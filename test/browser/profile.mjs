import { chromium } from 'playwright';
// The public profile page — profile.html?u=<username>.
//
// Two things this suite exists to hold still:
//
//   1. It must look like the dashboard. Same five tiles in the same order,
//      same panels in the same order — strip, Score Over Time with its three
//      range buttons, By Operation, Recent Games — rendered by the same
//      js/stats.js.
//   2. It must get there WITHOUT reading game_sessions. Everything on the
//      page comes through get_public_profile, which returns a fixed, minimal
//      projection: per-session figures (date, score, duration, a
//      server-computed accuracy percent) and never the questions those
//      figures were computed from. That is asserted positively below, as is
//      the one thing the projection withholds from a visitor — the session
//      key, which is what a Review link would need and what would open
//      somebody else's whole question list.
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
  // 300s holds the biggest number and, per `history` below, is never played:
  // the Best tile must show 84 at 120s, not 190.
  bests: { '60': 41, '120': 84, '300': 190 },
  ops: {
    addition:       { avg_ms: 1420, count: 9000, accuracy: 0.98 },
    subtraction:    { avg_ms: 1660, count: 5000, accuracy: 0.95 },
    multiplication: { avg_ms: 1980, count: 4000, accuracy: 0.93 },
    division:       { avg_ms: 2310, count: 3000, accuracy: 0.90 },
  },
  // `key` is deliberately absent from every entry: this fixture is somebody
  // else's profile (is_owner false), and get_public_profile emits a non-null
  // key only to a profile's owner. OWNER_PROFILE below is the same history
  // with keys on it, so the two Recent Games shapes are both exercised.
  //
  // acc: 94, 100 and null — the third is a session that stored no questions,
  // which must render as an em dash rather than as 0%.
  history: [
    { d: '2026-07-20', score: 70, duration: 120, acc: 94,   key: null },
    { d: '2026-07-21', score: 75, duration: 120, acc: 100,  key: null },
    { d: '2026-07-22', score: 80, duration: 120, acc: null, key: null },
  ],
};

