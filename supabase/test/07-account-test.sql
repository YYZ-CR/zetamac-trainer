-- Contract tests for supabase/account.sql.
--
-- Written against docs/account-deletion.md BEFORE reading the
-- implementation, so a pass means the contract holds — not that the code
-- does what it happens to do.
--
-- Runs after 06-settings-test.sql; pg_temp.ok / as_user / as_anon come
-- from 02-test.sql.
--
-- Two rules shape every assertion below:
--
--   * Never assert on non-emptiness. "Returned something", "did not
--     error" and "the row count changed" are not evidence. Every
--     assertion names the value it expects.
--   * Every precondition is fatal. pg_temp.ok RAISEs, so a fixture that
--     did not build what the test thinks it built dies at the setup
--     line rather than sailing on to a green post-condition that was
--     vacuously true.
--
-- The function under test destroys rows. That makes a test that
-- verifies too little actively dangerous: the failure mode is "the
-- delete quietly skipped a table" and the only thing standing between
-- that and production is whether this file counted.

\set ON_ERROR_STOP on
SET client_min_messages = NOTICE;

-- ════════════════════════════════════════════════════════════════
-- Helpers
-- ════════════════════════════════════════════════════════════════

-- Impersonate by id. Half these tests delete the user under test, and
-- pg_temp.as_user('…') looks callers up by a name that is about to stop
-- existing.
CREATE OR REPLACE FUNCTION pg_temp.acct_as(p_uid UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::TEXT, FALSE);
END $$;

-- A fresh account. p_username NULL leaves the account with no profile
-- row at all — a real state in this app: with email confirmation on,
-- signUp returns a user but no session, so the profile insert never
-- happens.
CREATE OR REPLACE FUNCTION pg_temp.acct_new(p_username TEXT)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE uid UUID;
BEGIN
  INSERT INTO auth.users (email)
  VALUES (COALESCE(p_username, 'noname' || md5(random()::TEXT)) || '@acct.test')
  RETURNING id INTO uid;

  IF p_username IS NOT NULL THEN
    INSERT INTO public.profiles (id, username, is_public) VALUES (uid, p_username, TRUE);
  END IF;
  RETURN uid;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.acct_sessions(p_uid UUID, p_prefix TEXT, n INT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.game_sessions
    (session_key, user_id, score, duration_seconds, questions, created_at)
  SELECT p_prefix || '_' || i, p_uid, 40 + i, 120, '[]'::jsonb, NOW() - i * INTERVAL '1 day'
  FROM generate_series(1, n) i;
END $$;

-- Past-dated daily attempts. The rule is that the account comes off
-- every daily leaderboard "including past days", so the fixture has to
-- be past days.
CREATE OR REPLACE FUNCTION pg_temp.acct_dailies(p_uid UUID, n INT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE d DATE;
BEGIN
  FOR i IN 1..n LOOP
    d := CURRENT_DATE - (400 + i);
    INSERT INTO public.daily_puzzles (puzzle_date, puzzle_number, config, questions)
    VALUES (d, 9000 + i, '{}'::jsonb, '[]'::jsonb)
    ON CONFLICT (puzzle_date) DO NOTHING;

    INSERT INTO public.daily_attempts
      (puzzle_date, user_id, started_at, submitted_at, score, answers, status)
    VALUES (d, p_uid, NOW(), NOW(), 30 + i, '[]'::jsonb, 'complete');
  END LOOP;
END $$;

-- Play a duel side to completion, answering `n` questions correctly, so
-- the run carries a score of exactly n and the test can assert that the
-- score survived rather than that "a row survived".
CREATE OR REPLACE FUNCTION pg_temp.acct_play(p_key TEXT, n INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE run JSONB; qs JSONB; ans JSONB;
BEGIN
  run := public.start_duel_run(p_key, NULL);
  qs  := run->'questions';
  SELECT jsonb_agg(jsonb_build_object(
           'i', i, 'value', (qs->i->>'answer')::INT, 'elapsed_ms', (i + 1) * 700
         ) ORDER BY i)
    INTO ans FROM generate_series(0, n - 1) i;
  RETURN public.submit_duel_run(p_key, NULL, COALESCE(ans, '[]'::jsonb));
END $$;

-- Every table that can name a user, in one number. "Leaves no row that
-- identifies it" is the headline rule of the design doc; this is that
-- rule expressed as a query.
CREATE OR REPLACE FUNCTION pg_temp.acct_refs(p_uid UUID)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT (SELECT COUNT(*) FROM auth.users            WHERE id          = p_uid)
       + (SELECT COUNT(*) FROM public.profiles       WHERE id          = p_uid)
       + (SELECT COUNT(*) FROM public.game_sessions  WHERE user_id     = p_uid)
       + (SELECT COUNT(*) FROM public.daily_attempts WHERE user_id     = p_uid)
       + (SELECT COUNT(*) FROM public.league_members WHERE user_id     = p_uid)
       + (SELECT COUNT(*) FROM public.leagues        WHERE owner_id    = p_uid)
       + (SELECT COUNT(*) FROM public.duels          WHERE creator_id  = p_uid)
       + (SELECT COUNT(*) FROM public.duels          WHERE opponent_id = p_uid)
       + (SELECT COUNT(*) FROM public.duel_runs      WHERE user_id     = p_uid);
$$;

-- ════════════════════════════════════════════════════════════════
-- 1. The confirmation guard
--
-- The argument is the whole point of the signature: it is what stops a
-- mis-wired button or a stray retry from destroying an account. The
-- assertion that matters is not the error string, it is that the
-- account is still there afterwards.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  uid   UUID;
  r     JSONB;
  keys  TEXT[];
  n     INT;
BEGIN
  uid := pg_temp.acct_new('acct_wrongstr');
  PERFORM pg_temp.acct_sessions(uid, 'wrongstr', 3);
  PERFORM pg_temp.acct_as(uid);

  SELECT COUNT(*) INTO n FROM public.game_sessions WHERE user_id = uid;
  PERFORM pg_temp.ok(n = 3, 'fixture: the guard subject starts with 3 sessions');

  r := public.delete_account('not_my_username');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
    'a wrong confirmation string does not report success');
  PERFORM pg_temp.ok(r->>'error' = 'confirm_mismatch',
    'a wrong confirmation string is refused as confirm_mismatch specifically');

  -- The assertion the whole guard exists for.
  PERFORM pg_temp.ok(pg_temp.acct_refs(uid) = 5,
    'a refused delete left the account entirely intact: user + profile + 3 sessions');
  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = uid) = 'acct_wrongstr',
    'and the username is still theirs');

  -- "On {ok: false} only `error` is present."
  SELECT array_agg(k ORDER BY k COLLATE "C") INTO keys FROM jsonb_object_keys(r) k;
  PERFORM pg_temp.ok(keys = ARRAY['error', 'ok'],
    'a refusal payload is exactly {ok, error} — no counts from a delete that did not happen');

  -- A mismatch does not raise: a user error is a payload, only a
  -- programming error is an exception. Reaching this line at all is
  -- that assertion; state it so the reason is on the record.
  PERFORM pg_temp.ok(TRUE, 'a mismatch returns a payload rather than raising');

  -- Near misses are still misses.
  PERFORM pg_temp.ok(public.delete_account('acct_wrongst')->>'error' = 'confirm_mismatch',
    'a username one character short is refused');
  PERFORM pg_temp.ok(public.delete_account('')->>'error' = 'confirm_mismatch',
    'an empty string is refused for an account that HAS a username');
  PERFORM pg_temp.ok(public.delete_account(NULL)->>'error' = 'confirm_mismatch',
    'a null confirmation is refused, not crashed on');
  PERFORM pg_temp.ok(public.delete_account('DELETE')->>'error' = 'confirm_mismatch',
    'the literal DELETE does not confirm an account that has a username');

  PERFORM pg_temp.ok(pg_temp.acct_refs(uid) = 5,
    'five refused attempts in a row deleted nothing');

  RAISE NOTICE '--- confirmation refusals OK ---';
