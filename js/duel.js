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
  // A steal room or a live steal run is just as destructible: re-resolving
  // would drop the channel and the presence the other player is watching.
  if (duelRunLive() || stealActive()) return;
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

    // ── Steal mode ──────────────────────────────────────────
    // A different system, not a flag: both players have to be here at once, so
    // an unplayed steal duel opens a room rather than a Start button. Anything
    // already finished, or expired, falls through to the ordinary result
    // renderer — a duel that is over is a duel that is over.
    if (stealModeOf(d) && !d.expired) {
      const mine = duelBlock(d, side);
      if (String(mine.status) === 'in_progress') { await stealRejoinRun(d); return; }
      if (!mine.played) { showStealRoom(d); return; }
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

// The seconds at which a side banked each correct answer, ascending, or []. The
// server sends TIMES ONLY — never which question, never the value — so this
// says how fast someone was without saying what they answered. Gated on
// scores_revealed for the same reason the score is: before both runs are in, a
// live opponent's pace is a chase target.
function duelPointsOf(d, block) {
  if (!d || d.scores_revealed !== true) return [];
  const raw = block && block.points;
  if (!Array.isArray(raw)) return [];
  return raw.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

// Clears everything the previous state put on the page, and stops its timers.
function resetDuelView() {
  if (duelTimer)       { clearInterval(duelTimer);       duelTimer = null; }
  if (duelExpiryTimer) { clearInterval(duelExpiryTimer); duelExpiryTimer = null; }
  if (duelChart)       { duelChart.destroy();            duelChart = null; }
  duelChartInput = null;
  stealTeardown();

  duelHide('steal-room');
  duelHide('steal-game');
  duelHide('steal-overlay');
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
  document.getElementById('steal-room').innerHTML  = '';
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

    <fieldset class="duel-mode-choice">
      <legend class="duel-mode-legend">Mode</legend>
      <label class="duel-mode-option">
        <input type="radio" name="duel-mode" value="classic" id="duel-mode-classic" checked>
        <span class="duel-mode-name">Classic</span>
        <span class="duel-mode-note">You each play the same questions whenever you like, at your own pace, and compare scores afterward.</span>
      </label>
      <label class="duel-mode-option">
        <input type="radio" name="duel-mode" value="steal" id="duel-mode-steal">
        <span class="duel-mode-name">Steal</span>
        <span class="duel-mode-note">You play at the same time: the first correct answer takes the point and you both jump to the next question.</span>
      </label>
    </fieldset>

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

// 'classic' or 'steal' — whichever radio is checked, defaulting to classic.
// Anything unrecognised is classic: a duel nobody has to be awake for is the
// safe reading of a broken control.
function readDuelModeChoice() {
  const el = document.querySelector('input[name="duel-mode"]:checked');
  return (el && el.value === 'steal') ? 'steal' : 'classic';
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
  const mode    = readDuelModeChoice();
  const res = await createDuel(seconds, mode);

  if (!res || !res.duel_key) {
    btn.disabled = false;
    btn.textContent = 'Create duel';
    if (status) {
      status.textContent = (typeof lastDuelError !== 'undefined' && lastDuelError)
        || "Couldn't create the duel — try again in a moment.";
    }
    return;
  }

  showDuelCreated(res, mode);
}

function showDuelCreated(res, requestedMode) {
  const key      = String(res.duel_key);
  const duration = duelNumber(res.duration_seconds) ?? 120;
  // The server's answer wins if it echoes one; otherwise what was asked for.
  const mode     = String(res.mode || requestedMode || 'classic') === 'steal' ? 'steal' : 'classic';

  duelHide('duel-loading');
  document.getElementById('duel-title').textContent = 'Duel created';

  const el = document.getElementById('duel-panel');
  el.innerHTML = `
    <div class="panel-head">
      <h2>Your duel is ready</h2>
      <span class="panel-note">${escapeHtml(duration)} seconds · ${mode === 'steal' ? 'Steal' : 'Classic'}</span>
    </div>
    <p class="duel-lede">${mode === 'steal' ? `
      Send the link below. It opens a room — you both have to be in it at the
      same time, because in steal mode the first correct answer takes the point
      and you both move on together. If they can't make it, the room will offer
      to turn this into a classic duel instead.` : `
      Send the link below. Whoever opens it first takes the other side — they
      don't need an account. Then play your own side; you'll both see the
      result once you're both done.`}
    </p>
    <div class="duel-created-actions">
      <a class="btn btn-primary" href="duel.html?d=${encodeURIComponent(key)}">${mode === 'steal' ? 'Open the room' : 'Play your side'}</a>
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
// What this client knows about its OWN finished run.
//
// get_duel_by_key never returns a stored ANSWER timeline — a correct entry
// states the answer to question i, so that would be a partial answer key. What
// it does return, once both runs are in, is the bare list of seconds at which
// each side banked a point: enough to draw a curve, and no help to anyone,
// since by then the duel can never be replayed.
//
// This record is therefore a fallback, not the source: it covers a run that
// finished against a database without the pace migration applied, and it is
// the only timeline available for the brief window before the reveal.

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
  renderDuelPace({
    duration, myScore, theirScore, record, revealed, myLabel, themLabel,
    myPoints:    duelPointsOf(d, me),
    theirPoints: duelPointsOf(d, them),
  });
}

// ── The pace graph ────────────────────────────────────────────
// Projected score over the run: banked × duration ÷ elapsed — the same curve,
// and the same warm-up gates, as renderRunGraph() in js/results.js.
//
// WHAT THIS IS DRAWN FROM, stated because a chart people screenshot should not
// be quietly interpolated:
//
//   Both lines  — real. One point per correct answer, at the second it landed,
//                 from get_duel_by_key's per-side `points`.
//   Fallbacks   — your own local timeline if the server sent no points (a run
//                 finished against a database without the pace migration), and
//                 failing that, the two final scores held flat, labelled as
//                 exactly that. A fabricated curve would be a lie.
//
// The server sends TIMES ONLY, never the answers, and only after both runs are
// in — at which point the duel can never be replayed (submit_duel_run rejects a
// second run per side), so a timeline is no longer a chase target or a hint.
// The fill is tinted toward whoever is ahead at that instant, which is what
// makes the crossings readable.
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
  // Both curves come from the server once both runs are in. It sends the
  // SECONDS at which each side banked a correct answer — times only, never the
  // answers — so the opponent's line is their real pace rather than their
  // final score held flat. Before the reveal these are absent, and the panel
  // is hidden anyway.
  //
  // i.record is the locally-saved timeline of this browser's own run. It is
  // still the fallback for your own line, for a duel finished a moment ago on
  // a database that has not had the migration applied yet.
  const localPts = (i.record && Array.isArray(i.record.points)) ? i.record.points : [];
  const myPts    = Array.isArray(i.myPoints)    && i.myPoints.length    ? i.myPoints    : localPts;
  const themRaw  = Array.isArray(i.theirPoints) ? i.theirPoints : [];

  // banked-so-far extrapolated to the full run, the same maths results.js uses.
  const curve = (times, finalScore) => {
    const out = [];
    for (let k = 0; k < times.length; k++) {
      const x = Number(times[k]);
      const banked = k + 1;
      if (!(x > 0) || x > duration) continue;
      if (banked < DUEL_WARMUP_Q || x < DUEL_WARMUP_SEC) continue;
      out.push({ x: duelRound1(x), y: duelRound1(banked * duration / x) });
    }
    // Terminal point: the score actually finished on, so the line lands on the
    // number in the card above it.
    if (finalScore !== null) out.push({ x: duration, y: finalScore });
    return out;
  };

  const youPts = curve(myPts, i.myScore);

  panel.style.display = 'block';

  // Fewer than three plotted points is not a curve.
  const havePace  = youPts.length >= 3;
  const themCurve = curve(themRaw, i.theirScore);
  const haveThem  = themCurve.length >= 3;

  // Their real pace when the server gave it, otherwise the one thing that IS
  // known about them — the score they finished on — held flat and labelled.
  const themPts = haveThem
    ? themCurve
    : (havePace ? youPts : [{ x: 0 }, { x: duration }]).map(p => ({ x: p.x, y: i.theirScore }));
  const yourFlat = [{ x: 0, y: i.myScore }, { x: duration, y: i.myScore }];

  if (note) {
    // Either line being real makes this a pace chart. Reading only the
    // viewer's would label a chart carrying a real opponent curve "Final
    // scores only", which is the one thing this caption exists not to do.
    note.textContent = (havePace || haveThem)
      ? 'Projected score over the run'
      : 'Final scores only';
  }
  if (caption) {
    const bothReal =
      'Both lines are projected score — questions banked so far, extrapolated to the full '
      + duration + ' seconds. Where your line is above theirs, you were ahead on pace at that '
      + 'moment. Only the times are shared, never the answers, and only once both runs are in.';
    const yoursOnly =
      'Your line is your projected score — questions banked so far, extrapolated to the full '
      + duration + ' seconds. Their per-answer times were not recorded for this duel, so their '
      + 'line is the score they finished on, held flat.';
    const theirsOnly =
      'Their line is projected score — questions banked so far, extrapolated to the full '
      + duration + ' seconds. Your own per-answer times are not available for this run, so your '
      + 'line is the score you finished on, held flat.';
    const neither =
      "The per-answer timeline for this run isn't available, so this is the honest "
      + 'version: the two final scores, nothing interpolated between them.';

    caption.textContent = havePace
      ? (haveThem ? bothReal  : yoursOnly)
      : (haveThem ? theirsOnly : neither);
  }

  const cYou   = themeColor('--c-duel-you',    '#333');
  const cThem  = themeColor('--c-duel-them',   '#888');
  const cAhead = themeColor('--c-duel-ahead',  'rgba(0, 102, 0, 0.18)');
  const cBehnd = themeColor('--c-duel-behind', 'rgba(204, 0, 0, 0.15)');
  const cGrid  = themeColor('--c-rule',        '#eee');
  const cText  = themeColor('--c-ink-muted',   '#555');

  const ys  = [i.myScore, i.theirScore, ...youPts.map(p => p.y), ...themPts.map(p => p.y)];
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
          // Same rule as the opponent's line below: dashed means "this is the
          // final score standing in for a curve", solid means measured.
          borderDash: havePace ? [] : [5, 4],
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
          // Dashed only when the line is the flat final-score fallback, so the
          // styling itself says whether it is a measured curve.
          borderDash: haveThem ? [] : [5, 4],
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

// ══════════════════════════════════════════════════════════════
// STEAL MODE
// ══════════════════════════════════════════════════════════════
// docs/steal-mode-design.md. First correct answer takes the point and BOTH
// players jump to the next question, so unlike a classic duel this shares
// state during the run — which brings in three problems a classic duel does
// not have, and every rule below is one of them:
//
//   1. Arbitration under latency. The server decides, on the client's
//      time-since-the-question-was-rendered, clamped to what it observed
//      itself. This file never decides who won a point. It sends a claim and
//      believes the answer.
//
//   2. Advancing without a stall. Waiting for arbitration would put a visible
//      pause on every question, which in a speed game is fatal. So a correct
//      answer advances the screen AT ONCE, broadcasts a hint, and settles the
//      point a beat later. If arbitration disagrees, the SCORE corrects and
//      the QUESTION does not rewind — a question moving backwards is far more
//      disorienting than a number moving by one.
//
//   3. Somebody's connection dying. Presence, a ten-second grace, and then the
//      duel ends early on the score so far, marked as ended early and NOT as a
//      win for whoever stayed. Awarding the rest to the survivor would make
//      pulling your own cable a winning move.
//
// The rule that runs through all of it: **a broadcast is a hint, never
// authority.** A message can move somebody's screen. It can never move a
// score. Every number this file displays as a point came out of a
// claim_duel_point return value, and the final number comes from the server's
// own recount at the end. That is why a forged `advance` is a nuisance rather
// than a cheat.
//
// Both timers here — the 3-2-1 countdown and the disconnect grace — are
// anchored to a deadline and compare against the clock on every tick. The
// countdown uses Date.now() because its deadline is SHARED between two
// machines; the run clock uses performance.now() like every other run in this
// project, because it is local and monotonic.

const STEAL_COUNTDOWN_MS = 3200;   // 3-2-1 plus a beat, so "1" is readable
const STEAL_GRACE_MS     = 10000;  // presence grace before the duel ends early
const STEAL_SETTLE_MS    = 400;    // the server's grace window for a better claim
const STEAL_FLASH_MS     = 700;    // how long the loser flash stays on the question

// How far ahead of us an `advance` hint is allowed to be before it is ignored.
// Being a few questions behind is ordinary after a reconnect; being a hundred
// behind is not, and acting on it would let a forged message walk somebody off
// the end of the question list and end their duel.
const STEAL_HINT_LOOKAHEAD = 25;

// A `start` deadline this far outside the present is not a countdown, so it is
// ignored rather than obeyed — otherwise one bad message parks both players in
// front of a "3" that never becomes a "2".
const STEAL_START_MAX_MS = 60000;
const STEAL_START_MIN_MS = -5000;

// ── State ─────────────────────────────────────────────────────

let stealSide     = '';      // 'creator' | 'opponent' — which side this client is
let stealChan     = null;    // the Realtime channel, or null when unavailable
let stealChanKey  = '';      // this tab's presence key
let stealRoomOpen = false;

let stealPresent = { creator: false, opponent: false };
let stealNames   = { creator: '', opponent: '' };   // user-controlled: escape on the way out
let stealReady   = { creator: false, opponent: false };

let stealStartAt    = null;  // shared epoch-ms deadline for the countdown
let stealCountTimer = null;

let stealRun        = null;  // { key, side, duration, startedAt, questions }
let stealIndex      = 0;     // the question on screen
let stealPoints     = null;  // Map index -> { winner, state, ms }
let stealQuestionAt = null;  // performance.now() when the current question appeared
let stealDeadline   = null;  // performance.now() the run ends at
let stealTimer      = null;
let stealFlashTimer = null;
let stealInputWired = false;
let stealLaunching  = false;
let stealEnding     = false;
let stealEnded      = false;
let stealResyncing  = false; // rejoined mid-run and not yet certain of the index

let stealGraceUntil = null;  // epoch ms the grace expires
let stealGraceTimer = null;

// ── Small predicates ──────────────────────────────────────────

function stealModeOf(d) {
  return !!d && String(d.mode || 'classic') === 'steal';
}

function stealRunLive() {
  return !!(stealRun && stealDeadline !== null && !stealEnded && !stealEnding);
}

// True while the page is showing a room or a run, i.e. while re-resolving the
// page state would destroy something the other player can see.
function stealActive() {
  return stealRoomOpen || stealRunLive();
}

function stealOther() {
  return stealSide === 'creator' ? 'opponent' : 'creator';
}

function stealBothReady() {
  return stealPresent.creator && stealPresent.opponent
      && stealReady.creator   && stealReady.opponent;
}

// ── The room ──────────────────────────────────────────────────
// Steal mode needs both players present at once, so the link opens a room
// rather than a Start button.

function showStealRoom(d) {
  duelHide('duel-loading');
  duelHide('duel-panel');
  duelHide('duel-notice');
  duelHide('duel-result');
  duelHide('duel-graph-panel');
  duelHide('duel-game');
  duelHide('steal-game');

  stealRoomOpen = true;
  stealSide = String(d.your_side || '') === 'creator' ? 'creator' : 'opponent';
  stealPresent[stealSide] = true;
  stealNames[stealSide] = stealMyName();

  document.getElementById('duel-title').textContent =
    stealSide === 'creator' ? 'Your steal duel' : "You've been challenged";

  renderStealRoom(d);
  duelShow('steal-room', 'block');
  if (stealSide === 'creator') showDuelShareLink(duelKey);

  stealJoinChannel();
}

// This client's own display name, for presence. Nothing on the duel payload
// carries a username (a duel is a link, not a directory), so it comes from the
// signed-in profile if there is one and is otherwise absent — a guest is
// "Opponent", which is honest.
let stealMyNameCache = null;
function stealMyName() {
  if (stealMyNameCache !== null) return stealMyNameCache;
  stealMyNameCache = '';
  const user = (typeof currentUser !== 'undefined') ? currentUser : null;
  if (user && typeof getProfile === 'function') {
    // Fire and forget: the room renders immediately with a role label and
    // upgrades to the name when it arrives.
    getProfile(user.id).then(p => {
      const name = p && typeof p.username === 'string' ? p.username.trim() : '';
      if (!name) return;
      stealMyNameCache = name;
      stealNames[stealSide] = name;
      stealTrack();
      if (stealRoomOpen) renderStealRoom(duelPayload || {});
    }).catch(() => {});
  }
  return stealMyNameCache;
}

function renderStealRoom(d) {
  const el = document.getElementById('steal-room');
  if (!el) return;

  const duration = duelNumber(d && d.duration_seconds) ?? (duelPayload ? duelNumber(duelPayload.duration_seconds) : null) ?? 120;
  const creator  = stealSide === 'creator';
  const both     = stealBothReady();
  const iAmReady = stealReady[stealSide] === true;

  let status;
  if (!stealPresent[stealOther()]) {
    status = creator ? 'Waiting for your opponent to open the link.'
                     : 'Waiting for the creator to come back to the room.';
  } else if (!both) {
    status = stealReady[stealOther()]
      ? "They're ready. Press Ready when you are."
      : "Waiting for them to press Ready.";
  } else {
    status = creator ? 'Both ready — start when you like.'
                     : 'Both ready — waiting for the creator to start.';
  }

  // Offered to the creator whenever the other side is not here: the questions
  // already exist, and a classic duel needs nobody to be awake.
  const convert = (creator && !stealPresent.opponent) ? `
    <div class="steal-convert">
      <strong>Nobody has taken the other side yet.</strong>
      <p>
        A steal duel needs both of you here at the same time. If they can't
        make it, this one can become a classic duel instead — the questions are
        already generated, and a classic duel needs nobody to be awake: you
        each play whenever you like and compare afterward.
      </p>
      <div class="duel-notice-actions">
        <button class="btn" id="steal-convert-btn">Convert to a classic duel</button>
        <span class="duel-start-status" id="steal-convert-status" role="status" aria-live="polite"></span>
      </div>
    </div>` : '';

  el.innerHTML = `
    <div class="panel-head">
      <h2>The room</h2>
      <span class="panel-note">${escapeHtml(duration)}-second steal duel</span>
    </div>

    <p class="duel-lede">
      The first correct answer takes the point and you both jump to the next
      question. That only works if you are both here, so nothing starts until
      you have both pressed Ready.
    </p>

    <ul class="steal-players">
      ${stealPlayerRow('creator')}
      ${stealPlayerRow('opponent')}
    </ul>

    <div class="steal-room-actions">
      <button class="btn" id="steal-ready-btn">${iAmReady ? 'Not ready' : 'Ready'}</button>
      ${creator ? `<button class="btn-start" id="steal-start-btn"${both ? '' : ' disabled'}>Start the duel</button>` : ''}
      <span class="steal-room-status" id="steal-room-status" role="status" aria-live="polite">${escapeHtml(status)}</span>
    </div>

    <div class="steal-countdown" id="steal-countdown" role="status" aria-live="assertive"></div>
    ${convert}
  `;

  const ready = document.getElementById('steal-ready-btn');
  if (ready) ready.addEventListener('click', stealToggleReady);
  const start = document.getElementById('steal-start-btn');
  if (start) start.addEventListener('click', stealStartCountdown);
  const conv = document.getElementById('steal-convert-btn');
  if (conv) conv.addEventListener('click', stealConvertToClassic);

  // A countdown already running must survive a re-render caused by a presence
  // change, so its text is restored rather than left blank until the next tick.
  if (stealStartAt !== null) stealTickCountdown();
}

// Every value in here that came off the wire is escaped: a presence payload is
// written by the OTHER browser, and a username is user-controlled text.
function stealPlayerRow(side) {
  const you   = side === stealSide;
  const label = side === 'creator' ? 'Creator' : 'Opponent';
  const name  = stealNames[side];
  const who   = name ? name : (you ? 'You' : label);
  const tag   = (you && name) ? ' (you)' : '';
  const state = !stealPresent[side] ? 'Not here yet'
              : stealReady[side]    ? 'Ready'
              : 'Here — not ready';
  const cls   = !stealPresent[side] ? 'is-away' : stealReady[side] ? 'is-ready' : 'is-here';

  return `
    <li class="steal-player ${cls}">
      <span class="steal-player-name">${escapeHtml(who)}${tag}</span>
      <span class="steal-player-role">${escapeHtml(label)}</span>
      <span class="steal-player-state">${escapeHtml(state)}</span>
    </li>`;
}

function stealToggleReady() {
  stealReady[stealSide] = !stealReady[stealSide];
  stealTrack();
  if (stealReady[stealSide]) stealSend('ready', { side: stealSide });
  renderStealRoom(duelPayload || {});
}

async function stealConvertToClassic() {
  const btn    = document.getElementById('steal-convert-btn');
  const status = document.getElementById('steal-convert-status');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Converting…';
  if (status) status.textContent = '';

  const res = (typeof convertDuelToClassic === 'function')
    ? await convertDuelToClassic(duelKey)
    : null;

  if (!res) {
    btn.disabled = false;
    btn.textContent = 'Convert to a classic duel';
    if (status) {
      status.textContent = (typeof lastDuelError !== 'undefined' && lastDuelError)
        || "Couldn't convert this duel — try again in a moment.";
    }
    return;
  }

  // The duel is a classic duel now, so the page is a different page.
  stealTeardown();
  await resolveDuelState();
}

// ── The countdown ─────────────────────────────────────────────
// A SHARED DEADLINE, not each client's own counter. The creator picks a
// wall-clock instant, broadcasts it, and both screens count towards the same
// number — so a throttled background tab, a slow paint or a dropped frame
// changes nothing about when the run actually starts.

function stealStartCountdown() {
  const btn = document.getElementById('steal-start-btn');
  if (btn && btn.disabled) return;
  if (!stealBothReady()) return;
  const at = Date.now() + STEAL_COUNTDOWN_MS;
  stealSend('start', { at });
  stealBeginCountdown(at);
}

function stealBeginCountdown(at) {
  const t = Number(at);
  if (!Number.isFinite(t)) return;
  const delta = t - Date.now();
  if (delta > STEAL_START_MAX_MS || delta < STEAL_START_MIN_MS) return;
  if (stealStartAt !== null) return;      // already counting
  stealStartAt = t;

  const btn = document.getElementById('steal-start-btn');
  if (btn) btn.disabled = true;
  const ready = document.getElementById('steal-ready-btn');
  if (ready) ready.disabled = true;

  if (stealCountTimer) clearInterval(stealCountTimer);
  stealCountTimer = setInterval(stealTickCountdown, 100);
  stealTickCountdown();
}

function stealTickCountdown() {
  const el = document.getElementById('steal-countdown');
  if (stealStartAt === null) return;

  const left = stealStartAt - Date.now();
  if (left <= 0) {
    if (stealCountTimer) { clearInterval(stealCountTimer); stealCountTimer = null; }
    if (el) el.textContent = 'Go';
    stealLaunchRun();
    return;
  }
  // Ceil, so a deadline 3.2s out reads "3" and the last visible number is "1".
  if (el) el.textContent = String(Math.min(3, Math.max(1, Math.ceil(left / 1000))));
}

// ── Starting the run ──────────────────────────────────────────

async function stealLaunchRun() {
  if (stealLaunching || stealRun) return;
  stealLaunching = true;

  const status = document.getElementById('steal-room-status');
  if (status) status.textContent = 'Starting…';

  const run = await startDuelRun(duelKey);
  stealLaunching = false;

  const questions = (run && Array.isArray(run.questions)) ? run.questions : [];
  if (!run || String(run.status || '') !== 'in_progress' || !questions.length) {
    stealStartAt = null;
    if (status) {
      status.textContent = (typeof lastDuelError !== 'undefined' && lastDuelError)
        || "Couldn't start the run — try again in a moment.";
    }
    const btn = document.getElementById('steal-start-btn');
    if (btn) btn.disabled = false;
    const ready = document.getElementById('steal-ready-btn');
    if (ready) ready.disabled = false;
    return;
  }

  enterStealRun(run);
}

// A refresh, or a tab that came back, lands here: start_duel_run is idempotent
// and returns the REAL remaining time. What it does not return is which
// question the duel is on — that lives in duel_points, and there is no
// function in the contract to ask for it — so the run comes back in at the
// first question and snaps forward on the next `advance` it hears. Stated on
// screen rather than hidden, because a player who is behind should know it.
async function stealRejoinRun(d) {
  stealSide = String(d.your_side || '') === 'creator' ? 'creator' : 'opponent';
  stealPresent[stealSide] = true;
  stealNames[stealSide] = stealMyName();
  stealJoinChannel();

  const run = await startDuelRun(duelKey);
  const questions = (run && Array.isArray(run.questions)) ? run.questions : [];
  if (!run || String(run.status || '') !== 'in_progress' || !questions.length) {
    // The window closed while the page was away: whatever the duel says now is
    // the answer, and the classic result renderer says it.
    showDuelResult(duelPayload || {});
    return;
  }
  stealResyncing = true;
  enterStealRun(run);
  stealBanner("Reconnected. You may be a question behind until the next point is taken.");
}

function enterStealRun(run) {
  stealRun = {
    key:       duelKey,
    side:      String(run.side || stealSide),
    duration:  duelNumber(run.duration_seconds) ?? 120,
    startedAt: String(run.started_at || ''),
    questions: run.questions,
  };
  stealSide = stealRun.side === 'creator' ? 'creator' : 'opponent';

  stealPoints = new Map();
  stealIndex  = 0;
  stealEnded  = false;
  stealEnding = false;

  const remaining = Math.max(0, duelNumber(run.seconds_remaining) ?? stealRun.duration);
  stealDeadline = performance.now() + remaining * 1000;

  stealRoomOpen = false;
  duelHide('steal-room');
  duelHide('duel-panel');
  duelHide('duel-share');
  duelHide('duel-result');
  duelHide('duel-notice');
  duelHide('duel-graph-panel');
  duelHide('duel-expiry');
  duelShow('steal-game', 'block');
  duelHide('steal-overlay');

  const input = document.getElementById('steal-input');
  if (input) { input.disabled = false; input.value = ''; }

  wireStealInput();
  stealRenderScore();
  stealSetLine('', '');
  stealShowQuestion();
  stealTick();
  // Anchored to stealDeadline, not counted in ticks — a background tab
  // throttles setInterval and a tick-counted clock hands out free time.
  stealTimer = setInterval(stealTick, 250);

  // Presence now carries the side the SERVER gave us, which is the one the
  // other player should see.
  stealTrack();
}

function stealTick() {
  if (!stealRunLive()) return;
  const left = Math.max(0, Math.ceil((stealDeadline - performance.now()) / 1000));
  const el = document.getElementById('steal-timer');
  if (el) el.textContent = 'Seconds left: ' + left;
  if (left <= 0) stealFinish('time');
}

function stealShowQuestion() {
  if (!stealRun) return;
  const q = stealRun.questions[stealIndex];
  if (!q) { stealFinish('time'); return; }

  document.getElementById('steal-question').textContent = String(q.display ?? '') + ' =';
  const input = document.getElementById('steal-input');
  if (input) { input.value = ''; input.focus(); }
  stealQuestionAt = performance.now();
}

// Digits only, Enter clears, a correct answer commits the moment it is
// complete — js/game.js's input handling, unchanged, because a duel is the
// same game. A WRONG answer is not sent anywhere: the server checks the answer
// itself and awards nothing for a wrong one, so a claim for it would be a
// round trip that could only ever say no.
function wireStealInput() {
  if (stealInputWired) return;
  stealInputWired = true;

  const input = document.getElementById('steal-input');
  if (!input) return;

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.value = ''; return; }
    const allowed = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home', 'End'];
    if (!allowed.includes(e.key) && !/^\d$/.test(e.key)) e.preventDefault();
  });

  input.addEventListener('input', () => {
    if (!stealRunLive() || !stealRun) return;
    const q = stealRun.questions[stealIndex];
    if (!q) return;

    const clean = input.value.replace(/\D/g, '');
    if (clean !== input.value) input.value = clean;
    if (!clean) return;

    if (clean === String(q.answer)) stealCommit();
  });
}

