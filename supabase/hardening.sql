-- ────────────────────────────────────────────────────────────────
--  RLS hardening — apply by hand in the Supabase SQL Editor.
--
--  NOT applied automatically and NOT required by the current client
--  code: js/db.js keeps working unchanged against the original
--  policies. Run this when you are ready, then re-test login, the
--  dashboard, and a shared results link.
--
--  Why: the anon key is public by design (it ships in js/config.js),
--  so RLS is the only access control this project has. The policies
--  in schema.sql are permissive enough that the key alone is enough
--  to read everyone's data.
-- ────────────────────────────────────────────────────────────────

-- ── 1. Sessions are no longer world-readable ────────────────────
-- Before: sessions_select USING (true) — anyone holding the anon key
-- could SELECT * FROM game_sessions and join it against the equally
-- public profiles table, yielding every user's full question history
-- (including individual response times) keyed to their username.
DROP POLICY IF EXISTS sessions_select ON public.game_sessions;

CREATE POLICY sessions_select_own ON public.game_sessions
  FOR SELECT USING (auth.uid() = user_id);

-- Sharing still works, but through a function that returns exactly one
-- row for an exact key rather than a blanket read of the table.
CREATE OR REPLACE FUNCTION public.get_session_by_key(p_key TEXT)
RETURNS TABLE (
  session_key      TEXT,
  config_key       TEXT,
  score            INTEGER,
  duration_seconds INTEGER,
  questions        JSONB,
  created_at       TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.session_key, s.config_key, s.score, s.duration_seconds,
         s.questions, s.created_at
  FROM public.game_sessions s
  WHERE s.session_key = p_key;
$$;

REVOKE ALL ON FUNCTION public.get_session_by_key(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_session_by_key(TEXT) TO anon, authenticated;

-- ── 2. Anonymous sessions can no longer be mass-claimed ─────────
-- Before: sessions_update USING (user_id IS NULL OR auth.uid() = user_id)
-- let any logged-in user run
--   UPDATE game_sessions SET user_id = <them> WHERE user_id IS NULL;
-- absorbing every unclaimed game in the database, and rewrite score
-- and questions while they were at it.
DROP POLICY IF EXISTS sessions_update ON public.game_sessions;

CREATE POLICY sessions_update_own ON public.game_sessions
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Claiming moves behind a function that takes one explicit key. It is
-- still guessable in principle, but it is no longer a single statement
-- over the whole table.
CREATE OR REPLACE FUNCTION public.claim_session(p_key TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE public.game_sessions
  SET user_id = auth.uid()
  WHERE session_key = p_key
    AND user_id IS NULL;

  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_session(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_session(TEXT) TO authenticated;

-- ── 3. Usernames stay public, ids do not ────────────────────────
-- profiles_select USING (true) exposed the auth.users UUID alongside
-- the username, which is what made joining sessions to people easy.
DROP POLICY IF EXISTS profiles_select ON public.profiles;

CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT USING (auth.uid() = id);

-- Registration needs an availability check without reading the table.
CREATE OR REPLACE FUNCTION public.username_available(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.profiles WHERE username = p_username);
$$;

REVOKE ALL ON FUNCTION public.username_available(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.username_available(TEXT) TO anon, authenticated;

-- ── 4. Bound what an anonymous writer can insert ────────────────
-- Both tables accept unauthenticated inserts of arbitrary-size JSONB
-- with no constraints at all, so scores and payload size are entirely
-- attacker-chosen. These are sanity bounds, not a rate limit.
ALTER TABLE public.game_sessions
  ADD CONSTRAINT sessions_score_sane
    CHECK (score >= 0 AND score <= 10000),
  ADD CONSTRAINT sessions_duration_sane
    CHECK (duration_seconds > 0 AND duration_seconds <= 3600),
  ADD CONSTRAINT sessions_questions_sane
    CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) <= 10000);

ALTER TABLE public.profiles
  ADD CONSTRAINT username_length
    CHECK (char_length(username) BETWEEN 1 AND 40);

-- ── 5. Drop the redundant index ─────────────────────────────────
-- session_key is already UNIQUE, which creates its own btree index.
DROP INDEX IF EXISTS idx_sessions_key;
