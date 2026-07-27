// Zetamac Daily — daily.html
//
// One puzzle a day, the same questions for everyone, one ranked attempt. The
// page is a small state machine over what the server says has happened today:
//
//   signed out    → explain, and offer the auth modal. A ranked daily needs an
//                   account, because one attempt cannot be enforced against an
//                   anonymous player.
//   not played    → puzzle number, the rules, an irreversible Start.
//   in progress   → the run, resumed from the server's remaining time.
//   complete      → the server's result, the board, a share string.
//   expired       → started, never submitted, window gone. Say so plainly.
//
// Two rules run through all of it:
//
//   * The clock is the server's. seconds_remaining from start_daily is
//     anchored to a wall-clock deadline (the way js/game.js does it) so a
//     background tab cannot hand out extra time, and a refresh mid-run picks
//     up the real remaining time rather than starting over.
//   * The score is the server's. This file counts answers so the HUD has
//     something to show, but that count is labelled "Answered", never shown as
//     a result, and never substituted for what submit_daily returns.
//
// Usernames on the leaderboard are user-controlled and this page renders them
// into innerHTML, so every one goes through escapeHtml() from js/util.js.

const DAILY_BOARD_LIMIT  = 100;
const DAILY_DRAFT_PREFIX = 'zt_daily_draft_';

// ── State ─────────────────────────────────────────────────────

let dailyStatus   = null;   // last get_daily_status payload
let dailyRun      = null;   // { puzzleNumber, puzzleDate, duration, startedAt, questions }
let dailyAnswers  = [];     // [{ i, value, elapsed_ms }] — what gets submitted
let dailyIndex    = 0;      // questions committed correctly, i.e. the current question
let dailyCurrent  = null;   // { display, operation, answer }
let dailyWrongLogged = false; // one wrong entry per question, at most

// performance.now() reading that corresponds to the start of the run, derived
// from the server's seconds_remaining — not from when this page loaded.
let dailyRunOrigin = null;
let dailyDeadline  = null;

let dailyTimer      = null;
let dailyResetTimer = null;
let dailyInputWired = false;

let dailySubmitting = false;
let dailySubmitted  = false;

// Which user the current view was built for. `undefined` means never resolved,
// which is distinct from null (resolved, signed out).
let dailyViewUserId = undefined;
let dailyResolving  = false;

// ── Boot ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const topBar = document.getElementById('top-bar');

  // The auth bar is decoration: a broken client must not stop the page from
  // rendering a readable explanation of why the daily is unavailable.
  try {
    createAuthModal();
    let user = null;
    try {
      user = await initAuth({
        onAuthChange: (u) => { renderAuthBar(u, topBar); onDailyAuthChange(u); },
      });
    } catch (e) { console.warn('initAuth failed:', e); }
    renderAuthBar(user, topBar);
  } catch (e) {
    console.warn('auth bar unavailable:', e);
    if (typeof renderThemeToggle === 'function') renderThemeToggle(topBar);
  }

  await resolveDailyState();
});

// Logging in or out changes which of the five states applies. Never while a
// run is live, though: re-resolving would tear the game out from under a
// player who is mid-attempt, and they only get the one.
function onDailyAuthChange(user) {
  const id = user ? user.id : null;
  if (dailyRunLive()) return;
  if (id === dailyViewUserId) return;   // onAuthStateChange also fires on load
  resolveDailyState();
}

// ── State machine ─────────────────────────────────────────────

