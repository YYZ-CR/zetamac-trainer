// Browser tests for the register half of js/auth.js.
//
// What they pin is the fix in supabase/signup.sql's header: the username the
// form collects must travel WITH the registration, as signUp's options.data,
// instead of being written by a second insert afterwards. That second insert
// is refused by RLS whenever signUp returns no session — which is what email
// confirmation does — and the account went on to play with no profile row and
// no name, invisible to every global board.
//
// So the assertion that matters most is the boring-looking one in "email
// confirmation on": signUp still carries the username, and the page no longer
// claims the account is broken. Before the fix that path wrote nothing and
// said "the username could not be saved"; the account really was nameless and
// the message was the only true thing about it.
//
// The real page scripts run against a stubbed Supabase client, so what is
// exercised is the page's own logic: what it sends, in what order, and what it
// says afterwards.
//
//   ZT_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//     node test/browser/register.mjs
//
// Serve with `python3 -m http.server 8099 --bind 127.0.0.1` — NOT `npx serve`,
// which strips the query string on its /page.html → /page redirect.

import { chromium } from 'playwright';

const EXE  = process.env.ZT_CHROMIUM || undefined;
const BASE = process.env.ZT_BASE || 'http://127.0.0.1:8099';

let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log('  pass:', l)) : (fail++, console.log('  FAIL:', l)); };

// ── The stub ────────────────────────────────────────────────────
// cfg:
//   session     — true when signUp returns a session (email confirmation OFF).
//                 false is the confirmation-on case: a user, no session, and
//                 nothing this browser is allowed to read or write yet.
//   profile     — what profiles.select().single() returns after signUp. An
//                 object is "the trigger already wrote it"; null is a project
//                 where signup.sql has not been applied.
//   insertFails — the profiles insert is refused, as it is when the name was
//                 taken between the availability check and the write.
//   available   — what username_available reports.
const SUPA = (cfg) => `(function(){
const CFG = ${JSON.stringify(cfg)};
window.__calls = [];
const rec = (k, v) => window.__calls.push([k, v]);
window.supabase = { createClient: () => ({
  auth: {
    // Signed out: this is the register flow.
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser:    async () => ({ data: { user: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
    signOut:    async () => ({ error: null }),
    signUp: async (payload) => {
      rec('signUp', payload);
      const user = { id: 'newuser', email: payload && payload.email };
      return {
        data: { user, session: CFG.session ? { user } : null },
        error: null,
      };
    },
    signInWithPassword: async (p) => {
      rec('signIn', p);
      return { data: { user: { id: 'newuser' } }, error: null };
    },
  },
  from: (t) => ({
    _t: t,
    select(){ return this; },
    eq(){ return this; },
    is(){ return this; },
    order(){ return this; },
    limit(){ return this; },
    single: async function(){
      // getProfile: the row the trigger wrote, or the "no rows" error
      // PostgREST returns when there is none.
      if (this._t !== 'profiles') return { data: null, error: { message: 'x' } };
      return CFG.profile
        ? { data: CFG.profile, error: null }
        : { data: null, error: { message: 'no rows' } };
    },
    maybeSingle: async () => ({ data: null, error: null }),
    insert: async function(row){
      rec('insert', [this._t, row]);
      return { error: CFG.insertFails ? { message: 'duplicate key' } : null };
    },
    update(row){ rec('update', [this._t, row]);
                 return { eq: () => ({ is: () => ({ select: async () =>
                   ({ data: [], error: null }) }) }) }; },
    then(r){ r({ data: [], error: null, count: 0 });
             return Promise.resolve({ data: [], error: null, count: 0 }); },
  }),
  rpc: async (n, args) => {
    rec('rpc', [n, args]);
    if (n === 'username_available') {
      return { data: CFG.available !== false, error: null };
    }
    return { data: null, error: { message: 'no fn' } };
  },
})};
window.Chart = function(){ this.destroy=()=>{}; this.update=()=>{};
                           this.data={datasets:[{},{}]};
                           this.options={scales:{x:{ticks:{}}}}; };
window.Chart.defaults = { font: {} };
})();`;

const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

