-- ────────────────────────────────────────────────────────────────
--  Zetamac Daily — one puzzle a day, one ranked attempt.
--  Apply by hand in the Supabase SQL Editor, AFTER schema.sql,
--  hardening.sql and social.sql. The contract this implements is
--  docs/daily-design.md; if the two ever disagree, the doc is the
--  spec and this is the bug.
--
--  The whole design turns on one sentence from that doc: *the
--  sequence does not exist for you until you start, and starting
--  starts a server-side clock*. Everything below is in service of
--  that. Pre-solving the day requires knowing the questions, knowing
--  the questions requires starting, and starting spends the single
--  attempt the UNIQUE constraint allows.
--
--  Which is why RLS is enabled on both tables with NO policies at
--  all. That is not an oversight and not a TODO. The anon key ships
--  in js/config.js, so any policy permissive enough to serve a
--  question to a player is a policy permissive enough to hand the
--  whole day's answer key to anyone holding the key — including
--  people who have not started, which is precisely the thing that
--  must be impossible. Every read and write goes through the
--  SECURITY DEFINER functions below, which decide what a caller is
--  allowed to see based on the state of their own attempt.
--
--  SET search_path = public on every function is not decoration. A
--  SECURITY DEFINER function without it resolves unqualified names
--  against the *caller's* search_path, which lets a caller shadow a
--  table or operator with one of their own and run it as the owner.
--
--  This file is idempotent: re-running it is the supported way to
--  deploy a change.
-- ────────────────────────────────────────────────────────────────

-- ── 1. Tables ───────────────────────────────────────────────────
-- One row per UTC day. `questions` is generated once, by whichever
-- player starts first, and then served unchanged to everyone — so
-- there is exactly one implementation of the generator and no PRNG
-- that a client and a server have to agree about forever.
CREATE TABLE IF NOT EXISTS public.daily_puzzles (
  puzzle_date      DATE PRIMARY KEY,
  -- Days since launch, for the share string. Denormalised from
  -- puzzle_date on purpose: it is baked into every screenshot ever
  -- posted, so it is stored rather than recomputed by a formula
  -- somebody might later "fix".
  puzzle_number    INTEGER     NOT NULL,
  config           JSONB       NOT NULL,
  duration_seconds INTEGER     NOT NULL DEFAULT 120,
  -- [{display, operation, answer}, ...]
  questions        JSONB       NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- One row per player per day. `started_at` is the server clock and
-- nothing else: a client that could set it could grant itself an
-- afternoon to answer 400 questions.
CREATE TABLE IF NOT EXISTS public.daily_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  puzzle_date  DATE NOT NULL REFERENCES public.daily_puzzles(puzzle_date),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at   TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  -- Recomputed from daily_puzzles.questions on every submit. The
  -- client is never asked what it scored and is never believed if it
  -- volunteers one.
  score        INTEGER,
  -- The *accepted* answers, [{i, value, elapsed_ms}] — see §5 for
  -- what "accepted" excludes. Storing the filtered array rather than
  -- the raw payload is what makes accuracy computable later without
  -- re-running the filter, and keeps arbitrary client keys out of a
  -- column that other functions read.
  answers      JSONB,
  status       TEXT NOT NULL,
  -- Suspicion, not a verdict. Never blocks, never hides. See §5.
  flagged      BOOLEAN NOT NULL DEFAULT FALSE,
  -- THE one-attempt rule. Enforcing it in the RPC instead would mean
  -- enforcing it nowhere: two concurrent start_daily calls would both
  -- see no attempt and both insert one.
  UNIQUE (puzzle_date, user_id),
  CONSTRAINT daily_attempts_status_valid
    CHECK (status IN ('in_progress', 'complete', 'expired'))
);

-- Re-runnability for a database that already has an older shape of
-- these tables. CREATE TABLE IF NOT EXISTS is a no-op on an existing
-- table — it does not reconcile columns — so anything added after
-- the first deploy has to be added again here explicitly.
ALTER TABLE public.daily_attempts
  ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE;

-- Same reasoning for the constraint that carries the product rule.
-- ADD CONSTRAINT has no IF NOT EXISTS, and re-running the file must
-- not fail on "already exists", so it is guarded by hand.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.daily_attempts'::REGCLASS
      AND conname  = 'daily_attempts_puzzle_date_user_id_key'
  ) THEN
    ALTER TABLE public.daily_attempts
      ADD CONSTRAINT daily_attempts_puzzle_date_user_id_key
      UNIQUE (puzzle_date, user_id);
  END IF;
END $$;

-- ── 2. RLS: on, and deliberately empty ──────────────────────────
-- Enabled with zero policies, which denies every row to every
-- non-owner role. The SECURITY DEFINER functions below run as the
-- table owner and are therefore unaffected; PostgREST's anon and
-- authenticated roles get nothing directly.
--
-- Note this is ENABLE, not FORCE: FORCE would subject the owner to
-- RLS too, and with no policies that would lock out the functions
-- themselves.
ALTER TABLE public.daily_puzzles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_attempts ENABLE ROW LEVEL SECURITY;

-- Belt and braces. Supabase's default privileges grant the API roles
-- table-level rights in `public`, and while RLS would deny the rows
-- anyway, a future policy added in haste should not silently become
-- a public read of the answer key. Revoking the grant means such a
-- policy still has nothing to apply to.
REVOKE ALL ON TABLE public.daily_puzzles  FROM anon, authenticated;
REVOKE ALL ON TABLE public.daily_attempts FROM anon, authenticated;