// ── Advancing optimistically ──────────────────────────────────
// A correct answer moves this screen NOW. The claim is fired and not awaited:
// the whole point is that arbitration happens behind the player rather than in
// front of them.

function stealCommit() {
  const index = stealIndex;
  const ms    = Math.max(0, Math.round(performance.now() - stealQuestionAt));

  // Optimistic, and shown as such: muted until the server confirms it.
  stealSetPoint(index, stealSide, 'optimistic', ms);
  stealAnnounce(index, stealSide, ms);
  stealAdvanceTo(index + 1);

  stealSend('advance', { index, by: stealSide, ms });
  stealClaim(index, ms);
}

// The question only ever moves FORWARD. An out-of-order hint, a duplicate
// broadcast or a late arbitration cannot rewind it — a question changing back
// underneath a player is far more disorienting than a score moving by one.
function stealAdvanceTo(next) {
  if (!stealRunLive() || !stealRun) return;
  if (next <= stealIndex) return;
  stealIndex = next;
  if (stealIndex >= stealRun.questions.length) { stealFinish('time'); return; }
  stealShowQuestion();
  stealRenderScore();
}

async function stealClaim(index, ms) {
  if (typeof claimDuelPoint !== 'function') return;
  const res = await claimDuelPoint(duelKey, index, ms);

  // A RAISEd refusal. Losing the race, or claiming a question that has already
  // been decided, both mean the point was not ours — which is a correction to
  // the SCORE and to nothing else.
  if (!res) {
    const code = (typeof lastDuelCode !== 'undefined') ? lastDuelCode : null;
    if (code === 'point_taken' || code === 'stale_index') {
      stealSetPoint(index, stealOther(), 'settled', null);
      stealAnnounce(index, stealOther(), null);
      if (code === 'stale_index') stealResyncing = true;
    }
    return;
  }

  // Or a returned refusal — the contract returns { ok:false, error:'wrong' }
  // for a wrong answer, and does not say whether the others are RAISEd or
  // returned, so both shapes are handled.
  if (res.ok === false) {
    const err = String(res.error || '');
    if (err === 'point_taken' || err === 'stale_index') {
      stealSetPoint(index, stealOther(), 'settled', null);
      stealAnnounce(index, stealOther(), null);
    }
    return;
  }

  const winner = res.winner === 'creator' ? 'creator'
               : res.winner === 'opponent' ? 'opponent' : '';
  if (!winner) return;

  const settledMs = duelNumber(res.elapsed_ms);
  stealSetPoint(index, winner, res.provisional === true ? 'provisional' : 'settled', settledMs);

  // Arbitration went the other way. The score has just corrected; the question
  // stays exactly where it is.
  if (winner !== stealSide) {
    stealAnnounce(index, winner, settledMs);
    stealSend('settled', { index, winner });
  }
}

