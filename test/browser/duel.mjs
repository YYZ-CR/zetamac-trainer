// Browser verification of duel.html, written against docs/duels-design.md and
// the payload shapes in supabase/duels.sql.
//
// Every assertion below names a SPECIFIC expected string. This repo has twice
// shipped a green suite that only proved "something rendered" and was passing
// against the wrong page state, so a non-emptiness check is not a test here.
import { chromium } from 'playwright';

// Playwright's bundled build and the one on PATH often disagree; point
// ZT_CHROMIUM at a specific binary when the default launch fails.
const EXE  = process.env.ZT_CHROMIUM || undefined;
// Serve with `python3 -m http.server`, NOT `npx serve` — serve's clean-URLs
// default silently strips the query string on its /page.html -> /page
// redirect, which makes assertions pass against the wrong page state.
const BASE  = process.env.ZT_BASE  || 'http://127.0.0.1:8099';
const SHOTS = process.env.ZT_SHOTS || '/tmp/shots';
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log('  pass:', label); }
                           else { fail++; console.log('  FAIL:', label); } };

function makeQuestions(n) {
  return Array.from({ length: n }, (_, i) => ({
    display: `${i + 2} + ${i + 3}`, operation: 'addition', answer: (i + 2) + (i + 3),
  }));
}

const round1 = v => Math.round(v * 10) / 10;

// A pace timeline: the SECONDS at which a side banked each correct answer,
// ascending — the shape get_duel_by_key's per-side `points` carries. Two
// phases so the projected-score curve it produces actually bends.
function paceTimes(nFirst, gapFirst, nSecond, gapSecond) {
  const out = [];
  for (let i = 1; i <= nFirst;  i++) out.push(round1(i * gapFirst));
  const t0 = nFirst * gapFirst;
  for (let i = 1; i <= nSecond; i++) out.push(round1(t0 + i * gapSecond));
  return out;
}

// The two timelines the decided-duel assertions are written against. They are
// deliberately different SHAPES, not just different lengths, so a chart that
// silently reused one side's x values for the other cannot pass.
//
//   YOU  — 74 answers: slow (2.4s) to 60s, then quick (1.2s) to 118.8s.
//          Projected score is a flat 50 through the first phase, rising to 74.
//          Exact point to assert: (60, 50)  =  25 banked x 120 / 60.
//   THEM — 61 answers: quick (1.2s) to 36s, then slow (2.6s) to 116.6s.
//          Projected score starts at 100 and decays to 61.
//          Exact point to assert: (36, 100) =  30 banked x 120 / 36.
//
// So the two curves cross around the 90-second mark: whoever is ahead changes
// once, which is the only thing the tinted fill exists to show.
const PACE_YOU  = paceTimes(25, 2.4, 49, 1.2);   // 74 times, last 118.8
const PACE_THEM = paceTimes(30, 1.2, 31, 2.6);   // 61 times, last 116.6

// A local timeline for the same 74 answers, evenly paced, so it projects to a
// flat ~74 the whole way — nothing like PACE_YOU, which sits at 50 for the
// first minute. It is the localStorage record wherever the server ALSO sends
// points: the server's must win, and the (60, 50) assertion is what proves it,
// since the even pacing puts (60, 74) there instead.
const LOCAL_EVEN_74 = Array.from({ length: 74 }, (_, i) => round1((i + 1) * (120 / 74)));