async function resolveDailyState() {
  if (dailyResolving) return;
  dailyResolving = true;

  try {
    const user = (typeof currentUser !== 'undefined') ? currentUser : null;
    dailyViewUserId = user ? user.id : null;
    resetDailyView();

    // db.js did not load at all (blocked CDN, file missing).
    if (typeof getDailyStatus !== 'function') {
      showDailyUnavailable('db.js unavailable');
      return;
    }

    if (!user) {
      showDailySignedOut();
      return;
    }

    const status = await getDailyStatus();
    if (!status) {
      // Distinguishes "not deployed / unreachable" from every normal answer:
      // get_daily_status always returns a payload for a signed-in caller.
      showDailyUnavailable(
        (typeof lastDailyError !== 'undefined' && lastDailyError) || 'get_daily_status returned nothing'
      );
      return;
    }

    dailyStatus = status;
    renderDailyMeta(status);

    const state = String(status.status || (status.played ? 'complete' : 'not_started'));

    if (state === 'in_progress') {
      await resumeDailyRun();
    } else if (state === 'complete') {
      showDailyComplete(status.result, status);
    } else if (state === 'expired') {
      showDailyExpired(status);
    } else {
      showDailyIntro(status);
    }
  } catch (e) {
    console.error('resolveDailyState failed:', e);
    showDailyUnavailable(String(e && e.message ? e.message : e));
  } finally {
    dailyResolving = false;
  }
}

// Clears everything the previous state put on the page, and stops its timers.
function resetDailyView() {
  if (dailyTimer)      { clearInterval(dailyTimer);      dailyTimer = null; }
  if (dailyResetTimer) { clearInterval(dailyResetTimer); dailyResetTimer = null; }

  dailyHide('daily-notice');
  dailyHide('daily-intro');
  dailyHide('daily-result');
  dailyHide('daily-board-panel');
  dailyHide('daily-reset');
  dailyHide('daily-game');
  dailyHide('daily-overlay');
  dailyShow('daily-loading');

  document.getElementById('daily-notice').innerHTML = '';
  document.getElementById('daily-intro').innerHTML  = '';
  document.getElementById('daily-result').innerHTML = '';
  document.getElementById('daily-board').innerHTML  = '';
}

// ── 1. Signed out ─────────────────────────────────────────────

function showDailySignedOut() {
  dailyHide('daily-loading');
  const el = document.getElementById('daily-notice');
  el.innerHTML = `
    <strong>The daily needs an account.</strong>
    <p>
      Everyone gets the same questions on the same day, so the scores are
      directly comparable — nobody can claim they drew an easier set.
    </p>
    <p>
      That only works with one attempt each, and one attempt can only be
      enforced against an account. An anonymous player can come back as
      somebody else, so an anonymous run cannot be ranked.
    </p>
    <div class="daily-notice-actions">
      <button class="btn btn-primary" id="daily-login-btn">Log in or register</button>
      <a href="index.html">Play an unranked game instead</a>
    </div>
  `;
  el.style.display = 'block';

  document.getElementById('daily-login-btn').addEventListener('click', () => {
    if (typeof showAuthModal === 'function') showAuthModal('login');
  });
}

// ── The daily is not deployed, or could not be reached ────────

function showDailyUnavailable(reason) {
  console.warn('daily unavailable:', reason);
  dailyHide('daily-loading');
  const el = document.getElementById('daily-notice');
  // Literal text only — `reason` is a database message and is not shown.
  el.innerHTML = `
    <strong>Zetamac Daily isn't available right now.</strong>
    <p>
      The page couldn't reach the daily puzzle. This is usually temporary —
      try again in a moment.
    </p>
    <div class="daily-notice-actions">
      <a href="index.html">Play a game</a>
      <a href="dashboard.html">Dashboard</a>
    </div>
  `;
  el.style.display = 'block';
}

// ── 2. Not played yet ─────────────────────────────────────────

function showDailyIntro(status, errorText) {
  dailyHide('daily-loading');

  const duration = dailyNumber(status && status.duration_seconds) ?? 120;
  const number   = dailyNumber(status && status.puzzle_number);

  const el = document.getElementById('daily-intro');
  el.innerHTML = `
    <div class="panel-head">
      <h2>Puzzle #${escapeHtml(number === null ? '—' : number)}</h2>
      <span class="panel-note">${escapeHtml(duration)} seconds</span>
    </div>

    <ul class="daily-rules">
      <li><strong>Everyone gets the same questions.</strong> The whole point: your score is comparable to everybody else's today.</li>
      <li><strong>One attempt.</strong> There is no retry, no second run, and no way to undo a bad one.</li>
      <li><strong>The clock is the server's.</strong> It starts the moment you press Start and keeps running — closing the tab, reloading, or losing your connection does not pause it.</li>
      <li><strong>Resets at midnight UTC</strong>, everywhere, so two players on the same day always get the same puzzle.</li>
    </ul>

    <p class="daily-warn">
      Pressing Start spends today's attempt. The questions do not exist for you
      until you do, and they do not go back in the box afterwards.
    </p>

    <div class="daily-start-row">
      <button class="btn-start" id="daily-start-btn">Start today's puzzle</button>
      <span class="daily-start-status" id="daily-start-status" role="status" aria-live="polite">${escapeHtml(errorText || '')}</span>
    </div>
  `;
  el.style.display = 'block';

  document.getElementById('daily-start-btn').addEventListener('click', startDailyRun);

  renderDailyReset(status);
  renderDailyLeaderboard(status && status.puzzle_date);
}

