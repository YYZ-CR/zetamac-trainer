// The first-run walkthrough. Contract: docs/walkthrough-design.md.
//
// Someone arriving for the first time sees a configuration screen and a Start
// button. Nothing on it says the run will be analysed afterwards, that there is
// a daily puzzle everyone plays, or that duels and leagues exist — every feature
// that makes this different from Zetamac is *behind* a run they have not done.
//
// Four things about this file are load-bearing:
//
//   1. The step list is ONE array. Adding a feature means adding one object to
//      TOUR_STEPS, never editing markup. test/browser/tour.mjs asserts the
//      rendered step count equals its length, so a feature shipped without a
//      step fails a test rather than quietly going undescribed.
//   2. A step MAY name a `target` selector, and a step that does gets a
//      spotlight: the scrim is punched through around that element and the
//      panel moves next to it with a caret. `target` is optional, and a step
//      whose target cannot be resolved falls back to exactly the centred
//      layout that preceded this — see tourLayout(). Never a hole around
//      nothing, never a caret pointing at nothing.
//   3. Nothing renders until localStorage has been read. A returning visitor
//      must not see a flash or a layout shift, so the seen check runs before the
//      element exists rather than hiding it afterwards.
//   4. The copy is static. It is written here as literal HTML with no
//      interpolation at all; if that ever changes, escapeHtml() from js/util.js
//      goes around every interpolated value.
//
// No build step: classic script, one global scope. Every top-level name here is
// prefixed tour/TOUR, because a duplicate top-level const anywhere across the
// loaded scripts is a SyntaxError that blanks the whole page.

// Bumping this shows the tour again to everyone who dismissed an older one.
// Bump it when the tour materially changes — a new step, a step that now
// describes something different. Do NOT bump it for a typo fix: a tour that
// reappears for no reason trains people to dismiss it unread.
const TOUR_VERSION = '1';
const TOUR_KEY     = 'zt_tour_seen';

// Ordered by what is most different from the thing they already know, not by
// what is biggest. Six, because a seventh is where people start clicking Skip.
//
// `target` is a CSS selector for the thing on the page the step is talking
// about. It is OPTIONAL: a step without one — or with one that does not resolve
// on this page, in this session — renders centred over a flat scrim, which is
// what every step did before spotlighting existed. The nav targets live in a
// header js/auth.js builds after a session lookup, so they are frequently not
// there yet at the instant the tour opens; tourResolve() waits for them.
const TOUR_STEPS = [
  {
    title: 'It tells you why',
    target: '#start-btn',
    html: `
      <p>Every question is timed to the millisecond, so a finished run is not a bare
         number. You get a graph of your pace through the run, a per-question
         breakdown, and the technique that would have saved the time.</p>
      <p class="tour-example"><strong>84 &divide; 7</strong> &rarr; 70 &divide; 7 = 10,
         14 &divide; 7 = 2, <strong>= 12</strong></p>`,
  },
  {
    title: 'Practise what you are worst at',
    target: 'a[href="practice.html"]',
    html: `
      <p>Practice mode weights your weakest question types higher, so drilling goes
         where the time is actually being lost rather than where it is comfortable.</p>`,
  },
  {
    title: 'Zetamac Daily',
    target: 'a[href="daily.html"]',
    html: `
      <p>One puzzle a day, the same questions for everyone, one attempt. It resets at
         midnight UTC.</p>
      <p>The shared sequence is what makes a leaderboard defensible: the usual
         objection to any arithmetic ranking is &ldquo;you got easier problems&rdquo;,
         and this removes it.</p>`,
  },
  {
    title: 'Duels',
    target: '#top-bar a[href="duel.html"]',
    html: `
      <p>Send a link. You both answer the same sequence, neither of you sees a score
         until you are both done, and it ends on a pace graph of both runs. No account
         is needed to accept one.</p>
      <p>Or play that same link live in <strong>steal mode</strong>: the first correct
         answer takes the point and both of you jump to the next question.</p>`,
  },
  {
    title: 'Private leagues',
    target: '#top-bar a[href="leagues.html"]',
    html: `
      <p>An invite code, a named group, and a board over the day&rsquo;s puzzle &mdash;
         today, the week&rsquo;s average, or best ever.</p>
      <p>Being 3rd of 6 behind people you know beats being 4,000th behind strangers.</p>`,
  },
  {
    title: 'A profile worth sharing',
    target: '#top-bar a[href="dashboard.html"]',
    html: `
      <p>Your own page at <code>/@you</code>, with a per-operation breakdown
         (+&nbsp;1.42s &middot; &minus;&nbsp;1.66s &middot; &times;&nbsp;1.98s &middot;
         &divide;&nbsp;2.31s), a percentile, and a share card drawn in whichever theme
         you are using.</p>
      <p>It stays private until you turn it on in Settings.</p>`,
  },
];

