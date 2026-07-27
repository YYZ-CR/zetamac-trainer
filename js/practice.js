// ── State ─────────────────────────────────────────────────────
// currentUser is declared by auth.js (global)
let categoryStats = {};     // "operation|category" → { operation, category, count, totalMs, mistakes }
let selectedKeys  = new Set();
let practiceRecs  = [];     // question records completed this session
let currentQ      = null;   // { display, answer, operation, category }
let qStartTime    = null;
let hadMistake    = false;
let mistakeVals   = [];
let streak        = 0;
let answered      = 0;
let sessionMs     = 0;
let feedbackTimer = null;   // pending nextQuestion() during the feedback pause

// ── Helpers ───────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Classification ────────────────────────────────────────────

function classifyMul(a, b) {
  if (a === b) return 'Squares';
  const lo = Math.min(a, b);
  if (lo >= 2 && lo <= 12) return `\u00d7${lo} tables`;
  return 'Large \u00d7 Large';
}

function classifyDiv(divisor, quotient) {
  if (divisor >= 2 && divisor <= 12) return `\u00f7${divisor}`;
  if (quotient >= 2 && quotient <= 12) return `\u00f7 large (\u00d7${quotient} factor)`;
  return 'Large \u00f7 Large';
}

function classifyAdd(a, b) {
  if (a === b) return 'Doubles';
  if (a >= 100 || b >= 100) return 'Triple-digit';
  if (a < 10 && b < 10) return 'Single + Single';
  if ((a < 10) !== (b < 10)) return 'Double + Single';
  // Both >= 10 from here
  if (Math.abs(a - b) <= 2) return 'Near-Doubles';
  const carry = ((a % 10) + (b % 10)) >= 10;
  return carry ? 'Double + Double, carry' : 'Double + Double, no carry';
}

function classifySub(minuend, subtrahend, answer) {
  if (answer <= 15) return 'Close Numbers';
  if (minuend >= 100) return 'Triple-digit';
  if (subtrahend % 10 <= 2 || subtrahend % 10 >= 8) return 'Round Subtrahend';
  const borrow = (minuend % 10) < (subtrahend % 10);
  return borrow ? 'Two-digit, borrow' : 'Two-digit, no borrow';
}

function classifyQuestion(q) {
  try {
    if (q.operation === 'multiplication') {
      const [a, b] = parseTwo(q.display, '\u00d7');
      return classifyMul(a, b);
    }
    if (q.operation === 'division') {
      const [, divisor] = parseTwo(q.display, '\u00f7');
      return classifyDiv(divisor, q.answer);
    }
    if (q.operation === 'addition') {
      const [a, b] = parseTwo(q.display, '+');
      return classifyAdd(a, b);
    }
    if (q.operation === 'subtraction') {
      const [minuend, subtrahend] = parseTwo(q.display, '\u2212');
      return classifySub(minuend, subtrahend, q.answer);
    }
  } catch (_) {}
  return 'Other';
}

// ── Generator ─────────────────────────────────────────────────