async function startDailyRun() {
  const btn    = document.getElementById('daily-start-btn');
  const status = document.getElementById('daily-start-status');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = 'Starting…';
  if (status) status.textContent = '';

  const run = await startDaily();
  if (!run) {
    btn.disabled = false;
    btn.textContent = "Start today's puzzle";
    if (status) status.textContent = "Couldn't start the puzzle — try again in a moment.";
    return;
  }

  await enterDailyRun(run);
}

// ── 3. In progress ────────────────────────────────────────────

// A refresh, a dropped connection or a reopened tab lands here. start_daily is
// idempotent, so this asks for the attempt again and gets the REAL remaining
// time back rather than a fresh 120 seconds.
async function resumeDailyRun() {
  const run = await startDaily();
  if (!run) {
    // The status said in_progress, so this is an infrastructure failure rather
    // than a state we can render. Offer the intro with the reason attached —
    // Start will resume the same attempt, not create a second one.
    showDailyIntro(dailyStatus, "Couldn't resume your run — try again in a moment.");
    return;
  }
  await enterDailyRun(run);
}

// Takes a start_daily payload and either begins/resumes the run or, if the
// window has already closed, renders whatever the payload says happened.
async function enterDailyRun(run) {
  const state     = String(run.status || '');
  const remaining = Math.max(0, dailyNumber(run.seconds_remaining) ?? 0);
  const questions = Array.isArray(run.questions) ? run.questions : [];

  renderDailyMeta(run);

  if (state === 'complete') {
    showDailyComplete(run.result, dailyStatus);
    return;
  }

  if (state !== 'in_progress' || !questions.length) {
    showDailyExpired(dailyStatus || run);
    return;
  }

  if (remaining <= 0) {
    // The clock ran out while the page was closed. If a draft survived, it is
    // worth one attempt at submitting it — the server's grace window is short
    // and this will usually be refused, but losing a finished run to a closed
    // tab is the failure worth spending a round trip to avoid.
    await recoverExpiredDailyDraft(run);
    return;
  }

  dailyRun = {
    puzzleNumber: dailyNumber(run.puzzle_number),
    puzzleDate:   String(run.puzzle_date || ''),
    duration:     dailyNumber(run.duration_seconds) ?? 120,
    startedAt:    String(run.started_at || ''),
    questions,
  };

  pruneDailyDrafts(dailyRun.puzzleDate);

  const draft  = loadDailyDraft();
  dailyAnswers = draft ? draft.answers : [];
  dailyIndex   = draft ? Math.min(draft.index, questions.length - 1) : 0;
  dailySubmitting = false;
  dailySubmitted  = false;

  // The origin of the run in the page's own monotonic clock, reconstructed
  // from the server's remaining time. Every elapsed_ms is measured from here,
  // so it stays correct across a refresh instead of restarting at zero.
  const now = performance.now();
  const spentMs  = Math.max(0, (dailyRun.duration - remaining) * 1000);
  dailyRunOrigin = now - spentMs;
  dailyDeadline  = now + remaining * 1000;

  dailyHide('daily-loading');
  dailyHide('daily-intro');
  dailyHide('daily-notice');
  dailyShow('daily-game', 'block');
  dailyHide('daily-overlay');

  const input = document.getElementById('daily-input');
  input.disabled = false;
  input.value = '';

  wireDailyInput();
  updateDailyAnswered();
  showDailyQuestion();
  tickDailyTimer();

  // Anchored to the deadline above, not counted in interval ticks: browsers
  // throttle setInterval in background tabs, and a tick-counted clock would
  // quietly hand out extra playing time whenever the tab lost focus.
  dailyTimer = setInterval(tickDailyTimer, 250);
}

