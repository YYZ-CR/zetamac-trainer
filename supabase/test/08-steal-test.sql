-- Contract tests for supabase/steal.sql.
--
-- Written against docs/steal-mode-design.md BEFORE reading the
-- implementation, so a pass means the contract holds — not that the code
-- does what it happens to do.
--
-- Runs after 07-account-test.sql; pg_temp.ok / as_user / as_anon come from
-- 02-test.sql.
--
-- Three rules shape every assertion below:
--
--   * Never assert on non-emptiness. "A row appeared", "it did not error"
--     and "somebody won" are not evidence. Every assertion names the value
--     it expects — the winning SIDE and the stored elapsed_ms, not just
--     that a point was awarded.
--   * Every precondition is fatal. pg_temp.ok RAISEs, so a fixture that
--     did not build what the test thinks it built dies at the setup line
--     rather than sailing on to a green post-condition that was vacuously
--     true. A steal test whose two "players" never actually started runs
--     would pass most of this file while proving nothing.
--   * Time is driven, never waited for. Every DO block is one transaction,
--     so NOW() is frozen inside it: a run started in the same block is
--     zero milliseconds old and every honest claim would clamp to 0. So
--     the fixtures BACKDATE started_at and awarded_at to known instants
--     and assert the exact millisecond values that follow. Nothing here
--     sleeps, and nothing here depends on how long the suite takes to run.
--
-- ── Two things the spec does not settle, and how this file reads them ──
--
--   1. §"claim_duel_point(p_key, p_guest_token, p_index, p_elapsed_ms)"
--      lists four parameters, but the paragraph under it says "the answer
--      is checked on the server against the stored question" and that a
--      wrong answer returns {ok:false, error:'wrong'}. With no answer
--      argument there is nothing to check. The answer argument therefore
--      has to exist, and this file finds it by name rather than by
--      position (see pg_temp.claim below) so a reasonable choice of name
--      or ordering does not read as a failure. If it is absent entirely,
--      the 'wrong answer' section is what fails, which is the right place
--      for that defect to surface.
--
--   2. "p_index must be the duel's current index (the highest awarded
--      index + 1)" and "for 400 ms a better claim replaces it" cannot both
--      be literally true: after index 0 is awarded the current index is 1,
--      so the replacing claim is on a stale index by that definition. The
--      reading taken here is the only one under which both sentences do
--      something: the most recently awarded index is claimable while its
--      grace window is open and gives `point_taken` once it closes, and
--      an index below that — a genuine replay — gives `stale_index`.

\set ON_ERROR_STOP on
SET client_min_messages = NOTICE;

-- ════════════════════════════════════════════════════════════════
-- Helpers
-- ════════════════════════════════════════════════════════════════

-- Which of this file's five values goes at each of claim_duel_point's
-- parameter positions, worked out from the parameter names. The design
-- doc's signature is missing the answer argument (note 1 above), so the
-- position — and even the presence — of that argument is not something
-- this file can hard-code without testing the implementation's spelling
-- rather than its behaviour.
CREATE TABLE IF NOT EXISTS pg_temp.steal_call (slots TEXT[]);

DO $$
DECLARE
  v_names TEXT[];
  v_nargs INT;
  v_slots TEXT[] := ARRAY[]::TEXT[];
  nm      TEXT;
  i       INT;
  n       INT;
