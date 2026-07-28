-- ────────────────────────────────────────────────────────────────
--  Private leagues — a named group, an invite code, and its own
--  board over the daily. Apply by hand in the Supabase SQL Editor,
--  AFTER schema.sql, hardening.sql, social.sql, daily.sql and
--  duels.sql. The contract this implements is docs/leagues-design.md;
--  if the two ever disagree, the doc is the spec and this is the bug.
--
--  daily.sql is a hard dependency, not an ordering preference. The
--  board is *over the daily* — daily_attempts is the only comparison
--  in this product that is already fair (same questions, one attempt,
--  server-timed), and this file reads that table rather than inventing
--  a second notion of a score. daily_today() is called rather than
--  re-deriving "today", because a league board that disagreed with the
--  daily page about which day it is would be a bug nobody could
--  reproduce.
--
--  Two sentences from the design govern everything below:
--
--    *membership is the privacy boundary* — so get_league (the join
--    screen) returns a name and a COUNT, and get_league_board returns
--    the roster and refuses anyone who is not in the league. An invite
--    code is a way to join, not a directory of who has already joined.
--    There is exactly one membership test (§4, league_is_member) and
--    every reader goes through it.
--
--    *a league of six where two are missing should look like a league
--    of six* — so the board is built from league_members LEFT JOINed
--    to daily_attempts, never from the attempts inward. A member with
--    no attempt appears with a null score, played=false, and shares
--    last place with every other member who has not played.
--
--  Which is why RLS is enabled on both tables with NO policies at all.
--  That is not an oversight and not a TODO. The anon key ships in
--  js/config.js, so any policy permissive enough to serve a board to a
--  member is a policy permissive enough to hand the roster of every
--  private league to anyone holding the key. Every read and write goes
--  through the SECURITY DEFINER functions below, which decide what a
--  caller may see from that caller's own membership.
--
--  Everything here is granted to `authenticated` and to nothing else.
--  A league is a group of known people; an anonymous member is neither
--  known nor addressable, and there is no anonymous surface to get
--  right. This is the one place in the roadmap where requiring signup
--  is correct rather than costly.
--
--  SET search_path = public on every function is not decoration. A
--  SECURITY DEFINER function without it resolves unqualified names
--  against the *caller's* search_path, which lets a caller shadow a
--  table or operator with one of their own and run it as the owner.
--
--  On the two traps this repo has already paid for once each:
--  nothing in this file accepts a JSONB payload from a client, so the
--  `jsonb_typeof(NULL) <> 'x'` hazard has no foothold here — the only
--  client-supplied values are TEXT and they are normalised in §3. The
--  volatile-draw hazard does apply, to key generation, and §3 says
--  where and why the shape used there is immune to it.
--
--  This file is idempotent: re-running it is the supported way to
--  deploy a change.
-- ────────────────────────────────────────────────────────────────

-- ── 1. Tables ───────────────────────────────────────────────────
-- One row per league. `league_key` is the invite code and the only
-- handle any RPC in this file accepts; ids never cross the API
-- boundary.
--
-- owner_id is a real column rather than "whoever joined first",
-- because ownership moves (see §9) and a derived owner could not.
-- ON DELETE CASCADE on owner_id means deleting an account deletes the
-- leagues it owns outright — which is what the design's schema says,
-- and is the right reading of "a league with no owner is
-- unreachable": rather than leave one behind, it goes.
CREATE TABLE IF NOT EXISTS public.leagues (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE both because it is the lookup key and because the retry
  -- loop in §7 relies on the constraint to detect a collision rather
  -- than on a racy pre-check.
  league_key TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  owner_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per member per league.
--
-- PRIMARY KEY (league_id, user_id) is what makes double-joining a
-- no-op rather than a duplicate row. Enforcing that in the RPC
-- instead would mean enforcing it nowhere: two concurrent
-- join_league calls would both see no membership and both insert
-- one, and the second would silently overwrite the first's joined_at
-- — which is the value ownership transfer is ordered by.
--
-- There is deliberately no surrogate id. The composite key IS the
-- identity of a membership, so every statement below keys on
-- (league_id, user_id) and cannot address anything else.
CREATE TABLE IF NOT EXISTS public.league_members (
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES auth.users(id)     ON DELETE CASCADE,
  -- Written exactly once, by the INSERT in §8, and never updated.
  -- "Longest-standing remaining member" in §9 is only meaningful
  -- because nothing in this file can move it — a re-join that reset
  -- it would let a member jump the succession queue by leaving and
  -- rejoining, which is backwards.
  --
  -- clock_timestamp(), not NOW(). NOW() is the *transaction*
  -- timestamp and is frozen for the whole transaction, so two members
  -- added in one transaction — a seed script, a backfill, a future
  -- "invite these five people" RPC — would carry byte-identical
  -- joined_at values and the succession order in §9 would collapse
  -- onto its tie-break, which is deterministic but arbitrary. The
  -- wall clock at the moment of the INSERT is the fact this column is
  -- supposed to record, and it is the fact ownership transfer needs.
  joined_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (league_id, user_id)
);

-- Re-runnability for a database that already has an older shape of
-- these tables. CREATE TABLE IF NOT EXISTS is a no-op on an existing
-- table — it does not reconcile columns or constraints — so anything
-- that carries a product rule has to be (re-)asserted explicitly, and
-- ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  -- A league name is rendered on someone else's screen. The lower
  -- bound stops an invisible league, the upper bound stops a name
  -- that is really a paragraph. §7 trims and checks before inserting;
  -- the constraint is what makes that a fact about the database
  -- rather than a fact about one function.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.leagues'::REGCLASS
      AND conname  = 'leagues_name_length'
  ) THEN
    ALTER TABLE public.leagues
      ADD CONSTRAINT leagues_name_length
      CHECK (char_length(name) BETWEEN 1 AND 60);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.league_members'::REGCLASS
      AND conname  = 'league_members_pkey'
  ) THEN
    ALTER TABLE public.league_members
      ADD CONSTRAINT league_members_pkey
      PRIMARY KEY (league_id, user_id);
  END IF;