function dailyRunLive() {
  return !!(dailyRun && dailyDeadline !== null && !dailySubmitted && !dailySubmitting);
}

function tickDailyTimer() {
  if (!dailyRunLive()) return;
  const left = Math.max(0, Math.ceil((dailyDeadline - performance.now()) / 1000));
  document.getElementById('daily-timer').textContent = 'Seconds left: ' + left;
  if (left <= 0) finishDailyRun();
}

function showDailyQuestion() {
  const q = dailyRun.questions[dailyIndex];
  if (!q) { finishDailyRun(); return; }

  dailyCurrent     = q;
  dailyWrongLogged = false;

  document.getElementById('daily-question').textContent = String(q.display ?? '') + ' =';
  const input = document.getElementById('daily-input');
  input.value = '';
  input.focus();
}

// Milliseconds since the START OF THE RUN, clamped so the sequence is
// non-decreasing and never exceeds the duration — both are conditions
// submit_daily checks, and both are cheaper to hold here than to argue about
// after a rejected submission.
function dailyElapsedMs() {
  const raw  = Math.round(performance.now() - dailyRunOrigin);
  const last = dailyAnswers.length ? dailyAnswers[dailyAnswers.length - 1].elapsed_ms : 0;
  const cap  = dailyRun.duration * 1000;
  return Math.min(cap, Math.max(last, Math.max(0, raw)));
}

// Input handling is js/game.js's, deliberately unchanged: digits only, Enter
// clears, and a correct answer auto-advances the moment it is complete. The
// daily must feel like the same game, because it is.
function wireDailyInput() {
  if (dailyInputWired) return;
  dailyInputWired = true;

  const input = document.getElementById('daily-input');

  input.addEventListener('keydown', e => {
    // Enter is muscle memory for anyone coming from Zetamac. There is nothing
    // to submit, so treat it as "clear and retry".
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
    if (!dailyCurrent || !dailyRunLive()) return;

    // Strip anything non-numeric that got in by paste or IME. Assigning
    // input.value does not re-fire this handler, so fall through to the checks
    // rather than returning — otherwise a pasted correct answer sits in the
    // box unaccepted and the game stalls.
    const clean = input.value.replace(/\D/g, '');
    if (clean !== input.value) input.value = clean;

    const val    = clean;
    const ansStr = String(dailyCurrent.answer);
    if (!val) return;

    if (val === ansStr) { commitDailyAnswer(val); return; }

    // A wrong answer of the right length is a wrong answer, not a typo on the
    // way to the right one — that is the only point at which the player has
    // actually asserted a number. Recorded once per question so a fumbled
    // keystroke cannot inflate the denominator; the server scores it.
    if (!dailyWrongLogged && val.length >= ansStr.length && !ansStr.startsWith(val)) {
      dailyWrongLogged = true;
      pushDailyAnswer(val);
    }
  });
}

function pushDailyAnswer(value) {
  dailyAnswers.push({ i: dailyIndex, value: Number(value), elapsed_ms: dailyElapsedMs() });
  saveDailyDraft();
}

function commitDailyAnswer(value) {
  pushDailyAnswer(value);
  dailyIndex++;
  saveDailyDraft();
  updateDailyAnswered();

  if (dailyIndex >= dailyRun.questions.length) { finishDailyRun(); return; }
  showDailyQuestion();
}

// "Answered", not "Score". The client's count is a guess — auto-advance means
// it happens to equal the correct count, but the server decides the score and
// this number must never be mistaken for it.
function updateDailyAnswered() {
  document.getElementById('daily-answered').textContent = 'Answered: ' + dailyIndex;
}

// ── Submitting ────────────────────────────────────────────────