END $$;

-- Case-insensitively, after trimming — one account per accepted form,
-- because a success consumes the account under test.
DO $$
DECLARE uid UUID; r JSONB;
BEGIN
  uid := pg_temp.acct_new('acct_upper');
  PERFORM pg_temp.acct_as(uid);
  r := public.delete_account('ACCT_UPPER');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'the username in upper case confirms — the comparison is case-insensitive');
  PERFORM pg_temp.ok(pg_temp.acct_refs(uid) = 0, 'and the account is gone');

  uid := pg_temp.acct_new('acct_padded');
  PERFORM pg_temp.acct_as(uid);
  r := public.delete_account('   acct_padded   ');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'a padded username confirms — the comparison trims');
  PERFORM pg_temp.ok(pg_temp.acct_refs(uid) = 0, 'and the account is gone');

  uid := pg_temp.acct_new('acct_mixed');
  PERFORM pg_temp.acct_as(uid);
  r := public.delete_account('  Acct_MIXED ');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'padding and case together still confirm');
  PERFORM pg_temp.ok(pg_temp.acct_refs(uid) = 0, 'and the account is gone');

  RAISE NOTICE '--- confirmation normalisation OK ---';
END $$;

-- An account with no username confirms with the literal DELETE, and
-- with nothing else. The empty string is the case that matters: a
-- client that renders an empty "type your username" field must not be
-- able to submit it.
DO $$
DECLARE uid UUID; r JSONB;
BEGIN
  uid := pg_temp.acct_new(NULL);
  PERFORM pg_temp.acct_as(uid);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = uid),
    'fixture: this account really has no profile row');
  PERFORM pg_temp.acct_sessions(uid, 'noname', 2);

  PERFORM pg_temp.ok(public.delete_account('')->>'error' = 'confirm_mismatch',
    'an empty string does NOT confirm an account with no username');
  PERFORM pg_temp.ok(public.delete_account('   ')->>'error' = 'confirm_mismatch',
    'whitespace does not confirm it either — trimming must not turn it into a match');
  PERFORM pg_temp.ok(public.delete_account(NULL)->>'error' = 'confirm_mismatch',
    'null does not confirm it');
  PERFORM pg_temp.ok(public.delete_account('DELETE_ME')->>'error' = 'confirm_mismatch',
    'a string merely containing DELETE does not confirm it');
  PERFORM pg_temp.ok(pg_temp.acct_refs(uid) = 3,
    'four refusals later the account and its 2 sessions are still there');

  r := public.delete_account('DELETE');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'the literal DELETE confirms an account with no username');
  PERFORM pg_temp.ok((r->>'sessions_deleted')::INT = 2,
    'and it really deleted the 2 sessions');
  PERFORM pg_temp.ok(pg_temp.acct_refs(uid) = 0,
    'a profile-less account deletes completely');

  RAISE NOTICE '--- no-username confirmation OK ---';
END $$;

-- The same normalisation applies to DELETE.
DO $$
DECLARE uid UUID;
BEGIN
  uid := pg_temp.acct_new(NULL);
  PERFORM pg_temp.acct_as(uid);
  PERFORM pg_temp.ok((public.delete_account('  delete  ')->>'ok')::BOOLEAN IS TRUE,
    'DELETE is compared the same way a username is: case-insensitively, after trimming');
  PERFORM pg_temp.ok(pg_temp.acct_refs(uid) = 0, 'and the account is gone');

  RAISE NOTICE '--- DELETE normalisation OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 2. Leagues — the rule this function exists for
--
-- leagues.owner_id is ON DELETE CASCADE, so the naive delete takes the
-- whole league down and every other member's board with it. These are
-- the assertions that a hand-written transfer really happened.
-- ════════════════════════════════════════════════════════════════

-- 2a. The owner of a three-member league leaves it standing.
--
-- The successor is deliberately given the LARGER uuid of the two
-- remaining members. `ORDER BY joined_at ASC, user_id ASC` and
-- `ORDER BY user_id ASC` pick different rows here, so an implementation
-- that forgot joined_at fails this test instead of passing it by luck.
DO $$
DECLARE
  v_owner   UUID;
  early     UUID;   -- joined first, larger uuid
  late      UUID;   -- joined second, smaller uuid
  a         UUID;
  b         UUID;
  code      TEXT;
  lid       UUID;
  r         JSONB;
  n         INT;
