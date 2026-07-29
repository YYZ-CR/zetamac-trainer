-- Contract tests for supabase/signup.sql.
--
-- Written against the contract stated below BEFORE reading the
-- implementation, so a pass means the contract holds rather than that the
-- trigger does whatever it happens to do.
--
-- THE CONTRACT. Registration collects a username (js/auth.js) and the
-- account must end up holding it. Until now the client wrote the profile
-- itself, in a second call after signUp, and that call is refused by RLS
-- whenever signUp returns no session — which is what email confirmation
-- does. The username was silently dropped and the account reached the
-- daily with no profile row at all, where get_global_board correctly
-- refuses to rank it (leaderboards.sql §2). So:
--
--   1. A new auth.users row whose raw_user_meta_data carries a
--      well-formed `username` gets exactly one profiles row, with that
--      username, trimmed.
--   2. SIGNUP NEVER FAILS BECAUSE OF THE PROFILE. Every refusal — absent
--      metadata, wrong JSON type, bad shape, name already taken in any
--      case — leaves the auth.users row committed and simply writes no
--      profile. An account with no name is a bad outcome; an account that
--      could not be created at all is a worse one.
--   3. A refused name leaves the account able to claim one later through
--      set_username, which is the only other way in.
--   4. It does not spend the free rename: username_changed_at stays NULL,
--      so the first change through set_username is still free.
--   5. Metadata edited after the fact renames nobody. The trigger fires on
--      INSERT only — otherwise raw_user_meta_data, which the client can
--      write, would be a way around the 30-day cooldown.
--   6. Applying the file twice leaves exactly one trigger. These files are
--      pasted into the SQL editor by hand and will eventually be pasted
--      twice; two triggers would attempt the insert twice per signup.
--
-- Runs last; pg_temp.ok comes from 02-test.sql.
--
-- Every assertion is on a specific expected value. "A profile appeared"
-- and "did not error" are not evidence.

\set ON_ERROR_STOP on
SET client_min_messages = NOTICE;

-- What Supabase GoTrue does on registration: one INSERT into auth.users
-- carrying whatever the client passed as signUp's options.data. Nothing
-- else about a real signup is relevant to this trigger.
CREATE OR REPLACE FUNCTION pg_temp.signup(p_email TEXT, p_meta JSONB)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE uid UUID;
BEGIN
  INSERT INTO auth.users (email, raw_user_meta_data)
  VALUES (p_email, p_meta)
  RETURNING id INTO uid;
  RETURN uid;
END $$;

-- The username on an account, or NULL when it has no profile row. The two
-- are different outcomes and every test below distinguishes them.
CREATE OR REPLACE FUNCTION pg_temp.name_of(uid UUID)
RETURNS TEXT LANGUAGE sql AS $$
  SELECT username FROM public.profiles WHERE id = uid;
$$;

CREATE OR REPLACE FUNCTION pg_temp.as_uid_10(uid UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', uid::TEXT, FALSE);
END $$;

-- ── 1. The happy path ───────────────────────────────────────────
DO $$
DECLARE
  uid UUID;
  n   INTEGER;
BEGIN
  uid := pg_temp.signup('sg-happy@example.test', '{"username":"sghappy"}'::JSONB);

  PERFORM pg_temp.ok(pg_temp.name_of(uid) = 'sghappy',
    'a well-formed username in the signup metadata becomes the profile username');

  SELECT COUNT(*) INTO n FROM public.profiles WHERE id = uid;
  PERFORM pg_temp.ok(n = 1, 'exactly one profile row is created, not two');

  -- Rule 4. Taking the name at signup is not "a change", and starting an
  -- account inside a 30-day cooldown it never chose to spend would be a
  -- worse bug than the one this file fixes.
  PERFORM pg_temp.ok(
    (SELECT username_changed_at FROM public.profiles WHERE id = uid) IS NULL,
    'signup does not spend the free rename: username_changed_at stays null');

  -- The default from social.sql, not something the trigger invents.
  PERFORM pg_temp.ok(
    (SELECT is_public FROM public.profiles WHERE id = uid) IS FALSE,
    'a new profile is private by default');

  RAISE NOTICE '--- happy path OK ---';
END $$;

-- ── 2. Whitespace is trimmed, exactly as set_username trims it ──
DO $$
DECLARE uid UUID;
BEGIN
  uid := pg_temp.signup('sg-trim@example.test', '{"username":"  sgtrim  "}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) = 'sgtrim',
    'the username is trimmed before it is stored');

  -- The boundary cases, on the trimmed value: a name that is only long
  -- enough with its padding is too short, and one only too long with it
  -- is fine. Trimming has to happen before the shape rule, not after.
  uid := pg_temp.signup('sg-trim2@example.test', '{"username":"  ab  "}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) IS NULL,
    'padding does not make a 2-character name long enough');

  uid := pg_temp.signup('sg-trim3@example.test',
                        ('{"username":"  ' || repeat('a', 20) || '  "}')::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) = repeat('a', 20),
    'padding around a 20-character name does not make it too long');

  RAISE NOTICE '--- trimming OK ---';
