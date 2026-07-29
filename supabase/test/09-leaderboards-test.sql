-- Contract tests for supabase/leaderboards.sql —
-- public.get_global_board(p_scope TEXT, p_limit INTEGER).
--
-- Written against docs/leaderboards-design.md BEFORE reading the
-- implementation, so a pass means the contract holds — not that the code
-- does what it happens to do.
--
-- Runs after 08-steal-test.sql; pg_temp.ok / as_user / as_anon come from
-- 02-test.sql.
--
-- Four rules shape every assertion below.
--
--   * Never assert on non-emptiness. "Some rows came back" and "it did
--     not error" are not evidence. Every assertion names the value it
--     expects: the username at a position, the exact score on the row,
--     the exact set of JSON keys.
--
--   * Every precondition is fatal. pg_temp.ok RAISEs, so a fixture that
--     did not build what the test thinks it built dies at the setup line
--     instead of sailing on to a vacuously-true post-condition. A board
--     test whose fixture players never got a qualifying run would pass
--     most of this file while proving nothing at all.
--
--   * The database is NOT empty when this file starts. 03/04/05/07/08
--     have already written daily attempts and duel runs, and 01-seed
--     wrote game_sessions. So nothing here asserts a global row count.
--     Every fixture score is >= 4900 — two orders of magnitude above any
--     score a real 120-second run in this database has — which makes the
--     top of every board deterministic no matter what ran before.
--
--   * Time is set, never waited for. submitted_at is written directly, so
--     "today", "six days ago" and the tie-break ordering are exact rather
--     than dependent on how long the suite takes.
--
-- ── The fixture, in one table ───────────────────────────────────────
--
--   player       run(s)                                    today  all_time
--   ──────────────────────────────────────────────────────────────────────
--   lbdaily1     daily attempt today, 5700                  5700     5700
--   lbmulti      daily 5200 + duel 120s 5600 + duel 120s
--                5100 today, duel 120s 6400 five days ago   5600     6400
--   lbtiea       duel 120s 5500 today, submitted 20m ago     5500     5500
--   lbtieb       duel 120s 5500 today, submitted  5m ago     5500     5500
--   lbprivate    daily attempt today, 5400, is_public FALSE  5400     5400
--   lbslow       duel 300s 6800 + duel 120s 5300 today       5300     5300
--   lbforge      duel 120s 4900 today, plus DEFAULT-config
--                solo runs of 9997 today and 9995 three
--                days ago — unverified, and ranking          9997     9997
--   lbsolo       solo 120s default 5350 today                5350     5350
--   lbsoloold    solo 120s default 5150 five days ago       absent    5150
--   lbold        duel 120s 6100 six days ago                absent    6100
--   lbonly300    duel 300s 6900 today                       absent   absent
--   lbnoname     duel 120s 6600 today, NO profile row       absent   absent
--   lbunfin      duel 120s 6500 today, status in_progress   absent   absent
--   lbnodaily    daily attempt today, in_progress, no score absent   absent
--   lbnocfg      solo 120s 9700 today, config_key NULL      absent   absent
--   lbsolo300    solo 300s 9600 today                       absent   absent
--   (a guest)    duel 120s 7777 today, user_id NULL         absent   absent
--   hexadecimal  its real daily attempt, plus a CUSTOM-config
--                solo run of 9999                          real daily score
--   lb001..lb130 duel 120s 1001..1130 today            enough players that
--                                                      the limit clamp bites
--
-- Scores that must appear on NO board, at any scope: 9999 (custom
-- config), 9700 (no config), 9600 and 6900 and 6800 (300-second runs),
-- 6600 (no username), 6500 (unsubmitted), 7777 (a guest, no username).
--
-- 9997 and 9995 DO appear, on 'today' and 'all_time' and never on
-- 'daily'. They are numbers a client reported and nothing checked. See
-- §1 before reading that as a bug.

\set ON_ERROR_STOP on
SET client_min_messages = NOTICE;

-- ════════════════════════════════════════════════════════════════
-- Helpers
-- ════════════════════════════════════════════════════════════════

-- An account. NULL username means no profiles row at all — profiles.username
-- is NOT NULL, so "a player with no username" can only mean a player with no
-- profile, which is exactly what an unfinished sign-up leaves behind.
CREATE OR REPLACE FUNCTION pg_temp.lb_user(p_username TEXT, p_public BOOLEAN DEFAULT TRUE)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE uid UUID;
BEGIN
  INSERT INTO auth.users (email)
  VALUES (COALESCE(p_username, 'lbnobody') || '@lb.test')
  RETURNING id INTO uid;
  PERFORM pg_temp.ok(uid IS NOT NULL, 'fixture: created an auth user for ' || COALESCE(p_username, '(no profile)'));

  IF p_username IS NOT NULL THEN
    INSERT INTO public.profiles (id, username, is_public) VALUES (uid, p_username, p_public);
    PERFORM pg_temp.ok(
      (SELECT COUNT(*) FROM public.profiles WHERE id = uid AND username = p_username) = 1,
      'fixture: ' || p_username || ' has exactly one profile');
  ELSE
    PERFORM pg_temp.ok((SELECT COUNT(*) FROM public.profiles WHERE id = uid) = 0,
      'fixture: the no-username player has no profile row');
  END IF;
  RETURN uid;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.lb_uid(p_username TEXT)
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT id FROM public.profiles WHERE username = p_username;
$$;

-- A server-scored duel run: one duel of p_duration seconds and a finished
-- creator-side run on it. The opponent side is a guest so the duel is a
-- real two-sided game rather than an orphan; that guest run has user_id
-- NULL and therefore no username, which is itself a case the board has to
-- skip.
--
-- Written straight into the tables on purpose. duel_runs is unreachable
-- from any client (RLS on, no policies, grants revoked) — the server writes
-- it, and a fixture standing in for the server is the honest way to place a
-- known score at a known instant.
CREATE OR REPLACE FUNCTION pg_temp.lb_duel_run(
  p_user     UUID,
  p_duration INTEGER,
  p_score    INTEGER,
  p_at       TIMESTAMPTZ,
  p_status   TEXT    DEFAULT 'complete',
  p_guest    INTEGER DEFAULT 1)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_key TEXT; v_id UUID; n INT;
BEGIN
  v_key := 'lb' || substr(md5(random()::TEXT || clock_timestamp()::TEXT), 1, 12);

  INSERT INTO public.duels
    (duel_key, creator_id, opponent_guest_token, config, duration_seconds,
     questions, status, created_at, expires_at)
  VALUES
    (v_key, p_user, 'lbguest-' || v_key,
     jsonb_build_object('duration', p_duration), p_duration,
     '[]'::JSONB, 'complete', p_at - INTERVAL '1 hour', p_at + INTERVAL '2 days')
  RETURNING id INTO v_id;
  PERFORM pg_temp.ok(v_id IS NOT NULL, 'fixture: a ' || p_duration || 's duel exists');

  INSERT INTO public.duel_runs
    (duel_id, side, user_id, guest_token, started_at, submitted_at, score, answers, status)
  VALUES
    (v_id, 'creator', p_user, NULL,
     p_at - (p_duration || ' seconds')::INTERVAL,
     CASE WHEN p_status = 'complete' THEN p_at END,
     p_score, '[]'::JSONB, p_status);

  -- The guest opponent, always finished, so the duel is complete on both
  -- sides and nothing here depends on an implementation choosing to ignore
  -- half-played duels.
  INSERT INTO public.duel_runs
    (duel_id, side, user_id, guest_token, started_at, submitted_at, score, answers, status)
  VALUES
    (v_id, 'opponent', NULL, 'lbguest-' || v_key,
     p_at - (p_duration || ' seconds')::INTERVAL, p_at, p_guest, '[]'::JSONB, 'complete');

  SELECT COUNT(*) INTO n FROM public.duel_runs WHERE duel_id = v_id;
  PERFORM pg_temp.ok(n = 2,
    'fixture: the ' || p_duration || 's duel has two runs, the player at ' || p_score);
  SELECT COUNT(*) INTO n FROM public.duel_runs
   WHERE duel_id = v_id AND side = 'creator' AND score = p_score AND status = p_status;
  PERFORM pg_temp.ok(n = 1,
    'fixture: the player''s run is stored at ' || p_score || ' / ' || p_status);
  RETURN v_id;
