// Independent verification of the daily page. The agent that built it was
// killed before running its last checks, so this is written from the contract
// in docs/daily-design.md rather than from its test file.
import { chromium } from 'playwright';
import fs from 'fs';

// Playwright's bundled build and the one on PATH often disagree; point
// ZT_CHROMIUM at a specific binary when the default launch fails.
const EXE  = process.env.ZT_CHROMIUM || undefined;
// Serve with `python3 -m http.server`, NOT `npx serve` — serve's clean-URLs
// default silently strips the query string on its /page.html -> /page
// redirect, which makes assertions pass against the wrong page state.
const BASE = process.env.ZT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log('  pass:', label); }
                           else { fail++; console.log('  FAIL:', label); } };

function makeQuestions(n) {
  return Array.from({ length: n }, (_, i) => ({
    display: `${i + 2} + ${i + 3}`, operation: 'addition', answer: (i + 2) + (i + 3),
  }));
}

// Stub CDN + a Supabase client whose rpc() is driven by `window.__rpc`.
const CDN = `
window.supabase = { createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session: window.__session ?? null }, error: null }),
    getUser:    async () => ({ data: { user: window.__session?.user ?? null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
    signOut: async () => ({ error: null }),
  },
  from: () => ({ select(){return this}, eq(){return this}, is(){return this},
                 order(){return this}, limit(){return this},
                 single: async () => ({ data: null, error: { message: 'stub' } }),
                 maybeSingle: async () => ({ data: null, error: null }),
                 insert: async () => ({ error: null }), update: async () => ({ error: null }),
                 upsert: async () => ({ error: null }) }),
  rpc: async (name, args) => {
    window.__rpcCalls = window.__rpcCalls || [];
    window.__rpcCalls.push([name, args]);
    const h = (window.__rpc || {})[name];
    if (!h) return { data: null, error: { message: 'function ' + name + ' does not exist' } };
    return { data: (typeof h === 'function' ? h(args) : h), error: null };
  },
}) };
window.Chart = function(){ this.destroy=function(){}; this.update=function(){}; this.data={datasets:[{}]}; this.options={scales:{x:{ticks:{}}}}; };
window.Chart.defaults = { font: {} };
`;