async function finishDailyRun() {
  if (dailySubmitting || dailySubmitted || !dailyRun) return;
  dailySubmitting = true;

  if (dailyTimer) { clearInterval(dailyTimer); dailyTimer = null; }
  dailyCurrent = null;

  const input = document.getElementById('daily-input');
  if (input) input.disabled = true;

  showDailyOverlay(`
    <h2>Time's up!</h2>
    <div class="gameover-label">Submitting your answers…</div>
  `);

  const res = await submitDaily(dailyAnswers);
  dailySubmitting = false;

  const score = dailyNumber(res && res.score);
  if (res && score !== null) {
    dailySubmitted = true;
    clearDailyDraft();
    await showDailyResultFromSubmit(res);
    return;
  }

  // The submit failed. It may still have landed (a response lost on the way
  // back), so ask the server what it thinks before offering a retry.
  const status = await getDailyStatus();
  if (status && String(status.status) === 'complete' && status.result) {
    dailySubmitted = true;
    clearDailyDraft();
    dailyStatus = status;
    dailyHide('daily-game');
    showDailyComplete(status.result, status);
    return;
  }

  showDailyOverlay(`
    <h2>Time's up!</h2>
    <div class="gameover-label">
      Your answers couldn't be submitted. They're still saved on this device —
      retrying will send them.
    </div>
    <button class="btn btn-primary" id="daily-retry-btn">Retry submit</button>
  `);
  const retry = document.getElementById('daily-retry-btn');
  if (retry) retry.addEventListener('click', () => { dailySubmitting = false; finishDailyRun(); });
}

async function showDailyResultFromSubmit(res) {
  // submit_daily does not carry seconds_until_reset, and that countdown is the
  // one thing on the finished page that has to be right. One more round trip.
  const status = await getDailyStatus();
  if (status) dailyStatus = status;

  dailyHide('daily-game');
  showDailyComplete(res, dailyStatus);
}

function showDailyOverlay(html) {
  const el = document.getElementById('daily-overlay');
  el.innerHTML = html;   // literal markup from this file only
  el.style.display = 'flex';
}

// A run that finished while the page was closed. Best effort: the server's
// grace window is three seconds, so this normally fails and the attempt is
// correctly reported as expired.
async function recoverExpiredDailyDraft(run) {
  const date  = String(run.puzzle_date || '');
  const draft = readDailyDraft(date, String(run.started_at || ''));

  if (draft && draft.answers.length) {
    const res = await submitDaily(draft.answers);
    if (res && dailyNumber(res.score) !== null) {
      clearDailyDraftFor(date);
      dailySubmitted = true;
      showDailyComplete(res, dailyStatus);
      return;
    }
  }

  clearDailyDraftFor(date);
  showDailyExpired(dailyStatus || run);
}

// Losing a completed run to a closed tab is the worst bug this page can have,
// so the end of the run is also submitted from the visibility hooks.
//
// Only ever once the clock has run out, though. Submitting because somebody
// alt-tabbed at 40 seconds would spend their single attempt for them, and that
// is unrecoverable — whereas a backgrounded live run simply resumes, with its
// answers, when they come back.
function dailyFlushOnHide() {
  if (!dailyRunLive()) return;
  if (dailyDeadline !== null && performance.now() >= dailyDeadline) finishDailyRun();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    dailyFlushOnHide();
  } else {
    // setInterval is clamped while hidden, and the submit window is only the
    // duration plus a few seconds of grace — check the clock immediately
    // rather than waiting for the next tick.
    tickDailyTimer();
  }
});

// pagehide fires on tab close and on bfcache eviction, where visibilitychange
// is not guaranteed. Same condition, so a double call is a no-op.
window.addEventListener('pagehide', dailyFlushOnHide);

// ── Draft (survives a refresh) ────────────────────────────────
// start_daily returns the remaining time but not the answers already given —
// there is nowhere for them to live server-side until the run is submitted. So
// they are kept here, keyed by puzzle date and pinned to the attempt's
// started_at, and a refresh mid-run resumes with them intact.