END $$;

-- A daily attempt on TODAY's puzzle, at a chosen score and instant.
CREATE OR REPLACE FUNCTION pg_temp.lb_daily(
  p_user   UUID,
  p_score  INTEGER,
  p_at     TIMESTAMPTZ,
  p_status TEXT DEFAULT 'complete')
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE n INT;
BEGIN
  INSERT INTO public.daily_attempts
    (puzzle_date, user_id, started_at, submitted_at, score, answers, status)
  VALUES
    (public.daily_today(), p_user, p_at - INTERVAL '120 seconds',
     CASE WHEN p_status = 'complete' THEN p_at END,
     CASE WHEN p_status = 'complete' THEN p_score END,
     '[]'::JSONB, p_status);

  SELECT COUNT(*) INTO n FROM public.daily_attempts
   WHERE user_id = p_user AND puzzle_date = public.daily_today() AND status = p_status;
  PERFORM pg_temp.ok(n = 1, 'fixture: a ' || p_status || ' daily attempt exists');
END $$;

-- ── Reading a board ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp.brows(v JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v->'rows') = 'array' THEN v->'rows' ELSE '[]'::JSONB END;
$$;

-- How many rows carry this username. 1 is the answer almost everywhere,
-- and 0 is the answer for everyone who must not be on the board.
CREATE OR REPLACE FUNCTION pg_temp.bcount(v JSONB, p_username TEXT)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT COUNT(*)::INT FROM jsonb_array_elements(pg_temp.brows(v)) e
   WHERE e->>'username' = p_username;
$$;

CREATE OR REPLACE FUNCTION pg_temp.bscore(v JSONB, p_username TEXT)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT (e->>'score')::INT FROM jsonb_array_elements(pg_temp.brows(v)) e
   WHERE e->>'username' = p_username LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION pg_temp.brank(v JSONB, p_username TEXT)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT (e->>'rank')::INT FROM jsonb_array_elements(pg_temp.brows(v)) e
   WHERE e->>'username' = p_username LIMIT 1;
$$;

-- 0-based position in the array. The array order is what the client
-- renders, so the tie-break is asserted here as well as on `rank`.
CREATE OR REPLACE FUNCTION pg_temp.bpos(v JSONB, p_username TEXT)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT (ord - 1)::INT FROM jsonb_array_elements(pg_temp.brows(v))
         WITH ORDINALITY x(e, ord)
   WHERE e->>'username' = p_username LIMIT 1;
$$;

-- Does ANY row carry this score? The forged-score assertions are all of
-- this shape: the number must not exist on the board under any name.
CREATE OR REPLACE FUNCTION pg_temp.bhas_score(v JSONB, p_score INT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(pg_temp.brows(v)) e
     WHERE jsonb_typeof(e->'score') = 'number' AND (e->>'score')::INT = p_score);
$$;

CREATE OR REPLACE FUNCTION pg_temp.blen(v JSONB)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_array_length(pg_temp.brows(v));
$$;