BEGIN
  SELECT COUNT(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'claim_duel_point';
  PERFORM pg_temp.ok(n = 1,
    'there is exactly one public.claim_duel_point — no overload a caller could land on by accident');

  SELECT p.proargnames, p.pronargs INTO v_names, v_nargs
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'claim_duel_point';

  PERFORM pg_temp.ok(v_names IS NOT NULL,
    'claim_duel_point names its parameters, so a caller can use named notation');
  PERFORM pg_temp.ok(v_nargs = 5,
    'claim_duel_point takes five arguments: key, guest token, index, the answer, elapsed_ms');

  FOR i IN 1..v_nargs LOOP
    nm := lower(COALESCE(v_names[i], ''));
    v_slots := v_slots || (CASE
      WHEN nm LIKE '%key%'     THEN 'key'
      WHEN nm LIKE '%guest%'   THEN 'guest'
      WHEN nm LIKE '%token%'   THEN 'guest'
      WHEN nm LIKE '%index%'   THEN 'index'
      WHEN nm LIKE '%elapsed%' THEN 'elapsed'
      WHEN nm LIKE '%ms%'      THEN 'elapsed'
      ELSE 'value' END);
  END LOOP;

  PERFORM pg_temp.ok('key'     = ANY(v_slots), 'claim_duel_point takes a duel key');
  PERFORM pg_temp.ok('guest'   = ANY(v_slots), 'claim_duel_point takes a guest token');
  PERFORM pg_temp.ok('index'   = ANY(v_slots), 'claim_duel_point takes a question index');
  PERFORM pg_temp.ok('elapsed' = ANY(v_slots), 'claim_duel_point takes an elapsed time');
  PERFORM pg_temp.ok('value'   = ANY(v_slots),
    'claim_duel_point takes the ANSWER — the server cannot check a claim it was never given');

  DELETE FROM pg_temp.steal_call;
  INSERT INTO pg_temp.steal_call VALUES (v_slots);

  RAISE NOTICE '--- claim_duel_point signature OK ---';
END $$;

-- Call claim_duel_point with the arguments in whatever order it declares
-- them. Literals rather than EXECUTE ... USING, so a parameter the
-- function does not have is simply not emitted.
CREATE OR REPLACE FUNCTION pg_temp.claim(
  p_key TEXT, p_guest TEXT, p_index INT, p_value INT, p_elapsed INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE slots TEXT[]; parts TEXT[] := ARRAY[]::TEXT[]; i INT; r JSONB;
BEGIN
  SELECT c.slots INTO slots FROM pg_temp.steal_call c;
  FOR i IN 1..COALESCE(array_length(slots, 1), 0) LOOP
    parts := parts || (CASE slots[i]
      WHEN 'key'   THEN quote_nullable(p_key)
      WHEN 'guest' THEN quote_nullable(p_guest)
      WHEN 'index' THEN quote_nullable(p_index)
      WHEN 'value' THEN quote_nullable(p_value)
      ELSE              quote_nullable(p_elapsed) END);
  END LOOP;
  EXECUTE 'SELECT public.claim_duel_point(' || array_to_string(parts, ', ') || ')' INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.did(p_key TEXT) RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT id FROM public.duels WHERE duel_key = p_key;
$$;

-- The correct answer to question i, read from the duel's own stored
-- question list — the same list the server scores against.
CREATE OR REPLACE FUNCTION pg_temp.qans(p_key TEXT, i INT) RETURNS INT
LANGUAGE sql STABLE AS $$
  SELECT (d.questions->i->>'answer')::INT FROM public.duels d WHERE d.duel_key = p_key;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pt_winner(p_key TEXT, i INT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT p.winner_side FROM public.duel_points p
   WHERE p.duel_id = (SELECT d.id FROM public.duels d WHERE d.duel_key = p_key)
     AND p.question_index = i;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pt_ms(p_key TEXT, i INT) RETURNS INT
LANGUAGE sql STABLE AS $$
  SELECT p.elapsed_ms FROM public.duel_points p
   WHERE p.duel_id = (SELECT d.id FROM public.duels d WHERE d.duel_key = p_key)
     AND p.question_index = i;
$$;

-- Rows for a duel, optionally for one side. NULL side counts both.
CREATE OR REPLACE FUNCTION pg_temp.pt_count(p_key TEXT, p_side TEXT) RETURNS INT
LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::INT FROM public.duel_points p
   WHERE p.duel_id = (SELECT d.id FROM public.duels d WHERE d.duel_key = p_key)
     AND (p_side IS NULL OR p.winner_side = p_side);
$$;

-- A steal duel with both sides in progress, and both runs backdated to
-- ONE shared instant `p_back` in the past.
--
-- The backdating is the fixture's whole point. NOW() is frozen for the
-- duration of a DO block, so a run started in the same block is zero
-- milliseconds old and `server_ms_since(started_at)` is 0 — every honest
-- claim would clamp to 0 and every arbitration below would degenerate
-- into the tie-break. Backdating by ten seconds puts the clamp ceiling at
-- a known 10000 ms, well clear of the sub-second times these tests claim.
--
-- Both sides get the SAME started_at deliberately: steal mode starts both
-- players off one shared countdown deadline, and the doc's
-- "duel_runs.started_at" does not say whose run it means. Keeping them
-- equal means nothing below depends on that unsettled reading.
--
-- Leaves the session impersonating the creator.
CREATE OR REPLACE FUNCTION pg_temp.steal_open(
  p_creator TEXT, p_opponent TEXT, p_back INTERVAL DEFAULT INTERVAL '10 seconds')
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE k TEXT; d UUID; r JSONB; n INT;
BEGIN
  PERFORM pg_temp.as_user(p_creator);
  k := (public.create_duel(120, 'steal'))->>'duel_key';
  PERFORM pg_temp.ok(k IS NOT NULL, 'fixture: create_duel returned a key for a steal duel');

  d := pg_temp.did(k);
  PERFORM pg_temp.ok(d IS NOT NULL, 'fixture: the steal duel exists in public.duels');
  PERFORM pg_temp.ok((SELECT mode FROM public.duels WHERE id = d) = 'steal',
    'fixture: it is stored as mode = steal, not silently as a classic duel');

  r := public.start_duel_run(k, NULL);
  PERFORM pg_temp.ok(r->>'side' = 'creator', 'fixture: the creator holds the creator side');
  PERFORM pg_temp.ok(jsonb_array_length(r->'questions') > 100,
    'fixture: a steal run is handed a real question list');

  PERFORM pg_temp.as_user(p_opponent);
  r := public.start_duel_run(k, NULL);
  PERFORM pg_temp.ok(r->>'side' = 'opponent', 'fixture: the opponent holds the opponent side');

  SELECT COUNT(*) INTO n FROM public.duel_runs WHERE duel_id = d;
  PERFORM pg_temp.ok(n = 2, 'fixture: exactly two runs are in progress');
  SELECT COUNT(*) INTO n FROM public.duel_runs
   WHERE duel_id = d AND status = 'in_progress';
  PERFORM pg_temp.ok(n = 2, 'fixture: and both of them are in_progress');

  UPDATE public.duel_runs SET started_at = NOW() - p_back WHERE duel_id = d;

  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0,
    'fixture: no point has been awarded yet');

  PERFORM pg_temp.as_user(p_creator);
  RETURN k;
END $$;

-- Move an awarded point `p_by` further into the past.
--
-- Shifts EVERY timestamp the row carries, because the grace deadline may
-- be recomputed from awarded_at on each claim or materialised into
-- settled_at at write time, and the fixture must mean "this point was
-- awarded p_by ago" under either. Moving one column and not the other
-- says something different — and, if the implementation happens to read
-- the column you left alone, says nothing at all.
CREATE OR REPLACE FUNCTION pg_temp.age_point(p_key TEXT, i INT, p_by INTERVAL)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE n INT;
BEGIN
  UPDATE public.duel_points
     SET awarded_at = awarded_at - p_by,
         settled_at = settled_at - p_by
   WHERE duel_id = (SELECT d.id FROM public.duels d WHERE d.duel_key = p_key)
     AND question_index = i;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 1,
    'fixture: aged the award for question ' || i || ' by ' || p_by);
END $$;

-- Score a CLASSIC run correctly, n answers, from the questions the server
-- gave. Deliberately a private copy rather than 04-duels-test.sql's
-- answer_run: this file must still mean something if it is run on its own.
CREATE OR REPLACE FUNCTION pg_temp.steal_classic_run(p_key TEXT, p_guest TEXT, n INT)
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

-- ════════════════════════════════════════════════════════════════
-- 1. Classic duels are untouched
--
-- "Classic behaviour must not change" is the single most important
-- constraint in the design doc, and it is the assertion that protects the
-- feature that already works. 04-duels-test.sql is the regression suite
-- for the mechanics; what is added here is that the new column defaults
-- the old rows to classic, that the old one-argument call still resolves,
-- and that the new function refuses a classic duel instead of quietly
-- starting to arbitrate points on one.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_type TEXT; v_null TEXT; v_def TEXT; n INT;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO v_type, v_null, v_def
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'duels' AND column_name = 'mode';

  PERFORM pg_temp.ok(v_type = 'text',  'duels.mode is TEXT');
  PERFORM pg_temp.ok(v_null = 'NO',    'duels.mode is NOT NULL');
  PERFORM pg_temp.ok(v_def LIKE '%classic%',
    'duels.mode DEFAULTs to classic — every row that predates the migration is a classic duel');

  -- The CHECK is what makes 'classic'/'steal' a fact about the database
  -- rather than a fact about whichever function last wrote the column.
  SELECT COUNT(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.duels'::REGCLASS
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%mode%'
     AND pg_get_constraintdef(oid) LIKE '%steal%'
     AND pg_get_constraintdef(oid) LIKE '%classic%';
  PERFORM pg_temp.ok(n = 1, 'exactly one CHECK constrains duels.mode to classic or steal');

  -- No pre-existing row was migrated to something else.
  SELECT COUNT(*) INTO n FROM public.duels WHERE mode NOT IN ('classic', 'steal');
  PERFORM pg_temp.ok(n = 0, 'no duel in the database carries a mode outside the two');

  RAISE NOTICE '--- mode column OK ---';
END $$;

DO $$
DECLARE k TEXT; d UUID; r JSONB; v JSONB; n INT; threw BOOLEAN;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');

  -- The old call. If create_duel gained a second parameter WITHOUT a
  -- default, or gained an overload rather than a default, this line is
  -- where that shows up — as "function is not unique" or a missing
  -- function, not as a subtly different duel.
  r := public.create_duel(120);
  k := r->>'duel_key';
  d := pg_temp.did(k);
  PERFORM pg_temp.ok(d IS NOT NULL, 'the one-argument create_duel still creates a duel');
  PERFORM pg_temp.ok((SELECT mode FROM public.duels WHERE id = d) = 'classic',
    'a duel created without a mode is a CLASSIC duel');
  PERFORM pg_temp.ok((r->>'duration_seconds')::INT = 120,
    'and it still reports the duration it was asked for');

  -- Both sides live, so the ONLY precondition claim_duel_point can be
  -- failing here is the mode. Asserting this on a finished duel would
  -- prove nothing: the run is no longer in progress, so the participant
  -- check legitimately fires first and the mode is never reached.
  PERFORM public.start_duel_run(k, NULL);
  PERFORM pg_temp.as_user('player6');
  PERFORM public.start_duel_run(k, NULL);

  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
    'claim_duel_point does not report success on a classic duel');
  PERFORM pg_temp.ok(r->>'error' = 'wrong_mode',
    'the creator of a live classic duel is refused as wrong_mode specifically');

  PERFORM pg_temp.as_user('player6');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok(r->>'error' = 'wrong_mode',
    'and so is its opponent — the refusal is about the duel, not about who asked');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0,
    'and no duel_points row was written for a classic duel');

  -- It then plays exactly as before: 20 of 20 and 12 of 12, scored from
  -- the stored questions.
  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.steal_classic_run(k, NULL, 20);
  PERFORM pg_temp.ok((r->>'score')::INT = 20, 'a classic duel still scores 20 of 20');

  PERFORM pg_temp.as_user('player6');
  r := pg_temp.steal_classic_run(k, NULL, 12);
  PERFORM pg_temp.ok((r->>'score')::INT = 12, 'and the opponent still scores 12 of 12');

  v := public.get_duel_by_key(k, NULL);
  PERFORM pg_temp.ok((v->'creator'->>'score')::INT  = 20, 'classic creator score is revealed as 20');
  PERFORM pg_temp.ok((v->'opponent'->>'score')::INT = 12, 'classic opponent score is revealed as 12');
  PERFORM pg_temp.ok(v->>'status' = 'complete', 'the classic duel reads as complete');
  PERFORM pg_temp.ok(v->>'mode' = 'classic',
    'get_duel_by_key names the mode, so the invite link knows which game it is opening');

  -- A finished classic duel awards nothing either. Which of the two
  -- refusals it gives is not pinned: with no run in progress the
  -- participant check is entitled to fire before the mode check, and the
  -- doc pairs the two conditions rather than ordering them. What is
  -- pinned is that it does not succeed and does not write.
  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
    'a finished classic duel awards nothing');
  PERFORM pg_temp.ok(r->>'error' IN ('wrong_mode', 'not_a_participant'),
    'and says so with one of the two documented refusals');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0, 'still no duel_points row');

  -- A classic duel nobody has opened yet, from a stranger.
  PERFORM pg_temp.as_user('hexadecimal');
  k := (public.create_duel(120))->>'duel_key';
  PERFORM pg_temp.as_user('player7');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
    'an unopened classic duel awards nothing to a passer-by');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0, 'and writes nothing');

  RAISE NOTICE '--- classic duels untouched OK ---';
