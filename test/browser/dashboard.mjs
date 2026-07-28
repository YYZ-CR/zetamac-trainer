import { chromium } from 'playwright';
// Playwright's bundled build and the one on PATH disagree; point ZT_CHROMIUM
// at a specific binary when the default launch fails.
const EXE = process.env.ZT_CHROMIUM || undefined;
const BASE = process.env.ZT_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.ZT_SHOTS || '/tmp/shots';
let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log('  pass:', l)) : (fail++, console.log('  FAIL:', l)); };

// ── Fixtures ──────────────────────────────────────────────────
// Dates are computed against today so the streak assertion means something:
// get_public_profile counts a run that ends today or yesterday, and the
// dashboard's local fallback must apply the same rule.
const dayISO = (back) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
};
const q = (operation, timeMs, hadMistake) => ({ operation, timeMs, hadMistake });

// Three games, three consecutive days ending today. Hand-computable:
//   10 questions, 3 of them fumbled  → 70% of questions clean
//   120s played twice (best 40), 60s once (best 30) → Best tile is 40 at 120s
//   scores 40, 30, 20                → avg last 3 = 30
//   one question with a bogus operation, which must be dropped
const SESSIONS = [
  { session_key: 'k1', created_at: `${dayISO(0)}T10:00:00Z`, score: 40, duration_seconds: 120,
    questions: [q('addition', 1000, false), q('addition', 2000, true),
                q('multiplication', 3000, false), q('bogus', 9999, false)] },
  { session_key: 'k2', created_at: `${dayISO(1)}T10:00:00Z`, score: 30, duration_seconds: 60,
    questions: [q('addition', 3000, false), q('division', 4000, false), q('division', 2000, false)] },
  { session_key: 'k3', created_at: `${dayISO(2)}T10:00:00Z`, score: 20, duration_seconds: 120,
    questions: [q('subtraction', 1000, true), q('subtraction', 1000, true),
                q('multiplication', 5000, false)] },
];

// Deliberately unlike anything derivable from SESSIONS, so a tile showing one
// of these numbers proves the server payload was used and not the fallback.
const PUBLIC_PROFILE = {
  username: 'hexadecimal',
  member_since: '2026-01-15T00:00:00Z',
  is_public: true,
  is_owner: true,
  total_games: 1234,
  total_questions: 45678,
  accuracy: 0.962,
  days_practiced: 87,
  streak: 12,
  // 300s carries the biggest number by a distance and is played least — a
  // Best tile that shows 190 has taken a max across durations, which is the
  // one thing it must never do.
  bests: { '60': 41, '120': 84, '300': 190 },
  ops: {
    addition:       { avg_ms: 1420, count: 9000, accuracy: 0.98 },
    subtraction:    { avg_ms: 1660, count: 5000, accuracy: 0.95 },
    multiplication: { avg_ms: 1980, count: 4000, accuracy: 0.93 },
    division:       { avg_ms: 2310, count: 3000, accuracy: 0.90 },
  },
  // Every recent game is a 120s run, so 120 is the duration played most and
  // the one the Best tile has to name.
  history: [
    { d: '2026-07-20', score: 70, duration: 120 },
    { d: '2026-07-21', score: 75, duration: 120 },
    { d: '2026-07-22', score: 80, duration: 120 },
  ],
};

// ── The stubbed CDN bundle ────────────────────────────────────
const SUPA = (o) => `(function(){
const REC='__ins';
if(!sessionStorage.getItem(REC)) sessionStorage.setItem(REC,'[]');
window.__inserts=()=>JSON.parse(sessionStorage.getItem(REC)||'[]');
const rec=(t,r)=>{const a=JSON.parse(sessionStorage.getItem(REC)||'[]');a.push([t,r]);sessionStorage.setItem(REC,JSON.stringify(a));};
const PROFILE=${JSON.stringify(o.profileRow ?? null)};
const SESSIONS=${JSON.stringify(o.sessions ?? [])};
const PUBLIC=${JSON.stringify(o.publicProfile ?? null)};
const AVAIL=${o.avail === false ? 'false' : 'true'};
window.__rpc=[]; window.__tables=[];
window.__charts={made:0,destroyed:0};
function builder(t){
  return { _t:t, _head:false,
    select(c,opt){ if(opt&&opt.head) this._head=true; return this; },
    eq(){return this}, is(){return this}, order(){return this}, limit(){return this},
    single:async function(){ return this._t==='profiles'
       ? {data:PROFILE, error:PROFILE?null:{message:'no rows'}}
       : {data:null,error:{message:'x'}}; },
    maybeSingle:async()=>({data:null,error:null}),
    insert:async function(row){ rec(this._t,row); return {error:null}; },
    update:async()=>({error:null}), upsert:async()=>({error:null}),
    then(r){ const res = this._t==='game_sessions'
        ? (this._head ? {data:null,error:null,count:SESSIONS.length}
                      : {data:SESSIONS,error:null,count:SESSIONS.length})
        : {data:[],error:null,count:0};
      r(res); return Promise.resolve(res); } };
}
window.supabase={createClient:()=>({
 auth:{getSession:async()=>({data:{session:{user:{id:'u1',email:'a@b.c'}}},error:null}),
       getUser:async()=>({data:{user:{id:'u1',email:'a@b.c'}}}),
       onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},
 from:(t)=>{ window.__tables.push(t); return builder(t); },
 rpc:async(n,args)=>{ window.__rpc.push([n,args]);
   if(n==='username_available') return {data:AVAIL,error:null};
   if(n==='get_public_profile') return PUBLIC?{data:PUBLIC,error:null}:{data:null,error:{message:'no fn'}};
   return {data:null,error:{message:'no fn'}}; },
})};
window.Chart=function(){window.__charts.made++;
  this.destroy=()=>{window.__charts.destroyed++;};this.update=()=>{};
  this.data={labels:[],datasets:[{},{}]};this.options={scales:{x:{ticks:{}}}};};
window.Chart.defaults={font:{}};
})();`;

