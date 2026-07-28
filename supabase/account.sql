-- ────────────────────────────────────────────────────────────────
--  Account deletion — one function, `delete_account`, and nothing
--  else. Apply by hand in the Supabase SQL Editor, LAST: after
--  schema.sql, hardening.sql, social.sql, daily.sql, duels.sql,
--  leagues.sql and settings.sql.
--
--  The ordering is not a preference. This file's body touches
--  game_sessions, profiles (schema.sql), daily_attempts (daily.sql),
--  duels and duel_runs (duels.sql), leagues and league_members
--  (leagues.sql) and auth.users. plpgsql resolves those names at
--  CALL time, not at CREATE time, so pasting this file early would
--  appear to succeed and then fail on the first real deletion — with
--  a half-deleted account, because the failure would land partway
--  down the ordered list below. settings.sql still goes before it
--  for settings.sql's own reason (it revokes column grants and
--  replaces a hardening.sql function), and nothing here undoes any
--  of that: this file creates one function and grants EXECUTE on it.
--
--  WHY THIS CANNOT BE `DELETE FROM auth.users`.
--
--  Every other table that names a user cleans itself up correctly on
--  the cascade. Two do not, and both failures are silent:
--
--    leagues.owner_id      ON DELETE CASCADE
--        The whole league disappears — its name, its members, its
--        board — because one member happened to be the one who
--        created it. Everyone else in that league loses a thing they
--        did not own and did not agree to lose. This is the
--        destructive one.
--
--    game_sessions.user_id ON DELETE SET NULL
--        The rows survive, unowned. They keep feeding the global
--        percentile in social.sql's get_score_percentile, so a
--        deleted account carries on moving everybody else's ranking
--        forever, and there is no longer any handle to find those
--        rows by.
--
--  So the work is done by hand, in order, and the auth.users row
--  goes LAST — at which point the remaining cascades (auth.identities,
--  auth.sessions, auth.refresh_tokens, and duels.opponent_id /
--  duel_runs.user_id, both SET NULL, which is what SHOULD happen to
--  a duel the caller merely played in) are the right behaviour and
--  are left to do their job.
--
--  A function body is one transaction. Either the account is gone
--  and every consequence above is settled, or nothing happened.
--
--  docs/account-deletion.md is the contract; this file implements it
--  and supabase/test/07-account-test.sql asserts it. If the league
--  rule below and public.leave_league (leagues.sql §9) ever disagree,
--  they are both wrong — see §1.
--
--  This file is idempotent: re-running it is the supported way to
--  deploy a change.
-- ────────────────────────────────────────────────────────────────