-- ── 3. The question generator ───────────────────────────────────
-- A PL/pgSQL twin of generateQuestion() in js/game.js, and the only
-- copy that matters: the client is handed finished questions, so the
-- two never have to agree on anything but the shape.
--
-- Shapes, matching the JS exactly:
--   addition        a + b
--   subtraction     (a+b) − a  or  (a+b) − b     — a reversed addition
--   multiplication  a × b
--   division        (a*b) ÷ a  or  (a*b) ÷ b     — a reversed product
--
-- Subtraction and division are generated as reverses so their
-- operands stay inside the configured ranges and the answers stay
-- whole. Drawing a dividend directly would produce fractions.
--
-- The display glyphs are U+2212 MINUS SIGN, U+00D7 MULTIPLICATION
-- SIGN and U+00F7 DIVISION SIGN — the same three the client renders,
-- and none of them ASCII. They are written as U& escapes rather than
-- pasted literals so that the file survives being copied through an
-- editor or a clipboard that is not confident about UTF-8.
CREATE OR REPLACE FUNCTION public.daily_generate_questions(
  p_config JSONB,
  p_count  INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minus  TEXT := U&'\2212';   -- −
  v_times  TEXT := U&'\00d7';   -- ×
  v_divide TEXT := U&'\00f7';   -- ÷
  v_ops    TEXT[];
  v_am1 INT; v_ax1 INT; v_am2 INT; v_ax2 INT;
  v_mm1 INT; v_mx1 INT; v_mm2 INT; v_mx2 INT;
  v_out JSONB;
BEGIN
  -- Bounds are read defensively even though the only caller passes
  -- the canonical config: a config row is JSONB with no shape
  -- constraint, and a missing key here would otherwise turn into a
  -- NULL range and a table full of null questions.
  v_am1 := COALESCE((p_config->>'addMin1')::INT,   2);
  v_ax1 := COALESCE((p_config->>'addMax1')::INT, 100);
  v_am2 := COALESCE((p_config->>'addMin2')::INT,   2);
  v_ax2 := COALESCE((p_config->>'addMax2')::INT, 100);
  v_mm1 := COALESCE((p_config->>'mulMin1')::INT,   2);
  v_mx1 := COALESCE((p_config->>'mulMax1')::INT,  12);
  v_mm2 := COALESCE((p_config->>'mulMin2')::INT,   2);
  v_mx2 := COALESCE((p_config->>'mulMax2')::INT, 100);

  -- An inverted range (max < min) would make the width expression
  -- below zero or negative and floor(random()*n) then misbehave.
  -- Normalising is friendlier than erroring on a config nobody can
  -- see.
  IF v_ax1 < v_am1 THEN v_ax1 := v_am1; END IF;
  IF v_ax2 < v_am2 THEN v_ax2 := v_am2; END IF;
  IF v_mx1 < v_mm1 THEN v_mx1 := v_mm1; END IF;
  IF v_mx2 < v_mm2 THEN v_mx2 := v_mm2; END IF;

  SELECT ARRAY(SELECT jsonb_array_elements_text(p_config->'operations'))
  INTO v_ops;
  IF v_ops IS NULL OR cardinality(v_ops) = 0 THEN
    v_ops := ARRAY['addition', 'subtraction', 'multiplication', 'division'];
  END IF;

  -- Set-based rather than a 400-iteration loop appending to a JSONB:
  -- each append copies the whole document, so the loop is quadratic
  -- in the question count for no reason.
  --
  -- The subquery `d` exists to *name* the random draws, because each
  -- one is read twice — `aa` appears in both the display string and
  -- the answer, and two inline random() calls would be two different
  -- numbers, i.e. a question whose stated answer is wrong.
  --
  -- It has to be a subquery whose target list does the drawing, and
  -- specifically NOT `CROSS JOIN LATERAL (SELECT random() ...)` with
  -- no reference to the outer row. That form is uncorrelated, the
  -- planner evaluates it exactly once, and all 400 questions come out
  -- byte-identical — a whole day of "puzzle" that is one question
  -- repeated. (Observed, not theorised.) The form below is safe for a
  -- documented reason rather than a lucky one: PostgreSQL refuses to
  -- pull up a subquery with volatile functions in its target list,
  -- precisely so they cannot be duplicated or hoisted, so `d` is
  -- guaranteed to be evaluated once per generate_series row and each
  -- draw is guaranteed to be read consistently.
  --
  -- Both operand pairs are drawn for every row and the CASE discards
  -- the pair it does not need — cheaper and clearer than branching
  -- before the draw.
  SELECT COALESCE(jsonb_agg(
    CASE d.op

      WHEN 'addition' THEN jsonb_build_object(
        'display',   d.aa || ' + ' || d.ab,
        'operation', 'addition',
        'answer',    d.aa + d.ab)

      WHEN 'subtraction' THEN CASE WHEN d.flip THEN jsonb_build_object(
          'display',   (d.aa + d.ab) || ' ' || v_minus || ' ' || d.aa,
          'operation', 'subtraction',
          'answer',    d.ab)
        ELSE jsonb_build_object(
          'display',   (d.aa + d.ab) || ' ' || v_minus || ' ' || d.ab,
          'operation', 'subtraction',
          'answer',    d.aa)
        END

      WHEN 'multiplication' THEN jsonb_build_object(
        'display',   d.ma || ' ' || v_times || ' ' || d.mb,
        'operation', 'multiplication',
        'answer',    d.ma * d.mb)

      WHEN 'division' THEN CASE WHEN d.flip THEN jsonb_build_object(
          'display',   (d.ma * d.mb) || ' ' || v_divide || ' ' || d.ma,
          'operation', 'division',
          'answer',    d.mb)
        ELSE jsonb_build_object(
          'display',   (d.ma * d.mb) || ' ' || v_divide || ' ' || d.mb,
          'operation', 'division',
          'answer',    d.ma)
        END

      -- An operation name that is not one of the four. Falling
      -- through to NULL would put a JSON null in the array and make
      -- the client's q.display throw; addition is the safe default.
      ELSE jsonb_build_object(
        'display',   d.aa || ' + ' || d.ab,
        'operation', 'addition',
        'answer',    d.aa + d.ab)
    END
    ORDER BY d.i), '[]'::JSONB)
  INTO v_out
  FROM (
    SELECT
      i,
      v_ops[1 + floor(random() * cardinality(v_ops))::INT] AS op,
      v_am1 + floor(random() * (v_ax1 - v_am1 + 1))::INT   AS aa,
      v_am2 + floor(random() * (v_ax2 - v_am2 + 1))::INT   AS ab,
      v_mm1 + floor(random() * (v_mx1 - v_mm1 + 1))::INT   AS ma,
      v_mm2 + floor(random() * (v_mx2 - v_mm2 + 1))::INT   AS mb,
      -- Which of the two reverses to show. Without it every
      -- subtraction would subtract the first operand and half the
      -- shapes the game can produce would never appear.
      random() < 0.5                                       AS flip
    FROM generate_series(1, GREATEST(COALESCE(p_count, 0), 0)) AS i
  ) d;

  RETURN v_out;
END;
$$;

-- Internal. Not granted to anyone: it is called from inside the
-- definer functions below, which run as the owner and so need no
-- grant of their own. Exposing it would let a caller burn CPU
-- generating arbitrarily large payloads.
REVOKE ALL ON FUNCTION public.daily_generate_questions(JSONB, INTEGER) FROM PUBLIC;

-- ── 4. Shared helpers ───────────────────────────────────────────
-- The canonical Zetamac default, in one place. Every other config is
-- unranked, which is the whole reason the daily board can be
-- compared across players at all.
CREATE OR REPLACE FUNCTION public.daily_default_config()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'operations', jsonb_build_array('addition', 'subtraction',
                                    'multiplication', 'division'),
    'addMin1',   2, 'addMax1', 100,
    'addMin2',   2, 'addMax2', 100,
    'mulMin1',   2, 'mulMax1',  12,
    'mulMin2',   2, 'mulMax2', 100,
    'duration', 120
  );
