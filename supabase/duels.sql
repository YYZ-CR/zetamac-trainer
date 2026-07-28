-- ────────────────────────────────────────────────────────────────
--  Duels — two players, one sequence, played whenever they like.
--  Apply by hand in the Supabase SQL Editor, AFTER schema.sql,
--  hardening.sql, social.sql and daily.sql. The contract this
--  implements is docs/duels-design.md; if the two ever disagree, the
--  doc is the spec and this is the bug.
--
--  daily.sql is a hard dependency, not an ordering preference. The
--  question generator (daily_generate_questions) and the canonical
--  config (daily_default_config) live there and are *called* from
--  here, never copied. A second generator would be a second thing to
--  keep correct, and the one property a duel must have — both players
--  answering the identical list — is exactly what a divergent copy
--  would quietly break.
--
--  The whole design turns on two sentences from that doc:
--
--    *the sequence does not exist for you until you start*  — same as
--    the daily, so start_duel_run is the only function in this file
--    that can emit `questions`, and only while that side's run is
--    genuinely live; and
--
--    *nobody sees a score until both are done* — because the second
--    player knowing the target turns a run into a chase and makes the
--    comparison meaningless. There is exactly one place in this file
--    that decides whether a score may be shown (§4,
--    duel_public_payload) and every reader goes through it.
--
--  Which is why RLS is enabled on both tables with NO policies at
--  all. That is not an oversight and not a TODO. The anon key ships
--  in js/config.js, so any policy permissive enough to serve a duel
--  to a player is a policy permissive enough to hand the question
--  list — and the opponent's live score — to anyone holding the key.
--  Every read and write goes through the SECURITY DEFINER functions
--  below, which decide what a caller may see from the state of that
--  caller's own run.
--
--  SET search_path = public on every function is not decoration. A
--  SECURITY DEFINER function without it resolves unqualified names
--  against the *caller's* search_path, which lets a caller shadow a
--  table or operator with one of their own and run it as the owner.
--
--  This file is idempotent: re-running it is the supported way to
--  deploy a change.
-- ────────────────────────────────────────────────────────────────

-- ── 1. Tables ───────────────────────────────────────────────────
-- One row per duel. `questions` is generated once, at creation, by
-- the creator — not lazily by whoever starts first, as the daily does.
-- The daily's laziness exists to settle a race between strangers
-- arriving on a brand new UTC day; a duel has an unambiguous author
-- and an unambiguous moment of creation, so there is no race to
-- settle and no reason to defer the work.
--
-- `config` is stored rather than recomputed. It is the record of what
-- this duel actually was; a later change to daily_default_config()
-- must not retroactively rewrite the description of a duel two people
-- already played.
CREATE TABLE IF NOT EXISTS public.duels (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The shareable link. UNIQUE both because it is the lookup key and
  -- because the retry loop in §5 relies on the constraint to detect a
  -- collision rather than on a racy pre-check.
  duel_key             TEXT UNIQUE NOT NULL,
  creator_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Exactly one of these two is set once the opponent side is claimed,
  -- and neither before. Together they are the opponent's identity, and
  -- the CHECK below is what stops a row from carrying two.
  opponent_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  opponent_guest_token TEXT,
  config               JSONB       NOT NULL,
  duration_seconds     INTEGER     NOT NULL,
  -- [{display, operation, answer}, ...] — shared by both sides.
  questions            JSONB       NOT NULL,
  status               TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- created_at + 48h, materialised. Stored rather than derived so the
  -- horizon of a duel already in flight cannot be moved by editing a
  -- constant in this file.
  expires_at           TIMESTAMPTZ NOT NULL
);

-- One row per side per duel.
--
-- PRIMARY KEY (duel_id, side) is THE one-run-per-side rule. Enforcing
-- it in the RPC instead would mean enforcing it nowhere: two
-- concurrent start_duel_run calls would both see no run and both
-- insert one, and the second insert would silently overwrite the
-- first's started_at — which is a fresh clock for a player who has
-- already seen the questions.
--
-- Note there is no surrogate id. The composite key is the identity of
-- a run, so every UPDATE below keys on (duel_id, side) and cannot
-- address anything else.
CREATE TABLE IF NOT EXISTS public.duel_runs (
  duel_id      UUID NOT NULL REFERENCES public.duels(id) ON DELETE CASCADE,
  side         TEXT NOT NULL,
  -- Who actually played this side. Recorded on the run as well as on
  -- the duel because the duel's opponent_* columns can be cleared by
  -- ON DELETE SET NULL, and a finished run should still remember
  -- whether it was a guest.
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  guest_token  TEXT,
  -- Server clock and nothing else: a client that could set this could
  -- grant itself an afternoon to answer 400 questions.
  started_at   TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  -- Recomputed from duels.questions on every submit. The client is
  -- never asked what it scored and is never believed if it volunteers
  -- one.
  score        INTEGER,
  -- The *accepted* answers, [{i, value, elapsed_ms}] — see §8 for what
  -- "accepted" excludes. Storing the filtered array rather than the
  -- raw payload keeps arbitrary client keys out of a column other
  -- functions read.
  answers      JSONB,
  status       TEXT NOT NULL,
  PRIMARY KEY (duel_id, side)
);

