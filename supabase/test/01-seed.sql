-- Realistic fixture data for exercising the social RPCs.
--
-- Deliberately includes the awkward cases: a player with no games, a private
-- profile, an anonymous (user_id IS NULL) session that must never be attributed
-- to anyone, a player who only ever played one duration, and a streak that has
-- been broken.

-- ── Players ──────────────────────────────────────────────────────
INSERT INTO auth.users (id, email)
SELECT gen_random_uuid(), 'p' || i || '@example.test'
FROM generate_series(1, 30) i;

-- Give every auth user a profile; most public, a couple private.
INSERT INTO public.profiles (id, username, is_public, created_at)
SELECT u.id,
       'player' || row_number() OVER (ORDER BY u.email),
       TRUE,
       NOW() - INTERVAL '120 days'
FROM auth.users u;

-- Named subjects we assert against by hand.
UPDATE public.profiles SET username = 'hexadecimal'
  WHERE username = 'player1';
UPDATE public.profiles SET username = 'privateperson', is_public = FALSE
  WHERE username = 'player2';
UPDATE public.profiles SET username = 'neverplayed'
  WHERE username = 'player3';
UPDATE public.profiles SET username = 'sixtyonly'
  WHERE username = 'player4';
UPDATE public.profiles SET username = 'brokenstreak'
  WHERE username = 'player5';

-- ── Helper: build a plausible questions payload ──────────────────
-- n questions cycling the four operations, with per-op timing bands that
-- differ (division slowest) and a sprinkle of mistakes, so the ops aggregate
-- has something real to distinguish.
CREATE OR REPLACE FUNCTION pg_temp.mk_questions(n INT, seed INT)
RETURNS JSONB LANGUAGE sql AS $$
  SELECT COALESCE(jsonb_agg(q), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'display',   'x',
      'operation', op,
      'answer',    1,
      'timeMs',    base + ((seed * i) % 600),
      'hadMistake', ((seed + i) % 11) = 0
    ) AS q
    FROM generate_series(1, n) i
    CROSS JOIN LATERAL (
      SELECT (ARRAY['addition','subtraction','multiplication','division'])[1 + (i % 4)] AS op,
             (ARRAY[1200, 1500, 1800, 2200])[1 + (i % 4)] AS base
    ) o
  ) s;
$$;

-- ── hexadecimal: 40 sessions, all four durations, 6-day live streak ──
INSERT INTO public.game_sessions
  (session_key, user_id, score, duration_seconds, questions, created_at)
SELECT
  'hex' || i,
  (SELECT id FROM public.profiles WHERE username = 'hexadecimal'),
  55 + (i % 30),
  (ARRAY[60, 120, 120, 120, 180, 300])[1 + (i % 6)],
  pg_temp.mk_questions(40 + (i % 20), i),
  -- Most recent six sessions land on the last six consecutive days.
  CASE WHEN i <= 6 THEN NOW() - (i - 1) * INTERVAL '1 day'
       ELSE NOW() - INTERVAL '20 days' - i * INTERVAL '1 day' END
FROM generate_series(1, 40) i;

-- ── Everyone else: enough 120s sessions to build a percentile population ──
INSERT INTO public.game_sessions
  (session_key, user_id, score, duration_seconds, questions, created_at)
SELECT
  'p' || p.username || '_' || i,
  p.id,
  30 + ((abs(hashtext(p.username)) + i * 7) % 60),
  120,
  pg_temp.mk_questions(20, i),
  NOW() - i * INTERVAL '2 days'
FROM public.profiles p
CROSS JOIN generate_series(1, 5) i
WHERE p.username NOT IN ('hexadecimal', 'neverplayed');

-- sixtyonly has played only 60s, so `bests` must contain exactly one key.
DELETE FROM public.game_sessions
WHERE user_id = (SELECT id FROM public.profiles WHERE username = 'sixtyonly');
INSERT INTO public.game_sessions
  (session_key, user_id, score, duration_seconds, questions, created_at)
VALUES ('sixty1',
        (SELECT id FROM public.profiles WHERE username = 'sixtyonly'),
        44, 60, pg_temp.mk_questions(30, 3), NOW() - INTERVAL '3 days');

-- brokenstreak last played 10 days ago → streak must be 0, not 5.
DELETE FROM public.game_sessions
WHERE user_id = (SELECT id FROM public.profiles WHERE username = 'brokenstreak');
INSERT INTO public.game_sessions
  (session_key, user_id, score, duration_seconds, questions, created_at)
SELECT 'broke' || i,
       (SELECT id FROM public.profiles WHERE username = 'brokenstreak'),
       50, 120, pg_temp.mk_questions(25, i),
       NOW() - INTERVAL '10 days' - i * INTERVAL '1 day'
FROM generate_series(1, 5) i;

-- ── An anonymous session with an impossible score ────────────────
-- user_id IS NULL, so it must not appear in any percentile population and must
-- not be attributable to a profile. If a percentile ever reflects this row,
-- the function is reading unattributed sessions.
INSERT INTO public.game_sessions
  (session_key, user_id, score, duration_seconds, questions, created_at)
VALUES ('anon1', NULL, 9999, 120, '[]'::jsonb, NOW());
