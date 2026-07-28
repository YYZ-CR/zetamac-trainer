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
async function createDuel(durationSeconds) {
  const n = Number(durationSeconds);
  return duelRpc('create_duel', {
    p_duration: Number.isFinite(n) ? Math.round(n) : 120,
  });
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