-- Re-runnability for a database that already has an older shape of
-- these tables. CREATE TABLE IF NOT EXISTS is a no-op on an existing
-- table — it does not reconcile columns or constraints — so anything
-- that carries a product rule has to be (re-)asserted explicitly, and
-- ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.duels'::REGCLASS
      AND conname  = 'duels_opponent_exclusive'
  ) THEN
    ALTER TABLE public.duels
      ADD CONSTRAINT duels_opponent_exclusive
      CHECK (opponent_id IS NULL OR opponent_guest_token IS NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.duels'::REGCLASS
      AND conname  = 'duels_status_valid'
  ) THEN
    ALTER TABLE public.duels
      ADD CONSTRAINT duels_status_valid
      CHECK (status IN ('open', 'complete', 'expired'));
  END IF;

  -- A duel whose creator is also its opponent is the exploit this
  -- file exists to prevent, expressed as a constraint. §7 can never
  -- write such a row, but a constraint is what makes that a fact
  -- about the database rather than a fact about one function.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.duels'::REGCLASS
      AND conname  = 'duels_creator_is_not_opponent'
  ) THEN
    ALTER TABLE public.duels
      ADD CONSTRAINT duels_creator_is_not_opponent
      CHECK (opponent_id IS NULL OR opponent_id <> creator_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.duel_runs'::REGCLASS
      AND conname  = 'duel_runs_side_valid'
  ) THEN
    ALTER TABLE public.duel_runs
      ADD CONSTRAINT duel_runs_side_valid
      CHECK (side IN ('creator', 'opponent'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.duel_runs'::REGCLASS
      AND conname  = 'duel_runs_status_valid'
  ) THEN
    ALTER TABLE public.duel_runs
      ADD CONSTRAINT duel_runs_status_valid
      CHECK (status IN ('in_progress', 'complete', 'expired'));
  END IF;
END $$;

-- ── 2. RLS: on, and deliberately empty ──────────────────────────
-- Enabled with zero policies, which denies every row to every
-- non-owner role. The SECURITY DEFINER functions below run as the
-- table owner and are therefore unaffected; PostgREST's anon and
-- authenticated roles get nothing directly.
--
-- This matters more here than anywhere else in the project, because
-- duel_runs.score is the single value the design says must stay
-- hidden. A direct SELECT would defeat every check in §4 at once.
--
-- Note this is ENABLE, not FORCE: FORCE would subject the owner to
-- RLS too, and with no policies that would lock out the functions
-- themselves.
ALTER TABLE public.duels     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duel_runs ENABLE ROW LEVEL SECURITY;

-- Belt and braces. Supabase's default privileges grant the API roles
-- table-level rights in `public`, and while RLS would deny the rows
-- anyway, a future policy added in haste should not silently become a
-- public read of the question list. Revoking the grant means such a
-- policy still has nothing to apply to.
REVOKE ALL ON TABLE public.duels     FROM anon, authenticated;
REVOKE ALL ON TABLE public.duel_runs FROM anon, authenticated;

-- ── 3. Keys, identity and clocks ────────────────────────────────
-- A duel key is 12 hex characters — 48 bits — where the rest of the
-- project uses 8 (js/db.js randomKey(), 32 bits).
--
-- The difference is deliberate and is about what the key protects. A
-- session key names a finished result that its owner is deliberately
-- sharing; guessing one wins you a scoreboard someone published
-- anyway. A duel key is a *capability*: whoever presents it first,
-- with any guest token, becomes the opponent, and there is exactly
-- one opponent slot. A 32-bit space is enumerable by a bored person
-- with a script, and the damage — silently occupying the opponent
-- side of strangers' duels so the real invitee is refused — is
-- cheap to do and annoying to detect. 48 bits moves that from "a
-- weekend project" to "not worth it", at the cost of four characters
-- in a URL.
--
-- Built from gen_random_uuid() rather than gen_random_bytes() so this
-- file needs no extension: gen_random_uuid() is in core since
-- PostgreSQL 13 and is seeded from the platform CSPRNG, and taking a
-- 48-bit slice of a 122-bit random value is uniform.
CREATE OR REPLACE FUNCTION public.duel_new_key()
RETURNS TEXT
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 12);
$$;

-- Internal. Not granted: a caller with no duel to create has no use
-- for a key generator.
REVOKE ALL ON FUNCTION public.duel_new_key() FROM PUBLIC;

