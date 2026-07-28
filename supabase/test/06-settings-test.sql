-- Contract tests for supabase/settings.sql.
-- Written against the rules stated at the top of that file — 3..20
-- characters, [A-Za-z0-9_-] only, no case collisions, 30 days between
-- changes with the first one free, and set_username as the ONLY way in —
-- before reading its implementation.
--
-- Runs after 05-leagues-test.sql; pg_temp.ok / as_user / as_anon come from 02.
--
-- Every assertion below is on a specific expected value. "Returned
-- something" and "did not error" are not evidence: the two defects this
-- repo has already shipped both passed suites written that way.

\set ON_ERROR_STOP on
SET client_min_messages = NOTICE;

-- Impersonate by id rather than by name, because half these tests rename
-- the user under test and pg_temp.as_user('…') looks them up by the name
-- they no longer have.
CREATE OR REPLACE FUNCTION pg_temp.as_uid(uid UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', uid::TEXT, FALSE);
END $$;

-- Two accounts with no profile row at all, which is a state this app
-- really has: with email confirmation on, signUp returns a user but no
-- session, so auth.uid() is null and the profile insert is refused.
DO $$
DECLARE a UUID; b UUID;
BEGIN
  INSERT INTO auth.users (email) VALUES ('set-a@example.test') RETURNING id INTO a;
  INSERT INTO auth.users (email) VALUES ('set-b@example.test') RETURNING id INTO b;
  PERFORM set_config('zt.test_a', a::TEXT, FALSE);
  PERFORM set_config('zt.test_b', b::TEXT, FALSE);
END $$;

-- ── The rule constants are the ones the function uses ───────────
DO $$
BEGIN
  PERFORM pg_temp.ok(public.username_cooldown_days() = 30,
    'the cooldown is 30 days');

  PERFORM pg_temp.ok(public.username_shape_error('goodname') IS NULL,
    'a well-formed name has no shape error');
  PERFORM pg_temp.ok(public.username_shape_error('abc') IS NULL,
    'exactly 3 characters is allowed');
  PERFORM pg_temp.ok(public.username_shape_error(repeat('a', 20)) IS NULL,
    'exactly 20 characters is allowed');
  PERFORM pg_temp.ok(public.username_shape_error('ab') = 'username_too_short',
    '2 characters is too short');
  PERFORM pg_temp.ok(public.username_shape_error(repeat('a', 21)) = 'username_too_long',
    '21 characters is too long');
  PERFORM pg_temp.ok(public.username_shape_error('   ') = 'username_empty',
    'whitespace only is empty, not too short');
  PERFORM pg_temp.ok(public.username_shape_error(NULL) = 'username_empty',
    'null is empty');
  PERFORM pg_temp.ok(public.username_shape_error('a-b_C9') IS NULL,
    'hyphen, underscore, digits and mixed case are all allowed');

  RAISE NOTICE '--- rule constants OK ---';
END $$;

-- ── A user with no profile row can claim one, once, free ────────
DO $$
DECLARE a UUID := current_setting('zt.test_a')::UUID;
        r JSONB; n INT; t0 TIMESTAMPTZ; t1 TIMESTAMPTZ; keys TEXT[];
BEGIN
  PERFORM pg_temp.as_uid(a);

  SELECT COUNT(*) INTO n FROM public.profiles WHERE id = a;
  PERFORM pg_temp.ok(n = 0, 'the fixture account starts with no profile row');

  r := public.set_username('freshname');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'a user with no profile row can set a username');
  PERFORM pg_temp.ok(r->>'username' = 'freshname',
    'the payload echoes the name that was set');
  PERFORM pg_temp.ok(r->>'error' IS NULL, 'a successful set carries no error');
  PERFORM pg_temp.ok(
    (r->>'next_change_allowed_at')::TIMESTAMPTZ BETWEEN NOW() + INTERVAL '29 days'
                                                    AND NOW() + INTERVAL '31 days',
    'the next change is 30 days out');

  -- The exact payload shape the client renders from.
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(r) k;
  PERFORM pg_temp.ok(
    keys = ARRAY['error','next_change_allowed_at','ok','username'],
    'the payload is exactly {ok, username, next_change_allowed_at, error}');

  SELECT COUNT(*) INTO n FROM public.profiles WHERE id = a AND username = 'freshname';
  PERFORM pg_temp.ok(n = 1, 'the profile row was actually inserted');

  SELECT username_changed_at INTO t0 FROM public.profiles WHERE id = a;
  PERFORM pg_temp.ok(t0 IS NOT NULL, 'the first set starts the cooldown clock');

  -- ── The second change, immediately: refused ───────────────────
  r := public.set_username('secondname');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
    'a second change inside 30 days is refused');
  PERFORM pg_temp.ok(r->>'error' = 'username_cooldown',
    'the refusal names the cooldown specifically');
  PERFORM pg_temp.ok(r->>'username' = 'freshname',
    'a refusal echoes the name they still have, not the one they asked for');
  PERFORM pg_temp.ok(
    (r->>'next_change_allowed_at')::TIMESTAMPTZ = t0 + INTERVAL '30 days',
    'the refusal says exactly when the change becomes possible');

  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = a) = 'freshname',
    'the refused change did not touch the stored name');

  -- ── Re-submitting the SAME name is a no-op, not a change ──────
  r := public.set_username('freshname');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'setting the name you already have succeeds');
  SELECT username_changed_at INTO t1 FROM public.profiles WHERE id = a;
  PERFORM pg_temp.ok(t1 = t0,
    'a no-op set does not burn the cooldown');

  RAISE NOTICE '--- claim and cooldown OK ---';
