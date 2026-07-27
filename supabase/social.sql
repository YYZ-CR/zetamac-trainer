-- ────────────────────────────────────────────────────────────────
--  Social layer — public profiles and score percentiles.
--  Apply by hand in the Supabase SQL Editor, AFTER schema.sql and
--  hardening.sql. The contract this implements is docs/social-api.md;
--  if the two ever disagree, the doc is the spec and this is the bug.
--
--  Why functions and not policies: hardening.sql reduced `profiles`
--  to profiles_select_own and `game_sessions` to sessions_select_own,
--  because the anon key ships in js/config.js and therefore any
--  policy permissive enough to serve a public profile is a public
--  API over the whole table. Public data crosses that boundary here
--  instead — through SECURITY DEFINER functions that return a fixed,
--  minimal projection that fits on one screen and can be audited as
--  a unit.
--
--  Consequently: nothing below ever emits user_id, session_key, an
--  auth.users column, or the raw `questions` payload. Only aggregates
--  computed from questions leave these functions.
--
--  SET search_path = public on every function is not decoration. A
--  SECURITY DEFINER function without it resolves unqualified names
--  against the *caller's* search_path, which lets a caller shadow a
--  table or operator with one of their own and run it as the owner.
--
--  This file is idempotent: re-running it is the supported way to
--  deploy a change.
-- ────────────────────────────────────────────────────────────────