// A point, and how sure of it we are:
//   optimistic  — our own answer, no server word yet
//   provisional — the server awarded it, inside the 400ms window in which a
//                 faster claim can still replace it
//   settled     — as final as this client can know before the server's recount
//
// This map is the ONLY thing the scoreline is computed from, and the only
// things that write to it are claim_duel_point's answers and this client's own
// answers. No broadcast reaches it.
function stealSetPoint(index, winner, state, ms) {
  if (!stealPoints) return;
  stealPoints.set(index, { winner, state, ms });

  if (state === 'provisional') {
    // Firms up on its own: the server's window is 400ms from the first write,
    // which happened no later than the response we just read, so waiting that
    // long from here is the conservative version.
    setTimeout(() => {
      const e = stealPoints && stealPoints.get(index);
      if (e && e.state === 'provisional') { e.state = 'settled'; stealRenderScore(); }
    }, STEAL_SETTLE_MS);
  }
  stealRenderScore();
}

function stealCountFor(side) {
  let n = 0;
  if (!stealPoints) return n;
  for (const e of stealPoints.values()) if (e.winner === side) n++;
  return n;
}

function stealRenderScore() {
  const you  = document.getElementById('steal-score-you');
  const them = document.getElementById('steal-score-them');
  if (!you || !them) return;

  let mine = 0, theirs = 0, mineSoft = false, theirsSoft = false;
  if (stealPoints) {
    for (const e of stealPoints.values()) {
      if (e.winner === stealSide)     { mine++;   if (e.state !== 'settled') mineSoft   = true; }
      else if (e.winner)              { theirs++; if (e.state !== 'settled') theirsSoft = true; }
    }
  }

  you.textContent  = 'You '  + mine;
  them.textContent = 'Them ' + theirs;
  // Muted while a point could still move, firm once it cannot. A point is
  // never shown and then snatched away without the display having said, the
  // whole time, that it was not final yet.
  you.className  = 'steal-score-side' + (mineSoft   ? ' is-provisional' : '');
  them.className = 'steal-score-side' + (theirsSoft ? ' is-provisional' : '');
}