function dailyDraftKey(date) { return DAILY_DRAFT_PREFIX + date; }

function saveDailyDraft() {
  if (!dailyRun) return;
  try {
    localStorage.setItem(dailyDraftKey(dailyRun.puzzleDate), JSON.stringify({
      startedAt: dailyRun.startedAt,
      index:     dailyIndex,
      answers:   dailyAnswers,
    }));
  } catch (_) { /* private mode, quota — the run still works, it just can't resume */ }
}

// Returns { index, answers } for an attempt, or null. A draft from a different
// attempt on the same date (started_at differs) is discarded rather than
// trusted: replaying stale answers into a new attempt would be worse than
// losing them.
function readDailyDraft(date, startedAt) {
  try {
    const raw = localStorage.getItem(dailyDraftKey(date));
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

function loadDailyDraft() {
  return dailyRun ? readDailyDraft(dailyRun.puzzleDate, dailyRun.startedAt) : null;
}

function clearDailyDraft() {
  if (dailyRun) clearDailyDraftFor(dailyRun.puzzleDate);
}

function clearDailyDraftFor(date) {
  try { localStorage.removeItem(dailyDraftKey(date)); } catch (_) {}
}

// Yesterday's draft is dead weight and can never be submitted.
function pruneDailyDrafts(keepDate) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.indexOf(DAILY_DRAFT_PREFIX) === 0 && k !== dailyDraftKey(keepDate)) {
        localStorage.removeItem(k);
      }
    }
  } catch (_) {}
}

// ── 4. Complete ───────────────────────────────────────────────

function showDailyComplete(result, status) {
  dailyHide('daily-loading');
  dailyHide('daily-intro');
  dailyHide('daily-game');

  const r        = result && typeof result === 'object' ? result : {};
  const score    = dailyNumber(r.score);
  const rank     = dailyNumber(r.rank);
  const players  = dailyNumber(r.players ?? (status && status.players));
  const accuracy = dailyAccuracyPercent(r.accuracy);
  const number   = dailyNumber(r.puzzle_number) ?? dailyNumber(status && status.puzzle_number);

  const rankText = (rank === null)
    ? '—'
    : (players === null ? '#' + rank : `${rank} of ${players}`);

  const el = document.getElementById('daily-result');
  el.innerHTML = `
    <div class="daily-verdict">
      <div class="daily-verdict-head">You finished puzzle #${escapeHtml(number === null ? '—' : number)}.</div>
      <div class="stats-row daily-verdict-stats">
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(score === null ? '—' : score)}</div>
          <div class="stat-label">Score</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(accuracy === null ? '—' : accuracy + '%')}</div>
          <div class="stat-label">Accuracy</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(rankText)}</div>
          <div class="stat-label">Rank</div>
        </div>
      </div>
      <p class="daily-verdict-note">
        Scored on the server from the answers you sent. That's your one attempt
        at this puzzle — the next one opens at midnight UTC.
      </p>

      <div class="daily-share">
        <label class="daily-share-label" for="daily-share-text">Share it</label>
        <div class="daily-share-row">
          <input type="text" id="daily-share-text" class="daily-share-input" readonly value="">
          <button class="btn" id="daily-share-btn">Copy</button>
        </div>
        <p class="daily-share-status" id="daily-share-status" role="status" aria-live="polite"></p>
      </div>
    </div>
  `;
  el.style.display = 'block';

  const shareText = dailyShareString(r, number);
  // A one-line value goes in the input; the URL is appended on copy so the
  // field stays readable and the paste still carries the site.
  const field = document.getElementById('daily-share-text');
  field.value = shareText.split('\n')[0];

  wireDailyShareButton(shareText);

  renderDailyReset(status);
  renderDailyLeaderboard((status && status.puzzle_date) || (dailyRun && dailyRun.puzzleDate));
}

// `Zetamac Daily #142 — 87 · 96%`, then the site on its own line.
function dailyShareString(result, fallbackNumber) {
  const number = dailyNumber(result && result.puzzle_number) ?? fallbackNumber;
  const score  = dailyNumber(result && result.score);
  const acc    = dailyAccuracyPercent(result && result.accuracy);

  let line = `Zetamac Daily #${number === null ? '—' : number} — ${score === null ? '—' : score}`;
  if (acc !== null) line += ` · ${acc}%`;

  const host = dailySiteUrl();
  return host ? `${line}\n${host}` : line;
}

