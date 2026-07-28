-- ────────────────────────────────────────────────────────────────
--  Steal mode — the real-time duel variant. First correct answer
--  takes the point and both players jump to the next question.
--
--  Apply by hand in the Supabase SQL Editor, AFTER duels.sql and
--  BEFORE settings.sql / account.sql. duels.sql is a hard dependency,
--  not an ordering preference: this file extends `duels` and
--  `duel_runs`, calls duel_role / duel_run_deadline / duel_pace_points,
--  and replaces duel_public_payload.
--
--  The contract this implements is docs/steal-mode-design.md; if the
--  two ever disagree, the doc is the spec and this is the bug. Two
--  places where the doc could not be implemented as literally written
--  are called out at the point of divergence — search for SPEC NOTE.
--
--  ⚠ ORDERING HAZARD, and the reason this file is not order-free like
--  the rest. §3 DROPs the one-argument create_duel(INTEGER) and
--  replaces it with create_duel(INTEGER, TEXT DEFAULT 'classic').
--  Keeping both would be an *ambiguous* overload: PostgreSQL cannot
--  choose between f(int) and f(int, text DEFAULT ...) for the call
--  `create_duel(120)` and raises "function create_duel(integer) is not
--  unique" — which would break every existing caller rather than none.
--
--  So: **re-applying duels.sql after this file resurrects the
--  one-argument version and makes create_duel ambiguous.** If you ever
--  re-apply duels.sql, re-apply this file straight afterwards. That is
--  the same rule README.md already states for settings.sql, and
--  supabase/test/run.sh exercises exactly that sequence.
--
--  Everything else here is idempotent in the usual way: CREATE TABLE
--  IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, and
--  constraints re-asserted through pg_constraint lookups because
--  ADD CONSTRAINT has no IF NOT EXISTS.
--
--  SET search_path = public on every SECURITY DEFINER function, for
--  the reason duels.sql gives: without it, unqualified names resolve
--  against the *caller's* search_path.
-- ────────────────────────────────────────────────────────────────

-- ── 1. The mode flag ────────────────────────────────────────────
-- Defaulted, so every row that already exists is a classic duel and
-- every function written before this file keeps behaving identically.
-- That is the single most important constraint on this migration:
-- supabase/test/04-duels-test.sql is the regression test for classic
-- duels and must pass completely untouched.
ALTER TABLE public.duels
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'classic';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.duels'::REGCLASS
      AND conname  = 'duels_mode_valid'
  ) THEN
    ALTER TABLE public.duels
      ADD CONSTRAINT duels_mode_valid
      CHECK (mode IN ('classic', 'steal'));
  END IF;
END $$;