// ── The steal, made legible ───────────────────────────────────
// A question changing underneath you mid-keystroke is disorienting unless the
// interface says why in the same instant: the question area flashes the loser
// state, the answer field clears, and ONE LINE, in place, says who took it and
// how fast. Not a toast over the next question.

function stealAnnounce(index, winner, ms) {
  const mine = winner === stealSide;
  const secs = duelNumber(ms) === null ? null : duelRound1(duelNumber(ms) / 1000);

  const text = mine
    ? (secs === null ? 'Stolen — you took it'        : `Stolen — you had it in ${secs}s`)
    : (secs === null ? 'Stolen — they took it'       : `Stolen — they had it in ${secs}s`);

  stealSetLine(text, mine ? 'is-you' : 'is-them');
  if (!mine) stealFlashLoss();
}

function stealSetLine(text, cls) {
  const el = document.getElementById('steal-line');
  if (!el) return;
  el.textContent = text;
  el.className = 'steal-line' + (cls ? ' ' + cls : '');
}

function stealFlashLoss() {
  const area  = document.getElementById('steal-area');
  const input = document.getElementById('steal-input');
  // The field clears: whatever was half-typed was for a question that is gone.
  if (input) input.value = '';
  if (!area) return;
  area.classList.add('is-stolen');
  if (stealFlashTimer) clearTimeout(stealFlashTimer);
  stealFlashTimer = setTimeout(() => {
    const a = document.getElementById('steal-area');
    if (a) a.classList.remove('is-stolen');
    stealFlashTimer = null;
  }, STEAL_FLASH_MS);
}

