import { chromium } from 'playwright';

// The header at phone widths.
//
// `.top-bar` was a single non-wrapping right-aligned flex row. On a 406px
// screen it began "y | Duel | Leagues | …" — Play, the link back to the game,
// was sliced in half and pushed off the LEFT edge, where nothing can scroll it
// back. The fix is one media query at the end of css/style.css: the bar wraps,
// centres, drops the "|" separators and grows a 44px tap target.
//
// The load-bearing assertion is §1 — every nav item's rect inside the
// viewport. Section 8 is a negative control: it neutralises the media query at
// runtime and requires §1's check to FAIL, so a suite that passes because it
// is measuring nothing cannot go green.

const EXE  = process.env.ZT_CHROMIUM;
const BASE = process.env.ZT_BASE || 'http://127.0.0.1:8120';

// Must match `@media (max-width: 700px)` in css/style.css. Derived there from
// the measured single-row width — 430px in the Zetamac theme, 516px in the
// dark theme, whose body font is monospace — plus headroom.
const BREAKPOINT = 700;
// The tap target the media query settles on.
const MIN_TAP = 44;

const WIDTHS  = [360, 390, 406, 480, 700, 1200];
const THEMES  = ['zetamac', 'dark'];
// index.html renders Play as the current-page <span>; every other page renders
// it as a real <a href="index.html">. Both must be reachable, and only the
// second can be followed, so both are in the matrix.
const PAGES   = ['index.html', 'dashboard.html'];
// Every page that has a top bar, swept once at the narrowest width.
const ALL_PAGES = ['index.html', 'dashboard.html', 'daily.html', 'duel.html',
  'leagues.html', 'practice.html', 'profile.html?u=x', 'results.html',
  'settings.html', 'privacy.html', 'terms.html'];

const SUPA = (signedIn) => `(function(){window.supabase={createClient:()=>({
 auth:{getSession:async()=>({data:{session:${signedIn ? "{user:{id:'u1',email:'a@b.c'}}" : 'null'}},error:null}),
   getUser:async()=>({data:{user:${signedIn ? "{id:'u1',email:'a@b.c'}" : 'null'}}}),
   onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},
 from:()=>({select(){return this},eq(){return this},is(){return this},order(){return this},limit(){return this},
   single:async()=>({data:null,error:{message:'x'}}),maybeSingle:async()=>({data:null,error:null}),
   insert:async()=>({error:null}),update:async()=>({error:null}),upsert:async()=>({error:null}),
   then(r){r({data:[],error:null,count:0});return Promise.resolve({data:[],error:null,count:0});}}),
 rpc:async()=>({data:null,error:{message:'no fn'}})})};
window.Chart=function(){this.destroy=()=>{};this.update=()=>{};this.data={datasets:[{},{}]};this.options={scales:{x:{ticks:{}}}};};
window.Chart.defaults={font:{}};})();`;

// Undoes the media query without touching the stylesheet, for section 8.
const UNFIX = `@media (max-width: ${BREAKPOINT}px){
  .top-bar{flex-wrap:nowrap!important;justify-content:flex-end!important;gap:8px!important;padding:10px 15px 0!important}
  .top-bar .sep{display:inline!important}
  .top-bar a,.top-bar .nav-current,.top-bar .link-btn{display:inline!important;min-height:0!important;padding:0!important;font-size:13px!important}
}`;

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : (fail++, console.log('  FAIL:', l)); };

// Read the bar back out of the page. Returns one record per nav item — the
// children of #top-bar that are not separators — plus the separators' computed
// display, the document's scroll width, and a hit test at each item's centre.
const READ_BAR = () => {
  const bar = document.getElementById('top-bar');
  if (!bar) return { missing: true };
  const kids = [...bar.children];
  const seps = kids.filter(el => el.classList.contains('sep'));
  const items = kids.filter(el => !el.classList.contains('sep'));
  const rec = el => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      label: el.textContent.trim(),
      tag: el.tagName,
      href: el.getAttribute('href'),
      cls: el.className,
      left: +r.left.toFixed(2), right: +r.right.toFixed(2),
      top: +r.top.toFixed(2), height: +r.height.toFixed(2), width: +r.width.toFixed(2),
      centreInside: cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight,
      hitSelf: !!hit && (hit === el || el.contains(hit)),
      hitLabel: hit ? (hit.textContent || '').trim().slice(0, 20) : null,
    };
  };
  return {
    items: items.map(rec),
    sepCount: seps.length,
    sepDisplays: seps.map(s => getComputedStyle(s).display),
    sepWidths: seps.map(s => +s.getBoundingClientRect().width.toFixed(2)),
    iw: innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    barHeight: +bar.getBoundingClientRect().height.toFixed(2),
    wrap: getComputedStyle(bar).flexWrap,
  };
};