BEGIN
  v_owner := pg_temp.acct_new('acct_lown');
  a := pg_temp.acct_new('acct_lm_a');
  b := pg_temp.acct_new('acct_lm_b');
  early := GREATEST(a, b);
  late  := LEAST(a, b);

  PERFORM pg_temp.acct_as(v_owner);
  code := (public.create_league('Succession By Delete'))->>'league_key';
  SELECT id INTO lid FROM public.leagues WHERE league_key = code;

  PERFORM pg_temp.acct_as(early);
  PERFORM public.join_league(code);
  PERFORM pg_temp.acct_as(late);
  PERFORM public.join_league(code);

  -- Pin joined_at rather than trusting clock_timestamp() ordering, so
  -- the expected successor is a stated fact and not a race.
  UPDATE public.league_members SET joined_at = TIMESTAMPTZ '2019-01-01'
   WHERE league_id = lid AND user_id = v_owner;
  UPDATE public.league_members SET joined_at = TIMESTAMPTZ '2020-01-01'
   WHERE league_id = lid AND user_id = early;
  UPDATE public.league_members SET joined_at = TIMESTAMPTZ '2021-01-01'
   WHERE league_id = lid AND user_id = late;

  SELECT COUNT(*) INTO n FROM public.league_members WHERE league_id = lid;
  PERFORM pg_temp.ok(n = 3, 'fixture: the league has exactly 3 members');
  PERFORM pg_temp.ok((SELECT g.owner_id FROM public.leagues g WHERE g.id = lid) = v_owner,
    'fixture: the account about to be deleted owns it');
  PERFORM pg_temp.ok(early > late,
    'fixture: the intended successor has the LARGER uuid, so user_id ordering alone would pick wrong');

  PERFORM pg_temp.acct_as(v_owner);
  r := public.delete_account('acct_lown');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'the owner deletes their account');

  SELECT COUNT(*) INTO n FROM public.leagues WHERE id = lid;
  PERFORM pg_temp.ok(n = 1,
    'the league SURVIVES its owner deleting their account — the cascade did not take it');

  PERFORM pg_temp.ok(
    (SELECT g.owner_id FROM public.leagues g WHERE g.id = lid) = early,
    'ownership passed to the longest-standing remaining member, not the lowest uuid');

  SELECT COUNT(*) INTO n FROM public.league_members WHERE league_id = lid;
  PERFORM pg_temp.ok(n = 2, 'exactly the two remaining members are still in it');
  PERFORM pg_temp.ok(
    EXISTS (SELECT 1 FROM public.league_members WHERE league_id = lid AND user_id = early)
    AND EXISTS (SELECT 1 FROM public.league_members WHERE league_id = lid AND user_id = late),
    'both remaining members kept their membership row');
  PERFORM pg_temp.ok(
    NOT EXISTS (SELECT 1 FROM public.league_members WHERE league_id = lid AND user_id = v_owner),
    'the departed owner is no longer a member');

  PERFORM pg_temp.ok((r->>'leagues_left')::INT        = 1, 'leagues_left is 1');
  PERFORM pg_temp.ok((r->>'leagues_transferred')::INT = 1,
    'leagues_transferred is 1 — exactly one league changed hands');
  PERFORM pg_temp.ok((r->>'leagues_deleted')::INT     = 0, 'no league was deleted');

  -- joined_at is what the succession order reads. A transfer that
  -- rewrote it would let the next departure pick a different heir.
  PERFORM pg_temp.ok(
    (SELECT joined_at FROM public.league_members WHERE league_id = lid AND user_id = early)
      = TIMESTAMPTZ '2020-01-01',
    'the transfer did not touch the successor''s joined_at');

  RAISE NOTICE '--- owner transfer OK ---';
END $$;

-- 2b. Sole member: the league goes with them.
DO $$
DECLARE uid UUID; code TEXT; lid UUID; r JSONB; n INT;
BEGIN
  uid := pg_temp.acct_new('acct_lsolo');
  PERFORM pg_temp.acct_as(uid);
  code := (public.create_league('Only Me'))->>'league_key';
  SELECT id INTO lid FROM public.leagues WHERE league_key = code;

  SELECT COUNT(*) INTO n FROM public.league_members WHERE league_id = lid;
  PERFORM pg_temp.ok(n = 1, 'fixture: the league has exactly one member');

  r := public.delete_account('acct_lsolo');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'the sole member deletes their account');

  SELECT COUNT(*) INTO n FROM public.leagues WHERE id = lid;
  PERFORM pg_temp.ok(n = 0, 'a league with nobody left in it is deleted');
  SELECT COUNT(*) INTO n FROM public.league_members WHERE league_id = lid;
  PERFORM pg_temp.ok(n = 0, 'and its membership rows go with it');

  PERFORM pg_temp.ok((r->>'leagues_left')::INT        = 1, 'leagues_left is 1');
  PERFORM pg_temp.ok((r->>'leagues_deleted')::INT     = 1, 'leagues_deleted is 1');
  PERFORM pg_temp.ok((r->>'leagues_transferred')::INT = 0,
    'an emptied league is deleted, not transferred to nobody');

  RAISE NOTICE '--- sole member OK ---';
END $$;

-- 2c. A plain member leaving changes nothing but the roster.
DO $$
DECLARE v_owner UUID; uid UUID; code TEXT; lid UUID; r JSONB; n INT;
BEGIN
  v_owner := pg_temp.acct_new('acct_lkeep');
  uid     := pg_temp.acct_new('acct_lmemb');

  PERFORM pg_temp.acct_as(v_owner);
  code := (public.create_league('Owner Stays'))->>'league_key';
  SELECT id INTO lid FROM public.leagues WHERE league_key = code;

  PERFORM pg_temp.acct_as(uid);
  PERFORM public.join_league(code);
  SELECT COUNT(*) INTO n FROM public.league_members WHERE league_id = lid;
  PERFORM pg_temp.ok(n = 2, 'fixture: two members');

  r := public.delete_account('acct_lmemb');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'a non-owner member deletes their account');

  PERFORM pg_temp.ok((SELECT g.owner_id FROM public.leagues g WHERE g.id = lid) = v_owner,
    'a non-owner leaving does not change the owner');
  SELECT COUNT(*) INTO n FROM public.league_members WHERE league_id = lid;
  PERFORM pg_temp.ok(n = 1, 'the roster is down to the owner');
  PERFORM pg_temp.ok((r->>'leagues_left')::INT        = 1, 'leagues_left is 1');
  PERFORM pg_temp.ok((r->>'leagues_transferred')::INT = 0, 'nothing was transferred');
  PERFORM pg_temp.ok((r->>'leagues_deleted')::INT     = 0, 'nothing was deleted');

  RAISE NOTICE '--- non-owner member OK ---';