// ── Transport ─────────────────────────────────────────────────
// Broadcast for the five messages in the design doc, presence for liveness.
// Everything arriving here is UNTRUSTED: it moves screens and it renders text,
// and it does neither of those things without being escaped and bounded first.

function stealJoinChannel() {
  if (stealChan) return;
  if (typeof duelChannel !== 'function') { stealNoRealtime(); return; }

  stealChanKey = stealSide + '-' + Math.random().toString(36).slice(2, 10);
  const ch = duelChannel(duelKey, stealChanKey);
  if (!ch) { stealNoRealtime(); return; }
  stealChan = ch;

  try {
    ch.on('broadcast', { event: 'ready'   }, m => stealOnReady(m && m.payload));
    ch.on('broadcast', { event: 'start'   }, m => stealOnStart(m && m.payload));
    ch.on('broadcast', { event: 'advance' }, m => stealOnAdvance(m && m.payload));
    ch.on('broadcast', { event: 'settled' }, m => stealOnSettled(m && m.payload));
    ch.on('broadcast', { event: 'bye'     }, m => stealOnBye(m && m.payload));
    ch.on('presence',  { event: 'sync'    }, () => stealSyncPresence());
    ch.on('presence',  { event: 'join'    }, p => stealSyncPresence(p));
    ch.on('presence',  { event: 'leave'   }, p => stealSyncPresence(p));
    ch.subscribe(status => {
      if (String(status) !== 'SUBSCRIBED') return;
      stealTrack();
    });
  } catch (e) {
    console.warn('steal: channel wiring failed:', e);
    stealNoRealtime();
  }
}

