-- ────────────────────────────────────────────────────────────────
--  Global leaderboards — the three public boards behind
--  docs/leaderboards-design.md.
--
--  Apply by hand in the Supabase SQL Editor, AFTER steal.sql and
--  BEFORE settings.sql / account.sql:
--
--    schema → hardening → social → daily → duels → steal →
--    leagues → THIS FILE → settings → account
--
--  steal.sql is a hard dependency of the *ordering*, not of the
--  code: this file reads `duel_runs` and `duels`, and steal.sql is
--  the last file that changes their shape, so anything applied
--  before it can be invalidated by it. settings.sql keeps its
--  "after everything that touches profiles" rule and account.sql
--  stays last for the reason its own header gives.
--
--  ⚠ NOTHING IN THIS FILE IS A REPLACEMENT.
--  Every object below is new: one function, three indexes. It
--  deliberately does not CREATE OR REPLACE anything defined in an
--  earlier migration — in particular it does NOT touch
--  get_daily_leaderboard, which ranks the same attempts differently
--  for a different caller (see §2). That matters because a function
--  redefined here would be silently reverted the next time somebody
--  re-pasted the file that first defined it, which is exactly what
--  happened when steal.sql took over three of duels.sql's functions.
--  Re-applying any earlier migration cannot disturb this file, and
--  re-applying this file cannot disturb any earlier one.
--
--  The contract is docs/leaderboards-design.md; where the two
--  disagree, the doc is the spec and this is the bug. The two places
--  the doc does not decide something the implementation has to decide
--  are marked SPEC NOTE.
--
--  Idempotent throughout: CREATE OR REPLACE FUNCTION, CREATE INDEX
--  IF NOT EXISTS. Re-running it is the supported way to deploy a
--  change.
--
--  SET search_path = public on the SECURITY DEFINER function, for
--  the reason daily.sql gives: without it, unqualified names resolve
--  against the *caller's* search_path.
-- ────────────────────────────────────────────────────────────────

-- ── 1. The integrity rule, restated where it is enforced ────────
-- ONLY SERVER-SCORED RUNS ARE ELIGIBLE FOR A GLOBAL BOARD.
--
-- game_sessions is INSERTed straight from the browser under a policy
-- of `auth.uid() = user_id OR user_id IS NULL`, and the anon key is
-- published in js/config.js. Anybody can therefore write themselves
-- a session with any score at all. That has never mattered because
-- those rows only ever fed their own owner's dashboard; the moment
-- they feed a public ranking, the top of the ranking belongs to
-- whoever first thought to type a large number.
--
-- So the boards read exactly two tables, and both of them hold
-- scores the *server* computed from questions the server generated:
--
--   daily_attempts — scored by submit_daily from daily_puzzles.questions
--   duel_runs      — scored by submit_duel_run from duels.questions
--
-- There is no reference to game_sessions anywhere in this file, and
-- a patch that adds one is a security regression, not a feature. The
-- cost of the rule is that practice and solo runs never rank, which
-- the design document states out loud rather than hiding.
--
-- Comparability: dailies and duels are both generated from
-- daily_default_config(), so operations and ranges already match.
-- Duration does not — duels run 15..600 seconds — so every board
-- here is fixed at the standard 120 seconds, the daily included. A
-- 300-second run is not a better result, it is a longer one.

