// Duels — duel.html
//
// Send someone a link. You both answer the same sequence. Compare. The page is
// a small state machine over what get_duel_by_key says has happened, and it is
// deliberately the same machine daily.html runs — a server-supplied question
// list, a server-supplied clock, resume-on-refresh, submit-on-expiry — because
// it is the same problem.
//
//   no ?d=          → create a duel: pick a duration, get a link, copy it.
//                     Signed-in only; somebody has to own a duel.
//   not played yet  → who is playing, the rules, an irreversible Start.
//   in progress     → the run, resumed from the server's remaining time.
//   you done, them  → "waiting for them", YOUR score only, the link again.
//     not done
//   both done       → the verdict and the pace graph.
//   expired         → a walkover is not a win. Say which it was.
//   third arrival   → this duel already has two players.
//   unknown key /   → a readable page, never a blank one.
//     no migration
//
// Three rules run through all of it:
//
//   * The clock is the server's. seconds_remaining from start_duel_run is
//     anchored to a wall-clock deadline (the way js/game.js and js/daily.js do
//     it) so a background tab cannot hand out extra time, and a refresh
//     mid-run picks up the real remaining time rather than starting over.
//   * The score is the server's. This file counts answers so the HUD has
//     something to show, but that count is labelled "Answered", never shown as
//     a result, and never substituted for what submit_duel_run returns.
//   * Nobody sees a score until both sides are done. Every score this page
//     renders for the OTHER player is gated on the payload's `scores_revealed`
//     flag, never on "the field happened to be non-null" — knowing the target
//     turns a run into a chase.
//
// Nothing here is user-controlled text today: supabase/duels.sql deliberately
// returns no usernames (a duel is a link, not a directory). The duel key comes
// from the URL, though, and it does reach innerHTML — so it goes through
// escapeHtml() like everything else, and so would a username the day the
// payload carries one.

const DUEL_DURATIONS      = [60, 120, 180, 300];
const DUEL_DRAFT_PREFIX   = 'zt_duel_draft_';
const DUEL_RESULT_PREFIX  = 'zt_duel_result_';

// A projection off one or two answers is meaningless, and so is one
// extrapolated from under five seconds. Same gates, same reasoning, as
// renderRunGraph() in js/results.js.
const DUEL_WARMUP_Q   = 3;
const DUEL_WARMUP_SEC = 5;

// ── State ─────────────────────────────────────────────────────

let duelKey       = '';     // from ?d= or /d/<key>
let duelPayload   = null;   // last get_duel_by_key payload
let duelRun       = null;   // { key, side, duration, startedAt, questions }
let duelAnswers   = [];     // [{ i, value, elapsed_ms }] — what gets submitted
let duelIndex     = 0;      // questions committed correctly, i.e. the current one
let duelCurrent   = null;   // { display, operation, answer }
let duelWrongLogged = false;

// performance.now() reading that corresponds to the start of the run, derived
// from the server's seconds_remaining — not from when this page loaded.
let duelRunOrigin = null;
let duelDeadline  = null;

let duelTimer       = null;
let duelExpiryTimer = null;
let duelInputWired  = false;

let duelSubmitting = false;
let duelSubmitted  = false;

let duelChart      = null;
let duelChartInput = null;  // last renderDuelPace() argument, for the theme rebuild

// Which user the current view was built for. `undefined` means never resolved,
// which is distinct from null (resolved, signed out).
let duelViewUserId = undefined;
let duelResolving  = false;

// ── URL ───────────────────────────────────────────────────────

// duel.html?d=<key>, or the clean /d/<key> a rewrite would serve. The clean
// form has to be read from the PATHNAME: a server-side rewrite is invisible to
// the browser, location.search is empty, and a page that only looked at the
// query string would render "create a duel" to somebody who followed an
// invite. Same shape as readUsernameFromUrl() in js/profile.js.
function readDuelKeyFromUrl() {
  const q = new URLSearchParams(window.location.search).get('d');
  if (q && q.trim()) return q.trim();

  const m = window.location.pathname.match(/^\/d\/([^/]+)\/?$/);
  if (!m) return '';
  // decodeURIComponent throws on a malformed escape (a bare '%' in the path),
  // which would otherwise take the whole page down before it renders.
  try {
    return decodeURIComponent(m[1]).trim();
  } catch (_) {
    return m[1].trim();
  }
}

function duelUrlFor(key) {
  try {
    return window.location.origin + '/duel.html?d=' + encodeURIComponent(key);
  } catch (_) {
    return 'duel.html?d=' + encodeURIComponent(key);
  }
}

// ── Boot ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const topBar = document.getElementById('top-bar');

  // The auth bar is decoration: a broken client must not stop the page from
  // rendering a readable explanation of why the duel is unavailable.
  try {
    createAuthModal();
    let user = null;
    try {
      user = await initAuth({
        onAuthChange: (u) => { renderAuthBar(u, topBar); onDuelAuthChange(u); },
      });
    } catch (e) { console.warn('initAuth failed:', e); }
    renderAuthBar(user, topBar);
  } catch (e) {
    console.warn('auth bar unavailable:', e);
    if (typeof renderThemeToggle === 'function') renderThemeToggle(topBar);
  }

  duelKey = readDuelKeyFromUrl();
  await resolveDuelState();
});

// Logging in or out changes which state applies — a signed-out visitor cannot
// create a duel, and signing in mid-page changes which side they are. Never
// while a run is live, though: re-resolving would tear the game out from under
// a player, and there is only one run per side.
function onDuelAuthChange(user) {
  const id = user ? user.id : null;
  if (duelRunLive()) return;
  if (id === duelViewUserId) return;   // onAuthStateChange also fires on load
  resolveDuelState();
}

// ── State machine ─────────────────────────────────────────────