-- The username at a 0-based position, so a whole prefix can be pinned.
CREATE OR REPLACE FUNCTION pg_temp.bname_at(v JSONB, p_i INT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.brows(v)->p_i->>'username';
$$;

CREATE OR REPLACE FUNCTION pg_temp.bscore_at(v JSONB, p_i INT)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT (pg_temp.brows(v)->p_i->>'score')::INT;
$$;

-- Every key that appears ANYWHERE in the document, at any depth. Walking
-- it is the only way to assert "no identifier in the payload" — reading
-- the top level would miss a user_id tucked inside a row, and eyeballing
-- one sample row would miss one that only some rows carry.
CREATE OR REPLACE FUNCTION pg_temp.jkeys(v JSONB)
RETURNS TEXT[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k TEXT; el JSONB; acc TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v IS NULL THEN RETURN acc; END IF;
  IF jsonb_typeof(v) = 'object' THEN
    FOR k, el IN SELECT key, value FROM jsonb_each(v) LOOP
      acc := acc || k || pg_temp.jkeys(el);
    END LOOP;
  ELSIF jsonb_typeof(v) = 'array' THEN
    FOR el IN SELECT value FROM jsonb_array_elements(v) LOOP
      acc := acc || pg_temp.jkeys(el);
    END LOOP;
  END IF;
  RETURN acc;
END $$;

-- A solo run: one game_sessions row, written the way the browser writes
-- it. p_cfg is the stored settings — pass daily_default_config() for a
-- qualifying run, anything else for a custom game, NULL for a session
-- with no config_key at all (which the client never writes, and which
-- the board must therefore refuse rather than assume about).
--
-- The score is a number handed over by the client. Nothing recomputes
-- it, here or in production; that is the whole point of the source and
-- the reason it is worth a helper of its own.
CREATE OR REPLACE FUNCTION pg_temp.lb_solo(
  p_user     UUID,
  p_duration INTEGER,
  p_score    INTEGER,
  p_at       TIMESTAMPTZ,
  p_cfg      JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_ckey TEXT; v_skey TEXT; n INT;
BEGIN
  v_skey := 'lbs' || substr(md5(random()::TEXT || clock_timestamp()::TEXT), 1, 12);
  IF p_cfg IS NOT NULL THEN
    v_ckey := substr(md5(p_cfg::TEXT), 1, 12);
    INSERT INTO public.game_configs (key, config)
    VALUES (v_ckey, p_cfg)
    ON CONFLICT (key) DO UPDATE SET config = EXCLUDED.config;
  END IF;

  INSERT INTO public.game_sessions
    (session_key, user_id, config_key, score, duration_seconds, questions, created_at)
  VALUES (v_skey, p_user, v_ckey, p_score, p_duration, '[]'::JSONB, p_at);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 1, 'fixture: a solo run of ' || p_score || ' at '
    || p_duration || 's' || CASE WHEN p_cfg IS NULL THEN ', no config' ELSE '' END);
  RETURN v_skey;
END $$;

-- The settings a solo run has to have been played on to qualify. Read
-- from the function the boards read, not copied — a literal here would
-- pass forever if daily_default_config() ever changed underneath it,
-- while the product's real sessions stopped matching.
CREATE OR REPLACE FUNCTION pg_temp.lb_std_cfg()
RETURNS JSONB LANGUAGE sql STABLE AS $$ SELECT public.daily_default_config(); $$;

-- ════════════════════════════════════════════════════════════════
-- 0. Fixtures
--
-- Every insert is checked. A suite in this repo once reported PASS on a
-- membership cap because its setup had silently skipped most of the users
-- it thought it created.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_now   TIMESTAMPTZ := NOW();
  uid     UUID;
  i       INT;
  n       INT;
BEGIN
  -- Near UTC midnight, "twenty minutes ago" is yesterday and every
  -- "today" assertion below means something different. Say so rather
  -- than fail somewhere confusing.
  PERFORM pg_temp.ok(
    ((v_now - INTERVAL '30 minutes') AT TIME ZONE 'UTC')::DATE = public.daily_today(),
    'fixture: the last 30 minutes are all inside today (re-run if this suite started at UTC midnight)');

  -- ── Today's puzzle, created the way the product creates it ─────
  uid := pg_temp.lb_user('lbdaily1');
  PERFORM pg_temp.as_user('lbdaily1');
  PERFORM public.start_daily();
  UPDATE public.daily_attempts
     SET status = 'complete', score = 5700,
         started_at = v_now - INTERVAL '15 minutes',
         submitted_at = v_now - INTERVAL '13 minutes'
   WHERE user_id = uid AND puzzle_date = public.daily_today();
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 1, 'fixture: lbdaily1 has a complete daily attempt at 5700');

  PERFORM pg_temp.ok(
    (SELECT duration_seconds FROM public.daily_puzzles
      WHERE puzzle_date = public.daily_today()) = 120,
    'fixture: today''s daily puzzle is a 120-second puzzle');

  -- ── The multi-run player ───────────────────────────────────────
  uid := pg_temp.lb_user('lbmulti');
  PERFORM pg_temp.lb_daily(uid, 5200, v_now - INTERVAL '12 minutes');
  PERFORM pg_temp.lb_duel_run(uid, 120, 5600, v_now - INTERVAL '10 minutes');
  PERFORM pg_temp.lb_duel_run(uid, 120, 5100, v_now - INTERVAL '9 minutes');
  PERFORM pg_temp.lb_duel_run(uid, 120, 6400, v_now - INTERVAL '5 days');

  -- ── The tie ────────────────────────────────────────────────────
  uid := pg_temp.lb_user('lbtiea');
  PERFORM pg_temp.lb_duel_run(uid, 120, 5500, v_now - INTERVAL '20 minutes');
  uid := pg_temp.lb_user('lbtieb');
  PERFORM pg_temp.lb_duel_run(uid, 120, 5500, v_now - INTERVAL '5 minutes');

  -- ── The private profile ────────────────────────────────────────
  uid := pg_temp.lb_user('lbprivate', FALSE);
  PERFORM pg_temp.ok(
    (SELECT is_public FROM public.profiles WHERE id = uid) IS FALSE,
    'fixture: lbprivate''s profile really is private');
  PERFORM pg_temp.lb_daily(uid, 5400, v_now - INTERVAL '11 minutes');

  -- ── Duration ───────────────────────────────────────────────────
  uid := pg_temp.lb_user('lbslow');
  PERFORM pg_temp.lb_duel_run(uid, 300, 6800, v_now - INTERVAL '8 minutes');
  PERFORM pg_temp.lb_duel_run(uid, 120, 5300, v_now - INTERVAL '7 minutes');
  uid := pg_temp.lb_user('lbonly300');
  PERFORM pg_temp.lb_duel_run(uid, 300, 6900, v_now - INTERVAL '6 minutes');

  -- ── Solo runs, the unverified source ───────────────────────────
  -- game_sessions is written directly by the client under
  --   WITH CHECK (auth.uid() = user_id OR user_id IS NULL)
  -- and the anon key is public, so every row below is one POST away for
  -- anybody, at any score they choose. The boards rank them anyway —
  -- see §1 and docs/leaderboards-design.md. These fixtures exist to pin
  -- WHICH of them rank, because that is the part a change can break.

  -- lbforge scores 9997 today on the default settings, with a real
  -- server-scored duel run at 4900 underneath it. Both numbers are on
  -- the board; the one that ranks is the higher, and it is the one
  -- nothing checked.
  uid := pg_temp.lb_user('lbforge');
  PERFORM pg_temp.lb_duel_run(uid, 120, 4900, v_now - INTERVAL '4 minutes');
  PERFORM pg_temp.lb_solo(uid, 120, 9997, v_now,                       pg_temp.lb_std_cfg());
  PERFORM pg_temp.lb_solo(uid, 120, 9995, v_now - INTERVAL '3 days',   pg_temp.lb_std_cfg());

  -- An ordinary player whose only run is a solo game, at a score that
  -- sits in the middle of the board rather than on top of it: the case
  -- the change was actually asked for.
  uid := pg_temp.lb_user('lbsolo');
  PERFORM pg_temp.lb_solo(uid, 120, 5350, v_now - INTERVAL '9 minutes', pg_temp.lb_std_cfg());

  -- The same, five days ago: absent from today, present all-time.
  uid := pg_temp.lb_user('lbsoloold');
  PERFORM pg_temp.lb_solo(uid, 120, 5150, v_now - INTERVAL '5 days',    pg_temp.lb_std_cfg());

  -- Comparability, three ways it fails. None of these is cheating and
  -- none of them ranks.
  --
  -- A custom config — 120 seconds of one-digit addition, which scores
  -- several times the default. Attributed to a seeded account so the
  -- rule is shown holding against a real player rather than a fixture.
  PERFORM pg_temp.lb_solo(pg_temp.lb_uid('hexadecimal'), 120, 9999, v_now,
    jsonb_build_object('operations', jsonb_build_array('addition'),
                       'addMin1', 2, 'addMax1', 9,
                       'addMin2', 2, 'addMax2', 9,
                       'mulMin1', 2, 'mulMax1', 12,
                       'mulMin2', 2, 'mulMax2', 100,
                       'duration', 120));

  -- No config_key at all. index.html always writes one, so this row can
  -- only come from something that is not the product; it must fail
  -- closed rather than be assumed to be a default game.
  uid := pg_temp.lb_user('lbnocfg');
  PERFORM pg_temp.lb_solo(uid, 120, 9700, v_now, NULL);

  -- A 300-second solo game. Its config says duration 300, so it fails
  -- the settings rule and the duration rule independently.
  uid := pg_temp.lb_user('lbsolo300');
  PERFORM pg_temp.lb_solo(uid, 300, 9600, v_now,
    jsonb_set(pg_temp.lb_std_cfg(), '{duration}', '300'::JSONB));

  PERFORM pg_temp.ok(
    (SELECT COUNT(*) FROM public.game_sessions WHERE score = 9999
       AND user_id = pg_temp.lb_uid('hexadecimal')) = 1,
    'fixture: a custom-config 9999 game_sessions row is attributed to hexadecimal');
  PERFORM pg_temp.ok(
    (SELECT gc.config FROM public.game_sessions g
       JOIN public.game_configs gc ON gc.key = g.config_key
      WHERE g.user_id = uid AND g.score = 9600) IS DISTINCT FROM pg_temp.lb_std_cfg(),
    'fixture: the 300-second solo game really is on a non-default config');

  -- ── Yesterday's man ────────────────────────────────────────────
  uid := pg_temp.lb_user('lbold');
  PERFORM pg_temp.lb_duel_run(uid, 120, 6100, v_now - INTERVAL '6 days');

  -- ── No username at all ─────────────────────────────────────────
  uid := pg_temp.lb_user(NULL);
  PERFORM pg_temp.lb_duel_run(uid, 120, 6600, v_now - INTERVAL '3 minutes');

  -- ── Runs that are not results ──────────────────────────────────
  -- An unsubmitted run has no submitted_at to rank on and no finished
  -- score to claim, whatever number is sitting in the column.
  uid := pg_temp.lb_user('lbunfin');
  PERFORM pg_temp.lb_duel_run(uid, 120, 6500, v_now - INTERVAL '2 minutes', 'in_progress');
  uid := pg_temp.lb_user('lbnodaily');
  PERFORM pg_temp.lb_daily(uid, NULL, v_now - INTERVAL '2 minutes', 'in_progress');

  -- ── A guest with a huge score ──────────────────────────────────
  -- user_id NULL: nobody to name, so nothing to show.
  uid := pg_temp.lb_user('lbguesthost');
  PERFORM pg_temp.lb_duel_run(uid, 120, 10, v_now - INTERVAL '1 minute', 'complete', 7777);

  -- ── Enough players that a clamp is observable ──────────────────
  FOR i IN 1..130 LOOP
    uid := pg_temp.lb_user('lbbulk' || i);
    PERFORM pg_temp.lb_duel_run(uid, 120, 1000 + i, v_now - INTERVAL '30 minutes');
  END LOOP;

  SELECT COUNT(*) INTO n FROM public.profiles WHERE username LIKE 'lbbulk%';
  PERFORM pg_temp.ok(n = 130, 'fixture: all 130 bulk players exist — the clamp test needs every one');
  SELECT COUNT(DISTINCT r.user_id) INTO n
    FROM public.duel_runs r JOIN public.duels d ON d.id = r.duel_id
    JOIN public.profiles p ON p.id = r.user_id
   WHERE d.duration_seconds = 120 AND r.status = 'complete' AND r.score IS NOT NULL
     AND p.username LIKE 'lbbulk%';
  PERFORM pg_temp.ok(n = 130, 'fixture: and all 130 have a finished 120-second run');

  RAISE NOTICE '--- fixtures OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 1. WHICH SOURCES REACH WHICH BOARD
--
-- The assertion the whole feature turns on, and therefore the first one
-- in the file. It runs in both directions, because both directions are
-- load-bearing:
--
--   * a solo game_sessions run RANKS on 'today' and 'all_time';
--   * it does NOT rank on 'daily', which stays the daily alone;
--   * a solo run on non-default settings ranks nowhere.
--
-- READ THIS BEFORE TAKING THE PASS AS REASSURANCE. game_sessions is
-- written straight from the browser, the anon key is public, and the
-- server never generated the questions — so the 9997 below is a number
-- somebody typed, and the board is asserted to show it. That is the
-- accepted cost recorded in docs/leaderboards-design.md, not an
-- oversight, and this test passing is not evidence that any score on
-- these two boards was checked. Nothing here can be: verification would
-- mean the server issuing the questions, which is the TODO item that
-- makes this section obsolete.
--
-- lbforge has BOTH a real server-scored duel run at 4900 and an
-- unverified 9997, which is what lets the test say something precise:
-- the higher of the two ranks, and it is the unverified one.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE d JSONB; t JSONB; a JSONB;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');
  d := public.get_global_board('daily',    100);
  t := public.get_global_board('today',    100);
  a := public.get_global_board('all_time', 100);

  -- The daily board is the one that cannot be forged, and that is the
  -- property being pinned here: none of these numbers reaches it.
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(d, 9997),
    'a solo run does not reach the daily board — that board is daily_attempts alone');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(d, 9995), 'nor a backdated one');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(d, 5350), 'nor an ordinary player''s solo run');
  PERFORM pg_temp.ok(pg_temp.bcount(d, 'lbsolo') = 0,
    'a player whose only run is solo is absent from the daily board entirely');

  -- ...and on the other two, it ranks.
  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbsolo') = 1, 'a solo run IS on today''s board');
  PERFORM pg_temp.ok(pg_temp.bscore(t, 'lbsolo') = 5350, 'at the 5350 the client reported');
  PERFORM pg_temp.ok(pg_temp.bcount(a, 'lbsolo') = 1, 'and on the all-time board');
  PERFORM pg_temp.ok(pg_temp.bscore(a, 'lbsolo') = 5350, 'also at 5350');

  -- A solo run from five days ago: gone from today, still all-time.
  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbsoloold') = 0,
    'a five-day-old solo run is not on today''s board');
  PERFORM pg_temp.ok(pg_temp.bscore(a, 'lbsoloold') = 5150,
    'and is still on the all-time board at 5150');

  -- The unverified number beats the verified one, which is the cost.
  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbforge') = 1, 'lbforge is on today''s board exactly once');
  PERFORM pg_temp.ok(pg_temp.bscore(t, 'lbforge') = 9997,
    'at the 9997 nothing checked, not the 4900 the server computed — the accepted cost, asserted');
  PERFORM pg_temp.ok(pg_temp.bcount(a, 'lbforge') = 1, 'and on the all-time board exactly once');
  PERFORM pg_temp.ok(pg_temp.bscore(a, 'lbforge') = 9997,
    'at 9997 there too, their best of the two solo runs and the duel run');

  -- Comparability is NOT relaxed. These are the runs that rank nowhere.
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 9999),
    'a custom-config solo run does not rank, however high it scored');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(a, 9999), 'nor on the all-time board');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(d, 9999), 'nor on the daily board');

  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 9700),
    'a solo run with no config_key does not rank — it fails closed');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(a, 9700), 'nor on the all-time board');
  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbnocfg') = 0, 'and its player is absent');

  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 9600), 'a 300-second solo run does not rank');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(a, 9600), 'nor on the all-time board');
  PERFORM pg_temp.ok(pg_temp.bcount(a, 'lbsolo300') = 0, 'and its player is absent');

  RAISE NOTICE '--- source eligibility OK (solo runs rank, and are unverified) ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 2. The envelope