END $$;

-- The CHECK is real, not decorative.
DO $$
DECLARE k TEXT; threw BOOLEAN := FALSE;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  k := (public.create_duel(120))->>'duel_key';
  BEGIN
    UPDATE public.duels SET mode = 'nonsense' WHERE duel_key = k;
  EXCEPTION WHEN check_violation THEN threw := TRUE;
  END;
  PERFORM pg_temp.ok(threw, 'a third mode value is rejected by the CHECK, not stored');
  PERFORM pg_temp.ok((SELECT mode FROM public.duels WHERE duel_key = k) = 'classic',
    'and the row still reads classic');
END $$;

-- ════════════════════════════════════════════════════════════════
-- 2. Arbitration is on clamped client time, not arrival order
--
-- The entire point of the design. If only one assertion in this file
-- survives, it is this one: the claim that arrives SECOND, reporting the
-- smaller clamped elapsed time, takes the point.
--
-- Awarding to whoever arrives first makes the game a ping contest, which
-- is the failure the doc opens with — and it is a failure that passes
-- every naive test, because in a test the two claims arrive in the order
-- the test made them.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE k TEXT; r JSONB; keys TEXT[];
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6');

  -- First to arrive, slower on the clock.
  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 900);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'the first claim is accepted');
  PERFORM pg_temp.ok(r->>'winner' = 'creator', 'and provisionally names the creator');
  PERFORM pg_temp.ok((r->>'index')::INT = 0, 'the payload echoes the index it decided');
  PERFORM pg_temp.ok((r->>'elapsed_ms')::INT = 900,
    'the payload reports the clamped time it stored, 900 ms');
  PERFORM pg_temp.ok((r->>'provisional')::BOOLEAN IS TRUE,
    'the first claim is provisional — the grace window is still open and the UI must say so');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator', 'the stored award says creator');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 900, 'the stored elapsed_ms is 900');

  -- The payload carries what the doc says and nothing that would leak
  -- the question list to a client mid-run.
  PERFORM pg_temp.ok(r ? 'ok' AND r ? 'index' AND r ? 'winner'
                 AND r ? 'elapsed_ms' AND r ? 'provisional',
    'a successful claim returns {ok, index, winner, elapsed_ms, provisional}');
  PERFORM pg_temp.ok(NOT (r ? 'questions') AND NOT (r ? 'answer') AND NOT (r ? 'user_id'),
    'and leaks neither the questions, an answer, nor a user_id');

  -- Second to arrive, faster on the clock. This is the assertion.
  PERFORM pg_temp.as_user('player6');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'the second, faster claim is accepted');
  PERFORM pg_temp.ok(r->>'winner' = 'opponent',
    'the point goes to the SECOND claim to arrive, because it was faster on the clock');
  PERFORM pg_temp.ok((r->>'elapsed_ms')::INT = 300, 'at its own 300 ms');

  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'opponent',
    'and the stored award moved to the opponent');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 300,
    'with the winner''s time, not the loser''s');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 1,
    'a replacement REPLACES: there is still exactly one row for question 0');

  RAISE NOTICE '--- arbitration by clamped time OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 3. The clamp is real
