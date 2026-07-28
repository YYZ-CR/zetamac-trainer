-- Contract tests for supabase/leagues.sql.
-- Written against docs/leagues-design.md before reading the implementation.
-- Runs after 03-daily-test.sql; pg_temp.ok / as_user / as_anon come from 02.

\set ON_ERROR_STOP on
SET client_min_messages = NOTICE;

-- Extra players, because the 100-member cap needs more than the seed's 30.
DO $$
DECLARE uid UUID;
BEGIN
  FOR i IN 100..220 LOOP
    INSERT INTO auth.users (email) VALUES ('bulk' || i || '@example.test') RETURNING id INTO uid;
    INSERT INTO public.profiles (id, username, is_public) VALUES (uid, 'bulk' || i, FALSE);
  END LOOP;
END $$;

-- ── Create, join, and the join-screen boundary ──────────────────
DO $$
DECLARE l JSONB; v JSONB; b JSONB; code TEXT; n INT; t0 TIMESTAMPTZ; t1 TIMESTAMPTZ;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  l := public.create_league('Desk Six');
  PERFORM pg_temp.ok(l IS NOT NULL,        'create_league returns a payload');
  PERFORM pg_temp.ok(l ? 'league_key',     'the payload carries an invite code');
  PERFORM pg_temp.ok(l->>'name' = 'Desk Six', 'the name comes back');
  code := l->>'league_key';

  -- The code is read aloud, so it must avoid ambiguous glyphs.
  PERFORM pg_temp.ok(code !~ '[O0Il1]',
    'the invite code avoids ambiguous characters (O/0, I/l/1)');
  PERFORM pg_temp.ok(length(code) >= 6, 'the invite code is not trivially short');

  -- The creator is a member without joining.
  SELECT COUNT(*) INTO n FROM public.league_members m
    JOIN public.leagues g ON g.id = m.league_id WHERE g.league_key = code;
  PERFORM pg_temp.ok(n = 1, 'the creator is the first member');

  -- ── A non-member gets a join screen, not the roster ───────────
  PERFORM pg_temp.as_user('player10');
  v := public.get_league(code);
  PERFORM pg_temp.ok(v IS NOT NULL,                  'a non-member can resolve the code');
  PERFORM pg_temp.ok(v->>'name' = 'Desk Six',        'a non-member sees the league name');
  PERFORM pg_temp.ok((v->>'member_count')::INT = 1,  'a non-member sees a member count');
  PERFORM pg_temp.ok((v->>'is_member')::BOOLEAN IS FALSE, 'is_member is false for a stranger');
  PERFORM pg_temp.ok(v::TEXT NOT LIKE '%hexadecimal%',
    'the join screen does NOT name the members — a code is not a directory');

  BEGIN
    b := public.get_league_board(code, 'today');
    PERFORM pg_temp.ok(b IS NULL OR b ? 'error',
      'a non-member cannot read the board');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ok(TRUE, 'a non-member cannot read the board (raised)');
  END;

  -- ── Joining, twice ────────────────────────────────────────────
  PERFORM public.join_league(code);
  SELECT joined_at INTO t0 FROM public.league_members m
    JOIN public.leagues g ON g.id = m.league_id
   WHERE g.league_key = code
     AND m.user_id = (SELECT id FROM public.profiles WHERE username = 'player10');
  PERFORM pg_temp.ok(t0 IS NOT NULL, 'joining adds the caller');

  PERFORM public.join_league(code);      -- again
  SELECT COUNT(*) INTO n FROM public.league_members m
    JOIN public.leagues g ON g.id = m.league_id
   WHERE g.league_key = code
     AND m.user_id = (SELECT id FROM public.profiles WHERE username = 'player10');
  PERFORM pg_temp.ok(n = 1, 'joining twice does not duplicate the membership');

  SELECT joined_at INTO t1 FROM public.league_members m
    JOIN public.leagues g ON g.id = m.league_id
   WHERE g.league_key = code
     AND m.user_id = (SELECT id FROM public.profiles WHERE username = 'player10');
  PERFORM pg_temp.ok(t0 = t1,
    'joining twice does not reset joined_at — ownership transfer depends on it');

  -- Now a member, the board opens up.
  b := public.get_league_board(code, 'today');
  PERFORM pg_temp.ok(b IS NOT NULL AND NOT (b ? 'error'), 'a member can read the board');
  PERFORM pg_temp.ok(jsonb_typeof(b->'rows') = 'array',  'the board has rows');
  PERFORM pg_temp.ok(b::TEXT NOT LIKE '%@example.test%', 'the board leaks no email');
  PERFORM pg_temp.ok(NOT (b->'rows'->0 ? 'user_id'),     'the board leaks no user_id');

  RAISE NOTICE '--- create/join/boundary OK ---';
