-- ════════════════════════════════════════════════════════════
-- signup.sql — the username is written at registration
-- ════════════════════════════════════════════════════════════
--
-- APPLY AFTER settings.sql. It calls username_shape_error(), which that
-- file defines, and it writes profiles.username, whose shape constraint
-- and case-insensitive unique index that file adds. Applied before it,
-- the trigger below would be created successfully and fail on the first
-- real registration.
--
-- ── The bug this fixes ──────────────────────────────────────────
--
-- Registration collects a username (js/auth.js) and then wrote it in a
-- SECOND call, after signUp:
--
--     await supabaseClient.auth.signUp({ email, password });
--     await createProfile(data.user.id, username);   -- a plain INSERT
--
-- That insert is checked by RLS against auth.uid(), and with email
-- confirmation enabled signUp returns a user but NO session — so
-- auth.uid() is null, the insert is refused, and the account exists with
-- no profile row and no username. The client said so and moved on, and
-- nothing ever retried: js/dashboard.js offers to claim a name, but only
-- to somebody who visits the dashboard. Go straight to the daily and you
-- can play indefinitely with no name.
--
-- Downstream, get_global_board drops every run it cannot attribute to a
-- username (leaderboards.sql §2, deliberately and before ranking). That
-- is the right behaviour and is not what changes here: three of four
-- attempts on the 2026-07-29 daily came from accounts in this state, and
-- the board was correct to hide runs it could not name. The defect is
-- upstream, in the account never getting the name its owner typed.
--
-- ── The fix ─────────────────────────────────────────────────────
--
-- Carry the username WITH the signup — js/auth.js now passes it as
-- signUp's options.data, which GoTrue stores on auth.users.raw_user_meta_
-- data — and create the profile from a trigger on auth.users. That makes
-- the profile a consequence of the account existing rather than a second
-- request that may never be sent, and it runs SECURITY DEFINER, so it
-- does not care whether the registrant has a session yet.
--
-- ── The rule that governs the whole file ────────────────────────
--
-- SIGNUP MUST NEVER FAIL BECAUSE OF THE PROFILE. An AFTER INSERT trigger
-- runs inside GoTrue's transaction: an exception escaping this function
-- does not merely skip the profile, it rolls the registration back and
-- the user sees a database error instead of an account. Every refusal
-- path here therefore returns NEW quietly and leaves the account with no
-- profile — recoverable at leisure through set_username. An account with
-- no name is a bad outcome; an account that could not be created at all
-- is a worse one, and the two are one `RAISE` apart.
--
-- ── What it deliberately does not do ────────────────────────────
--
-- It does not fire on UPDATE. raw_user_meta_data is writable by the
-- client through GoTrue's user-update endpoint, so an ON UPDATE trigger
-- would be a rename that skips the 30-day cooldown, the case-collision
-- rule and the refusal codes — a second way in, when settings.sql's
-- entire design is that set_username is the only one.
--
-- It does not set username_changed_at. Taking a name at registration is
-- not a change, and starting every new account inside a cooldown it never
-- chose to spend would be a worse bug than the one being fixed.
--
-- It does not backfill the accounts that are already nameless. Their
-- raw_user_meta_data never carried a username — the client did not send
-- one until this change — so there is nothing to backfill from. They
-- claim a name through set_username like anyone else.
--
-- Contract tests: supabase/test/10-signup-test.sql.

-- ── 0. Preflight ────────────────────────────────────────────────
-- plpgsql resolves the names in a function body at CALL time, so a
-- trigger created before settings.sql looks fine and fails on the first
-- registration — the one failure mode this file cannot tolerate. Fail
-- here instead, while nothing has been changed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'username_shape_error'
  ) THEN
    RAISE EXCEPTION 'signup.sql needs public.username_shape_error(), which supabase/settings.sql defines'
      USING HINT = 'Apply supabase/settings.sql first, then this file. Nothing has been changed.';
  END IF;