--
--   elapsed_clamped = LEAST(GREATEST(p_elapsed_ms, 0),
--                           server_ms_since(question_became_current))
--
-- Asserted on the STORED elapsed_ms, not on who won: a clamp that is
-- applied to the comparison but not to the column leaves the wrong number
-- on the scoreboard and in the "they had it in 1.4s" line.
--
-- `question_became_current` is the previous question's awarded_at, or
-- duel_runs.started_at for the first question — so the third block below
-- is the one that separates a real implementation from one that always
-- measures from the start of the run.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  -- Ceiling: 10 seconds of run, so 10000 ms.
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 5000000);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'an over-large claim is still a claim');
  -- 10000 exactly if the server measures with NOW(), a millisecond or two
  -- more if it measures with clock_timestamp(). Both are the server's
  -- number; 5000000 is not.
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) BETWEEN 10000 AND 10300,
    'a claim of 5000000 ms on a run the server has watched for 10000 ms is clamped to the server''s number');
  PERFORM pg_temp.ok((r->>'elapsed_ms')::INT = pg_temp.pt_ms(k, 0),
    'and the payload reports the clamped value, not the value asked for');

  RAISE NOTICE '--- clamp: upper bound OK ---';
END $$;

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), -5000);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'a negative claim is not a crash');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 0,
    'a negative elapsed time is clamped to 0 — and 0 is what is STORED, so the CHECK holds');
  PERFORM pg_temp.ok((r->>'elapsed_ms')::INT = 0, 'the payload reports 0 too');

  RAISE NOTICE '--- clamp: negative OK ---';
END $$;

-- An honest time inside the ceiling passes through untouched. Without
-- this, a clamp that simply overwrote every claim with the server's
-- number would satisfy both blocks above.
DO $$
DECLARE k TEXT;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');
  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 742);
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 742,
    'a claim well inside the ceiling is stored exactly as claimed — the clamp is a bound, not an override');
END $$;

-- The second question is measured from when the FIRST was decided.
--
-- The discriminating case: the run is 10 seconds old, but question 0 was
-- settled 500 ms ago. A claim of 40000 ms on question 1 must clamp to
-- ~500, not to ~10000. An implementation that always measures from
-- started_at passes every block above and fails here.
DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 400);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator', 'fixture: question 0 is decided');

  -- Drive the boundary rather than sleep for it: question 0 was awarded
  -- half a second ago, which also puts it outside the 400 ms grace.
  PERFORM pg_temp.age_point(k, 0, INTERVAL '500 milliseconds');

  PERFORM pg_temp.as_user('player6');
  r := pg_temp.claim(k, NULL, 1, pg_temp.qans(k, 1), 40000);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'the claim on question 1 is accepted');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 1) BETWEEN 500 AND 800,
    'question 1 is clamped to the 500 ms since question 0 was decided, NOT to the 10 s since the run began');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 1) < 1000,
    'a client cannot fabricate a lead by claiming a time longer than the question has existed');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 1) = 'opponent', 'and the opponent took question 1');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator', 'question 0 is untouched');

  RAISE NOTICE '--- clamp: per-question baseline OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 4. The grace window