// ── The share surface ─────────────────────────────────────────
// navigator.share and navigator.clipboard are both stubbed rather than used:
// 127.0.0.1 is a secure context, so the real clipboard is present here and
// would hide the one case that matters most — the insecure context, where
// navigator.clipboard is undefined and the unguarded call throws.
//
// `share`/`clipboard` are left alone unless a test names them, so every
// pre-existing block below runs against the browser as it was.
const SHARE_STUB = (cfg) => {
  window.__share  = [];
  window.__copied = [];
  const def = (name, value) =>
    Object.defineProperty(navigator, name, { configurable: true, writable: true, value });

  if (cfg.share === 'none') def('share', undefined);
  else if (cfg.share) def('share', (data) => {
    window.__share.push(data);
    if (cfg.share === 'abort') {
      const e = new Error('Share canceled'); e.name = 'AbortError';
      return Promise.reject(e);
    }
    if (cfg.share === 'reject') return Promise.reject(new Error('share unavailable'));
    return Promise.resolve();
  });

  if (cfg.clipboard === 'none') def('clipboard', undefined);
  else if (cfg.clipboard) def('clipboard', {
    writeText: (t) => {
      window.__copied.push(String(t));
      return cfg.clipboard === 'reject'
        ? Promise.reject(new Error('denied'))
        : Promise.resolve();
    },
  });
};

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});