let tourIndex      = 0;
let tourReturnFocus = null;   // whatever had focus before the tour took it

// ── Spotlight state ───────────────────────────────────────────
// tourAnchor is the element the CURRENT step is pointing at, or null for a
// centred step. tourResolveToken invalidates an in-flight retry loop when the
// step changes under it: without it, a slow nav resolving after somebody has
// already pressed Next would move the hole onto the previous step's target.
let tourAnchor       = null;
let tourResolveToken = 0;
let tourRaf          = 0;     // pending requestAnimationFrame for a re-layout

const TOUR_HOLE_PAD   = 6;    // breathing room around the target
const TOUR_GAP        = 12;   // hole to panel
const TOUR_EDGE       = 12;   // panel to viewport edge
const TOUR_CARET      = 12;   // caret square, before rotation
const TOUR_RESOLVE_MS = 600;  // how long to wait for a nav js/auth.js builds
const TOUR_RETRY_MS   = 40;

// A target that is missing, detached, display:none or zero-sized is *absent*,
// not "present but small". getBoundingClientRect() is already 0×0 for
// display:none, so the size check covers most of it; visibility is checked
// because a visibility:hidden element still measures.
function tourTargetEl(selector) {
  if (!selector) return null;
  let el = null;
  try { el = document.querySelector(selector); } catch (_) { return null; }
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  try { if (getComputedStyle(el).visibility === 'hidden') return null; } catch (_) {}
  return el;
}

// Bring the target on screen before anything is measured. A rect read while the
// target is below the fold sizes the hole from where the element is *now* and
// the page then scrolls out from under it.
function tourScrollIntoView(el) {
  const r  = el.getBoundingClientRect();
  const vh = document.documentElement.clientHeight;
  const vw = document.documentElement.clientWidth;
  const inView = r.top >= TOUR_EDGE && r.bottom <= vh - TOUR_EDGE &&
                 r.left >= 0 && r.right <= vw;
  if (inView) return;
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { el.scrollIntoView(); }
}

// The header is rendered by js/auth.js once a session lookup comes back, so on
// a cold load the nav targets do not exist at the instant the tour opens. Poll
// briefly, then give up and stay centred — a hole around nothing is worse than
// no hole.
function tourResolve(step) {
  const token = ++tourResolveToken;
  tourAnchor  = null;

  if (!step.target) { tourLayout(); return; }

  const settle = el => {
    if (token !== tourResolveToken) return;      // the step moved on without us
    tourAnchor = el;
    tourScrollIntoView(el);
    // One frame for the scroll and any reflow it caused, a second because the
    // first fires before layout has necessarily settled. Measuring earlier
    // sizes the hole from a stale rect.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token === tourResolveToken) tourLayout();
    }));
  };

  // The common case: it is already there, and laying out synchronously avoids a
  // frame of centred panel before it jumps to the target.
  const now = tourTargetEl(step.target);
  if (now) { tourAnchor = now; tourLayout(); settle(now); return; }

  tourLayout();                                   // centred while we wait
  const deadline = Date.now() + TOUR_RESOLVE_MS;
  const attempt = () => {
    if (token !== tourResolveToken) return;
    if (!document.getElementById('tour-overlay')) return;
    const el = tourTargetEl(step.target);
    if (el) { settle(el); return; }
    if (Date.now() < deadline) setTimeout(attempt, TOUR_RETRY_MS);
  };
  setTimeout(attempt, TOUR_RETRY_MS);
}

function tourRemoveHole() {
  const hole = document.getElementById('tour-hole');
  if (hole) hole.remove();
  const overlay = document.getElementById('tour-overlay');
  if (overlay) overlay.classList.remove('tour-overlay--spot');
}

function tourRemoveCaret() {
  const caret = document.getElementById('tour-caret');
  if (caret) caret.remove();
}