// Fill the register form and submit it. Returns everything asserted on: the
// recorded calls, and what the modal says afterwards.
async function register(cfg, { username = 'newname', email = 'new@example.test' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/cdn.jsdelivr.net/**', r => r.fulfill({
    status: 200, contentType: 'application/javascript', body: SUPA(cfg),
  }));
  // Mark the first-run tour as seen. It is a full-page overlay that swallows
  // every click on a fresh profile, and js/tour.js gates on this exact key and
  // version (TOUR_KEY / TOUR_VERSION) — if either changes, this suite starts
  // timing out on the submit button rather than failing quietly.
  await p.addInitScript(`localStorage.setItem('zt_tour_seen', '3')`);

  await p.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await p.evaluate(() => showAuthModal('register'));
  await p.waitForSelector('#auth-username:visible');

  await p.fill('#auth-email', email);
  await p.fill('#auth-password', 'hunter2hunter2');
  await p.fill('#auth-username', username);
  await p.click('#auth-submit-btn');
  await p.waitForTimeout(400);

  const calls = await p.evaluate(() => window.__calls);
  const error = (await p.textContent('#auth-error'))?.trim() ?? '';
  const open  = await p.evaluate(() =>
    document.getElementById('auth-modal').style.display !== 'none');

  await ctx.close();
  return { calls, error, open, errs };
}

const callsOf = (calls, kind) => calls.filter(([k]) => k === kind).map(([, v]) => v);

// ── 1. Email confirmation ON — the case the bug lived in ────────
// signUp returns a user and no session. Nothing may be read or written from
// here, so the trigger is the entire mechanism, and the username has to be in
// the signUp payload or it is gone for good.
{
  console.log('email confirmation on (no session):');
  const { calls, error, errs } = await register({ session: false, profile: null });
  const signUps = callsOf(calls, 'signUp');

  ok(signUps.length === 1, 'signUp is called exactly once');
  ok(signUps[0]?.options?.data?.username === 'newname',
     'the username is carried in signUp options.data');
  ok(signUps[0]?.email === 'new@example.test', 'the email is the one typed');

  // The regression this file exists to catch. The old code inserted here,
  // the insert was refused, and the account was left nameless.
  ok(callsOf(calls, 'insert').length === 0,
     'no profile insert is attempted without a session');
  ok(error === '',
     'no failure message: the trigger wrote the profile server-side');
  ok(errs.length === 0, 'no page errors');
}

// ── 2. Confirmation off, trigger applied — the ordinary path ────
{
  console.log('session, signup.sql applied:');
  const { calls, error, errs } = await register({
    session: true, profile: { id: 'newuser', username: 'newname' },
  });

  ok(callsOf(calls, 'signUp')[0]?.options?.data?.username === 'newname',
     'the username is still carried in options.data');
  ok(callsOf(calls, 'insert').length === 0,
     'the profile the trigger wrote is not written a second time');
  ok(error === '', 'nothing is reported as wrong');
  ok(errs.length === 0, 'no page errors');
}

// ── 3. Session, signup.sql NOT applied — the fallback ───────────
// CLAUDE.md: the client works on both sides of a migration. With a session
// there is something to check and something to fix, so it falls back to the
// insert the trigger would otherwise have made.
{
  console.log('session, signup.sql not applied:');
  const { calls, error, errs } = await register({ session: true, profile: null });
  const inserts = callsOf(calls, 'insert');

  ok(inserts.length === 1, 'the client falls back to inserting the profile itself');
  ok(inserts[0]?.[0] === 'profiles', 'into profiles');
  ok(inserts[0]?.[1]?.username === 'newname', 'with the username that was typed');
  ok(inserts[0]?.[1]?.id === 'newuser', 'and the id of the account just created');
  ok(error === '', 'and says nothing is wrong, because nothing is');
  ok(errs.length === 0, 'no page errors');
}

// ── 4. The name was taken in the gap ────────────────────────────
// The availability check said free, the UNIQUE index disagreed. That is a
// real failure and the only one worth a message: the account exists, the name
// is not theirs, and Settings is where they fix it.
{
  console.log('name taken between the check and the write:');
  const { calls, error } = await register({
    session: true, profile: null, insertFails: true,
  });

  ok(callsOf(calls, 'insert').length === 1, 'the insert was attempted');
  ok(/could not be saved/i.test(error), 'the failure is reported');
  ok(/settings/i.test(error), 'and it says where to fix it');
}

// ── 5. The client-side shape rule still runs first ──────────────
// No account should be created for a name the database is going to refuse:
// that is exactly how an account ends up nameless.
{
  console.log('a name the shape rule refuses:');
  const { calls, error } = await register({ session: true }, { username: 'ab' });

  ok(callsOf(calls, 'signUp').length === 0, 'signUp is never called');
  ok(/at least 3/i.test(error), 'and the reason names the rule');
}

{
  console.log('a name with a space:');
  const { calls, error } = await register({ session: true }, { username: 'bad name' });

  ok(callsOf(calls, 'signUp').length === 0, 'signUp is never called');
  ok(/space/i.test(error), 'and the reason names the rule');
}

// ── 6. A name already held ──────────────────────────────────────
{
  console.log('a name username_available reports taken:');
  const { calls, error } = await register({ session: true, available: false });

  ok(callsOf(calls, 'signUp').length === 0, 'signUp is never called');
  ok(/taken/i.test(error), 'and the reason says so');
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
