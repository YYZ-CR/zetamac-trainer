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
//   10 questions, 3 of them fumbled  → accuracy 70%
//   bests 120s → 40, 60s → 30        → two cards, never pooled
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

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});

async function page(o = {}) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/cdn.jsdelivr.net/**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: SUPA(o) }));
  const theme = o.theme || 'dark';
  await p.addInitScript(t => localStorage.setItem('zt_theme', t), theme);
  await p.goto(BASE + '/dashboard.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  return { ctx, p, errs };
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

// ── The strip, from the server payload ────────────────────────
console.log('[the five tiles render the get_public_profile payload]');
{
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE });
  const tiles = await p.evaluate(TILES);
  ok(tiles.length === 5, `exactly five tiles (got ${tiles.length})`);
  ok(JSON.stringify(tiles.map(t => t[1])) ===
     JSON.stringify(['Total Games', 'Questions', 'Accuracy', 'Days Practiced', 'Day Streak']),
     'the labels are the five asked for, in order');
  ok(tiles[0][0] === '1,234',  `Total Games is 1,234 (got ${tiles[0][0]})`);
  ok(tiles[1][0] === '45,678', `Questions is 45,678 (got ${tiles[1][0]})`);
  ok(tiles[2][0] === '96.2%',  `Accuracy is 96.2% (got ${tiles[2][0]})`);
  ok(tiles[3][0] === '87',     `Days Practiced is 87 (got ${tiles[3][0]})`);
  ok(tiles[4][0] === '12',     `Day Streak is 12 (got ${tiles[4][0]})`);

  // 1,234 is not derivable from the three stubbed sessions, so this also
  // proves the dashboard preferred the RPC over its own fallback.
  const called = await p.evaluate(() => window.__rpc.find(c => c[0] === 'get_public_profile'));
  ok(called && called[1].p_username === 'hexadecimal',
     'it looked the profile up by the signed-in username');

  ok(await p.evaluate(() =>
       Array.from(document.querySelectorAll('#best-row .best-card'))
         .map(c => c.textContent.replace(/\s+/g, ' ').trim()).join('|') === '41 60s|84 120s|190 300s'),
     'the best cards are one per duration played, never pooled across durations');
  ok((await p.textContent('#bests-note')).trim() === 'Avg last 3 · 30',
     'the rolling average moved into the bests panel head');
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
  ok(await p.evaluate(ORDERED, ['stat-strip', 'bests-panel', 'chart-panel']),
     'and the bests panel sits between the strip and the chart');
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
  ok(tiles[2][0] === '70%', `Accuracy is 70% (got ${tiles[2][0]})`);
  ok(tiles[3][0] === '3',   `Days Practiced is 3 (got ${tiles[3][0]})`);
  ok(tiles[4][0] === '3',   `Day Streak is 3 (got ${tiles[4][0]})`);
  ok(await p.evaluate(() => !window.__rpc.some(c => c[0] === 'get_public_profile')),
     'no profile lookup is attempted without a username');
  ok((await p.textContent('#stats-note')).includes('computed from the games loaded'),
     'and the page says the figures came from the loaded games');
  ok(await p.evaluate(() =>
       Array.from(document.querySelectorAll('#best-row .best-card'))
         .map(c => c.textContent.replace(/\s+/g, ' ').trim()).join('|') === '30 60s|40 120s'),
     'the bests are the per-duration maxima of the loaded sessions');

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
  const { ctx, p, errs } = await page({ profileRow: { id: 'u1', username: 'hexadecimal' },
                                        sessions: SESSIONS, publicProfile: PUBLIC_PROFILE, theme });
  ok(await p.isVisible('#stat-strip'), `${theme}: the strip is visible`);
  ok(errs.length === 0, `${theme}: no uncaught errors (${errs[0] ?? ''})`);
  await p.screenshot({ path: `${SHOTS}/dashboard-${theme}.png`, fullPage: true });
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