async function page(o = {}) {
  const ctx = await b.newContext({ viewport: o.viewport || { width: 1100, height: 900 } });
  const p = await ctx.newPage(); const errs = []; const dialogs = [];
  p.on('pageerror', e => errs.push(String(e)));
  // Playwright auto-dismisses dialogs only while nothing is listening, and the
  // insecure-context fallback raises a prompt() that a test has to inspect.
  p.on('dialog', d => {
    dialogs.push({ type: d.type(), message: d.message(), value: d.defaultValue() });
    d.dismiss().catch(() => {});
  });
  await p.route('**/cdn.jsdelivr.net/**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: SUPA(o) }));
  const theme = o.theme || 'dark';
  await p.addInitScript(t => localStorage.setItem('zt_theme', t), theme);
  await p.addInitScript(SHARE_STUB, { share: o.share ?? null, clipboard: o.clipboard ?? null });
  await p.goto(BASE + '/dashboard.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  return { ctx, p, errs, dialogs };
}

// Reads the five tiles as [[value,label], …] so an assertion can name the
// number it expects rather than checking that something non-empty is there.
const TILES = () => Array.from(document.querySelectorAll('#stat-strip .stat-card'))
  .map(c => [c.querySelector('.stat-value').textContent.trim(),
             c.querySelector('.stat-label').textContent.trim()]);

// Document order, not markup order: a panel moved with CSS would still pass a
// source-order check and would not be where the reader sees it.
const ORDERED = (ids) => {
  const els = ids.map(i => document.getElementById(i));
  if (els.some(e => !e)) return false;
  return els.every((e, i) => i === 0 ||
    (els[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
};

// ── The panels that were removed ──────────────────────────────
console.log('[the removed panels are gone from the DOM, not hidden]');
{
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE });
  ok(await p.evaluate(() => document.getElementById('profile-panel') === null),
     'no #profile-panel element exists at all');
  ok(await p.evaluate(() => document.getElementById('leagues-panel') === null),
     'no #leagues-panel element exists at all');
  ok(await p.evaluate(() => document.getElementById('copy-profile-link-btn') === null),
     'the Copy link button is gone with it');
  const body = (await p.textContent('body')) || '';
  ok(!/Public Profile/i.test(body), 'the words "Public Profile" are nowhere on the page');
  ok(!/Your Leagues/i.test(body),   'the words "Your Leagues" are nowhere on the page');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── The Best tile is not a max across durations ───────────────
// The assertion this change lives or dies by. bests carries 190 at 300s and
// 84 at 120s; every game in history is a 120s run. A tile reading 190 has
// pooled scores that are not the same measurement — a 300-second run scores
// roughly two and a half times a 120-second one — which is exactly why the
// old Personal Bests panel showed one card per duration.
console.log('[the Best tile is the best at the duration played most, not the biggest number]');
{
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE });
  const tiles = await p.evaluate(TILES);
  ok(tiles[2][0] === '84',
     `Best is 84, the 120s best (got ${tiles[2][0]})`);
  ok(tiles[2][0] !== '190',
     'and specifically not 190, the 300s best, which no assertion here would otherwise catch');
  ok(tiles[2][1] === 'Best · 120s',
     `the label names the duration the number belongs to (got "${tiles[2][1]}")`);
  ok(!(await p.textContent('#stat-strip')).includes('190'),
     '190 appears nowhere in the strip');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// Two durations, equal games played. The documented rule is that the longer
// duration wins, so this must be 190 at 300s — and it must be that for the
// stated reason, not because 190 is the bigger number, which is why the block
// above exists.
console.log('[a tie on games played is broken toward the longer duration]');
{
  const TIED = {
    ...PUBLIC_PROFILE,
    bests: { '120': 84, '300': 190 },
    history: [
      { d: '2026-07-19', score: 70, duration: 120 },
      { d: '2026-07-20', score: 71, duration: 300 },
      { d: '2026-07-21', score: 72, duration: 120 },
      { d: '2026-07-22', score: 73, duration: 300 },
    ],
  };
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: TIED });
  const tiles = await p.evaluate(TILES);
  ok(tiles[2][0] === '190', `two games each -> the 300s best, 190 (got ${tiles[2][0]})`);
  ok(tiles[2][1] === 'Best · 300s', `labelled 300s (got "${tiles[2][1]}")`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// The mirror image of the tie: one more 300s game than 120s games, and the
// tile follows the games played rather than staying on 120 out of habit.
console.log('[play a longer duration more and the tile follows the games, not the duration]');
{
  const LONG = {
    ...PUBLIC_PROFILE,
    bests: { '120': 84, '300': 190 },
    history: [
      { d: '2026-07-20', score: 70, duration: 120 },
      { d: '2026-07-21', score: 71, duration: 300 },
      { d: '2026-07-22', score: 72, duration: 300 },
    ],
  };
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: LONG });
  const tiles = await p.evaluate(TILES);
  ok(tiles[2][0] === '190' && tiles[2][1] === 'Best · 300s',
     `the most-played duration is 300s now (got ${tiles[2][0]} / "${tiles[2][1]}")`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── The strip, from the server payload ────────────────────────
console.log('[the five tiles render the get_public_profile payload]');
{
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE });
  const tiles = await p.evaluate(TILES);
  ok(tiles.length === 5, `exactly five tiles (got ${tiles.length})`);
  ok(JSON.stringify(tiles.map(t => t[1])) ===
     JSON.stringify(['Total Games', 'Questions', 'Best · 120s', 'Days Practiced', 'Day Streak']),
     'the labels are the five asked for, in order');
  ok(tiles[0][0] === '1,234',  `Total Games is 1,234 (got ${tiles[0][0]})`);
  ok(tiles[1][0] === '45,678', `Questions is 45,678 (got ${tiles[1][0]})`);
  ok(tiles[2][0] === '84',     `Best is 84 (got ${tiles[2][0]})`);
  ok(tiles[3][0] === '87',     `Days Practiced is 87 (got ${tiles[3][0]})`);
  ok(tiles[4][0] === '12',     `Day Streak is 12 (got ${tiles[4][0]})`);

  // 1,234 is not derivable from the three stubbed sessions, so this also
  // proves the dashboard preferred the RPC over its own fallback.
  const called = await p.evaluate(() => window.__rpc.find(c => c[0] === 'get_public_profile'));
  ok(called && called[1].p_username === 'hexadecimal',
     'it looked the profile up by the signed-in username');

  ok((await p.textContent('#stats-note')).includes('Averaging 30 across the last 3 games.'),
     'the rolling average moved into the note under the strip');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── Accuracy is gone, asserted positively ─────────────────────
// The Accuracy column of the Recent Games table is a per-session figure and
// stays, so this is asserted about the strip rather than about the page.
console.log('[no accuracy tile anywhere in the strip]');
{
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE });
  const tiles = await p.evaluate(TILES);
  ok(!tiles.some(t => /accuracy/i.test(t[1])), 'no tile is labelled Accuracy');
  ok(!tiles.some(t => t[0].includes('%')), 'no tile shows a percentage at all');
  ok(!(await p.textContent('#stat-strip')).includes('96.2'),
     "the payload's accuracy figure, 96.2%, is nowhere in the strip");
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── The Personal Bests panel ──────────────────────────────────
console.log('[the Personal Bests panel is gone from the DOM, not hidden]');
{
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE });
  ok(await p.evaluate(() => document.getElementById('bests-panel') === null),
     'no #bests-panel element exists at all');
  ok(await p.evaluate(() => document.getElementById('best-row') === null),
     'no #best-row element exists');
  ok(await p.evaluate(() => document.getElementById('bests-note') === null),
     'no #bests-note element exists');
  ok(await p.evaluate(() => document.querySelectorAll('.best-card').length === 0),
     'and not one best card was rendered anywhere');
  ok(!/Personal Bests/i.test((await p.textContent('body')) || ''),
     'the words "Personal Bests" appear nowhere');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── Panel order ───────────────────────────────────────────────
