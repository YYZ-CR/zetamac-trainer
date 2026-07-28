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
//   localStorage['zt_tour_seen'] === TOUR_VERSION means seen
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

async function newContext(browser, { theme = 'dark', seen = undefined } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
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

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

  // The step array is the source of truth for everything below.
  let STEPS = [];
  {
    const ctx = await newContext(browser);
    const { page } = await open(ctx);
    STEPS   = await page.evaluate(() => TOUR_STEPS.map(s => s.title));
    const V = await page.evaluate(() => TOUR_VERSION);
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

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
