// The first-run walkthrough. Contract: docs/walkthrough-design.md.
//
// Someone arriving for the first time sees a configuration screen and a Start
// button. Nothing on it says the run will be analysed afterwards, that there is
// a daily puzzle everyone plays, or that duels and leagues exist — every feature
// that makes this different from Zetamac is *behind* a run they have not done.
//
// Three things about this file are load-bearing:
//
//   1. The step list is ONE array. Adding a feature means adding one object to
//      TOUR_STEPS, never editing markup. test/browser/tour.mjs asserts the
//      rendered step count equals its length, so a feature shipped without a
//      step fails a test rather than quietly going undescribed.
//   2. Nothing renders until localStorage has been read. A returning visitor
//      must not see a flash or a layout shift, so the seen check runs before the
//      element exists rather than hiding it afterwards.
//   3. The copy is static. It is written here as literal HTML with no
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
const TOUR_STEPS = [
  {
    title: 'It tells you why',
    html: `
      <p>Every question is timed to the millisecond, so a finished run is not a bare
         number. You get a graph of your pace through the run, a per-question
         breakdown, and the technique that would have saved the time.</p>
      <p class="tour-example"><strong>84 &divide; 7</strong> &rarr; 70 &divide; 7 = 10,
         14 &divide; 7 = 2, <strong>= 12</strong></p>`,
  },
  {
    title: 'Practise what you are worst at',
    html: `
      <p>Practice mode weights your weakest question types higher, so drilling goes
         where the time is actually being lost rather than where it is comfortable.</p>`,
  },
  {
    title: 'Zetamac Daily',
    html: `
      <p>One puzzle a day, the same questions for everyone, one attempt. It resets at
         midnight UTC.</p>
      <p>The shared sequence is what makes a leaderboard defensible: the usual
         objection to any arithmetic ranking is &ldquo;you got easier problems&rdquo;,
         and this removes it.</p>`,
  },
  {
    title: 'Duels',
    html: `
      <p>Send a link. You both answer the same sequence, neither of you sees a score
         until you are both done, and it ends on a pace graph of both runs. No account
         is needed to accept one.</p>
      <p>Or play that same link live in <strong>steal mode</strong>: the first correct
         answer takes the point and both of you jump to the next question.</p>`,
  },
  {
    title: 'Private leagues',
    html: `
      <p>An invite code, a named group, and a board over the day&rsquo;s puzzle &mdash;
         today, the week&rsquo;s average, or best ever.</p>
      <p>Being 3rd of 6 behind people you know beats being 4,000th behind strangers.</p>`,
  },
  {
    title: 'A profile worth sharing',
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
