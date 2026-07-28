// The first-run walkthrough. Written against docs/walkthrough-design.md, before
// js/tour.js existed, so the eight numbered points in that document's "The test"
// section are the eight sections below.
//
// The assertion the whole feature turns on is section 2: it must not appear on a
// second visit. That is driven by a genuinely persisted localStorage across a real
// reload in the same browser context, never by a page variable — a page variable
// would pass while every returning visitor still got the modal.
//
// The DOM contract this file and js/tour.js are both built against:
//   #tour-overlay   the backdrop; absent from the DOM entirely when seen
//   .tour-modal     role=dialog, aria-modal=true, aria-labelledby=tour-heading
//   #tour-heading   the current step's title
//   #tour-body      the current step's copy
//   #tour-counter   "N / M"
//   #tour-back  #tour-next  #tour-skip  #tour-close   the controls
//   #tour-link      the footer "How this works" link, which re-opens it
//   #tour-hole      the spotlight, present ONLY for a step with a live target
//   #tour-caret     the panel's pointer, present ONLY when it points at one
//   localStorage['zt_tour_seen'] === TOUR_VERSION means seen
//
// Sections 9-13 cover the spotlight. Every geometric assertion there reads both
// rects out of the live DOM and compares them to each other — never against a
// number copied from the CSS, which would pass just as happily if the hole were
// pinned to the wrong element at the right size.
import { chromium } from 'playwright';
import fs from 'fs';

const EXE   = process.env.ZT_CHROMIUM || undefined;
// Serve with `python3 -m http.server`, NOT `npx serve` — serve's clean-URLs
// default strips the query string on its /page.html -> /page redirect.
const BASE  = process.env.ZT_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.ZT_SHOTS || '/tmp/shots';
const KEY   = 'zt_tour_seen';

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log('  pass:', label); }
                           else { fail++; console.log('  FAIL:', label); } };

// Signed-out Supabase + Chart.js stub. The tour must not depend on either, so
// this is deliberately the thinnest one in the suite: if the tour needs more
// than this to render, it has grown a network dependency it should not have.
const CDN = `
window.supabase = { createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser:    async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
    signOut: async () => ({ error: null }),
  },
  from: () => ({ select(){return this}, eq(){return this}, is(){return this},
                 order(){return this}, limit(){return this},
                 single: async () => ({ data: null, error: { message: 'stub' } }),
                 maybeSingle: async () => ({ data: null, error: null }),
                 insert: async () => ({ error: null }), update: async () => ({ error: null }),
                 upsert: async () => ({ error: null }),
                 then(r){ r({ data: [], error: null, count: 0 });
                          return Promise.resolve({ data: [], error: null, count: 0 }); } }),
  rpc: async () => ({ data: null, error: { message: 'stub' } }),
}) };
window.Chart = function(){ this.destroy=function(){}; this.update=function(){}; this.data={datasets:[{}]}; this.options={scales:{x:{ticks:{}}}}; };
window.Chart.defaults = { font: {} };
`;

// Records whether #tour-overlay was EVER attached to the document, not just
// whether it is there when we look. "No flash, no layout shift" is a claim about
// the whole lifetime of the page, and a tour that renders and then hides itself
// would satisfy a naive querySelector check while still flashing.
const WATCH = `(() => {
  window.__tourEverRendered = false;
  const hit = n => n && n.nodeType === 1 &&
    (n.id === 'tour-overlay' || (n.querySelector && n.querySelector('#tour-overlay')));
  const obs = new MutationObserver(ms => {
    for (const m of ms) for (const n of m.addedNodes) if (hit(n)) window.__tourEverRendered = true;
  });
  obs.observe(document.documentElement || document, { childList: true, subtree: true });
})();`;

const DESKTOP = { width: 1100, height: 900 };
const MOBILE  = { width: 390,  height: 844 };