// Stub CDN (jsdelivr is blocked in the sandbox) + a Supabase client whose
// rpc() is driven by `window.__rpc`. Chart.js is stubbed too, but records the
// config it was constructed with so the pace graph can be asserted on.
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
    if (!h) return { data: null, error: { message: 'function ' + name + ' does not exist', code: 'PGRST202' } };
    const out = (typeof h === 'function' ? h(args) : h);
    // A handler may raise the way supabase/duels.sql does: { __error: {...} }
    if (out && out.__error) return { data: null, error: out.__error };
    return { data: out, error: null };
  },
}) };
window.__charts = [];
window.Chart = function(ctx, cfg){
  window.__charts.push(cfg);
  this.destroy=function(){}; this.update=function(){};
  this.data=cfg.data; this.options=cfg.options;
};
window.Chart.defaults = { font: {} };
`;

async function newPage(browser, { theme = 'dark', session, rpc, storage } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/cdn.jsdelivr.net/**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: CDN }));
  await page.addInitScript(([t, s, r, st]) => {
    localStorage.setItem('zt_theme', t);
    for (const [k, v] of Object.entries(st || {})) localStorage.setItem(k, v);
    window.__session = s;
    // Handlers are shipped as source strings because addInitScript cannot
    // serialise functions.
    window.__rpc = {};
    for (const [k, v] of Object.entries(r)) window.__rpc[k] = eval('(' + v + ')');
  }, [theme, session ?? null, rpc ?? {}, storage ?? {}]);
  return { ctx, page, errors };
}

const SESSION = { user: { id: 'u1', email: 'a@b.c' } };
const KEY     = 'abcd1234ef';

// A get_duel_by_key payload with the fields supabase/duels.sql actually emits.
function duelPayload(over = {}) {
  return Object.assign({
    duel_key: KEY,
    duration_seconds: 120,
    created_at: '2026-07-28T00:00:00Z',
    expires_at: '2026-07-30T00:00:00Z',
    expired: false,
    status: 'open',
    seconds_until_expiry: 100000,
    your_side: 'opponent',
    opponent_claimed: true,
    scores_revealed: false,
    outcome: null,
    creator:  { played: false, status: null, submitted_at: null, score: null, is_you: false },
    opponent: { played: false, status: null, submitted_at: null, score: null, is_you: true },
  }, over);
}

const src = v => JSON.stringify(v);

(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

  for (const theme of ['dark', 'zetamac']) {
    const tag = theme === 'dark' ? 'dark' : 'light';
    console.log(`\n══════ theme: ${tag} ══════`);

    // ── State 1a. No ?d=, signed out ─────────────────────────
    {
      console.log('[1a create — signed out]');
      const { ctx, page, errors } = await newPage(browser, { theme, session: null, rpc: {} });
      await page.goto(`${BASE}/duel.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const body = await page.textContent('body');
      ok(body.includes('Creating a duel needs an account'),
         'signed-out creator is told an account is required');
      ok(/Accepting one doesn't need an account/.test(body),
         'and that accepting one does NOT need an account');
      ok(!/undefined|NaN|\[object/i.test(body), 'no undefined/NaN leaked into the copy');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-1a-create-signedout-${tag}.png` });
      await ctx.close();
    }

    // ── State 1b. No ?d=, signed in → create + copy link ─────
    {
      console.log('[1b create — signed in]');
      const rpc = { create_duel: `(a) => ({ duel_key: ${src(KEY)},
        expires_at: '2099-01-01T00:00:00Z', duration_seconds: a.p_duration })` };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      ok((await page.textContent('body')).includes('New duel'), 'the create panel renders');
      ok(await page.isVisible('#duel-duration'), 'a duration picker is offered');

      await page.selectOption('#duel-duration', '180');
      await page.click('#duel-create-btn');
      await page.waitForTimeout(400);

      const body = await page.textContent('body');
      ok(body.includes('Your duel is ready'), 'creation confirms');
      ok(body.includes('180 seconds'), 'the SERVER-returned duration (180) is shown');
      const link = await page.inputValue('#duel-share-text');
      ok(link.endsWith(`/duel.html?d=${KEY}`), `the share link carries the key (got "${link}")`);
      ok(await page.isVisible('#duel-share-btn'), 'a copy button is offered');

      const sent = await page.evaluate(() => window.__rpcCalls.find(c => c[0] === 'create_duel'));
      ok(sent && sent[1].p_duration === 180, 'create_duel was called with the chosen duration');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-1b-created-${tag}.png` });
      await ctx.close();
    }

    // ── State 2. Invited, not played — irreversible Start ────
    {
      console.log('[2 intro — invited guest]');
      const rpc = { get_duel_by_key: `() => (${src(duelPayload({ your_side: 'open', opponent_claimed: false }))})` };
      const { ctx, page, errors } = await newPage(browser, { theme, session: null, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const body = await page.textContent('body');
      ok(body.includes("You've been challenged"), 'the page says they have been challenged');
      ok(body.includes('120-second duel'), 'the duration from the payload is shown');
      ok(/claims your side of this duel and starts the 120-second/.test(body),
         'the irreversibility of Start is stated BEFORE the button');
      ok(body.includes('One run per side'), 'the one-run rule is stated');
      ok(body.includes("Neither score is shown until both of you are done"),
         'the no-peeking rule is stated');
      ok(body.includes("You're playing as a guest"), 'a signed-out player is warned it is browser-bound');
      ok(await page.isVisible('#duel-start-btn'), 'a Start button is offered');

      // The guest token must exist BEFORE start_duel_run is ever called.
      const token = await page.evaluate(k => localStorage.getItem('duel_guest_' + k), KEY);
      ok(typeof token === 'string' && token.length >= 8,
         `a guest token was persisted before starting (len ${token ? token.length : 0})`);
      const call = await page.evaluate(() => window.__rpcCalls.find(c => c[0] === 'get_duel_by_key'));
      ok(call && call[1].p_guest_token === token, 'that same token was sent to get_duel_by_key');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-2-intro-${tag}.png` });
      await ctx.close();
    }

    // ── State 3. In progress, resumed from the SERVER clock ──
    // The critical one: start_duel_run reports 47s remaining of a 120s run.
    // The page must show ~47, NOT 120 — restarting the clock on a refresh
    // hands out free time and destroys the one run per side.
    {
      console.log('[3 in progress — refresh resumes]');
      const qs = src(makeQuestions(400));
      const rpc = {
        get_duel_by_key: `() => (${src(duelPayload({
          your_side: 'opponent',
          opponent: { played: true, status: 'in_progress', submitted_at: null, score: null, is_you: true },
        }))})`,
        start_duel_run: `() => ({ duel_key: ${src(KEY)}, side: 'opponent', duration_seconds: 120,
          started_at: '2026-07-28T00:01:00Z', seconds_remaining: 47, status: 'in_progress',
          questions: ${qs}, duel: ${src(duelPayload({ your_side: 'opponent' }))} })`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: null, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      const timer = (await page.textContent('#duel-timer')) || '';
      const n = parseInt((timer.match(/\d+/) || [''])[0], 10);
      ok(Number.isFinite(n) && n >= 42 && n <= 48,
         `timer resumes from the SERVER's 47s, not the full 120s (got "${timer.trim()}")`);
      const q = (await page.textContent('#duel-question')) || '';
      ok(/^\d+ \+ \d+ =$/.test(q.trim()), `the first stub question is displayed (got "${q.trim()}")`);
      ok((await page.textContent('#duel-answered')).includes('Answered: 0'), 'the HUD counts answers');
      ok(!(await page.isVisible('#duel-panel')), 'the intro panel is gone once the run is live');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-3-inprogress-${tag}.png` });
      await ctx.close();
    }

    // ── State 4. You done, them not — NO opponent score ──────
    // The stub is deliberately hostile: it sets scores_revealed false but ALSO
    // leaks a real opponent score (88) and the caller's own (41) in the score
    // fields. A client that trusted `score != null` instead of the reveal flag
    // would print 88. The reveal gate is what this asserts.
    {
      console.log('[4 waiting — opponent score must not appear]');
      const rpc = {
        get_duel_by_key: `() => (${src(duelPayload({
          your_side: 'creator',
          scores_revealed: false,
          outcome: null,
          creator:  { played: true,  status: 'complete',    submitted_at: '2026-07-28T00:05:00Z', score: 41, is_you: true },
          opponent: { played: true,  status: 'in_progress', submitted_at: null,                   score: 88, is_you: false },
        }))})`,
      };
      // The local result record is the only place this client's own score can
      // come from on a reload — get_duel_by_key withholds it until reveal.
      const storage = {};
      storage['zt_duel_result_' + KEY] = JSON.stringify({
        side: 'creator', duration: 120, score: 41, answered: 44, accuracy: 0.93,
        points: Array.from({ length: 41 }, (_, i) => (i + 1) * 2.6),
      });
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc, storage });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const body = (await page.textContent('body')) || '';
      ok(body.includes('Waiting for your opponent'), 'the page says it is waiting for them');
      ok(body.includes('41'), "the viewer's OWN score is shown");
      ok(!body.includes('88'), "the opponent's score (88) appears NOWHERE in the DOM text");
      ok(!/\b88\b/.test(await page.innerHTML('body')),
         "the opponent's score is not hidden in markup either");
      ok(body.includes('hidden'), 'their side is labelled hidden rather than shown as a dash or a zero');
      ok(await page.isVisible('#duel-share-text'), 'the share link is offered again while waiting');
      ok(!(await page.isVisible('#duel-graph-panel')),
         'no pace graph before both scores are revealed');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-4-waiting-${tag}.png` });
      await ctx.close();
    }

    // ── State 5. Both done — the verdict and the pace graph ──
    // Both sides' per-answer times are on the payload, which is what the
    // server sends once (and only once) scores_revealed is true. Both lines
    // must therefore be real, measured curves.
    {
      console.log('[5 decided — verdict + pace graph]');
      const rpc = {
        get_duel_by_key: `() => (${src(duelPayload({
          your_side: 'creator',
          status: 'complete',
          scores_revealed: true,
          outcome: { type: 'decided', winner: 'creator' },
          creator:  { played: true, status: 'complete', submitted_at: '2026-07-28T00:05:00Z', score: 74, is_you: true,  points: PACE_YOU },
          opponent: { played: true, status: 'complete', submitted_at: '2026-07-28T02:05:00Z', score: 61, is_you: false, points: PACE_THEM },
        }))})`,
      };
      // Deliberately a DIFFERENT timeline for the same run: the server's
      // points must win over this, and (60, 50) below is what proves it.
      const storage = {};
      storage['zt_duel_result_' + KEY] = JSON.stringify({
        side: 'creator', duration: 120, score: 74, answered: 78, accuracy: 0.95,
        points: LOCAL_EVEN_74,
      });
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc, storage });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      const body = (await page.textContent('body')) || '';
      ok(body.includes('You won'), 'the verdict names the winner from outcome.winner');
      ok(body.includes('74') && body.includes('61'), 'both scores are shown once revealed');
      ok(await page.isVisible('#duel-graph-panel'), 'the pace graph panel is shown');

      const cfg = await page.evaluate(() => {
        const c = window.__charts[window.__charts.length - 1];
        if (!c) return null;
        const [you, them] = c.data.datasets;
        const at = (d, x) => d.data.filter(p => p.x === x).map(p => p.y);
        return {
          labels: c.data.datasets.map(d => d.label),
          youLen:  you.data.length,
          themLen: them.data.length,
          youYs:  [...new Set(you.data.map(p => p.y))].length,
          themYs: [...new Set(them.data.map(p => p.y))].length,
          youXs:  you.data.map(p => p.x).join(','),
          themXs: them.data.map(p => p.x).join(','),
          youAt60:   at(you, 60),
          themAt36:  at(them, 36),
          fill:      you.fill,
          themFill:  them.fill,
          youDash:   you.borderDash,
          themDash:  them.borderDash,
          lastYou:   you.data[you.data.length - 1],
          lastThem:  them.data[them.data.length - 1],
          xMax: c.options.scales.x.max,
          yMax: c.options.scales.y.max,
          yMin: c.options.scales.y.min,
        };
      });
      ok(cfg && cfg.labels.length === 2, 'the chart has exactly two series');
      ok(cfg && cfg.youLen >= 3 && cfg.themLen >= 3,
         `both series are real curves (${cfg && cfg.youLen} / ${cfg && cfg.themLen} points)`);
      ok(cfg && cfg.themYs > 1,
         `the opponent's series is NOT their final score held flat (${cfg && cfg.themYs} distinct y values)`);
      ok(cfg && cfg.youYs > 1, "the viewer's series is not flat either");
      ok(cfg && cfg.themXs !== cfg.youXs,
         "the opponent's series is not the viewer's x values wearing their score");
      // The one exact value each curve can only have if it was plotted from
      // that side's OWN times: 25 banked at 60s projects to 50, 30 banked at
      // 36s projects to 100.
      ok(cfg && cfg.youAt60.length === 1 && cfg.youAt60[0] === 50,
         `the viewer's curve passes through (60, 50) from the SERVER's times (got ${cfg && JSON.stringify(cfg.youAt60)})`);
      ok(cfg && cfg.themAt36.length === 1 && cfg.themAt36[0] === 100,
         `the opponent's curve passes through (36, 100) (got ${cfg && JSON.stringify(cfg.themAt36)})`);
      ok(cfg && cfg.lastYou && cfg.lastYou.x === 120 && cfg.lastYou.y === 74,
         "the viewer's curve lands on their final score at the end of the run");
      ok(cfg && cfg.lastThem && cfg.lastThem.x === 120 && cfg.lastThem.y === 61,
         "the opponent's curve lands on THEIR final score, not the viewer's");
      ok(cfg && Array.isArray(cfg.themDash) && cfg.themDash.length === 0,
         'a measured opponent curve is drawn solid, not dashed');
      ok(cfg && Array.isArray(cfg.youDash) && cfg.youDash.length === 0,
         "and so is the viewer's — dashed means stand-in, on either line");
      ok(cfg && cfg.fill && cfg.fill.target === 1 && cfg.fill.above && cfg.fill.below
         && cfg.fill.above !== cfg.fill.below,
         'the area between the lines is filled and tinted differently above vs below');
      ok(cfg && cfg.themFill === false, 'only one dataset fills, so the gap is tinted once');
      ok(cfg && cfg.xMax === 120, 'the x-axis spans the duel duration');
      ok(cfg && cfg.yMax >= 100 && cfg.yMin <= 50,
         `the y-axis covers BOTH series, incl. the opponent's early 100 (got ${cfg && cfg.yMin}..${cfg && cfg.yMax})`);
      ok(/Both lines are projected score/.test(body),
         'the caption says both lines are real projections');
      ok(/Only the times are shared, never the answers/.test(body),
         'and states what was and was not shared to draw them');
      ok(!/held flat/.test(body), 'and does NOT still claim their line is a flat final score');
      ok((await page.textContent('#duel-graph-note')) === 'Projected score over the run',
         'the graph note names what is plotted');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-5-decided-${tag}.png` });

      // The chart must be rebuilt, not left with stale colours, on a theme flip.
      const before = await page.evaluate(() => window.__charts.length);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('zt-theme-change')));
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => window.__charts.length);
      ok(after === before + 1, 'the chart is destroyed and rebuilt on zt-theme-change');
      await ctx.close();
    }

    // ── State 6. Walkover — not a win ────────────────────────
    {
      console.log('[6 walkover]');
      const rpc = {
        get_duel_by_key: `() => (${src(duelPayload({
          your_side: 'creator',
          status: 'expired',
          expired: true,
          seconds_until_expiry: 0,
          scores_revealed: true,
          outcome: { type: 'walkover', winner: 'creator' },
          creator:  { played: true,  status: 'complete', submitted_at: '2026-07-28T00:05:00Z', score: 74, is_you: true },
          opponent: { played: false, status: null,       submitted_at: null,                   score: null, is_you: false },
        }))})`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const body = (await page.textContent('body')) || '';
      ok(body.includes('Walkover — they never played'), 'a walkover is named as a walkover');
      ok(/That is a walkover, not a win/.test(body),
         'and is explicitly distinguished from a real win');
      ok(!/\bYou won\b/.test(body), 'the page does NOT claim a win');
      ok(body.includes('This duel has expired'), 'expiry is stated');
      ok(!(await page.isVisible('#duel-graph-panel')),
         'no pace graph when there is no opponent score to plot against');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-6-walkover-${tag}.png` });
      await ctx.close();
    }

    // ── State 6b. Nobody played ─────────────────────────────
    {
      console.log('[6b unplayed]');
      const rpc = {
        get_duel_by_key: `() => (${src(duelPayload({
          your_side: 'creator', status: 'expired', expired: true, seconds_until_expiry: 0,
          scores_revealed: true, outcome: { type: 'unplayed', winner: null },
        }))})`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const body = (await page.textContent('body')) || '';
      ok(body.includes('Nobody played this duel'), 'an unplayed duel says nobody played');
      ok(/There was no contest to decide/.test(body), 'and is not presented as a tie');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-6b-unplayed-${tag}.png` });
      await ctx.close();
    }

    // ── State 6c. Expired with the second side never claimed ─
    // The viewer holds the link but never took a side, so neither "you never
    // played" nor "they never played" is true of them.
    {
      console.log('[6c walkover seen by a non-player]');
      const rpc = {
        get_duel_by_key: `() => (${src(duelPayload({
          your_side: 'open', opponent_claimed: false, status: 'expired', expired: true,
          seconds_until_expiry: 0, scores_revealed: true,
          outcome: { type: 'walkover', winner: 'creator' },
          creator:  { played: true,  status: 'complete', submitted_at: '2026-07-28T00:05:00Z', score: 74, is_you: false },
          opponent: { played: false, status: null,       submitted_at: null,                   score: null, is_you: false },
        }))})`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: null, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const body = (await page.textContent('body')) || '';
      ok(body.includes('Walkover — only one side played'),
         'a non-player is not told "you never played"');
      ok(!/you never played|they never played/.test(body), 'and neither of the two-player wordings appears');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── State 7. Third arrival ──────────────────────────────
    {
      console.log('[7 third arrival]');
      const rpc = {
        get_duel_by_key: `() => (${src(duelPayload({ your_side: 'spectator', opponent_claimed: true }))})`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: null, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const body = (await page.textContent('body')) || '';
      ok(body.includes('This duel already has two players'),
         'the third arrival is told the duel is full');
      ok(body.includes('Start your own duel'), 'and is offered a duel of their own');
      const href = await page.getAttribute('.duel-notice-actions a.btn', 'href');
      ok(href === 'duel.html', `that link points at the create page (got "${href}")`);
      ok(!(await page.isVisible('#duel-start-btn')), 'no Start button is offered');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-7-full-${tag}.png` });
      await ctx.close();
    }

    // ── State 8a. Unknown key (RPC returns SQL NULL) ─────────
    {
      console.log('[8a unknown key]');
      const rpc = { get_duel_by_key: `() => null` };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=nope`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const body = (await page.textContent('body')) || '';
      ok(body.includes("There's no duel with that link"), 'an unknown key gets its own page');
      ok(!/unavailable|couldn't reach/i.test(body),
         'and is NOT confused with an infrastructure failure');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-8a-notfound-${tag}.png` });
      await ctx.close();
    }

    // ── State 8b. Migration not applied ─────────────────────
    {
      console.log('[8b RPCs missing]');
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc: {} });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const body = (await page.textContent('body')) || '';
      ok(body.includes("Duels aren't available right now"),
         'a missing migration produces a readable page, not a blank one');
      ok(!/PGRST202|does not exist|schema cache/i.test(body),
         'the raw database error is not shown to the user');
      ok(!/undefined|NaN|\[object Object\]/.test(body), 'no raw objects leaked into the copy');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/duel-8b-nomigration-${tag}.png` });
      await ctx.close();
    }
  }

  // ══════ Theme-independent checks ══════
  console.log('\n══════ contract checks ══════');

  // A hostile duel key from the URL must render as literal text.
  {
    console.log('[hostile key from the URL]');
    const XSS = `<img src=x onerror="window.__pwned=1">`;
    const rpc = { get_duel_by_key: `() => (${src(duelPayload({ duel_key: XSS, your_side: 'spectator' }))})` };
    const { ctx, page, errors } = await newPage(browser, { session: null, rpc });
    await page.goto(`${BASE}/duel.html?d=${encodeURIComponent(XSS)}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const pwned = await page.evaluate(() => window.__pwned === 1);
    const imgs  = await page.evaluate(() => document.querySelectorAll('.duel-wrap img').length);
    const body  = (await page.textContent('body')) || '';
    ok(!pwned, 'hostile key did NOT execute');
    ok(imgs === 0, 'hostile key produced no live element in the DOM');
    ok(body.includes(XSS), 'hostile key is rendered as literal text');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // The clean /d/<key> URL: a Vercel rewrite is server-side, so location.search
  // is EMPTY and only the pathname carries the key. Simulated by serving
  // duel.html's bytes at /d/<key> and asserting the page resolved the duel
  // rather than falling through to "create a duel".
  {
    console.log('[clean /d/<key> URL]');
    const rpc = { get_duel_by_key: `() => (${src(duelPayload({ your_side: 'spectator' }))})` };
    const { ctx, page, errors } = await newPage(browser, { session: null, rpc });
    // Stand in for the Vercel rewrite: /d/<key> serves duel.html's bytes. Its
    // own relative assets then resolve under /d/, so those are mapped back to
    // the root — exactly what a real server does and what the browser cannot
    // see, which is the whole reason location.search is empty here.
    await page.route(`${BASE}/d/**`, async r => {
      const path = new URL(r.request().url()).pathname;
      const target = /^\/d\/[^/]+$/.test(path) ? '/duel.html' : path.replace(/^\/d\//, '/');
      const res = await page.request.get(BASE + target);
      r.fulfill({
        status: res.status(),
        contentType: res.headers()['content-type'] || 'text/plain',
        body: await res.text(),
      });
    });
    await page.goto(`${BASE}/d/${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const search = await page.evaluate(() => window.location.search);
    ok(search === '', 'location.search really is empty on the clean URL');
    const call = await page.evaluate(() => (window.__rpcCalls || []).find(c => c[0] === 'get_duel_by_key'));
    ok(call && call[1].p_key === KEY, `the key was read from the PATHNAME (got ${call ? call[1].p_key : 'no call'})`);
    ok((await page.textContent('body')).includes('This duel already has two players'),
       'and the resolved state rendered, not the create page');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // Start → play → submit, end to end: the guest token is sent, the server's
  // score is what gets shown, and the local result record is written so the
  // waiting page has a number after a reload.
  {
    console.log('[full run: start → answer → submit]');
    const qs = src(makeQuestions(50));
    const rpc = {
      get_duel_by_key: `() => (${src(duelPayload({ your_side: 'open', opponent_claimed: false }))})`,
      start_duel_run: `() => ({ duel_key: ${src(KEY)}, side: 'opponent', duration_seconds: 120,
        started_at: '2026-07-28T00:01:00Z', seconds_remaining: 120, status: 'in_progress',
        questions: ${qs}, duel: ${src(duelPayload({ your_side: 'opponent' }))} })`,
      // The server's number is 3, deliberately NOT the two the client banked:
      // the page must show the server's score and never its own count.
      submit_duel_run: `() => ({ side: 'opponent', score: 3, total_answered: 2, accuracy: 1,
        duel: ${src(duelPayload({
          your_side: 'opponent', scores_revealed: false,
          creator:  { played: false, status: null, submitted_at: null, score: null, is_you: false },
          opponent: { played: true, status: 'complete', submitted_at: '2026-07-28T00:02:00Z', score: null, is_you: true },
        }))} })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: null, rpc });
    await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.click('#duel-start-btn');
    await page.waitForTimeout(500);

    ok(await page.isVisible('#duel-game'), 'the run started');
    const startCall = await page.evaluate(() => window.__rpcCalls.find(c => c[0] === 'start_duel_run'));
    const token = await page.evaluate(k => localStorage.getItem('duel_guest_' + k), KEY);
    ok(startCall && startCall[1].p_guest_token === token && token.length >= 8,
       'start_duel_run carried the persisted guest token');

    // 2 + 3 = 5, then 3 + 4 = 7.
    await page.fill('#duel-input', '5');
    await page.waitForTimeout(120);
    await page.fill('#duel-input', '7');
    await page.waitForTimeout(200);
    ok((await page.textContent('#duel-answered')).includes('Answered: 2'), 'answers advance the HUD');

    const draft = await page.evaluate(k => JSON.parse(localStorage.getItem('zt_duel_draft_' + k)), KEY);
    ok(draft && draft.answers.length === 2 && draft.answers[0].value === 5,
       'a draft is written so a refresh mid-run keeps the answers');
    ok(draft && draft.answers[0].elapsed_ms <= draft.answers[1].elapsed_ms,
       'draft elapsed_ms is non-decreasing, as submit_duel_run requires');

    // Run the clock out.
    await page.evaluate(() => { duelDeadline = performance.now() - 1; tickDuelTimer(); });
    await page.waitForTimeout(700);

    const submitCall = await page.evaluate(() => window.__rpcCalls.find(c => c[0] === 'submit_duel_run'));
    ok(submitCall && Array.isArray(submitCall[1].p_answers) && submitCall[1].p_answers.length === 2,
       'the answers were submitted');
    ok(submitCall && submitCall[1].p_answers.every(a =>
        typeof a.i === 'number' && typeof a.value === 'number' && typeof a.elapsed_ms === 'number'),
       'each answer has the {i, value, elapsed_ms} shape the RPC validates');
    ok(submitCall && !('score' in submitCall[1]), 'no client-computed score is sent');

    const body = (await page.textContent('body')) || '';
    ok(body.includes('Waiting for your opponent'), 'submitting lands on the waiting state');
    ok(body.includes('3'), "the SERVER's score (3) is shown, not the client's count of 2");

    const rec = await page.evaluate(k => JSON.parse(localStorage.getItem('zt_duel_result_' + k)), KEY);
    ok(rec && rec.score === 3, 'the local result record stores the server score');
    ok(rec && rec.points.length === 2, 'and the pace timeline for the two correct answers');
    ok(await page.isVisible('#duel-game') === false, 'the run overlay is gone');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // A refusal raised by the database arrives as `error`, not as a thrown JS
  // exception. Pressing Start on a duel that filled up in the meantime must
  // land on the "two players" page, not a stack trace or a blank screen.
  {
    console.log('[raised refusal on Start]');
    const rpc = {
      // First read says the side is free; after the failed Start it says full.
      get_duel_by_key: `() => { window.__n = (window.__n || 0) + 1;
        return window.__n === 1
          ? (${src(duelPayload({ your_side: 'open', opponent_claimed: false }))})
          : (${src(duelPayload({ your_side: 'spectator', opponent_claimed: true }))}); }`,
      start_duel_run: `() => ({ __error: { message: 'duel_already_has_opponent',
        code: '23505', hint: 'This duel already has two players.' } })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: null, rpc });
    await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.click('#duel-start-btn');
    await page.waitForTimeout(600);
    const body = (await page.textContent('body')) || '';
    ok(body.includes('This duel already has two players'),
       'a raised refusal becomes the right page, not an exception');
    ok(!/duel_already_has_opponent/.test(body), 'the raw error code is not shown to the user');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // The pace graph must degrade honestly when this browser has no timeline for
  // its own run — a decided duel opened on a second device.
  {
    console.log('[pace graph without a local timeline]');
    const rpc = {
      get_duel_by_key: `() => (${src(duelPayload({
        your_side: 'creator', status: 'complete', scores_revealed: true,
        outcome: { type: 'decided', winner: 'opponent' },
        creator:  { played: true, status: 'complete', submitted_at: '2026-07-28T00:05:00Z', score: 55, is_you: true },
        opponent: { played: true, status: 'complete', submitted_at: '2026-07-28T02:05:00Z', score: 69, is_you: false },
      }))})`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const body = (await page.textContent('body')) || '';
    ok(body.includes('You lost'), 'the verdict is right from the loser\'s side');
    ok(await page.isVisible('#duel-graph-panel'), 'a chart is still shown');
    ok((await page.textContent('#duel-graph-note')) === 'Final scores only',
       'it is labelled "Final scores only"');
    ok(/nothing interpolated between them/.test(body),
       'and the caption says no curve was invented');
    const cfg = await page.evaluate(() => {
      const c = window.__charts[window.__charts.length - 1];
      return { you: c.data.datasets[0].data, them: c.data.datasets[1].data,
               youDash: c.data.datasets[0].borderDash, themDash: c.data.datasets[1].borderDash };
    });
    ok(cfg.you.length === 2 && cfg.you.every(p => p.y === 55), 'the viewer line is their flat final score');
    ok(cfg.them.length === 2 && cfg.them.every(p => p.y === 69), 'the opponent line is theirs');
    ok(Array.isArray(cfg.youDash) && cfg.youDash.length === 2
       && Array.isArray(cfg.themDash) && cfg.themDash.length === 2,
       'BOTH lines are dashed, because neither of them was measured');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // The same second device, but the DATABASE has both timelines. Opening a
  // finished duel somewhere that never played it must still draw two real
  // curves — the local record is a fallback, not the source.
  {
    console.log('[pace graph from the server with no local record]');
    const rpc = {
      get_duel_by_key: `() => (${src(duelPayload({
        your_side: 'creator', status: 'complete', scores_revealed: true,
        outcome: { type: 'decided', winner: 'creator' },
        creator:  { played: true, status: 'complete', submitted_at: '2026-07-28T00:05:00Z', score: 74, is_you: true,  points: PACE_YOU },
        opponent: { played: true, status: 'complete', submitted_at: '2026-07-28T02:05:00Z', score: 61, is_you: false, points: PACE_THEM },
      }))})`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const body = (await page.textContent('body')) || '';
    const rec = await page.evaluate(k => localStorage.getItem('zt_duel_result_' + k), KEY);
    ok(rec === null, 'this browser really has no local record of the run');
    const cfg = await page.evaluate(() => {
      const c = window.__charts[window.__charts.length - 1];
      const [you, them] = c.data.datasets;
      const at = (d, x) => d.data.filter(p => p.x === x).map(p => p.y);
      return {
        youLen: you.data.length, themLen: them.data.length,
        youAt60: at(you, 60), themAt36: at(them, 36),
        lastYou: you.data[you.data.length - 1],
        lastThem: them.data[them.data.length - 1],
        youDash: you.borderDash, themDash: them.borderDash,
      };
    });
    ok(cfg.youLen >= 3 && cfg.themLen >= 3,
       `both lines are curves without any localStorage (${cfg.youLen} / ${cfg.themLen} points)`);
    ok(cfg.youAt60.length === 1 && cfg.youAt60[0] === 50,
       "the viewer's line is the server's timeline for their own side");
    ok(cfg.themAt36.length === 1 && cfg.themAt36[0] === 100, "and the opponent's is theirs");
    ok(cfg.lastYou.x === 120 && cfg.lastYou.y === 74 && cfg.lastThem.x === 120 && cfg.lastThem.y === 61,
       'each line still lands on its own final score');
    ok(Array.isArray(cfg.youDash) && cfg.youDash.length === 0
       && Array.isArray(cfg.themDash) && cfg.themDash.length === 0,
       'both lines are solid, because both were measured');
    ok((await page.textContent('#duel-graph-note')) === 'Projected score over the run',
       'it is not labelled "Final scores only"');
    ok(/Both lines are projected score/.test(body), 'the caption reflects two real curves');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // Only THEIR timeline survived: duel_pace_points returns [] for a run whose
  // stored answers do not pass its validity filter, so one side can have real
  // points and the other none. Half a real chart must not be described as
  // "the two final scores, nothing interpolated between them" — the caption is
  // the one thing on this panel that says what was measured and what was not.
  {
    console.log('[pace graph with only THEIR timeline]');
    const rpc = {
      get_duel_by_key: `() => (${src(duelPayload({
        your_side: 'creator', status: 'complete', scores_revealed: true,
        outcome: { type: 'decided', winner: 'creator' },
        creator:  { played: true, status: 'complete', submitted_at: '2026-07-28T00:05:00Z', score: 74, is_you: true,  points: [] },
        opponent: { played: true, status: 'complete', submitted_at: '2026-07-28T02:05:00Z', score: 61, is_you: false, points: PACE_THEM },
      }))})`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const body = (await page.textContent('body')) || '';
    const cfg = await page.evaluate(() => {
      const c = window.__charts[window.__charts.length - 1];
      const [you, them] = c.data.datasets;
      return {
        you: you.data, youDash: you.borderDash,
        themLen: them.data.length, themDash: them.borderDash,
        themAt36: them.data.filter(p => p.x === 36).map(p => p.y),
        lastThem: them.data[them.data.length - 1],
      };
    });
    ok(cfg.themLen >= 3 && cfg.themAt36.length === 1 && cfg.themAt36[0] === 100,
       `the opponent's line is their real curve (${cfg.themLen} points, through (36, 100))`);
    ok(Array.isArray(cfg.themDash) && cfg.themDash.length === 0,
       'and is solid, because it was measured');
    ok(cfg.lastThem.x === 120 && cfg.lastThem.y === 61, 'and lands on their final score');
    ok(cfg.you.length === 2 && cfg.you.every(p => p.y === 74),
       "the viewer's line is their final score held flat, on two points only");
    ok(Array.isArray(cfg.youDash) && cfg.youDash.length === 2,
       'and IS dashed, so the stand-in line is marked as one');
    ok((await page.textContent('#duel-graph-note')) === 'Projected score over the run',
       'the note is NOT "Final scores only" when one line is a real curve');
    ok(/Their line is projected score/.test(body),
       'the caption says whose line is the real one');
    ok(/Your own per-answer times are not available for this run, so your line is the score you finished on, held flat/
       .test(body.replace(/\s+/g, ' ')),
       'and says plainly that the viewer\'s own line is the stand-in');
    ok(!/nothing interpolated between them/.test(body),
       'and does NOT claim nothing was interpolated, which would be false of their line');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // A database without the pace migration: no `points` on either side, but
  // this browser played the run and kept its own timeline. The pre-migration
  // behaviour has to survive intact — the client is written to work on both
  // sides of a migration.
  {
    console.log('[pace graph with no server points — local timeline only]');
    const rpc = {
      get_duel_by_key: `() => (${src(duelPayload({
        your_side: 'creator', status: 'complete', scores_revealed: true,
        outcome: { type: 'decided', winner: 'creator' },
        creator:  { played: true, status: 'complete', submitted_at: '2026-07-28T00:05:00Z', score: 74, is_you: true },
        opponent: { played: true, status: 'complete', submitted_at: '2026-07-28T02:05:00Z', score: 61, is_you: false },
      }))})`,
    };
    const storage = {};
    storage['zt_duel_result_' + KEY] = JSON.stringify({
      side: 'creator', duration: 120, score: 74, answered: 78, accuracy: 0.95,
      points: PACE_YOU,
    });
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc, storage });
    await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const body = (await page.textContent('body')) || '';
    const cfg = await page.evaluate(() => {
      const c = window.__charts[window.__charts.length - 1];
      const [you, them] = c.data.datasets;
      return {
        youLen: you.data.length,
        youAt60: you.data.filter(p => p.x === 60).map(p => p.y),
        lastYou: you.data[you.data.length - 1],
        youDash: you.borderDash,
        themYs: [...new Set(them.data.map(p => p.y))],
        themDash: them.borderDash,
      };
    });
    ok(cfg.youLen >= 3, `the viewer's curve is still real, from localStorage (${cfg.youLen} points)`);
    ok(cfg.youAt60.length === 1 && cfg.youAt60[0] === 50, 'and passes through (60, 50)');
    ok(cfg.lastYou.x === 120 && cfg.lastYou.y === 74, 'and lands on their final score');
    ok(cfg.themYs.length === 1 && cfg.themYs[0] === 61,
       'the opponent line falls back to their final score held flat (61)');
    ok(Array.isArray(cfg.themDash) && cfg.themDash.length === 2,
       'and is dashed, so the styling itself says it was not measured');
    ok(Array.isArray(cfg.youDash) && cfg.youDash.length === 0,
       "while the viewer's measured line stays solid");
    ok((await page.textContent('#duel-graph-note')) === 'Projected score over the run',
       'the note still names the viewer\'s projection');
    ok(/their line is the score they finished on, held flat/.test(body),
       'the old caption wording is intact when there is nothing better to say');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