END $$;

-- ── 3. Every refusal still creates the account ──────────────────
-- Rule 2, one row per way of getting it wrong. Each asserts BOTH halves:
-- no profile, and the auth.users row still there.
DO $$
DECLARE
  uid   UUID;
  cases JSONB[] := ARRAY[
    NULL,                                    -- no metadata at all
    '{}'::JSONB,                             -- metadata, no username key
    '{"username":null}'::JSONB,              -- JSON null
    '{"username":""}'::JSONB,                -- empty
    '{"username":"   "}'::JSONB,             -- whitespace only
    '{"username":"ab"}'::JSONB,              -- too short
    -- Built with repeat() rather than typed out: a literal run of a's is
    -- a length nobody can verify by eye, and 20 would silently turn this
    -- into a second happy-path test that passes for the wrong reason.
    ('{"username":"' || repeat('a', 21) || '"}')::JSONB,
    '{"username":"bad name"}'::JSONB,        -- space
    '{"username":"bad.name"}'::JSONB,        -- disallowed punctuation
    '{"username":"héllo"}'::JSONB       -- non-ASCII
  ];
  labels TEXT[] := ARRAY[
    'null metadata', 'no username key', 'json null', 'empty string',
    'whitespace only', 'too short', 'too long', 'a space',
    'disallowed punctuation', 'non-ascii'
  ];
  i INTEGER;
BEGIN
  FOR i IN 1 .. array_length(labels, 1) LOOP
    uid := pg_temp.signup('sg-bad-' || i || '@example.test', cases[i]);

    PERFORM pg_temp.ok(pg_temp.name_of(uid) IS NULL,
      format('%s writes no profile', labels[i]));
    PERFORM pg_temp.ok(
      EXISTS (SELECT 1 FROM auth.users WHERE id = uid),
      format('%s still creates the account', labels[i]));
  END LOOP;

  RAISE NOTICE '--- refusals do not block signup OK ---';
END $$;

-- A JSON number is not a username. `->>` would stringify 1234567 into a
-- name that passes every shape rule, so the type has to be checked before
-- the shape — and with IS DISTINCT FROM, because jsonb_typeof of a
-- missing key is NULL and NULL <> 'string' is NULL, not true.
DO $$
DECLARE uid UUID;
BEGIN
  uid := pg_temp.signup('sg-number@example.test', '{"username":1234567}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) IS NULL,
    'a JSON number is not stringified into a username');

  uid := pg_temp.signup('sg-array@example.test', '{"username":["sgarray"]}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) IS NULL,
    'a JSON array is not a username');

  uid := pg_temp.signup('sg-object@example.test', '{"username":{"a":"b"}}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) IS NULL,
    'a JSON object is not a username');

  RAISE NOTICE '--- json type checking OK ---';
END $$;

-- ── 4. A taken name is refused, and its owner is untouched ──────
-- The important half is the second one. A trigger that took the name from
-- whoever registered last would be an account-theft bug, not a bug about
-- leaderboards.
DO $$
DECLARE
  owner_id UUID;
  uid      UUID;