// The panel goes back to being a centred flex item. Called for a step with no
// target, for a target that never resolved, and for a narrow viewport where no
// side of the target has room — in the last case the hole stays lit.
function tourCentrePanel(panel) {
  panel.classList.remove('tour-modal--anchored');
  panel.style.left = '';
  panel.style.top  = '';
  tourRemoveCaret();
}

// Everything about where the hole and the panel sit, derived from scratch from
// the live rect every time. There is no incremental state to get out of step
// with the page, which is what makes resize and scroll handling a re-call.
function tourLayout() {
  const overlay = document.getElementById('tour-overlay');
  if (!overlay) return;
  const panel = overlay.querySelector('.tour-modal');
  if (!panel) return;

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  const el   = tourAnchor && tourAnchor.isConnected ? tourAnchor : null;
  const rect = el ? el.getBoundingClientRect() : null;

  // No target, or a target that has since gone: exactly the old behaviour.
  //
  // The centre test is the third case and it is not theoretical: the header is
  // a single non-wrapping row, so on a narrow viewport in the wider of the two
  // themes its left-most link is pushed off the left edge with no scroll
  // container to bring it back. A hole around a sliver of an element nobody can
  // see is a hole around nothing.
  const offScreen = rect && (rect.left + rect.width  / 2 < 0 ||
                             rect.top  + rect.height / 2 < 0 ||
                             rect.left + rect.width  / 2 > vw ||
                             rect.top  + rect.height / 2 > vh);
  if (!rect || rect.width < 1 || rect.height < 1 || offScreen) {
    tourRemoveHole();
    tourCentrePanel(panel);
    return;
  }

  // The hole. The darkness is the shadow, not a background, so the hole itself
  // is genuinely transparent rather than a lighter patch of scrim.
  let hole = document.getElementById('tour-hole');
  if (!hole) {
    hole = document.createElement('div');
    hole.id = 'tour-hole';
    hole.className = 'tour-hole';
    hole.setAttribute('aria-hidden', 'true');
    // First child: the panel is later in the document and therefore paints on
    // top of the hole's shadow. Appending the hole last would bury the panel.
    overlay.insertBefore(hole, overlay.firstChild);
  }
  overlay.classList.add('tour-overlay--spot');
  const hx = rect.left   - TOUR_HOLE_PAD;
  const hy = rect.top    - TOUR_HOLE_PAD;
  const hw = rect.width  + TOUR_HOLE_PAD * 2;
  const hh = rect.height + TOUR_HOLE_PAD * 2;
  hole.style.left   = hx + 'px';
  hole.style.top    = hy + 'px';
  hole.style.width  = hw + 'px';
  hole.style.height = hh + 'px';

  // The panel. Measure it in its anchored width, which is not its centred one.
  panel.classList.add('tour-modal--anchored');
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;

  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;

  // Below, then above, then beside. Below first because a panel under the thing
  // it describes reads in the same direction as the sentence pointing at it.
  let place = '', px = 0, py = 0;
  if (hy + hh + TOUR_GAP + ph <= vh - TOUR_EDGE) {
    place = 'below'; py = hy + hh + TOUR_GAP; px = cx - pw / 2;
  } else if (hy - TOUR_GAP - ph >= TOUR_EDGE) {
    place = 'above'; py = hy - TOUR_GAP - ph; px = cx - pw / 2;
  } else if (hx + hw + TOUR_GAP + pw <= vw - TOUR_EDGE) {
    place = 'right'; px = hx + hw + TOUR_GAP; py = cy - ph / 2;
  } else if (hx - TOUR_GAP - pw >= TOUR_EDGE) {
    place = 'left';  px = hx - TOUR_GAP - pw; py = cy - ph / 2;
  }

  // Nowhere to put it: centred panel, hole still lit. On a short viewport this
  // is the honest answer, and it is still better than the flat scrim because
  // the thing being described is the only lit part of the page.
  if (!place) { tourCentrePanel(panel); return; }

  px = Math.max(TOUR_EDGE, Math.min(px, vw - TOUR_EDGE - pw));
  py = Math.max(TOUR_EDGE, Math.min(py, vh - TOUR_EDGE - ph));
  panel.style.left = Math.round(px) + 'px';
  panel.style.top  = Math.round(py) + 'px';

  // The caret. It only exists if it can actually point at the target: after
  // clamping, the panel edge it sits on has to span the target's centre.
  const vertical = place === 'below' || place === 'above';
  const along    = vertical ? cx - px : cy - py;
  const span     = vertical ? pw : ph;
  if (along < TOUR_CARET || along > span - TOUR_CARET) { tourRemoveCaret(); return; }

  let caret = document.getElementById('tour-caret');
  if (!caret) {
    caret = document.createElement('div');
    caret.id = 'tour-caret';
    caret.setAttribute('aria-hidden', 'true');
    panel.appendChild(caret);
  }
  // The caret points back at the target, so it sits on the opposite side of the
  // panel from the direction the panel was placed.
  const dir = place === 'below' ? 'up' : place === 'above' ? 'down'
            : place === 'right' ? 'left' : 'right';
  caret.className = 'tour-caret tour-caret--' + dir;
  caret.style.left = caret.style.top = '';
  const offset = Math.round(along - TOUR_CARET / 2) + 'px';
  if (vertical) caret.style.left = offset;
  else          caret.style.top  = offset;
}