console.log('[panel order: stats → score over time → by operation → recent games]');
{
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE });
  ok(await p.evaluate(ORDERED, ['stat-strip', 'chart-panel', 'ops-panel', 'games-panel']),
     'the four sections are in that document order');
  ok(await p.evaluate(ORDERED, ['stat-strip', 'stats-note', 'chart-panel']),
     'and the note sits between the strip and the chart, where the bests panel was');
  // Negative control: the same helper must refuse an order that is wrong,
  // or the two assertions above prove only that four elements exist.
  ok(!(await p.evaluate(ORDERED, ['ops-panel', 'chart-panel'])),
     'the order check has teeth — the reverse order is refused');
  ok(await p.isVisible('#ops-panel'), 'By Operation is visible');
  ok((await p.textContent('#ops-panel')).includes('1.42s'),
     'its bars carry the payload’s figures (addition, 1.42s)');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── The local fallback ────────────────────────────────────────
// A signed-in account with no profiles row: registration with email
// confirmation leaves accounts in exactly this state, and the page has to
// work without a username to look a public profile up by.
console.log('[no username -> the strip is computed locally, not five dashes]');
{
  const { ctx, p, errs } = await page({ profileRow: null, sessions: SESSIONS });
  const tiles = await p.evaluate(TILES);
  ok(tiles.length === 5, 'the strip still renders five tiles');
  ok(!tiles.every(t => t[0] === '—'), 'and they are not five em-dashes');
  ok(tiles[0][0] === '3',   `Total Games is the real count, 3 (got ${tiles[0][0]})`);
  ok(tiles[1][0] === '10',  `Questions is 10 (got ${tiles[1][0]})`);
  ok(tiles[2][0] === '40',  `Best is 40, the 120s maximum (got ${tiles[2][0]})`);
  ok(tiles[2][1] === 'Best · 120s',
     `and 120s is the duration played most, twice of three (got "${tiles[2][1]}")`);
  ok(tiles[3][0] === '3',   `Days Practiced is 3 (got ${tiles[3][0]})`);
  ok(tiles[4][0] === '3',   `Day Streak is 3 (got ${tiles[4][0]})`);
  ok(!tiles.some(t => /accuracy/i.test(t[1]) || t[0].includes('%')),
     'the locally computed strip has no accuracy tile either');
  ok(await p.evaluate(() => !window.__rpc.some(c => c[0] === 'get_public_profile')),
     'no profile lookup is attempted without a username');
  const fallbackNote = await p.textContent('#stats-note');
  ok(fallbackNote.includes('computed from the games loaded'),
     'and the page says the figures came from the loaded games');
  ok(fallbackNote.includes('Averaging 30 across the last 3 games.'),
     'the rolling average is in the note on this path too');

  // The whitelist is the reason a client-written `operation` cannot become a
  // row: the fourth question in the newest session says "bogus".
  const rows = await p.evaluate(() =>
    Array.from(document.querySelectorAll('#op-bars .op-bar-row')).map(r => [
      r.querySelector('.op-bar-name').textContent.trim(),
      r.querySelector('.op-bar-value').textContent.trim(),
      r.querySelector('.op-bar-meta').textContent.trim(),
    ]));
  ok(rows.length === 4, `four operation bars (got ${rows.length})`);
  ok(JSON.stringify(rows.map(r => r[0])) ===
     JSON.stringify(['addition', 'subtraction', 'multiplication', 'division']),
     'in the fixed order');
  ok(rows[0][1] === '2.00s', `addition averages 2.00s (got ${rows[0][1]})`);
  ok(rows[0][2] === '66.7% correct · 3 questions', `and reads "${rows[0][2]}"`);
  ok(rows[2][1] === '4.00s', `multiplication averages 4.00s (got ${rows[2][1]})`);
  ok(!(await p.textContent('#op-bars')).includes('bogus'),
     'an unrecognised operation is dropped, not rendered');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await p.screenshot({ path: `${SHOTS}/dashboard-local-fallback.png`, fullPage: true });
  await ctx.close();
}