-- ── 1. delete_account ───────────────────────────────────────────
-- Returns, always:
--
--   { ok: true,  leagues_left, leagues_deleted, leagues_transferred,
--                duels_deleted, duel_slots_released,
--                daily_attempts_deleted, sessions_deleted }
--   { ok: false, error }
--
-- The counts are not for the client. They exist so a contract test
-- can assert that each step did the specific thing it claims to do —
-- a step that silently matched no rows is the failure mode this
-- function has, and "it returned ok" would hide every instance of it.
--
-- CONFIRMATION. p_confirm must be the caller's own username, trimmed
-- and compared case-insensitively; an account that has no username
-- confirms with the literal `DELETE`. This is not theatre and it is
-- not a client concern: it is the only thing standing between this
-- function and a mis-wired button, a double-fired submit handler or
-- a retried request. The call cannot succeed unless the caller
-- supplied a string that only the account holder is looking at. Note
-- there is deliberately no id parameter — the account deleted is
-- auth.uid() and there is no argument by which it could be anything
-- else.
--
-- A mismatch is RETURNED, not raised, the same way set_username
-- returns its refusals: a user error is a payload, an exception is a
-- programming error. An empty string is always a mismatch, including
-- for the pathological profile whose username is a single space.
--
-- LOCKING, and why there are two locks.
--
--   pg_advisory_xact_lock(74002, hashtext(uid)) — the SAME key
--   set_username takes, on purpose, and taken FIRST so the two
--   functions can never interleave. set_username's write is an
--   INSERT ... ON CONFLICT (id) DO UPDATE; against a concurrent
--   deletion its conflict target vanishes mid-flight and the insert
--   is retried as a plain insert against an auth.users row that is
--   being deleted — a foreign-key error surfacing out of a rename.
--   Serialised, one of the two simply happens first. The advisory
--   lock is also the only lock available for an account with no
--   profiles row, where there is no row to lock at all.
--
--   SELECT ... FOR UPDATE on profiles — so two concurrent deletes of
--   the same account cannot both run the league transfer below and
--   hand the same league to two different successors.
--
-- Both are transaction-scoped and released whether this returns or
-- raises.
CREATE OR REPLACE FUNCTION public.delete_account(p_confirm TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID    := auth.uid();
  v_confirm   TEXT    := lower(btrim(COALESCE(p_confirm, '')));
  v_username  TEXT;
  v_expected  TEXT;
  v_l         RECORD;
  v_removed   INTEGER;
  v_remaining INTEGER;
  v_new_owner UUID;
  v_left      INTEGER := 0;
  v_deleted   INTEGER := 0;
  v_transfer  INTEGER := 0;
  v_duels     INTEGER := 0;
  v_slots     INTEGER := 0;
  v_daily     INTEGER := 0;
  v_sessions  INTEGER := 0;
BEGIN
  -- EXECUTE is granted to `authenticated` only, so this is the second
  -- lock on the same door — but auth.uid() can still be NULL inside an
  -- authenticated request if a gateway ever forwards a token with no
  -- subject, and "delete the account identified by NULL" must not be
  -- allowed to mean "delete the rows whose user_id IS NULL", which is
  -- every anonymous game session on the site.
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'account_requires_account');
  END IF;

  PERFORM pg_advisory_xact_lock(74002, hashtext(v_uid::TEXT));

  -- ── Step 1: lock the caller's row and read the confirmation phrase
  -- No row is a real state — registration with email confirmation on
  -- can leave an account without a profile — and it is the state the
  -- literal `DELETE` exists for.
  SELECT p.username INTO v_username
  FROM public.profiles p
  WHERE p.id = v_uid
  FOR UPDATE;

  v_expected := lower(btrim(COALESCE(v_username, 'DELETE')));

  IF v_confirm = '' OR v_confirm IS DISTINCT FROM v_expected THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'confirm_mismatch');
  END IF;

  -- ── Step 2: leagues ───────────────────────────────────────────
  -- Exactly the rule public.leave_league implements, applied to every
  -- league the caller is in. It is duplicated rather than called:
  -- leave_league takes an invite code and raises league_not_member,
  -- and a loop over "every league" has neither a code to pass nor a
  -- membership to be missing. Both copies are asserted — by
  -- 05-leagues-test.sql and by the account suite — so a change to one
  -- that is not made to the other fails a test rather than shipping.
  --
  -- The order inside the loop is the whole of it, and it is
  -- leave_league's order: delete the membership FIRST, count the
  -- remainder AFTER. Counting first gets both endings wrong by one —
  -- a league of one would see "1 remaining" and survive as litter,
  -- and the succession query would find the departing owner and hand
  -- the league straight back to them.
  --
  -- The rows are locked in a deterministic order (by id) because two
  -- accounts deleting at the same instant are two transactions taking
  -- the same set of league locks; in any other order they can take
  -- them in opposite orders and deadlock.
  --
  -- The scan is `owner OR member`, not `member`. Every path in
  -- leagues.sql keeps the owner in the roster, so the two are the
  -- same set — but if they ever came apart, a league owned and not
  -- joined is precisely the row the owner_id CASCADE would destroy at
  -- step 7, which is the thing this whole file exists to prevent.
  FOR v_l IN
    SELECT l.id, l.owner_id
    FROM public.leagues l
    WHERE l.owner_id = v_uid
       OR EXISTS (
         SELECT 1 FROM public.league_members m
         WHERE m.league_id = l.id AND m.user_id = v_uid
       )
    ORDER BY l.id
    FOR UPDATE OF l
  LOOP
    DELETE FROM public.league_members
    WHERE league_id = v_l.id AND user_id = v_uid;

    GET DIAGNOSTICS v_removed = ROW_COUNT;
    v_left := v_left + v_removed;

    SELECT COUNT(*)::INTEGER INTO v_remaining
    FROM public.league_members m WHERE m.league_id = v_l.id;

    IF v_remaining = 0 THEN
      -- Nobody left. A league with no members is litter and its key
      -- stops resolving, which is the observable half of that.
      -- league_members cascades; there is nothing else to clean up.
      DELETE FROM public.leagues WHERE id = v_l.id;
      v_deleted := v_deleted + 1;

    ELSIF v_l.owner_id = v_uid THEN
      -- Longest-standing remaining member inherits. ORDER BY
      -- joined_at, then user_id, so two members added inside one
      -- transaction — a seed, a backfill — still produce one
      -- deterministic successor rather than an arbitrary one. This
      -- tie-break is byte-for-byte leave_league's.
      SELECT m.user_id INTO v_new_owner
      FROM public.league_members m
      WHERE m.league_id = v_l.id
      ORDER BY m.joined_at ASC, m.user_id ASC
      LIMIT 1;

      UPDATE public.leagues SET owner_id = v_new_owner WHERE id = v_l.id;
      v_transfer := v_transfer + 1;
    END IF;
  END LOOP;

  -- ── Step 3: duels the caller created ──────────────────────────
  -- Deleted, with both sides' runs (duel_runs cascades from duels).
  --
  -- Stated plainly because it costs somebody else something: if an
  -- opponent played this duel, their result goes too. A duel is the
  -- creator's object — their key, their question sequence, their
  -- 48-hour clock — and it is reachable only by its own URL. A link
  -- owned by a deleted account resolving to "no such duel" is
  -- coherent; a result page comparing a score against a player who no
  -- longer exists is not.
  DELETE FROM public.duels WHERE creator_id = v_uid;
  GET DIAGNOSTICS v_duels = ROW_COUNT;

  -- ── Step 4: duels the caller only played in ───────────────────
  -- Kept. The creator's result is theirs and does not depend on the
  -- opponent still having an account; duels.opponent_id and
  -- duel_runs.user_id are both ON DELETE SET NULL, so step 7 leaves a
  -- finished run with its score and no owner, and the opponent
  -- renders as a deleted account rather than vanishing out of the
  -- middle of a comparison. Nothing to do here for those.
  --
  -- The exception is a slot claimed and never finished. That run has
  -- no result anyone can read, and leaving the claim behind would
  -- park the creator's link on an opponent who cannot come back: the
  -- duel would sit `open` until it expired, unplayable by anyone.
  -- So the claim is released and the empty run row removed, and the
  -- link is live again for whatever remains of its 48 hours.
  --
  -- "Never finished" is status = 'in_progress' and nothing else. An
  -- `expired` run IS a result — duel_refresh closes it at whatever
  -- was submitted, which may be zero, and the creator may already
  -- have seen the comparison — and re-opening a duel whose clock has
  -- run out would not give anybody a playable link anyway. The
  -- NOT EXISTS shape also covers the impossible-but-cheap case of a
  -- claim with no run row at all.
  --
  -- One statement, two writes: the UPDATE names the duels and the
  -- data-modifying CTE deletes exactly those runs. A data-modifying
  -- CTE always executes, referenced or not, and both halves see the
  -- same snapshot, so the run rows cannot be missed by a duel the
  -- UPDATE has just released.
  WITH released AS (
    UPDATE public.duels d
    SET opponent_id = NULL
    WHERE d.opponent_id = v_uid
      AND NOT EXISTS (
        SELECT 1 FROM public.duel_runs r
        WHERE r.duel_id = d.id
          AND r.side    = 'opponent'
          AND r.status IS DISTINCT FROM 'in_progress'
      )
    RETURNING d.id
  ), dropped AS (
    DELETE FROM public.duel_runs r
    USING released x
    WHERE r.duel_id = x.id AND r.side = 'opponent'
  )
  SELECT COUNT(*)::INTEGER INTO v_slots FROM released;

  -- ── Step 5: daily attempts ────────────────────────────────────
  -- Off every daily leaderboard, including past days. The cascade
  -- would do this one correctly on its own; it is written out because
  -- a reader of this function should not have to go and check which
  -- of the seven tables were left to the cascade and why.
  DELETE FROM public.daily_attempts WHERE user_id = v_uid;
  GET DIAGNOSTICS v_daily = ROW_COUNT;

  -- ── Step 6: game sessions ─────────────────────────────────────
  -- Deleted, NOT orphaned. This is the second of the two reasons this
  -- function exists: the FK is ON DELETE SET NULL, and unowned rows
  -- keep feeding get_score_percentile.
  DELETE FROM public.game_sessions WHERE user_id = v_uid;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  -- ── Step 7: the identity itself ───────────────────────────────
  -- The profile first, which is what frees the username for whoever
  -- wants it next, then the auth.users row, whose cascades are now
  -- all the correct ones.
  --
  -- This DELETE is the reason the function is SECURITY DEFINER: the
  -- `authenticated` role has no rights in the auth schema at all. The
  -- owner of this function does — it is the role the SQL editor runs
  -- as — and the only account it will ever delete is auth.uid()'s.
  DELETE FROM public.profiles WHERE id = v_uid;
  DELETE FROM auth.users WHERE id = v_uid;

  RETURN jsonb_build_object(
    'ok',                     TRUE,
    'leagues_left',           v_left,
    'leagues_deleted',        v_deleted,
    'leagues_transferred',    v_transfer,
    'duels_deleted',          v_duels,
    'duel_slots_released',    v_slots,
    'daily_attempts_deleted', v_daily,
    'sessions_deleted',       v_sessions
  );
END;
$$;

-- No grant to `anon`: there is no anonymous account to delete, and an
-- anon caller reaching this function could only ever be a bug or an
-- attempt. REVOKE first because CREATE OR REPLACE on a NEW function
-- grants EXECUTE to PUBLIC by default, which would hand it to anon
-- through the PUBLIC role regardless of what is granted below.
REVOKE ALL ON FUNCTION public.delete_account(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_account(TEXT) TO authenticated;