async function resolveDuelState() {
  if (duelResolving) return;
  duelResolving = true;

  try {
    const user = (typeof currentUser !== 'undefined') ? currentUser : null;
    duelViewUserId = user ? user.id : null;
    resetDuelView();

    // db.js did not load at all (blocked CDN, file missing).
    if (typeof getDuel !== 'function') {
      showDuelUnavailable();
      return;
    }

    // ── 1. No key: create a duel ────────────────────────────
    if (!duelKey) {
      showDuelCreate(user);
      return;
    }

    const d = await getDuel(duelKey);

    if (!d) {
      // get_duel_by_key returns SQL NULL for an unknown key and raises for
      // nothing — so a null payload with no recorded code is a real answer
      // ("no such duel"), and a null payload WITH one is infrastructure.
      if (typeof lastDuelCode !== 'undefined' && lastDuelCode) showDuelUnavailable();
      else showDuelNotFound();
      return;
    }

    duelPayload = d;
    renderDuelMeta(d);
    renderDuelExpiry(d);

    const side = String(d.your_side || '');

    // ── 7. Third arrival ────────────────────────────────────
    if (side === 'spectator') {
      showDuelFull(d);
      return;
    }

    // ── 2. The side is free and this visitor could take it ──
    if (side === 'open') {
      if (d.expired) { showDuelResult(d); return; }
      showDuelIntro(d);
      return;
    }

    const me = duelBlock(d, side);

    if (!me.played) {
      // Their own side, never started. If the duel is over that is now a
      // result (a walkover against them, or nobody played at all).
      if (d.expired) { showDuelResult(d); return; }
      showDuelIntro(d);
      return;
    }

    // ── 3. Mid-run ──────────────────────────────────────────
    if (String(me.status) === 'in_progress' && !d.expired) {
      await resumeDuelRun();
      return;
    }

    // ── 4/5/6. They have a result: waiting, verdict, walkover
    showDuelResult(d);
  } catch (e) {
    console.error('resolveDuelState failed:', e);
    showDuelUnavailable();
  } finally {
    duelResolving = false;
  }
}

// The caller's own side block, or the other one. `side` is 'creator' or
// 'opponent'; anything else has no block.
function duelBlock(d, side) {
  const b = (side === 'creator') ? d.creator : (side === 'opponent') ? d.opponent : null;
  return (b && typeof b === 'object') ? b : {};
}

function duelOtherSide(side) {
  return side === 'creator' ? 'opponent' : side === 'opponent' ? 'creator' : '';
}

// A side's score, or null. Gated on scores_revealed rather than on the field
// being non-null: that flag is the whole "nobody sees a score until both are
// done" rule, and reading around it — including from a server that one day
// sends more than it should — is exactly the leak the design forbids.
function duelScoreOf(d, block) {
  if (!d || d.scores_revealed !== true) return null;
  return duelNumber(block && block.score);
}

// Clears everything the previous state put on the page, and stops its timers.
function resetDuelView() {
  if (duelTimer)       { clearInterval(duelTimer);       duelTimer = null; }
  if (duelExpiryTimer) { clearInterval(duelExpiryTimer); duelExpiryTimer = null; }
  if (duelChart)       { duelChart.destroy();            duelChart = null; }
  duelChartInput = null;

  duelHide('duel-notice');
  duelHide('duel-panel');
  duelHide('duel-share');
  duelHide('duel-result');
  duelHide('duel-graph-panel');
  duelHide('duel-expiry');
  duelHide('duel-game');
  duelHide('duel-overlay');
  duelShow('duel-loading');

  document.getElementById('duel-notice').innerHTML = '';
  document.getElementById('duel-panel').innerHTML  = '';
  document.getElementById('duel-result').innerHTML = '';
  document.getElementById('duel-meta').textContent = '';
}

// ── 1. Create a duel ──────────────────────────────────────────

function showDuelCreate(user) {
  duelHide('duel-loading');
  document.getElementById('duel-title').textContent = 'Start a duel';

  if (!user) {
    const el = document.getElementById('duel-notice');
    el.innerHTML = `
      <strong>Creating a duel needs an account.</strong>
      <p>
        Somebody has to own a duel — an unowned one has nobody to notify and
        nobody to rematch. Accepting one doesn't need an account, though: send
        the link to anyone and they can play as a guest.
      </p>
      <div class="duel-notice-actions">
        <button class="btn btn-primary" id="duel-login-btn">Log in or register</button>
        <a href="index.html">Play a solo game instead</a>
      </div>
    `;
    el.style.display = 'block';
    document.getElementById('duel-login-btn').addEventListener('click', () => {
      if (typeof showAuthModal === 'function') showAuthModal('login');
    });
    return;
  }

  const el = document.getElementById('duel-panel');
  el.innerHTML = `
    <div class="panel-head">
      <h2>New duel</h2>
      <span class="panel-note">Open for 48 hours</span>
    </div>

    <ul class="duel-rules">
      <li><strong>You both get the same questions.</strong> Same sequence, same order — the comparison actually means something.</li>
      <li><strong>You don't have to play at the same time.</strong> Send the link, they play whenever, you both see the result.</li>
      <li><strong>Your opponent doesn't need an account.</strong> Whoever opens the link first takes the other side.</li>
      <li><strong>Neither score is shown until both of you have played.</strong> Knowing the target turns a run into a chase.</li>
    </ul>

    <div class="duel-create-row">
      <label for="duel-duration">Duration:</label>
      <select id="duel-duration">
        ${DUEL_DURATIONS.map(s =>
          `<option value="${s}"${s === 120 ? ' selected' : ''}>${s} seconds</option>`).join('')}
      </select>
      <button class="btn-start" id="duel-create-btn">Create duel</button>
      <span class="duel-start-status" id="duel-create-status" role="status" aria-live="polite"></span>
    </div>
  `;
  el.style.display = 'block';

  document.getElementById('duel-create-btn').addEventListener('click', createDuelNow);
}

async function createDuelNow() {
  const btn    = document.getElementById('duel-create-btn');
  const status = document.getElementById('duel-create-status');
  const select = document.getElementById('duel-duration');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = 'Creating…';
  if (status) status.textContent = '';

  const seconds = duelNumber(select && select.value) ?? 120;
  const res = await createDuel(seconds);

  if (!res || !res.duel_key) {
    btn.disabled = false;
    btn.textContent = 'Create duel';
    if (status) {
      status.textContent = (typeof lastDuelError !== 'undefined' && lastDuelError)
        || "Couldn't create the duel — try again in a moment.";
    }
    return;
  }

  showDuelCreated(res);
}