// The same rule on the fallback path, which computes the counts itself rather
// than reading them off history: one 300-second run scoring 190, against two
// 120-second runs whose best is 40.
console.log('[the local fallback does not pool scores across durations either]');
{
  const LONG_RUN = [...SESSIONS, {
    session_key: 'k4', created_at: `${dayISO(3)}T10:00:00Z`, score: 190, duration_seconds: 300,
    questions: [q('addition', 1000, false)],
  }];
  const { ctx, p, errs } = await page({ profileRow: null, sessions: LONG_RUN });
  const tiles = await p.evaluate(TILES);
  ok(tiles[2][0] === '40', `Best is still the 120s best, 40 (got ${tiles[2][0]})`);
  ok(tiles[2][0] !== '190', 'the single 300s run did not take the tile');
  ok(tiles[2][1] === 'Best · 120s', `labelled 120s (got "${tiles[2][1]}")`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── A hostile username ────────────────────────────────────────
console.log('[a hostile username does not execute]');
{
  const XSS = '<img src=x onerror="window.__pwned=1">';
  const { ctx, p, errs } = await page({
    profileRow: { id: 'u1', username: XSS },
    sessions: SESSIONS,
    publicProfile: { ...PUBLIC_PROFILE, username: XSS },
  });
  ok(await p.evaluate(() => window.__pwned !== 1), 'nothing executed');
  ok(await p.evaluate(() => document.querySelectorAll('.dashboard-wrap img').length === 0),
     'and it did not become an element');
  ok((await p.textContent('#username-display')).includes(XSS),
     'it is shown as literal text');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── Theme ─────────────────────────────────────────────────────
console.log('[the chart is destroyed and rebuilt on zt-theme-change]');
{
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE });
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
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal', is_public: true },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE, theme });
  ok(await p.isVisible('#stat-strip'), `${theme}: the strip is visible`);
  ok(await p.isVisible('#share-profile-btn'), `${theme}: the Share button is visible`);
  ok(errs.length === 0, `${theme}: no uncaught errors (${errs[0] ?? ''})`);
  await p.screenshot({ path: `${SHOTS}/dashboard-${theme}.png`, fullPage: true });
  await p.screenshot({ path: `${SHOTS}/dashboard-share-${theme}.png`,
                       clip: { x: 0, y: 0, width: 1100, height: 200 } });
  await ctx.close();
}

// ── The Share button ──────────────────────────────────────────
// It shares the /@name URL. The exact string is asserted everywhere below,
// because "a URL was passed" is satisfied by the wrong one.
const ORIGIN    = new URL(BASE).origin;
const SHARE_URL = ORIGIN + '/@hexadecimal';
const PUBLIC_ROW  = { id: 'u1', username: 'hexadecimal', is_public: true };
const PRIVATE_ROW = { id: 'u1', username: 'hexadecimal', is_public: false };

// Geometry from the live DOM, not markup order: a button that source-order
// says is after the name can still be rendered under it, or off the row.
const GEOM = () => {
  const name = document.getElementById('username-display');
  const btn  = document.getElementById('share-profile-btn');
  if (!name || !btn) return null;
  const n = name.getBoundingClientRect(), s = btn.getBoundingClientRect();
  return {
    nameLeft: n.left, nameRight: n.right, nameTop: n.top, nameBottom: n.bottom,
    btnLeft: s.left, btnRight: s.right, btnTop: s.top, btnBottom: s.bottom,
    btnW: s.width, btnH: s.height,
  };
};

console.log('[the Share button sits to the right of the username]');
{
  const { ctx, p, errs } = await page({ profileRow: PUBLIC_ROW, sessions: SESSIONS,
                                        publicProfile: PUBLIC_PROFILE, share: 'none', clipboard: 'ok' });
  const g = await p.evaluate(GEOM);
  ok(g !== null, 'the button is in the DOM beside the username line');
  ok(g && g.btnLeft >= g.nameRight - 0.5,
     `its left edge is at or past the name's right edge (${g && g.btnLeft} vs ${g && g.nameRight})`);
  ok(g && g.btnTop < g.nameBottom && g.btnBottom > g.nameTop,
     'and it overlaps that line vertically, so it is beside the name rather than under it');
  ok(g && g.btnLeft - g.nameRight >= 6 && g.btnLeft - g.nameRight <= 24,
     `with a real gap and not a stranded one (${g && (g.btnLeft - g.nameRight).toFixed(1)}px)`);
  ok(g && g.btnW > 40 && g.btnH > 16, `the button has size (${g && g.btnW}×${g && g.btnH})`);

  const shape = await p.evaluate(() => {
    const b = document.getElementById('share-profile-btn');
    b.focus();
    return {
      tag: b.tagName, type: b.type, text: b.textContent.trim(),
      name: (b.getAttribute('aria-label') || b.textContent).trim(),
      tabindex: b.getAttribute('tabindex'),
      focused: document.activeElement === b,
      imgs: b.querySelectorAll('img, svg').length,
    };
  });
  ok(shape.tag === 'BUTTON' && shape.type === 'button', 'it is a real <button type=button>');
  ok(shape.text === 'Share', `labelled "Share" (got "${shape.text}")`);
  ok(shape.name.length > 1 && !/^[^A-Za-z]+$/.test(shape.name),
     `its accessible name is words, not an icon ("${shape.name}")`);
  ok(shape.focused && shape.tabindex === null, 'it takes keyboard focus and is not removed from the tab order');
  ok(!(await p.isVisible('#share-note')), 'nothing is claimed under it before it is used');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[navigator.share is used once, with the absolute /@name URL]');
{
  const { ctx, p, errs } = await page({ profileRow: PUBLIC_ROW, sessions: SESSIONS,
                                        publicProfile: PUBLIC_PROFILE, share: 'ok', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(300);
  const calls = await p.evaluate(() => window.__share);
  ok(calls.length === 1, `navigator.share was called exactly once (got ${calls.length})`);
  ok(calls[0] && calls[0].url === SHARE_URL,
     `with ${SHARE_URL} (got ${calls[0] && calls[0].url})`);
  ok(calls[0] && calls[0].title === 'My Arithmetic Trainer profile',
     `and a title (got ${JSON.stringify(calls[0] && calls[0].title)})`);
  ok((await p.evaluate(() => window.__copied)).length === 0,
     'the clipboard was left alone — the sheet is the share');
  ok((await p.textContent('#share-profile-btn')).trim() === 'Share',
     'the label does not claim a copy that did not happen');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[the button works from the keyboard]');
{
  const { ctx, p, errs } = await page({ profileRow: PUBLIC_ROW, sessions: SESSIONS,
                                        publicProfile: PUBLIC_PROFILE, share: 'ok', clipboard: 'ok' });
  await p.focus('#share-profile-btn');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  const calls = await p.evaluate(() => window.__share);
  ok(calls.length === 1 && calls[0].url === SHARE_URL,
     `Enter on the focused button shares the same URL (got ${calls.length} call(s))`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[no navigator.share -> the URL is copied and the label says so, then reverts]');
{
  const { ctx, p, errs } = await page({ profileRow: PUBLIC_ROW, sessions: SESSIONS,
                                        publicProfile: PUBLIC_PROFILE, share: 'none', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(200);
  const copied = await p.evaluate(() => window.__copied);
  ok(copied.length === 1, `one clipboard write (got ${copied.length})`);
  ok(copied[0] === SHARE_URL, `of ${SHARE_URL} (got ${copied[0]})`);
  ok((await p.textContent('#share-profile-btn')).trim() === 'Copied!',
     'the label confirms it in place');
  await p.waitForTimeout(2300);
  ok((await p.textContent('#share-profile-btn')).trim() === 'Share',
     'and reverts about two seconds later');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[insecure context: no share, no clipboard -> the URL is still offered, nothing throws]');
{
  const { ctx, p, errs, dialogs } = await page({ profileRow: PUBLIC_ROW, sessions: SESSIONS,
                                                 publicProfile: PUBLIC_PROFILE,
                                                 share: 'none', clipboard: 'none' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(300);
  ok(dialogs.length === 1, `one prompt was raised (got ${dialogs.length})`);
  ok(dialogs[0] && dialogs[0].type === 'prompt', 'it is a prompt, so the URL can be selected by hand');
  ok(dialogs[0] && dialogs[0].value === SHARE_URL,
     `carrying ${SHARE_URL} (got ${dialogs[0] && dialogs[0].value})`);
  ok((await p.textContent('#share-profile-btn')).trim() === 'Share',
     'and the label does not claim a copy that never happened');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a dismissed share sheet is not a failure]');
{
  const { ctx, p, errs, dialogs } = await page({ profileRow: PUBLIC_ROW, sessions: SESSIONS,
                                                 publicProfile: PUBLIC_PROFILE,
                                                 share: 'abort', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(400);
  ok((await p.evaluate(() => window.__share)).length === 1, 'the sheet was opened');
  ok((await p.evaluate(() => window.__copied)).length === 0,
     'changing your mind does not copy something you did not ask for');
  ok(dialogs.length === 0, 'and raises no dialog');
  ok(!(await p.isVisible('#share-note')), 'no message is shown at all');
  const head = (await p.textContent('.dashboard-head')) || '';
  ok(!/couldn't|could not|error|failed|sorry/i.test(head),
     `nothing in the head reads as a failure (got "${head.replace(/\s+/g, ' ').trim()}")`);
  ok((await p.textContent('#share-profile-btn')).trim() === 'Share', 'the label is unchanged');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a share that genuinely fails falls back to the clipboard, still without an error]');
{
  const { ctx, p, errs } = await page({ profileRow: PUBLIC_ROW, sessions: SESSIONS,
                                        publicProfile: PUBLIC_PROFILE, share: 'reject', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(400);
  const copied = await p.evaluate(() => window.__copied);
  ok(copied.length === 1 && copied[0] === SHARE_URL,
     `the click still ends with the link in hand (got ${JSON.stringify(copied)})`);
  ok((await p.textContent('#share-profile-btn')).trim() === 'Copied!', 'and says so');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a private profile says the link works for nobody else; a public one does not]');
{
  const { ctx, p, errs } = await page({ profileRow: PRIVATE_ROW, sessions: SESSIONS,
                                        publicProfile: { ...PUBLIC_PROFILE, is_public: false },
                                        share: 'none', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(200);
  ok(await p.isVisible('#share-note'), 'the caveat is shown');
  const note = ((await p.textContent('#share-note')) || '').replace(/\s+/g, ' ').trim();
  ok(note === 'Copied — your profile is private, so only you can see it. Make it public in Settings.',
     `and it is the whole sentence (got "${note}")`);
  const link = await p.evaluate(() => {
    const a = document.querySelector('#share-note a');
    return a ? { href: a.getAttribute('href'), text: a.textContent.trim(), resolved: a.href } : null;
  });
  ok(link && link.href === 'settings.html', `Settings is a real link to settings.html (got ${link && link.href})`);
  ok(link && link.text === 'Settings', `and reads "Settings" (got "${link && link.text}")`);
  ok(link && /\/settings\.html$/.test(link.resolved), `resolving to ${link && link.resolved}`);
  ok((await p.evaluate(() => window.__copied))[0] === SHARE_URL,
     'the link was still copied — the caveat does not block the share');
  ok((await p.textContent('#share-profile-btn')).trim() === 'Copied!', 'and the label still confirms');
  await p.screenshot({ path: `${SHOTS}/dashboard-share-private.png`,
                       clip: { x: 0, y: 0, width: 1100, height: 220 } });
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}
{
  const { ctx, p, errs } = await page({ profileRow: PUBLIC_ROW, sessions: SESSIONS,
                                        publicProfile: PUBLIC_PROFILE, share: 'none', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(200);
  ok(!(await p.isVisible('#share-note')), 'a public profile shows no caveat');
  ok(((await p.textContent('#share-note')) || '').trim() === '',
     'and the note element is empty, not merely hidden');
  ok(!/private/i.test((await p.textContent('.dashboard-head')) || ''),
     'the word "private" is nowhere in the head');
  ok((await p.evaluate(() => window.__copied))[0] === SHARE_URL, 'the copy happened all the same');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[no username -> no Share button at all]');
{
  const { ctx, p, errs } = await page({ profileRow: null, sessions: SESSIONS,
                                        share: 'none', clipboard: 'ok' });
  ok(await p.evaluate(() => document.getElementById('share-profile-btn') === null),
     'no #share-profile-btn element exists');
  ok(await p.evaluate(() => document.getElementById('share-slot').children.length === 0),
     'the slot is empty rather than holding a disabled control');
  ok(!(await p.isVisible('#share-note')), 'and no note either');
  ok(!/\bShare\b/.test((await p.textContent('.dashboard-head')) || ''),
     'the word "Share" appears nowhere in the head');
  ok(await p.isVisible('#username-claim'), 'the claim panel is what is offered instead');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a hostile username survives the URL and stays inert]');
{
  const XSS = '"><img src=x onerror=window.__pwned=1>';
  const EXPECTED = ORIGIN + '/@' + encodeURIComponent(XSS);
  const { ctx, p, errs } = await page({
    profileRow: { id: 'u1', username: XSS, is_public: true },
    sessions: SESSIONS,
    publicProfile: { ...PUBLIC_PROFILE, username: XSS },
    share: 'none', clipboard: 'ok',
  });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__pwned !== 1), 'nothing executed');
  ok(await p.evaluate(() => document.querySelectorAll('.dashboard-wrap img').length === 0),
     'and it did not become an element');
  const copied = (await p.evaluate(() => window.__copied))[0];
  ok(copied === EXPECTED, `the copied URL is percent-encoded (got ${copied})`);
  ok(copied && !copied.includes('<') && !copied.includes('"') && !copied.includes('>'),
     'with no raw angle bracket or quote left in it');
  const parsed = await p.evaluate(u => {
    const url = new URL(u);
    return { origin: url.origin, path: url.pathname, back: decodeURIComponent(url.pathname.slice(2)) };
  }, copied);
  ok(parsed.origin === ORIGIN && parsed.path.startsWith('/@'),
     `it is still a /@name URL on this origin (${parsed.path})`);
  ok(parsed.back === XSS, 'and it decodes back to the username the profile actually has');
  ok((await p.textContent('#share-profile-btn')).trim() === 'Copied!', 'the button behaved normally');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[at 380px the button is beside the name and fully on screen]');
{
  const { ctx, p, errs } = await page({ profileRow: PUBLIC_ROW, sessions: SESSIONS,
                                        publicProfile: PUBLIC_PROFILE, share: 'none', clipboard: 'ok',
                                        viewport: { width: 380, height: 900 } });
  const g = await p.evaluate(GEOM);
  ok(g && g.btnRight <= 380, `the button is inside the viewport (right edge ${g && g.btnRight})`);
  ok(g && g.btnLeft >= 0, 'and not off the left of it');
  ok(g && g.btnLeft >= g.nameRight - 0.5 && g.btnTop < g.nameBottom && g.btnBottom > g.nameTop,
     'still on the same line as the name, to its right');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= 380),
     'and nothing it added made the page scroll sideways');
  await p.screenshot({ path: `${SHOTS}/dashboard-share-380.png`,
                       clip: { x: 0, y: 0, width: 380, height: 220 } });
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── The username claim panel (unchanged behaviour) ────────────
console.log('[no profile row -> claim panel shown]');
{ const {ctx,p,errs}=await page({profileRow:null,avail:true});
  ok(await p.isVisible('#username-claim'),'claim panel is visible when the profile is missing');
  const t=await p.textContent('body');
  ok(/username/i.test(t),'it explains what is missing');
  ok(/games are already saved/i.test(t),'it reassures that games are not lost');
  await p.fill('#claim-username','hexadecimal'); await p.click('#claim-btn'); await p.waitForTimeout(500);
  const ins=await p.evaluate(()=>window.__inserts());
  ok(ins.some(([t,r])=>t==='profiles'&&r.username==='hexadecimal'&&r.id==='u1'),
     'saving inserts the profile row with the right id and username');
  ok(errs.length===0,'no uncaught errors ('+(errs[0]??'')+')');
  await p.screenshot({path:`${SHOTS}/claim-panel.png`}); await ctx.close(); }
console.log('[username taken -> refused, no insert]');
{ const {ctx,p,errs}=await page({profileRow:null,avail:false});
  await p.fill('#claim-username','taken'); await p.click('#claim-btn'); await p.waitForTimeout(500);
  const err=await p.textContent('#claim-error');
  ok(/taken/i.test(err),'a taken username is refused with a clear message');
  ok((await p.evaluate(()=>window.__inserts())).length===0,'no insert was attempted for a taken name');
  ok(await p.isEnabled('#claim-btn'),'the button re-enables after a refusal');
  ok(errs.length===0,'no uncaught errors'); await ctx.close(); }
console.log('[profile exists -> panel hidden]');
{ const {ctx,p,errs}=await page({profileRow:{id:'u1',username:'already'},avail:true});
  ok(!(await p.isVisible('#username-claim')),'claim panel stays hidden when a profile exists');
  ok((await p.textContent('#username-display')).includes('already'),'the existing username is shown');
  ok(errs.length===0,'no uncaught errors'); await ctx.close(); }
console.log('[empty input -> refused]');
{ const {ctx,p}=await page({profileRow:null,avail:true});
  await p.click('#claim-btn'); await p.waitForTimeout(300);
  ok(/pick a username/i.test(await p.textContent('#claim-error')),'empty input is refused');
  ok((await p.evaluate(()=>window.__inserts())).length===0,'no insert on empty input'); await ctx.close(); }

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