function generateForCategory(operation, category) {
  if (operation === 'multiplication') {
    if (category === 'Squares') {
      const a = randInt(2, 15);
      return { display: `${a} \u00d7 ${a}`, answer: a * a, operation, category };
    }
    if (category.startsWith('\u00d7') && category.endsWith('tables')) {
      const factor = parseInt(category.slice(1));
      // other must be > factor so classifyMul sees lo=factor (not lo=other)
      // also avoids Squares overlap when other === factor
      const other  = randInt(factor + 1, 100);
      const [a, b] = Math.random() < 0.5 ? [factor, other] : [other, factor];
      return { display: `${a} \u00d7 ${b}`, answer: factor * other, operation, category };
    }
    // Large × Large
    const la = randInt(13, 50), lb = randInt(13, 50);
    return { display: `${la} \u00d7 ${lb}`, answer: la * lb, operation, category };
  }

  if (operation === 'division') {
    if (category.startsWith('\u00f7') && !category.includes('large')) {
      const divisor  = parseInt(category.slice(1));
      const quotient = randInt(2, 12);
      return { display: `${divisor * quotient} \u00f7 ${divisor}`, answer: quotient, operation, category };
    }
    if (category.includes('large')) {
      const m      = category.match(/\u00d7(\d+)/);
      const factor  = m ? parseInt(m[1]) : randInt(2, 12);
      const divisor = randInt(13, 99);
      return { display: `${divisor * factor} \u00f7 ${divisor}`, answer: factor, operation, category };
    }
    // Large ÷ Large
    const da = randInt(13, 50), db = randInt(13, 50);
    return { display: `${da * db} \u00f7 ${da}`, answer: db, operation, category };
  }

  if (operation === 'addition') {
    const [a, b] = genAddPair(category);
    return { display: `${a} + ${b}`, answer: a + b, operation, category };
  }

  if (operation === 'subtraction') {
    const [sum, sub, ans] = genSubPair(category);
    return { display: `${sum} \u2212 ${sub}`, answer: ans, operation, category };
  }

  // Fallback
  const a = randInt(2, 50), b = randInt(2, 50);
  return { display: `${a} + ${b}`, answer: a + b, operation: 'addition', category };
}

function genAddPair(category) {
  for (let i = 0; i < 200; i++) {
    let a, b;
    switch (category) {
      case 'Doubles':
        a = randInt(2, 60); b = a; break;
      case 'Near-Doubles':
        a = randInt(2, 60); b = a + (Math.random() < 0.5 ? 1 : -1) * randInt(1, 2);
        if (b < 2) b = a + 1; break;
      case 'Single + Single':
        a = randInt(2, 9); b = randInt(2, 9); break;
      case 'Double + Single':
        a = randInt(10, 99); b = randInt(2, 9);
        if (Math.random() < 0.5) { const t = a; a = b; b = t; } break;
      case 'Double + Double, no carry':
        a = randInt(10, 89); b = randInt(10, 89); break;
      case 'Double + Double, carry':
        a = randInt(10, 89); b = randInt(10, 89); break;
      case 'Triple-digit':
        a = randInt(100, 200); b = randInt(2, 99);
        if (Math.random() < 0.5) { const t = a; a = b; b = t; } break;
      default:
        a = randInt(2, 100); b = randInt(2, 100); break;
    }
    if (classifyAdd(a, b) === category) return [a, b];
  }
  return [randInt(2, 50), randInt(2, 50)];
}

function genSubPair(category) {
  for (let i = 0; i < 200; i++) {
    let sub, sum;
    switch (category) {
      case 'Close Numbers':
        sub = randInt(10, 90); sum = sub + randInt(2, 15); break;
      case 'Round Subtrahend': {
        const base = randInt(1, 9) * 10;
        sub = base + (Math.random() < 0.5 ? -randInt(1, 2) : randInt(1, 2));
        if (sub < 3) sub = base + 1;
        sum = sub + randInt(10, 80); break;
      }
      case 'Triple-digit':
        sub = randInt(10, 99); sum = sub + randInt(100, 200); break;
      default:
        sub = randInt(11, 89); sum = sub + randInt(10, 80); break;
    }
    const ans = sum - sub;
    if (ans > 0 && classifySub(sum, sub, ans) === category) return [sum, sub, ans];
  }
  return [60, 25, 35];
}

// ── History loading ───────────────────────────────────────────