END $$;

-- ── 2. RLS: on, and deliberately empty ──────────────────────────
-- Enabled with zero policies, which denies every row to every
-- non-owner role. The SECURITY DEFINER functions below run as the
-- table owner and are therefore unaffected; PostgREST's anon and
-- authenticated roles get nothing directly.
--
-- league_members is the sensitive table: it maps a league key to a
-- list of user ids, which is exactly the roster the design says a
-- non-member must not have. A direct SELECT would defeat every check
-- in this file at once.
--
-- Note this is ENABLE, not FORCE: FORCE would subject the owner to
-- RLS too, and with no policies that would lock out the functions
-- themselves.
ALTER TABLE public.leagues        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_members ENABLE ROW LEVEL SECURITY;

-- Belt and braces. Supabase's default privileges grant the API roles
-- table-level rights in `public`, and while RLS would deny the rows
-- anyway, a future policy added in haste should not silently become a
-- public read of every roster. Revoking the grant means such a policy
-- still has nothing to apply to.
REVOKE ALL ON TABLE public.leagues        FROM anon, authenticated;
REVOKE ALL ON TABLE public.league_members FROM anon, authenticated;

-- ── 3. Invite codes ─────────────────────────────────────────────
-- The alphabet is 30 characters:
--
--   23456789 ABCDEFGHJKMNPQRSTVWXYZ
--
-- Digits 0 and 1 and letters I, L, O are absent because this code
-- gets read down a desk, dictated over a call, and copied off a
-- whiteboard — 0/O and 1/l/I are the pairs that actually get
-- transcribed wrong. U is absent for Crockford's reason: with U
-- excluded, a randomly drawn code cannot spell an obscenity, and a
-- league invite that does is a support ticket. Case is not
-- significant on input (§3, league_normalize_key) because nobody
-- reads case aloud.
--
-- Note what falls out of that choice: because 0, 1, I, L, O and U
-- never occur in a real key, a caller who types one has unambiguously
-- mistyped, and the lookup simply fails. There is nothing to guess at
-- and no substitution table to get wrong.
--
-- Length is 10, which is log2(30^10) ≈ 49.1 bits — deliberately in
-- the same range as the 48-bit duel key in duels.sql, and for a
-- stronger reason. A guessed duel key wins you one side of one duel.
-- A guessed league key wins you a *roster*: real usernames and their
-- daily scores, which is precisely the thing membership is supposed
-- to gate. Enumerating a league key must therefore not be cheaper
-- than enumerating a duel key, so it is not. The cost is four
-- characters over a 6-character code, and speakability comes from the
-- alphabet rather than from being short.
--
-- Built from gen_random_uuid() rather than random(): random() is a
-- non-cryptographic PRNG and this string is a capability. Taking ten
-- bytes of a 122-bit CSPRNG value keeps the file extension-free —
-- gen_random_uuid() is core since PostgreSQL 13, gen_random_bytes()
-- would need pgcrypto.
--
-- Which bytes is not arbitrary. gen_random_uuid() returns a version-4
-- UUID: 128 bits of which six are FIXED — the high nibble of byte 6
-- is the version (always 0x4) and the top two bits of byte 8 are the
-- variant (always 0b10). Byte 6 therefore only ever takes 16 values,
-- and folding it into a 30-letter alphabet yields 16 of the 30
-- glyphs, never the other 14 — a character that carries 4 bits
-- instead of 4.9 and a visibly skewed position in every code the
-- product ever prints. Byte 8 is 64 consecutive values, which covers
-- all 30 residues but not evenly. So both are skipped and the ten
-- characters are drawn from the ten fully random bytes 0-5, 7 and
-- 9-11. (This was not theoretical: a per-position glyph-count test
-- over 3,000 generated keys showed position 7 stuck at exactly 16.)
--
-- On the trap: the uuid is drawn in a FROM-clause subquery and the
-- per-character expression references g.i, so the draw is correlated
-- with the row it feeds. The failure mode this repo has already paid
-- for — `CROSS JOIN LATERAL (SELECT random() ...)` with no reference
-- to the outer row, which the planner evaluates once so every row
-- comes out identical — cannot occur here in either direction: if the
-- planner evaluates the subquery once, the ten characters still come
-- from ten *different* bytes of it; if it pulls it up and re-evaluates
-- per row, they come from ten different uuids. Both are uniform. The
-- % 30 fold over a 256-value byte is very slightly biased (values
-- below 16 are drawn 9/256 rather than 8/256), which costs a few
-- thousandths of a bit per character and is not worth a rejection
-- loop.
CREATE OR REPLACE FUNCTION public.league_new_key()
RETURNS TEXT
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT string_agg(
           substr('23456789ABCDEFGHJKMNPQRSTVWXYZ',
                  1 + (get_byte(b.raw, g.i) % 30), 1),
           '' ORDER BY g.ord)
  FROM (SELECT decode(replace(gen_random_uuid()::TEXT, '-', ''), 'hex') AS raw) b,
       -- Bytes 6 and 8 are absent: they carry the v4 version and
       -- variant bits and are not fully random. See above.
       unnest(ARRAY[0, 1, 2, 3, 4, 5, 7, 9, 10, 11]) WITH ORDINALITY AS g(i, ord);