async function newPage(browser, { theme = 'dark', session, rpc } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/cdn.jsdelivr.net/**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: CDN }));
  await page.addInitScript(([t, s, r]) => {
    localStorage.setItem('zt_theme', t);
    window.__session = s;
    // Handlers are shipped as source strings because addInitScript cannot
    // serialise functions.
    window.__rpc = {};
    for (const [k, v] of Object.entries(r)) window.__rpc[k] = eval('(' + v + ')');
  }, [theme, session ?? null, rpc ?? {}]);
  return { ctx, page, errors };
}

const SESSION = { user: { id: 'u1', email: 'a@b.c' } };

(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

  // ── 1. Signed out ────────────────────────────────────────────
  {
    console.log('[signed out]');
    const { ctx, page, errors } = await newPage(browser, { session: null, rpc: {} });
    await page.goto(`${BASE}/daily.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const body = await page.textContent('body');
    ok(/log in|sign in|account/i.test(body), 'signed-out page asks the visitor to log in');
    ok(!/undefined|NaN|\[object/i.test(body), 'no undefined/NaN leaked into the copy');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ── 2. Not played yet ────────────────────────────────────────
  {
    console.log('[not played]');
    const rpc = { get_daily_status: `() => ({ puzzle_number: 42, puzzle_date: '2026-09-06',
      duration_seconds: 120, played: false, status: null, seconds_until_reset: 11940, result: null })` };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/daily.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const body = await page.textContent('body');
    ok(body.includes('42'), 'puzzle number 42 is shown');
    ok(/one attempt|once|single/i.test(body), 'the one-attempt rule is stated before starting');
    ok(/midnight|UTC|reset/i.test(body), 'the reset time is stated');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ── 3. Resume mid-run — the critical one ─────────────────────
  // start_daily reports 73s remaining of a 120s run. The page must show ~73,
  // NOT 120: restarting the clock silently destroys the one daily attempt.
  {
    console.log('[resume mid-run]');
    const qs = JSON.stringify(makeQuestions(400));
    const rpc = {
      get_daily_status: `() => ({ puzzle_number: 42, duration_seconds: 120, played: true,
        status: 'in_progress', seconds_until_reset: 11940, result: null })`,
      start_daily: `() => ({ puzzle_number: 42, puzzle_date: '2026-09-06', duration_seconds: 120,
        started_at: '2026-09-06T00:00:00Z', seconds_remaining: 73, status: 'in_progress',
        questions: ${qs}, result: null })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/daily.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const timer = (await page.textContent('#daily-timer')) || '';
    const n = parseInt((timer.match(/\d+/) || [''])[0], 10);
    ok(Number.isFinite(n) && n >= 68 && n <= 74,
       `timer resumes from the SERVER's 73s, not the full 120s (got "${timer.trim()}")`);
    const q = (await page.textContent('#daily-question')) || '';
    ok(/\d+\s*[+−×÷]\s*\d+/.test(q), `a question is displayed (got "${q.trim()}")`);
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await page.screenshot({ path: (process.env.ZT_SHOTS || '/tmp/shots') + '/daily-inprogress.png' });
    await ctx.close();
  }

  // ── 4. Complete: leaderboard, own row, hostile username ──────
  {
    console.log('[complete + leaderboard]');
    const XSS = `<img src=x onerror="window.__pwned=1">`;
    const rpc = {
      get_daily_status: `() => ({ puzzle_number: 42, duration_seconds: 120, played: true,
        status: 'complete', seconds_until_reset: 11940,
        result: { score: 87, accuracy: 0.956, rank: 4, players: 212 } })`,
      get_daily_leaderboard: `() => ({ puzzle_number: 42, players: 212, rows: [
          { rank: 1, username: ${JSON.stringify(XSS)}, score: 104, accuracy: 0.98 },
          { rank: 2, username: 'quietriver', score: 99, accuracy: 0.97 } ],
        you: { rank: 4, username: 'hexadecimal', score: 87, accuracy: 0.956 } })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/daily.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const body = await page.textContent('body');
    ok(body.includes('87'), 'the server-reported score is shown');
    ok(/\b4\b/.test(body) && body.includes('212'), 'rank and player count are shown');
    ok(body.includes('quietriver'), 'leaderboard rows render');
    const pwned = await page.evaluate(() => window.__pwned === 1);
    const injected = await page.evaluate(() =>
      document.querySelectorAll('#daily-board img').length);
    ok(!pwned, 'hostile username did NOT execute');
    ok(injected === 0, 'hostile username produced no live element in the DOM');
    ok(body.includes(XSS), 'hostile username is rendered as literal text');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await page.screenshot({ path: (process.env.ZT_SHOTS || '/tmp/shots') + '/daily-complete.png' });
    await ctx.close();
  }

  // ── 5. Migration not applied — must degrade, not blank ───────
  {
    console.log('[RPCs missing]');
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc: {} });
    await page.goto(`${BASE}/daily.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const body = (await page.textContent('body')) || '';
    ok(body.trim().length > 40, 'page is not blank when the RPCs do not exist');
    ok(!/undefined|NaN|\[object Object\]/.test(body), 'no raw error objects shown to the user');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ── 6. Light theme renders ───────────────────────────────────
  {
    console.log('[light theme]');
    const rpc = { get_daily_status: `() => ({ puzzle_number: 42, duration_seconds: 120,
      played: false, status: null, seconds_until_reset: 11940, result: null })` };
    const { ctx, page, errors } = await newPage(browser, { theme: 'zetamac', session: SESSION, rpc });
    await page.goto(`${BASE}/daily.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    ok((await page.textContent('body')).includes('42'), 'light theme renders the same content');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await page.screenshot({ path: (process.env.ZT_SHOTS || '/tmp/shots') + '/daily-light.png' });
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