async function loadHistory() {
  const seenSessions = new Set();
  const allQ = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('session_')) continue;
    const sessionKey = key.slice('session_'.length);
    if (seenSessions.has(sessionKey)) continue;
    seenSessions.add(sessionKey);
    try {
      const sess = JSON.parse(localStorage.getItem(key));
      if (Array.isArray(sess?.questions)) allQ.push(...sess.questions);
    } catch (_) {}
  }

  if (currentUser) {
    try {
      const rows = await getUserSessions(currentUser.id, 50);
      for (const row of rows) {
        if (seenSessions.has(row.session_key)) continue;
        seenSessions.add(row.session_key);
        if (Array.isArray(row.questions)) allQ.push(...row.questions);
      }
    } catch (_) {}
  }

  // Past practice counts too. Without this, drilling a weak category could
  // never move its numbers — "vs History" would compare against the same
  // pre-practice snapshot forever.
  for (const rec of loadPracticeHistory()) allQ.push(...rec.questions);

  const stats = {};
  for (const q of allQ) {
    if (!q.operation || typeof q.timeMs !== 'number') continue;
    const cat = classifyQuestion(q);
    const k = `${q.operation}|${cat}`;
    if (!stats[k]) stats[k] = { operation: q.operation, category: cat, count: 0, totalMs: 0, mistakes: 0 };
    stats[k].count++;
    stats[k].totalMs += q.timeMs;
    if (q.hadMistake) stats[k].mistakes++;
  }
  return stats;
}

// ── Practice history ──────────────────────────────────────────
// Practice runs are stored separately from `session_*` so they never leak
// into the dashboard, the score chart, or personal bests — those describe
// timed games. They exist only to keep the weakness stats honest.

const PRACTICE_PREFIX = 'practice_';
const PRACTICE_KEEP   = 40;   // most recent runs retained

function loadPracticeHistory() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PRACTICE_PREFIX)) continue;
    try {
      const rec = JSON.parse(localStorage.getItem(key));
      if (Array.isArray(rec?.questions)) out.push({ key, at: rec.at || 0, questions: rec.questions });
    } catch (_) {}
  }
  return out.sort((a, b) => a.at - b.at);
}

function savePracticeSession(recs) {
  if (!recs.length) return;
  // Keep only the fields the stats need — no need to mirror the game schema.
  const questions = recs.map(r => ({
    display:   r.display,
    operation: r.operation,
    answer:    r.answer,
    timeMs:    r.timeMs,
    hadMistake: r.hadMistake,
    mistakeValues: r.mistakeValues || [],
  }));
  try {
    localStorage.setItem(PRACTICE_PREFIX + randomKey(), JSON.stringify({
      at: Date.now(),
      questions,
    }));
  } catch (_) {
    return;  // quota full — the run is still shown, just not remembered
  }

  // Prune oldest so this can't grow without bound.
  const all = loadPracticeHistory();
  for (let i = 0; i < all.length - PRACTICE_KEEP; i++) {
    try { localStorage.removeItem(all[i].key); } catch (_) {}
  }
}

// ── Adaptive selection ────────────────────────────────────────
// The draw used to be uniform over whatever the user ticked, which meant the
// weakness analysis in the picker had no effect on what you actually got
// asked. Categories are now sampled in proportion to how much trouble they
// give you, blending lifetime history with how the current run is going.

function categoryWeight(key, liveStats) {
  const hist = categoryStats[key];
  const live = liveStats[key];

  // Combine history with this session so the mix adapts as you go.
  const count   = (hist?.count || 0) + (live?.count || 0);
  const totalMs = (hist?.totalMs || 0) + (live?.totalMs || 0);
  const misses  = (hist?.mistakes || 0) + (live?.mistakes || 0);
  if (!count) return 1;   // never seen — average priority

  const avgSec      = totalMs / count / 1000;
  const mistakeRate = misses / count;

  // Slow relative to a comfortable ~2s answer, bounded so one pathological
  // category can't crowd everything else out of the rotation.
  const speed = Math.min(3, Math.max(0.4, avgSec / 2));
  // Errors matter more than raw speed; a 50% miss rate doubles the weight.
  return speed * (1 + 2 * mistakeRate);
}

