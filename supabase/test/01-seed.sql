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

-- ── accplayer: history[].acc asserted against hand-counted values ─
-- mk_questions above computes hadMistake from a formula, so a test built on
-- it would re-derive the implementation rather than check it. These three
-- payloads are written out so the expected accuracy can be counted by eye:
--
--   accs1  10 questions, 2 with hadMistake  → acc must be exactly 80
--   accs2   4 questions, 0 with hadMistake  → acc must be exactly 100
--   accs3   0 questions (empty array)       → acc must be NULL, not 0
--
-- accs3 is the one that matters most. "No data" and "got everything wrong"
-- are different claims, and a function that reports 0 for a session with no
-- questions puts a wrong number on somebody's public profile.
--
-- Every score below is >= 30 on purpose. The percentile population seeded
-- above scores 30..89, and 02-test.sql asserts that a score of 20 sits at the
-- 0th percentile — which holds only while no player's BEST 120s score is
-- under 30. A score of 10 here would quietly move that boundary and fail a
-- test in a different file about a different function.
--
-- accplayer and malformed are NEW users rather than renamed playerN ones.
-- player1..player30 are addressed by name across 03-daily-test.sql,
-- 04-duels-test.sql and 08-steal-test.sql — renaming one to give it a
-- hand-built payload takes an opponent out from under forty-odd assertions in
-- suites that have nothing to do with this one. They are created down here,
-- AFTER the profile insert that numbers players by row_number() and after the
-- percentile population block, so they disturb neither: they get exactly the
-- sessions written below and no generated ones, which is also why there is no
-- DELETE to undo.
INSERT INTO auth.users (id, email)
VALUES (gen_random_uuid(), 'accplayer@example.test'),
       (gen_random_uuid(), 'malformed@example.test');

INSERT INTO public.profiles (id, username, is_public, created_at)
SELECT u.id,
       CASE u.email WHEN 'accplayer@example.test' THEN 'accplayer'
                    ELSE 'malformed' END,
       TRUE,
       NOW() - INTERVAL '120 days'
FROM auth.users u
WHERE u.email IN ('accplayer@example.test', 'malformed@example.test');

INSERT INTO public.game_sessions
  (session_key, user_id, score, duration_seconds, questions, created_at)
VALUES
  ('accs1',
   (SELECT id FROM public.profiles WHERE username = 'accplayer'),
   31, 120,
   -- 10 entries, indexes 3 and 7 are the mistakes.
   (SELECT jsonb_agg(jsonb_build_object(
      'display', 'x', 'operation', 'addition', 'answer', 1, 'timeMs', 1500,
      'hadMistake', i IN (3, 7)))
    FROM generate_series(1, 10) i),
   NOW() - INTERVAL '3 days'),
  ('accs2',
   (SELECT id FROM public.profiles WHERE username = 'accplayer'),
   35, 120,
   (SELECT jsonb_agg(jsonb_build_object(
      'display', 'x', 'operation', 'addition', 'answer', 1, 'timeMs', 1500,
      'hadMistake', FALSE))
    FROM generate_series(1, 4) i),
   NOW() - INTERVAL '2 days'),
  ('accs3',
   (SELECT id FROM public.profiles WHERE username = 'accplayer'),
   40, 120, '[]'::jsonb,
   NOW() - INTERVAL '1 day');

-- ── malformed: a questions payload that is the wrong shape throughout ──
-- `questions` is client-supplied JSONB with no shape constraint beyond "is an
-- array" (hardening.sql §4), so every reader has to be total over garbage. An
-- entry that is not an object, and a hadMistake that is a string rather than
-- a boolean, must not abort get_public_profile or be counted as a mistake.
-- The profile itself is created in the block above, alongside accplayer's.
INSERT INTO public.game_sessions
  (session_key, user_id, score, duration_seconds, questions, created_at)
VALUES
  -- 2 objects survive the shape filter; neither has a literal `true`
  -- hadMistake, so acc must be exactly 100. The string "true" is NOT a
  -- mistake: the convention in this file is that only literal JSON true is.
  ('malf1',
   (SELECT id FROM public.profiles WHERE username = 'malformed'),
   45, 120,
   '[42, "nope", null, {"operation":"addition","hadMistake":"true"}, {"operation":"addition"}]'::jsonb,
   NOW() - INTERVAL '2 days'),
  -- Nothing in the array is an object, so there is no question to score:
  -- acc must be NULL rather than 100 over an empty count.
  ('malf2',
   (SELECT id FROM public.profiles WHERE username = 'malformed'),
   50, 120, '[1, 2, 3]'::jsonb,
   NOW() - INTERVAL '1 day');

-- ── An anonymous session with an impossible score ────────────────
-- user_id IS NULL, so it must not appear in any percentile population and must
-- not be attributable to a profile. If a percentile ever reflects this row,
-- the function is reading unattributed sessions.
INSERT INTO public.game_sessions
  (session_key, user_id, score, duration_seconds, questions, created_at)
VALUES ('anon1', NULL, 9999, 120, '[]'::jsonb, NOW());
