-- ────────────────────────────────────────────────────────────────
--  Settings — usernames become an identity you cannot quietly
--  rewrite. Apply by hand in the Supabase SQL Editor, AFTER
--  schema.sql, hardening.sql and social.sql.
--
--  hardening.sql is the hard dependency: §5 replaces a function it
--  defines, and re-applying hardening.sql afterwards would put the
--  old one back. social.sql is a dependency of §6 only — is_public
--  is the one column the client is still allowed to write, and
--  granting UPDATE on a column that does not exist yet is an error,
--  so this file goes last, as the README's table says.
--
--  WHY this file exists at all.
--
--  schema.sql's profiles_update policy is `USING (auth.uid() = id)`
--  and hardening.sql's only bound on the value is
--  `CHECK (char_length(username) BETWEEN 1 AND 40)`. Together those
--  mean any signed-in user can open the browser console and run
--
--    supabase.from('profiles').update({username:'…'}).eq('id', me)
--
--  as many times as they like, with any 1..40 characters they like.
--  That is not a privilege-escalation hole — you can only write your
--  own row — but it is an unintended capability, and the username is
--  now the identity that every leaderboard, league board and duel
--  names a person by. Three concrete consequences:
--
--    * name-squatting: a script can cycle one account through every
--      short name on release day and hold none of them accountably,
--      because nothing records that a rename happened;
--    * lookalike impersonation: `YangYang` and `yangyang` are two
--      different rows under a case-sensitive UNIQUE, and on a league
--      board rendered in a proportional font they are one person;
--    * unlimited renames: the name at the top of yesterday's board
--      is not the name at the top of it today, and there is no
--      record that they were ever the same account.
--
--  So: one function, `set_username`, is the only way a username is
--  ever set or changed, and the client's ability to write the column
--  directly is revoked at the COLUMN level in §6. A policy alone
--  cannot do this — `profiles_update` has to keep letting the owner
--  update the row so the is_public toggle still works, and a policy
--  cannot say "this column but not that one". Column grants can.
--
--  What set_username enforces, and why each rule is here:
--
--    trim, then 3..20 characters  — "  " is not a name; 1-2
--      characters is squattable in an afternoon; 40 characters does
--      not fit a board row.
--    [A-Za-z0-9_-] only           — no spaces, and no Unicode at
--      all. Confusables are the whole attack: `pаypal` with a
--      Cyrillic а renders identically to `paypal` in every font this
--      site uses. There is no safe subset of Unicode to allow here,
--      so none is allowed.
--    no case-only collisions      — enforced by a UNIQUE index on
--      lower(username) (§2), which is also what makes the check
--      race-safe rather than advisory.
--    30 days between changes      — the first name a user sets is
--      free (username_changed_at IS NULL); after that the clock
--      runs. A cooldown is what makes squatting expensive and makes
--      a board row mean something for longer than a day.
--
--  Refusals are RETURNED, not raised: `{ok:false, error:'…'}`. Every
--  other RPC in this project raises, but every refusal here is
--  something the person typing can fix, and the payload has to carry
--  next_change_allowed_at alongside the reason so the page can say
--  "you can change this again on the 3rd" rather than "no".
--
--  SET search_path = public on every SECURITY DEFINER function is
--  not decoration: without it, unqualified names resolve against the
--  CALLER's search_path, and a caller can shadow a table or an
--  operator with one of their own and have it run as the owner.
--
--  This file is idempotent: re-running it is the supported way to
--  deploy a change.
-- ────────────────────────────────────────────────────────────────

-- ── 1. Preflight: refuse to half-apply ──────────────────────────
-- §2 creates a UNIQUE index on lower(username). On a database that
-- already contains `YangYang` and `yangyang` that index cannot be
-- built, and the failure would land in the middle of the file with
-- the column added and the function missing.
--
-- So the check runs FIRST, before any DDL, and names the offending
-- values. Whoever is pasting this into the SQL editor has to decide
-- which of the two duplicates keeps the name — this file cannot
-- decide that, and a migration that picked one silently would be
-- renaming a stranger's account.
DO $$
DECLARE
  v_dupes TEXT;
