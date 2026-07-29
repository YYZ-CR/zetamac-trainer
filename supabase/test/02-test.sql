-- Contract tests for supabase/social.sql.
-- Written against docs/social-api.md BEFORE reading the implementation, so a
-- pass means the contract holds — not that the code does what it happens to do.

\set ON_ERROR_STOP on
SET client_min_messages = NOTICE;

CREATE OR REPLACE FUNCTION pg_temp.ok(cond BOOLEAN, label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', label;
  END IF;
  RAISE NOTICE 'pass: %', label;
END $$;

-- Impersonation helpers matching how PostgREST sets the JWT subject.
CREATE OR REPLACE FUNCTION pg_temp.as_user(uname TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE uid UUID;
BEGIN
  SELECT id INTO uid FROM public.profiles WHERE username = uname;
  PERFORM set_config('request.jwt.claim.sub', uid::TEXT, FALSE);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_anon()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', FALSE);
END $$;

DO $$
DECLARE
  p        JSONB;
  q        JSONB;
  n        INT;
BEGIN
  PERFORM pg_temp.as_anon();

  -- ── Visibility ────────────────────────────────────────────────
  PERFORM pg_temp.ok(public.get_public_profile('nosuchuser') IS NULL,
    'unknown username returns SQL NULL');

  PERFORM pg_temp.ok(public.get_public_profile('privateperson') IS NULL,
    'private profile is invisible to anonymous callers');

  PERFORM pg_temp.as_user('privateperson');
  p := public.get_public_profile('privateperson');
  PERFORM pg_temp.ok(p IS NOT NULL,       'owner can see their own private profile');
  PERFORM pg_temp.ok((p->>'is_owner')::BOOLEAN,  'is_owner true for the owner');
  PERFORM pg_temp.ok(NOT (p->>'is_public')::BOOLEAN, 'is_public false for a private profile');

  -- An owner viewing SOMEONE ELSE's private profile still gets nothing.
  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.ok(public.get_public_profile('privateperson') IS NULL,
    'a logged-in stranger cannot see a private profile');

  PERFORM pg_temp.as_anon();
  p := public.get_public_profile('hexadecimal');
  PERFORM pg_temp.ok(p IS NOT NULL,               'public profile visible anonymously');
  PERFORM pg_temp.ok(NOT (p->>'is_owner')::BOOLEAN, 'is_owner false for a stranger');

  -- ── No leakage ────────────────────────────────────────────────
  PERFORM pg_temp.ok(NOT (p ? 'user_id'),     'payload omits user_id');
  PERFORM pg_temp.ok(NOT (p ? 'id'),          'payload omits id');
  PERFORM pg_temp.ok(NOT (p ? 'email'),       'payload omits email');
  PERFORM pg_temp.ok(NOT (p ? 'questions'),   'payload omits raw questions');
  PERFORM pg_temp.ok(NOT (p ? 'session_key'), 'payload omits session_key');
  PERFORM pg_temp.ok(p::TEXT NOT LIKE '%@example.test%', 'payload contains no email string');

  -- ── Aggregates ────────────────────────────────────────────────
  PERFORM pg_temp.ok((p->>'total_games')::INT = 40, 'total_games counts every session');
  PERFORM pg_temp.ok((p->>'accuracy')::NUMERIC BETWEEN 0 AND 1, 'accuracy is a 0..1 fraction');

  PERFORM pg_temp.ok((p->'bests') ?  '60',  'bests includes 60');
  PERFORM pg_temp.ok((p->'bests') ?  '120', 'bests includes 120');
  PERFORM pg_temp.ok((p->'bests') ?  '180', 'bests includes 180');
  PERFORM pg_temp.ok((p->'bests') ?  '300', 'bests includes 300');

  -- Durations never played must be ABSENT, not zero.
  q := public.get_public_profile('sixtyonly');
  PERFORM pg_temp.ok(q->'bests' ? '60',            'sixtyonly has a 60s best');
  PERFORM pg_temp.ok(NOT (q->'bests' ? '120'),     'unplayed duration is absent, not 0');
  PERFORM pg_temp.ok(jsonb_typeof(q->'bests') = 'object', 'bests is an object');

  -- ── Empty player ──────────────────────────────────────────────
  q := public.get_public_profile('neverplayed');
  PERFORM pg_temp.ok(q IS NOT NULL,                  'a player with no games still has a profile');
  PERFORM pg_temp.ok((q->>'total_games')::INT = 0,   'zero games reported as 0');
  PERFORM pg_temp.ok(q->'bests' = '{}'::jsonb,       'no games yields empty bests object (not null)');
  PERFORM pg_temp.ok(q->'ops'   = '{}'::jsonb,       'no games yields empty ops object (not null)');
  PERFORM pg_temp.ok(jsonb_typeof(q->'history') = 'array', 'history is always an array');

  -- ── Operations ────────────────────────────────────────────────
  PERFORM pg_temp.ok((p->'ops') ? 'addition',       'ops includes addition');
  PERFORM pg_temp.ok((p->'ops') ? 'division',       'ops includes division');
  PERFORM pg_temp.ok(
    (p->'ops'->'division'->>'avg_ms')::NUMERIC > (p->'ops'->'addition'->>'avg_ms')::NUMERIC,
    'division is slower than addition, per the seeded timing bands');
  PERFORM pg_temp.ok((p->'ops'->'addition'->>'count')::INT > 0, 'op count is populated');
  PERFORM pg_temp.ok((p->'ops'->'addition'->>'accuracy')::NUMERIC BETWEEN 0 AND 1,
    'op accuracy is a 0..1 fraction');

  -- ── History ───────────────────────────────────────────────────
  n := jsonb_array_length(p->'history');
  PERFORM pg_temp.ok(n > 0 AND n <= 500, 'history is capped at 500 entries');
  PERFORM pg_temp.ok(
    (p->'history'->0->>'d')::DATE <= (p->'history'->(n-1)->>'d')::DATE,
    'history is ordered oldest first');
  -- hexadecimal has exactly 40 sessions and the cap is 500, so the cap must
  -- not be truncating here. Asserted as an exact number rather than "<= 500",
  -- which a cap of 1 would also satisfy.
  PERFORM pg_temp.ok(n = 40, 'all 40 of hexadecimal''s sessions are returned, not a slice');

  -- ── History: per-session accuracy ─────────────────────────────
  -- accplayer's three sessions are hand-counted in 01-seed.sql, oldest
  -- first: accs1 (10 questions, 2 mistakes), accs2 (4, none), accs3 (empty).
  q := public.get_public_profile('accplayer');
  PERFORM pg_temp.ok(jsonb_array_length(q->'history') = 3,
    'accplayer has exactly the three seeded sessions');
  PERFORM pg_temp.ok((q->'history'->0->>'acc')::INT = 80,
    '2 mistakes in 10 questions is 80, not 0.8 and not 20');
  PERFORM pg_temp.ok((q->'history'->1->>'acc')::INT = 100,
    'a clean session is 100');
  -- The distinction that matters: no questions is not the same claim as
  -- every question wrong.
  PERFORM pg_temp.ok(jsonb_typeof(q->'history'->2->'acc') = 'null',
    'a session with no questions reports acc null, not 0');
  PERFORM pg_temp.ok((q->'history'->0->>'score')::INT = 31
                     AND (q->'history'->0->>'duration')::INT = 120,
    'the entry carries score and duration alongside acc');

  -- ── History: a malformed questions payload ────────────────────
  -- `questions` is client-supplied with no shape constraint beyond "is an
  -- array", so this must neither abort the function nor miscount.
  q := public.get_public_profile('malformed');
  PERFORM pg_temp.ok(jsonb_array_length(q->'history') = 2,
    'a malformed payload still yields its history entries');
  PERFORM pg_temp.ok((q->'history'->0->>'acc')::INT = 100,
    'non-object entries are skipped, and a STRING "true" hadMistake is not a mistake');
  PERFORM pg_temp.ok(jsonb_typeof(q->'history'->1->'acc') = 'null',
    'an array with no objects in it scores null rather than dividing by zero');

  -- ── History: the session key is owner-only ────────────────────
  -- This is the one identifier get_public_profile emits. A stranger must
  -- never receive one: it is the argument to results.html, which renders the
  -- whole question list of that game.
  PERFORM pg_temp.as_anon();
  q := public.get_public_profile('hexadecimal');
  PERFORM pg_temp.ok(
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q->'history') AS e
                WHERE (e->>'key') IS NOT NULL),
    'anon receives no session key on any history entry');
  -- Belt and braces: assert the key never appears anywhere in the serialised
  -- payload, so a key smuggled under a different name is caught too.
  PERFORM pg_temp.ok(q::TEXT NOT LIKE '%hex1%',
    'no session_key string appears anywhere in an anonymous payload');

  PERFORM pg_temp.as_user('hexadecimal');
  q := public.get_public_profile('hexadecimal');
  PERFORM pg_temp.ok(
    (SELECT COUNT(*) FROM jsonb_array_elements(q->'history') AS e
     WHERE (e->>'key') IS NOT NULL) = 40,
    'the owner receives a key on every one of their 40 entries');
  PERFORM pg_temp.ok(
    EXISTS (SELECT 1 FROM jsonb_array_elements(q->'history') AS e
            WHERE e->>'key' = 'hex1'),
    'and the keys are the real session_key values, not a hash or an index');

  -- A signed-in user looking at SOMEBODY ELSE's public profile is still a
  -- stranger to it. is_owner is per-profile, not "is logged in".
  PERFORM pg_temp.as_user('sixtyonly');
  q := public.get_public_profile('hexadecimal');
  PERFORM pg_temp.ok(
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q->'history') AS e
                WHERE (e->>'key') IS NOT NULL),
    'a signed-in visitor gets no session keys from a profile that is not theirs');

  PERFORM pg_temp.as_anon();

  -- ── Streak ────────────────────────────────────────────────────
  PERFORM pg_temp.ok((p->>'streak')::INT = 6,
    'a six-day consecutive run reports streak 6');
  PERFORM pg_temp.ok((public.get_public_profile('brokenstreak')->>'streak')::INT = 0,
    'a streak that ended 10 days ago reports 0');
  PERFORM pg_temp.ok((p->>'days_practiced')::INT > 0, 'days_practiced is populated');

  RAISE NOTICE '--- get_public_profile OK ---';
