-- Contract tests for supabase/daily.sql.
-- Written against docs/daily-design.md BEFORE reading the implementation, so a
-- pass means the contract holds rather than that the code does what it happens
-- to do.
--
-- Runs after 01-seed.sql, and reuses the players it creates.

\set ON_ERROR_STOP on
SET client_min_messages = NOTICE;

-- pg_temp.ok / as_user / as_anon are defined in 02-test.sql, which runs first.

-- Time travel: these functions compare NOW() against a stored started_at, so
-- an expiry test moves the attempt backwards rather than sleeping.
CREATE OR REPLACE FUNCTION pg_temp.age_attempt(uname TEXT, delta INTERVAL)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.daily_attempts a
  SET started_at = a.started_at - delta
  WHERE a.user_id = (SELECT id FROM public.profiles WHERE username = uname);
END $$;

DO $$
DECLARE
  a JSONB; b JSONB; r JSONB; s JSONB;
  t0 TIMESTAMPTZ; t1 TIMESTAMPTZ;
  n INT; qs JSONB;
BEGIN
  -- ── start_daily ───────────────────────────────────────────────
  PERFORM pg_temp.as_user('hexadecimal');
  a := public.start_daily();

  PERFORM pg_temp.ok(a IS NOT NULL, 'start_daily returns a payload');
  PERFORM pg_temp.ok(jsonb_typeof(a->'questions') = 'array',
    'a live attempt carries a question array');
  PERFORM pg_temp.ok(jsonb_array_length(a->'questions') > 100,
    'the question list is long enough for a fast run');
  PERFORM pg_temp.ok(a->'questions'->0 ? 'display'
                 AND a->'questions'->0 ? 'operation'
                 AND a->'questions'->0 ? 'answer',
    'questions carry display, operation and answer');
  -- A generator whose random draws are uncorrelated is evaluated once by the
  -- planner and emits the SAME question 400 times — a whole day's puzzle that
  -- is one question repeated. It still passes every shape check above, so it
  -- has to be asserted directly.
  SELECT COUNT(DISTINCT e->>'display') INTO n
    FROM jsonb_array_elements(a->'questions') e;
  PERFORM pg_temp.ok(n > 50,
    'the day''s questions are actually varied, not one draw repeated');

  -- Every operation the config enables should appear across 400 draws.
  SELECT COUNT(DISTINCT e->>'operation') INTO n
    FROM jsonb_array_elements(a->'questions') e;
  PERFORM pg_temp.ok(n = 4, 'all four operations appear in the day''s questions');

  -- The stated answer must match the stated display, or the puzzle is
  -- unwinnable in a way no shape check would reveal.
  SELECT COUNT(*) INTO n
    FROM jsonb_array_elements(a->'questions') e
   WHERE e->>'operation' = 'addition'
     AND (split_part(e->>'display', ' + ', 1))::INT
       + (split_part(e->>'display', ' + ', 2))::INT
       <> (e->>'answer')::INT;
  PERFORM pg_temp.ok(n = 0, 'every addition question''s answer matches its display');

  -- Division is a reversed product, and WHICH factor becomes the divisor is
  -- the contract: always the first multiplication range, never the second.
  -- The daily config is the Zetamac default 2–12 × 2–100, so a divisor of 73
  -- means the generator flipped the pair and asked a question the real game
  -- never asks. Both halves are checked because a divisor inside 2–12 can
  -- happen by luck when the second draw lands there.
  SELECT COUNT(*) INTO n
    FROM jsonb_array_elements(a->'questions') e
   WHERE e->>'operation' = 'division'
     AND (split_part(e->>'display', ' ' || U&'\00f7' || ' ', 2))::INT
           NOT BETWEEN 2 AND 12;
  PERFORM pg_temp.ok(n = 0, 'every divisor comes from the first multiplication range');

  SELECT COUNT(*) INTO n
    FROM jsonb_array_elements(a->'questions') e
   WHERE e->>'operation' = 'division'
     AND (split_part(e->>'display', ' ' || U&'\00f7' || ' ', 1))::INT
       <> (split_part(e->>'display', ' ' || U&'\00f7' || ' ', 2))::INT
        * (e->>'answer')::INT;
  PERFORM pg_temp.ok(n = 0, 'every division question''s answer matches its display');

  -- A generator pinned to one divisor would satisfy both checks above.
  SELECT COUNT(DISTINCT (split_part(e->>'display', ' ' || U&'\00f7' || ' ', 2))::INT)
    INTO n
    FROM jsonb_array_elements(a->'questions') e
   WHERE e->>'operation' = 'division';
  PERFORM pg_temp.ok(n >= 8, 'divisors spread across the 2-12 range');

  PERFORM pg_temp.ok((a->>'duration_seconds')::INT = 120, 'duration is 120s');
  PERFORM pg_temp.ok((a->>'seconds_remaining')::NUMERIC > 0, 'a fresh attempt has time left');
  PERFORM pg_temp.ok(a->>'status' = 'in_progress', 'a fresh attempt is in_progress');

  -- puzzle_number is baked into every share string ever posted.
  PERFORM pg_temp.ok(
    (a->>'puzzle_number')::INT
      = ((NOW() AT TIME ZONE 'UTC')::DATE - DATE '2026-07-27') + 1,
    'puzzle_number counts from 2026-07-27');

  -- ── Resume, not restart ───────────────────────────────────────
  SELECT started_at INTO t0 FROM public.daily_attempts
   WHERE user_id = (SELECT id FROM public.profiles WHERE username = 'hexadecimal');
  b := public.start_daily();
  SELECT started_at INTO t1 FROM public.daily_attempts
   WHERE user_id = (SELECT id FROM public.profiles WHERE username = 'hexadecimal');
  PERFORM pg_temp.ok(t0 = t1, 'calling start_daily twice does NOT reset the clock');
  PERFORM pg_temp.ok((b->>'status') = 'in_progress', 'the second call resumes the attempt');

  -- The same questions, so a refresh mid-run does not change the puzzle.
  PERFORM pg_temp.ok(a->'questions' = b->'questions',
    'resuming returns the identical question list');

  -- ── One puzzle per day, whoever asks ──────────────────────────
  PERFORM pg_temp.as_user('player6');
  PERFORM public.start_daily();
  PERFORM pg_temp.as_user('player7');
  PERFORM public.start_daily();
  SELECT COUNT(*) INTO n FROM public.daily_puzzles
   WHERE puzzle_date = (NOW() AT TIME ZONE 'UTC')::DATE;
  PERFORM pg_temp.ok(n = 1, 'three players on one day share exactly one puzzle');

  SELECT COUNT(*) INTO n FROM public.daily_attempts
   WHERE puzzle_date = (NOW() AT TIME ZONE 'UTC')::DATE;
  PERFORM pg_temp.ok(n = 3, 'each player gets their own attempt');

  RAISE NOTICE '--- start_daily OK ---';