BEGIN
  SELECT string_agg(d.names, '; ' ORDER BY d.names) INTO v_dupes
  FROM (
    SELECT lower(p.username) AS lowered,
           string_agg(p.username, ', ' ORDER BY p.username) AS names
    FROM public.profiles p
    GROUP BY lower(p.username)
    HAVING COUNT(*) > 1
  ) d;

  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'settings.sql not applied: these usernames differ only by case and cannot coexist under the unique index this file creates → %',
      v_dupes
      USING HINT =
        'Rename all but one of each group first (UPDATE public.profiles SET username = ... WHERE username = ...), then re-run this file. Nothing has been changed.';
  END IF;
END $$;

-- ── 2. The column, the index, and the shape ─────────────────────

-- NULL means "never changed", which is what makes the first set
-- free. It is deliberately not defaulted to NOW(): every account
-- that exists today registered before this rule did, and starting
-- all of them inside a cooldown would punish people for the schema
-- they happened to sign up under.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ;

-- The real guarantee behind the case-collision rule. Checking with a
-- SELECT inside set_username and then writing would be a
-- check-then-act race: two concurrent calls both see the name free
-- and both take it. This index is what makes the second one fail,
-- and set_username catches that failure rather than pre-empting it.
--
-- schema.sql's plain UNIQUE (username) stays: it is the exact-case
-- form of the same rule and costs nothing to keep.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower
  ON public.profiles (lower(username));

-- The shape rule, asserted at the table so it holds for every writer
-- and not only for set_username. It matters because INSERT stays
-- open to the client: registration (js/auth.js) creates the profile
-- row directly, and revoking that would break signup. The insert can
-- therefore still choose the FIRST username — which is exactly the
-- claim set_username would have allowed for free — but it can no
-- longer choose a shape set_username would have refused.
--
-- NOT VALID on purpose. Existing rows were written under the old
-- 1..40-characters-anything rule and some of them will not satisfy
-- this one; validating would abort the migration over data the
-- person applying it cannot fix from here. NOT VALID still enforces
-- the constraint on every INSERT and UPDATE from this moment on,
-- which is the part that matters — the old rows are grandfathered
-- and their owners get one free rename through set_username.
--
-- octet_length = char_length is not redundant with the character
-- ranges: PostgreSQL documents bracket-expression RANGES as
-- collation-dependent, so `[A-Za-z]` is not guaranteed to mean ASCII
-- letters under every collation. Byte length equal to character
-- length is guaranteed to mean "ASCII only" under UTF-8, and it is
-- the confusable-blocking half of the rule.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname  = 'profiles_username_shape'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_username_shape
      CHECK (
        username ~ '^[A-Za-z0-9_-]{3,20}$'
        AND octet_length(username) = char_length(username)
      ) NOT VALID;
  END IF;
END $$;

-- ── 3. The rules, as functions ──────────────────────────────────
-- Both are IMMUTABLE and both are readable in one screen, because
-- they are the two things a test and a client both need to agree
-- with, and a rule stated twice is a rule that drifts.

-- How long between changes. A function rather than a literal so the
-- contract tests assert the number the function body actually uses.
CREATE OR REPLACE FUNCTION public.username_cooldown_days()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT 30 $$;

REVOKE ALL ON FUNCTION public.username_cooldown_days() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.username_cooldown_days() TO anon, authenticated;

