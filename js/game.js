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
    // Generate a multiplication pair, then present one of the reverse divisions
    const a       = randInt(config.mulMin1, config.mulMax1);
    const b       = randInt(config.mulMin2, config.mulMax2);
    const product = a * b;
    if (Math.random() < 0.5) { display = `${product} \u00f7 ${a}`; answer = b; }
    else                      { display = `${product} \u00f7 ${b}`; answer = a; }
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
  const sessionData = {
    sessionKey,
    configKey,
    score,
    durationSeconds: config.duration,
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
    const allowed = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home', 'End'];
    if (!allowed.includes(e.key) && !/^\d$/.test(e.key)) {
      e.preventDefault();
    }
  });

  input.addEventListener('input', () => {
    // Strip any non-digit characters that snuck in (paste, IME, etc.)
    const clean = input.value.replace(/\D/g, '');
    if (clean !== input.value) { input.value = clean; return; }

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

  timerInterval = setInterval(() => {
    timeLeft--;
    document.getElementById('timer-display').textContent = 'Seconds left: ' + timeLeft;
    if (timeLeft <= 0) endGame();
  }, 1000);
}

document.addEventListener('DOMContentLoaded', initGame);