END $$;

-- 2d. The tie-break, stated: joined_at ASC, then user_id ASC.
DO $$
DECLARE
  v_owner UUID; a UUID; b UUID; code TEXT; lid UUID; r JSONB;
BEGIN
  v_owner := pg_temp.acct_new('acct_ltie');
  a := pg_temp.acct_new('acct_tie_a');
  b := pg_temp.acct_new('acct_tie_b');

  PERFORM pg_temp.acct_as(v_owner);
  code := (public.create_league('Dead Heat'))->>'league_key';
  SELECT id INTO lid FROM public.leagues WHERE league_key = code;

  PERFORM pg_temp.acct_as(a);
  PERFORM public.join_league(code);
  PERFORM pg_temp.acct_as(b);
  PERFORM public.join_league(code);

  -- Byte-identical joined_at, which is exactly what a seed script or a
  -- future "invite these five people" RPC would produce.
  UPDATE public.league_members SET joined_at = TIMESTAMPTZ '2022-06-01 12:00:00+00'
   WHERE league_id = lid AND user_id IN (a, b);
  UPDATE public.league_members SET joined_at = TIMESTAMPTZ '2019-01-01'
   WHERE league_id = lid AND user_id = v_owner;

  PERFORM pg_temp.ok(
    (SELECT COUNT(DISTINCT joined_at) FROM public.league_members
      WHERE league_id = lid AND user_id IN (a, b)) = 1,
    'fixture: the two candidates share a joined_at to the byte');
  PERFORM pg_temp.ok(a <> b, 'fixture: the two candidates are distinct users');

  PERFORM pg_temp.acct_as(v_owner);
  r := public.delete_account('acct_ltie');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'the owner deletes their account');

  PERFORM pg_temp.ok((SELECT g.owner_id FROM public.leagues g WHERE g.id = lid) = LEAST(a, b),
    'a joined_at tie is broken by user_id ASC — the lower uuid takes the league');
  PERFORM pg_temp.ok((r->>'leagues_transferred')::INT = 1, 'the tie still counts as a transfer');

  RAISE NOTICE '--- succession tie-break OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 3. The full delete: orphans, counts, the username, and a bystander
--
-- One subject carrying the exact mix in the design doc's example
-- payload — three leagues, one of which is emptied and one of which is
-- handed on — so the counts can be asserted against a known reality
-- rather than against each other.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  main       UUID;
  m1         UUID;
  m2         UUID;
  host       UUID;
  stander    UUID;
  code_solo  TEXT; code_own TEXT; code_guest TEXT;
  lid_solo   UUID; lid_own UUID; lid_guest UUID;
  r          JSONB;
  keys       TEXT[];
  n          INT;
  orphans_before INT; orphans_after INT;
  cs_before INT; cs_after INT;
  da_before INT; da_after INT;
  lm_before INT; lm_after INT;
  dr_before INT; dr_after INT;