-- The reason a candidate is unacceptable, or NULL when it is fine.
-- Returns a CODE, not a sentence: the client owns the wording (see
-- USERNAME_REFUSALS in js/db.js) and a database that shipped English
-- prose would own it instead.
--
-- Order matters. "  " is empty, not too short, and "ab cd" is
-- invalid characters rather than acceptable-length — checking length
-- before characters means the user fixes one complaint at a time in
-- the order they would naturally read them.
CREATE OR REPLACE FUNCTION public.username_shape_error(p_username TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_username IS NULL OR btrim(p_username) = ''       THEN 'username_empty'
    WHEN char_length(btrim(p_username)) < 3                 THEN 'username_too_short'
    WHEN char_length(btrim(p_username)) > 20                THEN 'username_too_long'
    WHEN btrim(p_username) !~ '^[A-Za-z0-9_-]+$'            THEN 'username_invalid_chars'
    WHEN octet_length(btrim(p_username))
         <> char_length(btrim(p_username))                  THEN 'username_invalid_chars'
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.username_shape_error(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.username_shape_error(TEXT) TO anon, authenticated;

-- ── 4. set_username — the only way in ───────────────────────────
-- Returns, always:
--
--   { ok, username, next_change_allowed_at, error }
--
--   username                — the name in effect AFTER the call. On
--                             a refusal that is the name they still
--                             have, or null if they have none, so a
--                             page can re-render from the payload
--                             without a second read.
--   next_change_allowed_at  — when the next change becomes possible,
--                             or null when one is possible now. The
--                             page renders "you can change this
--                             again on …" straight from it.
--   error                   — a code from §3 plus 'username_taken',
--                             'username_cooldown',
--                             'username_requires_account'. Null on
--                             success.
--
-- RACE SAFETY, both directions:
--
--   Same user, two concurrent calls — pg_advisory_xact_lock keyed on
--   the caller's uid. Without it both calls read username_changed_at
--   before either writes it, both conclude the cooldown has expired,
--   and one 30-day cooldown buys two renames. The lock is
--   transaction-scoped, so it is released whether the function
--   returns or raises.
--
--   Two users, one name — the UNIQUE index on lower(username) from
--   §2, caught here as unique_violation. Deliberately NOT a
--   SELECT-then-INSERT: the pre-check below exists only to produce
--   'username_taken' without burning a subtransaction in the common
--   case, and it is the index, not the check, that decides. Remove
--   the pre-check and this function is still correct; remove the
--   index and it is not.
--
-- The write is one INSERT ... ON CONFLICT (id) DO UPDATE so both
-- states the app really has — an account with a profile row and an
-- account without one — go down the same path. It also means the
-- only unique_violation that can reach the handler is the username
-- one: a primary-key conflict is absorbed by ON CONFLICT.
CREATE OR REPLACE FUNCTION public.set_username(p_username TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_name      TEXT := btrim(COALESCE(p_username, ''));
  v_shape     TEXT;
  v_cur       TEXT;
  v_changed   TIMESTAMPTZ;
  v_has_row   BOOLEAN := FALSE;
  v_next      TIMESTAMPTZ;
  v_cooldown  INTERVAL := (public.username_cooldown_days() || ' days')::INTERVAL;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE, 'username', NULL,
      'next_change_allowed_at', NULL, 'error', 'username_requires_account');
  END IF;

  v_shape := public.username_shape_error(v_name);

  -- The caller's current state is read before the shape is rejected,
  -- so even a refusal can echo back the name they still have.
  PERFORM pg_advisory_xact_lock(74002, hashtext(v_uid::TEXT));

  SELECT p.username, p.username_changed_at
    INTO v_cur, v_changed
  FROM public.profiles p
  WHERE p.id = v_uid;
  v_has_row := FOUND;

  v_next := CASE WHEN v_changed IS NULL THEN NULL ELSE v_changed + v_cooldown END;

  IF v_shape IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE, 'username', v_cur,
      'next_change_allowed_at', v_next, 'error', v_shape);
  END IF;

  -- Setting the name you already have is a no-op, not a change. It
  -- must not burn a 30-day cooldown, because a page that re-submits
  -- its own prefilled input — a double-tapped Save, a browser
  -- restoring a form on reload — would otherwise cost the user a
  -- month for changing nothing. Case-sensitive on purpose:
  -- yangyang → YangYang IS a change, it is what the board will show.
  IF v_has_row AND v_cur = v_name THEN
    RETURN jsonb_build_object(
      'ok', TRUE, 'username', v_cur,
      'next_change_allowed_at', v_next, 'error', NULL);
  END IF;

  -- The cooldown. NULL username_changed_at means this account has
  -- never set a name through this function — either it has no
  -- profile row at all, or it has one from registration — and that
  -- first set is free.
  IF v_changed IS NOT NULL AND NOW() < v_next THEN
    RETURN jsonb_build_object(
      'ok', FALSE, 'username', v_cur,
      'next_change_allowed_at', v_next, 'error', 'username_cooldown');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE lower(p.username) = lower(v_name)
      AND p.id <> v_uid
  ) THEN
    RETURN jsonb_build_object(
      'ok', FALSE, 'username', v_cur,
      'next_change_allowed_at', v_next, 'error', 'username_taken');
  END IF;

  BEGIN
    INSERT INTO public.profiles AS p (id, username, username_changed_at)
    VALUES (v_uid, v_name, NOW())
    ON CONFLICT (id) DO UPDATE
      SET username            = EXCLUDED.username,
          username_changed_at = EXCLUDED.username_changed_at;
  EXCEPTION WHEN unique_violation THEN
    -- Someone else took it between the check above and this write.
    -- The index decided; this only reports what it decided.
    RETURN jsonb_build_object(
      'ok', FALSE, 'username', v_cur,
      'next_change_allowed_at', v_next, 'error', 'username_taken');
  END;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'username', v_name,
    'next_change_allowed_at', NOW() + v_cooldown,
    'error', NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.set_username(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_username(TEXT) TO authenticated;

-- ── 5. Availability, told the truth ─────────────────────────────
-- hardening.sql's username_available compares with `=`, so it
-- answers "yes, free" for `YangYang` when `yangyang` exists — and
-- then §2's index refuses the insert and the registration modal
-- reports "the username could not be saved" for a name it had just
-- said was available. Replaced here with the same signature and the
-- same grants, comparing the way the index does.
--
-- Note for whoever is pasting migrations: re-applying hardening.sql
-- AFTER this file puts the case-sensitive version back. Re-apply
-- this file to fix it. The README's order (hardening → … →
-- settings) is the order that leaves it right.
CREATE OR REPLACE FUNCTION public.username_available(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE lower(username) = lower(btrim(COALESCE(p_username, '')))
  );