function pickWeightedKey(keys, liveStats) {
  const weights = keys.map(k => categoryWeight(k, liveStats));
  const total   = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return keys[Math.floor(Math.random() * keys.length)];
  let r = Math.random() * total;
  for (let i = 0; i < keys.length; i++) {
    r -= weights[i];
    if (r <= 0) return keys[i];
  }
  return keys[keys.length - 1];
}

// Fold a finished run into an existing stats map, returning a new map.
function mergeIntoStats(stats, recs) {
  const out = {};
  for (const [k, v] of Object.entries(stats)) out[k] = { ...v };
  for (const r of recs) {
    const k = `${r.operation}|${r.category}`;
    if (!out[k]) out[k] = { operation: r.operation, category: r.category, count: 0, totalMs: 0, mistakes: 0 };
    out[k].count++;
    out[k].totalMs += r.timeMs;
    if (r.hadMistake) out[k].mistakes++;
  }
  return out;
}

// Per-category tallies for the run in progress, used by categoryWeight.
function liveStatsFromRecs(recs) {
  const st = {};
  for (const r of recs) {
    const k = `${r.operation}|${r.category}`;
    if (!st[k]) st[k] = { count: 0, totalMs: 0, mistakes: 0 };
    st[k].count++;
    st[k].totalMs += r.timeMs;
    if (r.hadMistake) st[k].mistakes++;
  }
  return st;
}

// ── Picker view ───────────────────────────────────────────────

function renderPicker() {
  document.getElementById('view-picker').style.display = '';
  document.getElementById('view-session').style.display = 'none';
  document.getElementById('view-summary').style.display = 'none';

  // 'Other' is the catch-all for questions we could not classify. There is no
  // generator that can produce it, so drilling it burns the full rejection
  // budget and then serves the same hard-coded fallback problem every time.
  const entries = Object.values(categoryStats)
    .filter(e => e.category !== 'Other')
    .sort((a, b) => {
      const avgA = a.count > 0 ? a.totalMs / a.count : 0;
      const avgB = b.count > 0 ? b.totalMs / b.count : 0;
      return avgB - avgA;
    });

  const container = document.getElementById('picker-content');

  if (entries.length === 0) {
    container.innerHTML = `
      <p class="practice-hint">No game history found yet. Play a few games and come back, or dive right in:</p>
      <button class="btn btn-primary" id="practice-all-btn">Practice Common Types</button>
    `;
    document.getElementById('practice-all-btn').addEventListener('click', startPracticeAll);
    document.getElementById('start-practice-btn').style.display = 'none';
    return;
  }

  document.getElementById('start-practice-btn').style.display = '';
  const OP_LABELS = {
    multiplication: 'Multiplication',
    division: 'Division',
    addition: 'Addition',
    subtraction: 'Subtraction',
  };

  // Relative sampling weight, shown as 1-4 dots so the adaptive draw is
  // visible rather than a hidden behaviour.
  const weights = entries.map(e => categoryWeight(`${e.operation}|${e.category}`, {}));
  const maxW    = Math.max(...weights, 1);
  const focusDots = k => {
    const w = categoryWeight(k, {});
    return Math.max(1, Math.min(4, Math.round(w / maxW * 4)));
  };

  container.innerHTML = `
    <p class="practice-hint">Sorted by average time (slowest first). Select types to drill, then click Start.
    Within your selection, slower and more error-prone types come up more often &mdash; the
    <em>Focus</em> column shows how much.</p>
    <div class="picker-controls">
      <button class="link-btn" id="select-all-btn">Select all</button>
      <span class="sep">\u00b7</span>
      <button class="link-btn" id="deselect-all-btn">Deselect all</button>
      <span class="sep">\u00b7</span>
      <button class="link-btn" id="select-slow-btn">Select slowest 5</button>
    </div>
    <table class="picker-table">
      <thead>
        <tr>
          <th></th>
          <th>Operation</th>
          <th>Type</th>
          <th>Seen</th>
          <th>Avg Time</th>
          <th>Mistake Rate</th>
          <th>Focus</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map((e, idx) => {
          const k = `${e.operation}|${e.category}`;
          const avgMs = e.count > 0 ? e.totalMs / e.count : 0;
          const mistakePct = e.count > 0 ? Math.round(e.mistakes / e.count * 100) : 0;
          return `<tr>
            <td><input type="checkbox" class="cat-checkbox" data-key="${k}" data-idx="${idx}"></td>
            <td>${escapeHtml(OP_LABELS[e.operation] || e.operation)}</td>
            <td>${escapeHtml(e.category)}</td>
            <td>${e.count}</td>
            <td class="time-cell">${(avgMs / 1000).toFixed(2)}s</td>
            <td>${mistakePct}%</td>
            <td class="focus-cell">${'\u25cf'.repeat(focusDots(k))}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  container.querySelectorAll('.cat-checkbox').forEach(cb => {
    if (selectedKeys.has(cb.dataset.key)) cb.checked = true;
    cb.addEventListener('change', () => {
      cb.checked ? selectedKeys.add(cb.dataset.key) : selectedKeys.delete(cb.dataset.key);
      updateStartBtn();
    });
  });

  document.getElementById('select-all-btn').addEventListener('click', () => {
    container.querySelectorAll('.cat-checkbox').forEach(cb => {
      cb.checked = true; selectedKeys.add(cb.dataset.key);
    });
    updateStartBtn();
  });

  document.getElementById('deselect-all-btn').addEventListener('click', () => {
    container.querySelectorAll('.cat-checkbox').forEach(cb => {
      cb.checked = false; selectedKeys.delete(cb.dataset.key);
    });
    updateStartBtn();
  });

  document.getElementById('select-slow-btn').addEventListener('click', () => {
    container.querySelectorAll('.cat-checkbox').forEach(cb => {
      const idx = parseInt(cb.dataset.idx);
      if (idx < 5) { cb.checked = true; selectedKeys.add(cb.dataset.key); }
    });
    updateStartBtn();
  });

  updateStartBtn();
}

