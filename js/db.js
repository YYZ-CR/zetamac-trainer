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