$$;

REVOKE ALL ON FUNCTION public.username_available(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.username_available(TEXT) TO anon, authenticated;

-- ── 6. Column grants — the part that actually closes the door ───
-- Everything above is advice until this section runs. A SECURITY
-- DEFINER function is only "the only way" if the direct way is
-- withdrawn, and RLS cannot withdraw it: profiles_update has to keep
-- allowing the owner to update their row (the is_public toggle in
-- js/settings.js is a plain UPDATE), and a policy applies to the row,
-- not to the column.
--
-- Column-level grants are the tool that can. REVOKE first, because
-- Supabase grants ALL on every table in `public` to anon and
-- authenticated by default, and because revoking the table-level
-- UPDATE is what clears any column-level UPDATE grants that came
-- with it. Then hand back exactly what the client legitimately does:
--
--   SELECT  — js/db.js getProfile() reads the caller's own row;
--             profiles_select_own is what limits it to that row.
--   INSERT  — registration creates the profile row (js/auth.js
--             createProfile), and §2's CHECK constrains what it may
--             put in username.
--   UPDATE (is_public) — and nothing else. Not username, not
--             username_changed_at (which would reset the cooldown),
--             not id (which profiles_update's USING clause guards
--             anyway, but a grant that does not exist cannot be
--             reasoned about wrongly).
--
-- anon gets nothing at all. Every anonymous read of a profile in
-- this app goes through get_public_profile / username_available,
-- which are SECURITY DEFINER and return a fixed projection.
--
-- Verify on a live project with:
--   SELECT has_column_privilege('authenticated','public.profiles','username','UPDATE'),
--          has_column_privilege('authenticated','public.profiles','is_public','UPDATE');
--   → f, t
REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE ALL ON TABLE public.profiles FROM authenticated;

GRANT SELECT, INSERT            ON TABLE public.profiles TO authenticated;
GRANT UPDATE (is_public)        ON TABLE public.profiles TO authenticated;