--
-- 400 ms after the first write, a strictly better claim replaces it;
-- after that the point is settled and a late claim is `point_taken`.
--
-- Driven, not slept for: awarded_at is moved to a known distance in the
-- past and the claim is made immediately. 100 ms is unambiguously inside
-- a 400 ms window and 900 ms is unambiguously outside it, whichever clock
-- the implementation compares against, so neither assertion depends on
-- how long this suite has been running.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 900);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator', 'fixture: the creator has it at 900 ms');

  PERFORM pg_temp.age_point(k, 0, INTERVAL '100 milliseconds');

  PERFORM pg_temp.as_user('player6');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 250);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'a better claim 100 ms later is accepted — that is inside the 400 ms window');
  PERFORM pg_temp.ok(r->>'winner' = 'opponent', 'and it names the new winner');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'opponent', 'the stored award moved');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 250, 'to the opponent''s 250 ms');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 1, 'and there is still one row');

  RAISE NOTICE '--- grace: inside OK ---';
END $$;

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 900);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator', 'fixture: the creator has it at 900 ms');

  PERFORM pg_temp.age_point(k, 0, INTERVAL '900 milliseconds');

  PERFORM pg_temp.as_user('player6');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 250);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
    'a better claim 900 ms later does not report success — the point is settled');
  PERFORM pg_temp.ok(r->>'error' = 'point_taken',
    'and is refused as point_taken specifically');

  -- The refusal is only half of it. A settled point that quietly moves
  -- anyway is the flicker the 400 ms was chosen to prevent.
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator',
    'the award did NOT move — the creator still holds question 0');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 900, 'at the 900 ms it was settled on');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 1, 'and no second row was written');

  RAISE NOTICE '--- grace: outside OK ---';
END $$;

-- A WORSE claim inside the window must not move anything either. The
-- window is for better claims; "any claim within 400 ms wins" would pass
-- the two blocks above.
DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 250);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator', 'fixture: the creator has it at 250 ms');

  PERFORM pg_temp.as_user('player6');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 900);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator',
    'a slower claim inside the window does not take the point');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 250, 'and does not overwrite the winning time');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 1, 'one row, still');
  -- Whatever it returns, it must not tell the loser they won: the client
  -- renders `winner` straight into "Stolen".
  PERFORM pg_temp.ok(COALESCE(r->>'winner', 'creator') = 'creator',
    'and the payload does not name the loser as the winner');

  RAISE NOTICE '--- grace: a worse claim changes nothing OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 5. Ties go to `creator`, deterministically
--
-- Both orders, because the interesting one is the order a strictly-less
-- comparison gets wrong: the opponent writes first, the creator ties, and
-- the creator must take it. `p_new < p_held` alone leaves it with the
-- opponent and passes the other order by accident.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  PERFORM pg_temp.as_user('player6');
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'opponent',
    'fixture: the opponent wrote first, at 300 ms');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 300, 'fixture: stored as exactly 300 ms, unclamped');

  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator',
    'identical clamped milliseconds go to the creator, even though the opponent got there first');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 300, 'at the shared 300 ms');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 1, 'one row');
  PERFORM pg_temp.ok((r->>'winner') = 'creator', 'and the payload says so');

  RAISE NOTICE '--- tie-break: opponent first OK ---';
END $$;

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator', 'fixture: the creator wrote first, at 300 ms');

  PERFORM pg_temp.as_user('player6');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator',
    'a tie in the other order still goes to the creator — the rule is the side, not the order');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 300, 'at 300 ms');
  PERFORM pg_temp.ok(COALESCE(r->>'winner', 'creator') = 'creator',
    'and the payload does not name the opponent');

  RAISE NOTICE '--- tie-break: creator first OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 6. A wrong answer awards nothing and advances nobody
--
-- The answer is checked on the server against the stored question. A
-- client that fires a claim on every keystroke, or one that has been
-- edited to claim the point without doing the arithmetic, must get
-- nothing — and, crucially, must not advance the sequence for the player
-- who was still working on the question honestly.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0) + 7, 50);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE, 'a wrong answer does not report success');
  PERFORM pg_temp.ok(r->>'error' = 'wrong', 'it is refused as wrong specifically');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0,
    'and no duel_points row appears — not even a losing one');

  -- Nobody advanced. The proof is that question 0 is still claimable.
  PERFORM pg_temp.as_user('player6');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 800);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'question 0 is still the current index — a wrong answer advanced nobody');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'opponent',
    'and the player who actually answered it takes it');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 800, 'at their own 800 ms');

  -- It cost the wrong claimer their own time and nothing else: they can
  -- still take the next question.
  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.age_point(k, 0, INTERVAL '2 seconds');
  r := pg_temp.claim(k, NULL, 1, pg_temp.qans(k, 1), 100);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'a wrong answer carries no penalty beyond the time it cost — the next question is still theirs to win');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 1) = 'creator', 'and they win it');

  -- A wrong answer with an impossible time is still just wrong.
  PERFORM pg_temp.as_user('player6');
  PERFORM pg_temp.age_point(k, 1, INTERVAL '2 seconds');
  r := pg_temp.claim(k, NULL, 2, pg_temp.qans(k, 2) + 1, -9999);
  PERFORM pg_temp.ok(r->>'error' = 'wrong',
    'a wrong answer claimed at a negative time is wrong, not a 0 ms win');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 2, 'still two awarded questions');

  RAISE NOTICE '--- wrong answers OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 7. stale_index, in both directions