BEGIN
  -- ── The bystander: involved in none of this ───────────────────
  stander := pg_temp.acct_new('acct_bystand');
  PERFORM pg_temp.acct_sessions(stander, 'bystand', 4);
  PERFORM pg_temp.acct_dailies(stander, 2);
  PERFORM pg_temp.acct_as(stander);
  PERFORM public.create_league('Bystander League');
  PERFORM public.start_duel_run((public.create_duel(120))->>'duel_key', NULL);

  -- A census of zeros would prove nothing, so every column of it is
  -- required to be non-trivial before it is any use as a control.
  SELECT COUNT(*) INTO cs_before FROM public.game_sessions  WHERE user_id = stander;
  SELECT COUNT(*) INTO da_before FROM public.daily_attempts WHERE user_id = stander;
  SELECT COUNT(*) INTO lm_before FROM public.league_members WHERE user_id = stander;
  SELECT COUNT(*) INTO dr_before FROM public.duel_runs      WHERE user_id = stander;
  PERFORM pg_temp.ok(cs_before = 4, 'fixture: the bystander has 4 sessions');
  PERFORM pg_temp.ok(da_before = 2, 'fixture: the bystander has 2 daily attempts');
  PERFORM pg_temp.ok(lm_before = 1, 'fixture: the bystander is in 1 league');
  PERFORM pg_temp.ok(dr_before = 1, 'fixture: the bystander has 1 duel run');

  -- ── The subject ───────────────────────────────────────────────
  main := pg_temp.acct_new('acct_main');
  m1   := pg_temp.acct_new('acct_main_m1');
  m2   := pg_temp.acct_new('acct_main_m2');
  host := pg_temp.acct_new('acct_main_h');

  PERFORM pg_temp.acct_sessions(main, 'main', 5);
  PERFORM pg_temp.acct_dailies(main, 3);

  PERFORM pg_temp.acct_as(main);
  code_solo := (public.create_league('Main Solo'))->>'league_key';
  code_own  := (public.create_league('Main Owned'))->>'league_key';
  SELECT id INTO lid_solo FROM public.leagues WHERE league_key = code_solo;
  SELECT id INTO lid_own  FROM public.leagues WHERE league_key = code_own;

  PERFORM pg_temp.acct_as(m1);
  PERFORM public.join_league(code_own);
  PERFORM pg_temp.acct_as(m2);
  PERFORM public.join_league(code_own);

  PERFORM pg_temp.acct_as(host);
  code_guest := (public.create_league('Somebody Else''s'))->>'league_key';
  SELECT id INTO lid_guest FROM public.leagues WHERE league_key = code_guest;
  PERFORM pg_temp.acct_as(main);
  PERFORM public.join_league(code_guest);

  UPDATE public.league_members SET joined_at = TIMESTAMPTZ '2020-03-01'
   WHERE league_id = lid_own AND user_id = m1;
  UPDATE public.league_members SET joined_at = TIMESTAMPTZ '2020-04-01'
   WHERE league_id = lid_own AND user_id = m2;

  SELECT COUNT(*) INTO n FROM public.league_members WHERE user_id = main;
  PERFORM pg_temp.ok(n = 3, 'fixture: the subject is in exactly 3 leagues');
  SELECT COUNT(*) INTO n FROM public.game_sessions WHERE user_id = main;
  PERFORM pg_temp.ok(n = 5, 'fixture: the subject has exactly 5 sessions');
  SELECT COUNT(*) INTO n FROM public.daily_attempts WHERE user_id = main;
  PERFORM pg_temp.ok(n = 3, 'fixture: the subject has exactly 3 daily attempts');
  PERFORM pg_temp.ok(public.username_available('acct_main') IS FALSE,
    'fixture: the subject''s username is taken while the account lives');

  -- An orphaned session is the failure mode game_sessions.user_id
  -- ON DELETE SET NULL produces, and it is invisible to a count of the
  -- user''s own rows. Count the unowned rows in the whole table.
  SELECT COUNT(*) INTO orphans_before FROM public.game_sessions WHERE user_id IS NULL;

  -- ── The delete ────────────────────────────────────────────────
  PERFORM pg_temp.acct_as(main);
  r := public.delete_account('acct_main');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'the delete succeeds');

  -- ── The payload is exactly the documented shape ───────────────
  SELECT array_agg(k ORDER BY k COLLATE "C") INTO keys FROM jsonb_object_keys(r) k;
  PERFORM pg_temp.ok(keys = ARRAY[
      'daily_attempts_deleted', 'duel_slots_released', 'duels_deleted',
      'leagues_deleted', 'leagues_left', 'leagues_transferred',
      'ok', 'sessions_deleted'],
    'the success payload carries exactly the eight documented keys');

  PERFORM pg_temp.ok((r->>'leagues_left')::INT           = 3, 'leagues_left = 3');
  PERFORM pg_temp.ok((r->>'leagues_deleted')::INT        = 1, 'leagues_deleted = 1');
  PERFORM pg_temp.ok((r->>'leagues_transferred')::INT    = 1, 'leagues_transferred = 1');
  PERFORM pg_temp.ok((r->>'sessions_deleted')::INT       = 5, 'sessions_deleted = 5');
  PERFORM pg_temp.ok((r->>'daily_attempts_deleted')::INT = 3, 'daily_attempts_deleted = 3');
  PERFORM pg_temp.ok((r->>'duels_deleted')::INT          = 0,
    'a count with nothing to count is reported as 0, not omitted');
  PERFORM pg_temp.ok((r->>'duel_slots_released')::INT    = 0, 'duel_slots_released = 0');

  -- ── Nothing that identifies the account is left ───────────────
  PERFORM pg_temp.ok(pg_temp.acct_refs(main) = 0,
    'no row in any table still names the deleted account');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = main),
    'the profiles row is gone');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM auth.users WHERE id = main),
    'the auth.users row is gone');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.daily_attempts WHERE user_id = main),
    'every daily_attempts row is gone, past days included');

  -- Deleted, not orphaned. This is the assertion that separates a real
  -- delete from letting ON DELETE SET NULL have its way.
  SELECT COUNT(*) INTO n FROM public.game_sessions WHERE session_key LIKE 'main\_%';
  PERFORM pg_temp.ok(n = 0,
    'the subject''s sessions are DELETED, not left with a NULL user_id');
  SELECT COUNT(*) INTO orphans_after FROM public.game_sessions WHERE user_id IS NULL;
  PERFORM pg_temp.ok(orphans_after = orphans_before,
    'the table gained no unowned sessions — the global percentile is unchanged');

  -- ── The leagues settled the way the rule says ─────────────────
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.leagues WHERE id = lid_solo),
    'the league where they were alone is gone');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.leagues WHERE id = lid_own),
    'the league they owned survives');
  PERFORM pg_temp.ok((SELECT g.owner_id FROM public.leagues g WHERE g.id = lid_own) = m1,
    'and it went to its longest-standing remaining member');
  SELECT COUNT(*) INTO n FROM public.league_members WHERE league_id = lid_own;
  PERFORM pg_temp.ok(n = 2, 'the owned league keeps both remaining members');
  PERFORM pg_temp.ok((SELECT g.owner_id FROM public.leagues g WHERE g.id = lid_guest) = host,
    'the league they merely joined keeps its own owner');
  SELECT COUNT(*) INTO n FROM public.league_members WHERE league_id = lid_guest;
  PERFORM pg_temp.ok(n = 1, 'and is down to just its owner');

  -- ── The username is genuinely released ────────────────────────
  PERFORM pg_temp.ok(public.username_available('acct_main') IS TRUE,
    'the username reads as available again');
  DECLARE
    newcomer UUID := pg_temp.acct_new(NULL);
    sr       JSONB;
  BEGIN
    PERFORM pg_temp.acct_as(newcomer);
    sr := public.set_username('acct_main');
    PERFORM pg_temp.ok((sr->>'ok')::BOOLEAN IS TRUE,
      'another user can actually claim the deleted account''s name');
    PERFORM pg_temp.ok(
      (SELECT id FROM public.profiles WHERE username = 'acct_main') = newcomer,
      'and the name now belongs to them');
  END;

  -- ── The bystander was not touched ─────────────────────────────
  SELECT COUNT(*) INTO cs_after FROM public.game_sessions  WHERE user_id = stander;
  SELECT COUNT(*) INTO da_after FROM public.daily_attempts WHERE user_id = stander;
  SELECT COUNT(*) INTO lm_after FROM public.league_members WHERE user_id = stander;
  SELECT COUNT(*) INTO dr_after FROM public.duel_runs      WHERE user_id = stander;
  PERFORM pg_temp.ok(cs_after = cs_before, 'the bystander''s game_sessions are untouched');
  PERFORM pg_temp.ok(da_after = da_before, 'the bystander''s daily_attempts are untouched');
  PERFORM pg_temp.ok(lm_after = lm_before, 'the bystander''s league_members are untouched');
  PERFORM pg_temp.ok(dr_after = dr_before, 'the bystander''s duel_runs are untouched');
  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = stander) = 'acct_bystand',
    'the bystander still has their profile and their name');

  RAISE NOTICE '--- full delete OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 4. Duels
--
-- Three fates, and they are not the same fate: a duel the caller
-- created dies with them, a duel they played as the opponent survives
-- them, and a duel they claimed but never finished gives the slot back.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  subj      UUID;
  rival     UUID;
  third     UUID;
  k_mine    TEXT; id_mine  UUID;   -- created by subj, played out
  k_empty   TEXT; id_empty UUID;   -- created by subj, nobody came
  k_theirs  TEXT; id_theirs UUID;  -- created by rival, subj played opponent
  k_claim   TEXT; id_claim UUID;   -- created by third, subj claimed, never finished
  r         JSONB;
  n         INT;
  creator_score  INT;
  opp_score      INT;
  claim_status   TEXT;