END $$;

-- ── The board reflects the daily, including who did not play ────
DO $$
DECLARE code TEXT; b JSONB; n INT; unplayed INT;
BEGIN
  PERFORM pg_temp.as_user('player11');
  code := (public.create_league('Board Test'))->>'league_key';

  -- hexadecimal already completed today's daily in 03-daily-test.sql.
  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM public.join_league(code);
  -- player12 joins but never plays.
  PERFORM pg_temp.as_user('player12');
  PERFORM public.join_league(code);

  PERFORM pg_temp.as_user('player11');
  b := public.get_league_board(code, 'today');

  SELECT jsonb_array_length(b->'rows') INTO n;
  PERFORM pg_temp.ok(n = 3, 'every member appears on the board, played or not');

  SELECT COUNT(*) INTO unplayed FROM jsonb_array_elements(b->'rows') e
   WHERE (e->>'played')::BOOLEAN IS FALSE;
  PERFORM pg_temp.ok(unplayed >= 1,
    'a member who has not played today is present and flagged, not omitted');

  -- Whoever played must outrank whoever did not.
  PERFORM pg_temp.ok(
    (b->'rows'->0->>'played')::BOOLEAN IS TRUE
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b->'rows') e
                   WHERE (e->>'played')::BOOLEAN IS TRUE),
    'players are ranked above non-players');

  PERFORM pg_temp.ok(b->'rows'->0 ? 'username', 'rows carry a username');
  PERFORM pg_temp.ok(b->'rows'->0 ? 'rank',     'rows carry a rank');
  PERFORM pg_temp.ok(b ? 'scope',               'the scope is echoed back');

  -- The other scopes must not error on thin data.
  PERFORM pg_temp.ok(public.get_league_board(code, 'week') IS NOT NULL, 'week scope works');
  PERFORM pg_temp.ok(public.get_league_board(code, 'best') IS NOT NULL, 'best scope works');

  RAISE NOTICE '--- board OK ---';
END $$;

-- ── Leaving: transfer, then deletion ────────────────────────────
DO $$
DECLARE code TEXT; owner_now UUID; v JSONB; n INT;
BEGIN
  -- player13 owns; player14 joins first, player15 second.
  PERFORM pg_temp.as_user('player13');
  code := (public.create_league('Succession'))->>'league_key';
  PERFORM pg_temp.as_user('player14');
  PERFORM public.join_league(code);
  PERFORM pg_temp.as_user('player15');
  PERFORM public.join_league(code);

  -- The owner leaves: the longest-standing remaining member takes over.
  PERFORM pg_temp.as_user('player13');
  PERFORM public.leave_league(code);

  SELECT owner_id INTO owner_now FROM public.leagues WHERE league_key = code;
  PERFORM pg_temp.ok(
    owner_now = (SELECT id FROM public.profiles WHERE username = 'player14'),
    'an owner leaving hands the league to the longest-standing member');

  SELECT COUNT(*) INTO n FROM public.league_members m
    JOIN public.leagues g ON g.id = m.league_id WHERE g.league_key = code;
  PERFORM pg_temp.ok(n = 2, 'the departing owner is no longer a member');

  -- Everyone else leaves; the last one takes the league with them.
  PERFORM pg_temp.as_user('player14');
  PERFORM public.leave_league(code);
  PERFORM pg_temp.as_user('player15');
  PERFORM public.leave_league(code);

  SELECT COUNT(*) INTO n FROM public.leagues WHERE league_key = code;
  PERFORM pg_temp.ok(n = 0, 'the last member leaving deletes the league');

  PERFORM pg_temp.as_user('player16');
  PERFORM pg_temp.ok(public.get_league(code) IS NULL,
    'a deleted league''s code stops resolving');

  RAISE NOTICE '--- leaving OK ---';
