import { chromium } from 'playwright';
// The public profile page — profile.html?u=<username>.
//
// Two things this suite exists to hold still:
//
//   1. It must look like the dashboard. Same five tiles in the same order,
//      same panels in the same order, rendered by the same js/stats.js.
//   2. It must NOT grow the dashboard's Recent Games list. get_public_profile
//      returns a fixed, minimal projection with no per-session rows in it, and
//      publishing per-game history on a public URL is a cross-user data
//      exposure. That absence is asserted positively below, including that the
//      page never reads game_sessions at all.
const EXE = process.env.ZT_CHROMIUM || undefined;
const BASE = process.env.ZT_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.ZT_SHOTS || '/tmp/shots';
let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log('  pass:', l)) : (fail++, console.log('  FAIL:', l)); };

// The same payload dashboard.mjs uses, so a divergence between the two pages
// shows up as one of them rendering a different number from the same input.
const PUBLIC_PROFILE = {
  username: 'hexadecimal',
  member_since: '2026-01-15T00:00:00Z',
  is_public: true,
  is_owner: false,
  total_games: 1234,
  total_questions: 45678,
  accuracy: 0.962,
  days_practiced: 87,
  streak: 12,
  bests: { '60': 41, '120': 84, '300': 190 },
  ops: {
    addition:       { avg_ms: 1420, count: 9000, accuracy: 0.98 },
    subtraction:    { avg_ms: 1660, count: 5000, accuracy: 0.95 },
    multiplication: { avg_ms: 1980, count: 4000, accuracy: 0.93 },
    division:       { avg_ms: 2310, count: 3000, accuracy: 0.90 },
  },
  history: [
    { d: '2026-07-20', score: 70, duration: 120 },
    { d: '2026-07-21', score: 75, duration: 120 },
    { d: '2026-07-22', score: 80, duration: 120 },
  ],
};

const PERCENTILE = { score: 84, duration: 120, percentile: 0.784, players: 412 };

const SUPA = (o) => `(function(){
const PUBLIC=${JSON.stringify(o.publicProfile ?? null)};
const PCT=${JSON.stringify(o.percentile ?? null)};
const SIGNED_IN=${o.signedIn ? 'true' : 'false'};
window.__rpc=[]; window.__tables=[];
window.__charts={made:0,destroyed:0};
window.supabase={createClient:()=>({
 auth:{getSession:async()=>({data:{session:SIGNED_IN?{user:{id:'u1',email:'a@b.c'}}:null},error:null}),
       getUser:async()=>({data:{user:SIGNED_IN?{id:'u1',email:'a@b.c'}:null}}),
       onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},
 from:(t)=>{ window.__tables.push(t);
   return {select(){return this},eq(){return this},is(){return this},order(){return this},limit(){return this},
     single:async()=>({data:null,error:{message:'x'}}),maybeSingle:async()=>({data:null,error:null}),
     insert:async()=>({error:null}),update:async()=>({error:null}),upsert:async()=>({error:null}),
     then(r){r({data:[],error:null,count:0});return Promise.resolve({data:[],error:null,count:0});}}; },
 rpc:async(n,args)=>{ window.__rpc.push([n,args]);
   if(n==='get_public_profile') return PUBLIC?{data:PUBLIC,error:null}:{data:null,error:null};
   if(n==='get_score_percentile') return PCT?{data:PCT,error:null}:{data:null,error:{message:'no fn'}};
   return {data:null,error:{message:'no fn'}}; },
})};
window.Chart=function(){window.__charts.made++;
  this.destroy=()=>{window.__charts.destroyed++;};this.update=()=>{};
  this.data={labels:[],datasets:[{},{}]};this.options={scales:{x:{ticks:{}}}};};
window.Chart.defaults={font:{}};
})();`;

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});