async function newContext(browser, { theme = 'dark', seen = undefined, viewport = DESKTOP } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route('**/cdn.jsdelivr.net/**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: CDN }));
  // Seeded once, on the FIRST navigation only. An init script runs on every
  // navigation, so seeding (or clearing) the key unconditionally would reset it
  // on the reload that section 2 turns on — the tour would look broken, or
  // worse, look fixed. A fresh context starts with empty storage anyway.
  await ctx.addInitScript(([t, k, s, watch]) => {
    localStorage.setItem('zt_theme', t);
    if (s !== null && !localStorage.getItem('__seeded')) {
      localStorage.setItem(k, s);
      localStorage.setItem('__seeded', '1');
    }
    eval(watch);
  }, [theme, KEY, seen ?? null, WATCH]);
  return ctx;
}

const errorsOf = page => { const e = []; page.on('pageerror', x => e.push(String(x))); return e; };

async function open(ctx, path = '/index.html') {
  const page = await ctx.newPage();
  const errors = errorsOf(page);
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(350);
  return { page, errors };
}

const shown   = page => page.evaluate(() => !!document.getElementById('tour-overlay'));
const stored  = page => page.evaluate(k => localStorage.getItem(k), KEY);
const counter = page => page.textContent('#tour-counter');
const heading = page => page.textContent('#tour-heading');

// Live geometry, read at the moment of the assertion. Rounded to a tenth so a
// sub-pixel layout difference does not read as a failure while a genuine
// mis-anchoring of even two pixels still does.
const rectOf = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const n = v => Math.round(v * 10) / 10;
  return { x: n(r.left), y: n(r.top), w: n(r.width), h: n(r.height) };
}, sel);

// The spotlight has to sit on the target, not merely be the right size. Both
// rects come from the DOM; only the padding comes from the page's own constant.
function holeMatches(hole, target, pad, tol = 2) {
  if (!hole || !target) return false;
  return Math.abs(hole.x - (target.x - pad))        <= tol &&
         Math.abs(hole.y - (target.y - pad))        <= tol &&
         Math.abs(hole.w - (target.w + pad * 2))    <= tol &&
         Math.abs(hole.h - (target.h + pad * 2))    <= tol;
}

const fmt = r => r ? `${r.x},${r.y} ${r.w}x${r.h}` : 'none';