// No Realtime at all. The room says so and, for the creator, the fallback that
// already works is right there — this is exactly the failure the convert offer
// exists for.
function stealNoRealtime() {
  stealChan = null;
  const status = document.getElementById('steal-room-status');
  if (status) {
    status.textContent =
      "This browser couldn't open a real-time connection, so a steal duel can't be played here.";
  }
}

function stealTrack() {
  if (!stealChan || typeof stealChan.track !== 'function') return;
  try {
    stealChan.track({
      side:  stealSide,
      name:  String(stealNames[stealSide] || '').slice(0, 40),
      ready: stealReady[stealSide] === true,
    });
  } catch (e) { console.warn('steal: presence track failed:', e); }
}

function stealSend(event, payload) {
  if (!stealChan || typeof stealChan.send !== 'function') return;
  try {
    stealChan.send({ type: 'broadcast', event, payload });
  } catch (e) { console.warn('steal: broadcast failed:', e); }
}

function stealLeaveChannel(clean) {
  if (!stealChan) return;
  if (clean) stealSend('bye', { side: stealSide });
  try { if (typeof stealChan.untrack     === 'function') stealChan.untrack(); }     catch (_) {}
  try { if (typeof stealChan.unsubscribe === 'function') stealChan.unsubscribe(); } catch (_) {}
  stealChan = null;
}

// Which side an untrusted payload is talking about, or '' — every handler
// below starts here, so no message can name a third side into existence.
function stealSideOf(v) {
  return v === 'creator' ? 'creator' : v === 'opponent' ? 'opponent' : '';
}