--
-- A client racing ahead on an optimistic advance, and a replay of an
-- index that was settled questions ago. The second is the one that
-- matters for correctness: a replayed claim on question 0 in the tenth
-- question's worth of traffic must not rewrite a settled award.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  -- Racing ahead: nothing is awarded, so the current index is 0.
  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.claim(k, NULL, 3, pg_temp.qans(k, 3), 300);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE, 'a claim three questions ahead is refused');
  PERFORM pg_temp.ok(r->>'error' = 'stale_index', 'as stale_index');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0, 'and awards nothing');

  r := pg_temp.claim(k, NULL, 1, pg_temp.qans(k, 1), 300);
  PERFORM pg_temp.ok(r->>'error' = 'stale_index', 'even one question ahead is stale_index');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0, 'still nothing awarded');

  -- Below the floor, and past the end of the list. Neither may raise:
  -- these arrive from a public client.
  r := pg_temp.claim(k, NULL, -1, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok(r->>'error' = 'stale_index', 'a negative index is stale_index, not a crash');
  r := pg_temp.claim(k, NULL, 999999, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok(r->>'error' = 'stale_index', 'an index past the end of the list is stale_index');
  r := pg_temp.claim(k, NULL, NULL, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE, 'a NULL index does not award a point');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0, 'and none of those wrote a row');

  RAISE NOTICE '--- stale_index: racing ahead OK ---';
END $$;

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');
  PERFORM pg_temp.as_user('hexadecimal');

  -- Three questions decided, each one settled before the next, so the
  -- replay below is unambiguously a replay and not a grace-window
  -- improvement on the most recent point.
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 300);
  PERFORM pg_temp.age_point(k, 0, INTERVAL '2 seconds');
  PERFORM pg_temp.claim(k, NULL, 1, pg_temp.qans(k, 1), 300);
  PERFORM pg_temp.age_point(k, 1, INTERVAL '2 seconds');
  PERFORM pg_temp.claim(k, NULL, 2, pg_temp.qans(k, 2), 300);
  PERFORM pg_temp.age_point(k, 2, INTERVAL '2 seconds');

  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 3, 'fixture: three questions are decided');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator', 'fixture: the creator took question 0');

  -- A replay of question 0, from the other side, claiming to have been
  -- faster. The current index is 3.
  PERFORM pg_temp.as_user('player6');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 1);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE, 'a replayed old index is refused');
  PERFORM pg_temp.ok(r->>'error' = 'stale_index', 'as stale_index');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator',
    'and a settled award three questions back is not rewritten by a 1 ms replay');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 300, 'nor its time');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 3, 'still three awards');

  RAISE NOTICE '--- stale_index: replay OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 8. not_a_participant
--
-- Guests play duels, so claim_duel_point is granted to anon. That grant
-- is the reason this section exists: the only thing between it and a
-- stranger deciding somebody else's game is the participant check.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE k TEXT; r JSONB;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');

  -- A third signed-in account.
  PERFORM pg_temp.as_user('player7');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 10);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE, 'a third party does not get a point');
  PERFORM pg_temp.ok(r->>'error' = 'not_a_participant', 'they are refused as not_a_participant');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0, 'and nothing was written');

  -- Signed out, with no token at all. NULL must not match the two runs'
  -- NULL guest_token columns.
  PERFORM pg_temp.as_anon();
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 10);
  PERFORM pg_temp.ok(r->>'error' = 'not_a_participant',
    'a signed-out caller with no guest token is not a participant');
  r := pg_temp.claim(k, '', 0, pg_temp.qans(k, 0), 10);
  PERFORM pg_temp.ok(r->>'error' = 'not_a_participant',
    'nor is one with an empty guest token');
  r := pg_temp.claim(k, 'guest-anything', 0, pg_temp.qans(k, 0), 10);
  PERFORM pg_temp.ok(r->>'error' = 'not_a_participant',
    'nor one with an invented token, on a duel that has no guest side');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0, 'four strangers later, still no award');

  -- An unknown duel key is not an enumeration oracle either.
  r := pg_temp.claim('definitely-not-a-key', NULL, 0, 1, 10);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
    'an unknown duel key does not award a point, and does not raise');

  RAISE NOTICE '--- not_a_participant: signed-in and signed-out OK ---';
END $$;

-- The guest case, with a positive control: the real token works, so the
-- refusals above and below are refusals of the wrong token rather than of
-- guests in general.
DO $$
DECLARE k TEXT; d UUID; r JSONB; n INT;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  k := (public.create_duel(120, 'steal'))->>'duel_key';
  d := pg_temp.did(k);
  PERFORM pg_temp.ok((SELECT mode FROM public.duels WHERE id = d) = 'steal',
    'fixture: a steal duel for a guest to accept');
  PERFORM public.start_duel_run(k, NULL);

  PERFORM pg_temp.as_anon();
  r := public.start_duel_run(k, 'guest-steal-aaa');
  PERFORM pg_temp.ok(r->>'side' = 'opponent', 'fixture: the guest holds the opponent side');
  SELECT COUNT(*) INTO n FROM public.duel_runs WHERE duel_id = d;
  PERFORM pg_temp.ok(n = 2, 'fixture: two runs');
  UPDATE public.duel_runs SET started_at = NOW() - INTERVAL '10 seconds' WHERE duel_id = d;

  -- The wrong token, from an equally anonymous session.
  r := pg_temp.claim(k, 'guest-steal-bbb', 0, pg_temp.qans(k, 0), 10);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE, 'a guest with the wrong token gets nothing');
  PERFORM pg_temp.ok(r->>'error' = 'not_a_participant', 'they are not_a_participant');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 0, 'and no point was awarded');

  -- The real token.
  r := pg_temp.claim(k, 'guest-steal-aaa', 0, pg_temp.qans(k, 0), 640);
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'the guest who actually holds the side can claim');
  PERFORM pg_temp.ok(r->>'winner' = 'opponent', 'and takes the point as the opponent');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'opponent', 'the stored award agrees');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 640, 'at 640 ms');

  -- And the creator can still steal it back, so a guest opponent is a
  -- real opponent rather than a side the arbitration ignores.
  PERFORM pg_temp.as_user('hexadecimal');
  r := pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 200);
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator',
    'the creator can steal a point back from a guest');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 200, 'at 200 ms');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 1, 'one row throughout');

  RAISE NOTICE '--- not_a_participant: guests OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 9. Scores are never taken from the client