-- ── 2. get_global_board(p_scope, p_limit) ───────────────────────
-- Returns {scope, duration_seconds, generated_at, rows:[{rank,
-- username, score}]}, and on an unrecognised scope the same shape
-- with an empty rows array and an extra `error` key.
--
-- Granted to anon as well as authenticated: a leaderboard nobody can
-- read while signed out is not a leaderboard, and this is the one
-- page worth landing a stranger on.
--
-- What a row deliberately does not carry: user_id, email, session or
-- duel key, puzzle date, submitted_at, answers, questions. A row is
-- three fields, and the three are chosen so that no join key of any
-- kind leaves the database.
--
-- ONE PAGE, ONE RANKING RULE. All three scopes apply the same three
-- rules in the same order:
--
--   1. drop every run that cannot be attributed to a username,
--   2. keep one row per player — their best,
--   3. number with ROW_NUMBER() over score DESC, submitted_at ASC.
--
-- Step 1 comes first, and that ordering is the whole point of it:
-- dropping the unnamed *after* numbering leaves a board that opens at
-- rank 2 with a hole in it and returns nine rows when ten were asked
-- for, while a named player who should have been tenth is left off.
-- An account can reach the daily with no username — start_daily needs
-- only auth.uid(), and nothing in these migrations creates a profiles
-- row automatically — so this is reachable and not theoretical.
--
-- Step 3 is ROW_NUMBER and not RANK: the contract breaks ties on the
-- earlier submitted_at, first to get there holding the higher rank.
--
-- This is why the `daily` scope does NOT call get_daily_leaderboard.
-- That function shares a rank between tied players (daily.sql §8,
-- deliberately, and its own suite pins it), so borrowing it would put
-- two ranking rules on the three tabs of one page: two players on
-- 8100 would read `1, 1` on the first tab and `1, 2` on the next.
-- get_daily_leaderboard keeps its behaviour for its own caller, the
-- daily page. The duplication is two ranking implementations over one
-- table, which is a real cost, and it is the cheaper of the two.
--
-- A player whose profile is PRIVATE is shown. profiles.is_public
-- governs whether the profile *page* — a history nobody consented to
-- publish — is readable. A board shows a name and a score, which is
-- what a board is; entering a ranked run is a deliberate act whose
-- entire purpose is to appear on one.
CREATE OR REPLACE FUNCTION public.get_global_board(
  p_scope TEXT,
  p_limit INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Named, not buried in a predicate: this is the number the page
  -- heading has to say out loud, and the number that makes the board
  -- defensible. It is asserted, not assumed — see the duration
  -- lookups below, which apply to the daily too.
  c_duration  CONSTANT INTEGER := 120;
  -- Clamped, not trusted. p_limit arrives from a public client and an
  -- unbounded LIMIT is a request to serialise every run ever played
  -- into one JSON document. 100 is get_daily_leaderboard's ceiling
  -- too, so the boards cannot be made to disagree about length, and
  -- the contract states it so a client can plan for it.
  c_max_rows  CONSTANT INTEGER := 100;

  v_limit     INTEGER     := LEAST(GREATEST(COALESCE(p_limit, c_max_rows), 1),
                                   c_max_rows);
  v_today     DATE        := public.daily_today();
  -- The scope's window, as a pair of closed/half-open ranges rather
  -- than an IF inside the query. A predicate of the form
  -- `NOT v_today_only OR submitted_at >= ...` is not something the
  -- planner can turn into an index range; a plain BETWEEN is.
  v_date_from DATE;
  v_date_to   DATE;
  v_from      TIMESTAMPTZ;
  v_to        TIMESTAMPTZ;
  -- The daily board is the daily alone. Expressed as a flag rather
  -- than as a third copy of the query.
  v_duels     BOOLEAN;
  v_rows      JSONB;
BEGIN
  -- An unknown scope is an error payload, never an exception and
  -- never a silent fallback to a different board: a client that asked
  -- for 'weekly' and got the all-time board back would publish the
  -- wrong ranking under the right heading.
  IF p_scope IS NULL OR p_scope NOT IN ('daily', 'today', 'all_time') THEN
    RETURN jsonb_build_object(
      'scope',            p_scope,
      'duration_seconds', c_duration,
      'generated_at',     NOW(),
      'rows',             '[]'::JSONB,
      'error',            'invalid_scope'
    );
  END IF;

  IF p_scope = 'all_time' THEN
    -- ── Board 3, all time ──────────────────────────────────────
    -- Driven from the player list, not from the runs.
    --
    -- This is the one board whose input grows without bound, and the
    -- shape below is chosen for that and nothing else. Gathering
    -- candidates run-first means reading every run ever played and
    -- sorting it — measured at 100k runs: two sequential scans, two
    -- external merge sorts spilling to disk, ~128 ms, and every one
    -- of those numbers grows with the history of the product.
    --
    -- Asking the question player-first instead makes it O(players)
    -- rather than O(runs): for each player, walk their own runs from
    -- the best downwards and stop at the first one that qualifies —
    -- normally the first index tuple examined. A board cannot have
    -- more rows than there are players, so the player list is the
    -- smaller driving side by construction. Same measurement: no
    -- sequential scan on either run table, no sort spilling to disk,
    -- ~15 ms, and it stays flat as the history grows.
    --
    -- The LATERAL is correlated — it references pr.id, and every
    -- iteration therefore re-executes. Worth stating outright,
    -- because this project has already been bitten by the opposite
    -- case: an *un*correlated LATERAL is pulled up and evaluated once,
    -- and with a volatile function inside it every row came out
    -- identical.
    --
    -- Driving from profiles is also what makes "no username, no row"
    -- structural rather than a filter that could be forgotten: a run
    -- belonging to an account with no profile row is never reached.
    WITH named AS (
      SELECT pr.id AS user_id, pr.username, b.score, b.submitted_at
      FROM public.profiles pr
      CROSS JOIN LATERAL (
        SELECT x.score, x.submitted_at
        FROM (
          -- Their best qualifying daily attempt...
          (SELECT a.score, a.submitted_at
             FROM public.daily_attempts a
            WHERE a.user_id      = pr.id
              AND a.status       = 'complete'
              AND a.score        IS NOT NULL
              AND a.submitted_at IS NOT NULL
              -- The 120-second rule, as EXISTS on this branch and
              -- as a scalar subquery on the windowed one. The two
              -- forms are not interchangeable and the choice is
              -- measured, not stylistic:
              --
              --   Here the subquery sits inside a LATERAL that is
              --   re-executed once per player, and a scalar subquery
              --   is a SubPlan whose executor state is rebuilt on
              --   every one of those rescans. Measured over 617
              --   players and 160k runs: EXISTS 6-12 ms, the same
              --   query with scalar subqueries 199 ms. EXISTS
              --   becomes part of the plan — a semi-join the planner
              --   can materialise or memoise once — so it pays that
              --   cost a single time.
              --
              --   On the windowed branch the query runs once, so a
              --   SubPlan costs nothing and buys something: it pins
              --   the lookup to a per-row primary-key probe. Given
              --   EXISTS there, the planner instead hashes the whole
              --   of `duels` — a sequential scan of every duel ever
              --   created, 10.6 ms against 2.0 ms and growing.
              --
              -- Both parents are one row per child by foreign key, so
              -- the two forms mean the same thing either way round.
              AND EXISTS (SELECT 1 FROM public.daily_puzzles p
                           WHERE p.puzzle_date      = a.puzzle_date
                             AND p.duration_seconds = c_duration)
            ORDER BY a.score DESC, a.submitted_at ASC
            LIMIT 1)
          UNION ALL
          -- ...and their best qualifying duel run.
          --
          -- Guest runs are excluded by user_id = pr.id, which no
          -- guest token can satisfy: a guest is not an account, has
          -- no username, and ranking one would invent a person.
          --
          -- Expired runs are excluded by status = 'complete'.
          -- duel_refresh writes score = COALESCE(score, 0) when a
          -- clock runs out, which is a real number for a ranking of
          -- finished runs to ignore.
          --
          -- SPEC NOTE 1 — steal-mode runs are included. The doc names
          -- `duel_runs` without qualification and steal is a mode of
          -- that table. Worth knowing: a steal run's score is capped
          -- by what the opponent did not take, so it can only ever
          -- understate a player and can never manufacture a top row.
          (SELECT r.score, r.submitted_at
             FROM public.duel_runs r
            WHERE r.user_id      = pr.id
              AND r.status       = 'complete'
              AND r.score        IS NOT NULL
              AND r.submitted_at IS NOT NULL
              -- EXISTS here for the reason above: this subquery
              -- is rescanned once per player.
              AND EXISTS (SELECT 1 FROM public.duels u
                           WHERE u.id               = r.duel_id
                             AND u.duration_seconds = c_duration)
            ORDER BY r.score DESC, r.submitted_at ASC
            LIMIT 1)
        ) x
        -- One row per player: their best across both sources. A
        -- player's own second-best run must never displace somebody
        -- else. CROSS JOIN, so a player with no qualifying run
        -- contributes nothing at all rather than a NULL row.
        ORDER BY x.score DESC, x.submitted_at ASC
        LIMIT 1
      ) b
      WHERE pr.username IS NOT NULL
    ),
    ranked AS (
      -- user_id is the tie-break of last resort: two runs with the
      -- same score in the same microsecond still have to come back in
      -- a fixed order or the list reshuffles between refreshes. It is
      -- used for ordering only and never emitted.
      SELECT n.username,
             n.score,
             ROW_NUMBER() OVER (ORDER BY n.score DESC,
                                         n.submitted_at ASC,
                                         n.user_id ASC)::INTEGER AS rank
      FROM named n
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'rank',     t.rank,
                      'username', t.username,
                      'score',    t.score
                    ) ORDER BY t.rank), '[]'::JSONB)
      INTO v_rows
    FROM ranked t
    WHERE t.rank <= v_limit;

  ELSE
    -- ── Boards 1 and 2, both windowed on today ─────────────────
    -- Driven from the window, not from the player list: a day holds
    -- hundreds of runs where the site holds however many accounts
    -- have ever been created, so here the runs are the smaller side.
    -- Both boards read a date-leading index and touch nothing older
    -- than midnight UTC.
    --
    -- The only difference between them is board 1 being the daily
    -- alone. That is one flag rather than a third copy of the query,
    -- because the three rules in the header have to be the same three
    -- rules on every tab, and the way to guarantee that is for there
    -- to be one place they are written.
    v_date_from := v_today;
    v_date_to   := v_today;
    -- Half-open on a UTC day boundary, matching daily_today().
    v_from      := (v_today::TIMESTAMP AT TIME ZONE 'UTC');
    v_to        := v_from + INTERVAL '1 day';
    v_duels     := (p_scope = 'today');

    WITH per_source AS (
      -- The window is applied to puzzle_date, not submitted_at: an
      -- attempt's puzzle_date *is* its day (start_daily only ever
      -- serves the current puzzle), and puzzle_date leads an index
      -- that already exists.
      --
      -- DISTINCT ON is redundant for a single day — daily_attempts is
      -- UNIQUE (puzzle_date, user_id) — and is written anyway so that
      -- the one-row-per-player rule is visible in the query rather
      -- than inherited from a constraint in another file.
      SELECT * FROM (
        SELECT DISTINCT ON (a.user_id)
               a.user_id, a.score, a.submitted_at
        FROM public.daily_attempts a
        WHERE a.status       = 'complete'
          AND a.score        IS NOT NULL
          AND a.submitted_at IS NOT NULL
          AND a.puzzle_date  BETWEEN v_date_from AND v_date_to
          -- The daily is not exempt from the 120-second rule. The
          -- payload states 120 unconditionally, and
          -- daily_puzzles.duration_seconds is a real column, so a day
          -- published at another duration would be labelled 120 here
          -- and excluded from the other two boards. EXISTS here and
          -- a scalar subquery for duels below — this query runs once,
          -- not once per player, which is what makes the two forms
          -- trade places between the branches. See the all-time
          -- branch for the measurements.
          AND EXISTS (SELECT 1 FROM public.daily_puzzles p
                       WHERE p.puzzle_date      = a.puzzle_date
                         AND p.duration_seconds = c_duration)
        ORDER BY a.user_id, a.score DESC, a.submitted_at ASC
      ) d

      UNION ALL

      -- Board 2 only. A duel won at 91 belongs on a "today" board
      -- even though it was not the daily; on board 1 it does not
      -- exist. See the notes on the all-time branch for why guest and
      -- expired runs are absent and steal runs are not.
      SELECT * FROM (
        SELECT DISTINCT ON (r.user_id)
               r.user_id, r.score, r.submitted_at
        FROM public.duel_runs r
        WHERE v_duels
          AND r.status       = 'complete'
          AND r.user_id      IS NOT NULL
          AND r.score        IS NOT NULL
          AND r.submitted_at IS NOT NULL
          AND r.submitted_at >= v_from
          AND r.submitted_at <  v_to
          -- Pinned to a per-run primary-key probe. Written as
          -- EXISTS the planner hashes all of `duels` instead, which
          -- turns today's board into a sequential scan of every duel
          -- ever created. A missing parent yields NULL, and
          -- NULL = 120 is NULL, which is not true, so the run is
          -- excluded — it fails closed, which is the direction to
          -- fail in.
          AND (SELECT u.duration_seconds
                 FROM public.duels u
                WHERE u.id = r.duel_id) = c_duration
        ORDER BY r.user_id, r.score DESC, r.submitted_at ASC
      ) k
    ),
    -- One row per player across both sources.
    best AS (
      SELECT DISTINCT ON (s.user_id) s.user_id, s.score, s.submitted_at
      FROM per_source s
      ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
    ),
    -- Inner join: no profile, no username, no row — and, because this
    -- happens here and not after the numbering, no rank consumed and
    -- no place on the board taken from somebody who has a name.
    named AS (
      SELECT b.user_id, b.score, b.submitted_at, pr.username
      FROM best b
      JOIN public.profiles pr ON pr.id = b.user_id
      WHERE pr.username IS NOT NULL
    ),
    ranked AS (
      SELECT n.username,
             n.score,
             ROW_NUMBER() OVER (ORDER BY n.score DESC,
                                         n.submitted_at ASC,
                                         n.user_id ASC)::INTEGER AS rank
      FROM named n
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'rank',     t.rank,
                      'username', t.username,
                      'score',    t.score
                    ) ORDER BY t.rank), '[]'::JSONB)
      INTO v_rows
    FROM ranked t
    WHERE t.rank <= v_limit;
  END IF;

  RETURN jsonb_build_object(
    'scope',            p_scope,
    'duration_seconds', c_duration,
    'generated_at',     NOW(),
    'rows',             COALESCE(v_rows, '[]'::JSONB)
  );