function updateStartBtn() {
  const btn = document.getElementById('start-practice-btn');
  if (btn) btn.disabled = selectedKeys.size === 0;
}

function startPracticeAll() {
  const defaults = [
    ['multiplication', '\u00d72 tables'],
    ['multiplication', '\u00d73 tables'],
    ['multiplication', '\u00d74 tables'],
    ['multiplication', '\u00d75 tables'],
    ['multiplication', '\u00d76 tables'],
    ['multiplication', '\u00d77 tables'],
    ['multiplication', '\u00d78 tables'],
    ['multiplication', '\u00d79 tables'],
    ['multiplication', '\u00d710 tables'],
    ['multiplication', '\u00d711 tables'],
    ['multiplication', '\u00d712 tables'],
    ['division', '\u00f72'], ['division', '\u00f73'], ['division', '\u00f74'],
    ['division', '\u00f75'], ['division', '\u00f76'], ['division', '\u00f77'],
    ['division', '\u00f78'], ['division', '\u00f79'],
    ['addition', 'Double + Double, carry'], ['addition', 'Double + Single'],
    ['subtraction', 'Two-digit, borrow'], ['subtraction', 'Two-digit, no borrow'],
  ];
  defaults.forEach(([op, cat]) => selectedKeys.add(`${op}|${cat}`));
  startPractice();
}

// ── Session view ──────────────────────────────────────────────

function startPractice() {
  practiceRecs = [];
  streak   = 0;
  answered = 0;
  sessionMs = 0;

  document.getElementById('view-picker').style.display  = 'none';
  document.getElementById('view-session').style.display = '';
  document.getElementById('view-summary').style.display = 'none';

  updateSessionHUD();
  nextQuestion();
}