BEGIN
  subj  := pg_temp.acct_new('acct_duel_s');
  rival := pg_temp.acct_new('acct_duel_r');
  third := pg_temp.acct_new('acct_duel_t');

  -- (a) subj creates and both sides play it out.
  PERFORM pg_temp.acct_as(subj);
  k_mine := (public.create_duel(120))->>'duel_key';
  SELECT id INTO id_mine FROM public.duels WHERE duel_key = k_mine;
  PERFORM pg_temp.acct_play(k_mine, 9);
  PERFORM pg_temp.acct_as(rival);
  PERFORM pg_temp.acct_play(k_mine, 7);

  -- (b) subj creates one nobody ever opens.
  PERFORM pg_temp.acct_as(subj);
  k_empty := (public.create_duel(120))->>'duel_key';
  SELECT id INTO id_empty FROM public.duels WHERE duel_key = k_empty;

  -- (c) rival creates, subj plays the opponent side to completion.
  PERFORM pg_temp.acct_as(rival);
  k_theirs := (public.create_duel(120))->>'duel_key';
  SELECT id INTO id_theirs FROM public.duels WHERE duel_key = k_theirs;
  PERFORM pg_temp.acct_play(k_theirs, 11);
  PERFORM pg_temp.acct_as(subj);
  PERFORM pg_temp.acct_play(k_theirs, 6);

  -- (d) third creates, subj claims the opponent side and walks away.
  PERFORM pg_temp.acct_as(third);
  k_claim := (public.create_duel(120))->>'duel_key';
  SELECT id INTO id_claim FROM public.duels WHERE duel_key = k_claim;
  PERFORM public.start_duel_run(k_claim, NULL);
  PERFORM pg_temp.acct_as(subj);
  PERFORM public.start_duel_run(k_claim, NULL);

  -- ── Preconditions, all fatal ──────────────────────────────────
  SELECT COUNT(*) INTO n FROM public.duel_runs WHERE duel_id = id_mine;
  PERFORM pg_temp.ok(n = 2, 'fixture: the subject''s own duel holds two runs');
  SELECT COUNT(*) INTO n FROM public.duel_runs WHERE duel_id = id_empty;
  PERFORM pg_temp.ok(n = 0, 'fixture: the unopened duel holds no runs');

  SELECT score INTO creator_score FROM public.duel_runs
   WHERE duel_id = id_theirs AND side = 'creator';
  SELECT score INTO opp_score FROM public.duel_runs
   WHERE duel_id = id_theirs AND side = 'opponent';
  PERFORM pg_temp.ok(creator_score = 11,
    'fixture: the rival scored exactly 11 on their own duel');
  PERFORM pg_temp.ok(opp_score = 6,
    'fixture: the subject scored exactly 6 as the opponent');
  PERFORM pg_temp.ok(
    (SELECT opponent_id FROM public.duels WHERE id = id_theirs) = subj,
    'fixture: the subject is recorded as that duel''s opponent');

  PERFORM pg_temp.ok(
    (SELECT opponent_id FROM public.duels WHERE id = id_claim) = subj,
    'fixture: the subject holds the claimed slot');
  PERFORM pg_temp.ok(
    (SELECT submitted_at FROM public.duel_runs
      WHERE duel_id = id_claim AND side = 'opponent') IS NULL,
    'fixture: that claimed run was never submitted');
  SELECT status INTO claim_status FROM public.duels WHERE id = id_claim;
  PERFORM pg_temp.ok(claim_status = 'open', 'fixture: the claimed duel is still open');

  -- ── The delete ────────────────────────────────────────────────
  PERFORM pg_temp.acct_as(subj);
  r := public.delete_account('acct_duel_s');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'the delete succeeds');
  PERFORM pg_temp.ok((r->>'duels_deleted')::INT = 2,
    'duels_deleted = 2 — both duels the subject created');
  PERFORM pg_temp.ok((r->>'duel_slots_released')::INT = 1,
    'duel_slots_released = 1 — the one they claimed and never finished');

  -- (a)+(b) Duels the caller created are gone, with their runs.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.duels WHERE id = id_mine),
    'a duel the caller created is deleted');
  SELECT COUNT(*) INTO n FROM public.duel_runs WHERE duel_id = id_mine;
  PERFORM pg_temp.ok(n = 0,
    'its runs go with it — including the opponent''s, which is the cost the doc states');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.duels WHERE id = id_empty),
    'a duel the caller created that nobody played is deleted too');

  -- (c) A duel played as the opponent survives, intact.
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.duels WHERE id = id_theirs),
    'a duel the caller played as OPPONENT survives — it is the creator''s object');
  PERFORM pg_temp.ok(
    (SELECT creator_id FROM public.duels WHERE id = id_theirs) = rival,
    'and it still belongs to its creator');
  PERFORM pg_temp.ok(
    (SELECT score FROM public.duel_runs WHERE duel_id = id_theirs AND side = 'creator') = 11,
    'the creator''s run keeps its score');
  PERFORM pg_temp.ok(
    (SELECT user_id FROM public.duel_runs WHERE duel_id = id_theirs AND side = 'creator') = rival,
    'and keeps its owner');

  SELECT COUNT(*) INTO n FROM public.duel_runs
   WHERE duel_id = id_theirs AND side = 'opponent';
  PERFORM pg_temp.ok(n = 1,
    'the deleted opponent''s run row still EXISTS — it is not deleted mid-comparison');
  PERFORM pg_temp.ok(
    (SELECT user_id FROM public.duel_runs WHERE duel_id = id_theirs AND side = 'opponent') IS NULL,
    'the opponent run lost its owner: user_id is NULL');
  PERFORM pg_temp.ok(
    (SELECT score FROM public.duel_runs WHERE duel_id = id_theirs AND side = 'opponent') = 6,
    'and kept its score, so the creator''s result still has something to be measured against');

  -- (d) An unfinished claim releases the slot.
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.duels WHERE id = id_claim),
    'the duel whose slot was claimed still exists');
  PERFORM pg_temp.ok(
    (SELECT opponent_id FROM public.duels WHERE id = id_claim) IS NULL,
    'opponent_id is back to NULL — the creator''s link is live again');
  SELECT COUNT(*) INTO n FROM public.duel_runs
   WHERE duel_id = id_claim AND side = 'opponent';
  PERFORM pg_temp.ok(n = 0,
    'the unfinished run row is DELETED, not left as an orphan blocking the side');
  PERFORM pg_temp.ok(
    (SELECT status FROM public.duels WHERE id = id_claim) = 'open',
    'and the duel is still open');
  SELECT COUNT(*) INTO n FROM public.duel_runs
   WHERE duel_id = id_claim AND side = 'creator';
  PERFORM pg_temp.ok(n = 1, 'the creator''s own run on it is untouched');
  PERFORM pg_temp.ok(
    (SELECT user_id FROM public.duel_runs WHERE duel_id = id_claim AND side = 'creator') = third,
    'and still belongs to the creator');

  PERFORM pg_temp.ok(pg_temp.acct_refs(subj) = 0,
    'after all of that, no row anywhere still names the deleted account');

  -- The row state above is only the mechanism. These two are what the
  -- design doc actually promises, and a released slot that no new
  -- player can take would satisfy every assertion above while failing
  -- the thing it exists for.
  DECLARE
    latecomer UUID := pg_temp.acct_new('acct_duel_l');
    v         JSONB;
  BEGIN
    PERFORM pg_temp.acct_as(latecomer);
    v := public.start_duel_run(k_claim, NULL);
    PERFORM pg_temp.ok(v->>'side' = 'opponent',
      'a new player can actually claim the released slot — the creator''s link is live');
    PERFORM pg_temp.ok(
      (SELECT d.opponent_id FROM public.duels d WHERE d.id = id_claim) = latecomer,
      'and the duel now records them as its opponent');
  END;

  -- The surviving duel still resolves for its creator, and does not
  -- start leaking or erroring because one side has no account.
  PERFORM pg_temp.acct_as(rival);
  DECLARE v JSONB;
  BEGIN
    v := public.get_duel_by_key(k_theirs, NULL);
    PERFORM pg_temp.ok(v IS NOT NULL,
      'a duel whose opponent deleted their account still resolves');
    PERFORM pg_temp.ok(v->'creator'->>'username' = 'acct_duel_r',
      'and still names its creator');
    PERFORM pg_temp.ok(v::TEXT NOT LIKE '%acct_duel_s%',
      'the deleted opponent''s name appears nowhere in it');
  END;

  RAISE NOTICE '--- duels OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 5. Posture
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE args TEXT; res TEXT; n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'delete_account';
  PERFORM pg_temp.ok(n = 1,
    'there is exactly one delete_account — no overload that could take an id');

  -- regprocedure, not pg_get_function_identity_arguments: the latter
  -- carries the parameter NAME, which is not part of the contract.
  SELECT p.oid::REGPROCEDURE::TEXT,
         pg_get_function_result(p.oid)
    INTO args, res
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'delete_account';
  PERFORM pg_temp.ok(args = 'delete_account(text)',
    'delete_account takes one text argument and nothing else — the id is auth.uid(), always');
  PERFORM pg_temp.ok(res = 'jsonb', 'delete_account returns jsonb');

  PERFORM pg_temp.ok(
    (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'delete_account'),
    'delete_account is SECURITY DEFINER');

  -- Without a pinned search_path, every unqualified name in the body
  -- resolves against the CALLER's — as the owner.
  PERFORM pg_temp.ok(
    (SELECT 'search_path=public' = ANY(p.proconfig) FROM pg_proc p
       JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'delete_account'),
    'delete_account pins search_path = public');

  -- Functions are EXECUTE-to-PUBLIC by default, so anon has it unless
  -- the migration explicitly took it away.
  PERFORM pg_temp.ok(
    has_function_privilege('anon', 'public.delete_account(text)', 'EXECUTE') IS FALSE,
    'anon cannot call delete_account — there is no anonymous account to delete');
  PERFORM pg_temp.ok(
    has_function_privilege('authenticated', 'public.delete_account(text)', 'EXECUTE') IS TRUE,
    'authenticated can call delete_account');

  RAISE NOTICE '--- posture OK ---';
