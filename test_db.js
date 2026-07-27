// test_db.js — Node.js tests for js/db.js against a mocked Supabase client.
// Run: node test_db.js
//
// These cover the paths that change when supabase/hardening.sql is applied.
// The client has to work on BOTH sides of that migration — RPCs first, direct
// table access as a fallback — so that applying the SQL and redeploying the
// site can happen in either order without a window of breakage.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Mock Supabase ────────────────────────────────────────────
// `mode` picks which side of the migration we are simulating.
function makeClient(mode, log) {
  const HARDENED = mode === 'hardened';

  // A thenable query builder: every filter returns `this`, and awaiting it
  // resolves to whatever the terminal handler produced.
  function builder(table, op) {
    const state = { table, op, filters: {}, selected: false };
    const api = {
      select(_cols, opts) {
        state.selected = true;
        if (opts && opts.count) state.count = true;
        return api;
      },
      eq(col, val)  { state.filters[col] = val; return api; },
      is(col, val)  { state.filters[col] = val; return api; },
      order()       { return api; },
      limit()       { return api; },
      single()      { state.single = true; return api; },
      maybeSingle() { state.single = true; return api; },
      then(resolve) { resolve(settle(state)); return Promise.resolve(settle(state)); },
    };
    return api;
  }

  function settle(s) {
    log.push(`${s.op} ${s.table} ${JSON.stringify(s.filters)}`);
    if (s.table === 'game_sessions' && s.op === 'select') {
      // Hardened: owner-scoped SELECT hides rows you do not own.
      if (HARDENED) return { data: s.single ? null : [], error: s.single ? { code: 'PGRST116' } : null };
      return { data: s.single ? { session_key: s.filters.session_key, score: 7 } : [], error: null };
    }
    if (s.table === 'game_sessions' && s.op === 'update') {
      // Hardened: USING (auth.uid() = user_id) never matches a NULL row.
      if (HARDENED) return { data: [], error: null };
      return { data: [{ session_key: s.filters.session_key }], error: null };
    }
    if (s.table === 'profiles' && s.op === 'select') {
      if (HARDENED) return { data: null, error: null };   // owner-scoped: looks free
      return { data: s.filters.username === 'taken' ? { username: 'taken' } : null, error: null };
    }
    return { data: null, error: null };
  }

  return {
    from(table) {
      return {
        select: (...a) => builder(table, 'select').select(...a),
        update: () => builder(table, 'update'),
        insert: () => builder(table, 'insert'),
        upsert: () => builder(table, 'upsert'),
      };
    },
    rpc(name, args) {
      log.push(`rpc ${name} ${JSON.stringify(args)}`);
      if (!HARDENED) {
        // Function does not exist yet.
        return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
      }
      if (name === 'get_session_by_key')  return Promise.resolve({ data: [{ session_key: args.p_key, score: 42 }], error: null });
      if (name === 'claim_session')       return Promise.resolve({ data: args.p_key !== 'nope', error: null });
      if (name === 'username_available')  return Promise.resolve({ data: args.p_username !== 'taken', error: null });
      return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
    },
    auth: { getUser: async () => ({ data: { user: null } }) },
  };
}

function loadDb(mode) {
  const log = [];
  const store = new Map();
  const sandbox = {
    console: { error() {}, warn() {}, log() {} },
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    localStorage: {
      get length() { return store.size; },
      key: i => [...store.keys()][i] ?? null,
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    crypto: require('crypto').webcrypto,
    TextEncoder,
    Math, JSON, Date, Array, Object, String, Number, Promise, Boolean, Error,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.supabase = { createClient: () => makeClient(mode, log) };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/db.js'), 'utf8'), sandbox, { filename: 'js/db.js' });
  return { sandbox, log, store };
}

(async () => {
  for (const mode of ['legacy', 'hardened']) {
    console.log(`\n── ${mode === 'legacy' ? 'Before hardening.sql (current policies)' : 'After hardening.sql'} ──`);

    // getSession
    {
      const { sandbox, log } = loadDb(mode);
      const row = await sandbox.getSession('abc123');
      assert('getSession resolves a shared link', !!row && row.session_key === 'abc123',
        `got ${JSON.stringify(row)}`);
      const usedRpc = log.some(l => l.startsWith('rpc get_session_by_key'));
      const fellBack = log.some(l => l.startsWith('select game_sessions'));
      assert(mode === 'hardened' ? 'getSession uses the RPC' : 'getSession falls back to the direct read',
        mode === 'hardened' ? (usedRpc && !fellBack) : (usedRpc && fellBack), log.join(' | '));
    }

    // claimSessions
    {
      const { sandbox, store } = loadDb(mode);
      store.set('pending_sessions', JSON.stringify([{ sessionKey: 'aaa' }, { sessionKey: 'bbb' }]));
      await sandbox.claimSessions('user-1');
      assert('claimSessions clears the queue when every claim lands',
        !store.has('pending_sessions'), `left: ${store.get('pending_sessions')}`);
    }

    // A failed claim must be retained, not silently dropped.
    {
      const { sandbox, store } = loadDb(mode);
      store.set('pending_sessions', JSON.stringify([{ sessionKey: 'nope' }]));
      await sandbox.claimSessions('user-1');
      const left = store.get('pending_sessions');
      if (mode === 'hardened') {
        assert('an unclaimable session is kept for a later retry',
          !!left && left.includes('nope'), `left: ${left}`);
      } else {
        assert('legacy path still claims and clears', !store.has('pending_sessions'), `left: ${left}`);
      }
    }

    // isUsernameAvailable
    {
      const { sandbox } = loadDb(mode);
      const free  = await sandbox.isUsernameAvailable('brandnew');
      const taken = await sandbox.isUsernameAvailable('taken');
      assert('a free username reads as available', free === true);
      if (mode === 'hardened') {
        assert('a taken username is rejected via the RPC', taken === false);
      } else {
        assert('a taken username is rejected via the direct read', taken === false);
      }
    }
  }

  // ── Robustness, independent of the migration ───────────────
  console.log('\n── Robustness ──');
  {
    const { sandbox, store } = loadDb('legacy');
    store.set('pending_sessions', '{ this is not json');
    let threw = false;
    try { await sandbox.claimSessions('user-1'); } catch (_) { threw = true; }
    assert('corrupt pending_sessions does not throw into the login handler', !threw);
    assert('corrupt pending_sessions is discarded', !store.has('pending_sessions'));
  }
  {
    // No Supabase library at all — every function must degrade, not throw.
    const sandbox = {
      console: { error() {}, warn() {}, log() {} },
      SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y',
      localStorage: { length: 0, key: () => null, getItem: () => '[{"sessionKey":"a"}]', setItem() {}, removeItem() {} },
      Math, JSON, Date, Array, Object, String, Number, Promise, Boolean, Error,
    };
    sandbox.window = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/db.js'), 'utf8'), sandbox, { filename: 'js/db.js' });
    let threw = false;
    try {
      await sandbox.claimSessions('u');
      await sandbox.getSession('k');
      await sandbox.isUsernameAvailable('n');
      await sandbox.countUserSessions('u');
    } catch (_) { threw = true; }
    assert('every db function degrades safely with no Supabase client', !threw);
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed) { console.log(`${failed} test(s) FAILED`); process.exit(1); }
  console.log('All tests passed!');
})();