// Host only, resolved at render time. There is no configured site URL anywhere
// in this project, and inventing one here would guarantee it goes stale — the
// page knows where it is being served from. (Same reasoning, and the same
// shape, as shareCardSiteUrl() in js/sharecard.js.)
function dailySiteUrl() {
  try {
    const host = String(window.location.host || '').replace(/^www\./, '');
    if (host) return host;
  } catch (_) {}
  return '';
}

// Text clipboard writes fail in situations real players are actually in — any
// plain-http page (isSecureContext false) and older Safari — so the fallback
// is chosen up front rather than after a rejection they have already waited
// on. The string is always visible in the field, so manual copy is the floor.
function dailyCanCopyText() {
  try {
    return !!(window.isSecureContext
      && navigator.clipboard
      && typeof navigator.clipboard.writeText === 'function');
  } catch (_) {
    return false;
  }
}

async function copyDailyShare(text) {
  if (dailyCanCopyText()) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch (e) {
      console.warn('daily share: clipboard write failed, falling back:', e);
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
    console.warn('daily share: execCommand copy failed:', e);
  }

  return 'manual';
}

function wireDailyShareButton(shareText) {
  const btn    = document.getElementById('daily-share-btn');
  const status = document.getElementById('daily-share-status');
  const field  = document.getElementById('daily-share-text');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;

    const outcome = await copyDailyShare(shareText);

    btn.disabled = false;
    if (outcome === 'copied') {
      status.textContent = 'Copied — paste it anywhere.';
      status.className   = 'daily-share-status is-ok';
    } else {
      status.textContent = "This browser wouldn't let the page copy. The text is selected — press Ctrl/Cmd+C.";
      status.className   = 'daily-share-status is-error';
      if (field) { field.focus(); field.select(); }
    }
  });
}

// ── 5. Expired ────────────────────────────────────────────────

function showDailyExpired(status) {
  dailyHide('daily-loading');
  dailyHide('daily-intro');
  dailyHide('daily-game');

  const number = dailyNumber(status && status.puzzle_number);

  const el = document.getElementById('daily-result');
  el.innerHTML = `
    <div class="daily-notice daily-notice-inline">
      <strong>Your attempt at puzzle #${escapeHtml(number === null ? '—' : number)} ran out.</strong>
      <p>
        You started it, and the window closed before anything was submitted — so
        nothing was scored. The clock runs on the server from the moment a run
        starts, which is what stops anyone reading the questions today and
        answering them tomorrow.
      </p>
      <p>
        That was today's one attempt. The next puzzle opens at midnight UTC.
      </p>
    </div>
  `;
  el.style.display = 'block';

  renderDailyReset(status);
  renderDailyLeaderboard(status && status.puzzle_date);
}

// ── Leaderboard ───────────────────────────────────────────────