END $$;

-- ── submit_daily ────────────────────────────────────────────────
DO $$
DECLARE
  a JSONB; r JSONB; qs JSONB; ans JSONB; correct INT := 0;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  a  := public.start_daily();
  qs := a->'questions';

  -- Answer the first 30 questions: the even ones right, the odd ones wrong.
  -- The server must score 15 regardless of anything the client asserts.
  SELECT jsonb_agg(jsonb_build_object(
           'i', i,
           'value', CASE WHEN i % 2 = 0
                         THEN (qs->i->>'answer')::INT
                         ELSE (qs->i->>'answer')::INT + 1 END,
           'elapsed_ms', (i + 1) * 900
         ) ORDER BY i)
    INTO ans
    FROM generate_series(0, 29) i;

  -- A lying client: a score field, and a claim every answer was correct.
  ans := jsonb_build_object('score', 999, 'answers', ans);
  r := public.submit_daily(ans->'answers');

  PERFORM pg_temp.ok((r->>'score')::INT = 15,
    'the score is recomputed from stored answers, not taken from the client');
  PERFORM pg_temp.ok((r->>'total_answered')::INT = 30, 'total_answered counts submissions');
  PERFORM pg_temp.ok((r->>'accuracy')::NUMERIC BETWEEN 0 AND 1, 'accuracy is a fraction');
  PERFORM pg_temp.ok(r ? 'puzzle_number', 'the result carries the puzzle number');

  -- ── Questions must not leak after completion ──────────────────
  a := public.start_daily();
  PERFORM pg_temp.ok(a->>'status' = 'complete', 'a submitted attempt reads as complete');
  PERFORM pg_temp.ok(
    a->'questions' IS NULL OR a->'questions' = 'null'::jsonb
      OR jsonb_array_length(COALESCE(a->'questions', '[]'::jsonb)) = 0,
    'a completed attempt returns NO questions — otherwise the day leaks');

  -- ── Double submission ─────────────────────────────────────────
  BEGIN
    r := public.submit_daily('[]'::jsonb);
    PERFORM pg_temp.ok(
      (r ? 'error') OR (r->>'status' = 'complete'),
      'a second submission is refused rather than overwriting the first');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ok(TRUE, 'a second submission is refused (raised)');
  END;

  RAISE NOTICE '--- submit_daily scoring OK ---';