const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

async function load(pg, { width, theme, signedIn, unfix = false }) {
  const ctx = await browser.newContext({ viewport: { width, height: 720 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e.message || e)));
  await p.route('**/cdn.jsdelivr.net/**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: SUPA(signedIn) }));
  await p.addInitScript(t => {
    // The walkthrough modal would otherwise cover the header on index.html and
    // make every hit test return the overlay.
    localStorage.setItem('zt_tour_seen', '2');
    localStorage.setItem('zt_theme', t);
  }, theme);
  await p.goto(BASE + '/' + pg, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  if (unfix) await p.addStyleTag({ content: UNFIX });
  await p.waitForTimeout(60);
  const bar = await p.evaluate(READ_BAR);
  await ctx.close();
  return { bar, errors };
}

const expectedLabels = (signedIn, theme, pg) => {
  const nav = ['Play', 'Duel', 'Leagues', 'Dashboard'];
  if (signedIn) nav.push('Settings');
  nav.push(signedIn ? 'Log out' : 'Log in');
  if (!signedIn) nav.push('Register');
  nav.push(theme === 'dark' ? 'Light' : 'Dark');
  return nav;
};

// ── 1–6. The matrix ──────────────────────────────────────────
for (const theme of THEMES) {
  for (const signedIn of [true, false]) {
    for (const pg of PAGES) {
      for (const width of WIDTHS) {
        const tag = `${pg} ${width}px ${theme} signed-${signedIn ? 'in' : 'out'}`;
        const { bar, errors } = await load(pg, { width, theme, signedIn });
        if (bar.missing) { ok(false, `${tag}: no #top-bar`); continue; }

        const narrow = width <= BREAKPOINT;

        // The bar is what we think it is. Without this every assertion below
        // could pass on an empty header.
        const want = expectedLabels(signedIn, theme, pg);
        ok(JSON.stringify(bar.items.map(i => i.label)) === JSON.stringify(want),
          `${tag}: items are [${bar.items.map(i => i.label)}], want [${want}]`);
        ok(bar.sepCount === want.length - 1,
          `${tag}: ${bar.sepCount} separators, want ${want.length - 1}`);

        // §1. Every nav item fully inside the viewport. This is the assertion
        // the bug failed: Play sat at left = -33 on a 360px screen.
        for (const it of bar.items) {
          ok(it.left >= -0.01, `${tag}: "${it.label}" left=${it.left} is off the left edge`);
          ok(it.right <= bar.iw + 0.01, `${tag}: "${it.label}" right=${it.right} exceeds innerWidth=${bar.iw}`);
          ok(it.width > 0 && it.height > 0, `${tag}: "${it.label}" has no box`);
        }

        // §2. No horizontal document scroll.
        ok(bar.docScrollWidth <= bar.iw,
          `${tag}: documentElement.scrollWidth=${bar.docScrollWidth} > innerWidth=${bar.iw}`);

        // §4. Tap targets below the breakpoint.
        if (narrow) {
          for (const it of bar.items) {
            ok(it.height >= MIN_TAP,
              `${tag}: "${it.label}" is ${it.height}px tall, want >= ${MIN_TAP}`);
          }
        }

        // §5. Separators hidden below the breakpoint, visible above it.
        if (narrow) {
          ok(bar.sepDisplays.every(d => d === 'none'),
            `${tag}: separators still displayed (${[...new Set(bar.sepDisplays)]})`);
          ok(bar.sepWidths.every(w => w === 0),
            `${tag}: hidden separators still occupy width (${bar.sepWidths})`);
        } else {
          ok(bar.sepDisplays.every(d => d !== 'none'),
            `${tag}: separators hidden above the breakpoint`);
          ok(bar.sepWidths.every(w => w > 0),
            `${tag}: visible separators have zero width (${bar.sepWidths})`);
        }

        // Row geometry. Items sharing a top are one row.
        const rows = [...new Set(bar.items.map(i => Math.round(i.top)))].sort((a, b) => a - b);
        if (narrow) {
          // Wrapped rows are centred, not still flush right — a ragged left
          // edge reads as the overflow bug this replaces.
          for (const top of rows) {
            const row = bar.items.filter(i => Math.round(i.top) === top);
            const gapL = Math.min(...row.map(i => i.left));
            const gapR = bar.iw - Math.max(...row.map(i => i.right));
            ok(Math.abs(gapL - gapR) <= 2,
              `${tag}: row at y=${top} is not centred (left gap ${gapL.toFixed(1)}, right gap ${gapR.toFixed(1)})`);
          }
          // Two rows at 360px, one from ~480px up. A row per item would satisfy
          // everything above and look broken.
          ok(rows.length <= 2, `${tag}: header wrapped onto ${rows.length} rows`);
          ok(bar.wrap === 'wrap', `${tag}: flex-wrap is ${bar.wrap}`);
        } else {
          // §6. Nothing regresses on the desktop: one row, flush right, the
          // original compact height.
          ok(rows.length === 1, `${tag}: desktop header is on ${rows.length} rows`);
          const gapR = bar.iw - Math.max(...bar.items.map(i => i.right));
          ok(gapR >= 14 && gapR <= 17, `${tag}: right gap ${gapR.toFixed(1)}, want the 15px padding`);
          ok(bar.wrap === 'nowrap', `${tag}: flex-wrap is ${bar.wrap} above the breakpoint`);
          ok(bar.barHeight <= 30, `${tag}: desktop bar is ${bar.barHeight}px tall`);
        }

        // §3. Play is hit-testable at its centre, and on a page that is not
        // index.html it is a real link to the game.
        const play = bar.items[0];
        ok(play.label === 'Play', `${tag}: first item is "${play.label}"`);
        ok(play.hitSelf,
          `${tag}: elementFromPoint at Play's centre returned "${play.hitLabel}"`);
        if (pg === 'index.html') {
          ok(play.tag === 'SPAN' && /nav-current/.test(play.cls),
            `${tag}: Play on index.html should be the current-page span, got ${play.tag}.${play.cls}`);
        } else {
          ok(play.tag === 'A' && play.href === 'index.html',
            `${tag}: Play should link to index.html, got ${play.tag} href=${play.href}`);
        }

        // The tour's second victim: js/tour.js treats a target whose centre is
        // outside the viewport as absent, so an off-screen Duel link silently
        // downgraded that step to a centred panel.
        for (const it of bar.items) {
          ok(it.centreInside, `${tag}: "${it.label}" centre is outside the viewport`);
        }

        // §7.
        ok(errors.length === 0, `${tag}: page errors ${JSON.stringify(errors)}`);
      }
    }
  }
}

// ── Every page with a header, at the narrowest width ─────────
console.log('\n--- all pages at 360px ---');
for (const pg of ALL_PAGES) {
  const { bar, errors } = await load(pg, { width: 360, theme: 'dark', signedIn: true });
  if (bar.missing) { ok(false, `${pg}: no #top-bar`); continue; }
  const inside = bar.items.every(i => i.left >= -0.01 && i.right <= bar.iw + 0.01);
  ok(bar.items.length === 7, `${pg} @360: ${bar.items.length} nav items, want 7`);
  ok(inside, `${pg} @360: an item is outside the viewport`);
  ok(bar.docScrollWidth <= bar.iw, `${pg} @360: horizontal scroll (${bar.docScrollWidth} > ${bar.iw})`);
  ok(bar.items.every(i => i.height >= MIN_TAP), `${pg} @360: a tap target is under ${MIN_TAP}px`);
  ok(errors.length === 0, `${pg} @360: page errors ${JSON.stringify(errors)}`);
  console.log(`  ${pg.padEnd(20)} rows=${new Set(bar.items.map(i => Math.round(i.top))).size} barH=${bar.barHeight}`);
}

// ── 8. Negative control ──────────────────────────────────────
// The media query is neutralised at runtime and §1 must go red. If this
// section reports the layout is fine, §1 is not measuring anything.
console.log('\n--- negative control: media query neutralised ---');
for (const theme of THEMES) {
  for (const signedIn of [true, false]) {
    const { bar } = await load('dashboard.html', { width: 360, theme, signedIn, unfix: true });
    const offscreen = bar.items.filter(i => i.left < -0.01 || i.right > bar.iw + 0.01);
    ok(offscreen.length > 0,
      `control ${theme} signed-${signedIn ? 'in' : 'out'}: without the media query nothing overflowed — §1 proves nothing`);
    ok(bar.items.every(i => i.height < MIN_TAP),
      `control ${theme} signed-${signedIn ? 'in' : 'out'}: tap targets were already >= ${MIN_TAP}px without the fix`);
    console.log(`  ${theme.padEnd(8)} signed-${signedIn ? 'in ' : 'out'}: ` +
      `${offscreen.length} item(s) off-screen, first is "${bar.items[0].label}" at left=${bar.items[0].left}`);
  }
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
