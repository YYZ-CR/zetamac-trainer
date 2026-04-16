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

// ── Helpers ───────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseTwo(display, sep) {
  const parts = display.split(sep);
  return [parseInt(parts[0].trim(), 10), parseInt(parts[1].trim(), 10)];
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

// ── Picker view ───────────────────────────────────────────────

function renderPicker() {
  document.getElementById('view-picker').style.display = '';
  document.getElementById('view-session').style.display = 'none';
  document.getElementById('view-summary').style.display = 'none';

  const entries = Object.values(categoryStats).sort((a, b) => {
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

  container.innerHTML = `
    <p class="practice-hint">Sorted by average time (slowest first). Select types to drill, then click Start.</p>
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
        </tr>
      </thead>
      <tbody>
        ${entries.map((e, idx) => {
          const k = `${e.operation}|${e.category}`;
          const avgMs = e.count > 0 ? e.totalMs / e.count : 0;
          const mistakePct = e.count > 0 ? Math.round(e.mistakes / e.count * 100) : 0;
          return `<tr>
            <td><input type="checkbox" class="cat-checkbox" data-key="${k}" data-idx="${idx}"></td>
            <td>${OP_LABELS[e.operation] || e.operation}</td>
            <td>${e.category}</td>
            <td>${e.count}</td>
            <td class="time-cell">${(avgMs / 1000).toFixed(2)}s</td>
            <td>${mistakePct}%</td>
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
  const key  = keys[Math.floor(Math.random() * keys.length)];
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
    ${tip ? `<span class="fb-tip">${tip}</span>` : ''}
  `;
  fb.className = 'session-feedback visible';

  document.getElementById('session-input').disabled = true;
  updateSessionHUD();

  setTimeout(nextQuestion, tip ? 2000 : 900);
}

// ── Summary view ──────────────────────────────────────────────

function showSummary() {
  document.getElementById('view-picker').style.display  = 'none';
  document.getElementById('view-session').style.display = 'none';
  document.getElementById('view-summary').style.display = '';

  const container = document.getElementById('summary-content');
  if (practiceRecs.length === 0) {
    container.innerHTML = '<p class="no-data">No questions answered this session.</p>';
    return;
  }

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
          const histSt = categoryStats[`${r.operation}|${r.category}`];
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
            <td>${OP_LABELS[r.operation] || r.operation}</td>
            <td>${r.category}</td>
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

// ── Tips (mirrored from results.js) ──────────────────────────

function getTip(q) {
  try {
    if (q.operation === 'multiplication') return getMultiplicationTip(q);
    if (q.operation === 'division')       return getDivisionTip(q);
    if (q.operation === 'addition')       return getAdditionTip(q);
    if (q.operation === 'subtraction')    return getSubtractionTip(q);
  } catch (_) {}
  return '';
}

function getMultiplicationTip(q) {
  const [a, b] = parseTwo(q.display, '\u00d7');
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const ans = q.answer;
  if (lo === 2)  return `Double: ${hi} + ${hi} = ${ans}`;
  if (lo === 3)  return `Double then add once more: ${hi}\u00d72 = ${hi * 2}, + ${hi} = ${ans}`;
  if (lo === 4)  return `Double twice: ${hi} \u2192 ${hi * 2} \u2192 ${ans}`;
  if (lo === 5)  return `\u00d75: multiply by 10 then halve: ${hi}\u00d710 = ${hi * 10}, \u00f72 = ${ans}`;
  if (lo === 6)  return `\u00d76: 5\u00d7${hi} + ${hi}: ${hi * 5} + ${hi} = ${ans}`;
  if (lo === 7)  return `\u00d77: ${hi}\u00d710 \u2212 ${hi}\u00d73: ${hi * 10} \u2212 ${hi * 3} = ${ans}`;
  if (lo === 8)  return `\u00d78: double three times: ${hi} \u2192 ${hi * 2} \u2192 ${hi * 4} \u2192 ${ans}`;
  if (lo === 9)  return `\u00d79: ${hi}\u00d710 \u2212 ${hi}: ${hi * 10} \u2212 ${hi} = ${ans}`;
  if (lo === 10) return `Append a zero: ${hi}\u00d710 = ${ans}`;
  if (lo === 11) {
    if (hi >= 10 && hi <= 99) {
      const d1 = Math.floor(hi / 10), d2 = hi % 10, s = d1 + d2;
      if (s < 10)
        return `\u00d711 trick: put digit-sum (${d1}+${d2}=${s}) between the digits: ${d1}|${s}|${d2} = ${ans}`;
      return `\u00d711 trick: digit-sum ${d1}+${d2}=${s} (carry 1): ${d1 + 1}|${s - 10}|${d2} = ${ans}`;
    }
    return `\u00d711: ${hi}\u00d710 + ${hi}: ${hi * 10} + ${hi} = ${ans}`;
  }
  if (lo === 12) return `\u00d712: ${hi}\u00d710 + ${hi}\u00d72: ${hi * 10} + ${hi * 2} = ${ans}`;
  const roundHi = Math.round(hi / 10) * 10, diff = hi - roundHi;
  if (roundHi !== 0 && Math.abs(diff) <= 2 && diff !== 0) {
    const sign = diff > 0 ? '+' : '\u2212';
    return `Round: ${lo}\u00d7${roundHi} = ${lo * roundHi}, ${sign} ${lo}\u00d7${Math.abs(diff)} = ${Math.abs(lo * diff)} \u2192 ${ans}`;
  }
  const tens = Math.floor(hi / 10) * 10, ones = hi % 10;
  if (tens > 0 && ones > 0)
    return `Split: ${lo}\u00d7${tens} + ${lo}\u00d7${ones} = ${lo * tens} + ${lo * ones} = ${ans}`;
  return '';
}

function getDivisionTip(q) {
  const [a, b] = parseTwo(q.display, '\u00f7');
  const ans = q.answer;
  if (b === 2)  return `Halve: ${a} \u00f7 2 = ${ans}`;
  if (b === 3)  return `Recall \u00d73 = double+add: ${ans}\u00d72 = ${ans * 2}, + ${ans} = ${a}`;
  if (b === 4)  return `Halve twice: ${a} \u2192 ${a / 2} \u2192 ${ans}`;
  if (b === 5)  return `\u00f75: double then \u00f710: ${a}\u00d72 = ${a * 2}, \u00f710 = ${ans}`;
  if (b === 6)  return `\u00f76: halve then \u00f73: ${a} \u00f7 2 = ${a / 2}, \u00f7 3 = ${ans}`;
  if (b === 7)  return `Recall \u00d77 = \u00d710\u2212\u00d73: ${ans}\u00d710 \u2212 ${ans}\u00d73 = ${ans * 10} \u2212 ${ans * 3} = ${a}`;
  if (b === 8)  return `Halve three times: ${a} \u2192 ${a / 2} \u2192 ${a / 4} \u2192 ${ans}`;
  if (b === 9)  return `Recall \u00d79 = \u00d710\u2212n: ${ans}\u00d710 \u2212 ${ans} = ${ans * 10} \u2212 ${ans} = ${a}`;
  if (b === 10) return `Drop the last zero: ${a} \u00f7 10 = ${ans}`;
  if (b === 11) return `Recall \u00d711 = \u00d710+n: ${ans}\u00d710 + ${ans} = ${ans * 10} + ${ans} = ${a}`;
  if (b === 12) return `Recall \u00d712 = \u00d710+\u00d72: ${ans}\u00d710 + ${ans}\u00d72 = ${ans * 10} + ${ans * 2} = ${a}`;
  if (b > 12) {
    if (ans === 2)  return `${b}\u00d72 = ${a} \u2192 just double ${b}: ${b} + ${b} = ${a}`;
    if (ans === 3)  return `${b}\u00d73 = ${a} \u2192 double+add: ${b * 2} + ${b} = ${a}`;
    if (ans === 4)  return `${b}\u00d74 = ${a} \u2192 double twice: ${b} \u2192 ${b * 2} \u2192 ${a}`;
    if (ans === 5)  return `${b}\u00d75 = ${a} \u2192 ${b}\u00d710\u00f72: ${b * 10}\u00f72 = ${a}`;
    if (ans === 6)  return `${b}\u00d76 = ${a} \u2192 5\u00d7${b} + ${b}: ${b * 5} + ${b} = ${a}`;
    if (ans === 7)  return `${b}\u00d77 = ${a} \u2192 ${b}\u00d710\u2212${b}\u00d73: ${b * 10}\u2212${b * 3} = ${a}`;
    if (ans === 8)  return `${b}\u00d78 = ${a} \u2192 double 3\u00d7: ${b}\u2192${b * 2}\u2192${b * 4}\u2192${a}`;
    if (ans === 9)  return `${b}\u00d79 = ${a} \u2192 ${b}\u00d710\u2212${b}: ${b * 10}\u2212${b} = ${a}`;
    if (ans === 11) return `${b}\u00d711 = ${a} \u2192 ${b}\u00d710+${b}: ${b * 10}+${b} = ${a}`;
    if (ans === 12) return `${b}\u00d712 = ${a} \u2192 ${b}\u00d710+${b}\u00d72: ${b * 10}+${b * 2} = ${a}`;
  }
  return `What \u00d7 ${b} = ${a}? \u2192 ${ans} \u00d7 ${b} = ${a}`;
}

function getAdditionTip(q) {
  const [a, b] = parseTwo(q.display, '+');
  const ans = q.answer;
  const diff = Math.abs(a - b);
  if (diff <= 2) {
    const smaller = Math.min(a, b);
    if (diff === 0) return `Doubles: ${a} + ${a} = ${ans}`;
    return `Near-doubles: ${smaller} + ${smaller} = ${smaller * 2}, + ${diff} = ${ans}`;
  }
  const ceilA = Math.ceil(a / 10) * 10, toA = ceilA - a;
  if (toA > 0 && toA <= 4 && b >= toA)
    return `Bridge through ${ceilA}: ${a} + ${toA} = ${ceilA}, + ${b - toA} = ${ans}`;
  const ceilB = Math.ceil(b / 10) * 10, toB = ceilB - b;
  if (toB > 0 && toB <= 4 && a >= toB)
    return `Bridge through ${ceilB}: ${b} + ${toB} = ${ceilB}, + ${a - toB} = ${ans}`;
  const roundA = Math.round(a / 10) * 10, gapA = roundA - a;
  if (gapA >= 1 && gapA <= 4 && b >= gapA)
    return `Round ${a}\u2192${roundA}: ${roundA} + ${b - gapA} = ${ans}`;
  const roundB = Math.round(b / 10) * 10, gapB = roundB - b;
  if (gapB >= 1 && gapB <= 4 && a >= gapB)
    return `Round ${b}\u2192${roundB}: ${a - gapB} + ${roundB} = ${ans}`;
  const tensA = Math.floor(a / 10) * 10, onesA = a % 10;
  const tensB = Math.floor(b / 10) * 10, onesB = b % 10;
  if (tensA > 0 && tensB > 0) {
    const onesSum = onesA + onesB;
    if (onesSum >= 10)
      return `Left-to-right: ${tensA}+${tensB}=${tensA + tensB}, then ${onesA}+${onesB}=${onesSum} (carry 1) \u2192 ${ans}`;
    return `Left-to-right: ${tensA}+${tensB}=${tensA + tensB}, then +${onesSum} = ${ans}`;
  }
  return '';
}

function getSubtractionTip(q) {
  const [a, b] = parseTwo(q.display, '\u2212');
  const ans = q.answer;
  if (ans <= 15) return `Count up: ${b} + ${ans} = ${a}`;
  const roundB = Math.round(b / 10) * 10, diffB = b - roundB;
  if (Math.abs(diffB) <= 4 && diffB !== 0) {
    if (diffB < 0)
      return `Round up: ${a} \u2212 ${roundB} = ${a - roundB}, add back ${Math.abs(diffB)} \u2192 ${ans}`;
    return `Round down: ${a} \u2212 ${roundB} = ${a - roundB}, \u2212 ${diffB} more \u2192 ${ans}`;
  }
  const tensA = Math.floor(a / 10) * 10, onesA = a % 10;
  const tensB = Math.floor(b / 10) * 10, onesB = b % 10;
  if (onesA >= onesB)
    return `Left-to-right: ${tensA}\u2212${tensB}=${tensA - tensB}, then \u2212${onesB}+${onesA} \u2192 ${ans}`;
  return `Left-to-right: ${a}\u2212${tensB}=${a - tensB}, then \u2212${onesB} \u2192 ${ans}`;
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
