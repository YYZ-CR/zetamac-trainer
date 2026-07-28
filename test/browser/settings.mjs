// Browser tests for settings.html + js/settings.js.
//
// The real page scripts run against a stubbed Supabase client, so what is
// exercised here is the page's own logic: which state it renders, what it
// says, what it disables, and what it sends. Every assertion is on specific
// expected text — "contains a date" and "is not empty" would both have passed
// while the page said the wrong thing.
//
// Every state is checked in BOTH themes, because a hardcoded colour is
// invisible until somebody switches.
//
//   ZT_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//     node test/browser/settings.mjs
//
// Serve with `python3 -m http.server 8099 --bind 127.0.0.1` — NOT `npx serve`,
// which strips the query string on its /page.html → /page redirect.

import { chromium } from 'playwright';

const EXE   = process.env.ZT_CHROMIUM || undefined;
const BASE  = process.env.ZT_BASE  || 'http://127.0.0.1:8099';
const SHOTS = process.env.ZT_SHOTS || '/tmp/shots';

let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log('  pass:', l)) : (fail++, console.log('  FAIL:', l)); };

const DAY = 24 * 60 * 60 * 1000;

// The page formats with toLocaleDateString(undefined, {year,month,day}); the
// context below pins the locale to en-US and the timezone to UTC so the string
// is the same on every machine that runs this.
const longDate = (ms) => new Date(ms).toLocaleDateString('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
});