--
-- A side's steal score is COUNT(*) FROM duel_points, computed on the
-- server. The test submits a payload that would score 40 in a classic
-- duel and asserts the reported score is the 3 points that side actually
-- won.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  k TEXT; d UUID; qs JSONB; ans JSONB; r JSONB; v JSONB; i INT;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');
  d := pg_temp.did(k);

  -- Creator takes 0, 1, 2; opponent takes 3, 4. Each question is settled
  -- before the next is claimed, so the sequence is unambiguous.
  FOR i IN 0..4 LOOP
    IF i <= 2 THEN PERFORM pg_temp.as_user('hexadecimal');
    ELSE           PERFORM pg_temp.as_user('player6');
    END IF;
    r := pg_temp.claim(k, NULL, i, pg_temp.qans(k, i), 300);
    PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
      'fixture: question ' || i || ' was awarded');
    PERFORM pg_temp.age_point(k, i, INTERVAL '2 seconds');
  END LOOP;

  PERFORM pg_temp.ok(pg_temp.pt_count(k, 'creator')  = 3, 'fixture: the creator won 3 points');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, 'opponent') = 2, 'fixture: the opponent won 2');
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL)       = 5, 'fixture: five questions, five rows');

  -- Both sides now finish, each claiming forty correct answers. In a
  -- classic duel that payload scores 40.
  SELECT questions INTO qs FROM public.duels WHERE id = d;
  SELECT jsonb_agg(jsonb_build_object(
           'i', j, 'value', (qs->j->>'answer')::INT, 'elapsed_ms', (j + 1) * 100
         ) ORDER BY j)
    INTO ans FROM generate_series(0, 39) j;

  PERFORM pg_temp.as_user('hexadecimal');
  r := public.submit_duel_run(k, NULL, ans);
  PERFORM pg_temp.ok((r->>'score')::INT = 3,
    'the creator''s steal score is the 3 points they won, not the 40 answers they claimed');

  -- Reveal rule: the opponent has not finished, so nothing is visible.
  PERFORM pg_temp.as_user('player6');
  v := public.get_duel_by_key(k, NULL);
  PERFORM pg_temp.ok((v->>'scores_revealed')::BOOLEAN IS FALSE,
    'a steal duel with one side still running reveals nothing');
  PERFORM pg_temp.ok((v->'creator'->>'score') IS NULL,
    'the creator''s steal score is withheld until both runs are done, same as classic');

  r := public.submit_duel_run(k, NULL, ans);
  PERFORM pg_temp.ok((r->>'score')::INT = 2,
    'the opponent''s steal score is their 2 points, not the 40 they claimed');

  v := public.get_duel_by_key(k, NULL);
  PERFORM pg_temp.ok((v->>'scores_revealed')::BOOLEAN IS TRUE, 'now both are in');
  PERFORM pg_temp.ok((v->'creator'->>'score')::INT  = 3, 'the duel reports creator 3');
  PERFORM pg_temp.ok((v->'opponent'->>'score')::INT = 2, 'and opponent 2');
  PERFORM pg_temp.ok((v->'creator'->>'score')::INT
                   + (v->'opponent'->>'score')::INT = pg_temp.pt_count(k, NULL),
    'the two scores add up to the number of questions actually decided');
  PERFORM pg_temp.ok(v->>'status' = 'complete', 'the steal duel reads as complete');
  PERFORM pg_temp.ok(v->>'mode' = 'steal', 'and still knows which game it was');
  PERFORM pg_temp.ok(NOT (v ? 'questions'), 'the public payload still carries no questions');
  PERFORM pg_temp.ok(v::TEXT NOT LIKE '%@example.test%', 'and no email');

  RAISE NOTICE '--- server-side scoring OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 10. One award per question index, ever