--
-- {scope, duration_seconds, generated_at, rows}. A client is built
-- against these four names, so they are part of the contract.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE v JSONB; s TEXT;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');

  FOREACH s IN ARRAY ARRAY['daily', 'today', 'all_time'] LOOP
    v := public.get_global_board(s, 10);
    PERFORM pg_temp.ok(v IS NOT NULL, s || ': returns a payload');
    PERFORM pg_temp.ok(NOT (v ? 'error'), s || ': a valid scope is not an error');
    PERFORM pg_temp.ok(v->>'scope' = s, s || ': the scope is echoed back verbatim');
    PERFORM pg_temp.ok((v->>'duration_seconds')::INT = 120,
      s || ': the board says it is the 120-second board');
    PERFORM pg_temp.ok(jsonb_typeof(v->'rows') = 'array', s || ': rows is an array');
    PERFORM pg_temp.ok(v ? 'generated_at', s || ': carries generated_at');
    PERFORM pg_temp.ok(
      (v->>'generated_at')::TIMESTAMPTZ BETWEEN NOW() - INTERVAL '5 minutes'
                                            AND NOW() + INTERVAL '5 minutes',
      s || ': generated_at is a timestamp of now, not a placeholder');
  END LOOP;

  RAISE NOTICE '--- envelope OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 3. One row per player, at their best
--
-- lbmulti has four qualifying runs. Today's best is the 5600 duel — not
-- the 5200 daily, not the 5100 duel, and not the 6400 from five days ago,
-- which is the all-time best and must not leak into today.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE t JSONB; a JSONB; dupes INT;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');
  t := public.get_global_board('today',    100);
  a := public.get_global_board('all_time', 100);

  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbmulti') = 1,
    'four qualifying runs produce ONE row on today''s board');
  PERFORM pg_temp.ok(pg_temp.bscore(t, 'lbmulti') = 5600,
    'and it is today''s best of them, 5600');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 5200),
    'the same player''s weaker daily 5200 is not a second row');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 5100),
    'nor their weaker duel 5100');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 6400),
    'and five days ago''s 6400 is not on TODAY''s board at all');

  PERFORM pg_temp.ok(pg_temp.bcount(a, 'lbmulti') = 1,
    'one row on the all-time board too');
  PERFORM pg_temp.ok(pg_temp.bscore(a, 'lbmulti') = 6400,
    'at their all-time best of 6400');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(a, 5600),
    'their second-best never displaces somebody else');

  -- The date filter, from the other side: lbold has one run, six days
  -- old. Absent from today, present all-time.
  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbold') = 0,
    'a player whose only run was six days ago is not on today''s board');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 6100), 'and their 6100 is nowhere on it');
  PERFORM pg_temp.ok(pg_temp.bcount(a, 'lbold') = 1, 'but they are on the all-time board');
  PERFORM pg_temp.ok(pg_temp.bscore(a, 'lbold') = 6100, 'at 6100');

  -- Not just the fixtures: NO username repeats anywhere on either board.
  SELECT pg_temp.blen(t) - COUNT(DISTINCT e->>'username')::INT INTO dupes
    FROM jsonb_array_elements(pg_temp.brows(t)) e;
  PERFORM pg_temp.ok(dupes = 0, 'no username appears twice on today''s board');
  SELECT pg_temp.blen(a) - COUNT(DISTINCT e->>'username')::INT INTO dupes
    FROM jsonb_array_elements(pg_temp.brows(a)) e;
  PERFORM pg_temp.ok(dupes = 0, 'no username appears twice on the all-time board');

  -- An unsubmitted run is not a result, whatever is in its score column.
  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbunfin') = 0,
    'a run still in progress does not rank on today''s board');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 6500), 'and its 6500 appears nowhere');
  PERFORM pg_temp.ok(pg_temp.bcount(a, 'lbunfin') = 0, 'nor on the all-time board');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(a, 6500), 'nor there');

  RAISE NOTICE '--- one row per player, at their best OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 4. The 120-second restriction