$$;

REVOKE ALL ON FUNCTION public.daily_default_config() FROM PUBLIC;

-- Puzzle #1 is 2026-07-27. This is a one-way door: the number is
-- baked into every share string ever posted, so changing the epoch
-- silently renumbers other people's screenshots.
CREATE OR REPLACE FUNCTION public.daily_puzzle_number(p_date DATE)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (p_date - DATE '2026-07-27') + 1;
$$;

REVOKE ALL ON FUNCTION public.daily_puzzle_number(DATE) FROM PUBLIC;

-- Today, in UTC, always.
--
-- CURRENT_DATE would be wrong here — it is evaluated in the session's
-- TimeZone, which differs between the SQL editor, PostgREST and
-- whatever a future connection pooler sets. A player's puzzle must
-- not depend on which connection served them, so the conversion is
-- written out rather than inherited.
CREATE OR REPLACE FUNCTION public.daily_today()
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (NOW() AT TIME ZONE 'UTC')::DATE;
$$;

REVOKE ALL ON FUNCTION public.daily_today() FROM PUBLIC;

-- The result block — {score, accuracy, rank, players} — for one
-- player on one day, or SQL NULL if that player has no *complete*
-- attempt. Factored out because start_daily, submit_daily and
-- get_daily_status must all report the same numbers, and three
-- copies of a ranking query is three chances to tie-break
-- differently.
--
-- rank is RANK(), not ROW_NUMBER(): tied scores share a rank
-- (1, 2, 2, 4). Inventing an order between two identical scores
-- would mean telling one of those players they lost to the other on
-- a criterion nobody agreed to.
--
-- Takes a user_id, so it is never granted to an API role — that
-- argument is not something a client is allowed to choose.
CREATE OR REPLACE FUNCTION public.daily_result(p_date DATE, p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v JSONB;
BEGIN
  IF p_date IS NULL OR p_user IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
           'score',    r.score,
           -- 0/0 is not 1.0, it is unknown. A player who submitted an
           -- empty answer list has no accuracy, and JSON null lets the
           -- client render a dash instead of a flattering 100%.
           'accuracy', CASE WHEN r.answered > 0
                            THEN round(r.score::NUMERIC / r.answered, 3) END,
           'rank',     r.rank,
           'players',  (SELECT COUNT(*)::INTEGER
                        FROM public.daily_attempts a2
                        WHERE a2.puzzle_date = p_date
                          AND a2.status = 'complete')
         )
  INTO v
  FROM (
    SELECT
      a.user_id,
      a.score,
      COALESCE(jsonb_array_length(a.answers), 0) AS answered,
      RANK() OVER (ORDER BY a.score DESC)::INTEGER AS rank
    FROM public.daily_attempts a
    WHERE a.puzzle_date = p_date
      AND a.status = 'complete'
  ) r
  WHERE r.user_id = p_user;

  -- No complete attempt for this player: SQL NULL, which
  -- jsonb_build_object turns into a JSON null in the payloads below.
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.daily_result(DATE, UUID) FROM PUBLIC;

