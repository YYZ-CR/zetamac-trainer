// Initialize Supabase client
let supabaseClient = null;
try {
  if (window.supabase && window.supabase.createClient) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    console.error('Supabase library not found on window.supabase');
  }
} catch (e) {
  console.error('Supabase createClient failed:', e);
}

// Guard: returns true if client is ready, logs otherwise
function dbReady() {
  if (!supabaseClient) { console.warn('Supabase client unavailable'); return false; }
  return true;
}

// ── Key helpers ───────────────────────────────────────────────

// Deterministic 8-char hex key from a string (same input = same key)
async function hashToKey(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Random 8-char hex key
function randomKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Game configs ─────────────────────────────────────────────

async function saveConfig(config) {
  const canonical = JSON.stringify(
    Object.keys(config).sort().reduce((acc, k) => { acc[k] = config[k]; return acc; }, {})
  );
  const key = await hashToKey(canonical);
  if (dbReady()) {
    await supabaseClient
      .from('game_configs')
      .upsert({ key, config }, { onConflict: 'key', ignoreDuplicates: true });
  }
  return key;
}

async function getConfig(key) {
  if (!dbReady()) return null;
  const { data, error } = await supabaseClient
    .from('game_configs')
    .select('config')
    .eq('key', key)
    .single();
  return error ? null : data?.config ?? null;
}

// ── Game sessions ────────────────────────────────────────────

async function saveSession(sessionData) {
  if (!dbReady()) return false;
  const { data: { user } } = await supabaseClient.auth.getUser();
  const { error } = await supabaseClient.from('game_sessions').insert({
    session_key: sessionData.sessionKey,
    user_id: user?.id ?? null,
    config_key: sessionData.configKey ?? null,
    score: sessionData.score,
    duration_seconds: sessionData.durationSeconds,
    questions: sessionData.questions,
  });
  if (error) console.error('saveSession:', error.message);
  return !error;
}

// Shared results links need to resolve a session the viewer does not own.
// Once supabase/hardening.sql is applied, game_sessions is owner-readable only
// and that has to go through a SECURITY DEFINER function that returns exactly
// one row for an exact key. Before it is applied the function does not exist,
// so fall back to the direct read — that way the client works either side of
// the migration and deployment order doesn't matter.
async function getSession(sessionKey) {
  if (!dbReady()) return null;

  try {
    const { data, error } = await supabaseClient
      .rpc('get_session_by_key', { p_key: sessionKey });
    if (!error && Array.isArray(data)) return data[0] ?? null;
    if (!error && data) return data;
  } catch (_) { /* fall through to the direct read */ }

  const { data, error } = await supabaseClient
    .from('game_sessions')
    .select('*')
    .eq('session_key', sessionKey)
    .single();
  return error ? null : data;
}

async function getUserSessions(userId, limit = 30) {
  if (!dbReady()) return [];
  const { data, error } = await supabaseClient
    .from('game_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return error ? [] : (data ?? []);
}

// Exact number of games a user has played. getUserSessions caps how many rows
// it pulls (each one carries a full questions payload), so its length is not
// the total — the dashboard used to report the capped figure as "Total Games"
// and silently stop counting past the limit.
async function countUserSessions(userId) {
  if (!dbReady()) return null;
  const { count, error } = await supabaseClient
    .from('game_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);
  return error ? null : count;
}

// ── Profiles ─────────────────────────────────────────────────

async function getProfile(userId) {
  if (!dbReady()) return null;
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  return error ? null : data;
}

async function createProfile(userId, username) {
  if (!dbReady()) return false;
  const { error } = await supabaseClient
    .from('profiles')
    .insert({ id: userId, username });
  return !error;
}

// Is a username free? Prefers the SECURITY DEFINER function added by
// hardening.sql, falling back to the direct read while profiles is still
// world-readable. Returns true when it genuinely cannot tell — the UNIQUE
// constraint on profiles.username is the actual guarantee; this only exists
// to give a nicer message before the account is created.
async function isUsernameAvailable(username) {
  if (!dbReady()) return true;
  try {
    const { data, error } = await supabaseClient.rpc('username_available', { p_username: username });
    if (!error && typeof data === 'boolean') return data;
  } catch (_) { /* fall through */ }

  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('username')
      .eq('username', username)
      .maybeSingle();
    if (error) return true;
    return !data;
  } catch (_) {
    return true;
  }
}

// ── Public profiles / percentiles ────────────────────────────
// hardening.sql reduced profiles and game_sessions to owner-only reads, so a
// public profile page cannot touch either table across a user boundary. Every
// cross-user read below goes through a SECURITY DEFINER function from
// supabase/social.sql that returns a fixed, minimal projection — see
// docs/social-api.md for the exact shapes.

// Why this exists: getPublicProfile() returns null both when the profile is
// absent/private (a normal answer) and when we simply could not ask — no
// Supabase client, network failure, or social.sql not applied to the project
// yet. The profile page has to word those two cases very differently, so the
// reason for a failed call is recorded here rather than thrown, keeping the
// helpers' return contract simple. Null means "the last call was fine".
let lastSocialError = null;

// The public profile payload for a username, or null when it does not exist,
// is private and not ours, or could not be fetched (see lastSocialError).
async function getPublicProfile(username) {
  lastSocialError = null;
  if (!dbReady()) { lastSocialError = 'Supabase client unavailable'; return null; }
  if (!username) return null;

  try {
    const { data, error } = await supabaseClient
      .rpc('get_public_profile', { p_username: username });
    if (error) {
      console.warn('getPublicProfile:', error.message);
      lastSocialError = error.message || 'get_public_profile failed';
      return null;
    }
    // A JSONB-returning function normally comes back as the object itself,
    // but PostgREST wraps some function results in a single-element array.
    // Accept either shape so the client is not sensitive to that detail.
    const row = Array.isArray(data) ? (data[0] ?? null) : data;
    return row ?? null;
  } catch (e) {
    console.warn('getPublicProfile threw:', e);
    lastSocialError = String(e?.message ?? e);
    return null;
  }
}

// Where a score ranks among players' bests at the same duration:
// { score, duration, percentile, players }. Null when it cannot be fetched.
// `percentile` itself may be null when too few players qualify — the caller
// decides what is worth showing, the function only reports.
async function getScorePercentile(score, durationSeconds) {
  if (!dbReady()) { lastSocialError = 'Supabase client unavailable'; return null; }
  if (typeof score !== 'number' || typeof durationSeconds !== 'number') return null;

  try {
    const { data, error } = await supabaseClient.rpc('get_score_percentile', {
      p_score: score,
      p_duration: durationSeconds,
    });
    if (error) {
      console.warn('getScorePercentile:', error.message);
      lastSocialError = error.message || 'get_score_percentile failed';
      return null;
    }
    const row = Array.isArray(data) ? (data[0] ?? null) : data;
    return row ?? null;
  } catch (e) {
    console.warn('getScorePercentile threw:', e);
    lastSocialError = String(e?.message ?? e);
    return null;
  }
}

// Publish or unpublish the signed-in user's profile. profiles.is_public
// defaults to FALSE, so this is how a profile ever becomes visible to anyone
// else. No RPC needed: the existing profiles_update policy already scopes
// updates to auth.uid() = id, so the row is picked by the session's own user
// id and the database enforces that it is theirs. Returns whether it stuck.
async function setProfileVisibility(isPublic) {
  if (!dbReady()) return false;
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return false;
    const { error } = await supabaseClient
      .from('profiles')
      .update({ is_public: !!isPublic })
      .eq('id', user.id);
    if (error) { console.warn('setProfileVisibility:', error.message); return false; }
    return true;
  } catch (e) {
    console.warn('setProfileVisibility threw:', e);
    return false;
  }
}

// ── Session claiming ─────────────────────────────────────────
// After login, associate any locally-tracked anonymous sessions with the user

async function claimSessions(userId) {
  // This was the one db function without the null-client guard.
  if (!dbReady()) return;

  // Hand-edited or truncated localStorage used to throw a SyntaxError straight
  // into the login handler, so the user saw a parse error even though login
  // had already succeeded.
  let pending = [];
  try {
    const raw = JSON.parse(localStorage.getItem('pending_sessions') || '[]');
    if (Array.isArray(raw)) pending = raw;
  } catch (_) {
    localStorage.removeItem('pending_sessions');
    return;
  }
  if (!pending.length) return;

  const unclaimed = [];
  for (const entry of pending) {
    const sessionKey = entry && entry.sessionKey;
    if (!sessionKey) continue;

    let claimed = false;
    try {
      // Preferred path once hardening.sql is applied: a SECURITY DEFINER
      // function that claims one explicit key. The plain UPDATE below cannot
      // work under the hardened policy, because the row's user_id is still
      // NULL and so fails the auth.uid() = user_id check.
      const { data, error } = await supabaseClient.rpc('claim_session', { p_key: sessionKey });
      if (!error) {
        claimed = data === true;
      } else {
        const res = await supabaseClient
          .from('game_sessions')
          .update({ user_id: userId })
          .eq('session_key', sessionKey)
          .is('user_id', null)
          .select('session_key');
        claimed = !res.error && (res.data?.length ?? 0) > 0;
      }
    } catch (e) {
      console.error('claimSessions failed for', sessionKey, e);
    }

    // Keep anything that didn't land so a later login can retry it. The old
    // code cleared the list unconditionally and silently orphaned failures.
    if (!claimed) unclaimed.push(entry);
  }

  if (unclaimed.length) {
    localStorage.setItem('pending_sessions', JSON.stringify(unclaimed));
  } else {
    localStorage.removeItem('pending_sessions');
  }
}

// ── Zetamac Daily ────────────────────────────────────────────
// One puzzle a day, the same questions for everyone, one ranked attempt.
// Every call here is a SECURITY DEFINER RPC from supabase/daily.sql; the exact
// payload shapes are pinned in docs/daily-design.md. Two properties of that
// design decide the shape of this section:
//
//   * The client is never told the day's questions until it has spent its
//     attempt, so there is no table to read directly and no fallback path the
//     way getSession()/isUsernameAvailable() have — without the migration the
//     daily simply does not exist.
//   * The client is never consulted about the score. submitDaily() sends
//     answers and returns whatever the server decided; nothing here computes
//     or adjusts a score.
//
// Why the failure reason is recorded rather than thrown: null is a legitimate
// answer from all four of these — not signed in, migration not applied,
// network down — and daily.html has to word "you haven't played yet" very
// differently from "the daily isn't deployed". Same reasoning as
// lastSocialError above, kept as a separate variable so a failed leaderboard
// read can never be mistaken for a failed profile read. Null means "the last
// daily call was fine".
let lastDailyError = null;

// A JSONB-returning function normally comes back as the object itself, but
// PostgREST wraps some function results in a single-element array. All four
// daily RPCs return JSONB, so the unwrapping lives in one place.
function unwrapRpc(data) {
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
}

// Shared body for the four daily RPCs: guard, call, unwrap, and record why it
// failed instead of throwing. Returns the payload, or null.
async function dailyRpc(fn, args) {
  lastDailyError = null;
  if (!dbReady()) { lastDailyError = 'Supabase client unavailable'; return null; }

  try {
    const { data, error } = await supabaseClient.rpc(fn, args || {});
    if (error) {
      console.warn(fn + ':', error.message);
      lastDailyError = error.message || (fn + ' failed');
      return null;
    }
    return unwrapRpc(data);
  } catch (e) {
    console.warn(fn + ' threw:', e);
    lastDailyError = String(e?.message ?? e);
    return null;
  }
}

// Begin (or resume) the caller's attempt at today's puzzle:
// { puzzle_number, puzzle_date, duration_seconds, started_at,
//   seconds_remaining, status, questions, result }.
//
// Idempotent by design — calling it again returns the SAME attempt with the
// real remaining time, which is what makes a refresh mid-run resume instead of
// restart. `questions` is present only while the attempt is live; once the
// window has closed the payload carries the result and no questions, so the
// day's puzzle cannot be read by burning an attempt early. Requires a signed-in
// caller: one attempt cannot be enforced against an anonymous player.
async function startDaily() {
  return dailyRpc('start_daily');
}

// Submit the caller's answers — `[{ i, value, elapsed_ms }]`, elapsed_ms
// measured from the start of the run and non-decreasing — and return the
// server's verdict: { score, total_answered, accuracy, puzzle_number, rank,
// players, flagged }. This is the only place a daily score is decided; the
// client's own count is a guess and must never be shown in its place.
async function submitDaily(answers) {
  if (!Array.isArray(answers)) {
    lastDailyError = 'submitDaily expects an array of answers';
    return null;
  }
  return dailyRpc('submit_daily', { p_answers: answers });
}

// What has happened to the caller today: { puzzle_number, puzzle_date,
// duration_seconds, played, status, seconds_until_reset, result }. Drives the
// landing page without exposing the questions.
async function getDailyStatus() {
  return dailyRpc('get_daily_status');
}

// Today's board: { puzzle_number, players, rows: [{ rank, username, score,
// accuracy }], you }. `you` is null when the caller has not completed an
// attempt, and is returned even when their rank falls outside the top `limit`.
// Complete attempts only. Usernames in `rows` are user-controlled — escape
// them before they reach innerHTML.
async function getDailyLeaderboard(date, limit = 100) {
  const n = Number(limit);
  return dailyRpc('get_daily_leaderboard', {
    p_date:  date ? String(date) : null,
    p_limit: Number.isFinite(n) && n > 0 ? Math.floor(n) : 100,
  });
}

// ── Duels ────────────────────────────────────────────────────
// Send someone a link, both players answer the same sequence, compare. Every
// call here is a SECURITY DEFINER RPC from supabase/duels.sql; the exact
// payload shapes are pinned in docs/duels-design.md. Three properties of that
// design decide the shape of this section:
//
//   * A guest must be able to accept. The creator needs an account, but the
//     opponent may be anonymous, so every duel RPC except create_duel takes a
//     guest token and is granted to `anon`.
//   * Refusals are RAISEd, not returned. `duel_already_has_opponent`,
//     `duel_window_closed` and the rest arrive as `error` on the Supabase
//     response — not as a thrown exception — and a client that only checks for
//     a thrown error shows a third arrival a blank page. duelRpc() reads the
//     code out of `error` and turns it into a sentence.
//   * The score is the server's. submitDuelRun() sends answers and returns
//     whatever the server decided; nothing here computes or adjusts a score.
//
// Same reason as lastSocialError / lastDailyError for recording the failure
// rather than throwing: null is a legitimate answer from getDuel() (no such
// duel) and duel.html has to word that very differently from "duels are not
// deployed". lastDuelCode is the machine-readable half — null means the last
// call succeeded and any null payload was a real answer.

const DUEL_GUEST_PREFIX = 'duel_guest_';

// The refusals supabase/duels.sql raises, each as the sentence a player should
// actually read. The key is the RAISE message, which is what PostgREST puts in
// error.message; the HINT is deliberately not shown, because it is written for
// whoever is reading the database and not for the person holding the link.
const DUEL_REFUSALS = {
  duel_requires_account:
    'You need an account to create a duel — somebody has to own it.',
  duel_key_unavailable:
    "Couldn't allocate a link for this duel. Try again in a moment.",
  duel_not_found:
    'There is no duel with that link.',
  duel_requires_identity:
    "This browser couldn't be identified, so it can't claim a side of this duel. Allow site storage, or log in.",
  duel_bad_guest_token:
    "This browser couldn't be identified, so it can't claim a side of this duel. Allow site storage, or log in.",
  duel_already_has_opponent:
    'This duel already has two players.',
  duel_expired:
    'This duel has expired — a duel is open for 48 hours.',
  duel_not_started:
    "You haven't started this duel, so there's nothing to submit.",
  duel_already_submitted:
    'That side of the duel has already been played.',
  duel_window_closed:
    'The window for this run has closed.',

  // Steal mode (docs/steal-mode-design.md). These are refusals of a CLAIM, not
  // of a duel, so they are worded as a thing that happened in the run rather
  // than as an error — a player who lost a race by 30ms has not done anything
  // wrong. None of these strings appears in a classic refusal, so adding them
  // to this table cannot change how a classic duel reads an error.
  not_a_participant:
    "You aren't a player in this duel.",
  wrong_mode:
    'This duel is not a steal duel.',
  stale_index:
    'That question had already been decided.',
  point_taken:
    'They got there first.',
};

// Set when the last duel call failed: a sentence for the user (lastDuelError)
// and the raised code, 'duel_unavailable' or 'duel_missing' (lastDuelCode).
let lastDuelError = null;
let lastDuelCode  = null;

// The guest's entire identity for this duel, minted on first use and kept in
// localStorage under duel_guest_<key>.
//
// Losing the token loses the run — there is nothing else tying an anonymous
// player to their side — so it is written BEFORE it is ever sent, not after a
// successful start. Two randomKey() draws rather than one: the server accepts
// 8 to 200 characters, and this string is a bearer credential for one side of
// a duel for 48 hours, so 64 bits is the right end of that range.
//
// Returns '' when storage is unavailable (private mode, blocked cookies). That
// is honest rather than convenient: a token that cannot be persisted cannot be
// used to resume, and the server refuses to hand a duel side to an identity
// that will not survive a refresh (duel_requires_identity).
function duelGuestToken(key) {
  if (!key) return '';
  const storageKey = DUEL_GUEST_PREFIX + key;
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing && existing.trim().length >= 8) return existing.trim();
    const token = randomKey() + randomKey();
    localStorage.setItem(storageKey, token);
    // Read back: a quota-exceeded write can fail silently in some browsers,
    // and a token we believe in but never stored is worse than none.
    return localStorage.getItem(storageKey) === token ? token : '';
  } catch (_) {
    return '';
  }
}