$$;

-- Internal. Not granted: a caller with no league to create has no use
-- for a key generator.
REVOKE ALL ON FUNCTION public.league_new_key() FROM PUBLIC;

-- What a typed or pasted invite code means.
--
-- Uppercased, and everything that is not a letter or a digit removed,
-- so "  wpq7-k3nd rx " and "wpq7k3ndrx" are the same league. People
-- paste codes with the surrounding punctuation of wherever they found
-- them, and a lookup that failed on a trailing space would look like
-- a broken invite.
--
-- Returns NULL — "no key at all" — for an empty result or for
-- anything implausibly long, so a caller cannot make the database
-- hash a megabyte by pasting one. NULL is then a single "not found"
-- path in every RPC below rather than a special case in each.
--
-- IMMUTABLE and pure: it reads no tables and no clock, which is also
-- what makes it directly testable.
CREATE OR REPLACE FUNCTION public.league_normalize_key(p_key TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT k FROM (
    SELECT NULLIF(upper(regexp_replace(COALESCE(p_key, ''), '[^0-9A-Za-z]', '', 'g')),
                  '') AS k
  ) s
  WHERE char_length(s.k) <= 32;
$$;

REVOKE ALL ON FUNCTION public.league_normalize_key(TEXT) FROM PUBLIC;

-- ── 4. Caps and membership ──────────────────────────────────────
-- The two caps, as functions rather than as literals sprinkled
-- through §7-§9. Both bound the board query and stop a single account
-- creating unbounded rows, and a cap that lives in the client is not
-- a cap — the client cannot be trusted to count.
--
-- 100 members: past this a leaderboard is a phone book, and the board
-- query is O(members × scope), so the cap is also what keeps it cheap
-- enough to run on every page load.
CREATE OR REPLACE FUNCTION public.league_max_members()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT 100; $$;

REVOKE ALL ON FUNCTION public.league_max_members() FROM PUBLIC;

-- 20 leagues per account, counted as memberships — a league you own
-- is one you are in, so creating and joining draw on the same
-- allowance. Counting them separately would let one account hold 40.
CREATE OR REPLACE FUNCTION public.league_max_per_user()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT 20; $$;

REVOKE ALL ON FUNCTION public.league_max_per_user() FROM PUBLIC;

-- THE privacy boundary, in one function, so there is one
-- implementation to audit rather than three that must agree.
--
-- Total by construction: a NULL user (no session) or a NULL league is
-- not a member, rather than an undecidable NULL that an IF would
-- treat as false in one caller and an AND chain would propagate in
-- another.
CREATE OR REPLACE FUNCTION public.league_is_member(p_league_id UUID, p_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_league_id IS NOT NULL
     AND p_uid IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.league_members m
                 WHERE m.league_id = p_league_id AND m.user_id = p_uid);
$$;

REVOKE ALL ON FUNCTION public.league_is_member(UUID, UUID) FROM PUBLIC;

-- ── 5. The public face of a league ──────────────────────────────
-- Everything about a league that a caller holding its key is allowed
-- to see, and nothing else. get_league and join_league both return
-- this, so the join screen and the confirmation after joining cannot
-- drift apart.
--
-- What it deliberately never emits, in any state:
--
--   the roster   — the entire point. A member count answers "is this
--                  worth joining"; a list of usernames answers "who
--                  do I know here", which is a question only a member
--                  gets to ask. §12 is the only function in this file
--                  that emits the membership.
--   id, owner_id, user_id, emails — a league is a code, not a
--                  directory.
--
-- One name IS emitted: owner_username. An invite that cannot say who
-- is inviting you reads as spam, and "Desk Six, owned by hexadecimal,
-- 6 members" is the whole content of a join screen. One name is not a
-- directory — it is the single fact that makes the code trustworthy —
-- and it does not move the boundary the design draws: a non-member
-- still cannot enumerate the other five.
--
-- Note it is NOT gated on profiles.is_public, and that is deliberate
-- rather than an oversight. is_public governs whether a profile PAGE
-- is readable by strangers (social.sql, get_public_profile); it has
-- never meant "this username is a secret". A league naming its own
-- owner to somebody holding its invite code is the league speaking
-- about itself, not the profile system publishing anyone. The board
-- in §12 carries is_public per row for the one thing it does control:
-- whether a name may be LINKED to that page.
--
-- STABLE: it writes nothing. There is no lazy state to settle here —
-- unlike a duel, a league has no clock.
CREATE OR REPLACE FUNCTION public.league_public_payload(
  p_league_id UUID,
  p_uid       UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_l     public.leagues%ROWTYPE;
  v_n     INTEGER;
  v_owner TEXT;
BEGIN
  IF p_league_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_l FROM public.leagues WHERE id = p_league_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_n
  FROM public.league_members m WHERE m.league_id = v_l.id;

  -- A plain SELECT that may find nothing: an owner with no profile
  -- row leaves v_owner NULL and the league is still returned. Dropping
  -- the league instead would make a rare, unrelated data gap look like
  -- a dead invite code.
  SELECT p.username INTO v_owner
  FROM public.profiles p WHERE p.id = v_l.owner_id;

  RETURN jsonb_build_object(
    'league_key',   v_l.league_key,
    'name',         v_l.name,
    -- Who is inviting you. See the note above on why is_public does
    -- not gate this.
    'owner_username', v_owner,
    'member_count', v_n,
    -- The two facts a join screen needs: whether the button should
    -- say "Join" or "Open", and whether to offer the owner anything.
    'is_member',    public.league_is_member(v_l.id, p_uid),
    'is_owner',     p_uid IS NOT NULL AND v_l.owner_id = p_uid,
    'max_members',  public.league_max_members(),
    -- The contract's exact shape (…Z) rather than to_jsonb()'s
    -- +00:00, so Date.parse in the client sees the promised string.
    'created_at',   to_char(v_l.created_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.league_public_payload(UUID, UUID) FROM PUBLIC;

-- ── 6. Identity ─────────────────────────────────────────────────
-- Every RPC below starts by requiring an account. The grants already
-- restrict these functions to `authenticated`, so this is the second
-- lock on the same door — but auth.uid() can still be NULL inside an
-- authenticated request if a future gateway forwards a token without
-- a subject, and a league membership keyed on NULL would be a row
-- nobody could ever leave.
CREATE OR REPLACE FUNCTION public.league_require_uid()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'league_requires_account'
      USING ERRCODE = '42501',
            HINT    = 'Sign in to use leagues.';
  END IF;
  RETURN v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.league_require_uid() FROM PUBLIC;

-- ── 7. create_league ────────────────────────────────────────────
-- Creates the league, makes the caller its owner AND its first
-- member, and returns the invite code.
--
-- Owner and member are written in the same transaction on purpose. A
-- league whose creator is not in league_members would be a league its
-- own owner could not read the board of, and — worse — one that §9
-- would treat as having zero members the moment anybody left.
--
-- The per-user cap is taken under a transaction-scoped advisory lock
-- keyed on the caller's user id. A plain "count, then insert" is racy
-- under READ COMMITTED: two tabs both read 19 and both insert, and
-- the account ends up with 21. There is no row to lock instead —
-- the thing being constrained is a count over rows that do not exist
-- yet, which no row lock and no UNIQUE constraint can express — so
-- the lock is on the *user*, which is the only thing both
-- transactions have in common. It is xact-scoped, so it is released
-- by COMMIT or ROLLBACK and cannot leak out of a failed call.
--
-- Note the same lock is taken by join_league, and always BEFORE the
-- per-league row lock. One order, everywhere, so two callers cannot
-- deadlock by taking the pair in opposite directions.
CREATE OR REPLACE FUNCTION public.create_league(p_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := public.league_require_uid();
  v_name TEXT := btrim(COALESCE(p_name, ''));
  v_key  TEXT;
  v_id   UUID;
  v_mine INTEGER;
BEGIN
  -- Trimmed first, then measured. "   " is not a name, and a client
  -- that sent one would otherwise create a league nobody can see in a
  -- list.
  IF char_length(v_name) < 1 OR char_length(v_name) > 60 THEN
    RAISE EXCEPTION 'league_bad_name'
      USING ERRCODE = '22023',
            HINT    = 'League name must be 1 to 60 characters.';
  END IF;

  PERFORM pg_advisory_xact_lock(74001, hashtext(v_uid::TEXT));

  SELECT COUNT(*)::INTEGER INTO v_mine
  FROM public.league_members m WHERE m.user_id = v_uid;

  IF v_mine >= public.league_max_per_user() THEN
    RAISE EXCEPTION 'league_limit_reached'
      USING ERRCODE = '23514',
            HINT    = 'You are already in the maximum number of leagues.';
  END IF;

  -- Generated outside the insert and retried on collision. At ~49
  -- bits a collision is not going to happen; the loop is here because
  -- the alternative — SELECT-then-INSERT — is racy, and because a
  -- duplicate key must surface as a retry rather than as a 500 on the
  -- one day it does.
  FOR i IN 1..8 LOOP
    v_key := public.league_new_key();

    INSERT INTO public.leagues (league_key, name, owner_id)
    VALUES (v_key, v_name, v_uid)
    ON CONFLICT (league_key) DO NOTHING
    RETURNING id INTO v_id;

    EXIT WHEN v_id IS NOT NULL;
  END LOOP;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'league_key_unavailable'
      USING ERRCODE = '40001',
            HINT    = 'Could not allocate a league key; retry.';
  END IF;

  INSERT INTO public.league_members (league_id, user_id)
  VALUES (v_id, v_uid)
  ON CONFLICT (league_id, user_id) DO NOTHING;

  RETURN jsonb_build_object(
    'league_key', v_key,
    'name',       v_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_league(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_league(TEXT) TO authenticated;

-- ── 8. join_league ──────────────────────────────────────────────
-- Idempotent by contract: joining a league you are already in is
-- success, not an error, and it must not duplicate a row or move
-- joined_at. The client retries, the user double-taps, the invite
-- link gets opened twice — none of those are exceptional and none of
-- them should cost the member their place in the succession order
-- that §9 reads.
--
-- Three things are load-bearing here.
--
-- (a) The member cap is enforced under a row lock on the *league*:
--     SELECT ... FOR UPDATE on leagues before the count. This is the
--     mechanism, and it is chosen over the two alternatives on
--     purpose. A conditional insert (INSERT ... SELECT WHERE (SELECT
--     COUNT(*) ...) < 100) is not safe under READ COMMITTED — both
--     transactions evaluate the count against their own snapshot, both
--     see 99, and both insert. A UNIQUE constraint cannot express "at
--     most N rows in a group" at all. A row lock can: the second
--     caller blocks on the first until it commits, and its count is
--     then taken from a fresh statement snapshot that includes the
--     first caller's row. Concurrent joiners are serialised per
--     league, which is exactly the granularity the cap is stated at.
--
-- (b) Membership is re-checked AFTER the lock, not before it. Two
--     concurrent joins by the same user into a nearly-full league
--     would otherwise both pass the "not a member" test, and the
--     loser would be refused for being over the cap on a league it is
--     already in. Under the lock there is one answer.
--
-- (c) Lock order is user-then-league, matching §7, so the pair is
--     always taken in the same direction and cannot deadlock.
CREATE OR REPLACE FUNCTION public.join_league(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := public.league_require_uid();
  v_key    TEXT := public.league_normalize_key(p_key);
  v_id     UUID;
  v_locked UUID;
  v_n      INTEGER;
  v_mine   INTEGER;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'league_not_found'
      USING ERRCODE = 'P0002', HINT = 'No league with that code.';
  END IF;

  SELECT id INTO v_id FROM public.leagues WHERE league_key = v_key;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'league_not_found'
      USING ERRCODE = 'P0002', HINT = 'No league with that code.';
  END IF;

  PERFORM pg_advisory_xact_lock(74001, hashtext(v_uid::TEXT));

  -- The per-league mutex. Also re-reads the row, so a league deleted
  -- by a concurrent last-member leave (§9) is reported as gone rather
  -- than joined.
  SELECT id INTO v_locked FROM public.leagues WHERE id = v_id FOR UPDATE;
  IF v_locked IS NULL THEN
    RAISE EXCEPTION 'league_not_found'
      USING ERRCODE = 'P0002', HINT = 'No league with that code.';
  END IF;

  -- Already in. Nothing is written — in particular joined_at is not
  -- touched — and the caller gets the same payload a fresh join
  -- returns. Caps are not consulted, because nothing is being added:
  -- a league that is full of its existing members must still open for
  -- those members.
  IF NOT public.league_is_member(v_id, v_uid) THEN
    SELECT COUNT(*)::INTEGER INTO v_n
    FROM public.league_members m WHERE m.league_id = v_id;

    IF v_n >= public.league_max_members() THEN
      RAISE EXCEPTION 'league_full'
        USING ERRCODE = '23514',
              HINT    = 'This league is full.';
    END IF;

    SELECT COUNT(*)::INTEGER INTO v_mine
    FROM public.league_members m WHERE m.user_id = v_uid;

    IF v_mine >= public.league_max_per_user() THEN
      RAISE EXCEPTION 'league_limit_reached'
        USING ERRCODE = '23514',
              HINT    = 'You are already in the maximum number of leagues.';
    END IF;

    -- ON CONFLICT DO NOTHING even under the lock: the lock makes the
    -- cap correct, the primary key makes the row count correct, and
    -- neither is asked to do the other's job.
    INSERT INTO public.league_members (league_id, user_id)
    VALUES (v_id, v_uid)
    ON CONFLICT (league_id, user_id) DO NOTHING;
  END IF;

  RETURN public.league_public_payload(v_id, v_uid);
END;
$$;

REVOKE ALL ON FUNCTION public.join_league(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_league(TEXT) TO authenticated;

-- ── 9. leave_league ─────────────────────────────────────────────
-- The subtle one, and the ordering is the whole of it.
--
-- The caller's row is deleted FIRST, and the remaining members are
-- counted AFTER. Counting first and then deleting gets both endings
-- wrong by one: a league of one would see "1 remaining" and survive
-- as litter, and the succession query would find the departing owner
-- and hand the league back to them.
--
-- From that one count, three outcomes:
--
--   0 remaining  — the league is deleted outright. league_members
--                  cascades. A league with no members is litter, and
--                  its key stops resolving, which is the observable
--                  half of that.
--   owner left   — ownership moves to the longest-standing remaining
--                  member: ORDER BY joined_at, and by user_id after
--                  it so that two members who joined in the same
--                  transaction still produce one deterministic
--                  answer rather than an arbitrary one. A league with
--                  no owner is unreachable.
--   anyone else  — nothing but the delete.
--
-- The whole thing runs under the same per-league row lock join_league
-- takes, for a reason that only shows up with two people: two members
-- of a two-member league leaving at the same instant would each
-- delete their own row, each see the other's row still present in
-- their own snapshot, each count 1, and leave behind a league with no
-- members at all. Serialised, the second one counts 0 and deletes it.
--
-- Leaving a league you are not in RAISES rather than succeeding
-- quietly. join_league is idempotent because the design says so and
-- because a repeated join is a normal thing for a client to do;
-- leave has no such contract, and silently reporting success for a
-- league the caller was never in would hide a real client bug.
CREATE OR REPLACE FUNCTION public.leave_league(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         UUID := public.league_require_uid();
  v_key         TEXT := public.league_normalize_key(p_key);
  v_l           public.leagues%ROWTYPE;
  v_removed     INTEGER;
  v_remaining   INTEGER;
  v_new_owner   UUID;
  v_new_name    TEXT;
  v_deleted     BOOLEAN := FALSE;
  v_transferred BOOLEAN := FALSE;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'league_not_found'
      USING ERRCODE = 'P0002', HINT = 'No league with that code.';
  END IF;

  -- Locked on the way in, not looked up and then locked: the lookup
  -- and the lock are the same statement, so there is no window in
  -- which the row could be deleted between them.
  SELECT * INTO v_l FROM public.leagues WHERE league_key = v_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'league_not_found'
      USING ERRCODE = 'P0002', HINT = 'No league with that code.';
  END IF;

  DELETE FROM public.league_members
  WHERE league_id = v_l.id AND user_id = v_uid;

  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_removed = 0 THEN
    RAISE EXCEPTION 'league_not_member'
      USING ERRCODE = '42501',
            HINT    = 'You are not in this league.';
  END IF;

  -- AFTER the delete. This is the line the whole function turns on.
  SELECT COUNT(*)::INTEGER INTO v_remaining
  FROM public.league_members m WHERE m.league_id = v_l.id;

  IF v_remaining = 0 THEN
    DELETE FROM public.leagues WHERE id = v_l.id;
    v_deleted := TRUE;

  ELSIF v_l.owner_id = v_uid THEN
    SELECT m.user_id INTO v_new_owner
    FROM public.league_members m
    WHERE m.league_id = v_l.id
    ORDER BY m.joined_at ASC, m.user_id ASC
    LIMIT 1;

    UPDATE public.leagues SET owner_id = v_new_owner WHERE id = v_l.id;
    v_transferred := TRUE;

    -- A username, not an id. The caller was a member one statement
    -- ago and has already seen this person on the board, so naming
    -- the successor tells them nothing new — but it is still the only
    -- identifier this function is allowed to emit.
    SELECT p.username INTO v_new_name
    FROM public.profiles p WHERE p.id = v_new_owner;
  END IF;

  RETURN jsonb_build_object(
    'league_key',            v_l.league_key,
    'name',                  v_l.name,
    'left',                  TRUE,
    'league_deleted',        v_deleted,
    'ownership_transferred', v_transferred,
    'new_owner_username',    v_new_name,
    'member_count',          v_remaining
  );
END;
$$;

REVOKE ALL ON FUNCTION public.leave_league(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_league(TEXT) TO authenticated;

-- ── 10. get_my_leagues ──────────────────────────────────────────
-- The dashboard list: every league the caller is in, with the member
-- count that makes each one legible at a glance.
--
-- Always a JSON array, never SQL NULL — jsonb_agg over zero rows
-- returns NULL, and a client that had to distinguish null from []
-- would get it wrong once. A caller in no leagues gets [].
--
-- owner_username per league, so the dashboard can say who runs each
-- one without the caller having to open it. Same reasoning as §5, and
-- the same LEFT JOIN: a league whose owner has no profile row still
-- appears, with a null name, rather than dropping out of the caller's
-- own list.
--
-- Still no roster and no ids: this is a list of doors, and the board
-- behind each one is §12's job.
CREATE OR REPLACE FUNCTION public.get_my_leagues()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := public.league_require_uid();
  v_out JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(x.o ORDER BY x.joined_at DESC, x.league_key), '[]'::JSONB)
  INTO v_out
  FROM (
    SELECT
      m.joined_at,
      l.league_key,
      jsonb_build_object(
        'league_key',   l.league_key,
        'name',         l.name,
        'owner_username', op.username,
        'member_count', (SELECT COUNT(*)::INTEGER
                         FROM public.league_members m2
                         WHERE m2.league_id = l.id),
        'is_owner',     l.owner_id = v_uid,
        'max_members',  public.league_max_members(),
        'joined_at',    to_char(m.joined_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'created_at',   to_char(l.created_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ) AS o
    FROM public.league_members m
    JOIN public.leagues l ON l.id = m.league_id
    -- LEFT, not INNER: an owner with no profile row must not delete a
    -- league from the caller's own dashboard.
    LEFT JOIN public.profiles op ON op.id = l.owner_id
    WHERE m.user_id = v_uid
  ) x;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_leagues() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_leagues() TO authenticated;

-- ── 11. get_league ──────────────────────────────────────────────
-- The join screen, and the function an invite link lands on.
--
-- Name, owner, member count, and whether the caller is already in —
-- which is everything needed to render "Maths Desk, owned by
-- hexadecimal · 6 members · Join", and nothing more. The roster is
-- deliberately absent: an invite code should not be a directory of
-- who is in it, and someone forwarded a code they never use must not
-- thereby learn who their colleagues practise with. Naming the one
-- person who is doing the inviting is the opposite of that — it is
-- what makes the invite legible instead of anonymous — and §5 sets
-- out why profiles.is_public does not gate it.
--
-- Returns SQL NULL for an unknown key, the same NULL the social layer
-- returns for an unknown username and duels return for an unknown
-- duel key: the client renders one "no such league" page, and the
-- function does not distinguish "wrong code" from anything else.
CREATE OR REPLACE FUNCTION public.get_league(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := public.league_require_uid();
  v_key TEXT := public.league_normalize_key(p_key);
  v_id  UUID;
BEGIN
  IF v_key IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_id FROM public.leagues WHERE league_key = v_key;
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN public.league_public_payload(v_id, v_uid);
END;
$$;

REVOKE ALL ON FUNCTION public.get_league(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_league(TEXT) TO authenticated;

-- ── 12. get_league_board ────────────────────────────────────────
-- The leaderboard, and the only function in this file that emits
-- another person's username. Members only, checked before a single
-- row of the roster is read.
--
-- The board is over the daily, because the daily is the only
-- comparison in this product that is already fair: same questions,
-- one attempt, server-timed. Ranking by personal best would rank by
-- who played most.
--
-- Three scopes, and what "score" means in each:
--
--   today  — the score on today's puzzle. NULL if there is no
--            *complete* attempt. An attempt still in_progress is not
--            a result; an expired one is not either. Both read as
--            "hasn't played", which is what the board says.
--   week   — the MEAN over the last seven puzzles, alongside a
--            games-played count. A mean rather than a total, so
--            somebody who played twice cannot beat somebody who
--            played seven times by arithmetic alone; and the count is
--            carried in the payload so a 1-of-7 average of 80 is
--            legible as the small sample it is rather than as a
--            league lead. The window is the last seven rows of
--            daily_puzzles, not "today minus six days": if the site
--            ever misses a day, seven puzzles is still seven puzzles.
--   best   — the best daily score ever, with a lifetime count. The
--            trophy cabinet.
--
-- Two structural decisions worth stating outright.
--
-- (a) The query starts at league_members and LEFT JOINs outward.
--     Every member appears exactly once whether or not they have an
--     attempt — a league of six where two are missing looks like a
--     league of six. Starting at daily_attempts and joining back
--     would silently drop them, and would pass every test that only
--     checked the people who played.
--
-- (b) RANK(), not ROW_NUMBER(): tied scores share a rank (1, 2, 2,
--     4), matching daily_result() in daily.sql. Inventing an order
--     between two identical scores would mean telling one of those
--     players they lost to the other on a criterion nobody agreed to.
--     NULLS LAST is explicit because DESC defaults to NULLS FIRST —
--     without it every member who has not played would be joint
--     first. All non-players tie with each other, which is correct:
--     there is nothing to separate them.
--
-- There is no division anywhere that can see a zero. AVG over an
-- empty set is NULL, not an error; MAX over an empty set is NULL;
-- COUNT is 0; jsonb_agg over no rows is COALESCEd to []. An empty
-- league, a member with no attempts, and a week containing no
-- puzzles at all each produce a well-formed board.
--
-- `played` is a boolean in every scope and `games` carries the count,
-- rather than overloading one field with "did they" for today and
-- "how many" for the week. The design asks for both facts; this is
-- the shape in which neither has to be inferred.
CREATE OR REPLACE FUNCTION public.get_league_board(
  p_key   TEXT,
  p_scope TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := public.league_require_uid();
  v_key   TEXT := public.league_normalize_key(p_key);
  v_scope TEXT := lower(btrim(COALESCE(p_scope, 'today')));
  v_l     public.leagues%ROWTYPE;
  v_today DATE := public.daily_today();
  v_dates DATE[];
  v_rows  JSONB;
  v_n     INTEGER;
BEGIN
  IF v_scope = '' THEN
    v_scope := 'today';
  END IF;

  -- Refused rather than silently defaulted. A client that asked for
  -- 'month' must be told it does not exist, not handed today's board
  -- labelled as something else.
  IF v_scope NOT IN ('today', 'week', 'best') THEN
    RAISE EXCEPTION 'league_bad_scope'
      USING ERRCODE = '22023',
            HINT    = 'Scope must be today, week or best.';
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'league_not_found'
      USING ERRCODE = 'P0002', HINT = 'No league with that code.';
  END IF;

  SELECT * INTO v_l FROM public.leagues WHERE league_key = v_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'league_not_found'
      USING ERRCODE = 'P0002', HINT = 'No league with that code.';
  END IF;

  -- THE check. Before any roster row is read, and expressed as a
  -- refusal rather than an empty board: an empty board is
  -- indistinguishable from a league nobody has played in, and the
  -- client would render it as one.
  --
  -- This is a different answer from get_league's, deliberately. That
  -- function tells a code-holder the league exists and how big it is,
  -- which is what a join screen needs; this one adds nothing to that
  -- oracle and withholds the only thing that matters — the names.
  IF NOT public.league_is_member(v_l.id, v_uid) THEN
    RAISE EXCEPTION 'league_forbidden'
      USING ERRCODE = '42501',
            HINT    = 'Join this league to see its board.';
  END IF;

  -- The last seven puzzles that exist, most recent first. Computed
  -- once, outside the per-member aggregate. An empty array (a brand
  -- new database with no puzzles yet) matches nothing, which makes
  -- every week score NULL rather than an error.
  SELECT COALESCE(array_agg(d.puzzle_date), ARRAY[]::DATE[]) INTO v_dates
  FROM (
    SELECT p.puzzle_date FROM public.daily_puzzles p
    WHERE p.puzzle_date <= v_today
    ORDER BY p.puzzle_date DESC
    LIMIT 7
  ) d;

  SELECT COUNT(*)::INTEGER INTO v_n
  FROM public.league_members m WHERE m.league_id = v_l.id;

  WITH mem AS (
    -- LEFT JOIN to profiles: a member with no profile row is still a
    -- member and still occupies a seat, so they appear with a null
    -- username rather than vanishing from a board whose member_count
    -- would then not match its own row count.
    SELECT m.user_id,
           p.username,
           COALESCE(p.is_public, FALSE) AS is_public
    FROM public.league_members m
    LEFT JOIN public.profiles p ON p.id = m.user_id
    WHERE m.league_id = v_l.id
  ),
  stat AS (
    -- CASE evaluates only the matching branch, so exactly one
    -- aggregate runs per member per column. Only 'complete' attempts
    -- count, in every branch: an in_progress attempt is a run in
    -- flight and an expired one is a run abandoned, and neither is a
    -- result anyone should be ranked on.
    SELECT
      mem.user_id,
      CASE v_scope
        WHEN 'today' THEN (
          SELECT a.score::NUMERIC FROM public.daily_attempts a
          WHERE a.user_id = mem.user_id
            AND a.puzzle_date = v_today
            AND a.status = 'complete')
        WHEN 'week' THEN (
          SELECT round(AVG(a.score), 1) FROM public.daily_attempts a
          WHERE a.user_id = mem.user_id
            AND a.status = 'complete'
            AND a.puzzle_date = ANY (v_dates))
        ELSE (
          SELECT MAX(a.score)::NUMERIC FROM public.daily_attempts a
          WHERE a.user_id = mem.user_id
            AND a.status = 'complete')
      END AS score,
      CASE v_scope
        WHEN 'today' THEN (
          SELECT COUNT(*)::INTEGER FROM public.daily_attempts a
          WHERE a.user_id = mem.user_id
            AND a.puzzle_date = v_today
            AND a.status = 'complete')
        WHEN 'week' THEN (
          SELECT COUNT(*)::INTEGER FROM public.daily_attempts a
          WHERE a.user_id = mem.user_id
            AND a.status = 'complete'
            AND a.puzzle_date = ANY (v_dates))
        ELSE (
          SELECT COUNT(*)::INTEGER FROM public.daily_attempts a
          WHERE a.user_id = mem.user_id
            AND a.status = 'complete')
      END AS games
    FROM mem
  ),
  ranked AS (
    SELECT mem.user_id, mem.username, mem.is_public, s.score, s.games,
           RANK() OVER (ORDER BY s.score DESC NULLS LAST)::INTEGER AS rank
    FROM mem JOIN stat s ON s.user_id = mem.user_id
  )
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'rank',     r.rank,
               -- Usernames only. Not user_id, not the profile id, not
               -- an email — the board is a list of people you already
               -- share a league with, and it is not a way to resolve
               -- them to an account.
               'username', r.username,
               -- Whether it is safe to LINK that username to a
               -- profile page. Membership does not publish anybody:
               -- profiles.is_public is untouched by this entire file,
               -- and a private member appears on the board without
               -- becoming clickable.
               'is_public', r.is_public,
               'score',     r.score,
               'played',    r.games > 0,
               'games',     r.games,
               'is_you',    r.user_id = v_uid,
               'is_owner',  r.user_id = v_l.owner_id
             )
             -- rank first, then username, so two tied members come
             -- back in a stable order across calls rather than in
             -- whatever order the scan produced. NULLS LAST so a
             -- member with no profile does not float to the top of
             -- their rank group.
             ORDER BY r.rank, r.username NULLS LAST),
           '[]'::JSONB)
  INTO v_rows
  FROM ranked r;

  RETURN jsonb_build_object(
    'league_key',   v_l.league_key,
    'name',         v_l.name,
    -- Echoed back, so a client that raced two scope buttons can tell
    -- which board it is holding.
    'scope',        v_scope,
    'member_count', v_n,
    'puzzle_date',  to_char(v_today, 'YYYY-MM-DD'),
    -- How many puzzles the mean is actually over — 7 normally, fewer
    -- in the first week of the product's life. Null for the scopes it
    -- does not describe rather than a number that means nothing.
    'window_days',  CASE WHEN v_scope = 'week'
                         THEN COALESCE(array_length(v_dates, 1), 0) END,
    'rows',         v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_league_board(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_league_board(TEXT, TEXT) TO authenticated;

-- ── 13. Indexes ─────────────────────────────────────────────────
-- league_key is UNIQUE, which already builds the btree every lookup
-- in this file goes through, and league_members' PRIMARY KEY
-- (league_id, user_id) leads with league_id — so it serves the member
-- count, the roster scan in §12 and the succession query in §9. The
-- two below are the ones the primary key cannot serve.

-- Every query keyed on the *user* rather than the league: the
-- per-user cap in §7 and §8, and the dashboard list in §10. A
-- composite key leading with league_id is no help to any of them.
CREATE INDEX IF NOT EXISTS idx_league_members_user
  ON public.league_members (user_id);

-- Leagues an account owns. Not read by anything in this file — is_owner
-- is derived from a row already in hand — but it is what makes the
-- ON DELETE CASCADE from auth.users a lookup rather than a seq scan
-- when an account is deleted.
CREATE INDEX IF NOT EXISTS idx_leagues_owner
  ON public.leagues (owner_id);