function showDuelCreated(res) {
  const key      = String(res.duel_key);
  const duration = duelNumber(res.duration_seconds) ?? 120;

  duelHide('duel-loading');
  document.getElementById('duel-title').textContent = 'Duel created';

  const el = document.getElementById('duel-panel');
  el.innerHTML = `
    <div class="panel-head">
      <h2>Your duel is ready</h2>
      <span class="panel-note">${escapeHtml(duration)} seconds</span>
    </div>
    <p class="duel-lede">
      Send the link below. Whoever opens it first takes the other side — they
      don't need an account. Then play your own side; you'll both see the
      result once you're both done.
    </p>
    <div class="duel-created-actions">
      <a class="btn btn-primary" href="duel.html?d=${encodeURIComponent(key)}">Play your side</a>
    </div>
  `;
  el.style.display = 'block';

  showDuelShareLink(key);
  renderDuelExpiryFromSeconds(duelSecondsUntil(res.expires_at));
}

// ── The shareable link ────────────────────────────────────────

function showDuelShareLink(key) {
  const wrap  = document.getElementById('duel-share');
  const field = document.getElementById('duel-share-text');
  if (!wrap || !field) return;

  const url = duelUrlFor(key);
  field.value = url;
  wrap.style.display = 'block';
  wireDuelCopyButton(url);
}

// Text clipboard writes fail in situations real players are actually in — any
// plain-http page (isSecureContext false) and older Safari — so the fallback
// is chosen up front rather than after a rejection they have already waited
// on. The link is always visible in the field, so manual copy is the floor.
// (Same shape, and the same reasoning, as copyDailyShare() in js/daily.js.)
function duelCanCopyText() {
  try {
    return !!(window.isSecureContext
      && navigator.clipboard
      && typeof navigator.clipboard.writeText === 'function');
  } catch (_) {
    return false;
  }
}

async function copyDuelLink(text) {
  if (duelCanCopyText()) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch (e) {
      console.warn('duel link: clipboard write failed, falling back:', e);
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    if (ok) return 'copied';
  } catch (e) {
    console.warn('duel link: execCommand copy failed:', e);
  }

  return 'manual';
}

function wireDuelCopyButton(url) {
  const btn    = document.getElementById('duel-share-btn');
  const status = document.getElementById('duel-share-status');
  const field  = document.getElementById('duel-share-text');
  if (!btn) return;

  // The button survives across states, so replace it rather than stacking a
  // second listener that copies a stale link.
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);

  fresh.addEventListener('click', async () => {
    if (fresh.disabled) return;
    fresh.disabled = true;

    const outcome = await copyDuelLink(url);

    fresh.disabled = false;
    if (outcome === 'copied') {
      status.textContent = 'Copied — paste it anywhere.';
      status.className   = 'duel-share-status is-ok';
    } else {
      status.textContent = "This browser wouldn't let the page copy. The link is selected — press Ctrl/Cmd+C.";
      status.className   = 'duel-share-status is-error';
      if (field) { field.focus(); field.select(); }
    }
  });
}

// ── 2. Not played yet ─────────────────────────────────────────

function showDuelIntro(d, errorText) {
  duelHide('duel-loading');

  const duration = duelNumber(d.duration_seconds) ?? 120;
  const side     = String(d.your_side || '');
  const creator  = side === 'creator';
  const user     = (typeof currentUser !== 'undefined') ? currentUser : null;

  document.getElementById('duel-title').textContent =
    creator ? 'Your duel' : "You've been challenged";

  // No name to show: get_duel_by_key deliberately carries no usernames — a
  // duel is a link, not a directory — so this says what is actually known
  // rather than inventing an identity for the other player.
  const lede = creator
    ? `You created this duel. Send the link below, then play your side — you can do either first.`
    : `Somebody sent you this duel. You'll both answer the same sequence of questions for ${duration} seconds, and neither of you sees a score until both runs are in.`;

  const opponentLine = d.opponent_claimed
    ? (creator ? 'Your opponent has taken the other side.' : 'You have the second side.')
    : (creator ? 'Nobody has taken the other side yet.'    : 'The second side is still open — start and it is yours.');

  const guestNote = (!creator && !user)
    ? `<li><strong>You're playing as a guest.</strong> Your run is tied to this browser, so finish it here — clearing site data loses it. Signing in first attaches it to your account instead.</li>`
    : '';

  const el = document.getElementById('duel-panel');
  el.innerHTML = `
    <div class="panel-head">
      <h2>${escapeHtml(duration)}-second duel</h2>
      <span class="panel-note">${escapeHtml(opponentLine)}</span>
    </div>

    <p class="duel-lede">${escapeHtml(lede)}</p>

    <ul class="duel-rules">
      <li><strong>The same questions for both of you.</strong> One sequence, generated once, drawn from by both sides.</li>
      <li><strong>One run per side.</strong> There is no retry and no way to undo a bad one.</li>
      <li><strong>The clock is the server's.</strong> It starts the moment you press Start and keeps running — closing the tab, reloading, or losing your connection does not pause it.</li>
      <li><strong>Neither score is shown until both of you are done.</strong> You will not be told what to chase.</li>
      ${guestNote}
    </ul>

    <p class="duel-warn">
      Pressing Start claims your side of this duel and starts the ${escapeHtml(duration)}-second
      clock. It cannot be undone and it cannot be played twice.
    </p>

    <div class="duel-start-row">
      <button class="btn-start" id="duel-start-btn">Start your run</button>
      <span class="duel-start-status" id="duel-start-status" role="status" aria-live="polite">${escapeHtml(errorText || '')}</span>
    </div>
  `;
  el.style.display = 'block';

  document.getElementById('duel-start-btn').addEventListener('click', startDuelNow);

  // The creator still has to send the link, so it belongs on this page too.
  if (creator) showDuelShareLink(duelKey);
}