END $$;

-- ── The cooldown boundary, from both sides ──────────────────────
DO $$
DECLARE a UUID := current_setting('zt.test_a')::UUID; r JSONB;
BEGIN
  PERFORM pg_temp.as_uid(a);

  -- 29 days ago: still inside the window.
  UPDATE public.profiles SET username_changed_at = NOW() - INTERVAL '29 days' WHERE id = a;
  r := public.set_username('day29name');
  PERFORM pg_temp.ok(r->>'error' = 'username_cooldown',
    '29 days after the last change is still refused');
  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = a) = 'freshname',
    'the name is unchanged after the 29-day refusal');

  -- 31 days ago: the window has passed.
  UPDATE public.profiles SET username_changed_at = NOW() - INTERVAL '31 days' WHERE id = a;
  r := public.set_username('day31name');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    '31 days after the last change is allowed');
  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = a) = 'day31name',
    'the allowed change is actually written');
  PERFORM pg_temp.ok(
    (SELECT username_changed_at FROM public.profiles WHERE id = a) > NOW() - INTERVAL '1 minute',
    'a successful change restarts the clock');

  RAISE NOTICE '--- cooldown boundary OK ---';
END $$;

-- ── Case collisions, between users and against yourself ─────────
DO $$
DECLARE a UUID := current_setting('zt.test_a')::UUID;
        b UUID := current_setting('zt.test_b')::UUID;
        r JSONB; threw BOOLEAN;
BEGIN
  -- b has no profile row yet, so this is b's free first claim.
  PERFORM pg_temp.as_uid(b);

  r := public.set_username('DAY31NAME');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
    'a name differing only by case is refused');
  PERFORM pg_temp.ok(r->>'error' = 'username_taken',
    'the case collision is reported as taken, not as a generic failure');
  PERFORM pg_temp.ok(r->>'username' IS NULL,
    'a refused first claim leaves the caller with no username');

  r := public.set_username('day31name');
  PERFORM pg_temp.ok(r->>'error' = 'username_taken',
    'the identical name is refused too');

  r := public.set_username('hexadecimal');
  PERFORM pg_temp.ok(r->>'error' = 'username_taken',
    'a seeded name is taken');
  PERFORM pg_temp.ok(r->>'next_change_allowed_at' IS NULL,
    'a caller who has never set a name has no cooldown to report');

  -- b takes a free name; the collision refusals must not have consumed
  -- b's free first claim.
  r := public.set_username('b_name');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'a refused attempt did not burn the free first claim');
  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = b) = 'b_name',
    'b now owns b_name');

  -- The index, not the pre-check, is the guarantee. Prove it directly:
  -- a raw INSERT of a case variant must be refused by the database even
  -- with set_username entirely out of the picture.
  threw := FALSE;
  BEGIN
    INSERT INTO public.profiles (id, username)
    VALUES (gen_random_uuid(), 'B_NAME');
  EXCEPTION WHEN unique_violation THEN threw := TRUE;
  END;
  PERFORM pg_temp.ok(threw,
    'a unique index on lower(username), not a SELECT, is what refuses a case variant');

  -- Changing only your own capitalisation IS a change and needs the
  -- cooldown, because it is what a board row will show.
  PERFORM pg_temp.as_uid(b);
  r := public.set_username('B_Name');
  PERFORM pg_temp.ok(r->>'error' = 'username_cooldown',
    'recasing your own name is a change, not a no-op');

  RAISE NOTICE '--- case collisions OK ---';