--
-- "The primary key is the arbitration: an award is one insert that either
-- conflicts or does not." So the key has to be the key, and a duplicate
-- claim has to be a conflict rather than a second row.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE cols TEXT[]; n INT;
BEGIN
  SELECT array_agg(a.attname ORDER BY kk.ord) INTO cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY kk(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = kk.attnum
   WHERE ns.nspname = 'public' AND c.relname = 'duel_points' AND i.indisprimary;
  PERFORM pg_temp.ok(cols = ARRAY['duel_id', 'question_index'],
    'duel_points is keyed on (duel_id, question_index) — the arbitration is the constraint');

  SELECT COUNT(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.duel_points'::REGCLASS AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%winner_side%';
  PERFORM pg_temp.ok(n = 1, 'winner_side is constrained by a CHECK');

  SELECT COUNT(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.duel_points'::REGCLASS AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%elapsed_ms%';
  PERFORM pg_temp.ok(n = 1, 'elapsed_ms is constrained by a CHECK');

  RAISE NOTICE '--- duel_points shape OK ---';
END $$;

DO $$
DECLARE k TEXT; d UUID; r JSONB; threw BOOLEAN;
BEGIN
  k := pg_temp.steal_open('hexadecimal', 'player6', INTERVAL '10 seconds');
  d := pg_temp.did(k);

  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 500);
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 1, 'fixture: one award');

  -- The same claim again, twice, from the same side. A duplicated request
  -- is what a retry on a flaky connection looks like.
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 500);
  PERFORM pg_temp.claim(k, NULL, 0, pg_temp.qans(k, 0), 500);
  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 1,
    'a duplicated claim cannot produce a second row for the same question');
  PERFORM pg_temp.ok(pg_temp.pt_winner(k, 0) = 'creator', 'and the winner is unchanged');
  PERFORM pg_temp.ok(pg_temp.pt_ms(k, 0) = 500, 'and so is the time');

  -- The constraints, directly. A function is not the last line of
  -- defence; the table is.
  threw := FALSE;
  BEGIN
    INSERT INTO public.duel_points (duel_id, question_index, winner_side, elapsed_ms)
    VALUES (d, 0, 'creator', 500);
  EXCEPTION WHEN unique_violation THEN threw := TRUE;
  END;
  PERFORM pg_temp.ok(threw, 'a second row for (duel, index) is rejected by the primary key');

  threw := FALSE;
  BEGIN
    INSERT INTO public.duel_points (duel_id, question_index, winner_side, elapsed_ms)
    VALUES (d, 50, 'nobody', 500);
  EXCEPTION WHEN check_violation THEN threw := TRUE;
  END;
  PERFORM pg_temp.ok(threw, 'a winner_side outside creator/opponent is rejected');

  threw := FALSE;
  BEGIN
    INSERT INTO public.duel_points (duel_id, question_index, winner_side, elapsed_ms)
    VALUES (d, 51, 'creator', -1);
  EXCEPTION WHEN check_violation THEN threw := TRUE;
  END;
  PERFORM pg_temp.ok(threw, 'a negative elapsed_ms is rejected');

  PERFORM pg_temp.ok(pg_temp.pt_count(k, NULL) = 1, 'none of those got in');

  -- The rows die with the duel, so a deleted account cannot leave a
  -- scoreboard behind.
  DELETE FROM public.duels WHERE id = d;
  PERFORM pg_temp.ok(
    (SELECT COUNT(*) FROM public.duel_points WHERE duel_id = d) = 0,
    'duel_points cascades when its duel is deleted');

  RAISE NOTICE '--- one award per index OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 11. Posture
--
-- duel_points holds the live scoreboard of a game in progress. A direct
-- SELECT on it tells a player exactly how far ahead they are before the
-- reveal, and a direct INSERT is the whole game.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE relrls BOOLEAN; npol INT; n INT; bad TEXT;
BEGIN
  SELECT c.relrowsecurity INTO relrls
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'duel_points';
  PERFORM pg_temp.ok(relrls, 'RLS is enabled on duel_points');

  SELECT COUNT(*) INTO npol FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'duel_points';
  PERFORM pg_temp.ok(npol = 0,
    'duel_points has NO policies — it is reachable only through the functions');

  -- With no policies, RLS already denies every row; the revoked grant is
  -- what stops a policy added in haste from becoming a public read.
  PERFORM pg_temp.ok(
    has_table_privilege('anon', 'public.duel_points', 'SELECT') IS FALSE,
    'anon has no SELECT on duel_points');
  PERFORM pg_temp.ok(
    has_table_privilege('anon', 'public.duel_points', 'INSERT') IS FALSE,
    'anon has no INSERT on duel_points');
  PERFORM pg_temp.ok(
    has_table_privilege('anon', 'public.duel_points', 'UPDATE') IS FALSE,
    'anon has no UPDATE on duel_points');
  PERFORM pg_temp.ok(
    has_table_privilege('anon', 'public.duel_points', 'DELETE') IS FALSE,
    'anon has no DELETE on duel_points');
  PERFORM pg_temp.ok(
    has_table_privilege('authenticated', 'public.duel_points', 'SELECT') IS FALSE,
    'authenticated has no SELECT on duel_points either — the reveal gate is not optional');
  PERFORM pg_temp.ok(
    has_table_privilege('authenticated', 'public.duel_points', 'INSERT') IS FALSE,
    'authenticated has no INSERT on duel_points');
  PERFORM pg_temp.ok(
    has_table_privilege('authenticated', 'public.duel_points', 'UPDATE') IS FALSE,
    'authenticated has no UPDATE on duel_points');
  PERFORM pg_temp.ok(
    has_table_privilege('authenticated', 'public.duel_points', 'DELETE') IS FALSE,
    'authenticated has no DELETE on duel_points');

  -- claim_duel_point itself.
  PERFORM pg_temp.ok(
    (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'claim_duel_point'),
    'claim_duel_point is SECURITY DEFINER');
  PERFORM pg_temp.ok(
    (SELECT 'search_path=public' = ANY(p.proconfig) FROM pg_proc p
       JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'claim_duel_point'),
    'claim_duel_point pins search_path = public');
  PERFORM pg_temp.ok(
    (SELECT pg_get_function_result(p.oid) FROM pg_proc p
       JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'claim_duel_point') = 'jsonb',
    'claim_duel_point returns jsonb');
  PERFORM pg_temp.ok(
    (SELECT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p
       JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'claim_duel_point'),
    'anon can call claim_duel_point — guests play duels');
  PERFORM pg_temp.ok(
    (SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') FROM pg_proc p
       JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'claim_duel_point'),
    'authenticated can call claim_duel_point');

  -- Every function that touches the table, not just the one this file
  -- calls by name. Without a pinned search_path an unqualified name in a
  -- SECURITY DEFINER body resolves against the CALLER's search_path.
  SELECT COUNT(*), string_agg(p.proname, ', ') INTO n, bad
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.prosrc LIKE '%duel_points%'
     AND NOT (p.prosecdef AND COALESCE('search_path=public' = ANY(p.proconfig), FALSE));
  PERFORM pg_temp.ok(n = 0,
    'every function that touches duel_points is SECURITY DEFINER with search_path = public'
    || COALESCE(' (offenders: ' || bad || ')', ''));

  RAISE NOTICE '--- posture OK ---';
END $$;

SELECT 'ALL STEAL CONTRACT TESTS PASSED' AS result;