// resize and scroll both invalidate every number above, and both fire in
// bursts. One re-layout per frame is enough and keeps the hole glued to the
// target instead of trailing it.
function tourViewportChanged() {
  if (tourRaf) return;
  tourRaf = requestAnimationFrame(() => { tourRaf = 0; tourLayout(); });
}

// ── Seen state ────────────────────────────────────────────────
// The value stored is the version, not `true`, so bumping TOUR_VERSION brings
// the tour back for people who saw an older one. Any other value — a stale
// version, junk, a half-written string — counts as not seen, which fails
// towards showing a tour rather than towards silently never showing it again.
//
// localStorage rather than a profiles column: most first-time visitors have no
// account, which is what "first-time" means, so a column would miss exactly the
// people this is for. The cost is that it reappears on a second device.
function tourSeen() {
  try { return localStorage.getItem(TOUR_KEY) === TOUR_VERSION; }
  catch (_) { return false; }
}

function tourMarkSeen() {
  try { localStorage.setItem(TOUR_KEY, TOUR_VERSION); } catch (_) {}
}

// ── The dialog ────────────────────────────────────────────────
function tourBuild() {
  if (document.getElementById('tour-overlay')) return document.getElementById('tour-overlay');

  const overlay = document.createElement('div');
  overlay.className = 'tour-overlay';
  overlay.id = 'tour-overlay';
  // No interpolation anywhere in here: every value is a literal in this file.
  overlay.innerHTML = `
    <div class="tour-modal" role="dialog" aria-modal="true" aria-labelledby="tour-heading">
      <button class="tour-close" id="tour-close" type="button" aria-label="Close">&times;</button>
      <div class="tour-eyebrow">A quick tour</div>
      <h2 class="tour-title" id="tour-heading"></h2>
      <div class="tour-body" id="tour-body"></div>
      <div class="tour-dots" id="tour-dots" aria-hidden="true"></div>
      <div class="tour-controls">
        <button class="tour-skip" id="tour-skip" type="button">Skip</button>
        <div class="tour-nav">
          <span class="tour-counter" id="tour-counter" aria-live="polite"></span>
          <button class="tour-back" id="tour-back" type="button">Back</button>
          <button class="tour-next" id="tour-next" type="button">Next</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('tour-close').addEventListener('click', () => tourClose());
  document.getElementById('tour-skip').addEventListener('click',  () => tourClose());
  document.getElementById('tour-back').addEventListener('click',  () => tourGo(tourIndex - 1));
  document.getElementById('tour-next').addEventListener('click',  () => {
    if (tourIndex >= TOUR_STEPS.length - 1) tourClose();
    else tourGo(tourIndex + 1);
  });
  // Backdrop only: a click that started inside the panel must not close it.
  overlay.addEventListener('click', e => { if (e.target === overlay) tourClose(); });

  return overlay;
}

function tourRender() {
  const step = TOUR_STEPS[tourIndex];
  document.getElementById('tour-heading').textContent = step.title;
  document.getElementById('tour-body').innerHTML      = step.html;
  document.getElementById('tour-counter').textContent = `${tourIndex + 1} / ${TOUR_STEPS.length}`;

  const back = document.getElementById('tour-back');
  back.disabled = tourIndex === 0;

  const next = document.getElementById('tour-next');
  const last = tourIndex === TOUR_STEPS.length - 1;
  // "Start playing", never "Sign up" — the tour's job is to get somebody to
  // their first run, and an account is not needed for one.
  next.textContent = last ? 'Start playing' : 'Next';

  // The dots are drawn from the array too, so they cannot disagree with it.
  document.getElementById('tour-dots').innerHTML =
    TOUR_STEPS.map((_, i) => `<span class="tour-dot${i === tourIndex ? ' active' : ''}"></span>`).join('');

  // Last, because the panel's height depends on the copy just written into it
  // and the placement depends on that height.
  tourResolve(step);
}

function tourGo(i) {
  tourIndex = Math.max(0, Math.min(TOUR_STEPS.length - 1, i));
  tourRender();
}

// ── Keyboard ──────────────────────────────────────────────────
// Bound on document while open and removed on close, so Esc works wherever
// focus has wandered and nothing is left listening once the tour is gone.
function tourKeydown(e) {
  if (e.key === 'Escape')     { e.preventDefault(); tourClose(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); tourGo(tourIndex + 1); return; }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); tourGo(tourIndex - 1); return; }
  if (e.key !== 'Tab') return;

  // Keep Tab inside the dialog: it is aria-modal, and a focus ring wandering
  // onto the configuration form behind it would say otherwise.
  const modal = document.querySelector('#tour-overlay .tour-modal');
  if (!modal) return;
  const items = Array.from(modal.querySelectorAll('button:not([disabled])'));
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ── Open / close ──────────────────────────────────────────────
function tourOpen() {
  tourIndex = 0;
  tourBuild();
  tourRender();
  tourReturnFocus = document.activeElement;
  document.addEventListener('keydown', tourKeydown, true);
  // Capture on scroll so a scrolling container, not just the window, moves the
  // hole with its target. Passive: neither handler calls preventDefault.
  window.addEventListener('resize', tourViewportChanged, { passive: true });
  window.addEventListener('scroll', tourViewportChanged, { passive: true, capture: true });
  // Focus the primary action rather than the panel, so Enter and Space do the
  // obvious thing the moment it opens.
  const next = document.getElementById('tour-next');
  if (next) next.focus();
}

// Every route out of the tour comes through here, which is what makes "there is
// no way to close it that does not mark it seen" true by construction. A tour
// half-read is a tour someone chose to stop reading.
function tourClose() {
  tourMarkSeen();
  document.removeEventListener('keydown', tourKeydown, true);
  window.removeEventListener('resize', tourViewportChanged, { passive: true });
  window.removeEventListener('scroll', tourViewportChanged, { passive: true, capture: true });
  if (tourRaf) { cancelAnimationFrame(tourRaf); tourRaf = 0; }
  // Invalidates any retry loop still waiting for a nav that has not appeared.
  tourResolveToken++;
  tourAnchor = null;
  const overlay = document.getElementById('tour-overlay');
  if (overlay) overlay.remove();
  try { if (tourReturnFocus && tourReturnFocus.focus) tourReturnFocus.focus(); } catch (_) {}
  tourReturnFocus = null;
}

// ── Wiring ────────────────────────────────────────────────────
// Home page only. Someone landing on /duel.html?d=… came for a specific duel and
// a product tour in front of it is an obstacle. currentPageFile() comes from
// js/auth.js, which every page loads before this one; the check is belt and
// braces, since only index.html includes this script.
function tourOnHomePage() {
  try {
    if (currentPageFile() !== 'index.html') return false;
    // ?key=… is a shared configuration link. Somebody followed it to play
    // that configuration, the same way somebody follows /duel.html?d=… to
    // play that duel — and a product tour in front of either is an obstacle
    // rather than a welcome. The footer link is still there for them.
    return !new URLSearchParams(location.search).get('key');
  } catch (_) { return false; }
}

document.addEventListener('DOMContentLoaded', () => {
  // The footer link is the way back in after a dismissal, so it is wired
  // whether or not the tour itself is going to open.
  const link = document.getElementById('tour-link');
  if (link) link.addEventListener('click', e => { e.preventDefault(); tourOpen(); });

  // The seen check runs BEFORE anything is built. A returning player gets no
  // element, no paint and no layout shift — not a hidden one.
  if (tourSeen() || !tourOnHomePage()) return;
  tourOpen();
});