-- ── 2. duel_points ──────────────────────────────────────────────
-- One row per question that has been won, and the arbitration record
-- for it.
--
-- PRIMARY KEY (duel_id, question_index) IS the arbitration. An award
-- is one INSERT that either conflicts or does not; two players racing
-- the same question cannot both produce a row, and the loser's
-- statement blocks on the winner's row lock and is then re-evaluated
-- against the committed value rather than against a snapshot taken
-- before it existed. That is what makes this immune to the
-- check-then-act bug a read-then-write would have.
--
-- `awarded_at` is the moment the FIRST claim for this question was
-- written, and is never moved by a replacement inside the grace
-- window (§4) — otherwise a client could keep a point unsettled
-- indefinitely by claiming it repeatedly.
--
-- `settled_at` is awarded_at + the grace window: the instant the point
-- stops being provisional. It is a materialised convenience for
-- anything reading the table directly — **awarded_at is the
-- authority**, and every decision in §6 derives the window from it.
-- Storing the derived value and then also deciding from it would make
-- the two disagree the moment either is corrected, and this is not a
-- column worth a trigger.
CREATE TABLE IF NOT EXISTS public.duel_points (
  duel_id        UUID    NOT NULL REFERENCES public.duels(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL,
  winner_side    TEXT    NOT NULL
    CONSTRAINT duel_points_winner_side_valid
    CHECK (winner_side IN ('creator', 'opponent')),
  elapsed_ms     INTEGER NOT NULL
    CONSTRAINT duel_points_elapsed_nonneg
    CHECK (elapsed_ms >= 0),
  awarded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at     TIMESTAMPTZ,
  PRIMARY KEY (duel_id, question_index)
);

-- Re-assert the product rules for a database that already carries an
-- older shape of this table. CREATE TABLE IF NOT EXISTS is a no-op on
-- an existing table and reconciles nothing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.duel_points'::REGCLASS
      AND conname  = 'duel_points_winner_side_valid'
  ) THEN
    ALTER TABLE public.duel_points
      ADD CONSTRAINT duel_points_winner_side_valid
      CHECK (winner_side IN ('creator', 'opponent'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.duel_points'::REGCLASS
      AND conname  = 'duel_points_elapsed_nonneg'
  ) THEN
    ALTER TABLE public.duel_points
      ADD CONSTRAINT duel_points_elapsed_nonneg
      CHECK (elapsed_ms >= 0);
  END IF;
END $$;

-- The same posture as every table added since hardening.sql: RLS on,
-- no policies at all, grants revoked. The anon key ships in
-- js/config.js, so a policy permissive enough to let a player read
-- their own duel's points is permissive enough to hand the live score
-- of a duel in progress to anyone holding the key. Every read and
-- write goes through the SECURITY DEFINER functions below.
--
-- ENABLE, not FORCE: FORCE would subject the table owner to RLS too,
-- and with no policies that locks out the functions themselves.
ALTER TABLE public.duel_points ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.duel_points FROM anon, authenticated;

-- The claim path reads "the highest awarded index for this duel" on
-- every single claim, which the primary key already serves (it leads
-- with duel_id and orders by question_index). No extra index.

-- ── 3. create_duel gains a mode ─────────────────────────────────
-- See the ORDERING HAZARD note at the top of this file: the old
-- one-argument function is dropped rather than left in place, because
-- an int overload plus an (int, text DEFAULT) overload makes the
-- one-argument call ambiguous rather than compatible.
--
-- Dropping is safe here: nothing in this project's SQL calls
-- create_duel — only the client and the test suites do — so there is
-- no dependent function body to invalidate.
DROP FUNCTION IF EXISTS public.create_duel(INTEGER);

-- Otherwise identical to duels.sql §5, including the duration clamp
-- and the key-collision retry loop. The mode is validated rather than
-- clamped: silently handing somebody a classic duel when they asked
-- for a steal duel is a worse failure than an error, because they
-- would not find out until the room never appeared.
CREATE OR REPLACE FUNCTION public.create_duel(
  p_duration INTEGER,
  p_mode     TEXT DEFAULT 'classic'
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
  v_duration  INTEGER := LEAST(GREATEST(COALESCE(p_duration, 120), 15), 600);
  -- NULL means "unspecified", which is a classic duel — the whole
  -- point of the default. An unrecognised string is a different thing
  -- and is refused below.
  v_mode      TEXT := lower(btrim(COALESCE(p_mode, 'classic')));
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

  IF v_mode = '' THEN
    v_mode := 'classic';
  END IF;

  IF v_mode NOT IN ('classic', 'steal') THEN
    RAISE EXCEPTION 'duel_bad_mode'
      USING ERRCODE = '22023',
            HINT    = 'Duel mode must be classic or steal.';
  END IF;

  v_config := public.daily_default_config()
              || jsonb_build_object('duration', v_duration);

  v_questions := public.daily_generate_questions(
                   v_config,
                   LEAST(GREATEST(v_duration * 4, 200), 2400));

  v_expires := v_now + INTERVAL '48 hours';

  FOR i IN 1..8 LOOP
    v_key := public.duel_new_key();

    INSERT INTO public.duels
      (duel_key, creator_id, config, duration_seconds, questions,
       status, mode, created_at, expires_at)
    VALUES
      (v_key, v_uid, v_config, v_duration, v_questions,
       'open', v_mode, v_now, v_expires)
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
    'mode',             v_mode,
    'expires_at',       to_char(v_expires AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'duration_seconds', v_duration
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_duel(INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_duel(INTEGER, TEXT) TO authenticated;

-- ── 4. The grace window, as a named constant ────────────────────
-- 400 ms covers a realistic worst-case round trip while staying under
-- the threshold at which a settled score visibly flickers.
--
-- A function rather than a literal for the reason the design doc
-- gives: there is exactly one place to read it, one place to change
-- it, and one thing for a test to point at. Nothing that follows
-- contains the number 400.
--
-- Not granted to the API roles. A client that needs to know whether a
-- point may still move is told so by `provisional` on the claim it
-- just made; it has no use for the constant itself.
CREATE OR REPLACE FUNCTION public.duel_point_grace_ms()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 400;
$$;

REVOKE ALL ON FUNCTION public.duel_point_grace_ms() FROM PUBLIC;

-- The same constant as an INTERVAL, so the arithmetic below reads as
-- a time and not as a unit conversion.
CREATE OR REPLACE FUNCTION public.duel_point_grace()
RETURNS INTERVAL
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT make_interval(secs => public.duel_point_grace_ms()::NUMERIC / 1000.0);
$$;

REVOKE ALL ON FUNCTION public.duel_point_grace() FROM PUBLIC;

-- ── 5. Steal scoring ────────────────────────────────────────────
-- A side's steal score is the number of points it holds, counted here
-- and nowhere else. The client is never asked what it scored and is
-- never believed if it volunteers one — the same rule submit_duel_run
-- follows for classic duels, applied to the one table that records
-- who actually got there first.
--
-- Note this deliberately does NOT read duel_runs.score. In a steal
-- duel that column holds "questions I answered correctly", which is
-- not the same number as "questions I won" — you can answer every
-- question right and score nothing if you were slower every time.
CREATE OR REPLACE FUNCTION public.duel_steal_score(p_duel_id UUID, p_side TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.duel_points p
  WHERE p.duel_id = p_duel_id AND p.winner_side = p_side;
$$;

REVOKE ALL ON FUNCTION public.duel_steal_score(UUID, TEXT) FROM PUBLIC;

-- ── 6. claim_duel_point ─────────────────────────────────────────
-- The whole of arbitration, in one function.
--
-- Arbitration is NOT first-message-wins. If A answers at 1000 ms and B
-- at 1005 ms but A's packet takes 80 ms and B's takes 20 ms, the
-- server sees B first; awarding on arrival order makes the game a ping
-- contest. So the claim carries the client's time since the question
-- was rendered and the server decides on that — clamped, because a
-- number the client supplies is a number the client can lie about:
--
--   elapsed_clamped = LEAST(GREATEST(p_elapsed_ms, 0),
--                           server_ms_since(question_became_current))
--
-- `question_became_current` is server-known without trusting anybody:
-- the awarded_at of the previous question's point, or the caller's own
-- duel_runs.started_at for the first question. A client claiming 5 ms
-- on a question the server released 3 ms ago is clamped to 3 ms, and a
-- client claiming it answered question 12 in 40 ms when question 11
-- was decided 20 ms ago cannot fabricate a lead it never had. That
-- clamp is the whole security model: a cheat can only ever claim to be
-- as fast as the physics the server already observed.
--
-- SPEC NOTE — the answer parameter. docs/steal-mode-design.md gives
-- the signature as (p_key, p_guest_token, p_index, p_elapsed_ms) and
-- in the very next bullet requires that "the answer is checked on the
-- server against the stored question" and that a wrong answer returns
-- {ok:false, error:'wrong'}. Those two cannot both be true: with no
-- answer parameter there is nothing to check and 'wrong' is
-- unreachable. Rather than drop the server-side check — which is the
-- one invariant this project does not bend, and which is what stops a
-- client winning every question by claiming it typed something —
-- p_answer is added as a fifth parameter with a DEFAULT, so a
-- four-argument call still resolves. A claim that supplies no answer
-- supplies no evidence and is 'wrong'; it never awards a point.
--
-- SPEC NOTE — the return of a losing claim. The doc names point_taken
-- only for claims arriving after the window has settled. This function
-- returns it for any claim that does not end up holding the point,
-- settled or not, so that `ok` means exactly one thing: did you get
-- it. `winner`, `elapsed_ms` and `provisional` are returned either
-- way, which is what the UI needs to render the steal against you.
CREATE OR REPLACE FUNCTION public.claim_duel_point(
  p_key         TEXT,
  p_guest_token TEXT,
  p_index       INTEGER,
  p_elapsed_ms  INTEGER,
  p_answer      NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  -- clock_timestamp(), not NOW(). NOW() is the transaction's start
  -- time, and the losing claim in a race spends its time BLOCKED on
  -- the winner's row lock — so a statement-time clock would charge the
  -- loser for the winner's transaction and could push a claim that
  -- genuinely arrived inside the grace window outside it. Captured
  -- once, here, and used for the clamp, the insert and the window
  -- comparison alike, so all three agree on when this claim arrived.
  v_now       TIMESTAMPTZ := clock_timestamp();
  v_token     TEXT := NULLIF(btrim(COALESCE(p_guest_token, '')), '');
  v_d         public.duels%ROWTYPE;
  v_r         public.duel_runs%ROWTYPE;
  v_p         public.duel_points%ROWTYPE;
  v_role      TEXT;
  v_total     INTEGER;
  v_max       INTEGER;
  v_next      INTEGER;
  v_since     TIMESTAMPTZ;
  v_server_ms NUMERIC;
  v_ms        INTEGER;
  v_ok        BOOLEAN;
  v_out       JSONB;
BEGIN
  -- An unknown or absent key is refused as data, not raised. Two
  -- reasons, and they point the same way. This function is called once
  -- per question in a live game, so a refusal it can meet legitimately
  -- must not arrive as an exception the client has to unwrap mid-run;
  -- and answering "no such duel" differently from "not your duel"
  -- would make the function an enumeration oracle for duel keys, which
  -- get_duel_by_key deliberately is not. A caller with no duel is not
  -- a participant of one.
  IF p_key IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_a_participant');
  END IF;

  SELECT * INTO v_d FROM public.duels WHERE duel_key = p_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_a_participant');
  END IF;

  -- ---- who is claiming ----------------------------------------------------
  v_role := public.duel_role(v_d.creator_id, v_d.opponent_id,
                             v_d.opponent_guest_token, v_uid, v_token);

  IF v_role NOT IN ('creator', 'opponent') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_a_participant');
  END IF;

  SELECT * INTO v_r FROM public.duel_runs
  WHERE duel_id = v_d.id AND side = v_role;

  -- "A participant with a run in progress." A participant whose run
  -- has not started, has been submitted, or has run past its deadline
  -- is not one. The deadline is checked here rather than by calling
  -- duel_refresh: refresh writes, and a write on the hot path of a
  -- real-time game is contention between the two players for no gain.
  -- The 3-second grace is submit_duel_run's, so the two agree on when
  -- a run is over.
  IF NOT FOUND
     OR v_r.status IS DISTINCT FROM 'in_progress'
     OR v_now > public.duel_run_deadline(v_r.started_at, v_d.duration_seconds,
                                         v_d.expires_at)
                + make_interval(secs => 3) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_a_participant');
  END IF;

  -- ---- the right kind of duel ---------------------------------------------
  -- IS DISTINCT FROM, not <>: mode is NOT NULL today, and a guard that
  -- silently stops firing if that ever changes is the exact trap this
  -- codebase has already paid for twice.
  IF v_d.mode IS DISTINCT FROM 'steal' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'wrong_mode');
  END IF;

  -- ---- the right question -------------------------------------------------
  v_total := COALESCE(jsonb_array_length(v_d.questions), 0);

  -- The duel's current index: one past the highest question already
  -- awarded, and 0 when nothing has been. There is no separate cursor
  -- to keep in step with the points table — the points table IS the
  -- cursor.
  SELECT MAX(p.question_index) INTO v_max
  FROM public.duel_points p
  WHERE p.duel_id = v_d.id;

  v_next := COALESCE(v_max, -1) + 1;

  -- SPEC NOTE — which indices are claimable. The doc says p_index
  -- "must be the duel's current index (the highest awarded index + 1)"
  -- and that anything else is stale_index. Taken literally that makes
  -- the grace window unreachable: the instant the first claim is
  -- written the current index moves on, so the second player's claim
  -- for the question they were both racing arrives one behind and is
  -- refused as stale before arbitration ever runs. The whole of §4 of
  -- the design would be dead code.
  --
  -- So the claimable set is the next index AND the one most recently
  -- awarded — which is the only index a claim can legitimately be
  -- "late" for, and the only one the grace window applies to. Anything
  -- further back, or ahead, is genuinely stale: that is what a client
  -- racing ahead on an optimistic advance gets. `current_index` comes
  -- back so it can resynchronise without a second round trip.
  --
  -- A claim for the most recent index that arrives after its window
  -- has closed is not refused here — it falls through to the INSERT
  -- below, loses the conflict, and is answered with point_taken, which
  -- is the refusal the doc names for exactly that case.
  IF p_index IS NULL
     OR p_index < 0
     OR p_index >= v_total
     OR (p_index IS DISTINCT FROM v_next AND p_index IS DISTINCT FROM v_max) THEN
    RETURN jsonb_build_object(
      'ok',            FALSE,
      'error',         'stale_index',
      'index',         p_index,
      'current_index', v_next);
  END IF;

  -- ---- the answer, checked here and only here -----------------------------
  -- See the SPEC NOTE above. A wrong answer awards nothing and
  -- advances nobody; it costs the claimer only their own time.
  IF p_answer IS NULL
     OR jsonb_typeof(v_d.questions->p_index->'answer') IS DISTINCT FROM 'number'
     OR (v_d.questions->p_index->>'answer')::NUMERIC <> p_answer THEN
    RETURN jsonb_build_object(
      'ok',    FALSE,
      'error', 'wrong',
      'index', p_index);
  END IF;

  -- ---- the clamp ----------------------------------------------------------
  IF p_index = 0 THEN
    v_since := v_r.started_at;
  ELSE
    SELECT p.awarded_at INTO v_since
    FROM public.duel_points p
    WHERE p.duel_id = v_d.id AND p.question_index = p_index - 1;
  END IF;

  -- Unreachable — v_next is defined as one past a row that exists —
  -- and written down so a future change cannot turn a missing row into
  -- a NULL interval and a claim of zero milliseconds.
  v_since := COALESCE(v_since, v_r.started_at);

  v_server_ms := GREATEST(0,
                   floor(EXTRACT(EPOCH FROM (v_now - v_since)) * 1000));

  -- COALESCE to the server's own observation rather than to 0. A
  -- client that omits elapsed_ms must not thereby claim to have
  -- answered instantly, which is what GREATEST(NULL, 0) — Postgres
  -- ignores NULLs — would silently hand it.
  v_ms := LEAST(GREATEST(COALESCE(p_elapsed_ms::NUMERIC, v_server_ms), 0),
                v_server_ms,
                2147483647)::INTEGER;

  -- ---- arbitration --------------------------------------------------------
  -- One statement. The primary key decides whether this is the first
  -- claim or a challenge to one, and the ON CONFLICT target row is
  -- locked for the duration — so a second claimant does not read a
  -- snapshot from before the first insert, it waits and is then judged
  -- against the row that actually exists.
  --
  -- The replacement rule, exactly as the doc states it:
  --   * only inside the grace window (v_now < settled_at), and
  --   * only for a strictly smaller clamped elapsed time, or
  --   * on an exact tie, for 'creator' — arbitrary, but deterministic
  --     and written down, which is what a tie-break has to be. Note
  --     the tie-break is evaluated against the stored row rather than
  --     against arrival order, so it decides the same way whichever
  --     claim the server happened to see first.
  --
  -- awarded_at and settled_at are NOT touched by a replacement: the
  -- window runs from the first write, or a client could hold a point
  -- open forever by claiming it repeatedly.
  INSERT INTO public.duel_points AS dp
    (duel_id, question_index, winner_side, elapsed_ms, awarded_at, settled_at)
  VALUES
    (v_d.id, p_index, v_role, v_ms, v_now, v_now + public.duel_point_grace())
  ON CONFLICT (duel_id, question_index) DO UPDATE
    SET winner_side = EXCLUDED.winner_side,
        elapsed_ms  = EXCLUDED.elapsed_ms
    WHERE v_now < dp.awarded_at + public.duel_point_grace()
      AND (EXCLUDED.elapsed_ms < dp.elapsed_ms
           OR (EXCLUDED.elapsed_ms = dp.elapsed_ms
               AND EXCLUDED.winner_side = 'creator'
               AND dp.winner_side <> 'creator'))
  RETURNING * INTO v_p;

  -- No row came back: either the conflicting row beat this claim, or
  -- the window had closed. Read what is actually there — by now the
  -- other transaction has committed, so this SELECT sees it — and
  -- report from that rather than from what this call hoped for.
  IF NOT FOUND THEN
    SELECT * INTO v_p FROM public.duel_points
    WHERE duel_id = v_d.id AND question_index = p_index;
  END IF;

  -- `ok` means one thing: does the caller hold this point now. It is
  -- true when this claim took it, and true when an earlier claim by
  -- the same side already held it with a better time.
  v_ok := (v_p.winner_side = v_role);

  v_out := jsonb_build_object(
    'ok',          v_ok,
    'index',       p_index,
    'side',        v_role,
    'winner',      v_p.winner_side,
    -- The winning time, not the caller's. A losing client needs the
    -- number to say "they had it in 1.4s".
    'elapsed_ms',  v_p.elapsed_ms,
    -- Honest about the fact that this may still move, so the UI can
    -- show the point muted and let it firm up rather than award it and
    -- snatch it back.
    'provisional', v_now < v_p.awarded_at + public.duel_point_grace());

  IF NOT v_ok THEN
    v_out := v_out || jsonb_build_object('error', 'point_taken');
  END IF;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_duel_point(TEXT, TEXT, INTEGER, INTEGER, NUMERIC)
  FROM PUBLIC;
-- anon as well as authenticated: guests play duels, and a guest is the
-- most likely second player in a steal duel — the invite is a link.
GRANT EXECUTE ON FUNCTION public.claim_duel_point(TEXT, TEXT, INTEGER, INTEGER, NUMERIC)
  TO anon, authenticated;

-- ── 7. The public face, with steal scores ───────────────────────
-- Verbatim duels.sql §4 with one change, marked below: for a steal
-- duel the two scores are counted from duel_points instead of read
-- from duel_runs.score.
--
-- Replacing the function rather than adding a second one keeps the
-- "no scores until both are done" rule with exactly one
-- implementation, which is the property duels.sql was built around.
-- The reveal gate, the walkover/unplayed outcome types, the pace
-- points and everything the payload refuses to emit are unchanged —
-- a finished steal duel reveals its scores under exactly the same
-- rule as a classic one.
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
  v_c_score  INTEGER;
  v_o_score  INTEGER;
  v_reveal   BOOLEAN;
  v_role     TEXT;
  v_outcome  JSONB;
  v_c_name   TEXT;
  v_o_name   TEXT;
BEGIN
  SELECT * INTO v_d FROM public.duels WHERE id = p_duel_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT p.username INTO v_c_name
    FROM public.profiles p WHERE p.id = v_d.creator_id;

  IF v_d.opponent_id IS NOT NULL THEN
    SELECT p.username INTO v_o_name
      FROM public.profiles p WHERE p.id = v_d.opponent_id;
  END IF;

  SELECT * INTO v_c FROM public.duel_runs
  WHERE duel_id = v_d.id AND side = 'creator';
  v_c_found := FOUND;

  SELECT * INTO v_o FROM public.duel_runs
  WHERE duel_id = v_d.id AND side = 'opponent';
  v_o_found := FOUND;

  v_c_result := v_c_found AND v_c.status IN ('complete', 'expired');
  v_o_result := v_o_found AND v_o.status IN ('complete', 'expired');

  -- ---- the one change from duels.sql §4 -----------------------------------
  -- Where the score comes from. For a classic duel it is the number
  -- submit_duel_run recomputed from the stored questions; for a steal
  -- duel it is the number of points that side actually won, counted
  -- on the server from duel_points. Neither is ever the client's
  -- opinion, and everything downstream of here — the reveal gate, the
  -- outcome, the walkover — is identical for both.
  IF v_d.mode = 'steal' THEN
    v_c_score := public.duel_steal_score(v_d.id, 'creator');
    v_o_score := public.duel_steal_score(v_d.id, 'opponent');
  ELSE
    v_c_score := v_c.score;
    v_o_score := v_o.score;
  END IF;

  v_reveal := (v_c_result AND v_o_result) OR v_now > v_d.expires_at;

  v_role := public.duel_role(v_d.creator_id, v_d.opponent_id,
                             v_d.opponent_guest_token, p_uid, p_token);

  IF v_role = 'open' AND public.duel_side_played(v_d.id, 'opponent') THEN
    v_role := 'spectator';
  END IF;

  IF NOT v_reveal THEN
    v_outcome := NULL;
  ELSIF v_c_result AND v_o_result THEN
    v_outcome := jsonb_build_object(
      'type', 'decided',
      'winner', CASE
                  WHEN COALESCE(v_c_score, 0) > COALESCE(v_o_score, 0) THEN 'creator'
                  WHEN COALESCE(v_o_score, 0) > COALESCE(v_c_score, 0) THEN 'opponent'
                  ELSE 'tie'
                END);
  ELSIF v_c_result OR v_o_result THEN
    v_outcome := jsonb_build_object(
      'type',   'walkover',
      'winner', CASE WHEN v_c_result THEN 'creator' ELSE 'opponent' END);
  ELSE
    v_outcome := jsonb_build_object('type', 'unplayed', 'winner', NULL);
  END IF;

  RETURN jsonb_build_object(
    'duel_key',         v_d.duel_key,
    -- Which game this is. The room, the countdown and the whole
    -- real-time client only exist for one of the two, so the page has
    -- to be told before it renders anything.
    'mode',             v_d.mode,
    'duration_seconds', v_d.duration_seconds,
    'created_at',       to_char(v_d.created_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'expires_at',       to_char(v_d.expires_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'expired',          v_now > v_d.expires_at,
    'status',           CASE WHEN v_now > v_d.expires_at AND v_d.status = 'open'
                             THEN 'expired' ELSE v_d.status END,
    'seconds_until_expiry',
                        GREATEST(0, CEIL(EXTRACT(EPOCH FROM
                          (v_d.expires_at - v_now))))::INTEGER,
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
      'score',        CASE WHEN v_reveal AND v_c_result THEN v_c_score END,
      'points',       CASE WHEN v_reveal AND v_c_found
                           THEN public.duel_pace_points(v_d.questions, v_c.answers) END,
      'username',     v_c_name,
      'is_you',       v_role = 'creator'),
    'opponent',         jsonb_build_object(
      'played',       v_o_found,
      'status',       CASE WHEN v_o_found THEN v_o.status END,
      'submitted_at', CASE WHEN v_o_found AND v_o.submitted_at IS NOT NULL
                           THEN to_char(v_o.submitted_at AT TIME ZONE 'UTC',
                                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
      'score',        CASE WHEN v_reveal AND v_o_result THEN v_o_score END,
      'points',       CASE WHEN v_reveal AND v_o_found
                           THEN public.duel_pace_points(v_d.questions, v_o.answers) END,
      'username',     v_o_name,
      'is_you',       v_role = 'opponent')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.duel_public_payload(UUID, UUID, TEXT) FROM PUBLIC;

-- ── 8. submit_duel_run, told which game it is ───────────────────
-- Verbatim duels.sql §8 with one change, marked below: in a steal duel
-- the score a side ends on is the number of points it won, not the
-- number of questions it answered correctly.
--
-- Those are different numbers, and the difference is the entire game.
-- Both players see every question and both may answer it right; only
-- one of them got there first. A steal run that answered all forty
-- questions correctly and lost every race scored nothing, and taking
-- the classic count here would report forty — a score the client
-- supplied the raw material for, which is the one thing this project
-- does not do.
--
-- The answers array is still parsed, still filtered and still stored:
-- it is what duel_pace_points draws the curve from, and it is still
-- the client's claim rather than the server's finding. It just no
-- longer decides the score.
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
  v_right    BOOLEAN[];
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

  v_role := public.duel_role(v_d.creator_id, v_d.opponent_id,
                             v_d.opponent_guest_token, v_uid, v_token);

  IF v_role NOT IN ('creator', 'opponent') THEN
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

  IF v_r.status <> 'in_progress' THEN
    RAISE EXCEPTION 'duel_already_submitted'
      USING ERRCODE = '23505',
            HINT    = 'This side of the duel has already been played.';
  END IF;

  v_deadline := public.duel_run_deadline(v_r.started_at, v_d.duration_seconds,
                                         v_d.expires_at);

  IF v_now > v_deadline + make_interval(secs => 3) THEN
    RAISE EXCEPTION 'duel_window_closed'
      USING ERRCODE = '22023',
            HINT    = 'The window for this run has passed.';
  END IF;

  v_total_q := COALESCE(jsonb_array_length(v_d.questions), 0);
  v_max_ms  := GREATEST(COALESCE(v_d.duration_seconds, 0), 0)::NUMERIC * 1000;

  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'array' THEN
    v_raw := '[]'::JSONB;
  ELSE
    v_raw := p_answers;
  END IF;

  IF v_total_q > 0 THEN
    v_seen  := array_fill(FALSE, ARRAY[v_total_q]);
    v_right := array_fill(FALSE, ARRAY[v_total_q]);
  END IF;

  FOR v_elem IN SELECT value FROM jsonb_array_elements(v_raw) LOOP
    CONTINUE WHEN jsonb_typeof(v_elem) IS DISTINCT FROM 'object';
    CONTINUE WHEN jsonb_typeof(v_elem->'i') IS DISTINCT FROM 'number';
    CONTINUE WHEN jsonb_typeof(v_elem->'elapsed_ms') IS DISTINCT FROM 'number';

    v_i_num := (v_elem->>'i')::NUMERIC;
    v_ms    := (v_elem->>'elapsed_ms')::NUMERIC;

    CONTINUE WHEN NOT (v_i_num >= 0 AND v_i_num < v_total_q
                       AND v_i_num = floor(v_i_num));
    v_i := v_i_num::INTEGER;

    CONTINUE WHEN NOT (v_ms >= 0 AND v_ms <= v_max_ms);
    CONTINUE WHEN v_ms < v_prev_ms;

    IF NOT COALESCE(v_seen[v_i + 1], FALSE) THEN
      v_seen[v_i + 1] := TRUE;
      v_answered := v_answered + 1;
    END IF;

    v_prev_ms := v_ms;

    IF jsonb_typeof(v_elem->'value') = 'number'
       AND jsonb_typeof(v_d.questions->v_i->'answer') = 'number'
       AND (v_elem->>'value')::NUMERIC
           = (v_d.questions->v_i->>'answer')::NUMERIC THEN
      IF NOT COALESCE(v_right[v_i + 1], FALSE) THEN
        v_right[v_i + 1] := TRUE;
        v_score := v_score + 1;
      END IF;
    END IF;

    v_kept_arr := v_kept_arr || jsonb_build_object(
      'i',          v_i,
      'value',      CASE WHEN jsonb_typeof(v_elem->'value') = 'number'
                         THEN v_elem->'value' ELSE 'null'::JSONB END,
      'elapsed_ms', floor(v_ms)::BIGINT
    );
  END LOOP;

  SELECT COALESCE(jsonb_agg(e.val ORDER BY e.ord), '[]'::JSONB) INTO v_kept
  FROM unnest(v_kept_arr) WITH ORDINALITY AS e(val, ord);

  -- ---- the one change from duels.sql §8 -----------------------------------
  -- Whatever the answers array said, a steal run scores what it won.
  -- Counted here rather than trusted from anywhere, and stored on the
  -- run so that a direct reader, duel_refresh's expiry path and
  -- duel_public_payload all report the same number.
  IF v_d.mode = 'steal' THEN
    v_score := public.duel_steal_score(v_d.id, v_role);
  END IF;

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

  PERFORM public.duel_refresh(v_d.id);

  RETURN jsonb_build_object(
    'side',           v_role,
    'score',          v_score,
    'total_answered', v_answered,
    'accuracy',       CASE WHEN v_answered > 0
                           THEN round(v_score::NUMERIC / v_answered, 3) END,
    'duel',           public.duel_public_payload(v_d.id, v_uid, v_token)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_duel_run(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_duel_run(TEXT, TEXT, JSONB)
  TO anon, authenticated;

-- ── 9. What this file deliberately does not build ───────────────
-- The design doc's "Disconnects" section calls for a 10-second
-- presence grace after which the duel ends early on the score so far,
-- "marked ended_early". It names no function, no arguments and no
-- status vocabulary, and duels.duels_status_valid / duel_runs_status_valid
-- do not admit such a value — so there is nothing here to implement
-- against without inventing the contract, and inventing it is how the
-- client and the database end up disagreeing. Settle the shape in
-- docs/steal-mode-design.md first.
--
-- The room (ready / start / the shared countdown deadline) is
-- likewise transport and client state, not a database contract, apart
-- from the `mode` field the payload above now carries so the page
-- knows which one to render. The doc's offer to "convert the duel to
-- classic" when the opponent never arrives would be a real function —
-- an UPDATE of duels.mode guarded by "creator, still open, no points
-- awarded" — and is not specified beyond that sentence either.
