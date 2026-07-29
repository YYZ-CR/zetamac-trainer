// ── State ─────────────────────────────────────────────────────
let config      = null;
let configKey   = null;
let questions   = [];   // completed question records
let currentQ    = null; // { op, display, answer }
let qStartTime  = null;
let hadMistake  = false;
let mistakeVals = [];
let score       = 0;
let timeLeft    = 0;
let timerInterval = null;
let gameStartTime = null;

// ── Math ──────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateQuestion() {
  const ops = config.operations;
  const op  = ops[Math.floor(Math.random() * ops.length)];
  let display, answer;

  if (op === 'addition') {
    const a = randInt(config.addMin1, config.addMax1);
    const b = randInt(config.addMin2, config.addMax2);
    display = `${a} + ${b}`;
    answer  = a + b;

  } else if (op === 'subtraction') {
    // Generate an addition pair, then present one of the reverse subtractions
    const a   = randInt(config.addMin1, config.addMax1);
    const b   = randInt(config.addMin2, config.addMax2);
    const sum = a + b;
    if (Math.random() < 0.5) { display = `${sum} \u2212 ${a}`; answer = b; }
    else                      { display = `${sum} \u2212 ${b}`; answer = a; }

  } else if (op === 'multiplication') {
    const a = randInt(config.mulMin1, config.mulMax1);
    const b = randInt(config.mulMin2, config.mulMax2);
    display = `${a} \u00d7 ${b}`;
    answer  = a * b;

  } else { // division
    // Generate a multiplication pair, then present it as a division.
    //
    // The divisor is ALWAYS the first-range operand, never the second.
    // Zetamac does the same, and the difference is not cosmetic: under
    // the default 2\u201312 \u00d7 2\u2013100 it is the difference between dividing by
    // a times-table number and dividing by an arbitrary two-digit one.
    // Flipping produced questions like "876 \u00f7 73", which the real game
    // never asks and which are a different skill entirely.
    const a       = randInt(config.mulMin1, config.mulMax1);
    const b       = randInt(config.mulMin2, config.mulMax2);
    const product = a * b;
    display = `${product} \u00f7 ${a}`;
    answer  = b;
  }

  return { op, display, answer };
}

// ── Question flow ─────────────────────────────────────────────

function showQuestion(q) {
  currentQ    = q;
  hadMistake  = false;
  mistakeVals = [];
  qStartTime  = performance.now();

  document.getElementById('question-text').textContent = q.display + ' =';
  const input = document.getElementById('answer-input');
  input.value = '';
  input.focus();
}

function commitQuestion() {
  const timeMs = Math.round(performance.now() - qStartTime);
  questions.push({
    display:       currentQ.display,
    operation:     currentQ.op,
    answer:        currentQ.answer,
    timeMs,
    hadMistake,
    mistakeValues: [...mistakeVals],
  });
  score++;
  document.getElementById('score-display').textContent = 'Score: ' + score;
  showQuestion(generateQuestion());
}

// ── End game ──────────────────────────────────────────────────

function endGame() {
  clearInterval(timerInterval);
  document.getElementById('answer-input').disabled = true;

  const sessionKey  = randomKey();
  // Time actually spent playing, and the time sunk into the question that was
  // still on screen when the clock ran out. Without these the results timeline
  // ends short of the duration, which made the projected-score line terminate
  // above the real score.
  const elapsedMs   = gameStartTime != null ? Math.round(performance.now() - gameStartTime) : null;
  const unfinishedMs = qStartTime != null ? Math.round(performance.now() - qStartTime) : 0;
  const sessionData = {
    sessionKey,
    configKey,
    score,
    durationSeconds: config.duration,
    elapsedMs,
    unfinishedMs,
    questions,
  };

  // Always persist to localStorage (works for anonymous users too)
  localStorage.setItem('session_' + sessionKey, JSON.stringify(sessionData));

  // Track session key so we can claim it after login
  const pending = JSON.parse(localStorage.getItem('pending_sessions') || '[]');
  pending.push({ sessionKey });
  localStorage.setItem('pending_sessions', JSON.stringify(pending));

  // Best-effort async save to Supabase (don't block the redirect)
  saveSession(sessionData).catch(console.error);

  // Fallback for servers that strip query params
  localStorage.setItem('zt_last_session', sessionKey);

  // Show score overlay, then redirect
  const overlay = document.createElement('div');
  overlay.className = 'gameover-overlay';
  overlay.innerHTML = `
    <h2>Time's up!</h2>
    <div class="gameover-score">${score}</div>
    <div class="gameover-label">Redirecting to results…</div>
  `;
  document.body.appendChild(overlay);

  setTimeout(() => {
    window.location.href = 'results.html?session=' + sessionKey;
  }, 1800);
}