// Which refusal an error object represents, or 'duel_missing' when the
// function itself is not there (migration not applied), or 'duel_unavailable'
// for anything else. The raised name is in error.message, but PostgREST has
// moved detail between fields across versions, so all four are searched.
function duelErrorCode(error) {
  if (!error) return null;
  const blob = [error.message, error.details, error.hint, error.code]
    .filter(v => typeof v === 'string')
    .join(' ');

  for (const code of Object.keys(DUEL_REFUSALS)) {
    if (blob.indexOf(code) !== -1) return code;
  }
  // PostgREST reports an absent function as PGRST202 / "Could not find the
  // function ... in the schema cache"; older stacks say "does not exist".
  if (/PGRST202|schema cache|does not exist|could not find the function/i.test(blob)) {
    return 'duel_missing';
  }
  return 'duel_unavailable';
}

// Shared body for the four duel RPCs: guard, call, unwrap, and record why it
// failed instead of throwing. Returns the payload, or null.
async function duelRpc(fn, args) {
  lastDuelError = null;
  lastDuelCode  = null;

  if (!dbReady()) {
    lastDuelCode  = 'duel_unavailable';
    lastDuelError = 'Duels are unavailable right now.';
    return null;
  }

  try {
    const { data, error } = await supabaseClient.rpc(fn, args || {});
    if (error) {
      const code = duelErrorCode(error);
      lastDuelCode  = code;
      lastDuelError = DUEL_REFUSALS[code] || 'Duels are unavailable right now.';
      console.warn(fn + ':', error.message, '→', code);
      return null;
    }
    return unwrapRpc(data);
  } catch (e) {
    console.warn(fn + ' threw:', e);
    lastDuelCode  = 'duel_unavailable';
    lastDuelError = 'Duels are unavailable right now.';
    return null;
  }
}

