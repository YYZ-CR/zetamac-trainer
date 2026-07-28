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
  // 300s holds the biggest number and, per `history` below, is never played:
  // the Best tile must show 84 at 120s, not 190.
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
  const body = (await p.textContent('body')) || '';
  ok(!/accuracy/i.test(body), 'the word "accuracy" appears nowhere on the public page');
  ok(!body.includes('96.2'), "and neither does the payload's accuracy figure");
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
console.log('[panel order matches the dashboard, minus Recent Games]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE });
  ok(await p.evaluate(ORDERED, ['stat-strip', 'chart-panel', 'ops-panel']),
     'stats → Score Over Time → By Operation, in document order');
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
  ok(await p.isVisible('#share-profile-btn'), `${theme}: the Share button is visible`);
  ok(errs.length === 0, `${theme}: no uncaught errors (${errs[0] ?? ''})`);
  await p.screenshot({ path: `${SHOTS}/profile-${theme}.png`, fullPage: true });
  await p.screenshot({ path: `${SHOTS}/profile-share-${theme}.png`,
                       clip: { x: 0, y: 0, width: 1100, height: 200 } });
  await ctx.close();
}

// ── The Share button ──────────────────────────────────────────
// PUBLIC_PROFILE is somebody else's public profile (is_owner: false), which
// is the ordinary case here: sharing the page you are looking at is normal,
// and that link works, so it carries no caveat. The private case below is the
// owner previewing their own — the only profile this page ever renders that
// nobody else can open.
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

console.log('[the Share button sits to the right of the username]');
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
  ok(g && g.btnW > 40 && g.btnH > 16, `the button has size (${g && g.btnW}×${g && g.btnH})`);

  // The name is still its own element, and the button is not inside it — the
  // hostile-username block below asserts #profile-name is exactly the name.
  ok(await p.evaluate(() => !document.getElementById('profile-name')
                              .contains(document.getElementById('share-profile-btn'))),
     'the button is a sibling of the name, not part of it');

  const shape = await p.evaluate(() => {
    const b = document.getElementById('share-profile-btn');
    b.focus();
    return {
      tag: b.tagName, type: b.type, text: b.textContent.trim(),
      name: (b.getAttribute('aria-label') || b.textContent).trim(),
      tabindex: b.getAttribute('tabindex'),
      focused: document.activeElement === b,
    };
  });
  ok(shape.tag === 'BUTTON' && shape.type === 'button', 'it is a real <button type=button>');
  ok(shape.text === 'Share', `labelled "Share" (got "${shape.text}")`);
  ok(shape.name.length > 1 && !/^[^A-Za-z]+$/.test(shape.name),
     `its accessible name is words, not an icon ("${shape.name}")`);
  ok(shape.focused && shape.tabindex === null,
     'it takes keyboard focus and is not removed from the tab order');
  ok(!(await p.isVisible('#share-note')), 'nothing is claimed under it before it is used');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[navigator.share is used once, with the absolute /@name URL]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'ok', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(300);
  const calls = await p.evaluate(() => window.__share);
  ok(calls.length === 1, `navigator.share was called exactly once (got ${calls.length})`);
  ok(calls[0] && calls[0].url === SHARE_URL,
     `with ${SHARE_URL} (got ${calls[0] && calls[0].url})`);
  ok(calls[0] && calls[0].title === 'hexadecimal — Arithmetic Trainer',
     `and a title naming the profile (got ${JSON.stringify(calls[0] && calls[0].title)})`);
  ok((await p.evaluate(() => window.__copied)).length === 0,
     'the clipboard was left alone — the sheet is the share');
  ok((await p.textContent('#share-profile-btn')).trim() === 'Share',
     'the label does not claim a copy that did not happen');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[the button works from the keyboard]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'ok', clipboard: 'ok' });
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
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'none', clipboard: 'ok' });
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
  const { ctx, p, errs, dialogs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
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
  const { ctx, p, errs, dialogs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                                 share: 'abort', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(400);
  ok((await p.evaluate(() => window.__share)).length === 1, 'the sheet was opened');
  ok((await p.evaluate(() => window.__copied)).length === 0,
     'changing your mind does not copy something you did not ask for');
  ok(dialogs.length === 0, 'and raises no dialog');
  ok(!(await p.isVisible('#share-note')), 'no message is shown at all');
  const head = (await p.textContent('.profile-head')) || '';
  ok(!/couldn't|could not|error|failed|sorry/i.test(head),
     `nothing in the head reads as a failure (got "${head.replace(/\s+/g, ' ').trim()}")`);
  ok((await p.textContent('#share-profile-btn')).trim() === 'Share', 'the label is unchanged');
  ok(errs.length === 0, 'no uncaught errors (' + (errs[0] ?? '') + ')');
  await ctx.close();
}

console.log('[a share that genuinely fails falls back to the clipboard, still without an error]');
{
  const { ctx, p, errs } = await page({ publicProfile: PUBLIC_PROFILE, percentile: PERCENTILE,
                                        share: 'reject', clipboard: 'ok' });
  await p.click('#share-profile-btn');
  await p.waitForTimeout(400);
  const copied = await p.evaluate(() => window.__copied);
  ok(copied.length === 1 && copied[0] === SHARE_URL,
     `the click still ends with the link in hand (got ${JSON.stringify(copied)})`);
  ok((await p.textContent('#share-profile-btn')).trim() === 'Copied!', 'and says so');
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
     'the link was still copied — the caveat does not block the share');
  ok((await p.textContent('#share-profile-btn')).trim() === 'Copied!', 'and the label still confirms');
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

console.log('[no username in the payload -> no Share button at all]');
{
  const { ctx, p, errs } = await page({ publicProfile: { ...PUBLIC_PROFILE, username: '' },
                                        percentile: PERCENTILE, share: 'none', clipboard: 'ok' });
  ok(await p.isVisible('#profile-content'), 'the page still rendered');
  ok(await p.evaluate(() => document.getElementById('share-profile-btn') === null),
     'no #share-profile-btn element exists');
  ok(await p.evaluate(() => document.getElementById('share-slot').children.length === 0),
     'the slot is empty rather than holding a disabled control');
  ok(!(await p.isVisible('#share-note')), 'and no note either');
  ok(!/\bShare\b/.test((await p.textContent('.profile-head')) || ''),
     'the word "Share" appears nowhere in the head');
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
  ok((await p.textContent('#share-profile-btn')).trim() === 'Copied!', 'the button behaved normally');
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