END;
$$;

-- Default privileges on a new function are EXECUTE to PUBLIC, which
-- for a SECURITY DEFINER function reading two tables that nobody can
-- read directly is the whole attack surface. Revoke first, then grant
-- back deliberately.
REVOKE ALL ON FUNCTION public.get_global_board(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_global_board(TEXT, INTEGER)
  TO anon, authenticated;

-- ── 3. Indexes ──────────────────────────────────────────────────
-- These boards are read by signed-out visitors on a public page, so
-- get_global_board is the most-called function on the site and the
-- only one whose worst case grows with the entire history of the
-- product.
--
-- What already existed, and what it does and does not cover:
--
--   idx_daily_attempts_rank (puzzle_date, score DESC, submitted_at)
--     WHERE status = 'complete'
--       — serves boards 1 and 2 on the daily side, and is the reason
--         the 'daily' scope needs no index of its own even though it
--         now computes its own ranking: one day's complete attempts,
--         already in score order, is exactly what it indexes.
--   idx_daily_attempts_live (user_id, started_at) WHERE in_progress
--       — wrong status, wrong columns.
--   idx_duel_runs_user (user_id) WHERE user_id IS NOT NULL
--       — right leading column, but carries neither score nor status,
--         so every candidate is a heap fetch.
--   duel_runs PK (duel_id, side), duels PK, daily_puzzles PK
--       — the PKs serve the per-candidate duration lookups.
--
-- So the all-time best-per-player walk had no usable index on either
-- table, and board 2's duel window had none at all. Three below, and
-- one index deliberately not created.

-- The all-time walk, daily side: for one player, their attempts best
-- first. The column order is exactly the ORDER BY of the LATERAL, so
-- the "best qualifying run" is normally the first index tuple read
-- and LIMIT 1 stops there. Partial on status because the boards never
-- look at anything else, which keeps abandoned and in-flight attempts
-- out of the index entirely, and covering because score and
-- submitted_at are the only other columns read: no heap access, and
-- no chance of a plan that touches the answers payload.
CREATE INDEX IF NOT EXISTS idx_daily_attempts_global
  ON public.daily_attempts (user_id, score DESC, submitted_at ASC)
  WHERE status = 'complete';

-- The same for the duel side. Both predicates of the query are in the
-- index predicate, so the index holds only rows that can ever rank —
-- guest runs and unfinished runs are not merely filtered out, they
-- are not there. duel_id is INCLUDEd rather than indexed: it is not
-- part of any ordering, but the duration lookup needs it, and
-- carrying it is what keeps the scan index-only.
CREATE INDEX IF NOT EXISTS idx_duel_runs_global
  ON public.duel_runs (user_id, score DESC, submitted_at ASC)
  INCLUDE (duel_id)
  WHERE status = 'complete' AND user_id IS NOT NULL;

-- Board 2's duel window. daily_attempts gets this from
-- idx_daily_attempts_rank's leading puzzle_date; duel_runs had no
-- date-leading index at all, and without one "today's best" reads
-- every duel run ever played to find the few hundred from the last
-- 24 hours. Descending because the interesting end is always the
-- recent one.
CREATE INDEX IF NOT EXISTS idx_duel_runs_submitted
  ON public.duel_runs (submitted_at DESC)
  INCLUDE (user_id, score, duel_id)
  WHERE status = 'complete' AND user_id IS NOT NULL;

-- The all-time board's driving scan is `profiles WHERE username IS
-- NOT NULL`, which is every row of the table. Nothing to index — but
-- the rule that a *private* profile still ranks means the board must
-- never be tempted into filtering on is_public, and a partial index
-- on it is exactly the tempting thing to add later. Stated here
-- instead of indexed: is_public governs the profile page, not the
-- board, and no index in this file mentions it.

-- SPEC NOTE 2 — nothing here is materialised. Every call recomputes
-- its board from live rows. With the indexes above that is fast
-- enough at the scale this project has, and it cannot serve a stale
-- ranking. If the all-time board ever becomes the slow query on the
-- instance, the answer is a summary table refreshed on submit — not a
-- widened policy, and not a client-side cache of a public ranking.