// Walk to a step from wherever the tour currently is. Steps are only reachable
// by pressing Next, which is also what a person does, so the spotlight is being
// asserted against the same code path they exercise.
async function goToStep(page, n) {
  for (let i = 1; i < n; i++) await page.click('#tour-next');
  await page.waitForTimeout(250);   // scroll + the two settle frames
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

  // The step array is the source of truth for everything below.
  let STEPS = [], TARGETS = [], HOLE_PAD = 0;
  {
    const ctx = await newContext(browser);
    const { page } = await open(ctx);
    STEPS    = await page.evaluate(() => TOUR_STEPS.map(s => s.title));
    TARGETS  = await page.evaluate(() => TOUR_STEPS.map(s => s.target || null));
    HOLE_PAD = await page.evaluate(() => TOUR_HOLE_PAD);
    const V  = await page.evaluate(() => TOUR_VERSION);
    console.log(`[targets] ${TARGETS.map((t, i) => `${i + 1}:${t ?? '(none)'}`).join('  ')}`);
    ok(typeof HOLE_PAD === 'number' && HOLE_PAD > 0,
       `TOUR_HOLE_PAD is a positive number (${HOLE_PAD}) — the spotlight's breathing room`);
    console.log(`[step array] TOUR_VERSION=${V}, ${STEPS.length} steps: ${STEPS.join(' | ')}`);
    ok(Array.isArray(STEPS) && STEPS.length === 6,
       `the step array holds exactly six steps (got ${STEPS.length}) — a seventh is a decision, not an accident`);
    ok(STEPS.every(t => typeof t === 'string' && t.length > 0), 'every step has a title');
    ok(typeof V === 'string' && V.length > 0, 'TOUR_VERSION is a non-empty string');
    await ctx.close();
  }

  // ── 1. Appears on a first visit, at step 1 ───────────────────
  {
    console.log('[1. first visit]');
    const ctx = await newContext(browser);
    const { page, errors } = await open(ctx);
    ok(await shown(page), 'the tour is rendered on a first visit to index.html');
    ok((await heading(page)).trim() === STEPS[0], `step 1 is showing ("${(await heading(page)).trim()}")`);
    ok((await counter(page)).replace(/\s+/g, '') === `1/${STEPS.length}`,
       `the counter reads 1 / ${STEPS.length}`);
    const a11y = await page.evaluate(() => {
      const d = document.querySelector('.tour-modal');
      return d && { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'),
                    labelledby: d.getAttribute('aria-labelledby'),
                    hasLabel: !!document.getElementById(d.getAttribute('aria-labelledby')) };
    });
    ok(a11y && a11y.role === 'dialog', 'role="dialog"');
    ok(a11y && a11y.modal === 'true', 'aria-modal="true"');
    ok(a11y && a11y.labelledby === 'tour-heading' && a11y.hasLabel, 'labelled by its own heading');
    const focused = await page.evaluate(() => {
      const d = document.querySelector('.tour-modal');
      return !!(d && document.activeElement && d.contains(document.activeElement));
    });
    ok(focused, 'focus moved into the dialog on open');
    // Merely appearing must not mark it seen — otherwise a page someone never
    // read is a page they can never get back except through the footer link.
    ok((await stored(page)) === null, 'appearing alone does not mark it seen');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    ok(await shown(page), 'an undismissed tour comes back on the next load');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ── 2. Does not appear on the second visit ───────────────────
  // The one the feature turns on. Same context, real reload, real localStorage.
  {
    console.log('[2. second visit]');
    const ctx = await newContext(browser);
    const { page, errors } = await open(ctx);
    ok(await shown(page), 'visit one: shown');
    await page.click('#tour-skip');
    await page.waitForTimeout(150);
    const v = await stored(page);
    const version = await page.evaluate(() => TOUR_VERSION);
    ok(v === version, `dismissal stores the version, not "true" (stored "${v}")`);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    ok(!(await shown(page)), 'visit two: NOT shown');
    ok(!(await page.evaluate(() => window.__tourEverRendered)),
       'visit two: never attached to the DOM at all — no flash, no layout shift');

    // A brand-new page in the same context, i.e. the same origin storage.
    const p2 = await ctx.newPage();
    await p2.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    await p2.waitForTimeout(400);
    ok(!(await shown(p2)), 'a fresh tab in the same context does not show it either');
    ok(!(await p2.evaluate(() => window.__tourEverRendered)), 'fresh tab: never attached');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ── 3. Every dismissal route marks it seen and stays gone ────
  {
    console.log('[3. dismissal routes]');
    const routes = [
      ['Esc',        async p => { await p.keyboard.press('Escape'); }],
      ['close (×)',  async p => { await p.click('#tour-close'); }],
      ['Skip',       async p => { await p.click('#tour-skip'); }],
      ['backdrop',   async p => { await p.mouse.click(6, 6); }],
      ['finishing',  async p => { for (let i = 1; i < STEPS.length; i++) await p.click('#tour-next');
                                  await p.click('#tour-next'); }],
    ];
    for (const [label, act] of routes) {
      const ctx = await newContext(browser);
      const { page, errors } = await open(ctx);
      const before = await shown(page);
      await act(page);
      await page.waitForTimeout(200);
      const after   = await shown(page);
      const version = await page.evaluate(() => TOUR_VERSION);
      ok(before && !after, `${label}: closes the tour`);
      ok((await stored(page)) === version, `${label}: marks it seen`);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(350);
      ok(!(await shown(page)), `${label}: stays gone after a reload`);
      ok(errors.length === 0, `${label}: no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }
    // Half-read is still read: dismissing from a middle step marks it seen.
    const ctx = await newContext(browser);
    const { page } = await open(ctx);
    await page.click('#tour-next');
    await page.click('#tour-next');
    ok((await counter(page)).replace(/\s+/g, '') === `3/${STEPS.length}`, 'walked to step 3');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok((await stored(page)) === (await page.evaluate(() => TOUR_VERSION)),
       'dismissing on step 3 still marks it seen');
    await ctx.close();
  }

  // ── 4. Next / Back walk the steps, counter matches ───────────
  {
    console.log('[4. navigation]');
    const ctx = await newContext(browser);
    const { page, errors } = await open(ctx);

    ok(await page.evaluate(() => document.getElementById('tour-back').disabled),
       'Back is disabled on step 1');

    const seenTitles = [(await heading(page)).trim()];
    for (let i = 1; i < STEPS.length; i++) {
      await page.click('#tour-next');
      await page.waitForTimeout(60);
      seenTitles.push((await heading(page)).trim());
      ok((await counter(page)).replace(/\s+/g, '') === `${i + 1}/${STEPS.length}`,
         `Next reaches step ${i + 1} and the counter says so`);
    }
    ok(JSON.stringify(seenTitles) === JSON.stringify(STEPS),
       'the rendered step count and order equal the step array exactly');
    ok(seenTitles.length === STEPS.length,
       `${STEPS.length} rendered steps for ${STEPS.length} array entries — a feature without a step would fail here`);
    ok(/start playing/i.test(await page.textContent('#tour-next')),
       'the last step\'s primary action is "Start playing", not "Sign up"');
    ok(await shown(page), 'reaching the last step does not itself close the tour');

    // Back walks it in reverse.
    for (let i = STEPS.length - 1; i >= 1; i--) {
      await page.click('#tour-back');
      await page.waitForTimeout(60);
      ok((await heading(page)).trim() === STEPS[i - 1], `Back reaches step ${i}`);
    }
    ok(await page.evaluate(() => document.getElementById('tour-back').disabled),
       'Back is disabled again at step 1');
    ok((await stored(page)) === null, 'walking the steps has not marked it seen yet');

    // Arrow keys.
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(60);
    ok((await heading(page)).trim() === STEPS[1], 'ArrowRight advances a step');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(60);
    ok((await heading(page)).trim() === STEPS[0], 'ArrowLeft goes back a step');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(60);
    ok((await heading(page)).trim() === STEPS[0], 'ArrowLeft at step 1 stays on step 1');

    // The copy is static and must never arrive as markup.
    const bodyHtml = await page.evaluate(() => document.getElementById('tour-body').innerHTML);
    ok(!/<script|onerror=|javascript:/i.test(bodyHtml), 'no script or inline handler in the step copy');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ── 5. index.html only ───────────────────────────────────────
  {
    console.log('[5. other pages]');
    for (const pg of ['dashboard.html', 'daily.html', 'duel.html', 'leagues.html', 'practice.html']) {
      const ctx = await newContext(browser);
      const { page, errors } = await open(ctx, '/' + pg);
      ok(!(await shown(page)), `${pg}: no tour`);
      ok(!(await page.evaluate(() => window.__tourEverRendered)), `${pg}: never attached`);
      ok((await stored(page)) === null, `${pg}: does not write the seen flag either`);
      ok(errors.length === 0, `${pg}: no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // A shared configuration link is the home page by URL and not by
    // intention: somebody followed it to play that configuration, exactly as
    // somebody follows /duel.html?d=… to play that duel.
    {
      const ctx = await newContext(browser);
      const { page, errors } = await open(ctx, '/index.html?key=abc123');
      ok(!(await shown(page)), 'index.html?key=… : no tour in front of a shared config');
      ok(!(await page.evaluate(() => window.__tourEverRendered)), 'and it never attached');
      ok((await stored(page)) === null, 'and it did not burn the seen flag either');
      ok(await page.isVisible('#tour-link'), 'the footer link is still offered there');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }
  }

  // ── 6. The footer link re-opens it ───────────────────────────
  {
    console.log('[6. footer link]');
    const ctx = await newContext(browser);
    const { page, errors } = await open(ctx);
    await page.click('#tour-skip');
    await page.waitForTimeout(150);
    ok(!(await shown(page)), 'starting state: dismissed');
    ok(await page.isVisible('#tour-link'), 'the footer offers "How this works"');
    ok(/how this works/i.test(await page.textContent('#tour-link')), 'and says so in those words');
    await page.click('#tour-link');
    await page.waitForTimeout(200);
    ok(await shown(page), 'the footer link re-opens the tour after dismissal');
    ok((await heading(page)).trim() === STEPS[0], 're-opens at step 1');
    ok(!(await page.evaluate(() => window.location.hash)), 'the link does not leave a #hash behind');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok(!(await shown(page)), 'and closes again');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ── 7. A stale stored version shows it again ─────────────────
  {
    console.log('[7. versioning]');
    const ctx = await newContext(browser, { seen: '0.0-old' });
    const { page, errors } = await open(ctx);
    ok(await shown(page), 'a stored value that is not the current TOUR_VERSION shows the tour again');
    await page.click('#tour-skip');
    await page.waitForTimeout(150);
    ok((await stored(page)) === (await page.evaluate(() => TOUR_VERSION)),
       'dismissing overwrites the stale value with the current version');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();

    // The exact current version is the only value that suppresses it.
    const ctx2 = await newContext(browser);
    const probe = await ctx2.newPage();
    await probe.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    const version = await probe.evaluate(() => TOUR_VERSION);
    await probe.close();
    await ctx2.close();

    const ctx3 = await newContext(browser, { seen: version });
    const { page: p3 } = await open(ctx3);
    ok(!(await shown(p3)), 'the current version stored suppresses it');
    ok(!(await p3.evaluate(() => window.__tourEverRendered)), 'and it never renders');
    await ctx3.close();

    // A junk value is treated as "not seen" rather than throwing.
    const ctx4 = await newContext(browser, { seen: '{"broken":' });
    const { page: p4, errors: e4 } = await open(ctx4);
    ok(await shown(p4), 'a junk stored value shows the tour rather than breaking');
    ok(e4.length === 0, `junk value: no uncaught page errors (${e4[0] ?? ''})`);
    await ctx4.close();
  }

  // ── 8. Both themes, no errors, and screenshots to look at ────
  {
    console.log('[8. themes]');
    for (const theme of ['zetamac', 'dark']) {
      const ctx = await newContext(browser, { theme });
      const { page, errors } = await open(ctx);
      ok(await shown(page), `${theme}: tour renders`);

      // A panel that renders blank while reporting success has happened twice in
      // this project, so assert on the ink actually being there.
      const box = await page.evaluate(() => {
        const m = document.querySelector('.tour-modal');
        const r = m.getBoundingClientRect();
        const cs = getComputedStyle(m);
        return { w: r.width, h: r.height, bg: cs.backgroundColor, fg: cs.color,
                 text: (m.innerText || '').replace(/\s+/g, ' ').trim() };
      });
      ok(box.w > 260 && box.h > 160, `${theme}: the panel has real size (${Math.round(box.w)}x${Math.round(box.h)})`);
      ok(box.text.length > 120, `${theme}: the panel has real copy (${box.text.length} chars)`);
      ok(box.bg !== box.fg, `${theme}: text colour differs from the panel fill (${box.fg} on ${box.bg})`);
      ok(!/rgba\(0, 0, 0, 0\)/.test(box.bg), `${theme}: the panel has an opaque fill, not the page showing through`);
      await page.screenshot({ path: `${SHOTS}/tour-${theme}-first.png` });

      for (let i = 1; i < STEPS.length; i++) await page.click('#tour-next');
      await page.waitForTimeout(120);
      ok((await heading(page)).trim() === STEPS[STEPS.length - 1], `${theme}: reached the last step`);
      await page.screenshot({ path: `${SHOTS}/tour-${theme}-last.png` });

      // Every colour must come from a token: no literal hex in the tour rules.
      ok(errors.length === 0, `${theme}: no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // The stylesheet itself: tour rules must not carry hardcoded colours.
    const css = fs.readFileSync(new URL('../../css/style.css', import.meta.url), 'utf8');
    const tourBlock = css.split('\n').reduce((acc, line, i, all) => {
      if (/^\.tour-|^#tour-|^\.site-footer/.test(line)) acc.push(all.slice(i, i + 12).join('\n'));
      return acc;
    }, []).join('\n');
    ok(tourBlock.length > 0, 'the stylesheet has tour rules');
    const hexes = (tourBlock.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter(h => !/^#tour/.test(h));
    ok(hexes.length === 0, `no hardcoded hex in the tour's CSS (found ${hexes.join(', ')})`);
  }

  // ── 9. The hole sits on the target it is describing ──────────
  // Both rects out of the live DOM. A hole of the right size in the wrong place
  // is the failure mode this whole section exists for, so every assertion
  // compares position as well as size.
  {
    console.log('[9. the spotlight lands on its target]');
    for (const theme of ['zetamac', 'dark']) {
      const ctx = await newContext(browser, { theme });
      const { page, errors } = await open(ctx);

      let previous = null;
      for (let i = 0; i < STEPS.length; i++) {
        if (i > 0) { await page.click('#tour-next'); await page.waitForTimeout(250); }
        const sel = TARGETS[i];
        if (!sel) continue;
        const target = await rectOf(page, sel);
        const hole   = await rectOf(page, '#tour-hole');
        ok(target !== null, `${theme}: step ${i + 1}'s target resolves (${sel})`);
        ok(hole !== null, `${theme}: step ${i + 1} draws a hole`);
        ok(holeMatches(hole, target, HOLE_PAD),
           `${theme}: step ${i + 1}'s hole is on ${sel} — hole ${fmt(hole)} vs target ${fmt(target)}`);
        // Requirement 2: Next moves it. Without this, a hole that never updated
        // would satisfy the match above on step 1 and silently fail thereafter.
        if (previous) ok(Math.abs(hole.x - previous.x) > 2 || Math.abs(hole.y - previous.y) > 2,
                         `${theme}: step ${i + 1}'s hole moved off step ${i}'s target`);
        previous = hole;
      }

      // The hole is decoration: it must not eat the click that dismisses.
      const pe = await page.evaluate(() =>
        getComputedStyle(document.getElementById('tour-hole')).pointerEvents);
      ok(pe === 'none', `${theme}: the hole is pointer-events:none (${pe})`);
      const holeRect = await rectOf(page, '#tour-hole');
      await page.mouse.click(Math.round(holeRect.x + holeRect.w / 2),
                             Math.round(holeRect.y + holeRect.h / 2));
      await page.waitForTimeout(150);
      ok(!(await shown(page)), `${theme}: a click on the lit target still dismisses the tour`);
      ok((await stored(page)) === (await page.evaluate(() => TOUR_VERSION)),
         `${theme}: and that dismissal marks it seen like any other`);
      ok(errors.length === 0, `${theme}: no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }
  }

  // ── 10. A step with no target is the old centred layout ──────
  {
    console.log('[10. a step with no target]');
    const ctx = await newContext(browser);
    const { page, errors } = await open(ctx);
    // Take the target away from step 1 and re-render it: the data model has to
    // allow a step with none, and that step is the pre-spotlight behaviour.
    await page.evaluate(() => { delete TOUR_STEPS[0].target; tourGo(0); });
    await page.waitForTimeout(400);
    ok(await shown(page), 'the tour is still up');
    ok(!(await page.evaluate(() => !!document.getElementById('tour-hole'))),
       'a step with no target renders NO hole element at all');
    ok(!(await page.evaluate(() => !!document.getElementById('tour-caret'))),
       'and no caret');
    ok(!(await page.evaluate(() =>
          document.querySelector('.tour-modal').classList.contains('tour-modal--anchored'))),
       'and the panel is not anchored — it is the centred layout');
    const centred = await page.evaluate(() => {
      const r = document.querySelector('.tour-modal').getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      return { dx: Math.abs((r.left + r.right) / 2 - vw / 2),
               dy: Math.abs((r.top + r.bottom) / 2 - vh / 2) };
    });
    ok(centred.dx < 3 && centred.dy < 3,
       `and it really is centred (off by ${Math.round(centred.dx)}, ${Math.round(centred.dy)})`);
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ── 11. A target that cannot be resolved ─────────────────────
  // The nav is built by js/auth.js off a session lookup, so "the target is not
  // there" is the normal case for a fraction of a second and a permanent one if
  // the markup ever moves. Forced here by deleting the element first.
  {
    console.log('[11. an unresolvable target]');
    const ctx = await newContext(browser);
    const { page, errors } = await open(ctx);
    const sel = TARGETS.find(t => t);
    ok(!!sel, 'at least one step names a target');

    await page.click('#tour-close');
    await page.waitForTimeout(120);
    await page.evaluate(s => { const el = document.querySelector(s); if (el) el.remove(); }, sel);
    ok((await rectOf(page, sel)) === null, `${sel} is gone from the page`);

    await page.click('#tour-link');
    // Longer than the resolve window: the point is that it gives up and stays
    // centred rather than retrying forever or drawing a hole around nothing.
    await page.waitForTimeout(1200);
    ok(await shown(page), 'the tour still opens with its target missing');
    ok((await heading(page)).trim() === STEPS[0], 'on step 1');
    ok(!(await page.evaluate(() => !!document.getElementById('tour-hole'))),
       'no hole is drawn around the element that is not there');
    ok(!(await page.evaluate(() => !!document.getElementById('tour-caret'))),
       'and no caret is drawn pointing at it');
    ok(!(await page.evaluate(() =>
          document.querySelector('.tour-modal').classList.contains('tour-modal--anchored'))),
       'the panel falls back to centred');
    // And the step after it, whose target is still there, still spotlights.
    await page.click('#tour-next');
    await page.waitForTimeout(300);
    if (TARGETS[1]) {
      const t = await rectOf(page, TARGETS[1]);
      const h = await rectOf(page, '#tour-hole');
      ok(holeMatches(h, t, HOLE_PAD),
         `a missing target on step 1 does not break step 2's spotlight (${fmt(h)} vs ${fmt(t)})`);
    }
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ── 12. The panel is never clipped ───────────────────────────
  // Desktop and a narrow phone. On the phone some steps legitimately fall back
  // to the centred layout — the header does not wrap, so its left-most link can
  // be off the left edge — and that is fine; being inside the viewport is not.
  {
    console.log('[12. the panel stays in the viewport]');
    for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
      const ctx = await newContext(browser, { viewport });
      const { page, errors } = await open(ctx);
      for (let i = 0; i < STEPS.length; i++) {
        if (i > 0) { await page.click('#tour-next'); await page.waitForTimeout(250); }
        const fit = await page.evaluate(() => {
          const r  = document.querySelector('.tour-modal').getBoundingClientRect();
          const vw = document.documentElement.clientWidth;
          const vh = document.documentElement.clientHeight;
          return { ok: r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5,
                   r: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
                   vw, vh };
        });
        ok(fit.ok, `${label}: step ${i + 1}'s panel is fully inside the viewport ` +
                   `(${fit.r.join(',')} in ${fit.vw}x${fit.vh})`);
        // A caret is only ever drawn when there is a hole for it to point at.
        const pair = await page.evaluate(() => ({
          hole:  !!document.getElementById('tour-hole'),
          caret: !!document.getElementById('tour-caret'),
        }));
        ok(!pair.caret || pair.hole,
           `${label}: step ${i + 1} never has a caret without a hole`);
      }
      ok(errors.length === 0, `${label}: no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }
  }

  // ── 13. Resize and scroll keep the hole on the target ────────
  {
    console.log('[13. resize and scroll]');
    const ctx = await newContext(browser);
    const { page, errors } = await open(ctx);
    const step = TARGETS.findIndex(t => t) + 1;
    await goToStep(page, step);

    const before = await rectOf(page, '#tour-hole');
    ok(before !== null, `step ${step} starts with a hole (${fmt(before)})`);

    await page.setViewportSize({ width: 780, height: 700 });
    await page.waitForTimeout(300);
    const t1 = await rectOf(page, TARGETS[step - 1]);
    const h1 = await rectOf(page, '#tour-hole');
    ok(h1 !== null, 'the hole survives a resize');
    ok(holeMatches(h1, t1, HOLE_PAD),
       `after a resize the hole is still on its target (${fmt(h1)} vs ${fmt(t1)})`);
    // The target moved, so a hole that had simply been left alone would fail.
    ok(Math.abs(h1.x - before.x) > 2 || Math.abs(h1.y - before.y) > 2,
       'and it actually moved with the target rather than being left behind');

    // Scrolling the page underneath it must do the same. Short enough that the
    // document genuinely scrolls — at a taller viewport this whole page fits and
    // scrollBy() is a no-op, which would make the assertion below prove nothing.
    await page.setViewportSize({ width: 780, height: 420 });
    await page.waitForTimeout(250);
    await page.evaluate(() => window.scrollBy(0, 100));
    await page.waitForTimeout(300);
    const sy = await page.evaluate(() => window.scrollY);
    ok(sy > 0, `the page really scrolled (scrollY ${sy}) — a no-op scroll would prove nothing`);
    const t2 = await rectOf(page, TARGETS[step - 1]);
    const h2 = await rectOf(page, '#tour-hole');
    ok(holeMatches(h2, t2, HOLE_PAD),
       `after a scroll the hole is still on its target (${fmt(h2)} vs ${fmt(t2)})`);
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
