-- ════════════════════════════════════════════════════════════
-- Zetamac Trainer — Supabase Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor
-- ════════════════════════════════════════════════════════════

-- Game configurations (shareable via ?key=xxxx)
CREATE TABLE IF NOT EXISTS public.game_configs (
  key          TEXT PRIMARY KEY,
  config       JSONB NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Individual game sessions
CREATE TABLE IF NOT EXISTS public.game_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key      TEXT UNIQUE NOT NULL,
  user_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  config_key       TEXT REFERENCES public.game_configs(key) ON DELETE SET NULL,
  score            INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL,
  -- Array of { display, operation, answer, timeMs, hadMistake, mistakeValues }
  questions        JSONB NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- User profiles (username display)
CREATE TABLE IF NOT EXISTS public.profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username   TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON public.game_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_key
  ON public.game_sessions (session_key);

-- ════════════════════════════════════════════════════════════
-- Row Level Security
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.game_configs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;

-- game_configs: fully public (configs contain no sensitive data)
CREATE POLICY "configs_select" ON public.game_configs
  FOR SELECT USING (true);
CREATE POLICY "configs_insert" ON public.game_configs
  FOR INSERT WITH CHECK (true);

-- game_sessions: public read (so results links are shareable),
--   insert allowed for authenticated users and anonymous (user_id NULL),
--   update only to claim an unclaimed session or edit your own
CREATE POLICY "sessions_select" ON public.game_sessions
  FOR SELECT USING (true);
CREATE POLICY "sessions_insert" ON public.game_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
CREATE POLICY "sessions_update" ON public.game_sessions
  FOR UPDATE
  USING  (user_id IS NULL OR auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- profiles: public read, owner write
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (true);
CREATE POLICY "profiles_insert" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);