--
-- "A 300-second run is not a better result, it is a longer one." Duels
-- run 15–600 seconds; only 120 is comparable.
--
-- Two cases, because they fail differently: lbslow has BOTH a 300s 6800
-- and a 120s 5300, so an implementation that ranks the player by their
-- best run of any length shows 6800 here. lbonly300 has nothing else, so
-- an implementation that filters the player rather than the run shows
-- them anyway with whatever it can find.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE t JSONB; a JSONB;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');
  t := public.get_global_board('today',    100);
  a := public.get_global_board('all_time', 100);

  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbslow') = 1,
    'a player with a 300s run and a 120s run is on today''s board once');
  PERFORM pg_temp.ok(pg_temp.bscore(t, 'lbslow') = 5300,
    'at their 120-second 5300, not their 300-second 6800');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 6800),
    'a higher score from a 300-second run does not rank');
  PERFORM pg_temp.ok(pg_temp.bscore(a, 'lbslow') = 5300, 'all-time agrees: 5300');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(a, 6800), 'and 6800 is not there either');

  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbonly300') = 0,
    'a player whose only run was 300 seconds is not on today''s board at all');
  PERFORM pg_temp.ok(pg_temp.bcount(a, 'lbonly300') = 0, 'nor the all-time board');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 6900), 'and their 6900 is on neither');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(a, 6900), 'confirmed all-time');

  RAISE NOTICE '--- the 120-second restriction OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 5. `daily` ranks the daily, by the SAME rules as the other two boards
--
-- An earlier draft of the design said this board was get_daily_leaderboard
-- projected, and this section asserted the two matched row for row. That
-- reading is superseded and the assertion has been replaced, because the
-- two functions cannot both be right:
--
--   get_daily_leaderboard uses RANK() and lets tied players share a rank.
--   It also LEFT JOINs profiles, so it can emit a row with a null username.
--
--   get_global_board numbers with ROW_NUMBER(), breaks ties on the earlier
--   submission, and drops the unnamed before ranking and before the limit.
--
-- Three tabs of one page must not number ties differently, so the daily
-- board follows the global rules and get_daily_leaderboard keeps its own
-- for its own caller, the daily page.
--
-- The old assertion passed only because this fixture happened to have no
-- tie and no unnamed player on the daily. Both are added below, so the
-- section now fails if the daily board is ever reverted to a projection.
-- ════════════════════════════════════════════════════════════════

-- The fixture this section needs, and that the superseded assertion did
-- not have: a tie on the daily, and an unnamed player holding the top
-- daily score. Both scores are chosen to sit outside the top rows pinned
-- by section 10 — the tie at the very bottom, the unnamed one dropped
-- from every board by the rule under test — so this adds a case without
-- moving anybody else's rank.
DO $$
DECLARE uid UUID; v_now TIMESTAMPTZ := NOW(); n INT;
BEGIN
  -- Two players, the same daily score, twenty minutes apart.
  uid := pg_temp.lb_user('lbdtiea');
  PERFORM pg_temp.as_user('lbdtiea');
  PERFORM public.start_daily();
  UPDATE public.daily_attempts
     SET status = 'complete', score = 100,
         started_at = v_now - INTERVAL '25 minutes',
         submitted_at = v_now - INTERVAL '24 minutes'
   WHERE user_id = uid AND puzzle_date = public.daily_today();
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 1, 'fixture: lbdtiea has a complete daily attempt at 100');

  uid := pg_temp.lb_user('lbdtieb');
  PERFORM pg_temp.as_user('lbdtieb');
  PERFORM public.start_daily();
  UPDATE public.daily_attempts
     SET status = 'complete', score = 100,
         started_at = v_now - INTERVAL '5 minutes',
         submitted_at = v_now - INTERVAL '4 minutes'
   WHERE user_id = uid AND puzzle_date = public.daily_today();
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 1, 'fixture: lbdtieb has the same score, submitted 20 minutes later');

  -- And an account that never picked a username, holding what would
  -- otherwise be the top score of the day. start_daily needs only
  -- auth.uid(), and nothing creates a profiles row, so this is reachable.
  uid := pg_temp.lb_user(NULL);
  PERFORM set_config('request.jwt.claim.sub', uid::TEXT, TRUE);
  PERFORM public.start_daily();
  UPDATE public.daily_attempts
     SET status = 'complete', score = 9500,
         started_at = v_now - INTERVAL '20 minutes',
         submitted_at = v_now - INTERVAL '19 minutes'
   WHERE user_id = uid AND puzzle_date = public.daily_today();
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 1, 'fixture: an account with no username tops today''s daily at 9500');
END $$;

DO $$
DECLARE g JSONB; d JSONB; gp JSONB; dp JSONB; unnamed INT;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');
  g := public.get_global_board('daily', 100);
  d := public.get_daily_leaderboard(public.daily_today(), 100);

  PERFORM pg_temp.ok(d IS NOT NULL, 'fixture: get_daily_leaderboard answers for today');

  -- get_daily_leaderboard LEFT JOINs profiles, so the unnamed player is
  -- on ITS board. That is the precondition for everything below: if this
  -- is 0 the fixture did not build and the assertions are vacuous.
  SELECT COUNT(*)::INT INTO unnamed
    FROM jsonb_array_elements(d->'rows') e WHERE e->>'username' IS NULL;
  PERFORM pg_temp.ok(unnamed = 1,
    'fixture: the raw daily leaderboard carries one unnamed row, so there is something to drop');

  -- The rules the global board applies and get_daily_leaderboard does not.
  PERFORM pg_temp.ok(
    (SELECT COUNT(*) FROM jsonb_array_elements(pg_temp.brows(g)) e
      WHERE e->>'username' IS NULL) = 0,
    'the global daily board carries no unnamed row');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(g, 9500),
    'and not the unnamed player''s 9500 either, though it is the top score of the day');
  PERFORM pg_temp.ok(
    ((pg_temp.brows(g)->0)->>'rank')::INT = 1,
    'so the board opens at rank 1, not at 2 with a hole where they were');

  -- Ties: numbered, not shared, earlier submission first.
  PERFORM pg_temp.ok(pg_temp.brank(g, 'lbdtiea') + 1 = pg_temp.brank(g, 'lbdtieb'),
    'tied players take consecutive ranks rather than sharing one');
  PERFORM pg_temp.ok(pg_temp.brank(g, 'lbdtiea') < pg_temp.brank(g, 'lbdtieb'),
    'and the earlier submission holds the higher rank');
  PERFORM pg_temp.ok(
    (SELECT COUNT(*) = COUNT(DISTINCT e->>'rank')
       FROM jsonb_array_elements(pg_temp.brows(g)) e),
    'no rank appears twice anywhere on the daily board');

  -- Specific values first: an equality between two arrays proves nothing
  -- if both are empty or both are wrong in the same way.
  PERFORM pg_temp.ok(pg_temp.bname_at(g, 0) = 'lbdaily1', 'the daily board is topped by lbdaily1');
  PERFORM pg_temp.ok(pg_temp.bscore_at(g, 0) = 5700,      'with 5700');
  PERFORM pg_temp.ok(pg_temp.brank(g, 'lbdaily1') = 1,    'at rank 1');
  PERFORM pg_temp.ok(pg_temp.bname_at(g, 1) = 'lbprivate', 'then lbprivate');
  PERFORM pg_temp.ok(pg_temp.bscore_at(g, 1) = 5400,       'with 5400');
  PERFORM pg_temp.ok(pg_temp.bname_at(g, 2) = 'lbmulti',   'then lbmulti');
  PERFORM pg_temp.ok(pg_temp.bscore_at(g, 2) = 5200,
    'with their DAILY 5200 — the daily board ranks the daily, not their best run of the day');
  PERFORM pg_temp.ok(pg_temp.blen(g) >= 4,
    'and the daily board carries the earlier suites'' players too, so the comparison is not trivial');

  -- The two functions must NOT agree once a tie or an unnamed player
  -- exists, and this fixture now has both. gp/dp are the same projection
  -- as before; the assertion on them is inverted.
  SELECT jsonb_agg(jsonb_build_object('rank', e->'rank', 'username', e->'username',
                                      'score', e->'score') ORDER BY ord)
    INTO gp FROM jsonb_array_elements(pg_temp.brows(g)) WITH ORDINALITY x(e, ord);
  SELECT jsonb_agg(jsonb_build_object('rank', e->'rank', 'username', e->'username',
                                      'score', e->'score') ORDER BY ord)
    INTO dp FROM jsonb_array_elements(d->'rows') WITH ORDINALITY x(e, ord);
  PERFORM pg_temp.ok(gp IS DISTINCT FROM dp,
    'the daily board is NOT get_daily_leaderboard projected — it applies the global rules');

  -- The daily scope is the daily, not a relabelled "today". lbtiea's
  -- 5500 is a duel run today and belongs on `today` only.
  PERFORM pg_temp.ok(pg_temp.bcount(g, 'lbtiea') = 0,
    'a duel run does not appear on the DAILY board');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(g, 5500), 'and neither does its score');
  PERFORM pg_temp.ok(pg_temp.bcount(g, 'lbmulti') = 1,
    'a player with both a daily attempt and duel runs appears once on the daily board');

  RAISE NOTICE '--- daily agrees with get_daily_leaderboard OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 6. An unknown scope is an error payload, with no rows