async function startDuelNow() {
  const btn    = document.getElementById('duel-start-btn');
  const status = document.getElementById('duel-start-status');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = 'Starting…';
  if (status) status.textContent = '';

  const run = await startDuelRun(duelKey);
  if (!run) {
    // A refusal here is usually final — the duel filled up, or expired,
    // between loading the page and pressing Start. Re-resolve so the page
    // shows the state that is now true rather than a button that will fail
    // again; a transient failure just re-renders this same intro.
    const code = (typeof lastDuelCode !== 'undefined') ? lastDuelCode : null;
    if (code === 'duel_already_has_opponent' || code === 'duel_expired') {
      await resolveDuelState();
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Start your run';
    if (status) {
      status.textContent = (typeof lastDuelError !== 'undefined' && lastDuelError)
        || "Couldn't start your run — try again in a moment.";
    }
    return;
  }

  await enterDuelRun(run);
}

// ── 3. In progress ────────────────────────────────────────────

// A refresh, a dropped connection or a reopened tab lands here. start_duel_run
// is idempotent, so this asks for the run again and gets the REAL remaining
// time back rather than a fresh clock.
async function resumeDuelRun() {
  const run = await startDuelRun(duelKey);
  if (!run) {
    showDuelIntro(duelPayload, "Couldn't resume your run — try again in a moment.");
    return;
  }
  await enterDuelRun(run);
}

// Takes a start_duel_run payload and either begins/resumes the run or, if the
// window has already closed, renders whatever the duel says happened.
async function enterDuelRun(run) {
  const state     = String(run.status || '');
  const remaining = Math.max(0, duelNumber(run.seconds_remaining) ?? 0);
  const questions = Array.isArray(run.questions) ? run.questions : [];

  if (run.duel && typeof run.duel === 'object') {
    duelPayload = run.duel;
    renderDuelMeta(duelPayload);
    renderDuelExpiry(duelPayload);
  }

  if (state !== 'in_progress' || !questions.length || remaining <= 0) {
    // Either already finished, or the clock ran out while the page was closed.
    // If a draft survived, it is worth one attempt at submitting it — the
    // server's grace window is short and this will usually be refused, but
    // losing a finished run to a closed tab is the failure worth a round trip.
    if (state === 'in_progress' && remaining <= 0) {
      await recoverExpiredDuelDraft(run);
      return;
    }
    showDuelResult(duelPayload || {});
    return;
  }

  duelRun = {
    key:       duelKey,
    side:      String(run.side || ''),
    duration:  duelNumber(run.duration_seconds) ?? 120,
    startedAt: String(run.started_at || ''),
    questions,
  };

  const draft = loadDuelDraft();
  duelAnswers = draft ? draft.answers : [];
  duelIndex   = draft ? Math.min(draft.index, questions.length - 1) : 0;
  duelSubmitting = false;
  duelSubmitted  = false;

  // The origin of the run in the page's own monotonic clock, reconstructed
  // from the server's remaining time. Every elapsed_ms is measured from here,
  // so it stays correct across a refresh instead of restarting at zero.
  const now = performance.now();
  const spentMs  = Math.max(0, (duelRun.duration - remaining) * 1000);
  duelRunOrigin = now - spentMs;
  duelDeadline  = now + remaining * 1000;

  duelHide('duel-loading');
  duelHide('duel-panel');
  duelHide('duel-notice');
  duelHide('duel-share');
  duelHide('duel-result');
  duelHide('duel-graph-panel');
  duelShow('duel-game', 'block');
  duelHide('duel-overlay');

  const input = document.getElementById('duel-input');
  input.disabled = false;
  input.value = '';

  wireDuelInput();
  updateDuelAnswered();
  showDuelQuestion();
  tickDuelTimer();

  // Anchored to the deadline above, not counted in interval ticks: browsers
  // throttle setInterval in background tabs, and a tick-counted clock would
  // quietly hand out extra playing time whenever the tab lost focus.
  duelTimer = setInterval(tickDuelTimer, 250);
}

function duelRunLive() {
  return !!(duelRun && duelDeadline !== null && !duelSubmitted && !duelSubmitting);
}

function tickDuelTimer() {
  if (!duelRunLive()) return;
  const left = Math.max(0, Math.ceil((duelDeadline - performance.now()) / 1000));
  document.getElementById('duel-timer').textContent = 'Seconds left: ' + left;
  if (left <= 0) finishDuelRun();
}

function showDuelQuestion() {
  const q = duelRun.questions[duelIndex];
  if (!q) { finishDuelRun(); return; }

  duelCurrent     = q;
  duelWrongLogged = false;

  document.getElementById('duel-question').textContent = String(q.display ?? '') + ' =';
  const input = document.getElementById('duel-input');
  input.value = '';
  input.focus();
}

// Milliseconds since the START OF THE RUN, clamped so the sequence is
// non-decreasing and never exceeds the duration — both are conditions
// submit_duel_run checks, and both are cheaper to hold here than to argue
// about after a rejected submission.
function duelElapsedMs() {
  const raw  = Math.round(performance.now() - duelRunOrigin);
  const last = duelAnswers.length ? duelAnswers[duelAnswers.length - 1].elapsed_ms : 0;
  const cap  = duelRun.duration * 1000;
  return Math.min(cap, Math.max(last, Math.max(0, raw)));
}

// Input handling is js/game.js's, deliberately unchanged: digits only, Enter
// clears, and a correct answer auto-advances the moment it is complete. A duel
// must feel like the same game, because it is.
function wireDuelInput() {
  if (duelInputWired) return;
  duelInputWired = true;

  const input = document.getElementById('duel-input');

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.value = '';
      return;
    }
    const allowed = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home', 'End'];
    if (!allowed.includes(e.key) && !/^\d$/.test(e.key)) {
      e.preventDefault();
    }
  });

  input.addEventListener('input', () => {
    if (!duelCurrent || !duelRunLive()) return;

    const clean = input.value.replace(/\D/g, '');
    if (clean !== input.value) input.value = clean;

    const val    = clean;
    const ansStr = String(duelCurrent.answer);
    if (!val) return;

    if (val === ansStr) { commitDuelAnswer(val); return; }

    // A wrong answer of the right length is a wrong answer, not a typo on the
    // way to the right one. Recorded once per question so a fumbled keystroke
    // cannot inflate the denominator; the server scores it.
    if (!duelWrongLogged && val.length >= ansStr.length && !ansStr.startsWith(val)) {
      duelWrongLogged = true;
      pushDuelAnswer(val);
    }
  });
}

function pushDuelAnswer(value) {
  duelAnswers.push({ i: duelIndex, value: Number(value), elapsed_ms: duelElapsedMs() });
  saveDuelDraft();
}

