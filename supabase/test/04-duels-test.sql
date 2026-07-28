-- Contract tests for supabase/duels.sql.
-- Written against docs/duels-design.md before reading the implementation.
-- Runs after 01-seed.sql; pg_temp.ok / as_user / as_anon come from 02-test.sql.

\set ON_ERROR_STOP on
SET client_min_messages = NOTICE;

CREATE OR REPLACE FUNCTION pg_temp.age_duel(p_key TEXT, delta INTERVAL)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.duels SET created_at = created_at - delta,
                          expires_at = expires_at - delta
   WHERE duel_key = p_key;
  UPDATE public.duel_runs r SET started_at = r.started_at - delta
   WHERE r.duel_id = (SELECT id FROM public.duels WHERE duel_key = p_key);
END $$;

-- Score a live run correctly, `n` answers, using the questions the server gave.
CREATE OR REPLACE FUNCTION pg_temp.answer_run(p_key TEXT, p_guest TEXT, n INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE run JSONB; qs JSONB; ans JSONB;
BEGIN
  run := public.start_duel_run(p_key, p_guest);
  qs  := run->'questions';
  SELECT jsonb_agg(jsonb_build_object(
           'i', i, 'value', (qs->i->>'answer')::INT, 'elapsed_ms', (i + 1) * 800
         ) ORDER BY i)
    INTO ans FROM generate_series(0, n - 1) i;
  RETURN public.submit_duel_run(p_key, p_guest, COALESCE(ans, '[]'::jsonb));
END $$;

-- ── Creation, and the creator playing both sides ────────────────
DO $$
DECLARE d JSONB; k TEXT; r JSONB; v JSONB; threw BOOLEAN; n INT;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  d := public.create_duel(120);
  PERFORM pg_temp.ok(d IS NOT NULL,            'create_duel returns a payload');
  PERFORM pg_temp.ok(d ? 'duel_key',           'the payload carries a duel_key');
  PERFORM pg_temp.ok(length(d->>'duel_key') >= 8, 'the key is not trivially short');
  PERFORM pg_temp.ok(d ? 'expires_at',         'the payload carries an expiry');
  k := d->>'duel_key';

  -- The duel's public face must never carry the questions.
  v := public.get_duel_by_key(k, NULL);
  PERFORM pg_temp.ok(v IS NOT NULL, 'get_duel_by_key resolves a real key');
  PERFORM pg_temp.ok(NOT (v ? 'questions')
                  OR v->'questions' IS NULL
                  OR v->'questions' = 'null'::jsonb,
    'get_duel_by_key NEVER returns questions');
  PERFORM pg_temp.ok(v::TEXT NOT LIKE '%@example.test%', 'no email leaks into the duel view');

  -- Who challenged you. An invite that says "somebody sent you this duel" is
  -- a poor thing to receive from a friend.
  PERFORM pg_temp.ok(v->'creator'->>'username' = 'hexadecimal',
    'the duel names its creator');
  PERFORM pg_temp.ok(v->'opponent'->>'username' IS NULL,
    'an unclaimed opponent side has no name');
  -- A name is not a score, so it is NOT behind the reveal gate: the payload
  -- names the creator while the duel is still unfinished.
  PERFORM pg_temp.ok((v->>'scores_revealed')::BOOLEAN IS FALSE
                 AND v->'creator'->>'username' IS NOT NULL,
    'the creator is named before any score is revealed');
  PERFORM pg_temp.ok(NOT (v->'creator' ? 'user_id'), 'naming a side leaks no user_id');

  -- The creator starts. They take `creator` and only `creator`.
  r := public.start_duel_run(k, NULL);
  PERFORM pg_temp.ok(r->>'side' = 'creator', 'the creator takes the creator side');
  PERFORM pg_temp.ok(jsonb_typeof(r->'questions') = 'array',
    'start_duel_run hands over the questions');
  PERFORM pg_temp.ok(jsonb_array_length(r->'questions') > 100, 'enough questions for a fast run');

  SELECT COUNT(DISTINCT e->>'display') INTO n
    FROM jsonb_array_elements(r->'questions') e;
  PERFORM pg_temp.ok(n > 50, 'duel questions are varied, not one draw repeated');

  -- Calling again must resume, not restart, and not open a second side.
  r := public.start_duel_run(k, NULL);
  PERFORM pg_temp.ok(r->>'side' = 'creator', 'a second call keeps the same side');
  SELECT COUNT(*) INTO n FROM public.duel_runs
   WHERE duel_id = (SELECT id FROM public.duels WHERE duel_key = k);
  PERFORM pg_temp.ok(n = 1,
    'the creator opening their own link twice does NOT claim the opponent side');

  -- Even with a guest token, the creator is still the creator.
  r := public.start_duel_run(k, 'guest-pretending-to-be-someone');
  PERFORM pg_temp.ok(r->>'side' = 'creator',
    'the creator cannot become the opponent by supplying a guest token');
  SELECT COUNT(*) INTO n FROM public.duel_runs
   WHERE duel_id = (SELECT id FROM public.duels WHERE duel_key = k);
  PERFORM pg_temp.ok(n = 1, 'still exactly one run — no second side was opened');

  RAISE NOTICE '--- create/side-assignment OK ---';
END $$;

-- ── Opponents, guests, and third parties ────────────────────────
DO $$
DECLARE d JSONB; k TEXT; r JSONB; t0 TIMESTAMPTZ; t1 TIMESTAMPTZ; threw BOOLEAN; n INT;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  k := (public.create_duel(120))->>'duel_key';
  PERFORM public.start_duel_run(k, NULL);              -- creator claims

  -- A signed-in stranger takes the opponent side.
  PERFORM pg_temp.as_user('player6');
  r := public.start_duel_run(k, NULL);
  PERFORM pg_temp.ok(r->>'side' = 'opponent', 'a stranger takes the opponent side');

  SELECT started_at INTO t0 FROM public.duel_runs
   WHERE duel_id = (SELECT id FROM public.duels WHERE duel_key = k) AND side = 'opponent';
  PERFORM public.start_duel_run(k, NULL);
  SELECT started_at INTO t1 FROM public.duel_runs
   WHERE duel_id = (SELECT id FROM public.duels WHERE duel_key = k) AND side = 'opponent';
  PERFORM pg_temp.ok(t0 = t1, 'start_duel_run twice does NOT reset the opponent clock');

  -- A third signed-in arrival is a spectator, not a player.
  PERFORM pg_temp.as_user('player7');
  threw := FALSE;
  BEGIN
    r := public.start_duel_run(k, NULL);
    PERFORM pg_temp.ok(r ? 'error' OR (r->>'side') IS NULL,
      'a third arrival is refused a side');
  EXCEPTION WHEN OTHERS THEN
    threw := TRUE;
    PERFORM pg_temp.ok(TRUE, 'a third arrival is refused a side (raised)');
  END;
  SELECT COUNT(*) INTO n FROM public.duel_runs
   WHERE duel_id = (SELECT id FROM public.duels WHERE duel_key = k);
  PERFORM pg_temp.ok(n = 2, 'a duel never holds more than two runs');

  RAISE NOTICE '--- opponent/third-party OK ---';
END $$;

-- ── Guest identity ──────────────────────────────────────────────
DO $$
DECLARE k TEXT; r JSONB; n INT; threw BOOLEAN;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  k := (public.create_duel(120))->>'duel_key';
  PERFORM public.start_duel_run(k, NULL);

  -- A guest claims the opponent side.
  PERFORM pg_temp.as_anon();
  r := public.start_duel_run(k, 'guest-aaa');
  PERFORM pg_temp.ok(r->>'side' = 'opponent', 'a guest can claim the opponent side');

  -- The same token resumes rather than being treated as someone new.
  r := public.start_duel_run(k, 'guest-aaa');
  PERFORM pg_temp.ok(r->>'side' = 'opponent', 'the same guest token resumes');

  -- A guest has no profile, so the side stays nameless rather than inventing
  -- one. The client renders this as "Guest".
  PERFORM pg_temp.ok(
    public.get_duel_by_key(k, 'guest-aaa')->'opponent'->>'username' IS NULL,
    'a guest opponent is nameless, not fabricated');
  PERFORM pg_temp.ok(
    public.get_duel_by_key(k, 'guest-aaa')->'creator'->>'username' = 'hexadecimal',
    'a guest can still see who challenged them');
  SELECT COUNT(*) INTO n FROM public.duel_runs
   WHERE duel_id = (SELECT id FROM public.duels WHERE duel_key = k);
  PERFORM pg_temp.ok(n = 2, 'resuming created no extra run');

  -- A different token is a different person, and the side is taken.
  BEGIN
    r := public.start_duel_run(k, 'guest-bbb');
    PERFORM pg_temp.ok(r ? 'error' OR (r->>'side') IS NULL,
      'a different guest token is refused the claimed side');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ok(TRUE, 'a different guest token is refused (raised)');
  END;

  -- An empty/NULL token must not match the stored one by accident.
  BEGIN
    r := public.start_duel_run(k, NULL);
    PERFORM pg_temp.ok(r ? 'error' OR (r->>'side') IS NULL,
      'an anonymous caller with NO token cannot inherit a guest run');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ok(TRUE, 'an anonymous caller with no token is refused (raised)');
  END;

  RAISE NOTICE '--- guest identity OK ---';
END $$;

-- ── Scores stay hidden until both are done ──────────────────────
DO $$
DECLARE k TEXT; v JSONB; r JSONB; body TEXT;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  k := (public.create_duel(120))->>'duel_key';
  r := pg_temp.answer_run(k, NULL, 20);
  PERFORM pg_temp.ok((r->>'score')::INT = 20, 'the creator scored 20 of 20');

  -- The opponent looks at the duel BEFORE playing. They must not learn 20.
  PERFORM pg_temp.as_user('player6');
  v := public.get_duel_by_key(k, NULL);
  body := v::TEXT;
  PERFORM pg_temp.ok(v IS NOT NULL, 'the opponent can see the duel exists');
  PERFORM pg_temp.ok(body NOT LIKE '%20%' OR (v->'creator'->>'score') IS NULL,
    'the opponent cannot see the creator score before playing');
  PERFORM pg_temp.ok((v->'creator'->>'score') IS NULL,
    'creator score is withheld while the duel is unfinished');

  -- Now the opponent plays; both scores become visible.
  r := pg_temp.answer_run(k, NULL, 12);
  PERFORM pg_temp.ok((r->>'score')::INT = 12, 'the opponent scored 12 of 12');

  v := public.get_duel_by_key(k, NULL);
  PERFORM pg_temp.ok((v->'creator'->>'score')::INT  = 20, 'creator score revealed once both are done');
  PERFORM pg_temp.ok((v->'opponent'->>'score')::INT = 12, 'opponent score revealed once both are done');
  PERFORM pg_temp.ok(v->>'status' = 'complete', 'the duel reads as complete');

  RAISE NOTICE '--- score visibility OK ---';
END $$;

-- ── Scoring is not the client's opinion ─────────────────────────
DO $$
DECLARE k TEXT; run JSONB; qs JSONB; ans JSONB; r JSONB;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  k   := (public.create_duel(120))->>'duel_key';
  run := public.start_duel_run(k, NULL);
  qs  := run->'questions';

  -- 30 answers, evens right and odds wrong: the server must say 15.
  SELECT jsonb_agg(jsonb_build_object(
           'i', i,
           'value', CASE WHEN i % 2 = 0 THEN (qs->i->>'answer')::INT
                                        ELSE (qs->i->>'answer')::INT + 1 END,
           'elapsed_ms', (i + 1) * 700
         ) ORDER BY i)
    INTO ans FROM generate_series(0, 29) i;

  r := public.submit_duel_run(k, NULL, ans);
  PERFORM pg_temp.ok((r->>'score')::INT = 15,
    'the score is recomputed server-side, not taken from the client');

  -- A second submission must not overwrite the first.
  BEGIN
    r := public.submit_duel_run(k, NULL, ans);
    PERFORM pg_temp.ok(r ? 'error' OR (r->>'score')::INT = 15,
      'a second submission is refused');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ok(TRUE, 'a second submission is refused (raised)');
  END;

  RAISE NOTICE '--- scoring OK ---';
END $$;

-- ── Malformed input must not 500 ────────────────────────────────
DO $$
DECLARE k TEXT; bad JSONB; threw BOOLEAN;
BEGIN
  PERFORM pg_temp.as_user('player8');
  k := (public.create_duel(120))->>'duel_key';
  PERFORM public.start_duel_run(k, NULL);

  FOREACH bad IN ARRAY ARRAY[
    '{}'::jsonb, '"nope"'::jsonb, 'null'::jsonb, '[1,2,3]'::jsonb,
    '[{"i":"x","value":"y","elapsed_ms":"z"}]'::jsonb,
    '[{"nope":1}]'::jsonb,
    '[{"i":999999,"value":3,"elapsed_ms":10}]'::jsonb
  ] LOOP
    threw := FALSE;
    BEGIN
      PERFORM public.submit_duel_run(k, NULL, bad);
    EXCEPTION WHEN OTHERS THEN threw := TRUE;
    END;
    PERFORM pg_temp.ok(NOT threw, 'malformed ' || bad::TEXT || ' does not raise');
    UPDATE public.duel_runs SET status = 'in_progress', submitted_at = NULL, score = NULL
     WHERE duel_id = (SELECT id FROM public.duels WHERE duel_key = k);
  END LOOP;

  RAISE NOTICE '--- malformed input OK ---';
END $$;

-- ── Expiry and walkover ─────────────────────────────────────────
DO $$
DECLARE k TEXT; v JSONB; r JSONB;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  k := (public.create_duel(120))->>'duel_key';
  PERFORM pg_temp.answer_run(k, NULL, 10);       -- only the creator plays

  PERFORM pg_temp.age_duel(k, INTERVAL '49 hours');

  v := public.get_duel_by_key(k, NULL);
  PERFORM pg_temp.ok(v->>'status' = 'expired', 'a 49-hour-old duel reads as expired');
  PERFORM pg_temp.ok((v->'creator'->>'score')::INT = 10,
    'an expired duel reveals the score that does exist');
  PERFORM pg_temp.ok(v::TEXT ILIKE '%walkover%' OR (v->'opponent'->>'status') <> 'complete',
    'a half-played duel is distinguishable from a real win');

  -- Nobody can start a run on an expired duel.
  PERFORM pg_temp.as_user('player9');
  BEGIN
    r := public.start_duel_run(k, NULL);
    PERFORM pg_temp.ok(r ? 'error' OR (r->'questions') IS NULL,
      'an expired duel cannot be started');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ok(TRUE, 'an expired duel cannot be started (raised)');
  END;

  RAISE NOTICE '--- expiry OK ---';
END $$;

-- ── Unknown keys, and the tables staying shut ───────────────────
DO $$
DECLARE v JSONB; relrls BOOLEAN; npol INT;
BEGIN
  PERFORM pg_temp.as_anon();
  v := public.get_duel_by_key('definitely-not-a-key', NULL);
  PERFORM pg_temp.ok(v IS NULL OR v ? 'error',
    'an unknown duel key resolves to nothing rather than erroring');

  SELECT c.relrowsecurity INTO relrls FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'duels';
  PERFORM pg_temp.ok(relrls, 'RLS is enabled on duels');

  SELECT COUNT(*) INTO npol FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('duels', 'duel_runs');
  PERFORM pg_temp.ok(npol = 0, 'no permissive policies on the duel tables');

  RAISE NOTICE '--- posture OK ---';
END $$;

SELECT 'ALL DUEL CONTRACT TESTS PASSED' AS result;