--
-- "Anything else is an error payload, not an exception, and never a
-- silent fallback to a different board." A fallback is the dangerous
-- half: a typo in a client would then render one board under another
-- board's heading, and nothing would look wrong.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE v JSONB; t JSONB; d JSONB; a JSONB; s TEXT; threw BOOLEAN;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');
  d := public.get_global_board('daily',    100);
  t := public.get_global_board('today',    100);
  a := public.get_global_board('all_time', 100);
  PERFORM pg_temp.ok(pg_temp.blen(d) > 0 AND pg_temp.blen(t) > 0 AND pg_temp.blen(a) > 0,
    'fixture: all three real boards have rows, so "no rows" below means something');

  FOREACH s IN ARRAY ARRAY['bogus', 'all-time', 'week', 'DROP', ''] LOOP
    threw := FALSE;
    BEGIN
      v := public.get_global_board(s, 10);
    EXCEPTION WHEN OTHERS THEN threw := TRUE;
    END;
    PERFORM pg_temp.ok(NOT threw,
      'scope "' || s || '" does not raise — a public client gets a payload, not a 500');
    PERFORM pg_temp.ok(v IS NOT NULL, 'scope "' || s || '" returns a payload');
    PERFORM pg_temp.ok(v ? 'error',   'scope "' || s || '" returns an ERROR payload');
    PERFORM pg_temp.ok(pg_temp.blen(v) = 0, 'scope "' || s || '" returns no rows');

    -- The fallback, stated as three separate impossibilities rather than
    -- inferred from the row count.
    PERFORM pg_temp.ok(pg_temp.brows(v) IS DISTINCT FROM pg_temp.brows(d),
      'scope "' || s || '" is not the daily board wearing another name');
    PERFORM pg_temp.ok(pg_temp.brows(v) IS DISTINCT FROM pg_temp.brows(t),
      'scope "' || s || '" is not today''s board');
    PERFORM pg_temp.ok(pg_temp.brows(v) IS DISTINCT FROM pg_temp.brows(a),
      'scope "' || s || '" is not the all-time board');
    PERFORM pg_temp.ok(COALESCE(v->>'scope', '') NOT IN ('daily', 'today', 'all_time'),
      'scope "' || s || '" does not claim to be one of the three real scopes');
  END LOOP;

  -- NULL is not one of the three either; whatever it does, it must not
  -- raise, because a client with an unset tab sends it.
  threw := FALSE;
  BEGIN
    v := public.get_global_board(NULL, 10);
  EXCEPTION WHEN OTHERS THEN threw := TRUE;
  END;
  PERFORM pg_temp.ok(NOT threw, 'a NULL scope does not raise');
  PERFORM pg_temp.ok(v IS NOT NULL, 'a NULL scope returns a payload');

  RAISE NOTICE '--- unknown scope OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 7. The limit is clamped
--
-- "A client asking for 100,000 rows gets the maximum, not a timeout."
-- 138+ players are eligible today, so a clamp is observable rather than
-- indistinguishable from "that is all there was".
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE big JSONB; med JSONB; five JSONB; zero JSONB; neg JSONB; nul JSONB;
        eligible INT; i INT;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');

  SELECT COUNT(DISTINCT r.user_id)::INT INTO eligible
    FROM public.duel_runs r
    JOIN public.duels d ON d.id = r.duel_id
    JOIN public.profiles p ON p.id = r.user_id
   WHERE d.duration_seconds = 120 AND r.status = 'complete' AND r.score IS NOT NULL;
  PERFORM pg_temp.ok(eligible > 100,
    'fixture: more than 100 named players have a finished 120-second run, so a clamp is visible');

  big  := public.get_global_board('today', 100000);
  med  := public.get_global_board('today', 1000);
  five := public.get_global_board('today', 5);

  PERFORM pg_temp.ok(pg_temp.blen(big) < eligible,
    'asking for 100000 rows does not serialise every eligible player');
  PERFORM pg_temp.ok(pg_temp.blen(big) = pg_temp.blen(med),
    'and 1000 gets the same number back — the ceiling is the server''s, not the caller''s');
  PERFORM pg_temp.ok(pg_temp.blen(big) = 100,
    'the ceiling is 100 rows, the same maximum get_daily_leaderboard documents');
  PERFORM pg_temp.ok(pg_temp.blen(public.get_global_board('all_time', 100000)) = 100,
    'the all-time board is clamped to 100 too');

  -- A limit under the ceiling is honoured exactly, and truncates the same
  -- board rather than producing a different one.
  PERFORM pg_temp.ok(pg_temp.blen(five) = 5, 'a limit of 5 returns exactly 5 rows');
  FOR i IN 0..4 LOOP
    PERFORM pg_temp.ok(pg_temp.brows(five)->i = pg_temp.brows(big)->i,
      'row ' || i || ' of the 5-row board is row ' || i || ' of the full board');
  END LOOP;

  -- Degenerate limits arrive from public clients and must not raise.
  zero := public.get_global_board('today', 0);
  neg  := public.get_global_board('today', -7);
  nul  := public.get_global_board('today', NULL);
  PERFORM pg_temp.ok(pg_temp.blen(zero) BETWEEN 0 AND 100, 'a limit of 0 is answered, not an error');
  PERFORM pg_temp.ok(pg_temp.blen(neg)  BETWEEN 0 AND 100, 'a negative limit is answered, not an error');
  PERFORM pg_temp.ok(pg_temp.blen(nul)  BETWEEN 1 AND 100, 'a NULL limit falls back to a default board');

  RAISE NOTICE '--- the limit is clamped OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 8. Nothing in the payload identifies anybody