function stealOnReady(payload) {
  const side = stealSideOf(payload && payload.side);
  if (!side || side === stealSide) return;
  stealPresent[side] = true;
  stealReady[side]   = true;
  if (stealRoomOpen) renderStealRoom(duelPayload || {});
}

function stealOnStart(payload) {
  if (!stealRoomOpen) return;
  stealBeginCountdown(payload && payload.at);
}

// The optimistic advance, seen from the other side. It moves this screen and
// says why. It does NOT touch the score: a message is a hint, and a hint that
// could award a point would make a forged message a cheat.
function stealOnAdvance(payload) {
  if (!stealRunLive()) return;
  const by  = stealSideOf(payload && payload.by);
  const idx = duelNumber(payload && payload.index);
  if (!by || by === stealSide || idx === null) return;

  // Bounded before it is acted on. Below the current question it is a stale
  // hint about something already gone; far above it, it is either nonsense or
  // a forged message trying to run somebody off the end of the question list,
  // which would end their duel. A hint may move a screen by a question. It may
  // not end a run.
  const target = Math.round(idx);
  if (target < stealIndex || target > stealIndex + STEAL_HINT_LOOKAHEAD) return;

  stealAnnounce(target, by, duelNumber(payload && payload.ms));
  stealAdvanceTo(target + 1);
  stealResyncing = false;
}

// Arbitration disagreed with somebody's optimistic view. Same rule: it can
// re-word the line, and it cannot move a number. A point of ours that this
// message contradicts stays MUTED rather than firming up — which is the honest
// display, because the server has the last word at the end of the run and this
// client has not heard it yet.
function stealOnSettled(payload) {
  if (!stealRunLive()) return;
  const winner = stealSideOf(payload && payload.winner);
  const idx    = duelNumber(payload && payload.index);
  if (!winner || idx === null) return;

  const mine = stealPoints && stealPoints.get(Math.round(idx));
  if (mine && mine.state !== 'settled') {
    mine.state = 'provisional';   // stays muted; the server's recount decides
    stealRenderScore();
  }
  if (winner !== stealSide) stealSetLine('Stolen — they took that one', 'is-them');
}

// A clean leave. The point of the message is that the other side does not have
// to sit out the full grace to learn what already happened.
function stealOnBye(payload) {
  const side = stealSideOf(payload && payload.side);
  if (!side || side === stealSide) return;
  stealPresent[side] = false;
  stealReady[side]   = false;
  if (stealRunLive()) { stealFinish('opponent_left'); return; }
  if (stealRoomOpen)  renderStealRoom(duelPayload || {});
}

// Presence: rebuilt from the channel's own state where the client offers it
// (that is the authoritative view and the one a `sync` refers to), and from
// the join/leave deltas otherwise.
function stealSyncPresence(delta) {
  const wasHere = stealPresent[stealOther()];

  if (stealChan && typeof stealChan.presenceState === 'function') {
    let state = {};
    try { state = stealChan.presenceState() || {}; } catch (_) { state = {}; }

    const seen = { creator: false, opponent: false };
    for (const k of Object.keys(state)) {
      const list = Array.isArray(state[k]) ? state[k] : [];
      for (const p of list) {
        const side = stealSideOf(p && p.side);
        if (!side || side === stealSide) continue;   // our own truth is local
        seen[side] = true;
        if (typeof p.name === 'string') stealNames[side] = p.name.slice(0, 40);
        if (typeof p.ready === 'boolean') stealReady[side] = p.ready;
      }
    }
    stealPresent[stealOther()] = seen[stealOther()];
    stealPresent[stealSide]    = true;
  } else if (delta) {
    for (const p of (Array.isArray(delta.newPresences) ? delta.newPresences : [])) {
      const side = stealSideOf(p && p.side);
      if (side && side !== stealSide) {
        stealPresent[side] = true;
        if (typeof p.name === 'string') stealNames[side] = p.name.slice(0, 40);
        if (typeof p.ready === 'boolean') stealReady[side] = p.ready;
      }
    }
    for (const p of (Array.isArray(delta.leftPresences) ? delta.leftPresences : [])) {
      const side = stealSideOf(p && p.side);
      if (side && side !== stealSide) stealPresent[side] = false;
    }
  }

  const nowHere = stealPresent[stealOther()];
  if (stealRunLive()) {
    if (wasHere && !nowHere) stealBeginGrace();
    if (!wasHere && nowHere) stealStopGrace(true);
  }
  if (stealRoomOpen) renderStealRoom(duelPayload || {});
}

// ── Disconnects ───────────────────────────────────────────────
// Ten seconds of grace, then the duel ends early on the score so far. NOT a
// win for whoever stayed: awarding the remaining questions to the survivor
// would make pulling your own cable the winning move, which is the one outcome
// a competitive mode must not reward.
//
// Anchored to a wall-clock deadline like every other timer here, so a
// throttled background tab cannot stretch ten seconds into a minute.

function stealBeginGrace() {
  if (stealGraceUntil !== null) return;
  stealGraceUntil = Date.now() + STEAL_GRACE_MS;
  if (stealGraceTimer) clearInterval(stealGraceTimer);
  stealGraceTimer = setInterval(stealTickGrace, 250);
  stealTickGrace();
}

function stealTickGrace() {
  if (stealGraceUntil === null) return;
  const leftMs = stealGraceUntil - Date.now();
  if (leftMs <= 0) {
    stealStopGrace(false);
    stealFinish('opponent_left');
    return;
  }
  stealBanner(`Your opponent has dropped out. Ending the duel in ${Math.ceil(leftMs / 1000)}s unless they come back.`);
}

function stealStopGrace(clearBanner) {
  if (stealGraceTimer) { clearInterval(stealGraceTimer); stealGraceTimer = null; }
  stealGraceUntil = null;
  if (clearBanner) stealBanner('');
}