async function page(o = {}) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/cdn.jsdelivr.net/**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: SUPA(o) }));
  await p.addInitScript(t => localStorage.setItem('zt_theme', t), o.theme || 'dark');
  const u = o.u === undefined ? 'hexadecimal' : o.u;
  const url = u === null ? BASE + '/profile.html' : BASE + '/profile.html?u=' + encodeURIComponent(u);
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  return { ctx, p, errs };
}

const TILES = () => Array.from(document.querySelectorAll('#stat-strip .stat-card'))
  .map(c => [c.querySelector('.stat-value').textContent.trim(),
             c.querySelector('.stat-label').textContent.trim()]);

const ORDERED = (ids) => {
  const els = ids.map(i => document.getElementById(i));
  if (els.some(e => !e)) return false;
  return els.every((e, i) => i === 0 ||
    (els[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
};

// ── The strip ─────────────────────────────────────────────────
console.log('[the five tiles are the dashboard’s five, with the payload’s values]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  const tiles = await p.evaluate(TILES);
  ok(tiles.length === 5, `exactly five tiles (got ${tiles.length})`);
  ok(JSON.stringify(tiles.map(t => t[1])) ===
     JSON.stringify(['Total Games', 'Questions', 'Accuracy', 'Days Practiced', 'Day Streak']),
     'the same labels, in the same order, as the dashboard');
  ok(tiles[0][0] === '1,234',  `Total Games is 1,234 (got ${tiles[0][0]})`);
  ok(tiles[1][0] === '45,678', `Questions is 45,678 (got ${tiles[1][0]})`);
  ok(tiles[2][0] === '96.2%',  `Accuracy is 96.2% (got ${tiles[2][0]})`);
  ok(tiles[3][0] === '87',     `Days Practiced is 87 (got ${tiles[3][0]})`);
  ok(tiles[4][0] === '12',     `Day Streak is 12 (got ${tiles[4][0]})`);
  ok(await p.evaluate(() =>
       Array.from(document.querySelectorAll('#best-row .best-card'))
         .map(c => c.textContent.replace(/\s+/g, ' ').trim()).join('|') === '41 60s|84 120s|190 300s'),
     'the best cards match the dashboard’s, one per duration');
  ok((await p.textContent('#bests-note')).trim() === 'Avg last 3 · 75',
     'the bests panel head carries the rolling average, as on the dashboard');
  ok((await p.textContent('#percentile-line')).includes('78%'),
     'the percentile line survives the rearrangement');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── Order ─────────────────────────────────────────────────────
console.log('[panel order matches the dashboard, minus Recent Games]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  ok(await p.evaluate(ORDERED, ['stat-strip', 'chart-panel', 'ops-panel']),
     'stats → Score Over Time → By Operation, in document order');
  ok(await p.evaluate(ORDERED, ['stat-strip', 'bests-panel', 'chart-panel']),
     'and the bests panel sits between the strip and the chart');
  // Negative control: the same helper must refuse an order that is wrong,
  // or the two assertions above prove only that four elements exist.
  ok(!(await p.evaluate(ORDERED, ['ops-panel', 'chart-panel'])),
     'the order check has teeth — the reverse order is refused');
  const rows = await p.evaluate(() =>
    Array.from(document.querySelectorAll('#op-bars .op-bar-row')).map(r => [
      r.querySelector('.op-bar-name').textContent.trim(),
      r.querySelector('.op-bar-value').textContent.trim(),
    ]));
  ok(rows.length === 4, `four operation bars (got ${rows.length})`);
  ok(rows[0][0] === 'addition' && rows[0][1] === '1.42s',
     `addition averages 1.42s (got ${rows[0] && rows[0][1]})`);
  ok(rows[3][0] === 'division' && rows[3][1] === '2.31s',
     `division averages 2.31s (got ${rows[3] && rows[3][1]})`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── No per-game history, asserted positively ──────────────────
console.log('[the public page carries no per-game history]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  ok(await p.evaluate(() => document.getElementById('games-panel') === null),
     'no #games-panel element exists');
  ok(await p.evaluate(() => document.querySelectorAll('.games-table, #games-tbody, .view-session-link').length === 0),
     'no games table, no table body, no per-session links');
  const body = (await p.textContent('body')) || '';
  ok(!/Recent Games/i.test(body), 'the words "Recent Games" appear nowhere');
  ok(!/results\.html/.test(await p.content()), 'and nothing links to a single run');
  ok(await p.evaluate(() => !window.__tables.includes('game_sessions')),
     'the page never reads game_sessions — every figure came through the RPC');
  ok(await p.evaluate(() => window.__rpc.every(c =>
       c[0] === 'get_public_profile' || c[0] === 'get_score_percentile')),
     'and it called nothing but the two functions the contract names');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── The share image is gone ───────────────────────────────────
console.log('[the Share Image button is gone from the DOM, not hidden]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  ok(await p.evaluate(() => document.getElementById('share-card-btn') === null),
     'no #share-card-btn element exists');
  ok(await p.evaluate(() => document.getElementById('share-card-actions') === null),
     'no #share-card-actions element exists');
  ok(await p.evaluate(() => document.getElementById('share-card-status') === null),
     'and no status line for it');
  ok(!/Share Image/i.test((await p.textContent('body')) || ''),
     'the words "Share Image" appear nowhere');
  ok(!/sharecard\.js/.test(await p.content()), 'js/sharecard.js is no longer loaded here');
  ok(await p.evaluate(() => document.getElementById('totals-row') === null),
     'the old bottom totals row is gone — its five figures are the strip now');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── A hostile username ────────────────────────────────────────
console.log('[a hostile username does not execute and does not become an element]');
{
  const XSS = '<img src=x onerror="window.__pwned=1">';
  const { ctx, p, errs } = await page({
    u: XSS,
    publicProfile: { ...PUBLIC_PROFILE, username: XSS },
    percentile: PERCENTILE,
  });
  ok(await p.evaluate(() => window.__pwned !== 1), 'nothing executed');
  ok(await p.evaluate(() => document.querySelectorAll('.profile-wrap img').length === 0),
     'it did not become an element');
  ok((await p.textContent('#profile-name')) === XSS, 'it is rendered as literal text');
  ok(await p.evaluate(() => document.title.includes('<img')),
     'and the title carries it as text too');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── Theme ─────────────────────────────────────────────────────
console.log('[the chart is destroyed and rebuilt on zt-theme-change]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  const before = await p.evaluate(() => ({ ...window.__charts }));
  ok(before.made === 1 && before.destroyed === 0, 'one chart on load');
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('zt-theme-change', { detail: { theme: 'zetamac' } })));
  await p.waitForTimeout(200);
  const after = await p.evaluate(() => ({ ...window.__charts }));
  ok(after.destroyed === 1, `the old chart was destroyed (got ${after.destroyed})`);
  ok(after.made === 2, `and a new one built (got ${after.made})`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[both themes render without an uncaught error]');
for (const theme of ['zetamac', 'dark']) {
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE, theme });
  ok(await p.isVisible('#stat-strip'), `${theme}: the strip is visible`);
  ok(errs.length === 0, `${theme}: no uncaught errors (${errs[0] ?? ''})`);
  await p.screenshot({ path: `${SHOTS}/profile-${theme}.png`, fullPage: true });
  await ctx.close();
}

// ── The states either side of a record ────────────────────────
console.log('[an account with no games shows the empty state, not a strip of zeros]');
{
  const empty = { ...PUBLIC_PROFILE, total_games: 0, total_questions: 0, accuracy: null,
                  days_practiced: 0, streak: 0, bests: {}, ops: {}, history: [] };
  const { ctx, p, errs } = await page({ publicProfile: empty });
  ok(await p.isVisible('#profile-empty'), 'the empty state is shown');
  ok(!(await p.isVisible('#stat-strip')), 'and the strip stays hidden');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a missing profile still says so]');
{
  const { ctx, p, errs } = await page({ publicProfile: null });
  ok(await p.isVisible('#profile-notice'), 'the notice is shown');
  ok(/private or doesn't exist/i.test(await p.textContent('#profile-notice')),
     'and it does not distinguish private from absent');
  ok(!(await p.isVisible('#stat-strip')), 'no strip');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[no ?u= at all]');
{
  const { ctx, p, errs } = await page({ u: null, publicProfile: PUBLIC_PROFILE });
  ok(await p.isVisible('#profile-notice'), 'the notice is shown');
  ok((await p.textContent('#profile-notice')).includes('Settings'),
     'and it points at Settings, which is where the profile link lives now');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