// The same profile seen by its owner: identical figures, plus the session
// keys that make the Review column possible.
const OWNER_PROFILE = {
  ...PUBLIC_PROFILE,
  is_owner: true,
  history: [
    { d: '2026-07-20', score: 70, duration: 120, acc: 94,   key: 'sess-a' },
    { d: '2026-07-21', score: 75, duration: 120, acc: 100,  key: 'sess-b' },
    { d: '2026-07-22', score: 80, duration: 120, acc: null, key: 'sess-c' },
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
window.Chart=function(ctx,cfg){window.__charts.made++;
  // The points the page asked for, captured at construction. The range
  // buttons destroy and rebuild rather than mutate, so this is always the
  // currently drawn series — which is the only way to tell "Last 20" from
  // "All Time" through a stub.
  try{window.__chartData=cfg.data.datasets[0].data.slice();}catch(e){window.__chartData=null;}
  try{window.__chartLabels=cfg.data.labels.slice();}catch(e){window.__chartLabels=null;}
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
  await p.addInitScript(t => localStorage.setItem('zt_theme', t), o.theme || 'dark');
  await p.addInitScript(SHARE_STUB, { share: o.share ?? null, clipboard: o.clipboard ?? null });
  const u = o.u === undefined ? 'hexadecimal' : o.u;
  const url = u === null ? BASE + '/profile.html' : BASE + '/profile.html?u=' + encodeURIComponent(u);
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  return { ctx, p, errs, dialogs };
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
     JSON.stringify(['Total Games', 'Questions', 'Best · 120s', 'Days Practiced', 'Day Streak']),
     'the same labels, in the same order, as the dashboard');
  ok(tiles[0][0] === '1,234',  `Total Games is 1,234 (got ${tiles[0][0]})`);
  ok(tiles[1][0] === '45,678', `Questions is 45,678 (got ${tiles[1][0]})`);
  ok(tiles[2][0] === '84',     `Best is 84 (got ${tiles[2][0]})`);
  ok(tiles[3][0] === '87',     `Days Practiced is 87 (got ${tiles[3][0]})`);
  ok(tiles[4][0] === '12',     `Day Streak is 12 (got ${tiles[4][0]})`);

  const note = (await p.textContent('#stats-note')).replace(/\s+/g, ' ').trim();
  ok(note.includes('Averaging 75 across the last 3 games'),
     `the rolling average is in the note under the strip (got "${note}")`);
  ok(note.includes('78%'), 'and so is the percentile');
  ok(note === 'Averaging 75 across the last 3 games — faster than 78% of players at 120 seconds.',
     `the two read as one sentence (got "${note}")`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── The Best tile is not a max across durations ───────────────
// The same fixture the dashboard uses, and the same rule: 190 at 300s is the
// biggest number in `bests` and the least played, so a tile showing it has
// pooled measurements that are not comparable.
console.log('[the Best tile is the best at the duration played most, not the biggest number]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  const tiles = await p.evaluate(TILES);
  ok(tiles[2][0] === '84', `Best is 84, the 120s best (got ${tiles[2][0]})`);
  ok(tiles[2][0] !== '190', 'and specifically not 190, the 300s best');
  ok(tiles[2][1] === 'Best · 120s',
     `the label names the duration the number belongs to (got "${tiles[2][1]}")`);
  ok(!(await p.textContent('#stat-strip')).includes('190'), '190 is nowhere in the strip');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

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
  const { ctx, p, errs } = await page({ publicProfile: TIED, percentile: PERCENTILE });
  const tiles = await p.evaluate(TILES);
  ok(tiles[2][0] === '190', `two games each -> the 300s best, 190 (got ${tiles[2][0]})`);
  ok(tiles[2][1] === 'Best · 300s', `labelled 300s (got "${tiles[2][1]}")`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── Accuracy and the Personal Bests panel are gone ────────────
console.log('[no accuracy tile, and no Personal Bests panel in the DOM]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  const tiles = await p.evaluate(TILES);
  ok(!tiles.some(t => /accuracy/i.test(t[1])), 'no tile is labelled Accuracy');
  ok(!tiles.some(t => t[0].includes('%')), 'no tile shows a percentage');
  // Scoped to the strip, not the whole page. This assertion used to read
  // "the word appears nowhere", which was true only while the page had no
  // Recent Games table — that table has an Accuracy COLUMN, and so does the
  // dashboard's. What this block protects is the absence of an accuracy TILE
  // in the strip, so that is what it now says.
  const strip = (await p.textContent('#stat-strip')) || '';
  ok(!/accuracy/i.test(strip), 'the word "accuracy" appears nowhere in the stat strip');
  // The payload's all-time accuracy (0.962) must still be nowhere on the
  // page. The Recent Games column carries PER-SESSION accuracy — 94%, 100%,
  // an em dash — so 96.2 appearing would mean the removed tile came back
  // somewhere else, which is exactly what this block is for.
  const body = (await p.textContent('body')) || '';
  ok(!body.includes('96.2'), "and the payload's all-time accuracy figure is nowhere on the page");
  ok(await p.evaluate(() => document.getElementById('bests-panel') === null),
     'no #bests-panel element exists at all');
  ok(await p.evaluate(() => document.getElementById('best-row') === null),
     'no #best-row element exists');
  ok(await p.evaluate(() => document.querySelectorAll('.best-card').length === 0),
     'not one best card was rendered');
  ok(!/Personal Bests/i.test(body), 'the words "Personal Bests" appear nowhere');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// The percentile is a second RPC that lands after the rest of the page. When
// it never lands, the note must still be a sentence rather than a fragment
// waiting for one.
console.log('[no percentile -> the note is still a whole sentence]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: null });
  const note = (await p.textContent('#stats-note')).replace(/\s+/g, ' ').trim();
  ok(note === 'Averaging 75 across the last 3 games.', `the average alone (got "${note}")`);
  ok(!note.includes('—'), 'with no dangling dash where the percentile would have been');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// ── Order ─────────────────────────────────────────────────────
console.log('[panel order matches the dashboard]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  ok(await p.evaluate(ORDERED, ['stat-strip', 'chart-panel', 'ops-panel', 'games-panel']),
     'stats → Score Over Time → By Operation → Recent Games, in document order');
  ok(await p.evaluate(ORDERED, ['stat-strip', 'stats-note', 'chart-panel']),
     'and the note sits between the strip and the chart, where the bests panel was');
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

// ── Recent Games, and where its rows came from ────────────────
// The table exists now, but the boundary it is on the far side of does not
// move: it is built from get_public_profile's `history`, and game_sessions is
// never read. Both halves are asserted, because the table looking right
// proves nothing about where the rows came from.
const ROWS = () => Array.from(document.querySelectorAll('#games-tbody tr'))
  .map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()));

console.log('[Recent Games renders the history, newest first]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  ok(await p.isVisible('#games-panel'), 'the Recent Games panel is shown');
  const rows = await p.evaluate(ROWS);
  ok(rows.length === 3, `three rows, one per history entry (got ${rows.length})`);
  // Newest first: history arrives oldest-first for the chart, so a table that
  // forgot to reverse would lead with Jul 20 and nobody would notice.
  ok(rows[0] && rows[0][1] === '80',
     `the newest game leads the table (got score "${rows[0] && rows[0][1]}")`);
  ok(rows[2] && rows[2][1] === '70',
     `and the oldest is last (got score "${rows[2] && rows[2][1]}")`);
  ok(rows[0] && /^Jul 22, 2026$/.test(rows[0][0]),
     `the date carries the year and does not slide a day (got "${rows[0] && rows[0][0]}")`);
  ok(rows[0] && rows[0][2] === '120s', `duration reads "120s" (got "${rows[0] && rows[0][2]}")`);
  ok(rows[1] && rows[1][3] === '100%', `accuracy reads as a percent (got "${rows[1] && rows[1][3]}")`);
  // The distinction the SQL goes out of its way to preserve: a session that
  // stored no questions has no accuracy, and must not be reported as 0%.
  ok(rows[0] && rows[0][3] === '—',
     `a null accuracy is an em dash, not 0% (got "${rows[0] && rows[0][3]}")`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a visitor gets no Review column at all — not a column of dashes]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  const heads = await p.evaluate(() =>
    Array.from(document.querySelectorAll('.games-table thead th')).map(th => th.textContent.trim()));
  ok(heads.length === 4 && heads.join('|') === 'Date|Score|Duration|Accuracy',
     `four columns, no Review header (got ${JSON.stringify(heads)})`);
  const rows = await p.evaluate(ROWS);
  ok(rows.every(r => r.length === 4), 'and every row has four cells to match');
  ok(await p.evaluate(() => document.querySelectorAll('.view-session-link').length === 0),
     'no per-session link exists');
  ok(!/results\.html/.test(await p.content()),
     'and nothing on the page links to a single run');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[the owner gets the Review column, linking to their own runs]');
{
  const { ctx, p, errs } = await page({ publicProfile: OWNER_PROFILE, percentile: PERCENTILE,
                                        signedIn: true });
  const heads = await p.evaluate(() =>
    Array.from(document.querySelectorAll('.games-table thead th')).map(th => th.textContent.trim()));
  ok(heads.length === 5 && heads[4] === 'Review',
     `five columns, Review last (got ${JSON.stringify(heads)})`);
  const links = await p.evaluate(() =>
    Array.from(document.querySelectorAll('.view-session-link')).map(a => ({
      text: a.textContent.trim(), href: a.getAttribute('href'),
    })));
  ok(links.length === 3, `one link per row (got ${links.length})`);
  // Newest first, so the first link is the newest session's key.
  ok(links[0] && links[0].href === 'results.html?session=sess-c',
     `the link carries that row's own session key (got ${links[0] && links[0].href})`);
  ok(links[0] && links[0].text === 'View', 'and reads "View"');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a hostile session key cannot break out of the href]');
{
  const XSS  = '"><img src=x onerror=window.__pwned=1>';
  const { ctx, p, errs } = await page({
    publicProfile: { ...OWNER_PROFILE,
                     history: [{ d: '2026-07-22', score: 80, duration: 120, acc: 90, key: XSS }] },
    percentile: PERCENTILE, signedIn: true });
  ok(await p.evaluate(() => window.__pwned !== 1), 'nothing executed');
  ok(await p.evaluate(() => document.querySelectorAll('.games-table img').length === 0),
     'and it did not become an element');
  const href = await p.evaluate(() => {
    const a = document.querySelector('.view-session-link');
    return a ? a.getAttribute('href') : null;
  });
  ok(href === 'results.html?session=' + encodeURIComponent(XSS),
     `the key is percent-encoded into the query string (got ${href})`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[every figure came through the RPC — game_sessions is never read]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  ok(await p.evaluate(() => !window.__tables.includes('game_sessions')),
     'the page never reads game_sessions — the table above was built from the RPC payload');
  ok(await p.evaluate(() => window.__tables.length === 0),
     'in fact it reads no table at all');
  ok(await p.evaluate(() => window.__rpc.every(c =>
       c[0] === 'get_public_profile' || c[0] === 'get_score_percentile')),
     'and it called nothing but the two functions the contract names');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[the chart range buttons slice the history]');
{
  // 25 entries so "Last 20" is a real cut rather than the whole set.
  const many = Array.from({ length: 25 }, (_, i) => ({
    d: `2026-06-${String(i + 1).padStart(2, '0')}`, score: 50 + i, duration: 120, acc: 90, key: null,
  }));
  const { ctx, p, errs } = await page({ publicProfile: { ...PUBLIC_PROFILE, history: many },
                                        percentile: PERCENTILE });
  const btns = await p.evaluate(() =>
    Array.from(document.querySelectorAll('.chart-range-btn')).map(b => ({
      range: b.dataset.range, text: b.textContent.trim(), active: b.classList.contains('active'),
    })));
  ok(btns.length === 3 && btns.map(b => b.range).join('|') === '20|100|all',
     `three range buttons, same as the dashboard (got ${JSON.stringify(btns.map(b => b.range))})`);
  ok(btns[0] && btns[0].active, 'Last 20 is the one selected on load');

  const count = () => window.__chartData ? window.__chartData.length : null;
  ok(await p.evaluate(count) === 20,
     `the default draws the last 20 of 25 (got ${await p.evaluate(count)})`);
  await p.click('.chart-range-btn[data-range="all"]');
  await p.waitForTimeout(150);
  ok(await p.evaluate(count) === 25, `All Time draws all 25 (got ${await p.evaluate(count)})`);
  ok(await p.evaluate(() =>
       document.querySelector('.chart-range-btn[data-range="all"]').classList.contains('active') &&
       !document.querySelector('.chart-range-btn[data-range="20"]').classList.contains('active')),
     'and the active class moved with it');
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
  ok(await p.isVisible('#share-profile-btn'), `${theme}: the copy-link button is visible`);
  ok(errs.length === 0, `${theme}: no uncaught errors (${errs[0] ?? ''})`);
  await p.screenshot({ path: `${SHOTS}/profile-${theme}.png`, fullPage: true });
  await p.screenshot({ path: `${SHOTS}/profile-share-${theme}.png`,
                       clip: { x: 0, y: 0, width: 1100, height: 200 } });
  await ctx.close();
}

// ── The copy-link button ──────────────────────────────────────
// PUBLIC_PROFILE is somebody else's public profile (is_owner: false), which
// is the ordinary case here: copying the link to the page you are looking at
// is normal, and that link works, so it carries no caveat. The private case
// below is the owner previewing their own — the only profile this page ever
// renders that nobody else can open.
const ORIGIN    = new URL(BASE).origin;
const SHARE_URL = ORIGIN + '/@hexadecimal';
const MINE_PRIVATE = { ...PUBLIC_PROFILE, is_public: false, is_owner: true };

// Geometry from the live DOM, not markup order: a button that source-order
// says is after the name can still be rendered under it, or off the row.
const GEOM = () => {
  const name = document.getElementById('profile-name');
  const btn  = document.getElementById('share-profile-btn');
  if (!name || !btn) return null;
  const n = name.getBoundingClientRect(), s = btn.getBoundingClientRect();
  return {
    nameLeft: n.left, nameRight: n.right, nameTop: n.top, nameBottom: n.bottom,
    btnLeft: s.left, btnRight: s.right, btnTop: s.top, btnBottom: s.bottom,
    btnW: s.width, btnH: s.height,
  };
};

// The accessible name in each of its two states. An icon button has no text,
// so this IS its label as far as anything but a sighted mouse user is
// concerned, and asserting on it is asserting on the label.
const NAME_IDLE = 'Copy link to profile';
const NAME_DONE = 'Link copied';

const SHAPE = () => {
  const b = document.getElementById('share-profile-btn');
  return {
    tag: b.tagName, type: b.type, text: b.textContent.trim(),
    name: (b.getAttribute('aria-label') || '').trim(),
    title: (b.getAttribute('title') || '').trim(),
    copied: b.classList.contains('is-copied'),
    svgs: b.querySelectorAll('svg').length,
    svgHidden: b.querySelector('svg')?.getAttribute('aria-hidden') === 'true',
  };
};

console.log('[the copy-link button sits to the right of the username]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'none', clipboard: 'ok' });
  const g = await p.evaluate(GEOM);
  ok(g !== null, 'the button is in the DOM beside the <h1>');
  ok(g && g.btnLeft >= g.nameRight - 0.5,
     `its left edge is at or past the name's right edge (${g && g.btnLeft} vs ${g && g.nameRight})`);
  ok(g && g.btnTop < g.nameBottom && g.btnBottom > g.nameTop,
     'and it overlaps that line vertically, so it is beside the name rather than under it');
  ok(g && g.btnLeft - g.nameRight >= 6 && g.btnLeft - g.nameRight <= 24,
     `with a real gap and not a stranded one (${g && (g.btnLeft - g.nameRight).toFixed(1)}px)`);
  // 24px each way is the smallest thing a finger reliably hits. The icon
  // inside is 15px; the padding is what makes the target, so asserting on the
  // icon's own size would pass a control nobody can tap.
  ok(g && g.btnW >= 24 && g.btnH >= 24,
     `the button is at least a 24px tap target (${g && g.btnW}×${g && g.btnH})`);

  // The name is still its own element, and the button is not inside it — the
  // hostile-username block below asserts #profile-name is exactly the name.
  ok(await p.evaluate(() => !document.getElementById('profile-name')
                              .contains(document.getElementById('share-profile-btn'))),
     'the button is a sibling of the name, not part of it');

  const shape = await p.evaluate(SHAPE);
  const focus = await p.evaluate(() => {
    const b = document.getElementById('share-profile-btn');
    b.focus();
    return { tabindex: b.getAttribute('tabindex'), focused: document.activeElement === b };
  });
  ok(shape.tag === 'BUTTON' && shape.type === 'button', 'it is a real <button type=button>');
  ok(shape.svgs === 1, `it draws one inline SVG glyph (got ${shape.svgs})`);
  ok(shape.text === '', `and carries no text label (got "${shape.text}")`);
  ok(shape.svgHidden, 'the glyph is aria-hidden, so the label is not announced twice');
  ok(shape.name === NAME_IDLE, `its accessible name is "${NAME_IDLE}" (got "${shape.name}")`);
  ok(shape.title === NAME_IDLE,
     `and the same words are the hover tooltip, so the glyph is explained (got "${shape.title}")`);
  ok(focus.focused && focus.tabindex === null,
     'it takes keyboard focus and is not removed from the tab order');
  ok(!(await p.isVisible('#share-note')), 'nothing is claimed under it before it is used');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a click copies the absolute /@name URL, confirms, and reverts]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'none', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(200);
  const copied = await p.evaluate(() => window.__copied);
  ok(copied.length === 1, `one clipboard write (got ${copied.length})`);
  ok(copied[0] === SHARE_URL, `of ${SHARE_URL} (got ${copied[0]})`);
  const done = await p.evaluate(SHAPE);
  ok(done.name === NAME_DONE, `the accessible name confirms it (got "${done.name}")`);
  ok(done.copied, 'and the tick state is on the button');
  await p.waitForTimeout(2300);
  const back = await p.evaluate(SHAPE);
  ok(back.name === NAME_IDLE, `it reverts about two seconds later (got "${back.name}")`);
  ok(!back.copied, 'and drops the tick state with it');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// The point of the change: copying is the whole behaviour. A platform share
// sheet is a full-screen modal between a person and the one thing they wanted,
// so the button must not open one even where the API exists.
console.log('[navigator.share is never called, even on a platform that has one]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'ok', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(300);
  ok((await p.evaluate(() => window.__share)).length === 0,
     'the share sheet was not opened');
  const copied = await p.evaluate(() => window.__copied);
  ok(copied.length === 1 && copied[0] === SHARE_URL,
     `the URL went to the clipboard instead (got ${JSON.stringify(copied)})`);
  ok((await p.evaluate(SHAPE)).name === NAME_DONE, 'and the button says so');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[the button works from the keyboard]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'none', clipboard: 'ok' });
  await p.focus('#share-profile-btn');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  const copied = await p.evaluate(() => window.__copied);
  ok(copied.length === 1 && copied[0] === SHARE_URL,
     `Enter on the focused button copies the same URL (got ${JSON.stringify(copied)})`);
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[insecure context: no clipboard -> the URL is still offered, nothing throws]');
{
  const { ctx, p, errs, dialogs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                                 share: 'none', clipboard: 'none' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(300);
  ok(dialogs.length === 1, `one prompt was raised (got ${dialogs.length})`);
  ok(dialogs[0] && dialogs[0].type === 'prompt', 'it is a prompt, so the URL can be selected by hand');
  ok(dialogs[0] && dialogs[0].value === SHARE_URL,
     `carrying ${SHARE_URL} (got ${dialogs[0] && dialogs[0].value})`);
  const shape = await p.evaluate(SHAPE);
  ok(shape.name === NAME_IDLE,
     `and the button does not claim a copy that never happened (got "${shape.name}")`);
  ok(!shape.copied, 'nor show the tick');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[my own private profile says the link works for nobody else]');
{
  const { ctx, p, errs } = await page({ publicProfile: MINE_PRIVATE, percentile: PERCENTILE,
                                        signedIn: true, share: 'none', clipboard: 'ok' });
  ok(await p.isVisible('#owner-banner'), 'the owner banner is up, so this is the private-and-mine case');
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
     'the link was still copied — the caveat does not block the copy');
  ok((await p.evaluate(SHAPE)).name === NAME_DONE, 'and the button still confirms');
  await p.screenshot({ path: `${SHOTS}/profile-share-private.png`,
                       clip: { x: 0, y: 0, width: 1100, height: 300 } });
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log("[somebody else's public profile shares the page, with no caveat]");
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'none', clipboard: 'ok' });
  ok(!(await p.isVisible('#owner-banner')), 'no owner banner — this profile is not mine');
  await p.click('#share-profile-btn');
  await p.waitForTimeout(200);
  ok((await p.evaluate(() => window.__copied))[0] === SHARE_URL, 'the page URL was copied');
  ok(!(await p.isVisible('#share-note')), 'and no caveat is shown');
  ok(((await p.textContent('#share-note')) || '').trim() === '',
     'the note element is empty, not merely hidden');
  ok(!/private/i.test((await p.textContent('.profile-head')) || ''),
     'the word "private" is nowhere in the head');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[no username in the payload -> no copy-link button at all]');
{
  const { ctx, p, errs } = await page({ publicProfile: { ...PUBLIC_PROFILE, username: '' },
                                        percentile: PERCENTILE, share: 'none', clipboard: 'ok' });
  ok(await p.isVisible('#profile-content'), 'the page still rendered');
  ok(await p.evaluate(() => document.getElementById('share-profile-btn') === null),
     'no #share-profile-btn element exists');
  ok(await p.evaluate(() => document.getElementById('share-slot').children.length === 0),
     'the slot is empty rather than holding a disabled control');
  ok(!(await p.isVisible('#share-note')), 'and no note either');
  ok(await p.evaluate(() => document.querySelectorAll('.share-btn').length === 0),
     'and no copy-link control is left anywhere on the page');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a hostile username survives the URL and stays inert]');
{
  const XSS = '"><img src=x onerror=window.__pwned=1>';
  const EXPECTED = ORIGIN + '/@' + encodeURIComponent(XSS);
  const { ctx, p, errs } = await page({
    u: XSS,
    publicProfile: { ...PUBLIC_PROFILE, username: XSS },
    percentile: PERCENTILE,
    share: 'none', clipboard: 'ok',
  });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__pwned !== 1), 'nothing executed');
  ok(await p.evaluate(() => document.querySelectorAll('.profile-wrap img').length === 0),
     'and it did not become an element');
  ok((await p.textContent('#profile-name')) === XSS,
     'the name element still holds exactly the name, and nothing else');
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
  ok((await p.evaluate(SHAPE)).name === NAME_DONE, 'the button behaved normally');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[at 380px the button is beside the name and fully on screen]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'none', clipboard: 'ok',
                                        viewport: { width: 380, height: 900 } });
  const g = await p.evaluate(GEOM);
  ok(g && g.btnRight <= 380, `the button is inside the viewport (right edge ${g && g.btnRight})`);
  ok(g && g.btnLeft >= 0, 'and not off the left of it');
  ok(g && g.btnLeft >= g.nameRight - 0.5 && g.btnTop < g.nameBottom && g.btnBottom > g.nameTop,
     'still on the same line as the name, to its right');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= 380),
     'and nothing it added made the page scroll sideways');
  await p.screenshot({ path: `${SHOTS}/profile-share-380.png`,
                       clip: { x: 0, y: 0, width: 380, height: 260 } });
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

// A 20-character username, the maximum the rules allow, at 28px next to a
// button on a 360px phone. The row has to wrap rather than push the button
// off the screen — and the name must not be truncated to make room.
console.log('[the longest allowed username at 360px keeps both the name and the button on screen]');
{
  const LONG = 'abcdefghijklmnopqrst';
  const { ctx, p, errs } = await page({ u: LONG,
                                        publicProfile: { ...PUBLIC_PROFILE, username: LONG },
                                        percentile: PERCENTILE, share: 'none', clipboard: 'ok',
                                        viewport: { width: 360, height: 900 } });
  const g = await p.evaluate(GEOM);
  ok(g && g.btnRight <= 360 && g.btnLeft >= 0, `the button is on screen (${g && g.btnLeft}–${g && g.btnRight})`);
  ok(g && g.nameRight <= 360, 'so is the whole name');
  ok((await p.textContent('#profile-name')) === LONG, 'and the name is complete, not clipped');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= 360),
     'the page does not scroll sideways');
  await p.screenshot({ path: `${SHOTS}/profile-share-360-long.png`,
                       clip: { x: 0, y: 0, width: 360, height: 260 } });
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
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