function commitDuelAnswer(value) {
  pushDuelAnswer(value);
  duelIndex++;
  saveDuelDraft();
  updateDuelAnswered();

  if (duelIndex >= duelRun.questions.length) { finishDuelRun(); return; }
  showDuelQuestion();
}

// "Answered", not "Score". The client's count is a guess — auto-advance means
// it happens to equal the correct count, but the server decides the score and
// this number must never be mistaken for it.
function updateDuelAnswered() {
  document.getElementById('duel-answered').textContent = 'Answered: ' + duelIndex;
}

// ── Submitting ────────────────────────────────────────────────

async function finishDuelRun() {
  if (duelSubmitting || duelSubmitted || !duelRun) return;
  duelSubmitting = true;

  if (duelTimer) { clearInterval(duelTimer); duelTimer = null; }
  duelCurrent = null;

  const input = document.getElementById('duel-input');
  if (input) input.disabled = true;

  showDuelOverlay(`
    <h2>Time's up!</h2>
    <div class="gameover-label">Submitting your answers…</div>
  `);

  const res = await submitDuelRun(duelKey, duelAnswers);
  duelSubmitting = false;

  const score = duelNumber(res && res.score);
  if (res && score !== null) {
    duelSubmitted = true;
    // Saved BEFORE the draft is cleared: this record is the only copy of the
    // run's shape this client will ever have. get_duel_by_key returns no
    // per-answer timeline (a stored one is a partial answer key), and it hides
    // even the caller's OWN score until both sides are done — so without this,
    // reloading the "waiting for them" page would have no number to show.
    saveDuelResultRecord(res);
    clearDuelDraft();
    duelHide('duel-game');
    duelPayload = (res.duel && typeof res.duel === 'object') ? res.duel : duelPayload;
    showDuelResult(duelPayload || {}, res);
    return;
  }

  // The submit failed. It may still have landed (a response lost on the way
  // back), so ask the server what it thinks before offering a retry.
  const code = (typeof lastDuelCode !== 'undefined') ? lastDuelCode : null;
  if (code === 'duel_already_submitted' || code === 'duel_window_closed') {
    duelSubmitted = true;
    clearDuelDraft();
    duelHide('duel-game');
    await resolveDuelState();
    return;
  }

  showDuelOverlay(`
    <h2>Time's up!</h2>
    <div class="gameover-label">
      Your answers couldn't be submitted. They're still saved on this device —
      retrying will send them.
    </div>
    <button class="btn btn-primary" id="duel-retry-btn">Retry submit</button>
  `);
  const retry = document.getElementById('duel-retry-btn');
  if (retry) retry.addEventListener('click', () => { duelSubmitting = false; finishDuelRun(); });
}

function showDuelOverlay(html) {
  const el = document.getElementById('duel-overlay');
  el.innerHTML = html;   // literal markup from this file only
  el.style.display = 'flex';
}

// A run that finished while the page was closed. Best effort: the server's
// grace window is three seconds, so this normally fails and the run is
// correctly reported as expired.
async function recoverExpiredDuelDraft(run) {
  const draft = readDuelDraft(duelKey, String(run.started_at || ''));

  if (draft && draft.answers.length) {
    // The record needs the question list to work out which answers were
    // right, and this payload is the last time this client will see it.
    duelRun = {
      key:       duelKey,
      side:      String(run.side || ''),
      duration:  duelNumber(run.duration_seconds) ?? 120,
      startedAt: String(run.started_at || ''),
      questions: Array.isArray(run.questions) ? run.questions : [],
    };
    duelAnswers = draft.answers;

    const res = await submitDuelRun(duelKey, draft.answers);
    if (res && duelNumber(res.score) !== null) {
      saveDuelResultRecord(res);
      clearDuelDraft();
      duelSubmitted = true;
      duelPayload = (res.duel && typeof res.duel === 'object') ? res.duel : duelPayload;
      showDuelResult(duelPayload || {}, res);
      return;
    }
  }

  clearDuelDraft();
  showDuelResult(duelPayload || {});
}

// Losing a completed run to a closed tab is the worst bug this page can have,
// so the end of the run is also submitted from the visibility hooks. Only ever
// once the clock has run out, though: submitting because somebody alt-tabbed
// at 40 seconds would spend their one run for them.
function duelFlushOnHide() {
  if (!duelRunLive()) return;
  if (duelDeadline !== null && performance.now() >= duelDeadline) finishDuelRun();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    duelFlushOnHide();
  } else {
    // setInterval is clamped while hidden, and the submit window is only the
    // duration plus a few seconds of grace — check the clock immediately
    // rather than waiting for the next tick.
    tickDuelTimer();
  }
});

// pagehide fires on tab close and on bfcache eviction, where visibilitychange
// is not guaranteed. Same condition, so a double call is a no-op.
window.addEventListener('pagehide', duelFlushOnHide);

// ── Draft (survives a refresh) ────────────────────────────────
// start_duel_run returns the remaining time but not the answers already given
// — there is nowhere for them to live server-side until the run is submitted.
// So they are kept here, keyed by duel and pinned to the run's started_at, and
// a refresh mid-run resumes with them intact.

function duelDraftKey(key) { return DUEL_DRAFT_PREFIX + key; }

function saveDuelDraft() {
  if (!duelRun) return;
  try {
    localStorage.setItem(duelDraftKey(duelRun.key), JSON.stringify({
      startedAt: duelRun.startedAt,
      index:     duelIndex,
      answers:   duelAnswers,
    }));
  } catch (_) { /* private mode, quota — the run still works, it just can't resume */ }
}

// Returns { index, answers } for a run, or null. A draft from a different run
// (started_at differs) is discarded rather than trusted.
function readDuelDraft(key, startedAt) {
  try {
    const raw = localStorage.getItem(duelDraftKey(key));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return null;
    if (startedAt && d.startedAt && d.startedAt !== startedAt) return null;
    if (!Array.isArray(d.answers)) return null;

    const answers = d.answers.filter(a =>
      a && Number.isFinite(Number(a.i)) &&
      Number.isFinite(Number(a.value)) &&
      Number.isFinite(Number(a.elapsed_ms))
    ).map(a => ({ i: Number(a.i), value: Number(a.value), elapsed_ms: Number(a.elapsed_ms) }));

    const index = Number.isFinite(Number(d.index)) ? Math.max(0, Number(d.index)) : 0;
    return { index, answers };
  } catch (_) {
    return null;
  }
}