--
-- "Every row is rank · username · score, and nothing else — no user ids,
-- no session keys, no dates that could identify a run."
--
-- Asserted by walking every key at every depth. A user_id on row 84 is
-- exactly as leaked as one on row 0, and eyeballing the first row is how
-- that gets missed.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE v JSONB; s TEXT; ks TEXT[]; bad TEXT; n INT;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');

  FOREACH s IN ARRAY ARRAY['daily', 'today', 'all_time'] LOOP
    v  := public.get_global_board(s, 100);
    ks := pg_temp.jkeys(v);
    PERFORM pg_temp.ok(array_length(ks, 1) > 3,
      s || ': the key walk actually walked something');

    SELECT string_agg(DISTINCT k, ', ') INTO bad
      FROM unnest(ks) k
     WHERE lower(k) IN ('user_id', 'userid', 'id', 'uid', 'user', 'email', 'auth_id',
                        'session_key', 'duel_key', 'duel_id', 'attempt_id', 'puzzle_date',
                        'questions', 'answers', 'started_at', 'submitted_at', 'created_at');
    PERFORM pg_temp.ok(bad IS NULL,
      s || ': no identifying key anywhere in the payload' || COALESCE(' (found: ' || bad || ')', ''));

    -- Values, not just key names: a uuid or an email under an innocent
    -- key is the same leak.
    PERFORM pg_temp.ok(v::TEXT !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
      s || ': no UUID appears anywhere in the payload');
    PERFORM pg_temp.ok(v::TEXT NOT LIKE '%@%',
      s || ': no email address appears anywhere in the payload');

    -- Every row, exactly three keys.
    SELECT COUNT(*)::INT INTO n
      FROM jsonb_array_elements(pg_temp.brows(v)) e
     WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k)
           <> ARRAY['rank', 'score', 'username'];
    PERFORM pg_temp.ok(n = 0,
      s || ': every row carries exactly {rank, username, score} and nothing else');

    -- No blank rows: a null score or a null/empty username is a row that
    -- should not have been emitted at all.
    SELECT COUNT(*)::INT INTO n
      FROM jsonb_array_elements(pg_temp.brows(v)) e
     WHERE COALESCE(e->>'username', '') = '' OR jsonb_typeof(e->'score') <> 'number';
    PERFORM pg_temp.ok(n = 0, s || ': no row has a blank username or a non-numeric score');

    -- Ranks are 1-based and never decrease down the array.
    PERFORM pg_temp.ok((pg_temp.brows(v)->0->>'rank')::INT = 1, s || ': the first row is rank 1');
    SELECT COUNT(*)::INT INTO n
      FROM jsonb_array_elements(pg_temp.brows(v)) WITH ORDINALITY x(e, ord)
     WHERE ord > 1
       AND (e->>'rank')::INT < (pg_temp.brows(v)->(ord - 2)::INT->>'rank')::INT;
    PERFORM pg_temp.ok(n = 0, s || ': rank never decreases down the array');

    -- And scores never increase down the array: the board is sorted.
    SELECT COUNT(*)::INT INTO n
      FROM jsonb_array_elements(pg_temp.brows(v)) WITH ORDINALITY x(e, ord)
     WHERE ord > 1
       AND (e->>'score')::INT > (pg_temp.brows(v)->(ord - 2)::INT->>'score')::INT;
    PERFORM pg_temp.ok(n = 0, s || ': scores never increase down the array');
  END LOOP;

  -- The whole document, one exact key set. The doc enumerates the return
  -- value; anything else in it is something a client was not built for.
  v := public.get_global_board('today', 100);
  SELECT array_agg(DISTINCT k ORDER BY k) INTO ks FROM unnest(pg_temp.jkeys(v)) k;
  PERFORM pg_temp.ok(
    ks = ARRAY['duration_seconds', 'generated_at', 'rank', 'rows', 'scope', 'score', 'username'],
    'the payload contains exactly {scope, duration_seconds, generated_at, rows{rank, username, score}} '
    || '(found: ' || array_to_string(ks, ', ') || ')');

  RAISE NOTICE '--- no identifiers in the payload OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 9. Who is on the board and who is not
--
-- A player with no username is skipped rather than rendered blank — "a
-- row of anonymous placeholders at the top of a public page".
--
-- A player whose profile is PRIVATE is on the board. The spec is
-- deliberate: is_public governs whether the profile PAGE is readable, not
-- whether a score counts. This is the rule most likely to be "fixed" by
-- someone who has not read the doc, which is why it is pinned.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE t JSONB; a JSONB; d JSONB;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');
  t := public.get_global_board('today',    100);
  a := public.get_global_board('all_time', 100);
  d := public.get_global_board('daily',    100);

  -- No profile row: 6600 would be rank 1 on both boards if it were shown.
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 6600),
    'a player with no username is absent from today''s board, not shown blank');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(a, 6600),
    'and absent from the all-time board');

  -- A guest run: user_id NULL, 7777, would also be rank 1.
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(t, 7777),
    'a guest duel run has nobody to name and does not rank');
  PERFORM pg_temp.ok(NOT pg_temp.bhas_score(a, 7777),
    'nor on the all-time board');

  -- An in-progress daily attempt has no score at all.
  PERFORM pg_temp.ok(pg_temp.bcount(d, 'lbnodaily') = 0,
    'a daily attempt still in progress is not a row on the daily board');
  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbnodaily') = 0, 'nor on today''s board');

  -- The private profile, present on all three of its boards.
  PERFORM pg_temp.ok(pg_temp.bcount(d, 'lbprivate') = 1,
    'a private profile IS on the daily board — is_public governs the profile page, not the score');
  PERFORM pg_temp.ok(pg_temp.bscore(d, 'lbprivate') = 5400, 'at 5400');
  PERFORM pg_temp.ok(pg_temp.bcount(t, 'lbprivate') = 1, 'and on today''s board');
  PERFORM pg_temp.ok(pg_temp.bscore(t, 'lbprivate') = 5400, 'at 5400');
  PERFORM pg_temp.ok(pg_temp.bcount(a, 'lbprivate') = 1, 'and on the all-time board');
  PERFORM pg_temp.ok(pg_temp.bscore(a, 'lbprivate') = 5400, 'at 5400');

  RAISE NOTICE '--- usernames, guests and private profiles OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 10. The top of the board, in order
--
-- Every exclusion above is also an ordering claim. Pinned as a prefix so
-- one rule quietly failing open shows up as a shifted name rather than as
-- a passing test.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE t JSONB; a JSONB;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');
  t := public.get_global_board('today',    100);
  a := public.get_global_board('all_time', 100);

  PERFORM pg_temp.ok(pg_temp.bname_at(t, 0) = 'lbforge'   AND pg_temp.bscore_at(t, 0) = 9997,
    'today, 1st: lbforge at an unverified 9997 — the top of this board is a client-reported number');
  PERFORM pg_temp.ok(pg_temp.bname_at(t, 1) = 'lbdaily1'  AND pg_temp.bscore_at(t, 1) = 5700,
    'today, 2nd: lbdaily1 at 5700 (a daily attempt counts as a run today)');
  PERFORM pg_temp.ok(pg_temp.bname_at(t, 2) = 'lbmulti'   AND pg_temp.bscore_at(t, 2) = 5600,
    'today, 3rd: lbmulti at 5600');
  PERFORM pg_temp.ok(pg_temp.bname_at(t, 3) = 'lbtiea'    AND pg_temp.bscore_at(t, 3) = 5500,
    'today, 4th: lbtiea at 5500');
  PERFORM pg_temp.ok(pg_temp.bname_at(t, 4) = 'lbtieb'    AND pg_temp.bscore_at(t, 4) = 5500,
    'today, 5th: lbtieb at 5500');
  PERFORM pg_temp.ok(pg_temp.bname_at(t, 5) = 'lbprivate' AND pg_temp.bscore_at(t, 5) = 5400,
    'today, 6th: lbprivate at 5400');
  PERFORM pg_temp.ok(pg_temp.bname_at(t, 6) = 'lbsolo'    AND pg_temp.bscore_at(t, 6) = 5350,
    'today, 7th: lbsolo at 5350 — a solo run placed on merit, mid-board');
  PERFORM pg_temp.ok(pg_temp.bname_at(t, 7) = 'lbslow'    AND pg_temp.bscore_at(t, 7) = 5300,
    'today, 8th: lbslow at their 120-second 5300');
  PERFORM pg_temp.ok(pg_temp.bname_at(t, 8) = 'lbbulk130' AND pg_temp.bscore_at(t, 8) = 1130,
    'today, 9th: the best of the ordinary players, at 1130 — lbforge''s 4900 duel run '
    || 'is NOT a second row of theirs');

  PERFORM pg_temp.ok(pg_temp.bname_at(a, 0) = 'lbforge'   AND pg_temp.bscore_at(a, 0) = 9997,
    'all-time, 1st: lbforge at 9997');
  PERFORM pg_temp.ok(pg_temp.bname_at(a, 1) = 'lbmulti'   AND pg_temp.bscore_at(a, 1) = 6400,
    'all-time, 2nd: lbmulti at 6400');
  PERFORM pg_temp.ok(pg_temp.bname_at(a, 2) = 'lbold'     AND pg_temp.bscore_at(a, 2) = 6100,
    'all-time, 3rd: lbold at 6100, six days old and still counting');
  PERFORM pg_temp.ok(pg_temp.bname_at(a, 3) = 'lbdaily1'  AND pg_temp.bscore_at(a, 3) = 5700,
    'all-time, 4th: lbdaily1 at 5700');
  PERFORM pg_temp.ok(pg_temp.bname_at(a, 4) = 'lbtiea'    AND pg_temp.bscore_at(a, 4) = 5500,
    'all-time, 5th: lbtiea at 5500');
  PERFORM pg_temp.ok(pg_temp.bname_at(a, 5) = 'lbtieb'    AND pg_temp.bscore_at(a, 5) = 5500,
    'all-time, 6th: lbtieb at 5500');
  PERFORM pg_temp.ok(pg_temp.bname_at(a, 6) = 'lbprivate' AND pg_temp.bscore_at(a, 6) = 5400,
    'all-time, 7th: lbprivate at 5400');
  PERFORM pg_temp.ok(pg_temp.bname_at(a, 7) = 'lbsolo'    AND pg_temp.bscore_at(a, 7) = 5350,
    'all-time, 8th: lbsolo at 5350');
  PERFORM pg_temp.ok(pg_temp.bname_at(a, 8) = 'lbslow'    AND pg_temp.bscore_at(a, 8) = 5300,
    'all-time, 9th: lbslow at 5300');
  PERFORM pg_temp.ok(pg_temp.bname_at(a, 9) = 'lbsoloold' AND pg_temp.bscore_at(a, 9) = 5150,
    'all-time, 10th: lbsoloold at 5150, five days old and still counting');

  RAISE NOTICE '--- board order OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 11. Posture