END $$;

-- An unauthenticated caller deletes nothing at all. Asserted against a
-- census of every table the function writes to, because "it returned an
-- error" and "it deleted somebody" are not mutually exclusive.
DO $$
DECLARE
  u0 INT; p0 INT; g0 INT; d0 INT; a0 INT; l0 INT; m0 INT; r0 INT;
  u1 INT; p1 INT; g1 INT; d1 INT; a1 INT; l1 INT; m1 INT; r1 INT;
  res JSONB;
  raised BOOLEAN := FALSE;
BEGIN
  SELECT COUNT(*) INTO u0 FROM auth.users;
  SELECT COUNT(*) INTO p0 FROM public.profiles;
  SELECT COUNT(*) INTO g0 FROM public.game_sessions;
  SELECT COUNT(*) INTO d0 FROM public.duels;
  SELECT COUNT(*) INTO a0 FROM public.daily_attempts;
  SELECT COUNT(*) INTO l0 FROM public.leagues;
  SELECT COUNT(*) INTO m0 FROM public.league_members;
  SELECT COUNT(*) INTO r0 FROM public.duel_runs;
  PERFORM pg_temp.ok(u0 > 0 AND p0 > 0 AND g0 > 0 AND l0 > 0,
    'fixture: there is a populated database to fail to delete');

  PERFORM pg_temp.as_anon();
  BEGIN
    res := public.delete_account('DELETE');
    PERFORM pg_temp.ok((res->>'ok')::BOOLEAN IS NOT TRUE,
      'an unauthenticated caller does not get ok:true');
  EXCEPTION WHEN OTHERS THEN
    raised := TRUE;
    PERFORM pg_temp.ok(TRUE, 'an unauthenticated caller is refused (raised)');
  END;

  SELECT COUNT(*) INTO u1 FROM auth.users;
  SELECT COUNT(*) INTO p1 FROM public.profiles;
  SELECT COUNT(*) INTO g1 FROM public.game_sessions;
  SELECT COUNT(*) INTO d1 FROM public.duels;
  SELECT COUNT(*) INTO a1 FROM public.daily_attempts;
  SELECT COUNT(*) INTO l1 FROM public.leagues;
  SELECT COUNT(*) INTO m1 FROM public.league_members;
  SELECT COUNT(*) INTO r1 FROM public.duel_runs;

  PERFORM pg_temp.ok(u1 = u0, 'no auth.users row was deleted by a signed-out call');
  PERFORM pg_temp.ok(p1 = p0, 'no profiles row was deleted by a signed-out call');
  PERFORM pg_temp.ok(g1 = g0, 'no game_sessions row was deleted by a signed-out call');
  PERFORM pg_temp.ok(d1 = d0, 'no duels row was deleted by a signed-out call');
  PERFORM pg_temp.ok(a1 = a0, 'no daily_attempts row was deleted by a signed-out call');
  PERFORM pg_temp.ok(l1 = l0, 'no leagues row was deleted by a signed-out call');
  PERFORM pg_temp.ok(m1 = m0, 'no league_members row was deleted by a signed-out call');
  PERFORM pg_temp.ok(r1 = r0, 'no duel_runs row was deleted by a signed-out call');

  RAISE NOTICE '--- unauthenticated caller OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 6. Standing invariants, over everything this file did