END $$;

-- ── Percentile ──────────────────────────────────────────────────
DO $$
DECLARE
  r120 JSONB; rlow JSONB; rhigh JSONB; r300 JSONB;
BEGIN
  PERFORM pg_temp.as_anon();

  r120 := public.get_score_percentile(50, 120);
  PERFORM pg_temp.ok((r120->>'players')::INT >= 20, '120s population is the seeded player count');
  PERFORM pg_temp.ok((r120->>'score')::INT = 50,     'echoes the score back');
  PERFORM pg_temp.ok((r120->>'duration')::INT = 120, 'echoes the duration back');
  PERFORM pg_temp.ok((r120->>'percentile')::NUMERIC BETWEEN 0 AND 1, 'percentile is a 0..1 fraction');

  -- The anonymous 9999 row must not be in the population.
  PERFORM pg_temp.ok(
    (public.get_score_percentile(9998, 120)->>'percentile')::NUMERIC = 1.0,
    'a score above every PLAYER is 100th percentile — the anonymous 9999 row is excluded');

  -- Monotonicity.
  rlow  := public.get_score_percentile(20, 120);
  rhigh := public.get_score_percentile(85, 120);
  PERFORM pg_temp.ok(
    (rlow->>'percentile')::NUMERIC <= (rhigh->>'percentile')::NUMERIC,
    'percentile is monotonic in score');
  PERFORM pg_temp.ok((rlow->>'percentile')::NUMERIC = 0,
    'a score below every player is 0th percentile');

  -- Thin population → null percentile but an honest player count.
  r300 := public.get_score_percentile(60, 300);
  PERFORM pg_temp.ok((r300->>'players')::INT < 5, '300s has a thin population in the fixture');
  PERFORM pg_temp.ok(r300->>'percentile' IS NULL,
    'percentile suppressed below 5 players');
  PERFORM pg_temp.ok((r300->>'players') IS NOT NULL,
    'player count still reported when percentile is suppressed');

  -- A duration nobody has played at all must not divide by zero.
  PERFORM pg_temp.ok(public.get_score_percentile(50, 999) IS NOT NULL,
    'an unplayed duration returns a payload rather than erroring');
  PERFORM pg_temp.ok((public.get_score_percentile(50, 999)->>'players')::INT = 0,
    'an unplayed duration reports zero players');

  -- A missing score must not be silently placed at the bottom of the field.
  PERFORM pg_temp.ok(public.get_score_percentile(NULL, 120)->>'percentile' IS NULL,
    'a NULL score yields a NULL percentile, not 0');

  RAISE NOTICE '--- get_score_percentile OK ---';
END $$;

SELECT 'ALL CONTRACT TESTS PASSED' AS result;