// Create a duel and return { duel_key, expires_at, duration_seconds }, or null
// (see lastDuelError). Signed-in callers only — an unowned duel has nobody to
// notify and nobody to rematch. The duration is clamped server-side to
// 15..600, so the returned duration_seconds is the one that was actually used
// and is what the page must show.
// `mode` is 'classic' (the default) or 'steal'. p_mode is sent ONLY for a
// steal duel: create_duel gained the argument with a default, so a classic
// create must stay the exact one-argument call it was before — a database that
// has not had the steal migration applied yet still answers it, and the client
// is written to work on both sides of a migration.
async function createDuel(durationSeconds, mode) {
  const n = Number(durationSeconds);
  const args = { p_duration: Number.isFinite(n) ? Math.round(n) : 120 };
  if (String(mode || '') === 'steal') args.p_mode = 'steal';
  return duelRpc('create_duel', args);
}

// The duel's public face for whoever is holding the link: duel_key,
// duration_seconds, created_at, expires_at, expired, status,
// seconds_until_expiry, your_side ('creator' | 'opponent' | 'open' |
// 'spectator'), opponent_claimed, scores_revealed, outcome and a { played,
// status, submitted_at, score, is_you } block for each side.
//
// Never returns the questions, and returns a side's score ONLY when
// scores_revealed is true — knowing the target turns a run into a chase. The
// client must gate on that flag rather than on `score != null`.
//
// Null means either "no duel with that key" (lastDuelCode null — an ordinary
// answer) or "the call failed" (lastDuelCode set). Those are different pages.
async function getDuel(key) {
  if (!key) { lastDuelError = null; lastDuelCode = null; return null; }
  return duelRpc('get_duel_by_key', {
    p_key: String(key),
    p_guest_token: duelGuestToken(key) || null,
  });
}