END $$;

-- ── Character and length refusals, each named ───────────────────
-- A fresh account per case, so a refusal can never be confused with a
-- cooldown left over from the previous one.
DO $$
DECLARE
  uid  UUID;
  r    JSONB;
  cases TEXT[][] := ARRAY[
    ARRAY['bad name',              'username_invalid_chars'],
    ARRAY['bad.name',              'username_invalid_chars'],
    ARRAY['bad@name',              'username_invalid_chars'],
    ARRAY['name/../etc',           'username_invalid_chars'],
    ARRAY['<script>x</script>',    'username_invalid_chars'],
    -- Cyrillic а (U+0430) in an otherwise ASCII name: the confusable
    -- case this whole rule exists for.
    ARRAY['dаy31name',             'username_invalid_chars'],
    -- Fullwidth Latin, and an emoji.
    ARRAY['ｄａｙ３１',              'username_invalid_chars'],
    ARRAY['name🙂',                'username_invalid_chars'],
    ARRAY['ab',                    'username_too_short'],
    ARRAY['a',                     'username_too_short'],
    ARRAY[repeat('a', 21),         'username_too_long'],
    ARRAY['   ',                   'username_empty'],
    ARRAY['',                      'username_empty']
  ];
  i INT;
BEGIN
  FOR i IN 1 .. array_length(cases, 1) LOOP
    INSERT INTO auth.users (email) VALUES ('shape' || i || '@example.test')
      RETURNING id INTO uid;
    PERFORM pg_temp.as_uid(uid);

    r := public.set_username(cases[i][1]);
    PERFORM pg_temp.ok(r->>'error' = cases[i][2],
      format('%L is refused as %s', cases[i][1], cases[i][2]));
    PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
      format('%L does not report success', cases[i][1]));
    PERFORM pg_temp.ok(
      NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = uid),
      format('%L wrote no profile row', cases[i][1]));
  END LOOP;

  -- NULL is a refusal, not a crash.
  INSERT INTO auth.users (email) VALUES ('shapenull@example.test') RETURNING id INTO uid;
  PERFORM pg_temp.as_uid(uid);
  PERFORM pg_temp.ok(public.set_username(NULL)->>'error' = 'username_empty',
    'a null username is refused as empty');

  RAISE NOTICE '--- shape refusals OK ---';
END $$;

-- ── Trimming, boundaries, and the signed-out caller ─────────────
DO $$
DECLARE uid UUID; r JSONB;
BEGIN
  INSERT INTO auth.users (email) VALUES ('trim@example.test') RETURNING id INTO uid;
  PERFORM pg_temp.as_uid(uid);
  r := public.set_username('   trimmed_name   ');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE, 'a padded name is accepted');
  PERFORM pg_temp.ok(r->>'username' = 'trimmed_name',
    'the stored name is trimmed');
  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = uid) = 'trimmed_name',
    'the row holds the trimmed form, not the padded one');

  INSERT INTO auth.users (email) VALUES ('min@example.test') RETURNING id INTO uid;
  PERFORM pg_temp.as_uid(uid);
  PERFORM pg_temp.ok((public.set_username('abc')->>'ok')::BOOLEAN IS TRUE,
    'a 3-character name is accepted');

  INSERT INTO auth.users (email) VALUES ('max@example.test') RETURNING id INTO uid;
  PERFORM pg_temp.as_uid(uid);
  PERFORM pg_temp.ok((public.set_username(repeat('z', 20))->>'ok')::BOOLEAN IS TRUE,
    'a 20-character name is accepted');

  PERFORM pg_temp.as_anon();
  r := public.set_username('anonymous_pick');
  PERFORM pg_temp.ok(r->>'error' = 'username_requires_account',
    'a signed-out caller is told they need an account');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS FALSE,
    'a signed-out caller does not succeed');
  PERFORM pg_temp.ok(
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE username = 'anonymous_pick'),
    'a signed-out caller wrote nothing');

  RAISE NOTICE '--- trimming and boundaries OK ---';