END $$;

-- ── 1. handle_new_user ──────────────────────────────────────────
-- Runs once per registration, inside GoTrue's transaction.
--
-- SECURITY DEFINER because the point of the file is to write a profile
-- for a registrant who has no session yet, and so no auth.uid() for
-- profiles' RLS policy to match. SET search_path = public because
-- without it the unqualified names in the body would resolve against the
-- caller's search_path — and the caller here is the auth system, not a
-- session this file controls.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::JSONB);
  v_name TEXT;
BEGIN
  -- The type check comes first, and it is IS DISTINCT FROM rather than
  -- <>. `->` on a missing key returns SQL NULL, jsonb_typeof(NULL) is
  -- NULL, and NULL <> 'string' is NULL — which is not true, so a plain
  -- <> would fall through on exactly the commonest input, an account
  -- registered with no metadata at all. This repo has shipped that bug
  -- once already (see CLAUDE.md).
  --
  -- The check is on the TYPE and not only the value because ->> would
  -- happily stringify the JSON number 1234567 into a name that satisfies
  -- every shape rule. options.data is client-controlled; it gets the
  -- same treatment as any other client input.
  IF jsonb_typeof(v_meta -> 'username') IS DISTINCT FROM 'string' THEN
    RETURN NEW;
  END IF;

  -- btrim before the shape check, matching set_username: a name that is
  -- only long enough with its padding is too short.
  v_name := btrim(v_meta ->> 'username');

  -- One rule, stated once, in settings.sql §3 — the same function
  -- set_username and the client both go through. A second copy of
  -- "3..20 characters, [A-Za-z0-9_-]" here is a rule that would drift.
  IF public.username_shape_error(v_name) IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    -- ON CONFLICT (id) for the profile that somehow already exists;
    -- the username collision is left to the unique index and caught
    -- below, because a pre-check would be a check-then-act race and the
    -- index is the only real guarantee. Both are non-fatal: a taken
    -- name costs this account its name, never its registration.
    INSERT INTO public.profiles (id, username)
    VALUES (NEW.id, v_name)
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION
    -- Deliberately broad, and deliberately loud. Narrowing this to
    -- unique_violation would let some unforeseen error — a constraint
    -- added later, a table renamed — abort registration itself, which
    -- is the one outcome this file exists to prevent. The WARNING is
    -- what keeps "broad" from meaning "silent": it lands in the
    -- Postgres logs with the account id, so a systematic failure here
    -- is discoverable rather than showing up as an empty leaderboard
    -- weeks later.
    WHEN OTHERS THEN
      RAISE WARNING 'handle_new_user: no profile for % (%): %',
        NEW.id, SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- Not a callable API. PostgreSQL checks EXECUTE on a trigger function
-- when the trigger is CREATED, not when it fires, so revoking here does
-- not affect registration; it only stops a client from invoking it
-- directly. supabase_auth_admin is granted anyway, because it owns
-- auth.users and a wrong guess about that check would break every
-- signup — the grant costs nothing and removes the doubt.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin';
  END IF;
END $$;

-- ── 2. The trigger ──────────────────────────────────────────────
-- DROP then CREATE, so a second application replaces the trigger rather
-- than adding a second one that attempts the insert again. CREATE OR
-- REPLACE TRIGGER exists only from PostgreSQL 14 and this file should
-- apply to older projects too.
--
-- AFTER INSERT, not BEFORE: the profiles row carries a foreign key to
-- auth.users(id), so the user must already be there.
DO $$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users';
  EXECUTE 'CREATE TRIGGER on_auth_user_created
             AFTER INSERT ON auth.users
             FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'signup.sql could not create its trigger on auth.users: %', SQLERRM
      USING HINT = 'Run this file in the Supabase SQL editor, which connects as postgres. A pooled or restricted role cannot add triggers to auth.users. Nothing has been changed.';
END $$;