function loadDuelDraft() {
  return duelRun ? readDuelDraft(duelRun.key, duelRun.startedAt) : null;
}

function clearDuelDraft() {
  try { localStorage.removeItem(duelDraftKey(duelKey)); } catch (_) {}
}

// ── The local result record ───────────────────────────────────
// What this client knows about its OWN finished run, and the only source the
// pace graph has for a per-answer timeline: get_duel_by_key deliberately does
// not return one, because a stored timeline is a partial answer key — a
// correct entry states the answer to question i.
//
// Consequence, stated plainly because the graph depends on it: the pace curve
// exists only for the run this browser played, on this browser. There is no
// path by which this page can ever draw the opponent's curve.

function duelResultKey(key) { return DUEL_RESULT_PREFIX + key; }

function saveDuelResultRecord(res) {
  if (!duelRun) return;

  // Seconds at which each CORRECT answer landed. Correctness is recomputed
  // here from the question list rather than assumed from auto-advance, so a
  // wrong entry logged against a question can never bank a point.
  const points = [];
  for (const a of duelAnswers) {
    const q = duelRun.questions[a.i];
    if (!q) continue;
    if (Number(a.value) === Number(q.answer)) points.push(Number(a.elapsed_ms) / 1000);
  }
  points.sort((x, y) => x - y);

  try {
    localStorage.setItem(duelResultKey(duelRun.key), JSON.stringify({
      side:      duelRun.side,
      startedAt: duelRun.startedAt,
      duration:  duelRun.duration,
      score:     duelNumber(res && res.score),
      answered:  duelNumber(res && res.total_answered),
      accuracy:  duelNumber(res && res.accuracy),
      points,
    }));
  } catch (_) { /* the result still renders, it just won't survive a reload */ }
}

function readDuelResultRecord(key) {
  try {
    const raw = localStorage.getItem(duelResultKey(key));
    if (!raw) return null;
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object') return null;
    const points = Array.isArray(r.points)
      ? r.points.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      : [];
    return {
      side:     String(r.side || ''),
      duration: duelNumber(r.duration),
      score:    duelNumber(r.score),
      answered: duelNumber(r.answered),
      accuracy: duelNumber(r.accuracy),
      points,
    };
  } catch (_) {
    return null;
  }
}

// ── 4/5/6. Results ────────────────────────────────────────────
// One renderer for three states, because they are three readings of the same
// payload and splitting them invites two of them to drift:
//
//   scores_revealed false → you are done, they are not. Your number only.
//   outcome 'decided'     → both played. Who won, and the pace graph.
//   outcome 'walkover'    → one side never turned up. Not a win, and not
//                           displayed as one.
//   outcome 'unplayed'    → nobody played. Not a tie; there was no contest.

function showDuelResult(d, submitRes) {
  duelHide('duel-loading');
  duelHide('duel-panel');
  duelHide('duel-game');
  duelHide('duel-share');

  const side     = String(d.your_side || '');
  const iPlay    = side === 'creator' || side === 'opponent';
  const me       = duelBlock(d, side);
  const them     = duelBlock(d, duelOtherSide(side));
  const duration = duelNumber(d.duration_seconds) ?? 120;
  const record   = readDuelResultRecord(duelKey);
  const outcome  = (d.outcome && typeof d.outcome === 'object') ? d.outcome : null;
  const revealed = d.scores_revealed === true;

  // My own score: the server's, from whichever of the three places has it.
  // submit_duel_run always returns it (it is mine and I just earned it);
  // get_duel_by_key withholds it until both sides are done, which is why the
  // local record exists at all.
  const myScore = duelNumber(submitRes && submitRes.score)
    ?? duelScoreOf(d, me)
    ?? (record ? record.score : null);

  // Theirs: only ever through the reveal gate.
  const theirScore = revealed ? duelScoreOf(d, them) : null;

  let heading = 'Duel';
  let note    = '';
  let tone    = '';

  if (!revealed) {
    // ── 4. Waiting ──────────────────────────────────────────
    heading = 'Waiting for your opponent';
    note = them.played
      ? "They're partway through. Neither score is shown until both runs are in — you'll see both at once."
      : "They haven't played yet. Neither score is shown until both runs are in — you'll see both at once.";
  } else if (outcome && outcome.type === 'walkover') {
    // ── 6. Walkover ─────────────────────────────────────────
    const mine = outcome.winner === side;
    // Deliberately no win/loss colour on any of these. The copy says a
    // walkover is not a win, and a green stripe beside it would say the
    // opposite, louder.
    tone = '';
    if (!iPlay) {
      // Somebody holding the link who never took a side — the duel expired
      // with the second slot still free. Neither "you" applies to them.
      heading = 'Walkover — only one side played';
      note    = 'The 48 hours ran out with one run in and the other side never claimed. Nothing was compared.';
    } else if (mine) {
      heading = 'Walkover — they never played';
      note    = 'The 48 hours ran out with only your run in. That is a walkover, not a win — there was nothing to beat.';
    } else {
      heading = 'Walkover — you never played';
      note    = 'The 48 hours ran out before you played, so it went to them by walkover. Nothing was compared.';
    }
  } else if (outcome && outcome.type === 'unplayed') {
    heading = 'Nobody played this duel';
    note    = 'The 48 hours ran out before either side started. There was no contest to decide.';
  } else if (outcome && outcome.type === 'decided') {
    // ── 5. Decided ──────────────────────────────────────────
    if (outcome.winner === 'tie') {
      heading = 'Tied';
      tone    = 'is-tie';
      note    = 'Same score, same questions. Rematch.';
    } else if (outcome.winner === side) {
      heading = 'You won';
      tone    = 'is-win';
      note    = 'Both runs are in, on the same sequence, scored on the server.';
    } else if (iPlay) {
      heading = 'You lost';
      tone    = 'is-loss';
      note    = 'Both runs are in, on the same sequence, scored on the server.';
    } else {
      heading = 'Result';
      note    = 'Both runs are in, on the same sequence, scored on the server.';
    }
  } else {
    heading = 'Duel over';
    note    = 'This duel has closed.';
  }

  const myLabel   = iPlay ? 'You' : 'Creator';
  const themLabel = iPlay ? 'Them' : 'Opponent';

  // A score that is not revealed renders as a dash, and the label says why —
  // it must never look like a zero, and it must never look like a number that
  // is merely missing.
  const themCell = revealed
    ? (theirScore === null ? '—' : theirScore)
    : 'hidden';

  const el = document.getElementById('duel-result');
  el.innerHTML = `
    <div class="duel-verdict ${escapeHtml(tone)}">
      <div class="duel-verdict-head">${escapeHtml(heading)}</div>
      <div class="stats-row duel-verdict-stats">
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(myScore === null ? '—' : myScore)}</div>
          <div class="stat-label">${escapeHtml(myLabel)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(themCell)}</div>
          <div class="stat-label">${escapeHtml(themLabel)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(duration)}s</div>
          <div class="stat-label">Duration</div>
        </div>
      </div>
      <p class="duel-verdict-note">${escapeHtml(note)}</p>
      ${myScore === null && iPlay && me.played ? `
      <p class="duel-verdict-note">
        Your own score isn't on this device — it was played in another browser,
        or site data has been cleared. It appears here once both runs are in.
      </p>` : ''}
      <div class="duel-result-actions">
        <a href="duel.html">Start another duel</a>
        <a href="index.html">Play a solo game</a>
      </div>
    </div>
  `;
  el.style.display = 'block';

  // Still waiting on them: the link is the thing that gets them to play, so it
  // goes back on the page. Their score is not here in any form.
  if (!revealed && iPlay) showDuelShareLink(duelKey);

  renderDuelExpiry(d);
  renderDuelPace({ duration, myScore, theirScore, record, revealed, myLabel, themLabel });
}