function stealBanner(text) {
  const el = document.getElementById('steal-banner');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

// ── Ending ────────────────────────────────────────────────────

async function stealFinish(reason) {
  if (stealEnding || stealEnded) return;
  stealEnding = true;

  if (stealTimer) { clearInterval(stealTimer); stealTimer = null; }
  stealStopGrace(true);

  const input = document.getElementById('steal-input');
  if (input) input.disabled = true;

  stealShowOverlay(`
    <h2>${reason === 'time' ? "Time's up!" : 'Duel ended early'}</h2>
    <div class="gameover-label">Getting the final score from the server…</div>
  `);

  // The duel is marked ended early server-side only when it actually ended
  // early. A run that reached its own deadline just ended.
  let ended = null;
  if (reason !== 'time' && typeof endDuelEarly === 'function') {
    ended = await endDuelEarly(duelKey, reason);
  }

  // Whatever the server says the duel is now, which is the only place a final
  // score comes from. A failure here is survivable; a fabricated score is not.
  let payload = null;
  try { payload = await getDuel(duelKey); } catch (e) { console.warn('steal: reload failed:', e); }

  stealEnded = true;
  stealLeaveChannel(reason !== 'opponent_left');
  showStealEnded(reason, payload || duelPayload, ended);
}

function stealShowOverlay(html) {
  const el = document.getElementById('steal-overlay');
  if (!el) return;
  el.innerHTML = html;    // literal markup from this file only
  el.style.display = 'flex';
}

// A score off an arbitrary payload, tolerant about where it sits: an
// end_duel_early result may carry `creator_score` or a `creator: { score }`
// block, and this must not invent a number from either shape being absent.
function stealScoreFrom(payload, side) {
  if (!payload || typeof payload !== 'object') return null;
  const flat = duelNumber(payload[side + '_score']);
  if (flat !== null) return flat;
  const block = payload[side];
  if (block && typeof block === 'object') return duelNumber(block.score);
  return null;
}

function showStealEnded(reason, d, ended) {
  duelHide('steal-game');
  duelHide('steal-overlay');
  duelHide('steal-room');
  duelHide('duel-loading');
  duelHide('duel-panel');
  duelHide('duel-share');

  const payload  = (d && typeof d === 'object') ? d : {};
  const duration = (stealRun ? stealRun.duration : null) ?? duelNumber(payload.duration_seconds) ?? 120;
  const other    = stealOther();

  // The server's numbers, from the end_duel_early result if it gave any and
  // otherwise from the reloaded duel. duelScoreOf() keeps its reveal gate:
  // this client never reads around it.
  let mine   = stealScoreFrom(ended, stealSide);
  let theirs = stealScoreFrom(ended, other);
  if (mine === null || theirs === null) {
    mine   = duelScoreOf(payload, duelBlock(payload, stealSide));
    theirs = duelScoreOf(payload, duelBlock(payload, other));
  }

  // Nothing from the server: fall back to the points this client watched the
  // server award, and SAY that is what they are. It is a tally of server
  // rulings, not a score this file worked out, and it is labelled so that
  // nobody reads it as final.
  const fromServer = mine !== null && theirs !== null;
  if (!fromServer) {
    mine   = stealCountFor(stealSide);
    theirs = stealCountFor(other);
  }

  const outcome = (payload.outcome && typeof payload.outcome === 'object') ? payload.outcome : null;

  let heading, note, tone = '';
  if (reason !== 'time') {
    // Ended early is not a win, and is not coloured like one.
    heading = 'Ended early';
    note = reason === 'opponent_left'
      ? 'Your opponent dropped out and did not come back within ten seconds, so the duel is recorded on the score so far. That is not a win for anybody — treating a dropped connection as a victory would make pulling the cable a winning move.'
      : 'You left, so the duel is recorded on the score so far. That is not a win for anybody.';
  } else if (fromServer && outcome && outcome.type === 'decided' && outcome.winner === 'tie') {
    heading = 'Tied';  tone = 'is-tie';
    note = 'Same score, same questions, decided point by point on the server. Rematch.';
  } else if (fromServer && outcome && outcome.type === 'decided' && outcome.winner === stealSide) {
    heading = 'You won';  tone = 'is-win';
    note = 'Every point was arbitrated on the server, on time since the question appeared.';
  } else if (fromServer && outcome && outcome.type === 'decided') {
    heading = 'You lost';  tone = 'is-loss';
    note = 'Every point was arbitrated on the server, on time since the question appeared.';
  } else {
    heading = 'Steal duel over';
    note = 'The clock ran out. Every point was arbitrated on the server, on time since the question appeared.';
  }

  const el = document.getElementById('duel-result');
  el.innerHTML = `
    <div class="duel-verdict ${escapeHtml(tone)}">
      <div class="duel-verdict-head">${escapeHtml(heading)}</div>
      <div class="stats-row duel-verdict-stats">
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(mine)}</div>
          <div class="stat-label">You</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(theirs)}</div>
          <div class="stat-label">Them</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(duration)}s</div>
          <div class="stat-label">Duration</div>
        </div>
      </div>
      <p class="duel-verdict-note">${escapeHtml(note)}</p>
      ${fromServer ? '' : `
      <p class="duel-verdict-note">
        These are the points this browser watched the server award. The duel's
        own final score is recomputed from the points table — reload to see it.
      </p>`}
      <div class="duel-result-actions">
        <a href="duel.html">Start another duel</a>
        <a href="index.html">Play a solo game</a>
      </div>
    </div>
  `;
  el.style.display = 'block';
  document.getElementById('duel-title').textContent = reason === 'time' ? 'Steal duel' : 'Duel ended early';
}

// ── Teardown ──────────────────────────────────────────────────

function stealTeardown() {
  if (stealCountTimer) { clearInterval(stealCountTimer); stealCountTimer = null; }
  if (stealTimer)      { clearInterval(stealTimer);      stealTimer = null; }
  if (stealGraceTimer) { clearInterval(stealGraceTimer); stealGraceTimer = null; }
  if (stealFlashTimer) { clearTimeout(stealFlashTimer);  stealFlashTimer = null; }

  stealLeaveChannel(false);

  stealRoomOpen   = false;
  stealStartAt    = null;
  stealGraceUntil = null;
  stealRun        = null;
  stealPoints     = null;
  stealDeadline   = null;
  stealIndex      = 0;
  stealEnding     = false;
  stealEnded      = false;
  stealResyncing  = false;
  stealPresent = { creator: false, opponent: false };
  stealReady   = { creator: false, opponent: false };
  stealNames   = { creator: '', opponent: '' };
}

// Leaving cleanly tells the other side, so they are not left staring at a
// grace countdown for something that has already happened. pagehide fires on
// tab close and on bfcache eviction, where visibilitychange does not.
window.addEventListener('pagehide', () => {
  if (stealActive()) stealLeaveChannel(true);
});