--
-- "Never leave a league without an owner, and never delete a league
-- that still has members" is a property of the database, not of one
-- call, so it is asserted over the whole table after ~20 deletions.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM public.leagues g
   WHERE NOT EXISTS (SELECT 1 FROM public.league_members m WHERE m.league_id = g.id);
  PERFORM pg_temp.ok(n = 0, 'no league is left with zero members');

  SELECT COUNT(*) INTO n FROM public.leagues g
   WHERE NOT EXISTS (SELECT 1 FROM public.league_members m
                      WHERE m.league_id = g.id AND m.user_id = g.owner_id);
  PERFORM pg_temp.ok(n = 0, 'every league''s owner is one of its own members');

  SELECT COUNT(*) INTO n FROM public.leagues g
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.owner_id);
  PERFORM pg_temp.ok(n = 0, 'no league is owned by an account that no longer exists');

  SELECT COUNT(*) INTO n FROM public.league_members m
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id);
  PERFORM pg_temp.ok(n = 0, 'no league membership names an account that no longer exists');

  SELECT COUNT(*) INTO n FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);
  PERFORM pg_temp.ok(n = 0, 'no profile outlives its auth.users row');

  SELECT COUNT(*) INTO n FROM public.duels d
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = d.creator_id);
  PERFORM pg_temp.ok(n = 0, 'no duel is owned by an account that no longer exists');

  SELECT COUNT(*) INTO n FROM public.duels d
   WHERE d.opponent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = d.opponent_id);
  PERFORM pg_temp.ok(n = 0, 'no duel names an opponent account that no longer exists');

  SELECT COUNT(*) INTO n FROM public.daily_attempts a
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = a.user_id);
  PERFORM pg_temp.ok(n = 0, 'no daily attempt names an account that no longer exists');

  SELECT COUNT(*) INTO n FROM public.game_sessions s
   WHERE s.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id);
  PERFORM pg_temp.ok(n = 0, 'no game session names an account that no longer exists');

  RAISE NOTICE '--- standing invariants OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 7. A finished duel does not put its opponent side back on the market
--
-- LAST on purpose. This assertion currently FAILS, and \set
-- ON_ERROR_STOP aborts the file at the first failure — put anywhere
-- else it would mask the ~30 assertions after it. Everything above
-- this line passes.
--
-- docs/account-deletion.md §4 keeps a duel the caller played as the
-- opponent, and says the caller's run "keeps its score and loses its
-- owner — user_id is ON DELETE SET NULL, so the cascade already does
-- the right thing here, and the opponent renders as a deleted account
-- rather than vanishing mid-comparison."
--
-- The cascade nulls duels.opponent_id too, and to start_duel_run a
-- duel with a NULL opponent_id is an UNCLAIMED duel. So the finished
-- side goes back on the market: the next signed-in visitor to the
-- creator's link is handed side='opponent', adopts the existing run
-- row, and is rendered — to the creator and to themselves — as having
-- scored the deleted player's score on a duel they never played.
--
-- The opponent does not render as a deleted account. It renders as
-- whoever opened the link next.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  maker    UUID; leaver UUID; stranger UUID;
  k        TEXT; did    UUID; v JSONB;
BEGIN
  maker    := pg_temp.acct_new('acct_fin_c');
  leaver   := pg_temp.acct_new('acct_fin_o');
  stranger := pg_temp.acct_new('acct_fin_x');

  PERFORM pg_temp.acct_as(maker);
  k := (public.create_duel(120))->>'duel_key';
  SELECT id INTO did FROM public.duels WHERE duel_key = k;
  PERFORM pg_temp.acct_play(k, 11);

  PERFORM pg_temp.acct_as(leaver);
  PERFORM pg_temp.acct_play(k, 6);

  PERFORM pg_temp.ok((SELECT d.status FROM public.duels d WHERE d.id = did) = 'complete',
    'fixture: both sides played, the duel is complete');
  PERFORM pg_temp.ok(
    (SELECT rr.score FROM public.duel_runs rr
      WHERE rr.duel_id = did AND rr.side = 'opponent') = 6,
    'fixture: the opponent scored exactly 6');

  PERFORM pg_temp.acct_as(leaver);
  PERFORM pg_temp.ok((public.delete_account('acct_fin_o')->>'ok')::BOOLEAN IS TRUE,
    'fixture: the opponent deletes their account');

  -- The stranger has never seen this duel before.
  PERFORM pg_temp.acct_as(stranger);
  BEGIN
    v := public.start_duel_run(k, NULL);
  EXCEPTION WHEN OTHERS THEN
    v := NULL;   -- refusing by raising is a perfectly good refusal
  END;

  PERFORM pg_temp.ok(
    (SELECT d.opponent_id FROM public.duels d WHERE d.id = did) IS NULL,
    'a stranger cannot claim the opponent side of a FINISHED duel whose opponent was deleted');
  PERFORM pg_temp.ok(
    (SELECT rr.user_id FROM public.duel_runs rr
      WHERE rr.duel_id = did AND rr.side = 'opponent') IS NULL,
    'and cannot adopt the deleted opponent''s finished run row');

  v := public.get_duel_by_key(k, NULL);
  PERFORM pg_temp.ok(v->'opponent'->>'username' IS NULL,
    'the finished duel still renders its opponent as a deleted account, not as the stranger');

  RAISE NOTICE '--- finished-duel reclaim OK ---';
END $$;

SELECT 'ALL ACCOUNT CONTRACT TESTS PASSED' AS result;