// ── The pace graph ────────────────────────────────────────────
// Projected score over the run: banked × duration ÷ elapsed — the same curve,
// and the same warm-up gates, as renderRunGraph() in js/results.js.
//
// WHAT THIS IS ACTUALLY DRAWN FROM, because the honest version is narrower
// than the design doc's sketch:
//
//   Your line   — real. One point per correct answer, from the timeline this
//                 browser recorded while you played (the local result record).
//   Their line  — their FINAL SCORE, held flat across the run. Not a curve,
//                 and not presented as one.
//
// There is no per-answer timeline for the opponent, anywhere, on purpose:
// get_duel_by_key does not return one because a stored timeline is a partial
// answer key, and submit_duel_run returns only the caller's own totals. So the
// choice was a fabricated curve or a flat reference, and a fabricated curve
// would be a lie in the one chart people screenshot.
//
// The flat line still earns its place: projected score converges on the final
// score as the clock runs down, so "their final score" is exactly the pace
// they finished on, and every crossing of it is a real fact — the moment your
// pace passed, or fell behind, what they ended up doing. The fill is tinted
// toward whoever is ahead at that instant, which is what makes that readable.
function renderDuelPace(input) {
  duelChartInput = input || null;

  const panel   = document.getElementById('duel-graph-panel');
  const canvas  = document.getElementById('duel-chart');
  const note    = document.getElementById('duel-graph-note');
  const caption = document.getElementById('duel-chart-caption');
  if (!panel || !canvas) return;

  if (duelChart) { duelChart.destroy(); duelChart = null; }

  const i = duelChartInput;
  if (!i || typeof Chart === 'undefined') { panel.style.display = 'none'; return; }
  // Nothing to compare until both scores are on the table.
  if (!i.revealed || i.myScore === null || i.theirScore === null) {
    panel.style.display = 'none';
    return;
  }

  const duration = i.duration || 120;
  const pts      = (i.record && Array.isArray(i.record.points)) ? i.record.points : [];

  const youPts  = [];
  for (let k = 0; k < pts.length; k++) {
    const x = pts[k];
    const banked = k + 1;
    if (!(x > 0) || x > duration) continue;
    if (banked < DUEL_WARMUP_Q || x < DUEL_WARMUP_SEC) continue;
    youPts.push({ x: duelRound1(x), y: duelRound1(banked * duration / x) });
  }
  // Terminal point: the score actually finished on, so the line lands on the
  // number in the card above it.
  youPts.push({ x: duration, y: i.myScore });

  panel.style.display = 'block';

  // Fewer than three plotted points is not a curve, and there is no local
  // timeline at all when the run was played on another device. Fall back to
  // the two numbers that ARE known, and say that is what this is.
  const havePace = youPts.length >= 3;

  const themPts = (havePace ? youPts : [{ x: 0 }, { x: duration }])
    .map(p => ({ x: p.x, y: i.theirScore }));
  const yourFlat = [{ x: 0, y: i.myScore }, { x: duration, y: i.myScore }];

  if (note) {
    note.textContent = havePace
      ? 'Projected score over the run'
      : 'Final scores only';
  }
  if (caption) {
    caption.textContent = havePace
      ? 'Your line is your projected score — questions banked so far, extrapolated to the full '
        + duration + ' seconds. Their per-answer times are never shared (a stored timeline gives away '
        + 'answers), so their line is the score they finished on, held flat. Where your line is above '
        + 'it, you were on a winning pace.'
      : "The per-answer timeline for this run isn't on this device, and the server never shares one — "
        + 'so this is the honest version: the two final scores, nothing interpolated between them.';
  }

  const cYou   = themeColor('--c-duel-you',    '#333');
  const cThem  = themeColor('--c-duel-them',   '#888');
  const cAhead = themeColor('--c-duel-ahead',  'rgba(0, 102, 0, 0.18)');
  const cBehnd = themeColor('--c-duel-behind', 'rgba(204, 0, 0, 0.15)');
  const cGrid  = themeColor('--c-rule',        '#eee');
  const cText  = themeColor('--c-ink-muted',   '#555');

  const ys  = [i.myScore, i.theirScore, ...youPts.map(p => p.y)];
  const lo  = Math.min(...ys);
  const hi  = Math.max(...ys);
  const pad = Math.max(2, (hi - lo) * 0.2);

  duelChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        {
          label: i.myLabel || 'You',
          data: havePace ? youPts : yourFlat,
          borderColor: cYou,
          borderWidth: 2,
          tension: havePace ? 0.3 : 0,
          pointRadius: 0,
          pointHoverRadius: 4,
          // The whole point of the chart: tint the gap between the two lines
          // toward whoever is ahead at that instant, so a lead change is a
          // colour change rather than something to be worked out.
          fill: { target: 1, above: cAhead, below: cBehnd },
          order: 1,
        },
        {
          label: i.themLabel || 'Them',
          data: themPts,
          borderColor: cThem,
          borderWidth: 2,
          borderDash: [5, 4],
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: false,
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 }, color: cText },
        },
        tooltip: {
          callbacks: {
            title: items => `${duelRound1(items[0].parsed.x)}s in`,
            label: item => `${item.dataset.label}: ${Math.round(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Seconds', font: { size: 11 }, color: cText },
          min: 0,
          max: duration,
          grid: { color: cGrid },
          ticks: { font: { size: 11 }, maxTicksLimit: 12, color: cText },
        },
        y: {
          beginAtZero: false,
          min: Math.max(0, Math.floor(lo - pad)),
          max: Math.ceil(hi + pad),
          title: { display: true, text: `Projected score (${duration}s)`, font: { size: 11 }, color: cText },
          grid: { color: cGrid },
          ticks: { font: { size: 11 }, precision: 0, color: cText },
        },
      },
    },
  });
}

// Chart.js resolves colours at construction, so the chart has to be destroyed
// and rebuilt when the palette changes.
window.addEventListener('zt-theme-change', () => {
  if (duelChartInput) renderDuelPace(duelChartInput);
});

// ── 7. Third arrival ──────────────────────────────────────────

function showDuelFull(d) {
  duelHide('duel-loading');
  document.getElementById('duel-title').textContent = 'This duel is full';

  const el = document.getElementById('duel-notice');
  el.innerHTML = `
    <strong>This duel already has two players.</strong>
    <p>
      A duel is between two people, so the link only works for the first two
      who open it. If you played this duel in another browser, or cleared site
      data, that run can't be recovered — a guest run is tied to the browser
      that played it.
    </p>
    <div class="duel-notice-actions">
      <a class="btn btn-primary" href="duel.html">Start your own duel</a>
      <a href="index.html">Play a solo game</a>
    </div>
  `;
  el.style.display = 'block';
  renderDuelExpiry(d);
}

// ── 8. Unknown key, and no migration ──────────────────────────

function showDuelNotFound() {
  duelHide('duel-loading');
  document.getElementById('duel-title').textContent = 'No such duel';

  const el = document.getElementById('duel-notice');
  el.innerHTML = `
    <strong>There's no duel with that link.</strong>
    <p>
      Either the link was mistyped, or the duel was deleted. Duel links look
      like <code>duel.html?d=abcd1234</code>.
    </p>
    <div class="duel-notice-actions">
      <a class="btn btn-primary" href="duel.html">Start a duel</a>
      <a href="index.html">Play a solo game</a>
    </div>
  `;
  el.style.display = 'block';
}

function showDuelUnavailable() {
  duelHide('duel-loading');
  document.getElementById('duel-title').textContent = 'Duels are unavailable';

  // Literal text only — the database's own message is logged, never shown.
  const el = document.getElementById('duel-notice');
  el.innerHTML = `
    <strong>Duels aren't available right now.</strong>
    <p>
      The page couldn't reach the duel service. This is usually temporary — try
      again in a moment.
    </p>
    <div class="duel-notice-actions">
      <a href="daily.html">Play the daily</a>
      <a href="index.html">Play a solo game</a>
    </div>
  `;
  el.style.display = 'block';
}

// ── Expiry countdown ──────────────────────────────────────────

function renderDuelExpiry(d) {
  if (!d) return;
  if (d.expired) {
    const el = document.getElementById('duel-expiry');
    if (!el) return;
    if (duelExpiryTimer) { clearInterval(duelExpiryTimer); duelExpiryTimer = null; }
    el.textContent = 'This duel has expired — a duel stays open for 48 hours.';
    el.style.display = 'block';
    return;
  }
  renderDuelExpiryFromSeconds(duelNumber(d.seconds_until_expiry));
}

function renderDuelExpiryFromSeconds(seconds) {
  const el = document.getElementById('duel-expiry');
  if (!el) return;
  if (seconds === null || seconds === undefined || seconds < 0) {
    el.style.display = 'none';
    return;
  }

  // Anchored to a deadline for the same reason the game clock is: a countdown
  // that counts ticks drifts badly in a backgrounded tab.
  const deadline = performance.now() + seconds * 1000;
  el.style.display = 'block';

  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    if (left <= 0) {
      el.textContent = 'This duel has expired — reload to see the result.';
      if (duelExpiryTimer) { clearInterval(duelExpiryTimer); duelExpiryTimer = null; }
      return;
    }
    el.textContent = `This duel expires in ${duelDurationText(left)}.`;
  };

  tick();
  if (duelExpiryTimer) clearInterval(duelExpiryTimer);
  duelExpiryTimer = setInterval(tick, 1000);
}

// Hours and minutes far out, minutes and seconds close in. Minutes are rounded
// UP rather than truncated, so a payload that said 47h 59m does not render as
// 47h 58m a heartbeat after it arrived.
function duelDurationText(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  if (s >= 3600) {
    const mins = Math.ceil(s / 60);
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  }
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

// ── Shell helpers ─────────────────────────────────────────────

function renderDuelMeta(d) {
  const el = document.getElementById('duel-meta');
  if (!el) return;
  const bits = [];
  const duration = duelNumber(d && d.duration_seconds);
  if (duration !== null) bits.push(duration + ' seconds');
  if (d && d.duel_key) bits.push('Duel ' + String(d.duel_key));
  // textContent: the key came off the URL and is not this file's to trust.
  el.textContent = bits.join(' · ');
}

function duelShow(id, display = 'block') {
  const el = document.getElementById(id);
  if (el) el.style.display = display;
}

function duelHide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function duelNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function duelRound1(v) {
  return Math.round(v * 10) / 10;
}

// Seconds between now and an ISO timestamp, or null. create_duel returns
// expires_at but not a countdown, and the "…Z" shape is the contract.
function duelSecondsUntil(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((t - Date.now()) / 1000));
}