END $$;

-- ── Caps are enforced in SQL ────────────────────────────────────
DO $$
DECLARE code TEXT; n INT; threw BOOLEAN; i INT;
BEGIN
  PERFORM pg_temp.as_user('bulk100');
  code := (public.create_league('Capped'))->>'league_key';

  -- 99 more joiners fills it to exactly 100 including the owner.
  FOR i IN 101..199 LOOP
    PERFORM pg_temp.as_user('bulk' || i);
    PERFORM public.join_league(code);
  END LOOP;

  SELECT COUNT(*) INTO n FROM public.league_members m
    JOIN public.leagues g ON g.id = m.league_id WHERE g.league_key = code;
  PERFORM pg_temp.ok(n = 100, 'the league filled to exactly 100');

  PERFORM pg_temp.as_user('bulk200');
  threw := FALSE;
  BEGIN
    PERFORM public.join_league(code);
  EXCEPTION WHEN OTHERS THEN threw := TRUE;
  END;
  SELECT COUNT(*) INTO n FROM public.league_members m
    JOIN public.leagues g ON g.id = m.league_id WHERE g.league_key = code;
  PERFORM pg_temp.ok(n = 100, 'the 101st member is refused — the cap holds');

  -- 20 leagues per user.
  PERFORM pg_temp.as_user('bulk210');
  FOR i IN 1..20 LOOP
    PERFORM public.create_league('L' || i);
  END LOOP;
  SELECT COUNT(*) INTO n FROM public.leagues
   WHERE owner_id = (SELECT id FROM public.profiles WHERE username = 'bulk210');
  PERFORM pg_temp.ok(n = 20, 'twenty leagues is allowed');

  BEGIN
    PERFORM public.create_league('L21');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  SELECT COUNT(*) INTO n FROM public.leagues
   WHERE owner_id = (SELECT id FROM public.profiles WHERE username = 'bulk210');
  PERFORM pg_temp.ok(n = 20, 'the 21st league is refused');

  RAISE NOTICE '--- caps OK ---';
END $$;

-- ── Unknown codes, my leagues, and posture ──────────────────────
DO $$
DECLARE v JSONB; relrls BOOLEAN; npol INT; n INT;
BEGIN
  PERFORM pg_temp.as_user('hexadecimal');
  PERFORM pg_temp.ok(public.get_league('NOSUCHCODE') IS NULL,
    'an unknown invite code resolves to nothing rather than erroring');

  v := public.get_my_leagues();
  PERFORM pg_temp.ok(v IS NOT NULL, 'get_my_leagues returns a payload');
  PERFORM pg_temp.ok(jsonb_typeof(COALESCE(v->'leagues', v)) = 'array',
    'get_my_leagues returns an array');

  -- Someone in no leagues gets an empty list, not an error.
  PERFORM pg_temp.as_user('player20');
  v := public.get_my_leagues();
  PERFORM pg_temp.ok(v IS NOT NULL, 'a user with no leagues gets a payload');
  PERFORM pg_temp.ok(jsonb_array_length(COALESCE(v->'leagues', v)) = 0,
    'a user with no leagues gets an empty list');

  SELECT c.relrowsecurity INTO relrls FROM pg_class c
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
   WHERE n2.nspname = 'public' AND c.relname = 'leagues';
  PERFORM pg_temp.ok(relrls, 'RLS is enabled on leagues');

  SELECT COUNT(*) INTO npol FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('leagues', 'league_members');
  PERFORM pg_temp.ok(npol = 0, 'no permissive policies on the league tables');

  RAISE NOTICE '--- posture OK ---';
END $$;

SELECT 'ALL LEAGUE CONTRACT TESTS PASSED' AS result;