END $$;

-- ── Availability answers the way the index decides ──────────────
DO $$
BEGIN
  PERFORM pg_temp.as_anon();
  PERFORM pg_temp.ok(public.username_available('B_NAME') IS FALSE,
    'username_available is case-insensitive, matching the unique index');
  PERFORM pg_temp.ok(public.username_available('b_name') IS FALSE,
    'an exactly-matching name is unavailable');
  PERFORM pg_temp.ok(public.username_available('nobody_has_this') IS TRUE,
    'a free name is available');
  PERFORM pg_temp.ok(public.username_available('  b_name  ') IS FALSE,
    'padding does not make a taken name look free');

  RAISE NOTICE '--- availability OK ---';
END $$;

-- ── The shape rule holds for the INSERT path too ────────────────
-- Registration inserts the profile row directly (js/auth.js), so the
-- CHECK constraint — not just set_username — has to refuse a confusable.
DO $$
DECLARE uid UUID; threw BOOLEAN;
BEGIN
  INSERT INTO auth.users (email) VALUES ('rawins@example.test') RETURNING id INTO uid;

  threw := FALSE;
  BEGIN
    INSERT INTO public.profiles (id, username) VALUES (uid, 'raw name');
  EXCEPTION WHEN check_violation THEN threw := TRUE;
  END;
  PERFORM pg_temp.ok(threw,
    'a direct INSERT cannot take a name with a space');

  threw := FALSE;
  BEGIN
    INSERT INTO public.profiles (id, username) VALUES (uid, 'rаwname');  -- Cyrillic а
  EXCEPTION WHEN check_violation THEN threw := TRUE;
  END;
  PERFORM pg_temp.ok(threw,
    'a direct INSERT cannot take a Unicode confusable');

  threw := FALSE;
  BEGIN
    INSERT INTO public.profiles (id, username) VALUES (uid, 'xy');
  EXCEPTION WHEN check_violation THEN threw := TRUE;
  END;
  PERFORM pg_temp.ok(threw,
    'a direct INSERT cannot take a 2-character name');

  INSERT INTO public.profiles (id, username) VALUES (uid, 'raw_ok_name');
  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = uid) = 'raw_ok_name',
    'a well-formed direct INSERT still works — registration is not broken');

  RAISE NOTICE '--- insert path OK ---';
END $$;

-- ── The grants are what close the direct-write door ─────────────
-- Catalog AND runtime. The catalog says what was granted; the runtime
-- check says what the database actually does with it, and only the pair
-- of them rules out a green run that proves nothing.
DO $$
BEGIN
  PERFORM pg_temp.ok(
    has_column_privilege('authenticated', 'public.profiles', 'username', 'UPDATE') IS FALSE,
    'authenticated cannot UPDATE profiles.username');
  PERFORM pg_temp.ok(
    has_column_privilege('authenticated', 'public.profiles', 'username_changed_at', 'UPDATE') IS FALSE,
    'authenticated cannot UPDATE profiles.username_changed_at either — that would reset the cooldown');
  PERFORM pg_temp.ok(
    has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE') IS FALSE,
    'authenticated cannot UPDATE profiles.id');

  -- The positive control. Without this the two assertions above would
  -- also pass on a database where authenticated simply has no grants at
  -- all, which would prove nothing about column-level revocation.
  PERFORM pg_temp.ok(
    has_column_privilege('authenticated', 'public.profiles', 'is_public', 'UPDATE') IS TRUE,
    'authenticated CAN still UPDATE profiles.is_public — the settings toggle works');
  PERFORM pg_temp.ok(
    has_table_privilege('authenticated', 'public.profiles', 'SELECT') IS TRUE,
    'authenticated can still read its own profile row');
  PERFORM pg_temp.ok(
    has_table_privilege('authenticated', 'public.profiles', 'INSERT') IS TRUE,
    'authenticated can still insert a profile row at registration');
  PERFORM pg_temp.ok(
    has_table_privilege('anon', 'public.profiles', 'SELECT') IS FALSE,
    'anon has no direct read on profiles at all');

  RAISE NOTICE '--- grant catalog OK ---';