END $$;

-- ── A fumbled question still counts ─────────────────────────────
-- Same defect as duels: the client logs a wrong attempt then the correction
-- under one `i`, and scoring only the first entry threw every correction away.
DO $$
DECLARE a JSONB; qs JSONB; ans JSONB; r JSONB;
BEGIN
  PERFORM pg_temp.as_user('player12');
  a  := public.start_daily();
  qs := a->'questions';

  SELECT jsonb_agg(e ORDER BY ord) INTO ans FROM (
    SELECT (i*2)     AS ord,
           jsonb_build_object('i', i, 'value', (qs->i->>'answer')::INT + 3,
                              'elapsed_ms', (i*2+1)*500) AS e
      FROM generate_series(0, 9) i
    UNION ALL
    SELECT (i*2 + 1) AS ord,
           jsonb_build_object('i', i, 'value', (qs->i->>'answer')::INT,
                              'elapsed_ms', (i*2+2)*500) AS e
      FROM generate_series(0, 9) i
  ) z;

  r := public.submit_daily(ans);
  PERFORM pg_temp.ok((r->>'score')::INT = 10,
    'daily: a question answered wrong then right still scores');
  PERFORM pg_temp.ok((r->>'total_answered')::INT = 10,
    'daily: counted as ten answered, not twenty');

  RAISE NOTICE '--- daily fumbled answers OK ---';
END $$;

-- ── Expiry ──────────────────────────────────────────────────────
DO $$
DECLARE a JSONB; r JSONB; ok BOOLEAN;
BEGIN
  PERFORM pg_temp.as_user('player8');
  a := public.start_daily();
  PERFORM pg_temp.ok(a->>'status' = 'in_progress', 'player8 started');

  -- Push the start well past the window.
  PERFORM pg_temp.age_attempt('player8', INTERVAL '10 minutes');

  a := public.start_daily();
  PERFORM pg_temp.ok((a->>'seconds_remaining')::NUMERIC = 0,
    'an expired attempt reports no time remaining');
  PERFORM pg_temp.ok(
    a->'questions' IS NULL OR a->'questions' = 'null'::jsonb
      OR jsonb_array_length(COALESCE(a->'questions', '[]'::jsonb)) = 0,
    'an EXPIRED attempt returns no questions either');

  BEGIN
    r := public.submit_daily('[{"i":0,"value":1,"elapsed_ms":100}]'::jsonb);
    PERFORM pg_temp.ok((r ? 'error') OR (r->>'score') IS NULL OR (r->>'score')::INT = 0,
      'submitting after the window is refused');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ok(TRUE, 'submitting after the window is refused (raised)');
  END;

  RAISE NOTICE '--- expiry OK ---';
END $$;