--
-- The board is the one page worth landing a stranger on, so anon must be
-- able to call it — which makes the fixed projection the only thing
-- standing between a public function and the tables behind it.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE n INT; f OID; tbl TEXT;
BEGIN
  SELECT COUNT(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'get_global_board';
  PERFORM pg_temp.ok(n = 1,
    'there is exactly one public.get_global_board — no overload a caller could land on by accident');

  SELECT p.oid INTO f
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'get_global_board';

  -- Names as well as types: the client calls this through PostgREST, which
  -- passes arguments by name, so a renamed parameter is a broken call.
  PERFORM pg_temp.ok(pg_get_function_identity_arguments(f) = 'p_scope text, p_limit integer',
    'get_global_board(p_scope TEXT, p_limit INTEGER), exactly as the contract spells it');
  PERFORM pg_temp.ok(pg_get_function_result(f) = 'jsonb', 'it returns jsonb');
  PERFORM pg_temp.ok((SELECT prosecdef FROM pg_proc WHERE oid = f),
    'get_global_board is SECURITY DEFINER');
  PERFORM pg_temp.ok(
    (SELECT COALESCE('search_path=public' = ANY(proconfig), FALSE) FROM pg_proc WHERE oid = f),
    'get_global_board pins search_path = public');
  PERFORM pg_temp.ok(has_function_privilege('anon', f, 'EXECUTE'),
    'anon can call it — a leaderboard nobody can read while signed out is not a leaderboard');
  PERFORM pg_temp.ok(has_function_privilege('authenticated', f, 'EXECUTE'),
    'authenticated can call it');

  -- The tables it reads stay unreachable from the client roles. Without
  -- this the function is a convenience, not a boundary.
  FOREACH tbl IN ARRAY ARRAY['daily_attempts', 'daily_puzzles', 'duels', 'duel_runs'] LOOP
    PERFORM pg_temp.ok(has_table_privilege('anon', 'public.' || tbl, 'SELECT') IS FALSE,
      'anon still has no direct SELECT on ' || tbl);
    PERFORM pg_temp.ok(has_table_privilege('authenticated', 'public.' || tbl, 'SELECT') IS FALSE,
      'authenticated still has no direct SELECT on ' || tbl);
    PERFORM pg_temp.ok(
      (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND c.relname = tbl),
      'RLS is still enabled on ' || tbl);
  END LOOP;

  RAISE NOTICE '--- posture OK ---';
END $$;

-- A signed-out caller gets the same board as a signed-in one: it is a
-- public ranking, not a personalised one, and nothing in it varies by who
-- is asking.
DO $$
DECLARE anon_v JSONB; user_v JSONB; s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['daily', 'today', 'all_time'] LOOP
    PERFORM pg_temp.as_anon();
    anon_v := public.get_global_board(s, 100);
    PERFORM pg_temp.as_user('lbmulti');
    user_v := public.get_global_board(s, 100);

    PERFORM pg_temp.ok(anon_v IS NOT NULL AND NOT (anon_v ? 'error'),
      s || ': a signed-out caller gets a board, not an error');
    PERFORM pg_temp.ok(pg_temp.brows(anon_v) = pg_temp.brows(user_v),
      s || ': the signed-out board is identical to the signed-in one');
    PERFORM pg_temp.ok(pg_temp.blen(anon_v) > 0
                   AND pg_temp.bname_at(anon_v, 0) = pg_temp.bname_at(user_v, 0),
      s || ': including who is at the top of it');
  END LOOP;

  RAISE NOTICE '--- public readability OK ---';
END $$;

-- ════════════════════════════════════════════════════════════════
-- 12. Ties break on the earlier submitted_at
--
-- lbtiea and lbtieb both scored 5500 today; lbtiea submitted fifteen
-- minutes earlier. "First to get there holds the higher rank."
--
-- Last in the file deliberately. The array-order half is unambiguous; the
-- rank-number half depends on whether the implementation numbers ties
-- with ROW_NUMBER (1,2,3,4) or RANK (1,2,3,3), and this is the one place
-- the design doc's sentence could be read either way. ON_ERROR_STOP
-- aborts at the first failure, so an argument about the second half must
-- not be able to hide the fifty assertions above it.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE t JSONB; a JSONB;
BEGIN
  PERFORM pg_temp.as_user('lbmulti');
  t := public.get_global_board('today',    100);
  a := public.get_global_board('all_time', 100);

  PERFORM pg_temp.ok(pg_temp.bscore(t, 'lbtiea') = 5500 AND pg_temp.bscore(t, 'lbtieb') = 5500,
    'fixture: both tied players are on today''s board at 5500');
  PERFORM pg_temp.ok(pg_temp.bpos(t, 'lbtiea') < pg_temp.bpos(t, 'lbtieb'),
    'today: the earlier submission is listed first');
  PERFORM pg_temp.ok(pg_temp.bpos(t, 'lbtieb') = pg_temp.bpos(t, 'lbtiea') + 1,
    'today: and immediately before the later one — nothing was reordered between them');
  PERFORM pg_temp.ok(pg_temp.bpos(a, 'lbtiea') < pg_temp.bpos(a, 'lbtieb'),
    'all-time: the earlier submission is listed first there too');

  PERFORM pg_temp.ok(pg_temp.brank(t, 'lbtiea') <= pg_temp.brank(t, 'lbtieb'),
    'today: the earlier submission does not rank BELOW the later one');

  -- The strict reading of "first to get there holds the higher rank".
  PERFORM pg_temp.ok(pg_temp.brank(t, 'lbtiea') < pg_temp.brank(t, 'lbtieb'),
    'today: the tie is broken on submitted_at in the rank itself, not only in the array order');
  PERFORM pg_temp.ok(pg_temp.brank(a, 'lbtiea') < pg_temp.brank(a, 'lbtieb'),
    'all-time: the same');

  RAISE NOTICE '--- tie-break OK ---';
END $$;

SELECT 'ALL LEADERBOARD CONTRACT TESTS PASSED' AS result;