END $$;

-- Runtime: actually become `authenticated` and try it.
DO $$
DECLARE
  uid    UUID;
  denied BOOLEAN := FALSE;
  moved  BOOLEAN := FALSE;
BEGIN
  SELECT id INTO uid FROM public.profiles WHERE username = 'b_name';
  PERFORM pg_temp.as_uid(uid);

  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    EXECUTE 'UPDATE public.profiles SET username = ''renamed_in_console'' WHERE id = auth.uid()';
  EXCEPTION WHEN insufficient_privilege THEN denied := TRUE;
  END;
  EXECUTE 'RESET ROLE';

  PERFORM pg_temp.ok(denied,
    'as the authenticated role, a direct UPDATE of username is denied by the database');
  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = uid) = 'b_name',
    'and the name really did not move');

  -- The same statement shape against is_public must SUCCEED, or the
  -- assertion above is only telling us the role cannot write anything.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    EXECUTE 'UPDATE public.profiles SET is_public = TRUE WHERE id = auth.uid()';
    moved := TRUE;
  EXCEPTION WHEN OTHERS THEN moved := FALSE;
  END;
  EXECUTE 'RESET ROLE';

  PERFORM pg_temp.ok(moved,
    'as the authenticated role, updating is_public is still allowed');
  PERFORM pg_temp.ok(
    (SELECT is_public FROM public.profiles WHERE id = uid) IS TRUE,
    'and the visibility toggle really landed');

  -- An upsert is not a way round it either: ON CONFLICT DO UPDATE needs
  -- the UPDATE privilege on every column it writes.
  denied := FALSE;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    EXECUTE 'INSERT INTO public.profiles (id, username) VALUES (auth.uid(), ''upserted_name'')
             ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username';
  EXCEPTION WHEN insufficient_privilege THEN denied := TRUE;
  END;
  EXECUTE 'RESET ROLE';

  PERFORM pg_temp.ok(denied,
    'an upsert cannot smuggle a username past the column grant');
  PERFORM pg_temp.ok(
    (SELECT username FROM public.profiles WHERE id = uid) = 'b_name',
    'the name survived the upsert attempt');

  RAISE NOTICE '--- grant runtime OK ---';
END $$;

-- ── set_username is reachable from the client, and only it ──────
DO $$
BEGIN
  PERFORM pg_temp.ok(
    has_function_privilege('authenticated', 'public.set_username(TEXT)', 'EXECUTE') IS TRUE,
    'authenticated can call set_username');
  PERFORM pg_temp.ok(
    has_function_privilege('anon', 'public.set_username(TEXT)', 'EXECUTE') IS FALSE,
    'anon cannot call set_username — there is no anonymous username to set');

  -- SECURITY DEFINER without a pinned search_path resolves unqualified
  -- names against the caller's, as the owner.
  PERFORM pg_temp.ok(
    (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'set_username'),
    'set_username is SECURITY DEFINER');
  PERFORM pg_temp.ok(
    (SELECT 'search_path=public' = ANY(p.proconfig) FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'set_username'),
    'set_username pins search_path = public');

  PERFORM pg_temp.ok(
    EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'profiles'
               AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%lower(username%'),
    'the unique lower(username) index exists');

  RAISE NOTICE '--- posture OK ---';
END $$;

SELECT 'ALL SETTINGS CONTRACT TESTS PASSED' AS result;