// Claim a side and begin — or resume — this browser's run:
// { duel_key, side, duration_seconds, started_at, seconds_remaining, status,
//   questions, duel }.
//
// Idempotent by design: started_at is written exactly once, so calling this
// again returns the SAME run with the real remaining time, which is what makes
// a refresh mid-run resume instead of restart. `questions` is present only
// while the run is genuinely live; once the window has closed it is null, so
// the sequence cannot be read by starting early and walking away.
//
// Raises (→ null, with lastDuelCode set) for a third arrival
// ('duel_already_has_opponent'), an expired duel ('duel_expired') and a
// browser that cannot hold a token ('duel_requires_identity').
async function startDuelRun(key) {
  if (!key) { lastDuelCode = 'duel_not_found'; lastDuelError = DUEL_REFUSALS.duel_not_found; return null; }
  return duelRpc('start_duel_run', {
    p_key: String(key),
    p_guest_token: duelGuestToken(key) || null,
  });
}

// Submit this side's answers — `[{ i, value, elapsed_ms }]`, elapsed_ms
// measured from the start of the run and non-decreasing — and return the
// server's verdict: { side, score, total_answered, accuracy, duel }. This is
// the only place a duel score is decided; the client's own count is a guess
// and must never be shown in its place.
async function submitDuelRun(key, answers) {
  if (!key) { lastDuelCode = 'duel_not_found'; lastDuelError = DUEL_REFUSALS.duel_not_found; return null; }
  if (!Array.isArray(answers)) {
    lastDuelCode  = 'duel_unavailable';
    lastDuelError = 'submitDuelRun expects an array of answers';
    return null;
  }
  return duelRpc('submit_duel_run', {
    p_key: String(key),
    p_guest_token: duelGuestToken(key) || null,
    p_answers: answers,
  });
}