BEGIN
  owner_id := pg_temp.signup('sg-owner@example.test', '{"username":"sgtaken"}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(owner_id) = 'sgtaken', 'the first claimant gets the name');

  uid := pg_temp.signup('sg-thief@example.test', '{"username":"sgtaken"}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) IS NULL,
    'an exactly-taken name writes no profile for the second account');
  PERFORM pg_temp.ok(pg_temp.name_of(owner_id) = 'sgtaken',
    'and does not move the name off the account that holds it');

  -- settings.sql's unique index is on lower(username): SGTAKEN and
  -- sgtaken cannot coexist, and the trigger must not be the writer that
  -- gets to break that.
  uid := pg_temp.signup('sg-thief2@example.test', '{"username":"SGTAKEN"}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) IS NULL,
    'a name taken in a different case writes no profile either');
  PERFORM pg_temp.ok(
    (SELECT COUNT(*) FROM public.profiles WHERE lower(username) = 'sgtaken') = 1,
    'exactly one account holds the name, in any case');

  RAISE NOTICE '--- collisions OK ---';
END $$;

-- ── 5. A refused account can still claim a name afterwards ──────
-- Rule 3. This is the path every account created before this file is on,
-- so it has to work, and set_username is the only door.
DO $$
DECLARE
  uid UUID;
  r   JSONB;
BEGIN
  uid := pg_temp.signup('sg-later@example.test', '{"username":"no"}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) IS NULL, 'the too-short name was refused');

  PERFORM pg_temp.as_uid_10(uid);
  r := public.set_username('sglater');
  PERFORM pg_temp.ok((r->>'ok')::BOOLEAN IS TRUE,
    'an account the trigger refused can still claim a name through set_username');
  PERFORM pg_temp.ok(pg_temp.name_of(uid) = 'sglater',
    'and the name it claims is the one it asked for');
  PERFORM set_config('request.jwt.claim.sub', '', FALSE);

  RAISE NOTICE '--- later claim OK ---';
END $$;

-- ── 6. INSERT only ──────────────────────────────────────────────
-- Rule 5. raw_user_meta_data is client-writable through GoTrue's user
-- update endpoint. If the trigger fired on UPDATE, that endpoint would be
-- a rename that skips the cooldown, the case-collision rule and the
-- refusal codes — i.e. a second way in, when settings.sql's whole design
-- is that there is exactly one.
DO $$
DECLARE uid UUID;
BEGIN
  uid := pg_temp.signup('sg-update@example.test', '{"username":"sgbefore"}'::JSONB);
  PERFORM pg_temp.ok(pg_temp.name_of(uid) = 'sgbefore', 'named at signup');

  UPDATE auth.users SET raw_user_meta_data = '{"username":"sgafter"}'::JSONB
   WHERE id = uid;
  PERFORM pg_temp.ok(pg_temp.name_of(uid) = 'sgbefore',
    'editing the metadata afterwards does not rename the account');

  -- And the same for an account that has no profile: a later metadata
  -- edit must not become a way of claiming one either.
  uid := pg_temp.signup('sg-update2@example.test', NULL);
  UPDATE auth.users SET raw_user_meta_data = '{"username":"sgsneak"}'::JSONB
   WHERE id = uid;
  PERFORM pg_temp.ok(pg_temp.name_of(uid) IS NULL,
    'editing the metadata afterwards does not create a missing profile');

  RAISE NOTICE '--- insert-only OK ---';
END $$;

-- ── 7. Applied twice, one trigger ───────────────────────────────
-- run.sh re-applies the migrations for exactly this reason. Two triggers
-- would each attempt the insert; the second would hit ON CONFLICT and be
-- invisible here, so assert the count directly rather than inferring it
-- from a signup still working.
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'auth'
    AND c.relname  = 'users'
    AND NOT t.tgisinternal;

  PERFORM pg_temp.ok(n = 1,
    'exactly one non-internal trigger on auth.users after two applications');

  RAISE NOTICE '--- idempotency OK ---';
END $$;

DO $$ BEGIN RAISE NOTICE '=== 10-signup-test.sql: all assertions passed ==='; END $$;