-- ── 5. start_daily ──────────────────────────────────────────────
-- Creates today's puzzle if it does not exist, creates the caller's
-- attempt if they have not started, and returns the questions — but
-- only while the attempt is genuinely live.
--
-- Three things are load-bearing here.
--
-- (a) Puzzle creation is lazy and race-safe. Two players hitting a
--     brand new UTC day at the same instant must not end up on two
--     different sequences, which would defeat the entire point of a
--     shared daily. INSERT ... ON CONFLICT DO NOTHING followed by a
--     re-SELECT settles it: the loser blocks on the winner's
--     speculative insert, inserts nothing, and then reads back the
--     winner's row. Both players get the same 400 questions.
--     The loser does generate a set of questions it then throws
--     away. That is deliberate — it costs a few milliseconds once per
--     day, and the alternative (advisory locks, or generating after
--     the insert) is more machinery guarding less.
--
-- (b) A second call resumes, it does not restart. started_at is
--     written exactly once, by the INSERT, and every later call reads
--     it back and derives the remaining time from it. There is no
--     code path in this file that updates started_at, which is the
--     only way to be sure a refresh cannot buy more time.
--
-- (c) Questions come back only while the window is open AND the
--     attempt is in_progress. This is the single most important
--     property in the file. Without it a player starts at 00:01,
--     reads the answer key, walks away, and either studies it or
--     hands it to everyone else — and every score on the board that
--     day is worthless.
CREATE OR REPLACE FUNCTION public.start_daily()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_now       TIMESTAMPTZ := NOW();
  v_today     DATE;
  v_config    JSONB;
  v_p         public.daily_puzzles%ROWTYPE;
  v_a         public.daily_attempts%ROWTYPE;
  v_remaining INTEGER;
  v_live      BOOLEAN;
