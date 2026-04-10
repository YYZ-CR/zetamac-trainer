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

async function getSession(sessionKey) {
  if (!dbReady()) return null;
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

// ── Session claiming ─────────────────────────────────────────
// After login, associate any locally-tracked anonymous sessions with the user

async function claimSessions(userId) {
  const pending = JSON.parse(localStorage.getItem('pending_sessions') || '[]');
  if (!pending.length) return;
  for (const { sessionKey } of pending) {
    await supabaseClient
      .from('game_sessions')
      .update({ user_id: userId })
      .eq('session_key', sessionKey)
      .is('user_id', null);
  }
  localStorage.removeItem('pending_sessions');
}