// ── Steal-mode duels ─────────────────────────────────────────
// The real-time variant: first correct answer takes the point and both players
// jump to the next question. docs/steal-mode-design.md is the contract. Three
// properties of it decide the shape of this section:
//
//   * The point is the SERVER's. claim_duel_point arbitrates on the client's
//     time-since-the-question-was-rendered, clamped against what the server
//     itself observed, and returns who actually won. Nothing here computes a
//     winner, and nothing here reads one out of a broadcast — the channel
//     below carries hints, and a hint that could award a point would make a
//     forged message a score.
//   * A guest must still be able to play, so these take the same guest token
//     as every other duel RPC and are granted to `anon`.
//   * Realtime may simply not be there: an older supabase-js with no
//     .channel(), a blocked WebSocket, a stubbed client. duelChannel() returns
//     null rather than throwing, and duel.js degrades to offering a classic
//     duel — which needs nobody to be awake — instead of a dead page.

// Claim the point for question `index`, having answered it `elapsedMs` after
// it appeared on screen. Returns { ok, index, winner, elapsed_ms, provisional }
// — `provisional` true while the server's 400ms grace window is still open, so
// the UI can say the point may yet move — or null with lastDuelCode set for a
// refusal ('point_taken', 'stale_index', 'wrong_mode', 'not_a_participant').
//
// The elapsed time is the client's, and a client can lie about it; the server
// clamps it to the time it has itself observed since the question was
// released, so the worst a cheat can claim is the physics the server saw.
// Sending a wrong answer is pointless — the server checks it and awards
// nothing — so duel.js only ever calls this for an answer it knows is right.
async function claimDuelPoint(key, index, elapsedMs) {
  if (!key) { lastDuelCode = 'duel_not_found'; lastDuelError = DUEL_REFUSALS.duel_not_found; return null; }
  const i  = Number(index);
  const ms = Number(elapsedMs);
  return duelRpc('claim_duel_point', {
    p_key: String(key),
    p_guest_token: duelGuestToken(key) || null,
    p_index:      Number.isFinite(i)  ? Math.max(0, Math.round(i))  : 0,
    p_elapsed_ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0,
  });
}

// End a steal duel on the score so far, because a player's presence went away
// for longer than the grace window (or they left cleanly). The duel is marked
// ended early — NOT as a win for whoever stayed, which would make pulling your
// ethernet cable a winning move.
//
// NOTE: docs/steal-mode-design.md specifies the behaviour but does not name
// this function or pin its payload, unlike claim_duel_point. The name and
// arguments here are this client's proposal and must be reconciled with
// supabase/duels.sql before either side ships. duel.js therefore treats a
// missing function as survivable: it still renders the ended-early state and
// re-reads the duel for the authoritative scores.
async function endDuelEarly(key, reason) {
  if (!key) { lastDuelCode = 'duel_not_found'; lastDuelError = DUEL_REFUSALS.duel_not_found; return null; }
  return duelRpc('end_duel_early', {
    p_key: String(key),
    p_guest_token: duelGuestToken(key) || null,
    p_reason: String(reason || 'ended_early'),
  });
}

// Turn a steal duel that nobody turned up for into a classic one. The
// questions are already generated and a classic duel needs nobody to be awake,
// so this is the failure mode degrading to the thing that already works rather
// than to a dead end.
//
// Same caveat as endDuelEarly: the design doc requires the offer but does not
// name the function. Creator only — it is their duel.
async function convertDuelToClassic(key) {
  if (!key) { lastDuelCode = 'duel_not_found'; lastDuelError = DUEL_REFUSALS.duel_not_found; return null; }
  return duelRpc('convert_duel_to_classic', {
    p_key: String(key),
    p_guest_token: duelGuestToken(key) || null,
  });
}

// The Realtime channel a steal duel talks on: broadcast for the five messages
// in the design doc, presence for liveness. `presenceKey` identifies this tab
// so a reconnecting player replaces their own entry rather than appearing
// twice.
//
// Returns null — never throws — when Realtime is unavailable. The caller has a
// real fallback (a classic duel), and it can only offer it if it is told.
function duelChannel(key, presenceKey) {
  if (!key || !dbReady()) return null;
  if (typeof supabaseClient.channel !== 'function') {
    console.warn('duelChannel: this Supabase client has no Realtime');
    return null;
  }
  try {
    return supabaseClient.channel('duel:' + String(key), {
      config: {
        presence: { key: String(presenceKey || '') },
        // Own messages come back from the local optimistic path, not from the
        // server; echoing them would double-apply every advance.
        broadcast: { self: false },
      },
    });
  } catch (e) {
    console.warn('duelChannel failed:', e);
    return null;
  }
}