function updateSessionHUD() {
  document.getElementById('session-answered').textContent = answered;
  document.getElementById('session-streak').textContent   = streak;
  const avg = answered > 0 ? (sessionMs / answered / 1000).toFixed(2) + 's' : '\u2014';
  document.getElementById('session-avg').textContent = avg;
}

function nextQuestion() {
  const keys = [...selectedKeys];
  if (!keys.length) { showSummary(); return; }
  const key = pickWeightedKey(keys, liveStatsFromRecs(practiceRecs));
  const [operation, category] = key.split('|');

  currentQ    = generateForCategory(operation, category);
  hadMistake  = false;
  mistakeVals = [];
  qStartTime  = performance.now();

  document.getElementById('session-question').textContent = currentQ.display + ' =';

  const input = document.getElementById('session-input');
  input.value    = '';
  input.disabled = false;
  input.focus();

  document.getElementById('session-feedback').className = 'session-feedback hidden';
}

function commitAnswer() {
  const elapsed = Math.round(performance.now() - qStartTime);
  sessionMs += elapsed;
  answered++;
  streak = hadMistake ? 0 : streak + 1;

  practiceRecs.push({
    display:       currentQ.display,
    operation:     currentQ.operation,
    category:      currentQ.category,
    answer:        currentQ.answer,
    timeMs:        elapsed,
    hadMistake,
    mistakeValues: [...mistakeVals],
  });

  const tip = getTip({ ...currentQ, timeMs: elapsed, hadMistake, mistakeValues: mistakeVals });

  const fb = document.getElementById('session-feedback');
  fb.innerHTML = `
    <span class="fb-result ${hadMistake ? 'fb-mistake' : 'fb-correct'}">${hadMistake ? '\u2717' : '\u2713'} ${(elapsed / 1000).toFixed(2)}s</span>
    ${tip ? `<span class="fb-tip">${escapeHtml(tip)}</span>` : ''}
  `;
  fb.className = 'session-feedback visible';

  document.getElementById('session-input').disabled = true;
  updateSessionHUD();

  feedbackTimer = setTimeout(nextQuestion, tip ? 2000 : 900);
}

// ── Summary view ──────────────────────────────────────────────