async function renderDailyLeaderboard(date) {
  const panel = document.getElementById('daily-board-panel');
  const board = document.getElementById('daily-board');
  const note  = document.getElementById('daily-board-note');
  if (!panel || typeof getDailyLeaderboard !== 'function') return;

  panel.style.display = 'block';
  board.innerHTML = '<p class="daily-board-empty">Loading…</p>';
  note.textContent = '';

  const data = await getDailyLeaderboard(date, DAILY_BOARD_LIMIT);
  if (!data) {
    board.innerHTML = '<p class="daily-board-empty">The leaderboard couldn\'t be loaded right now.</p>';
    return;
  }

  const rows    = Array.isArray(data.rows) ? data.rows : [];
  const you     = data.you && typeof data.you === 'object' ? data.you : null;
  const players = dailyNumber(data.players) ?? rows.length;

  note.textContent = players === 1 ? '1 player today' : `${players} players today`;

  if (!rows.length) {
    board.innerHTML = `
      <p class="daily-board-empty">
        Nobody has finished today's puzzle yet. Be first.
      </p>
    `;
    return;
  }

  const isYou = row => !!(you
    && dailyNumber(row.rank) !== null
    && dailyNumber(row.rank) === dailyNumber(you.rank)
    && String(row.username ?? '') === String(you.username ?? ''));

  const bodyRows = rows.map(r => dailyBoardRow(r, isYou(r))).join('');

  // The caller always gets a row, even at rank 4,000 — a list that stops at
  // 100 tells someone in four figures nothing at all, and their own line in
  // context tells them what to beat.
  const youInTop = rows.some(isYou);
  const youRow   = (you && !youInTop)
    ? `<tbody class="daily-board-you-block"><tr class="daily-board-gap"><td colspan="4">…</td></tr>${dailyBoardRow(you, true)}</tbody>`
    : '';

  board.innerHTML = `
    <table class="daily-board-table">
      <thead>
        <tr><th class="col-rank">#</th><th>Player</th><th class="col-num">Score</th><th class="col-num">Accuracy</th></tr>
      </thead>
      <tbody>${bodyRows}</tbody>
      ${youRow}
    </table>
  `;
}

// Usernames are user-controlled and land in innerHTML — escapeHtml, always.
function dailyBoardRow(r, mine) {
  const rank = dailyNumber(r.rank);
  const acc  = dailyAccuracyPercent(r.accuracy);
  const sc   = dailyNumber(r.score);
  return `
    <tr class="${mine ? 'is-you' : ''}">
      <td class="col-rank">${escapeHtml(rank === null ? '—' : rank)}</td>
      <td class="col-name">${escapeHtml(String(r.username ?? '—'))}${mine ? '<span class="daily-you-tag">you</span>' : ''}</td>
      <td class="col-num">${escapeHtml(sc === null ? '—' : sc)}</td>
      <td class="col-num">${escapeHtml(acc === null ? '—' : acc + '%')}</td>
    </tr>
  `;
}

// ── Reset countdown ───────────────────────────────────────────

function renderDailyReset(status) {
  const el = document.getElementById('daily-reset');
  if (!el) return;

  const seconds = dailyNumber(status && status.seconds_until_reset);
  if (seconds === null || seconds < 0) { el.style.display = 'none'; return; }

  // Anchored to a deadline for the same reason the game clock is: a countdown
  // that counts ticks drifts badly in a backgrounded tab.
  const deadline = performance.now() + seconds * 1000;
  el.style.display = 'block';

  const tick = () => {
    const left = Math.max(0, Math.round((deadline - performance.now()) / 1000));
    if (left <= 0) {
      el.textContent = 'A new puzzle is available — reload to play it.';
      if (dailyResetTimer) { clearInterval(dailyResetTimer); dailyResetTimer = null; }
      return;
    }
    el.textContent = `Next puzzle in ${dailyDuration(left)} — the daily resets at midnight UTC.`;
  };

  tick();
  if (dailyResetTimer) clearInterval(dailyResetTimer);
  dailyResetTimer = setInterval(tick, 1000);
}

function dailyDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// ── Shell helpers ─────────────────────────────────────────────

function renderDailyMeta(payload) {
  const el = document.getElementById('daily-meta');
  if (!el) return;
  const number = dailyNumber(payload && payload.puzzle_number);
  const date   = String((payload && payload.puzzle_date) || '');
  const bits   = [];
  if (number !== null) bits.push('Puzzle #' + number);
  if (date) bits.push(date);
  // textContent: the date comes back from the database as a string.
  el.textContent = bits.join(' · ');
}

function dailyShow(id, display = 'block') {
  const el = document.getElementById(id);
  if (el) el.style.display = display;
}

function dailyHide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function dailyNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The contract gives accuracy as a fraction (0.956); tolerate a percentage in
// case the server ever hands one over, and round to a whole percent because
// that is what the share string carries.
function dailyAccuracyPercent(v) {
  const n = dailyNumber(v);
  if (n === null) return null;
  const frac = n > 1 ? n / 100 : n;
  return Math.round(frac * 100);
}