// ── The stub ────────────────────────────────────────────────────
// cfg: { user, profile, setUsername, updateFails }
//   setUsername — the JSONB set_username would return, or {__error:'…'} to
//                 make the RPC itself fail (migration not applied).
const SUPA = (cfg) => `(function(){
const CFG = ${JSON.stringify(cfg)};
const REC = '__calls';
// Initialised only if absent. Log out navigates to index.html, which loads
// this same stub again — resetting here would erase the signOut we are about
// to assert on. Each test gets a fresh context, so it always starts empty.
if (!sessionStorage.getItem(REC)) sessionStorage.setItem(REC, '[]');
window.__calls = () => JSON.parse(sessionStorage.getItem(REC) || '[]');
const rec = (k, v) => { const a = JSON.parse(sessionStorage.getItem(REC) || '[]');
                        a.push([k, v]); sessionStorage.setItem(REC, JSON.stringify(a)); };
const user = CFG.user;
window.supabase = { createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session: user ? { user } : null }, error: null }),
    getUser:    async () => ({ data: { user } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
    signOut:    async () => { rec('signOut', 1); return { error: null }; },
  },
  from: (t) => ({
    _t: t,
    select(){ return this; },
    eq(){ return this; },
    is(){ return this; },
    order(){ return this; },
    limit(){ return this; },
    single: async function(){
      return this._t === 'profiles'
        ? { data: CFG.profile || null,
            error: CFG.profile ? null : { message: 'no rows' } }
        : { data: null, error: { message: 'x' } };
    },
    maybeSingle: async () => ({ data: null, error: null }),
    insert: async function(row){ rec('insert', [this._t, row]); return { error: null }; },
    // .update(row).eq(col, val) — a distinct object, because the select chain
    // above needs eq() to return the builder and this one needs it awaitable.
    update(row){
      rec('update', [this._t, row]);
      return { eq: async () => ({ error: CFG.updateFails ? { message: 'denied' } : null }) };
    },
    then(r){ r({ data: [], error: null, count: 0 });
             return Promise.resolve({ data: [], error: null, count: 0 }); },
  }),
  rpc: async (n, args) => {
    rec('rpc', [n, args]);
    if (n === 'set_username') {
      const r = CFG.setUsername;
      if (r && r.__error) return { data: null, error: { message: r.__error } };
      return { data: r || null, error: null };
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

async function open(cfg, theme) {
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 1000 },
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/cdn.jsdelivr.net/**', r => r.fulfill({
    status: 200, contentType: 'application/javascript', body: SUPA(cfg),
  }));
  await p.addInitScript(`localStorage.setItem('zt_theme', ${JSON.stringify(theme)})`);
  await p.goto(BASE + '/settings.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  return { ctx, p, errs };
}

const shot = (p, name, theme) =>
  p.screenshot({ path: `${SHOTS}/settings-${name}-${theme}.png`, fullPage: true });

const USER = { id: 'u1', email: 'yang@example.test' };

// Every block below runs once per theme.
for (const theme of ['zetamac', 'dark']) {
  console.log(`\n════════ theme: ${theme} ════════`);

  // ── Signed out ────────────────────────────────────────────────
  console.log('[signed out]');
  {
    const { ctx, p, errs } = await open({ user: null }, theme);
    ok(await p.isVisible('#settings-signed-out'), 'the signed-out prompt is shown');
    ok(!(await p.isVisible('#settings-signed-in')), 'no settings panels are shown');
    ok(!(await p.isVisible('#settings-loading')), 'the loading line is gone');

    const t = await p.textContent('#settings-signed-out');
    ok(t.includes('Settings live with your account.'),
       'it explains that settings belong to an account');
    ok(/log in/i.test(t), 'it says to log in');

    await p.click('#settings-login-btn');
    await p.waitForTimeout(200);
    ok(await p.isVisible('#auth-modal'), 'Log In opens the auth modal');
    ok((await p.textContent('#modal-heading')) === 'Log In', 'the modal is in log-in mode');

    await p.click('#modal-close-btn');
    await p.click('#settings-register-btn');
    await p.waitForTimeout(200);
    ok((await p.textContent('#modal-heading')) === 'Register',
       'Register opens the same modal in register mode');

    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'signed-out', theme);
    await ctx.close();
  }

  // ── Signed in, no username at all: the claim flow ─────────────
  console.log('[no username -> claim flow, no cooldown]');
  {
    const { ctx, p, errs } = await open({ user: USER, profile: null }, theme);
    ok(await p.isVisible('#settings-signed-in'), 'the panels are shown');

    ok((await p.textContent('#username-panel-note')) === 'Not set',
       'the username panel is badged "Not set"');
    const intro = await p.textContent('#username-intro');
    ok(intro.includes('Claiming your first one is free'),
       'it says the first username is free');
    ok(intro.includes('the 30-day wait only starts once you have one'),
       'it says the wait does not apply yet');
    ok((await p.textContent('#username-save-btn')) === 'Claim username',
       'the button reads "Claim username", not "Save"');
    ok(await p.isEnabled('#username-input'), 'the input is usable');
    ok((await p.inputValue('#username-input')) === '', 'the input starts empty');
    ok(!(await p.isVisible('#username-current')), 'no current name is claimed to exist');

    ok((await p.textContent('#username-rules')) ===
       '3 to 20 characters. Letters, numbers, hyphens and underscores only — no spaces. ' +
       'You can change it once every 30 days.',
       'the rules are stated in full');

    // Visibility is gated on having a username.
    ok((await p.textContent('#visibility-badge')) === 'Needs a username',
       'the visibility panel says it needs a username');
    ok(!(await p.isEnabled('#visibility-check')), 'the visibility toggle is disabled');
    ok((await p.textContent('#visibility-note'))
        .includes('you need a username before it can be public'),
       'it explains why the toggle is off');
    ok(!(await p.isVisible('#visibility-link-row')), 'no profile link is offered');

    ok((await p.textContent('#account-email')) === 'yang@example.test',
       'the account email is shown');
    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'no-username', theme);
    await ctx.close();
  }

  // ── Claiming a username succeeds ──────────────────────────────
  console.log('[claim succeeds -> visibility unlocks]');
  {
    const next = Date.now() + 30 * DAY;
    const { ctx, p, errs } = await open({
      user: USER, profile: null,
      setUsername: { ok: true, username: 'yang_z', error: null,
                     next_change_allowed_at: new Date(next).toISOString() },
    }, theme);

    await p.fill('#username-input', 'yang_z');
    await p.click('#username-save-btn');
    await p.waitForTimeout(400);

    const calls = await p.evaluate(() => window.__calls());
    const rpc = calls.find(([k, v]) => k === 'rpc' && v[0] === 'set_username');
    ok(!!rpc, 'it calls set_username');
    ok(rpc && rpc[1][1].p_username === 'yang_z', 'it sends the typed name');
    ok(!calls.some(([k, v]) => k === 'update' && v[1] && 'username' in v[1]),
       'it never writes profiles.username directly');

    ok((await p.textContent('#username-status')) === 'Saved. You are now yang_z.',
       'it confirms the new name');
    ok((await p.textContent('#username-panel-note')) === 'Locked',
       'the panel is locked immediately — the 30-day clock has started');
    ok(!(await p.isEnabled('#username-input')), 'and the input is disabled');
    ok((await p.textContent('#username-intro'))
        .includes('You can change it again on ' + longDate(next)),
       'it names the date the next change is allowed: ' + longDate(next));

    ok((await p.textContent('#visibility-badge')) === 'Private',
       'the visibility panel unlocks and reads Private');
    ok(await p.isEnabled('#visibility-check'), 'the toggle is now usable');
    ok((await p.textContent('#settings-subtitle')) === 'Signed in as yang_z',
       'the header subtitle picks up the new name');

    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'claimed', theme);
    await ctx.close();
  }

  // ── A username with a name already, outside any cooldown ──────
  console.log('[username set, changeable now]');
  {
    const { ctx, p, errs } = await open({
      user: USER,
      profile: { id: 'u1', username: 'yang_z', is_public: false, username_changed_at: null },
    }, theme);

    ok((await p.textContent('#username-panel-note')) === 'Set',
       'the panel is badged "Set"');
    ok((await p.textContent('#username-current')) === 'Your username is yang_z',
       'the current name is shown');
    ok((await p.inputValue('#username-input')) === 'yang_z',
       'the input is prefilled with it');
    ok(await p.isEnabled('#username-input'), 'the input is usable');
    ok(await p.isEnabled('#username-save-btn'), 'Save is usable');
    ok((await p.textContent('#username-intro'))
        .includes('Changing it starts a 30-day wait'),
       'it warns that a change starts the wait');

    ok((await p.textContent('#visibility-badge')) === 'Private',
       'the profile is private');
    ok(!(await p.isVisible('#visibility-link-row')),
       'a private profile offers no link to share');

    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'editable', theme);
    await ctx.close();
  }

  // ── Inside the cooldown ───────────────────────────────────────
  console.log('[cooldown active -> input disabled, date named]');
  {
    const changed = Date.now() - 5 * DAY;
    const next    = changed + 30 * DAY;
    const { ctx, p, errs } = await open({
      user: USER,
      profile: { id: 'u1', username: 'yang_z', is_public: true,
                 username_changed_at: new Date(changed).toISOString() },
    }, theme);

    ok((await p.textContent('#username-panel-note')) === 'Locked',
       'the panel is badged "Locked"');
    ok(!(await p.isEnabled('#username-input')), 'the input is disabled');
    ok(!(await p.isEnabled('#username-save-btn')), 'Save is disabled');
    ok((await p.textContent('#username-intro')) ===
       'You changed your username recently. You can change it again on ' +
       longDate(next) + '.',
       'it names exactly when the change becomes possible: ' + longDate(next));

    // The rules stay on screen during the cooldown: they are what the name has
    // to satisfy when the wait ends.
    ok((await p.textContent('#username-rules')).includes('3 to 20 characters'),
       'the rules are still stated while locked');

    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'cooldown', theme);
    await ctx.close();
  }

  // ── Refusals, each with its own reason ────────────────────────
  console.log('[a rejected username shows the reason]');
  {
    const cases = [
      ['username_invalid_chars', 'Yang Zhang',
       'Usernames can only use letters, numbers, hyphens and underscores — no spaces, ' +
       'accents or other alphabets.'],
      ['username_too_short', 'ab', 'Usernames are at least 3 characters.'],
      ['username_taken', 'YANG_Z',
       'That name is already taken. Names are compared without case, so "Alex" and ' +
       '"alex" count as the same name.'],
      ['username_missing', 'anything',
       'Username changes are not available on this deployment yet.'],
    ];

    for (const [code, typed, expected] of cases) {
      const cfg = {
        user: USER,
        profile: { id: 'u1', username: 'yang_z', is_public: false, username_changed_at: null },
        setUsername: code === 'username_missing'
          ? { __error: 'Could not find the function public.set_username in the schema cache' }
          : { ok: false, username: 'yang_z', next_change_allowed_at: null, error: code },
      };
      const { ctx, p, errs } = await open(cfg, theme);

      await p.fill('#username-input', typed);
      await p.click('#username-save-btn');
      await p.waitForTimeout(300);

      ok((await p.textContent('#username-error')) === expected,
         `${code} is reported as: ${expected}`);
      ok((await p.textContent('#username-current')) === 'Your username is yang_z',
         `${code} leaves the current name alone`);
      ok((await p.inputValue('#username-input')) === typed,
         `${code} keeps what was typed so it can be edited`);
      ok(await p.isEnabled('#username-save-btn'),
         `${code} re-enables Save`);
      ok((await p.textContent('#username-status')) === '',
         `${code} claims no success`);
      ok(errs.length === 0, `${code}: no uncaught errors (` + (errs[0] ?? '') + ')');

      if (code === 'username_invalid_chars') await shot(p, 'refused', theme);
      await ctx.close();
    }
  }

  // ── A cooldown refusal arriving from the server ───────────────
  console.log('[cooldown refusal names the date and locks the field]');
  {
    const next = Date.now() + 12 * DAY;
    const { ctx, p, errs } = await open({
      user: USER,
      // The page believes there is no cooldown; the server disagrees. The
      // server wins, and the page has to re-render from its answer.
      profile: { id: 'u1', username: 'yang_z', is_public: false, username_changed_at: null },
      setUsername: { ok: false, username: 'yang_z', error: 'username_cooldown',
                     next_change_allowed_at: new Date(next).toISOString() },
    }, theme);

    await p.fill('#username-input', 'newname');
    await p.click('#username-save-btn');
    await p.waitForTimeout(300);

    ok((await p.textContent('#username-error')) ===
       'You changed your username too recently. You can change it again on ' +
       longDate(next) + '.',
       'the refusal names the exact date: ' + longDate(next));
    ok(!(await p.isEnabled('#username-input')),
       'the field locks itself once the server says there is a cooldown');
    ok(!(await p.isEnabled('#username-save-btn')), 'and Save locks with it');
    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'cooldown-refusal', theme);
    await ctx.close();
  }

  // ── The visibility toggle: success ────────────────────────────
  console.log('[visibility toggle publishes and offers the link]');
  {
    const { ctx, p, errs } = await open({
      user: USER,
      profile: { id: 'u1', username: 'yang_z', is_public: false, username_changed_at: null },
    }, theme);

    await p.check('#visibility-check');
    await p.waitForTimeout(300);

    const calls = await p.evaluate(() => window.__calls());
    ok(calls.some(([k, v]) => k === 'update' && v[0] === 'profiles' && v[1].is_public === true),
       'it sends is_public true');
    ok((await p.textContent('#visibility-status')) === 'Your profile is now public.',
       'it confirms publication');
    ok((await p.textContent('#visibility-badge')) === 'Public', 'the badge flips to Public');
    ok(await p.isVisible('#visibility-link-row'), 'the link row appears');
    ok((await p.textContent('#visibility-link')) === '/@yang_z',
       'the link is shown in its /@name form');
    ok((await p.getAttribute('#visibility-link', 'href')) === 'profile.html?u=yang_z',
       'but the href is the real query-string URL');
    ok(await p.isVisible('#visibility-copy-btn'), 'a copy button is offered');

    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'public', theme);
    await ctx.close();
  }

  // ── The visibility toggle: failure reverts ────────────────────
  console.log('[visibility toggle reverts on failure]');
  {
    const { ctx, p, errs } = await open({
      user: USER,
      profile: { id: 'u1', username: 'yang_z', is_public: false, username_changed_at: null },
      updateFails: true,
    }, theme);

    // click(), not check(): check() asserts the box ends up ticked, and the
    // whole point of this case is that it does not.
    await p.click('#visibility-check');
    await p.waitForTimeout(300);

    ok((await p.isChecked('#visibility-check')) === false,
       'the checkbox goes back to unchecked');
    ok((await p.textContent('#visibility-status')) ===
       "Couldn't save that — your profile is still private. Try again.",
       'it says the profile is still private');
    ok((await p.textContent('#visibility-badge')) === 'Private',
       'the badge still reads Private');
    ok(!(await p.isVisible('#visibility-link-row')),
       'no shareable link is offered for a profile that was not published');
    ok(await p.isEnabled('#visibility-check'), 'the toggle is usable again');

    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'visibility-failed', theme);
    await ctx.close();
  }

  // ── A hostile username is text, not markup ────────────────────
  console.log('[a hostile username renders as literal text]');
  {
    const NASTY = '<img src=x onerror="window.__xss=1">';
    const { ctx, p, errs } = await open({
      user: USER,
      profile: { id: 'u1', username: NASTY, is_public: true, username_changed_at: null },
    }, theme);

    ok((await p.evaluate(() => window.__xss)) === undefined,
       'nothing in the username executed');
    ok((await p.$('#username-current img')) === null,
       'the username did not become an element');
    ok((await p.textContent('#username-current')) === 'Your username is ' + NASTY,
       'it is shown verbatim as text');
    ok((await p.textContent('#visibility-link')) === '/@' + NASTY,
       'the profile link shows it verbatim too');
    ok((await p.$('#visibility-link img')) === null,
       'and the link did not become an element either');
    ok((await p.textContent('#settings-subtitle')) === 'Signed in as ' + NASTY,
       'the header subtitle shows it verbatim');
    ok((await p.getAttribute('#visibility-link', 'href')) ===
       'profile.html?u=' + encodeURIComponent(NASTY),
       'the href is percent-encoded, not interpolated raw');

    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'hostile-username', theme);
    await ctx.close();
  }

  // ── Appearance ────────────────────────────────────────────────
  console.log('[appearance stays in sync with the header toggle]');
  {
    const { ctx, p, errs } = await open({
      user: USER,
      profile: { id: 'u1', username: 'yang_z', is_public: false, username_changed_at: null },
    }, theme);

    const other = theme === 'dark' ? 'zetamac' : 'dark';

    ok(await p.isChecked(`#theme-${theme}`), `the ${theme} radio starts checked`);
    ok(!(await p.isChecked(`#theme-${other}`)), `the ${other} radio starts unchecked`);
    ok((await p.textContent('#appearance-badge')) === (theme === 'dark' ? 'Dark' : 'Zetamac'),
       'the badge names the current theme');

    // Switching from the radio moves the document and the store.
    await p.check(`#theme-${other}`);
    await p.waitForTimeout(150);
    ok((await p.getAttribute('html', 'data-theme')) === other,
       'choosing the other radio applies that theme');
    ok((await p.evaluate(() => localStorage.getItem('zt_theme'))) === other,
       'and stores it under the one existing key, zt_theme');
    ok((await p.textContent('#appearance-badge')) === (other === 'dark' ? 'Dark' : 'Zetamac'),
       'the badge follows');

    // Switching from the header toggle moves the radio back.
    await p.click('.theme-toggle');
    await p.waitForTimeout(150);
    ok((await p.getAttribute('html', 'data-theme')) === theme,
       'the header toggle switches back');
    ok(await p.isChecked(`#theme-${theme}`),
       'and the radio follows the header toggle — one store, two controls');
    ok((await p.evaluate(() => document.querySelectorAll('[name="zt-theme"]:checked').length)) === 1,
       'exactly one theme is ever selected');

    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await shot(p, 'appearance', theme);
    await ctx.close();
  }

  // ── Account ───────────────────────────────────────────────────
  console.log('[account section]');
  {
    const { ctx, p, errs } = await open({
      user: USER,
      profile: { id: 'u1', username: 'yang_z', is_public: false, username_changed_at: null },
    }, theme);

    ok((await p.textContent('#account-email')) === 'yang@example.test',
       'the email is shown');
    ok(await p.$('#account-email input') === null,
       'the email is read-only text, not an editable field');

    await p.click('#settings-logout-btn');
    await p.waitForTimeout(400);
    const calls = await p.evaluate(() => window.__calls());
    ok(calls.some(([k]) => k === 'signOut'), 'Log out signs out');
    ok(/\/index\.html$/.test(p.url()),
       'and leaves for the home page rather than sitting on a dead settings page');

    ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
    await ctx.close();
  }

  // ── The nav ───────────────────────────────────────────────────
  console.log('[nav]');
  {
    const { ctx, p } = await open({
      user: USER,
      profile: { id: 'u1', username: 'yang_z', is_public: false, username_changed_at: null },
    }, theme);
    ok((await p.textContent('.top-bar .nav-current')) === 'Settings',
       'Settings is marked as the current page rather than linking to itself');
    await ctx.close();
  }
  {
    const { ctx, p } = await open({ user: null }, theme);
    ok((await p.textContent('.top-bar')).indexOf('Settings') === -1,
       'signed out, the nav does not offer Settings at all');
    await ctx.close();
  }
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