-- ── 1. Profiles are private until their owner opts in ───────────
-- DEFAULT FALSE matters more than it looks: this column is added to
-- a table that already has rows, and the alternative default would
-- publish every existing user's history the moment the migration ran.
-- Nobody consented to that, so the migration must be a no-op for
-- them and publishing must be a deliberate act.
--
-- No RPC is needed to flip it. hardening.sql left profiles_update
-- scoped to auth.uid() = id, so the client toggles this with a plain
-- UPDATE and cannot touch anyone else's row.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. get_public_profile ───────────────────────────────────────
-- Looks a profile up by username and returns the projection in
-- docs/social-api.md, or SQL NULL.
--
-- NULL — not an empty object, not a JSON null — is returned in two
-- cases, and deliberately the *same* NULL in both: when no such
-- username exists, and when the profile is private and the caller is
-- not its owner. Distinguishing them would turn this function into a
-- username-existence oracle for anyone holding the anon key, which is
-- everyone. The client renders one "no such profile" page either way.
--
-- Owners are exempt from the is_public check so they can preview
-- their own page before publishing it; is_owner in the payload tells
-- the client which of those two situations it is looking at.
CREATE OR REPLACE FUNCTION public.get_public_profile(p_username TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id              UUID;
  v_username        TEXT;
  v_created_at      TIMESTAMPTZ;
  v_is_public       BOOLEAN;
  v_is_owner        BOOLEAN;
  v_caller          UUID;
  v_total_games     INTEGER;
  v_total_questions BIGINT;
  v_total_mistakes  BIGINT;
  v_accuracy        NUMERIC;
  v_bests           JSONB;
  v_ops             JSONB;
  v_history         JSONB;
  v_days_practiced  INTEGER;
  v_streak          INTEGER;
BEGIN
  SELECT p.id, p.username, p.created_at, p.is_public
    INTO v_id, v_username, v_created_at, v_is_public
  FROM public.profiles p
  WHERE p.username = p_username;

  -- No such username.
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- auth.uid() is NULL for the anon role. Comparing it to v_id with =
  -- would then yield NULL, not FALSE, so it is pinned to a boolean
  -- here rather than used directly in the IF below.
  v_caller   := auth.uid();
  v_is_owner := (v_caller IS NOT NULL AND v_caller = v_id);

  -- Private, and the caller is not the owner: same answer as above.
  IF NOT v_is_public AND NOT v_is_owner THEN
    RETURN NULL;
  END IF;

  -- ---- all-time counters -------------------------------------------------
  -- total_games, total_questions and accuracy are all-time per the
  -- contract. They stay cheap because none of them unnests: array
  -- length and a jsonpath filter are both evaluated per row, so this
  -- scans one row per session rather than one row per question.
  SELECT
    count(*)::INTEGER,
    COALESCE(SUM(jsonb_array_length(s.questions)), 0)::BIGINT,
    COALESCE(SUM(jsonb_array_length(
      jsonb_path_query_array(s.questions, '$[*] ? (@.hadMistake == true)')
    )), 0)::BIGINT
  INTO v_total_games, v_total_questions, v_total_mistakes
  FROM public.game_sessions s
  WHERE s.user_id = v_id;

  -- A profile with zero answered questions has no accuracy, and
  -- 0/0 is not 1.0 — it is unknown. JSON null, so the client can
  -- render a dash instead of a flattering 100%.
  IF v_total_questions > 0 THEN
    v_accuracy := round(1 - (v_total_mistakes::NUMERIC / v_total_questions), 3);
  END IF;

  -- ---- bests -------------------------------------------------------------
  -- Object keyed by duration in seconds. Keys are JSON object keys and
  -- therefore strings — {"120": 84}, not {120: 84} — which is why
  -- duration_seconds is cast to text explicitly rather than left to
  -- an implicit cast that would not compile.
  --
  -- Built by aggregating over rows that exist, so a duration the user
  -- has never played is simply absent rather than present-with-zero.
  -- The COALESCE is load-bearing: jsonb_object_agg over zero rows
  -- returns NULL, and a NULL here would propagate into
  -- jsonb_build_object as a JSON null and break the client's
  -- Object.entries() walk.
  SELECT COALESCE(jsonb_object_agg(b.duration_seconds::TEXT, b.best), '{}'::JSONB)
  INTO v_bests
  FROM (
    SELECT s.duration_seconds, MAX(s.score) AS best
    FROM public.game_sessions s
    WHERE s.user_id = v_id
    GROUP BY s.duration_seconds
  ) b;

  -- ---- ops ---------------------------------------------------------------
  -- The one aggregation here that genuinely has to unnest `questions`,
  -- and so the one with a hard bound on its input: the 200 most recent
  -- sessions. Without the LIMIT this is O(every question the user has
  -- ever answered) on every page view, which for a heavy user is tens
  -- of thousands of rows materialised to compute four averages.
  --
  -- The LIMIT must be applied in a subquery, before the LATERAL — a
  -- LIMIT on the joined result would cap questions, not sessions.
  SELECT COALESCE(jsonb_object_agg(t.op, jsonb_build_object(
           'avg_ms',   t.avg_ms,
           'count',    t.cnt,
           'accuracy', t.accuracy
         )), '{}'::JSONB)
  INTO v_ops
  FROM (
    SELECT
      q.op,
      round(AVG(q.time_ms))::INTEGER AS avg_ms,
      COUNT(*)::INTEGER              AS cnt,
      -- COUNT(*) is >= 1 inside a group, so this cannot divide by zero.
      round(1 - (COUNT(*) FILTER (WHERE q.had_mistake))::NUMERIC / COUNT(*), 3)
                                     AS accuracy
    FROM (
      SELECT
        elem->>'operation' AS op,
        -- Type-checked rather than cast blindly. A row whose timeMs is
        -- a string would abort the whole function on ::NUMERIC, and
        -- `questions` is client-supplied JSONB with no shape constraint
        -- beyond "is an array" (hardening.sql §4). NULLs here are
        -- skipped by AVG rather than poisoning it.
        CASE WHEN jsonb_typeof(elem->'timeMs') = 'number'
             THEN (elem->>'timeMs')::NUMERIC END AS time_ms,
        -- Total by construction: anything that is not literal true —
        -- false, absent, or the wrong type — counts as no mistake.
        (elem->'hadMistake') = 'true'::JSONB     AS had_mistake
      FROM (
        SELECT s.questions
        FROM public.game_sessions s
        WHERE s.user_id = v_id
        ORDER BY s.created_at DESC
        LIMIT 200
      ) recent
      CROSS JOIN LATERAL jsonb_array_elements(recent.questions) AS elem
      WHERE jsonb_typeof(elem) = 'object'
    ) q
    -- Whitelisted rather than grouped by whatever string is in the
    -- payload. The output of a SECURITY DEFINER function is served to
    -- third parties, and without this a user could put arbitrary text
    -- in `operation` and have it echoed back as a JSON key on their
    -- own public page. Add to this list when the game adds an
    -- operation, or the new one will be silently dropped.
    WHERE q.op IN ('addition', 'subtraction', 'multiplication', 'division')
    GROUP BY q.op
  ) t;

  -- ---- history -----------------------------------------------------------
  -- Up to 60 most recent sessions, returned oldest-first so the client
  -- can feed it straight to a sparkline. Selected newest-first with a
  -- LIMIT (to get the most recent 60) and re-ordered inside jsonb_agg
  -- (to hand them back chronologically) — two different orderings on
  -- purpose.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'd',        to_char(h.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
           'score',    h.score,
           'duration', h.duration_seconds
         ) ORDER BY h.created_at), '[]'::JSONB)
  INTO v_history
  FROM (
    SELECT s.created_at, s.score, s.duration_seconds
    FROM public.game_sessions s
    WHERE s.user_id = v_id
    ORDER BY s.created_at DESC
    LIMIT 60
  ) h;

  -- ---- days_practiced and streak -----------------------------------------
  -- Gaps and islands, not a loop. Number the distinct practice days in
  -- order and subtract the row number from the date: every run of
  -- consecutive days collapses to a single constant, so grouping by
  -- that constant gives one row per unbroken run. A cursor walking
  -- backwards day by day would be O(streak) round trips for the same
  -- answer.
  --
  -- Days are UTC calendar days, matching the contract. created_at is
  -- TIMESTAMPTZ, so it is converted explicitly rather than left to
  -- the session's TimeZone setting, which differs between the SQL
  -- editor and PostgREST.
  --
  -- The streak is the run that ends today or yesterday. Yesterday
  -- counts because a user mid-streak has not necessarily played yet
  -- today and should not be told their streak is over. At most one
  -- run can qualify: two runs both ending within that window would be
  -- contiguous and would already have merged into one.
  WITH days AS (
    SELECT DISTINCT (s.created_at AT TIME ZONE 'UTC')::DATE AS d
    FROM public.game_sessions s
    WHERE s.user_id = v_id
  ), islands AS (
    SELECT
      MAX(g.d)        AS last_day,
      COUNT(*)::INTEGER AS len
    FROM (
      SELECT d, d - (row_number() OVER (ORDER BY d))::INTEGER AS island
      FROM days
    ) g
    GROUP BY g.island
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM days),
    -- No qualifying run — last session older than yesterday, or no
    -- sessions at all — is a streak of 0, not NULL.
    COALESCE((
      SELECT MAX(i.len) FROM islands i
      WHERE i.last_day >= (now() AT TIME ZONE 'UTC')::DATE - 1
    ), 0)
  INTO v_days_practiced, v_streak;

  RETURN jsonb_build_object(
    'username',        v_username,
    -- Emitted in the contract's exact shape (…Z) rather than
    -- to_jsonb()'s +00:00, so Date.parse in the client sees the same
    -- string the doc promises.
    'member_since',    to_char(v_created_at AT TIME ZONE 'UTC',
                               'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'is_public',       v_is_public,
    'is_owner',        v_is_owner,
    'total_games',     v_total_games,
    'total_questions', v_total_questions,
    'accuracy',        v_accuracy,
    'bests',           v_bests,
    'ops',             v_ops,
    'history',         v_history,
    'days_practiced',  v_days_practiced,
    'streak',          v_streak
  );
END;
$$;

-- Default EXECUTE on a new function is granted to PUBLIC, which on a
-- SECURITY DEFINER function means every role in the database inherits
-- owner-level reach through it. Revoked and re-granted explicitly so
-- the grant list is the one written here and not the one Postgres
-- assumed.
REVOKE ALL ON FUNCTION public.get_public_profile(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_profile(TEXT) TO anon, authenticated;

-- ── 3. get_score_percentile ─────────────────────────────────────
-- Where a score sits against everyone else's at the same duration.
--
-- The population is one entry per *player* — each player's best at
-- that duration — not one per session. Per-session would let anyone
-- inflate the denominator by grinding, and would make a beginner who
-- played 500 games rank above a strong player who played 5.
--
-- Only sessions with a user_id count. Anonymous sessions cannot be
-- attributed to a player, so counting them would mean counting one
-- unknown number of people as one player each.
--
-- Returns aggregates only: no username, no user_id, no per-player
-- scores. The most this can be mined for is the shape of the score
-- distribution, which is the point of it.
CREATE OR REPLACE FUNCTION public.get_score_percentile(
  p_score    INTEGER,
  p_duration INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_players    INTEGER;
  v_below      INTEGER;
  v_percentile NUMERIC;
BEGIN
  -- One pass, two numbers: how many players are ranked at this
  -- duration, and how many of them have a best strictly below the
  -- score being placed. Strictly below, so a score tying the field
  -- does not claim credit for beating it.
  SELECT
    COUNT(*)::INTEGER,
    (COUNT(*) FILTER (WHERE b.best < p_score))::INTEGER
  INTO v_players, v_below
  FROM (
    SELECT s.user_id, MAX(s.score) AS best
    FROM public.game_sessions s
    WHERE s.user_id IS NOT NULL
      AND s.duration_seconds = p_duration
    GROUP BY s.user_id
  ) b;

  -- Below five players a percentile is theatre: with four people it
  -- can only ever be 0, .25, .5, .75 or 1, and each of those is a
  -- statement about four named individuals rather than a population.
  -- Null instead, and the client hides the figure entirely below 20
  -- (that higher threshold lives in the client on purpose, so it can
  -- be tuned without a migration).
  --
  -- This test also stands in for the divide-by-zero guard: v_players
  -- is necessarily >= 5 on the branch that divides, so the no-players
  -- case can never reach it.
  -- p_score NULL is excluded explicitly. `best < NULL` is NULL rather
  -- than true, so v_below would come back 0 and the function would
  -- confidently report 0th percentile for a score that was never
  -- supplied. Unknown input has to produce an unknown answer.
  IF v_players >= 5 AND p_score IS NOT NULL THEN
    -- Four decimal places: more resolution than the client shows, so
    -- rounding for display stays a client decision.
    v_percentile := round(v_below::NUMERIC / v_players, 4);
  END IF;

  -- players is always reported, including when percentile is null —
  -- it is what the client uses to decide whether to show the figure
  -- and what to say instead.
  RETURN jsonb_build_object(
    'score',      p_score,
    'duration',   p_duration,
    'percentile', v_percentile,
    'players',    v_players
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_score_percentile(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_score_percentile(INTEGER, INTEGER)
  TO anon, authenticated;

-- ── 4. Indexes ──────────────────────────────────────────────────
-- The percentile scan groups every ranked session at one duration.
-- Leading with duration_seconds makes that an index range rather than
-- a seq scan of the table; score DESC is there so the per-player MAX
-- can be answered from the index.
CREATE INDEX IF NOT EXISTS idx_sessions_duration_score
  ON public.game_sessions (duration_seconds, score DESC);

-- Profile lookup is by username and almost always for a public
-- profile, so the index only covers those rows. Partial keeps it
-- small — private profiles are the default and expected majority —
-- and it is only usable by queries that also filter on is_public,
-- which is exactly the lookup above. Note this depends on the column
-- added in §1, so the ordering within this file matters.
CREATE INDEX IF NOT EXISTS idx_profiles_username_public
  ON public.profiles (username) WHERE is_public;