BEGIN
  -- A ranked attempt needs an identity, because "one attempt" is
  -- meaningless for a caller who can be a new person every request.
  -- Anonymous players can still play the day's config unranked
  -- through the ordinary game.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'daily_requires_account'
      USING ERRCODE = '42501',
            HINT    = 'Sign in to play the ranked daily.';
  END IF;

  v_today  := public.daily_today();
  v_config := public.daily_default_config();

  -- ---- the day's puzzle --------------------------------------------------
  SELECT * INTO v_p FROM public.daily_puzzles WHERE puzzle_date = v_today;

  IF NOT FOUND THEN
    INSERT INTO public.daily_puzzles
      (puzzle_date, puzzle_number, config, duration_seconds, questions)
    VALUES (
      v_today,
      public.daily_puzzle_number(v_today),
      v_config,
      COALESCE((v_config->>'duration')::INT, 120),
      -- ~400 covers the fastest plausible run at 120 seconds with a
      -- wide margin. Running out mid-game is unrecoverable; a few
      -- unused questions cost nothing.
      public.daily_generate_questions(v_config, 400)
    )
    ON CONFLICT (puzzle_date) DO NOTHING;

    -- Unconditional re-SELECT, not `IF NOT FOUND`-style branching on
    -- the insert: after ON CONFLICT DO NOTHING we cannot tell whether
    -- we won without asking, and the answer we need — the row that is
    -- actually there — is the same either way.
    SELECT * INTO v_p FROM public.daily_puzzles WHERE puzzle_date = v_today;
  END IF;

  -- ---- the caller's attempt ----------------------------------------------
  SELECT * INTO v_a
  FROM public.daily_attempts
  WHERE puzzle_date = v_today AND user_id = v_uid;

  IF NOT FOUND THEN
    INSERT INTO public.daily_attempts
      (puzzle_date, user_id, started_at, status)
    VALUES (v_today, v_uid, v_now, 'in_progress')
    ON CONFLICT (puzzle_date, user_id) DO NOTHING;

    -- Same pattern, same reason, and here it also covers the case
    -- that matters most: the same player double-clicking Start. The
    -- second insert does nothing and the re-SELECT returns the first
    -- one's started_at, so the clock cannot be reset by racing it.
    SELECT * INTO v_a
    FROM public.daily_attempts
    WHERE puzzle_date = v_today AND user_id = v_uid;
  END IF;

  -- ---- lazy expiry --------------------------------------------------------
  -- An attempt that ran out while nobody was looking is closed the
  -- next time anyone asks about it. No scheduler: a cron job that
  -- fails to deploy would leave attempts in_progress forever, and
  -- every reader here has to re-derive the state from started_at
  -- anyway to be correct.
  IF v_a.status = 'in_progress'
     AND v_now > v_a.started_at
                 + make_interval(secs => v_p.duration_seconds + 3) THEN
    UPDATE public.daily_attempts
    SET status = 'expired',
        -- "Closes at whatever was submitted, which may be nothing" —
        -- and nothing is zero, not unknown.
        score  = COALESCE(score, 0)
    WHERE id = v_a.id
    RETURNING * INTO v_a;
  END IF;

  -- Remaining time is measured against the duration, not the grace
  -- period. The 3s grace exists to absorb network latency on the
  -- submit, not to be spent answering.
  v_remaining := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
                   v_a.started_at
                   + make_interval(secs => v_p.duration_seconds) - v_now
                 ))))::INTEGER;

  v_live := (v_a.status = 'in_progress' AND v_remaining > 0);

  RETURN jsonb_build_object(
    'puzzle_number',     v_p.puzzle_number,
    'puzzle_date',       to_char(v_p.puzzle_date, 'YYYY-MM-DD'),
    'duration_seconds',  v_p.duration_seconds,
    -- The contract's exact shape (…Z) rather than to_jsonb()'s
    -- +00:00, so Date.parse in the client sees the string the doc
    -- promises.
    'started_at',        to_char(v_a.started_at AT TIME ZONE 'UTC',
                                 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'seconds_remaining', CASE WHEN v_live THEN v_remaining ELSE 0 END,
    'status',            v_a.status,
    -- The whole security property, in one CASE. Note it is the same
    -- expression whether the attempt is complete, expired, or merely
    -- out of time: there is no state in which a caller who is not
    -- mid-run can see the answer key.
    'questions',         CASE WHEN v_live THEN v_p.questions END,
    'result',            public.daily_result(v_a.puzzle_date, v_uid)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_daily() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_daily() TO authenticated;

-- ── 6. submit_daily ─────────────────────────────────────────────
-- The only place a score is decided.
--
-- The client sends [{i, value, elapsed_ms}] and is not consulted
-- about the score. If the payload contains a `score` key it is read
-- by nothing here; the score is counted from daily_puzzles.questions,
-- which the client has seen but cannot write.
--
-- The awkward requirement is that a *malformed* payload must not
-- raise. A client bug that sends a string where a number belongs is
-- a bug, not an attack, and it must not surface as a 500 that looks
-- like the server fell over. So every field is checked with
-- jsonb_typeof before it is cast, and anything that fails is dropped
-- rather than fatal. The genuine rejections — a closed window, a
-- second submission — do raise, because those the client must be
-- told about unambiguously.
CREATE OR REPLACE FUNCTION public.submit_daily(p_answers JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_now      TIMESTAMPTZ := NOW();
  v_a        public.daily_attempts%ROWTYPE;
  v_p        public.daily_puzzles%ROWTYPE;
  v_raw      JSONB;
  v_elem     JSONB;
  v_total_q  INTEGER;
  v_max_ms   NUMERIC;
  v_i_num    NUMERIC;
  v_ms       NUMERIC;
  v_prev_ms  NUMERIC := -1;
  v_i        INTEGER;
  v_seen     BOOLEAN[];
  v_kept     JSONB := '[]'::JSONB;
  v_kept_arr JSONB[] := ARRAY[]::JSONB[];
  v_gaps     NUMERIC[] := ARRAY[]::NUMERIC[];
  v_score    INTEGER := 0;
  v_answered INTEGER := 0;
  v_median   NUMERIC;
  v_stddev   NUMERIC;
  v_flagged  BOOLEAN := FALSE;
  v_result   JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'daily_requires_account'
      USING ERRCODE = '42501',
            HINT    = 'Sign in to play the ranked daily.';
  END IF;

  -- ---- find the attempt ---------------------------------------------------
  -- By user and status, NOT by today's date. A player who starts at
  -- 23:59:30 UTC submits after midnight, when "today" is a different
  -- puzzle they have never started. Keying the lookup on the date
  -- would throw that run away every single night.
  SELECT * INTO v_a
  FROM public.daily_attempts
  WHERE user_id = v_uid AND status = 'in_progress'
  ORDER BY started_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    -- Nothing live. Either they already submitted, or they never
    -- started. Distinguish the two so the client can say something
    -- true; both are refusals.
    SELECT * INTO v_a
    FROM public.daily_attempts
    WHERE user_id = v_uid AND puzzle_date = public.daily_today();

    IF NOT FOUND THEN
      RAISE EXCEPTION 'daily_not_started'
        USING ERRCODE = 'P0002',
              HINT    = 'Call start_daily() before submitting.';
    END IF;

    -- The one-attempt rule, at the point it actually bites.
    RAISE EXCEPTION 'daily_already_submitted'
      USING ERRCODE = '23505',
            HINT    = 'This puzzle has already been played.';
  END IF;

  SELECT * INTO v_p
  FROM public.daily_puzzles
  WHERE puzzle_date = v_a.puzzle_date;

  -- ---- the clock ----------------------------------------------------------
  -- Server clock, both ends. started_at was written by the server and
  -- v_now is read from the server; nothing a client sends enters this
  -- comparison, so there is nothing to pause, slow or rewind. The 3s
  -- grace is for the round trip, not for thinking.
  --
  -- Note the attempt is NOT marked expired here: RAISE aborts the
  -- transaction and would roll the mark back anyway. §5 and §7 both
  -- close it lazily on the next call, and a row left in_progress in
  -- the meantime is harmless — the leaderboard counts only 'complete'
  -- and a retry re-checks this same clock.
  IF v_now - v_a.started_at
     > make_interval(secs => v_p.duration_seconds + 3) THEN
    RAISE EXCEPTION 'daily_window_closed'
      USING ERRCODE = '22023',
            HINT    = 'The 120-second window for this attempt has passed.';
  END IF;

  v_total_q := COALESCE(jsonb_array_length(v_p.questions), 0);
  v_max_ms  := v_p.duration_seconds::NUMERIC * 1000;

  -- ---- normalise the payload ---------------------------------------------
  -- Not an array (null, an object, a bare string, absent): treat as
  -- no answers rather than erroring. The player gets a zero, which is
  -- what they earned, and the client gets a payload instead of a 500.
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'array' THEN
    v_raw := '[]'::JSONB;
  ELSE
    v_raw := p_answers;
  END IF;

  IF v_total_q > 0 THEN
    v_seen := array_fill(FALSE, ARRAY[v_total_q]);
  END IF;

  -- Walked in order rather than aggregated, because the
  -- non-decreasing check is inherently sequential.
  FOR v_elem IN SELECT value FROM jsonb_array_elements(v_raw) LOOP
    -- Structure. Each of these is a client bug, and each drops one
    -- answer rather than the whole submission.
    --
    -- IS DISTINCT FROM, not <>. An ABSENT key makes `v_elem->'i'` a
    -- SQL NULL, jsonb_typeof(NULL) is NULL, and `NULL <> 'number'`
    -- is NULL — which CONTINUE WHEN treats as false and lets the row
    -- through to be cast. That is the exact path a payload like
    -- [{"nope": 1}] takes, and it ends in a null array subscript and
    -- the 500 this function exists to avoid. Three-valued logic is
    -- the whole hazard of validating client JSON, so every check
    -- below is written to be total.
    CONTINUE WHEN jsonb_typeof(v_elem) IS DISTINCT FROM 'object';
    CONTINUE WHEN jsonb_typeof(v_elem->'i') IS DISTINCT FROM 'number';
    CONTINUE WHEN jsonb_typeof(v_elem->'elapsed_ms') IS DISTINCT FROM 'number';

    -- Read as NUMERIC first and range-check before casting to INT.
    -- A JSON number may be 1e400, and ::INT on that is an overflow
    -- error — which is exactly the 500 this function must not
    -- produce.
    v_i_num := (v_elem->>'i')::NUMERIC;
    v_ms    := (v_elem->>'elapsed_ms')::NUMERIC;

    -- Total by construction: anything not provably an in-range whole
    -- number is dropped, so NULL fails the test rather than passing
    -- it.
    CONTINUE WHEN NOT (v_i_num >= 0 AND v_i_num < v_total_q
                       AND v_i_num = floor(v_i_num));
    v_i := v_i_num::INTEGER;

    -- Past the end of the window: unreachable, so it did not happen.
    -- Same shape, same reason.
    CONTINUE WHEN NOT (v_ms >= 0 AND v_ms <= v_max_ms);

    -- Time does not run backwards. The offending entry is dropped and
    -- v_prev_ms is left alone, so one bad row cannot truncate the
    -- rest of an otherwise ordered run.
    CONTINUE WHEN v_ms < v_prev_ms;

    -- The same question answered twice would otherwise score twice.
    CONTINUE WHEN COALESCE(v_seen[v_i + 1], FALSE);
    v_seen[v_i + 1] := TRUE;

    -- Accepted. It counts as answered whatever `value` turned out to
    -- be: a non-numeric value is a wrong answer, not a free pass, or
    -- a client could inflate its accuracy by sending junk it knows
    -- will be discarded.
    v_answered := v_answered + 1;
    v_gaps     := v_gaps || (v_ms - GREATEST(v_prev_ms, 0));
    v_prev_ms  := v_ms;

    IF jsonb_typeof(v_elem->'value') = 'number'
       AND jsonb_typeof(v_p.questions->v_i->'answer') = 'number'
       AND (v_elem->>'value')::NUMERIC
           = (v_p.questions->v_i->>'answer')::NUMERIC THEN
      v_score := v_score + 1;
    END IF;

    -- Rebuilt from the three fields this function actually read, so
    -- whatever else the client attached — a `score`, a `correct`
    -- flag, a megabyte of padding — is not what gets stored.
    v_kept_arr := v_kept_arr || jsonb_build_object(
      'i',          v_i,
      'value',      CASE WHEN jsonb_typeof(v_elem->'value') = 'number'
                         THEN v_elem->'value' ELSE 'null'::JSONB END,
      'elapsed_ms', floor(v_ms)::BIGINT
    );
  END LOOP;

  -- WITH ORDINALITY and an explicit ORDER BY: unnest happens to emit
  -- array order today, but jsonb_agg without ORDER BY is only ever
  -- accidentally ordered, and the stored answers are read back as a
  -- timeline.
  SELECT COALESCE(jsonb_agg(e.val ORDER BY e.ord), '[]'::JSONB) INTO v_kept
  FROM unnest(v_kept_arr) WITH ORDINALITY AS e(val, ord);

  -- ---- flagging, not blocking --------------------------------------------
  -- Two cheap signals, both on the gaps between answers:
  --
  --   median gap below a human floor — nobody sustains sub-300ms
  --   across dozens of mixed-operation questions, including typing;
  --
  --   near-zero spread — a human's gaps wander by hundreds of
  --   milliseconds, a script's do not.
  --
  -- Both need a real sample, hence the >= 10 floor, which doubles as
  -- the divide-by-zero guard: percentile_cont and stddev_samp over an
  -- empty or single-element set return NULL, and this branch cannot
  -- be reached with fewer than ten.
  --
  -- Deliberately no action beyond recording it. False positives on a
  -- leaderboard are worse than the occasional bot — banning a fast
  -- honest player is unrecoverable, tolerating a bot for a day is
  -- not — so nothing downstream filters on `flagged`. Acting on it is
  -- a human decision, later, with the evidence in front of them.
  IF array_length(v_gaps, 1) >= 10 THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY g),
           stddev_samp(g)
    INTO v_median, v_stddev
    FROM unnest(v_gaps) AS g;

    v_flagged := (v_median IS NOT NULL AND v_median < 300)
              OR (v_stddev IS NOT NULL AND v_stddev < 15);
  END IF;

  -- ---- commit -------------------------------------------------------------
  -- Guarded by status so that two submits racing each other cannot
  -- both win: the second updates zero rows. The read above would
  -- normally have caught it, but two concurrent transactions can both
  -- have read 'in_progress'.
  UPDATE public.daily_attempts
  SET submitted_at = v_now,
      score        = v_score,
      answers      = v_kept,
      status       = 'complete',
      flagged      = v_flagged
  WHERE id = v_a.id
    AND status = 'in_progress';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'daily_already_submitted'
      USING ERRCODE = '23505',
            HINT    = 'This puzzle has already been played.';
  END IF;

  v_result := public.daily_result(v_a.puzzle_date, v_uid);

  RETURN jsonb_build_object(
    'score',          v_score,
    'total_answered', v_answered,
    -- Same 0/0 reasoning as everywhere else: no answers means no
    -- accuracy, not perfect accuracy.
    'accuracy',       CASE WHEN v_answered > 0
                           THEN round(v_score::NUMERIC / v_answered, 3) END,
    'puzzle_number',  v_p.puzzle_number,
    'rank',           v_result->'rank',
    'players',        v_result->'players',
    'flagged',        v_flagged
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_daily(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_daily(JSONB) TO authenticated;

-- ── 7. get_daily_status ─────────────────────────────────────────
-- Has the caller played today, and what happened. Drives the landing
-- page.
--
-- Emits no questions in any state — not even mid-attempt. A player
-- who is mid-run and refreshes calls start_daily, which resumes them;
-- this function has no reason to carry the answer key and therefore
-- does not.
--
-- It also does NOT create the day's puzzle. Loading the landing page
-- is not starting a run, and a puzzle row created by a passer-by
-- would be a puzzle nobody has started — harmless, but it would make
-- "the first player creates the day" false, which is the invariant
-- §5's race argument rests on. Everything the payload needs is
-- derivable from the date, so a missing row costs nothing.
CREATE OR REPLACE FUNCTION public.get_daily_status()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_now      TIMESTAMPTZ := NOW();
  v_today    DATE := public.daily_today();
  v_duration INTEGER;
  v_a        public.daily_attempts%ROWTYPE;
  v_reset    INTEGER;
BEGIN
  -- Duration from the row if the day exists, otherwise the canonical
  -- default. The client shows "120 seconds" on the landing page
  -- before anyone has started, and it should not be blank.
  SELECT p.duration_seconds INTO v_duration
  FROM public.daily_puzzles p WHERE p.puzzle_date = v_today;
  v_duration := COALESCE(v_duration,
                         (public.daily_default_config()->>'duration')::INT);

  -- Seconds to the next UTC midnight, for the countdown. Computed
  -- from the UTC wall clock rather than a timezone-sensitive
  -- date_trunc, for the same reason daily_today() exists.
  v_reset := CEIL(EXTRACT(EPOCH FROM (
               ((v_today + 1)::TIMESTAMP) - (v_now AT TIME ZONE 'UTC')
             )))::INTEGER;

  -- No identity: the anonymous view of the day. Reachable only if
  -- somebody re-grants this to anon, but a NULL uid must produce a
  -- payload rather than a NULL row either way.
  IF v_uid IS NOT NULL THEN
    SELECT * INTO v_a
    FROM public.daily_attempts
    WHERE puzzle_date = v_today AND user_id = v_uid;

    -- Lazy expiry, same rule as §5. This is why the function is
    -- VOLATILE rather than STABLE: reading the state is what closes
    -- an abandoned attempt.
    IF FOUND AND v_a.status = 'in_progress'
       AND v_now > v_a.started_at + make_interval(secs => v_duration + 3) THEN
      UPDATE public.daily_attempts
      SET status = 'expired',
          score  = COALESCE(score, 0)
      WHERE id = v_a.id
      RETURNING * INTO v_a;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'puzzle_number',      public.daily_puzzle_number(v_today),
    'puzzle_date',        to_char(v_today, 'YYYY-MM-DD'),
    'duration_seconds',   v_duration,
    'played',             v_a.id IS NOT NULL,
    -- NULL, not 'not_started': the three status values are states of
    -- an attempt, and there is no attempt. `played` is the field that
    -- answers the question the client is actually asking.
    'status',             v_a.status,
    'seconds_until_reset', v_reset,
    -- NULL for an attempt that is in_progress or expired — there is
    -- no submitted result to report — and never any questions.
    'result',             public.daily_result(v_today, v_uid)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_daily_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_status() TO authenticated;

-- ── 8. get_daily_leaderboard ────────────────────────────────────
-- Public data: username, score, accuracy, rank, for complete
-- attempts only. Granted to anon as well as authenticated, because
-- the board is the artefact the daily exists to produce and a
-- logged-out visitor should be able to see what they are missing.
--
-- Top N plus the caller's own row, always, even at rank 4,000.
-- Telling someone they are 4,000th out of a list that stops at 100
-- tells them nothing; showing their row tells them what to beat.
--
-- What it deliberately does not emit: user_id, started_at,
-- submitted_at, the answers array, and — obviously — questions. A
-- leaderboard row is four fields.
--
-- Usernames appear regardless of profiles.is_public. That column
-- (social.sql §1) governs the profile *page*, whose contents are a
-- history nobody consented to publish; entering a ranked daily is a
-- deliberate, per-day act whose entire purpose is to appear on a
-- board. Conflating the two would leave the board full of blanks.
--
-- `flagged` is not consulted. A flagged attempt ranks exactly like
-- any other; the flag is a note for a human, not a filter (§6).
CREATE OR REPLACE FUNCTION public.get_daily_leaderboard(
  p_date  DATE,
  p_limit INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_date    DATE := COALESCE(p_date, public.daily_today());
  -- Clamped, not trusted. p_limit arrives from a public client, and
  -- an unbounded LIMIT is a request to serialise the entire day into
  -- one JSON document. 100 is the contract's number and also the
  -- ceiling.
  v_limit   INTEGER := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100);
  v_players INTEGER;
  v_rows    JSONB;
  v_you     JSONB;
BEGIN
  WITH ranked AS (
    SELECT
      a.user_id,
      a.score,
      CASE WHEN COALESCE(jsonb_array_length(a.answers), 0) > 0
           THEN round(a.score::NUMERIC
                      / jsonb_array_length(a.answers), 3) END AS accuracy,
      RANK() OVER (ORDER BY a.score DESC)::INTEGER            AS rank,
      -- Display order only. Ties share a rank (see daily_result), but
      -- the array still has to come back in some fixed order or the
      -- client's list reshuffles between refreshes; earliest
      -- submission first, id to break the remaining tie.
      ROW_NUMBER() OVER (ORDER BY a.score DESC,
                                  a.submitted_at ASC,
                                  a.id ASC)                   AS seq
    FROM public.daily_attempts a
    WHERE a.puzzle_date = v_date
      AND a.status = 'complete'
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM ranked),
    -- COALESCE because jsonb_agg over zero rows is NULL, and a JSON
    -- null here would break the client's rows.map().
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'rank',     t.rank,
               'username', pr.username,
               'score',    t.score,
               'accuracy', t.accuracy
             ) ORDER BY t.seq)
      FROM ranked t
      LEFT JOIN public.profiles pr ON pr.id = t.user_id
      WHERE t.seq <= v_limit
    ), '[]'::JSONB),
    -- The caller's row, whether or not it made the cut. NULL — a JSON
    -- null in the payload — when they have not played, which is what
    -- the contract specifies.
    (SELECT jsonb_build_object(
              'rank',     t.rank,
              'username', pr.username,
              'score',    t.score,
              'accuracy', t.accuracy
            )
     FROM ranked t
     LEFT JOIN public.profiles pr ON pr.id = t.user_id
     WHERE v_uid IS NOT NULL AND t.user_id = v_uid)
  INTO v_players, v_rows, v_you;

  RETURN jsonb_build_object(
    'puzzle_number', public.daily_puzzle_number(v_date),
    'puzzle_date',   to_char(v_date, 'YYYY-MM-DD'),
    'players',       COALESCE(v_players, 0),
    'rows',          COALESCE(v_rows, '[]'::JSONB),
    'you',           v_you
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_daily_leaderboard(DATE, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_leaderboard(DATE, INTEGER)
  TO anon, authenticated;

-- ── 9. Indexes ──────────────────────────────────────────────────
-- The ranking scan: every complete attempt for one day, ordered by
-- score. Partial on status because the leaderboard never looks at
-- anything else, which keeps abandoned and in-flight attempts out of
-- the index entirely. submitted_at is the display tie-break, carried
-- so the ordering can be answered from the index.
CREATE INDEX IF NOT EXISTS idx_daily_attempts_rank
  ON public.daily_attempts (puzzle_date, score DESC, submitted_at ASC)
  WHERE status = 'complete';

-- submit_daily's "the caller's live attempt" lookup leads with
-- user_id, which the UNIQUE (puzzle_date, user_id) index cannot serve
-- — its leading column is the date. Partial for the same reason as
-- above: at most one row per user qualifies, and the index stays
-- roughly the size of the set of runs currently in flight.
CREATE INDEX IF NOT EXISTS idx_daily_attempts_live
  ON public.daily_attempts (user_id, started_at DESC)
  WHERE status = 'in_progress';