-- Who is this caller, with respect to this duel? The single place
-- side assignment is decided, so there is one implementation to audit
-- rather than three that must agree.
--
-- Returns exactly one of:
--   'creator'    — the signed-in creator of this duel
--   'opponent'   — the identity already holding the opponent side
--   'open'       — a usable identity, and the opponent side is free
--   'spectator'  — everyone else: a third arrival, or nobody at all
--
-- The rules, in the order they are applied and for the reasons the
-- design doc gives:
--
-- (a) The creator check comes FIRST and returns unconditionally. This
--     is what makes "the creator cannot play both sides" true rather
--     than hoped for: there is no argument to this function, and no
--     guest token, that lets a caller who is the creator come out of
--     it as 'opponent'. They open their own link and they get their
--     own side. (A creator who signs *out* and arrives as an
--     anonymous guest is indistinguishable from any other guest and
--     will take the opponent side — that is not solvable server-side
--     and is not what the exploit is: it costs them their own side,
--     since the creator run is keyed to their account.)
--
-- (b) A claimed opponent side is matched against the identity that
--     claimed it, of the same kind. A guest token is never compared
--     to a user id and vice versa, so a token cannot impersonate a
--     signed-in opponent no matter what it contains.
--
-- (c) Tokens are compared exactly, and an absent or blank token is
--     "no identity" rather than a value. Note this function never
--     evaluates `p_token = p_opponent_token` unless BOTH are known to
--     be non-NULL — which is the whole point. Written the obvious way
--     (`WHERE opponent_guest_token = p_token`) an unclaimed duel has
--     opponent_guest_token NULL, `NULL = NULL` is NULL, and the
--     comparison is merely false rather than matching; but the
--     mirror-image bug — treating "both NULL" as a match, e.g. via
--     IS NOT DISTINCT FROM — would hand the opponent side to every
--     anonymous caller who ever loads the page. Three-valued logic
--     cuts both ways here, so the NULLs are eliminated before any
--     comparison happens.
--
-- IMMUTABLE and pure: it reads no tables and no clock. Everything it
-- needs is passed in, which is also what makes it directly testable.
CREATE OR REPLACE FUNCTION public.duel_role(
  p_creator        UUID,
  p_opponent_id    UUID,
  p_opponent_token TEXT,
  p_uid            UUID,
  p_token          TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token TEXT := NULLIF(btrim(COALESCE(p_token, '')), '');
BEGIN
  -- (a) The creator, always and only the creator.
  IF p_uid IS NOT NULL AND p_creator IS NOT NULL AND p_uid = p_creator THEN
    RETURN 'creator';
  END IF;

  -- (b) Opponent side taken by an account.
  IF p_opponent_id IS NOT NULL THEN
    IF p_uid IS NOT NULL AND p_uid = p_opponent_id THEN
      RETURN 'opponent';
    END IF;
    RETURN 'spectator';
  END IF;

  -- (b) Opponent side taken by a guest. Holding the exact token IS
  -- being that guest — it is the only identity they have — so a
  -- signed-in caller presenting it resumes that run rather than being
  -- turned away. Anything else is a third arrival.
  IF p_opponent_token IS NOT NULL THEN
    IF v_token IS NOT NULL AND v_token = p_opponent_token THEN
      RETURN 'opponent';
    END IF;
    RETURN 'spectator';
  END IF;

  -- Free. Claimable by anyone who can be identified again later; a
  -- caller with neither an account nor a token cannot be, so they
  -- would be unable to resume their own run and are refused rather
  -- than handed the one opponent slot.
  IF p_uid IS NOT NULL OR v_token IS NOT NULL THEN
    RETURN 'open';
  END IF;

  RETURN 'spectator';
END;
$$;

REVOKE ALL ON FUNCTION public.duel_role(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC;

-- When a run's clock stops.
--
-- LEAST() is the load-bearing part. A run started five seconds before
-- the duel expires does NOT get a full two minutes past the horizon:
-- its window is truncated at expires_at. That costs a late accepter
-- some seconds, and it buys the invariant everything else in this
-- file depends on —
--
--   after expires_at, no run is live.
--
-- §4 reveals both scores once the duel has expired. Without the clamp
-- a run could still be in progress at that moment, and the player
-- would be handed the target mid-run — precisely the chase the design
-- forbids. With it, "expired" and "still playing" are mutually
-- exclusive by construction rather than by timing luck.
CREATE OR REPLACE FUNCTION public.duel_run_deadline(
  p_started  TIMESTAMPTZ,
  p_duration INTEGER,
  p_expires  TIMESTAMPTZ
)
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT LEAST(p_started + make_interval(secs => GREATEST(COALESCE(p_duration, 0), 0)),
               p_expires);
$$;

REVOKE ALL ON FUNCTION public.duel_run_deadline(TIMESTAMPTZ, INTEGER, TIMESTAMPTZ)
  FROM PUBLIC;

-- ── 4. Lazy resolution and the public face ──────────────────────
-- Closes anything that ran out while nobody was looking, then leaves
-- the duel's own status consistent with its runs.
--
-- No scheduler. A cron job that fails to deploy would leave runs
-- in_progress forever, and every reader here has to re-derive the
-- state from started_at anyway to be correct — so the derivation is
-- the mechanism and the write is only a cache of it.
--
-- The 3-second grace matches §8's submit window exactly. If it did
-- not, a submit arriving inside its grace period could be pre-empted
-- by this function marking the run expired in the same call, and the
-- player would lose a run they submitted on time.
CREATE OR REPLACE FUNCTION public.duel_refresh(p_duel_id UUID)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now     TIMESTAMPTZ := NOW();
  v_d       public.duels%ROWTYPE;
  v_results INTEGER;
BEGIN
  SELECT * INTO v_d FROM public.duels WHERE id = p_duel_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.duel_runs r
  SET status = 'expired',
      -- "Closes at whatever was submitted, which may be nothing" —
      -- and nothing is zero, not unknown. A NULL here would make the
      -- comparison in duel_public_payload undecidable.
      score  = COALESCE(r.score, 0)
  WHERE r.duel_id = v_d.id
    AND r.status  = 'in_progress'
    AND v_now > public.duel_run_deadline(r.started_at, v_d.duration_seconds,
                                         v_d.expires_at)
                + make_interval(secs => 3);

  -- A side "has a result" once it is complete or expired. An expired
  -- run counts: the player showed up, the clock ran out, and zero is
  -- a real score. Only a side that never started at all is absent,
  -- which is what §4's walkover distinguishes.
  SELECT COUNT(*) INTO v_results
  FROM public.duel_runs r
  WHERE r.duel_id = v_d.id AND r.status IN ('complete', 'expired');

  IF v_d.status = 'open' THEN
    IF v_results >= 2 THEN
      UPDATE public.duels SET status = 'complete'
      WHERE id = v_d.id AND status = 'open';
    ELSIF v_now > v_d.expires_at THEN
      UPDATE public.duels SET status = 'expired'
      WHERE id = v_d.id AND status = 'open';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.duel_refresh(UUID) FROM PUBLIC;

-- Everything about a duel that anyone is ever allowed to see, and
-- nothing else. Every reader in this file goes through this function,
-- so the "no scores until both are done" rule has exactly one
-- implementation.
--
-- What it deliberately never emits, in any state:
--
--   questions   — the answer key. Only §7 emits those, and only to a
--                 side whose own run is live.
--   answers     — a stored timeline is a partial answer key (a
--                 correct entry states the answer to question i).
--   user_id, guest_token, emails — a duel is a link, not a directory.
--   how many questions a side has answered — this is the same leak as
--                 the score wearing a hat. "They are on 61" tells the
--                 other player their target just as well as "they
--                 scored 61", so `answered` is not in the payload at
--                 any point, revealed or not.
--
-- Scores appear only when v_reveal, which is true when both sides
-- have a result or the duel has expired — and by duel_run_deadline's
-- clamp those two conditions are exactly the states in which no run
-- is live, so a revealed score can never reach a player who is still
-- playing.
--
-- STABLE, not VOLATILE: it writes nothing. duel_refresh is the
-- volatile half and is called separately by the RPCs, which keeps
-- "what may be seen" free of "what gets closed".
CREATE OR REPLACE FUNCTION public.duel_public_payload(
  p_duel_id UUID,
  p_uid     UUID,
  p_token   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now      TIMESTAMPTZ := NOW();
  v_d        public.duels%ROWTYPE;
  v_c        public.duel_runs%ROWTYPE;
  v_o        public.duel_runs%ROWTYPE;
  v_c_found  BOOLEAN := FALSE;
  v_o_found  BOOLEAN := FALSE;
  v_c_result BOOLEAN;
  v_o_result BOOLEAN;
  v_reveal   BOOLEAN;
  v_role     TEXT;
  v_outcome  JSONB;
BEGIN
  SELECT * INTO v_d FROM public.duels WHERE id = p_duel_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_c FROM public.duel_runs
  WHERE duel_id = v_d.id AND side = 'creator';
  v_c_found := FOUND;

  SELECT * INTO v_o FROM public.duel_runs
  WHERE duel_id = v_d.id AND side = 'opponent';
  v_o_found := FOUND;

  -- Pinned to booleans rather than used inline: v_c.status is NULL
  -- when the row was not found, and `NULL IN (...)` is NULL, which an
  -- IF would treat as false but an AND/OR chain would propagate.
  v_c_result := v_c_found AND v_c.status IN ('complete', 'expired');
  v_o_result := v_o_found AND v_o.status IN ('complete', 'expired');

  v_reveal := (v_c_result AND v_o_result) OR v_now > v_d.expires_at;

  v_role := public.duel_role(v_d.creator_id, v_d.opponent_id,
                             v_d.opponent_guest_token, p_uid, p_token);

  -- The outcome block exists so a walkover is legible AS a walkover.
  -- "You won 84–0" and "they never turned up" are different social
  -- facts, and collapsing them into a win is the thing the design
  -- explicitly says not to do — so `type` is a first-class field and
  -- the client is never asked to infer it from a null score.
  IF NOT v_reveal THEN
    v_outcome := NULL;
  ELSIF v_c_result AND v_o_result THEN
    v_outcome := jsonb_build_object(
      'type', 'decided',
      'winner', CASE
                  WHEN COALESCE(v_c.score, 0) > COALESCE(v_o.score, 0) THEN 'creator'
                  WHEN COALESCE(v_o.score, 0) > COALESCE(v_c.score, 0) THEN 'opponent'
                  ELSE 'tie'
                END);
  ELSIF v_c_result OR v_o_result THEN
    v_outcome := jsonb_build_object(
      'type',   'walkover',
      'winner', CASE WHEN v_c_result THEN 'creator' ELSE 'opponent' END);
  ELSE
    -- Nobody played. Not a tie — there was no contest.
    v_outcome := jsonb_build_object('type', 'unplayed', 'winner', NULL);
  END IF;

  RETURN jsonb_build_object(
    'duel_key',         v_d.duel_key,
    'duration_seconds', v_d.duration_seconds,
    -- The contract's exact shape (…Z) rather than to_jsonb()'s
    -- +00:00, so Date.parse in the client sees the promised string.
    'created_at',       to_char(v_d.created_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'expires_at',       to_char(v_d.expires_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    -- Derived from the clock, not read from the column: the column is
    -- a cache that duel_refresh maintains, and a reader that trusted
    -- it would report an un-refreshed duel as open past its horizon.
    'expired',          v_now > v_d.expires_at,
    'status',           CASE WHEN v_now > v_d.expires_at AND v_d.status = 'open'
                             THEN 'expired' ELSE v_d.status END,
    'seconds_until_expiry',
                        GREATEST(0, CEIL(EXTRACT(EPOCH FROM
                          (v_d.expires_at - v_now))))::INTEGER,
    -- Which side the caller is, so the client can render "your turn",
    -- "waiting for them" or "this duel is full" without guessing.
    'your_side',        v_role,
    'opponent_claimed', (v_d.opponent_id IS NOT NULL
                         OR v_d.opponent_guest_token IS NOT NULL),
    'scores_revealed',  v_reveal,
    'outcome',          v_outcome,
    'creator',          jsonb_build_object(
      'played',       v_c_found,
      'status',       CASE WHEN v_c_found THEN v_c.status END,
      'submitted_at', CASE WHEN v_c_found AND v_c.submitted_at IS NOT NULL
                           THEN to_char(v_c.submitted_at AT TIME ZONE 'UTC',
                                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
      'score',        CASE WHEN v_reveal AND v_c_result THEN v_c.score END,
      'is_you',       v_role = 'creator'),
    'opponent',         jsonb_build_object(
      'played',       v_o_found,
      'status',       CASE WHEN v_o_found THEN v_o.status END,
      'submitted_at', CASE WHEN v_o_found AND v_o.submitted_at IS NOT NULL
                           THEN to_char(v_o.submitted_at AT TIME ZONE 'UTC',
                                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
      'score',        CASE WHEN v_reveal AND v_o_result THEN v_o.score END,
      'is_you',       v_role = 'opponent')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.duel_public_payload(UUID, UUID, TEXT) FROM PUBLIC;

-- ── 5. create_duel ──────────────────────────────────────────────
-- Signed-in only. Somebody has to own a duel: an unowned one has
-- nobody to notify, nobody to rematch, and no `creator` identity for
-- §7 to refuse the opponent side to.
--
-- The sequence is generated here, once, and both sides draw from it.
-- That is the one structural difference from the daily, and it is why
-- the generator is called rather than reimplemented — the property
-- that matters is that the two players answer the identical list, and
-- a second copy of the generator is a second chance to break it.
CREATE OR REPLACE FUNCTION public.create_duel(p_duration INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_now       TIMESTAMPTZ := NOW();
  -- Clamped, not trusted, and not rejected either. p_duration arrives
  -- from a public client; an unbounded one is a request to generate
  -- and store an arbitrarily large question list. 15..600 covers
  -- every duration the game offers with room to spare, and the
  -- effective value is returned so the client shows what it got
  -- rather than what it asked for.
  v_duration  INTEGER := LEAST(GREATEST(COALESCE(p_duration, 120), 15), 600);
  v_config    JSONB;
  v_questions JSONB;
  v_key       TEXT;
  v_expires   TIMESTAMPTZ;
  v_id        UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'duel_requires_account'
      USING ERRCODE = '42501',
            HINT    = 'Sign in to create a duel.';
  END IF;

  -- The canonical config with this duel's duration written into it,
  -- so the stored config describes the duel that was actually played.
  v_config := public.daily_default_config()
              || jsonb_build_object('duration', v_duration);

  -- ~4 questions per second: comfortably past the fastest plausible
  -- run, since running out mid-game is unrecoverable while a few
  -- hundred unused questions cost a few kilobytes. Floored so a short
  -- duel still has a real list, and capped so a 600-second duel does
  -- not turn into a megabyte of JSONB.
  v_questions := public.daily_generate_questions(
                   v_config,
                   LEAST(GREATEST(v_duration * 4, 200), 2400));

  v_expires := v_now + INTERVAL '48 hours';

  -- Generated outside the insert and retried on collision. At 48 bits
  -- a collision is not going to happen; the loop is here because the
  -- alternative — SELECT-then-INSERT — is racy, and because a
  -- duplicate key must surface as a retry rather than as a 500 on the
  -- one day it does. The questions are generated once, before the
  -- loop: a retry re-rolls the key, not the puzzle.
  FOR i IN 1..8 LOOP
    v_key := public.duel_new_key();

    INSERT INTO public.duels
      (duel_key, creator_id, config, duration_seconds, questions,
       status, created_at, expires_at)
    VALUES
      (v_key, v_uid, v_config, v_duration, v_questions,
       'open', v_now, v_expires)
    ON CONFLICT (duel_key) DO NOTHING
    RETURNING id INTO v_id;

    EXIT WHEN v_id IS NOT NULL;
  END LOOP;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'duel_key_unavailable'
      USING ERRCODE = '40001',
            HINT    = 'Could not allocate a duel key; retry.';
  END IF;

  RETURN jsonb_build_object(
    'duel_key',         v_key,
    'expires_at',       to_char(v_expires AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'duration_seconds', v_duration
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_duel(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_duel(INTEGER) TO authenticated;

-- ── 6. get_duel_by_key ──────────────────────────────────────────
-- The duel's public face, and the function the invite link lands on.
-- Granted to anon, because an invited guest is anonymous by design —
-- if accepting a duel required an account the loop would die exactly
-- when it was working.
--
-- Returns SQL NULL for an unknown key, the same NULL the social layer
-- returns for an unknown username: the client renders one "no such
-- duel" page and the function is not an enumeration oracle that
-- distinguishes "wrong key" from anything else.
--
-- It emits no questions in any state. A player who is mid-run and
-- refreshes calls start_duel_run, which resumes them; this function
-- has no reason to carry the answer key and therefore does not.
--
-- VOLATILE, not STABLE: reading a duel is what closes an abandoned
-- run and settles the duel's status.
CREATE OR REPLACE FUNCTION public.get_duel_by_key(
  p_key         TEXT,
  p_guest_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_key IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_id FROM public.duels WHERE duel_key = p_key;
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM public.duel_refresh(v_id);

  RETURN public.duel_public_payload(v_id, auth.uid(), p_guest_token);
END;
$$;

REVOKE ALL ON FUNCTION public.get_duel_by_key(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_duel_by_key(TEXT, TEXT) TO anon, authenticated;

-- ── 7. start_duel_run ───────────────────────────────────────────
-- Claims a side, stamps the server clock, and hands over the
-- questions — the only function in this file that ever does.
--
-- Four things are load-bearing here.
--
-- (a) The creator takes `creator` and cannot take anything else. That
--     decision is made by duel_role (§3), whose first branch returns
--     unconditionally, and it is backed by the
--     duels_creator_is_not_opponent constraint and by an explicit
--     `creator_id <> v_uid` predicate on the claiming UPDATE below.
--     Three layers for one rule because it is the obvious exploit:
--     the creator opens their own link, plays both sides, and picks
--     whichever result flatters them.
--
-- (b) Claiming the opponent side is a conditional UPDATE on the duel
--     row, not a read followed by a write. Two guests arriving at the
--     same instant both see an unclaimed duel; only one of their
--     UPDATEs matches `opponent_id IS NULL AND opponent_guest_token
--     IS NULL`, and the loser re-reads and is refused as a spectator.
--
-- (c) A second call resumes, it does not restart. started_at is
--     written exactly once, by the INSERT, and every later call reads
--     it back and derives the remaining time from it. There is no
--     code path in this file that updates started_at — which is the
--     only way to be sure a refresh cannot buy more time — and the
--     INSERT is ON CONFLICT DO NOTHING plus a re-SELECT, so even a
--     double-clicked Start returns the first call's clock.
--
-- (d) Questions come back only while the window is open AND the run
--     is in_progress. Without it a player starts, reads the list,
--     walks away, and hands it to their opponent.
CREATE OR REPLACE FUNCTION public.start_duel_run(
  p_key         TEXT,
  p_guest_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_now       TIMESTAMPTZ := NOW();
  -- Normalised once, here, and passed on unchanged. Blank and
  -- whitespace-only tokens become NULL — "no identity" — so they can
  -- never be stored and never match anything later.
  v_token     TEXT := NULLIF(btrim(COALESCE(p_guest_token, '')), '');
  v_d         public.duels%ROWTYPE;
  v_r         public.duel_runs%ROWTYPE;
  v_role      TEXT;
  v_updated   INTEGER;
  v_deadline  TIMESTAMPTZ;
  v_remaining INTEGER;
  v_live      BOOLEAN;
BEGIN
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'duel_not_found'
      USING ERRCODE = 'P0002', HINT = 'No duel with that key.';
  END IF;

  SELECT * INTO v_d FROM public.duels WHERE duel_key = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duel_not_found'
      USING ERRCODE = 'P0002', HINT = 'No duel with that key.';
  END IF;

  PERFORM public.duel_refresh(v_d.id);
  SELECT * INTO v_d FROM public.duels WHERE id = v_d.id;

  v_role := public.duel_role(v_d.creator_id, v_d.opponent_id,
                             v_d.opponent_guest_token, v_uid, v_token);

  IF v_role = 'spectator' THEN
    -- Two different refusals, told apart so the client can say
    -- something true. No identity at all is a fixable client
    -- condition; a full duel is not.
    IF v_uid IS NULL AND v_token IS NULL THEN
      RAISE EXCEPTION 'duel_requires_identity'
        USING ERRCODE = '42501',
              HINT    = 'Sign in or supply a guest token to play this duel.';
    END IF;
    RAISE EXCEPTION 'duel_already_has_opponent'
      USING ERRCODE = '23505',
            HINT    = 'This duel already has two players.';
  END IF;

  -- ---- claim the opponent side -------------------------------------------
  IF v_role = 'open' THEN
    -- Nothing may be claimed after the horizon. An expired duel
    -- resolves with whatever exists; it does not acquire a new player.
    IF v_now > v_d.expires_at THEN
      RAISE EXCEPTION 'duel_expired'
        USING ERRCODE = '22023',
              HINT    = 'This duel has expired.';
    END IF;

    -- A guest's token is their entire identity for the next 48 hours,
    -- and it is also a bearer credential for one side of this duel.
    -- An 8-character floor is the same length js/db.js already
    -- generates and is the point below which "guess the opponent's
    -- token" stops being theoretical; the ceiling is there because
    -- this string is stored and compared on every call.
    IF v_uid IS NULL
       AND (char_length(v_token) < 8 OR char_length(v_token) > 200) THEN
      RAISE EXCEPTION 'duel_bad_guest_token'
        USING ERRCODE = '22023',
              HINT    = 'Guest token must be 8 to 200 characters.';
    END IF;

    UPDATE public.duels
    SET opponent_id          = v_uid,
        -- Exactly one of the two, never both: the CHECK in §1 would
        -- reject a row carrying an account id and a token.
        opponent_guest_token = CASE WHEN v_uid IS NULL THEN v_token END
    WHERE id = v_d.id
      AND opponent_id IS NULL
      AND opponent_guest_token IS NULL
      -- Unreachable given duel_role's first branch, and written down
      -- anyway. This is the predicate that makes "the creator cannot
      -- occupy the opponent slot" true of the statement rather than
      -- true of the caller's route to it.
      AND (v_uid IS NULL OR creator_id <> v_uid);

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    -- Lost the race, or the guard above fired. Re-read and re-decide
    -- rather than assuming: the winner may have been this same guest
    -- in a concurrent tab, in which case they are the opponent and
    -- should simply proceed.
    SELECT * INTO v_d FROM public.duels WHERE id = v_d.id;
    v_role := public.duel_role(v_d.creator_id, v_d.opponent_id,
                               v_d.opponent_guest_token, v_uid, v_token);

    IF v_role <> 'opponent' THEN
      RAISE EXCEPTION 'duel_already_has_opponent'
        USING ERRCODE = '23505',
              HINT    = 'This duel already has two players.';
    END IF;
  END IF;

  -- ---- the caller's run ---------------------------------------------------
  SELECT * INTO v_r FROM public.duel_runs
  WHERE duel_id = v_d.id AND side = v_role;

  IF NOT FOUND THEN
    -- Starting a run after the horizon is refused for the same reason
    -- claiming is: the result would be unresolvable. Note this is
    -- checked only for a NEW run — a caller who already has one
    -- always gets their payload back, expired or not, because
    -- refusing to tell someone how their own finished run went is
    -- just a broken results page.
    IF v_now > v_d.expires_at THEN
      RAISE EXCEPTION 'duel_expired'
        USING ERRCODE = '22023',
              HINT    = 'This duel has expired.';
    END IF;

    INSERT INTO public.duel_runs
      (duel_id, side, user_id, guest_token, started_at, status)
    VALUES
      (v_d.id, v_role, v_uid,
       CASE WHEN v_uid IS NULL THEN v_token END,
       v_now, 'in_progress')
    ON CONFLICT (duel_id, side) DO NOTHING;

    -- Unconditional re-SELECT rather than branching on the insert:
    -- after ON CONFLICT DO NOTHING we cannot tell whether we won
    -- without asking, and the answer we need — the row that is
    -- actually there, with the started_at that is actually stored —
    -- is the same either way.
    SELECT * INTO v_r FROM public.duel_runs
    WHERE duel_id = v_d.id AND side = v_role;
  END IF;

  -- ---- lazy expiry of this run -------------------------------------------
  v_deadline := public.duel_run_deadline(v_r.started_at, v_d.duration_seconds,
                                         v_d.expires_at);

  IF v_r.status = 'in_progress'
     AND v_now > v_deadline + make_interval(secs => 3) THEN
    UPDATE public.duel_runs
    SET status = 'expired',
        score  = COALESCE(score, 0)
    WHERE duel_id = v_d.id AND side = v_role
    RETURNING * INTO v_r;

    -- Closing this run may have completed the duel.
    PERFORM public.duel_refresh(v_d.id);
  END IF;

  -- Remaining time is measured against the deadline, not the grace
  -- period. The 3s grace exists to absorb network latency on the
  -- submit, not to be spent answering.
  v_remaining := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_deadline - v_now))))::INTEGER;

  v_live := (v_r.status = 'in_progress' AND v_remaining > 0);

  RETURN jsonb_build_object(
    'duel_key',          v_d.duel_key,
    'side',              v_role,
    'duration_seconds',  v_d.duration_seconds,
    'started_at',        to_char(v_r.started_at AT TIME ZONE 'UTC',
                                 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'seconds_remaining', CASE WHEN v_live THEN v_remaining ELSE 0 END,
    'status',            v_r.status,
    -- The whole security property, in one CASE. It is the same
    -- expression whether the run is complete, expired, or merely out
    -- of time: there is no state in which a caller who is not mid-run
    -- can see the question list.
    'questions',         CASE WHEN v_live THEN v_d.questions END,
    -- The duel around the run — statuses always, scores only if §4
    -- says so. A player who has just started sees their opponent's
    -- status and not their number.
    'duel',              public.duel_public_payload(v_d.id, v_uid, v_token)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_duel_run(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_duel_run(TEXT, TEXT) TO anon, authenticated;

-- ── 8. submit_duel_run ──────────────────────────────────────────
-- The only place a duel score is decided.
--
-- The client sends [{i, value, elapsed_ms}] and is not consulted
-- about the score. If the payload contains a `score` key it is read
-- by nothing here; the score is counted from duels.questions, which
-- the client has seen but cannot write.
--
-- The awkward requirement is that a *malformed* payload must not
-- raise. A client bug that sends a string where a number belongs is a
-- bug, not an attack, and it must not surface as a 500 that looks
-- like the server fell over. So every field is checked with
-- jsonb_typeof before it is cast, and anything that fails is dropped
-- rather than fatal. The genuine rejections — a closed window, a
-- second submission, a caller who is not a player — do raise, because
-- those the client must be told about unambiguously.
CREATE OR REPLACE FUNCTION public.submit_duel_run(
  p_key         TEXT,
  p_guest_token TEXT,
  p_answers     JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_now      TIMESTAMPTZ := NOW();
  v_token    TEXT := NULLIF(btrim(COALESCE(p_guest_token, '')), '');
  v_d        public.duels%ROWTYPE;
  v_r        public.duel_runs%ROWTYPE;
  v_role     TEXT;
  v_deadline TIMESTAMPTZ;
  v_raw      JSONB;
  v_elem     JSONB;
  v_total_q  INTEGER;
  v_max_ms   NUMERIC;
  v_i_num    NUMERIC;
  v_ms       NUMERIC;
  v_prev_ms  NUMERIC := -1;
  v_i        INTEGER;
  v_seen     BOOLEAN[];
  v_kept     JSONB := '[]'::JSONB;
  v_kept_arr JSONB[] := ARRAY[]::JSONB[];
  v_score    INTEGER := 0;
  v_answered INTEGER := 0;
BEGIN
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'duel_not_found'
      USING ERRCODE = 'P0002', HINT = 'No duel with that key.';
  END IF;

  SELECT * INTO v_d FROM public.duels WHERE duel_key = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duel_not_found'
      USING ERRCODE = 'P0002', HINT = 'No duel with that key.';
  END IF;

  -- Deliberately NOT refreshed first. duel_refresh would mark a run
  -- past its deadline 'expired', and this function would then report
  -- "already submitted" for what is really a late submission. The
  -- clock is checked here, explicitly, so the refusal names the right
  -- reason.
  v_role := public.duel_role(v_d.creator_id, v_d.opponent_id,
                             v_d.opponent_guest_token, v_uid, v_token);

  IF v_role NOT IN ('creator', 'opponent') THEN
    -- 'open' lands here too: an identity that could have claimed the
    -- opponent side but never did has no run to submit against.
    -- Submitting is not a way to skip starting.
    RAISE EXCEPTION 'duel_not_started'
      USING ERRCODE = 'P0002',
            HINT    = 'Call start_duel_run() before submitting.';
  END IF;

  SELECT * INTO v_r FROM public.duel_runs
  WHERE duel_id = v_d.id AND side = v_role;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'duel_not_started'
      USING ERRCODE = 'P0002',
            HINT    = 'Call start_duel_run() before submitting.';
  END IF;

  -- The one-run-per-side rule at the point it actually bites. A run
  -- that already expired lands here too, which is correct: it is
  -- closed, and a closed run does not take answers.
  IF v_r.status <> 'in_progress' THEN
    RAISE EXCEPTION 'duel_already_submitted'
      USING ERRCODE = '23505',
            HINT    = 'This side of the duel has already been played.';
  END IF;

  -- ---- the clock ----------------------------------------------------------
  -- Server clock, both ends. started_at was written by the server and
  -- v_now is read from the server; nothing a client sends enters this
  -- comparison, so there is nothing to pause, slow or rewind. The 3s
  -- grace is for the round trip, not for thinking.
  --
  -- Note the run is NOT marked expired here: RAISE aborts the
  -- transaction and would roll the mark back anyway. §4 and §7 both
  -- close it lazily on the next call, and a row left in_progress in
  -- the meantime is harmless — a retry re-checks this same clock.
  v_deadline := public.duel_run_deadline(v_r.started_at, v_d.duration_seconds,
                                         v_d.expires_at);

  IF v_now > v_deadline + make_interval(secs => 3) THEN
    RAISE EXCEPTION 'duel_window_closed'
      USING ERRCODE = '22023',
            HINT    = 'The window for this run has passed.';
  END IF;

  v_total_q := COALESCE(jsonb_array_length(v_d.questions), 0);
  v_max_ms  := GREATEST(COALESCE(v_d.duration_seconds, 0), 0)::NUMERIC * 1000;

  -- ---- normalise the payload ---------------------------------------------
  -- Not an array (null, an object, a bare string, absent): treat as no
  -- answers rather than erroring. The player gets a zero, which is
  -- what they earned, and the client gets a payload instead of a 500.
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'array' THEN
    v_raw := '[]'::JSONB;
  ELSE
    v_raw := p_answers;
  END IF;

  IF v_total_q > 0 THEN
    v_seen := array_fill(FALSE, ARRAY[v_total_q]);
  END IF;

  -- Walked in order rather than aggregated, because the non-decreasing
  -- check is inherently sequential.
  FOR v_elem IN SELECT value FROM jsonb_array_elements(v_raw) LOOP
    -- Structure. Each of these is a client bug, and each drops one
    -- answer rather than the whole submission.
    --
    -- IS DISTINCT FROM, not <>. An ABSENT key makes `v_elem->'i'` a
    -- SQL NULL, jsonb_typeof(NULL) is NULL, and `NULL <> 'number'` is
    -- NULL — which CONTINUE WHEN treats as false and lets the row
    -- through to be cast. That is the exact path a payload like
    -- [{"nope": 1}] takes, and it ends in a null array subscript and
    -- the 500 this function exists to avoid. Three-valued logic is
    -- the whole hazard of validating client JSON, so every check
    -- below is written to be total.
    CONTINUE WHEN jsonb_typeof(v_elem) IS DISTINCT FROM 'object';
    CONTINUE WHEN jsonb_typeof(v_elem->'i') IS DISTINCT FROM 'number';
    CONTINUE WHEN jsonb_typeof(v_elem->'elapsed_ms') IS DISTINCT FROM 'number';

    -- Read as NUMERIC first and range-check before casting to INT. A
    -- JSON number may be 1e400, and ::INT on that is an overflow error
    -- — which is exactly the 500 this function must not produce.
    v_i_num := (v_elem->>'i')::NUMERIC;
    v_ms    := (v_elem->>'elapsed_ms')::NUMERIC;

    -- Total by construction: anything not provably an in-range whole
    -- number is dropped, so NULL fails the test rather than passing
    -- it. v_total_q = 0 (a duel with no questions, which §5 cannot
    -- produce but a hand-edited row could) makes this reject
    -- everything rather than subscript an unallocated array.
    CONTINUE WHEN NOT (v_i_num >= 0 AND v_i_num < v_total_q
                       AND v_i_num = floor(v_i_num));
    v_i := v_i_num::INTEGER;

    -- Past the end of the window: unreachable, so it did not happen.
    CONTINUE WHEN NOT (v_ms >= 0 AND v_ms <= v_max_ms);

    -- Time does not run backwards. The offending entry is dropped and
    -- v_prev_ms is left alone, so one bad row cannot truncate the rest
    -- of an otherwise ordered run.
    CONTINUE WHEN v_ms < v_prev_ms;

    -- The same question answered twice would otherwise score twice.
    CONTINUE WHEN COALESCE(v_seen[v_i + 1], FALSE);
    v_seen[v_i + 1] := TRUE;

    -- Accepted. It counts as answered whatever `value` turned out to
    -- be: a non-numeric value is a wrong answer, not a free pass, or a
    -- client could inflate its accuracy by sending junk it knows will
    -- be discarded.
    v_answered := v_answered + 1;
    v_prev_ms  := v_ms;

    IF jsonb_typeof(v_elem->'value') = 'number'
       AND jsonb_typeof(v_d.questions->v_i->'answer') = 'number'
       AND (v_elem->>'value')::NUMERIC
           = (v_d.questions->v_i->>'answer')::NUMERIC THEN
      v_score := v_score + 1;
    END IF;

    -- Rebuilt from the three fields this function actually read, so
    -- whatever else the client attached — a `score`, a `correct` flag,
    -- a megabyte of padding — is not what gets stored.
    v_kept_arr := v_kept_arr || jsonb_build_object(
      'i',          v_i,
      'value',      CASE WHEN jsonb_typeof(v_elem->'value') = 'number'
                         THEN v_elem->'value' ELSE 'null'::JSONB END,
      'elapsed_ms', floor(v_ms)::BIGINT
    );
  END LOOP;

  -- WITH ORDINALITY and an explicit ORDER BY: unnest happens to emit
  -- array order today, but jsonb_agg without ORDER BY is only ever
  -- accidentally ordered, and the stored answers are read back as a
  -- timeline — which is what the pace graph in docs/duels-design.md
  -- will be drawn from.
  SELECT COALESCE(jsonb_agg(e.val ORDER BY e.ord), '[]'::JSONB) INTO v_kept
  FROM unnest(v_kept_arr) WITH ORDINALITY AS e(val, ord);

  -- ---- commit -------------------------------------------------------------
  -- Guarded by status so that two submits racing each other cannot
  -- both win: the second updates zero rows. The read above would
  -- normally have caught it, but two concurrent transactions can both
  -- have read 'in_progress'.
  UPDATE public.duel_runs
  SET submitted_at = v_now,
      score        = v_score,
      answers      = v_kept,
      status       = 'complete'
  WHERE duel_id = v_d.id
    AND side    = v_role
    AND status  = 'in_progress';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'duel_already_submitted'
      USING ERRCODE = '23505',
            HINT    = 'This side of the duel has already been played.';
  END IF;

  -- This submission may have completed the duel, which is what makes
  -- the payload below reveal both scores — to both players, at the
  -- same moment, and not before.
  PERFORM public.duel_refresh(v_d.id);

  RETURN jsonb_build_object(
    'side',           v_role,
    -- The caller's OWN score, always. It is theirs, they just earned
    -- it, and withholding it would be theatre.
    'score',          v_score,
    'total_answered', v_answered,
    -- 0/0 is not 1.0, it is unknown. A player who submitted an empty
    -- answer list has no accuracy, and JSON null lets the client
    -- render a dash instead of a flattering 100%.
    'accuracy',       CASE WHEN v_answered > 0
                           THEN round(v_score::NUMERIC / v_answered, 3) END,
    'duel',           public.duel_public_payload(v_d.id, v_uid, v_token)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_duel_run(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_duel_run(TEXT, TEXT, JSONB)
  TO anon, authenticated;

-- ── 9. Indexes ──────────────────────────────────────────────────
-- duel_key is UNIQUE, which already builds the btree every lookup in
-- this file goes through, and duel_runs' PRIMARY KEY (duel_id, side)
-- leads with duel_id — so it serves both the per-side fetch and the
-- "all runs of this duel" scan in duel_refresh. Neither needs an
-- index of its own; the ones below are for the queries this file does
-- not contain yet.

-- "My duels", newest first — the dashboard list.
CREATE INDEX IF NOT EXISTS idx_duels_creator
  ON public.duels (creator_id, created_at DESC);

-- The same list from the other side. Partial because the column is
-- NULL for every unaccepted duel and for every guest opponent, which
-- in practice is most rows.
CREATE INDEX IF NOT EXISTS idx_duels_opponent
  ON public.duels (opponent_id, created_at DESC)
  WHERE opponent_id IS NOT NULL;

-- The sweep a future cleanup job would want: duels still open past
-- their horizon. Partial on status so the index stays roughly the
-- size of the set of duels currently in flight rather than growing
-- with every duel ever created.
CREATE INDEX IF NOT EXISTS idx_duels_open_expiry
  ON public.duels (expires_at)
  WHERE status = 'open';

-- Runs belonging to an account, for a per-player duel history. Guest
-- runs are excluded: a guest token is not a person and grouping by it
-- would invent one.
CREATE INDEX IF NOT EXISTS idx_duel_runs_user
  ON public.duel_runs (user_id)
  WHERE user_id IS NOT NULL;