// ── Init ──────────────────────────────────────────────────────

async function initGame() {
  const params = new URLSearchParams(window.location.search);
  configKey = params.get('key');

  // Fallback: if query param was stripped by the dev server, read from localStorage
  if (!configKey) {
    const pending = JSON.parse(localStorage.getItem('zt_pending_game') || 'null');
    if (pending) {
      configKey = pending.key;
      config    = pending.config;
      localStorage.removeItem('zt_pending_game');
    } else {
      window.location.href = 'index.html';
      return;
    }
  }

  if (!config) {
    // Try localStorage keyed by configKey, then Supabase
    localStorage.removeItem('zt_pending_game');
    const cached = localStorage.getItem('config_' + configKey);
    if (cached) {
      config = JSON.parse(cached);
    } else {
      try {
        config = await getConfig(configKey);
      } catch (e) {
        console.error('getConfig failed:', e);
        config = null;
      }
    }
  }

  if (!config) {
    document.getElementById('game-loading').textContent = 'Game not found.';
    setTimeout(() => window.location.href = 'index.html', 2000);
    return;
  }

  timeLeft = config.duration;
  document.getElementById('timer-display').textContent = 'Seconds left: ' + timeLeft;
  document.getElementById('game-loading').style.display = 'none';
  document.getElementById('game-area').style.display    = 'flex';

  // ── Input handling ────────────────────────────────────────
  const input = document.getElementById('answer-input');

  // Block non-numeric keys at the keyboard level
  input.addEventListener('keydown', e => {
    // Enter is muscle memory for anyone coming from Zetamac. There is nothing
    // to submit (correct answers auto-advance), so treat it as "clear and
    // retry" rather than silently swallowing the keypress.
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
    // Strip any non-digit characters that snuck in (paste, IME, etc.).
    // Assigning input.value does not re-fire this handler, so we must fall
    // through to the checks below rather than returning — otherwise pasting
    // "42x" for answer 42 leaves the correct answer sitting in the box
    // unaccepted and the game stalls until the next keystroke.
    const clean = input.value.replace(/\D/g, '');
    if (clean !== input.value) input.value = clean;

    const val    = clean;
    const ansStr = String(currentQ.answer);

    if (!val) return;

    // A mistake is any non-empty input that is not a valid prefix of the answer.
    // The user must eventually backspace and retype to get it right.
    if (!ansStr.startsWith(val)) {
      hadMistake = true;
      if (!mistakeVals.includes(val)) mistakeVals.push(val);
    }

    // Auto-advance the moment the full correct answer is typed
    if (val === ansStr) commitQuestion();
  });

  // ── Timer ────────────────────────────────────────────────
  showQuestion(generateQuestion());

  // Anchor the clock to a wall-clock deadline rather than counting interval
  // ticks. Browsers throttle setInterval in background tabs, so a tick-counted
  // timer hands out extra playing time whenever the tab loses focus.
  gameStartTime = performance.now();
  const deadline = gameStartTime + config.duration * 1000;

  timerInterval = setInterval(() => {
    timeLeft = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    document.getElementById('timer-display').textContent = 'Seconds left: ' + timeLeft;
    if (timeLeft <= 0) endGame();
  }, 250);
}

document.addEventListener('DOMContentLoaded', initGame);