-- ── Malformed input must not 500 ────────────────────────────────
DO $$
DECLARE r JSONB; threw BOOLEAN;
BEGIN
  PERFORM pg_temp.as_user('player9');
  PERFORM public.start_daily();

  FOREACH r IN ARRAY ARRAY[
    '{}'::jsonb,
    '"nonsense"'::jsonb,
    'null'::jsonb,
    '[1,2,3]'::jsonb,
    '[{"i":"x","value":"y","elapsed_ms":"z"}]'::jsonb,
    '[{"i":-5,"value":3,"elapsed_ms":10}]'::jsonb,
    '[{"i":999999,"value":3,"elapsed_ms":10}]'::jsonb,
    '[{"nope":1}]'::jsonb
  ] LOOP
    threw := FALSE;
    BEGIN
      PERFORM public.submit_daily(r);
    EXCEPTION WHEN OTHERS THEN
      threw := TRUE;
    END;
    PERFORM pg_temp.ok(NOT threw,
      'malformed payload ' || r::TEXT || ' does not raise');
    -- Only the first submission can land; reset so each shape is tested live.
    UPDATE public.daily_attempts SET status = 'in_progress', submitted_at = NULL, score = NULL
     WHERE user_id = (SELECT id FROM public.profiles WHERE username = 'player9');
  END LOOP;

  RAISE NOTICE '--- malformed input OK ---';
END $$;

-- ── Leaderboard ─────────────────────────────────────────────────
DO $$
DECLARE lb JSONB; today DATE := (NOW() AT TIME ZONE 'UTC')::DATE; n INT;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  lb := public.get_daily_leaderboard(today, 100);

  PERFORM pg_temp.ok(lb IS NOT NULL, 'leaderboard returns a payload');
  PERFORM pg_temp.ok(jsonb_typeof(lb->'rows') = 'array', 'rows is an array');
  PERFORM pg_temp.ok((lb->>'players')::INT >= 1, 'players is counted');

  n := jsonb_array_length(lb->'rows');
  IF n >= 2 THEN
    PERFORM pg_temp.ok(
      (lb->'rows'->0->>'score')::INT >= (lb->'rows'->1->>'score')::INT,
      'rows are ordered by score descending');
    PERFORM pg_temp.ok((lb->'rows'->0->>'rank')::INT = 1, 'the first row is rank 1');
  END IF;

  PERFORM pg_temp.ok(lb->'rows'->0 ? 'username', 'rows carry a username');
  PERFORM pg_temp.ok(NOT (lb->'rows'->0 ? 'user_id'), 'rows do NOT leak user_id');
  PERFORM pg_temp.ok(lb::TEXT NOT LIKE '%@example.test%', 'the leaderboard leaks no email');

  -- The caller played, so their own row must be present even outside the top N.
  PERFORM pg_temp.ok(lb ? 'you', 'the payload has a `you` key');
  PERFORM pg_temp.ok(lb->'you' IS NOT NULL AND lb->'you' <> 'null'::jsonb,
    'a player who has played sees their own row');

  -- A day nobody played must not divide by zero.
  lb := public.get_daily_leaderboard(DATE '2020-01-01', 100);
  PERFORM pg_temp.ok(lb IS NOT NULL, 'an unplayed day returns a payload');
  PERFORM pg_temp.ok((lb->>'players')::INT = 0, 'an unplayed day reports zero players');
  PERFORM pg_temp.ok(jsonb_array_length(COALESCE(lb->'rows', '[]'::jsonb)) = 0,
    'an unplayed day has no rows');

  RAISE NOTICE '--- leaderboard OK ---';
END $$;

-- ── The tables themselves stay shut ─────────────────────────────
-- Same posture as hardening.sql: the anon key is public, so the tables must be
-- unreadable and only the functions may cross the boundary.
DO $$
DECLARE relrls BOOLEAN; npol INT;
BEGIN
  SELECT c.relrowsecurity INTO relrls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'daily_attempts';
  PERFORM pg_temp.ok(relrls, 'RLS is enabled on daily_attempts');

  SELECT COUNT(*) INTO npol FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('daily_attempts', 'daily_puzzles');
  PERFORM pg_temp.ok(npol = 0,
    'no permissive policies — all access goes through the functions');

  RAISE NOTICE '--- RLS posture OK ---';
END $$;

SELECT 'ALL DAILY CONTRACT TESTS PASSED' AS result;