function showSummary() {
  // Finishing during the feedback pause used to leave the scheduled
  // nextQuestion() running: it would fire seconds later, re-enable the hidden
  // input, advance the unseen question and steal focus from the summary.
  if (feedbackTimer !== null) { clearTimeout(feedbackTimer); feedbackTimer = null; }
  currentQ = null;

  document.getElementById('view-picker').style.display  = 'none';
  document.getElementById('view-session').style.display = 'none';
  document.getElementById('view-summary').style.display = '';

  const container = document.getElementById('summary-content');
  if (practiceRecs.length === 0) {
    container.innerHTML = '<p class="no-data">No questions answered this session.</p>';
    return;
  }

  // Snapshot the pre-run stats for the "vs History" column, then fold this run
  // into the record so the next visit compares against it.
  const priorStats = categoryStats;
  savePracticeSession(practiceRecs);
  categoryStats = mergeIntoStats(priorStats, practiceRecs);

  const byKey = {};
  for (const r of practiceRecs) {
    const k = `${r.operation}|${r.category}`;
    if (!byKey[k]) byKey[k] = { operation: r.operation, category: r.category, count: 0, totalMs: 0, mistakes: 0 };
    byKey[k].count++;
    byKey[k].totalMs += r.timeMs;
    if (r.hadMistake) byKey[k].mistakes++;
  }

  const rows = Object.values(byKey).sort((a, b) => (b.totalMs / b.count) - (a.totalMs / a.count));
  const OP_LABELS = {
    multiplication: 'Multiplication', division: 'Division',
    addition: 'Addition', subtraction: 'Subtraction',
  };

  const overallAvg      = sessionMs / practiceRecs.length;
  const totalMistakes   = practiceRecs.filter(r => r.hadMistake).length;
  const accuracyPct     = Math.round((practiceRecs.length - totalMistakes) / practiceRecs.length * 100);

  container.innerHTML = `
    <div class="summary-cards">
      <div class="summary-card">
        <div class="card-value">${practiceRecs.length}</div>
        <div class="card-label">Answered</div>
      </div>
      <div class="summary-card">
        <div class="card-value">${(overallAvg / 1000).toFixed(2)}s</div>
        <div class="card-label">Avg Time</div>
      </div>
      <div class="summary-card">
        <div class="card-value">${accuracyPct}%</div>
        <div class="card-label">Accuracy</div>
      </div>
    </div>

    <h3 class="summary-by-cat">By Category</h3>
    <table class="picker-table">
      <thead>
        <tr>
          <th>Operation</th>
          <th>Type</th>
          <th>Answered</th>
          <th>Avg Time</th>
          <th>vs History</th>
          <th>Accuracy</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const avgMs  = r.totalMs / r.count;
          // Compare against the stats as they stood BEFORE this run, otherwise
          // the run dilutes the baseline it is being measured against.
          const histSt = priorStats[`${r.operation}|${r.category}`];
          let vsHist = '<span class="vs-same">\u2014</span>';
          if (histSt && histSt.count >= 3) {
            const histAvg = histSt.totalMs / histSt.count;
            const diff    = avgMs - histAvg;
            const pct     = Math.abs(Math.round(diff / histAvg * 100));
            if (diff < -50)      vsHist = `<span class="vs-better">\u2193 ${pct}% faster</span>`;
            else if (diff > 50)  vsHist = `<span class="vs-worse">\u2191 ${pct}% slower</span>`;
          }
          const acc = Math.round((r.count - r.mistakes) / r.count * 100);
          return `<tr>
            <td>${escapeHtml(OP_LABELS[r.operation] || r.operation)}</td>
            <td>${escapeHtml(r.category)}</td>
            <td>${r.count}</td>
            <td class="time-cell">${(avgMs / 1000).toFixed(2)}s</td>
            <td>${vsHist}</td>
            <td>${acc}%</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}


// ── Init ──────────────────────────────────────────────────────

async function initPractice() {
  createAuthModal();

  try {
    currentUser = await initAuth({
      onAuthChange: (u) => {
        renderAuthBar(u, document.getElementById('top-bar'));
      },
    });
  } catch (_) {}
  renderAuthBar(currentUser, document.getElementById('top-bar'));

  // Load history then render picker
  document.getElementById('picker-loading').style.display = '';
  categoryStats = await loadHistory();
  document.getElementById('picker-loading').style.display = 'none';
  renderPicker();

  // Session input handling (set up once; input is disabled between questions)
  const input = document.getElementById('session-input');

  input.addEventListener('keydown', e => {
    const allowed = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home', 'End'];
    if (!allowed.includes(e.key) && !/^\d$/.test(e.key)) e.preventDefault();
  });

  input.addEventListener('input', () => {
    if (!currentQ) return;
    const clean = input.value.replace(/\D/g, '');
    if (clean !== input.value) { input.value = clean; return; }

    const val    = clean;
    const ansStr = String(currentQ.answer);
    if (!val) return;

    if (!ansStr.startsWith(val)) {
      hadMistake = true;
      if (!mistakeVals.includes(val)) mistakeVals.push(val);
    }

    if (val === ansStr) commitAnswer();
  });

  document.getElementById('start-practice-btn').addEventListener('click', () => {
    if (selectedKeys.size > 0) startPractice();
  });

  document.getElementById('finish-btn').addEventListener('click', showSummary);

  document.getElementById('practice-again-btn').addEventListener('click', startPractice);

  document.getElementById('back-to-picker-btn').addEventListener('click', renderPicker);
}

document.addEventListener('DOMContentLoaded', initPractice);