// ── Private leagues ──────────────────────────────────────────
// A named group, an invite code, and its own leaderboard over the daily.
// Every call here is a SECURITY DEFINER RPC from supabase/leagues.sql; the
// exact payload shapes are pinned in docs/leagues-design.md. Three properties
// of that design decide the shape of this section:
//
//   * Accounts only. Every league RPC is granted to `authenticated` and to
//     nothing else, and each one re-checks auth.uid() — so a signed-out caller
//     gets `league_requires_account` rather than an empty list. There is no
//     anonymous path to fall back to, unlike duels.
//   * Refusals are RAISEd, not returned. `league_forbidden`, `league_full`,
//     `league_limit_reached` and the rest arrive as `error` on the Supabase
//     response — NOT as a thrown JS exception — so a client that only wrapped
//     these in try/catch would render a blank page to a non-member. leagueRpc()
//     reads the code out of `error` and turns it into a sentence.
//   * get_my_leagues returns a BARE JSON ARRAY, not an object wrapper. It is
//     the one function here that must not go through unwrapRpc(), which would
//     silently hand back only the first league.
//
// Same reason as lastSocialError / lastDailyError / lastDuelError for recording
// the failure rather than throwing: null is a legitimate answer from getLeague()
// (no such code) and leagues.html has to word that very differently from
// "leagues are not deployed". lastLeagueCode is the machine-readable half —
// null means the last call succeeded and any null payload was a real answer.

// The refusals supabase/leagues.sql raises, each as the sentence somebody
// should actually read. The key is the RAISE message, which is what PostgREST
// puts in error.message; the HINT is deliberately not shown, because it is
// written for whoever is reading the database and not for the person holding
// the invite code.
const LEAGUE_REFUSALS = {
  league_requires_account:
    'Leagues need an account — sign in and try again.',
  league_bad_name:
    'A league name has to be between 1 and 60 characters.',
  league_key_unavailable:
    "Couldn't allocate a code for this league. Try again in a moment.",
  league_not_found:
    'There is no league with that code.',
  league_forbidden:
    'Only members can see this league. Join it with its code to see the board.',
  league_not_member:
    "You're not in this league, so there's nothing to leave.",
  league_full:
    'This league is full — it already has the maximum of 100 members.',
  league_limit_reached:
    "You're already in the maximum of 20 leagues. Leave one to make room.",
  league_bad_scope:
    'That leaderboard view does not exist.',
};

// Set when the last league call failed: a sentence for the user
// (lastLeagueError) and the raised code, 'league_missing' or
// 'league_unavailable' (lastLeagueCode).
let lastLeagueError = null;
let lastLeagueCode  = null;

// What a typed or pasted invite code means, client-side. The same rule
// supabase/leagues.sql's league_normalize_key applies — uppercase, drop
// everything that is not a letter or a digit — so that "  wpq7-k3nd rx " and
// "WPQ7K3NDRX" are the same league here as they are there.
//
// The server normalises anyway; this exists so the input does not LOOK broken
// while somebody is pasting into it, and so the client can build a canonical
// invite URL rather than echoing back whatever punctuation came with the code.
//
// Deliberately no length rule, unlike the SQL: truncating or emptying the
// field under the user's cursor is worse than sending a code the server will
// reject. The callers below apply the 32-character bound instead.
function normalizeLeagueKey(key) {
  return String(key ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

// Which refusal an error object represents, or 'league_missing' when the
// function itself is not there (migration not applied), or 'league_unavailable'
// for anything else. The raised name is in error.message, but PostgREST has
// moved detail between fields across versions, so all four are searched.
function leagueErrorCode(error) {
  if (!error) return null;
  const blob = [error.message, error.details, error.hint, error.code]
    .filter(v => typeof v === 'string')
    .join(' ');

  for (const code of Object.keys(LEAGUE_REFUSALS)) {
    if (blob.indexOf(code) !== -1) return code;
  }
  // PostgREST reports an absent function as PGRST202 / "Could not find the
  // function ... in the schema cache"; older stacks say "does not exist".
  if (/PGRST202|schema cache|does not exist|could not find the function/i.test(blob)) {
    return 'league_missing';
  }
  return 'league_unavailable';
}

// Shared body for the six league RPCs: guard, call, unwrap, and record why it
// failed instead of throwing. Returns the payload, or null.
//
// `unwrap` is false for exactly one caller — get_my_leagues, whose payload is
// a bare array that unwrapRpc() would reduce to its first element.
async function leagueRpc(fn, args, unwrap = true) {
  lastLeagueError = null;
  lastLeagueCode  = null;

  if (!dbReady()) {
    lastLeagueCode  = 'league_unavailable';
    lastLeagueError = 'Leagues are unavailable right now.';
    return null;
  }

  try {
    const { data, error } = await supabaseClient.rpc(fn, args || {});
    if (error) {
      const code = leagueErrorCode(error);
      lastLeagueCode  = code;
      lastLeagueError = LEAGUE_REFUSALS[code] || 'Leagues are unavailable right now.';
      console.warn(fn + ':', error.message, '→', code);
      return null;
    }
    return unwrap ? unwrapRpc(data) : (data ?? null);
  } catch (e) {
    console.warn(fn + ' threw:', e);
    lastLeagueCode  = 'league_unavailable';
    lastLeagueError = 'Leagues are unavailable right now.';
    return null;
  }
}

// A code that cannot possibly name a league, refused without a round trip.
// league_normalize_key returns SQL NULL for an empty or over-long key and every
// RPC turns that into league_not_found, so this is the same answer, sooner.
function leagueRejectKey(key) {
  lastLeagueCode  = 'league_not_found';
  lastLeagueError = LEAGUE_REFUSALS.league_not_found;
  return null;
}

// Create a league and return { league_key, name }, or null (see
// lastLeagueError). Signed-in callers only. The name is trimmed and bounded
// server-side (1..60 characters); a name that fails that comes back as
// 'league_bad_name'.
async function createLeague(name) {
  return leagueRpc('create_league', { p_name: String(name ?? '') });
}

// Join a league by its invite code and return the league payload
// { league_key, name, owner_username, member_count, is_member, is_owner,
//   max_members, created_at }, or null.
//
// Idempotent by contract: joining a league you are already in is success, not
// an error, and does not move your joined_at. Raises (→ null, with
// lastLeagueCode set) for 'league_full', 'league_limit_reached' and
// 'league_not_found'.
async function joinLeague(key) {
  const k = normalizeLeagueKey(key);
  if (!k || k.length > 32) return leagueRejectKey(k);
  return leagueRpc('join_league', { p_key: k });
}

// Leave a league and return what actually happened:
// { league_key, name, left, league_deleted, ownership_transferred,
//   new_owner_username, member_count }.
//
// The three outcomes are not interchangeable and the caller must report the
// one that occurred: the last member leaving DELETES the league, an owner
// leaving TRANSFERS it to the longest-standing remaining member, and anyone
// else just leaves. Raises 'league_not_member' for a league the caller was
// never in — leave is not idempotent, deliberately.
async function leaveLeague(key) {
  const k = normalizeLeagueKey(key);
  if (!k || k.length > 32) return leagueRejectKey(k);
  return leagueRpc('leave_league', { p_key: k });
}

// Every league the caller is in, as an ARRAY of
// { league_key, name, owner_username, member_count, is_owner, max_members,
//   joined_at, created_at }, most recently joined first.
//
// [] means "in no leagues" and is a normal answer; null means the call failed
// and lastLeagueCode says why. get_my_leagues returns a bare JSON array, so
// this is the one wrapper that must not unwrap — see leagueRpc.
async function getMyLeagues() {
  const data = await leagueRpc('get_my_leagues', {}, false);
  if (Array.isArray(data)) return data;
  if (lastLeagueCode) return null;
  return [];
}

// The public face of one league for whoever is holding its code:
// { league_key, name, owner_username, member_count, is_member, is_owner,
//   max_members, created_at }. Deliberately carries NO roster — an invite code
//  is a way to join, not a directory of who has already joined — so a join
// screen built from this cannot leak the membership.
//
// Null means either "no league with that code" (lastLeagueCode null — an
// ordinary answer) or "the call failed" (lastLeagueCode set). Those are
// different pages.
async function getLeague(key) {
  const k = normalizeLeagueKey(key);
  if (!k || k.length > 32) { lastLeagueError = null; lastLeagueCode = null; return null; }
  return leagueRpc('get_league', { p_key: k });
}

// The league's leaderboard over the daily, for MEMBERS ONLY:
// { league_key, name, scope, member_count, puzzle_date, window_days,
//   rows: [{ rank, username, is_public, score, played, games, is_you,
//   is_owner }] }.
//
// Scope is 'today' | 'week' | 'best'; anything else is refused rather than
// silently defaulted. A non-member gets 'league_forbidden' (SQLSTATE 42501),
// which arrives as `error` and becomes null here with lastLeagueCode set — an
// empty board would be indistinguishable from a league nobody has played in.
//
// Two fields decide how a row may be rendered, and neither may be inferred:
// `played` false means the member has no complete attempt in this scope and
// must be shown as such rather than as a zero, and `is_public` false means
// their profile is unpublished and their username must NOT be linked.
// Usernames and the league name are user-controlled — escape them before they
// reach innerHTML.
async function getLeagueBoard(key, scope) {
  const k = normalizeLeagueKey(key);
  if (!k || k.length > 32) return leagueRejectKey(k);
  const s = String(scope ?? 'today').toLowerCase().trim();
  return leagueRpc('get_league_board', {
    p_key:   k,
    p_scope: (s === 'week' || s === 'best') ? s : 'today',
  });
}

// ── Usernames ────────────────────────────────────────────────
// supabase/settings.sql revoked UPDATE (username) from `authenticated` at the
// column level, so the plain `.from('profiles').update({username})` that used
// to work — from this file or from anybody's browser console — is now denied
// by the database. set_username is the only way in, and it is where the rules
// live: 3–20 characters, [A-Za-z0-9_-] only, no case collisions, and 30 days
// between changes with the first one free.
//
// Unlike every other RPC in this file, set_username RETURNS its refusals
// rather than raising them, because each one is something the person typing
// can fix and because the payload has to carry next_change_allowed_at
// alongside the reason. So there is no error-code sniffing here — only the
// transport failures below have to be invented.

// One sentence per refusal code the database can return, plus the two this
// client invents when the call never got an answer. The cooldown line is
// deliberately vague: js/settings.js replaces it with the actual date, which
// it has and this file does not.
const USERNAME_REFUSALS = {
  username_requires_account:
    'You need to be logged in to set a username.',
  username_empty:
    'Type a username first.',
  username_too_short:
    'Usernames are at least 3 characters.',
  username_too_long:
    'Usernames are at most 20 characters.',
  username_invalid_chars:
    'Usernames can only use letters, numbers, hyphens and underscores — no spaces, ' +
    'accents or other alphabets.',
  username_taken:
    'That name is already taken. Names are compared without case, so "Alex" and ' +
    '"alex" count as the same name.',
  username_cooldown:
    'You changed your username too recently.',
  username_missing:
    'Username changes are not available on this deployment yet.',
  username_unavailable:
    "Couldn't reach the server. Try again in a moment.",
};

// How long the database makes a user wait between changes. It is
// username_cooldown_days() in supabase/settings.sql that decides; this copy
// exists only so the page can say "changeable again on …" from the
// username_changed_at it already read, without a second round trip. The server
// is authoritative — every refusal below comes from it, never from this number.
const USERNAME_COOLDOWN_DAYS = 30;

// Set or change the signed-in user's username. Works for an account that has
// no profiles row yet (it inserts one) and for one that does (it updates).
//
// ALWAYS returns { ok, username, next_change_allowed_at, error } and never
// throws:
//
//   ok                     — whether the name is now what was asked for.
//   username               — the name in effect AFTER the call. On a refusal
//                            that is the name they still have, or null if they
//                            have none, so a page can re-render from this
//                            payload alone.
//   next_change_allowed_at — ISO timestamp of when the next change becomes
//                            possible, or null when one is possible now.
//   error                  — null on success, otherwise a key of
//                            USERNAME_REFUSALS.
//
// Setting the name you already have is a success and does not start a new
// cooldown, so a double-tapped Save costs nothing.
async function setUsername(username) {
  const fail = (code) => ({
    ok: false,
    username: null,
    next_change_allowed_at: null,
    error: code,
  });

  if (!dbReady()) return fail('username_unavailable');

  try {
    const { data, error } = await supabaseClient.rpc('set_username', {
      p_username: String(username ?? ''),
    });

    if (error) {
      // Every refusal arrives in `data`, so an `error` here means the call
      // itself did not happen: the migration is not applied, or the network
      // is gone. PostgREST reports an absent function as PGRST202.
      const blob = [error.message, error.details, error.hint, error.code]
        .filter(v => typeof v === 'string')
        .join(' ');
      console.warn('set_username:', error.message);
      return fail(/PGRST202|schema cache|does not exist|could not find the function/i.test(blob)
        ? 'username_missing'
        : 'username_unavailable');
    }

    const row = unwrapRpc(data);
    if (!row || typeof row !== 'object') return fail('username_unavailable');

    return {
      ok: row.ok === true,
      username: row.username ?? null,
      next_change_allowed_at: row.next_change_allowed_at ?? null,
      error: row.ok === true ? null : (row.error || 'username_unavailable'),
    };
  } catch (e) {
    console.warn('set_username threw:', e);
    return fail('username_unavailable');
  }
}

// ── Deleting an account ──────────────────────────────────────
// supabase/account.sql's delete_account is the only way an account leaves this
// site. It takes no id — the account deleted is always auth.uid() — and it
// settles every row that mentions the caller by hand rather than letting the
// foreign keys cascade, because two of those cascades are actively destructive
// (a league owner would take the whole league with them, and orphaned
// game_sessions would keep feeding everybody else's percentile).
// docs/account-deletion.md states the fate of every row and is the contract
// both sides are built against.
//
// Like set_username, and unlike the duel and league RPCs, it RETURNS its one
// refusal rather than raising it: a confirmation that does not match is
// something the person typing can fix, not a programming error. So the only
// codes invented here are the transport failures.

// One sentence per outcome that is not success. Every one of them has to leave
// the reader certain about whether the account still exists — an ambiguous
// message after a failed delete is the worst copy on the site, because the
// obvious response to it is to try again.
const ACCOUNT_REFUSALS = {
  confirm_mismatch:
    "That didn't match, so nothing was deleted. Type it exactly as shown above.",
  account_requires_account:
    'You are not signed in, so nothing was deleted. Log in and try again.',
  account_missing:
    'Account deletion is not available on this deployment yet. Your account has ' +
    'NOT been deleted.',
  account_unavailable:
    "Couldn't reach the server, so your account has NOT been deleted. Nothing was " +
    'changed — try again in a moment.',
};

// Delete the signed-in user's account. `confirmText` must be their username,
// or the literal DELETE for an account that has none; the database compares it
// case-insensitively after trimming and refuses anything else.
//
// ALWAYS returns an object and never throws:
//
//   { ok: true, leagues_left, leagues_deleted, leagues_transferred,
//     duels_deleted, duel_slots_released, daily_attempts_deleted,
//     sessions_deleted }
//   { ok: false, error }   — a key of ACCOUNT_REFUSALS.
//
// The caller must sign out immediately on ok:true. The account row is gone but
// the access token this browser is holding stays valid until it expires, so a
// page that only redirects leaves a live session behind.
async function deleteAccount(confirmText) {
  const fail = (code) => ({ ok: false, error: code });

  if (!dbReady()) return fail('account_unavailable');

  try {
    const { data, error } = await supabaseClient.rpc('delete_account', {
      p_confirm: String(confirmText ?? ''),
    });

    if (error) {
      // The refusal arrives in `data`, so an `error` here means the call never
      // happened: the migration is not applied, or the network is gone.
      // PostgREST reports an absent function as PGRST202.
      const blob = [error.message, error.details, error.hint, error.code]
        .filter(v => typeof v === 'string')
        .join(' ');
      console.warn('delete_account:', error.message);
      return fail(/PGRST202|schema cache|does not exist|could not find the function/i.test(blob)
        ? 'account_missing'
        : 'account_unavailable');
    }

    const row = unwrapRpc(data);
    if (!row || typeof row !== 'object') return fail('account_unavailable');

    if (row.ok === true) return Object.assign({}, row, { ok: true, error: null });

    // An unrecognised code is still a refusal, and the account still exists —
    // account_unavailable is the sentence that says so.
    const code = row.error && ACCOUNT_REFUSALS[row.error] ? row.error : 'account_unavailable';
    return fail(code);
  } catch (e) {
    console.warn('delete_account threw:', e);
    return fail('account_unavailable');
  }
}
