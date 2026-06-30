document.addEventListener('DOMContentLoaded', async () => {
  createAuthModal();

  let user = null;
  try {
    user = await initAuth({
      onAuthChange: (u, event) => {
        renderAuthBar(u, document.getElementById('top-bar'));
        if (event === 'SIGNED_IN') {
          document.getElementById('save-banner').style.display = 'none';
        }
      },
    });
  } catch (e) { console.warn('initAuth failed:', e); }
  renderAuthBar(user, document.getElementById('top-bar'));

  const params = new URLSearchParams(window.location.search);
  // Fallback for servers that strip query params (e.g. npx serve):
  //   zt_pending_session = set by dashboard View links (specific session)
  //   zt_last_session    = set by game end (most recent game)
  const sessionKey = params.get('session')
    || localStorage.getItem('zt_pending_session')
    || localStorage.getItem('zt_last_session');
  localStorage.removeItem('zt_pending_session');
  if (!sessionKey) { window.location.href = 'index.html'; return; }

  // ── Load session ─────────────────────────────────────────
  let session   = null;
  let isLocal   = false;

  const cached = localStorage.getItem('session_' + sessionKey);
  if (cached) {
    session = JSON.parse(cached);
    isLocal = true;
  } else {
    try {
      const row = await getSession(sessionKey);
      if (row) {
        session = {
          sessionKey:      row.session_key,
          configKey:       row.config_key,
          score:           row.score,
          durationSeconds: row.duration_seconds,
          questions:       row.questions,
        };
      }
    } catch (_) {}
  }

  if (!session) {
    document.getElementById('results-wrap').innerHTML = '<p>Session not found.</p>';
    return;
  }

  // Show save banner only for the user's own fresh (local) anonymous session
  if (isLocal && !user) {
    document.getElementById('save-banner').style.display = 'block';
    document.getElementById('save-login-btn').addEventListener('click', () => showAuthModal('login'));
    document.getElementById('save-register-btn').addEventListener('click', () => showAuthModal('register'));
  }

  renderSummary(session);
  renderRunGraph(session);
  renderBreakdown(session);
  renderFeedback(session);

  // ── Tabs ─────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // ── Actions ───────────────────────────────────────────────
  document.getElementById('play-again-btn').addEventListener('click', () => {
    window.location.href = session.configKey
      ? 'index.html?key=' + session.configKey
      : 'index.html';
  });

  document.getElementById('share-btn').addEventListener('click', () => {
    const btn = document.getElementById('share-btn');
    navigator.clipboard.writeText(window.location.href).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy Results Link'; }, 2000);
    }).catch(() => {
      prompt('Copy this link:', window.location.href);
    });
  });
});

// ── Render helpers ────────────────────────────────────────────

function renderSummary(session) {
  const { score, questions } = session;
  const withMistakes = questions.filter(q => q.hadMistake).length;
  const accuracy     = questions.length > 0
    ? Math.round(((questions.length - withMistakes) / questions.length) * 100) + '%'
    : '—';
  const avgMs  = questions.length > 0
    ? questions.reduce((s, q) => s + q.timeMs, 0) / questions.length
    : 0;
  const avgStr = questions.length > 0 ? (avgMs / 1000).toFixed(2) + 's' : '—';

  document.getElementById('summary-score').textContent     = score;
  document.getElementById('summary-accuracy').textContent  = accuracy;
  document.getElementById('summary-avg-time').textContent  = avgStr;
  document.getElementById('summary-mistakes').textContent  = withMistakes;
}

// ── Run graph ─────────────────────────────────────────────────
// Monkeytype-style per-run chart. Reconstructs the timeline from each
// question's timeMs (no wall-clock timestamps are stored) and plots a
// projected final score over time: (answers/sec) × session duration.
function renderRunGraph(session) {
  const panel  = document.getElementById('run-graph-panel');
  const canvas = document.getElementById('run-chart');
  const qs     = session.questions || [];

  // Need at least a couple of points (and Chart.js) for a meaningful graph.
  if (qs.length < 2 || typeof Chart === 'undefined' || !canvas) {
    if (panel) panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';

  const duration = session.durationSeconds || 0;
  const SMOOTH_K = 5; // sliding window (questions) for the smoothed line

  // Cumulative elapsed time (seconds) at the moment each question was answered.
  const elapsed = [];
  let acc = 0;
  for (const q of qs) { acc += q.timeMs; elapsed.push(acc / 1000); }

  // Per-point series, all carrying the question index so the tooltip can show
  // exactly what was happening at that instant.
  const rawPts = [];      // instantaneous projected score
  const smoothPts = [];   // sliding-window projected score (main line)

  for (let i = 0; i < qs.length; i++) {
    const x = elapsed[i];

    // Instantaneous: this single question's pace projected across the session.
    const rawScore = duration * (1000 / qs[i].timeMs);
    rawPts.push({ x, y: round1(rawScore), i });

    // Smoothed: answers/sec over the last K questions × duration.
    const from = Math.max(0, i - SMOOTH_K + 1);
    let msSum = 0;
    for (let j = from; j <= i; j++) msSum += qs[j].timeMs;
    const count = i - from + 1;
    const smoothScore = duration * (count / (msSum / 1000));
    smoothPts.push({ x, y: round1(smoothScore), i });
  }

  // Mistakes are drawn as red ✗ points directly on the smoothed line so the
  // index-based tooltip stays aligned across all datasets.
  const isMistake = ctx => qs[ctx.dataIndex]?.hadMistake;

  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Projected score',
          data: smoothPts,
          borderColor: '#333',
          backgroundColor: 'rgba(50,50,50,0.06)',
          borderWidth: 2,
          tension: 0.3,
          pointRadius:      ctx => isMistake(ctx) ? 6 : 0,
          pointHoverRadius: ctx => isMistake(ctx) ? 8 : 4,
          pointStyle:       ctx => isMistake(ctx) ? 'crossRot' : 'circle',
          pointBorderColor: ctx => isMistake(ctx) ? '#c44' : '#333',
          pointBackgroundColor: ctx => isMistake(ctx) ? '#c44' : '#333',
          pointBorderWidth: 2,
          fill: true,
          order: 2,
        },
        {
          label: 'Instantaneous',
          data: rawPts,
          borderColor: 'rgba(150,150,150,0.7)',
          borderDash: [5, 4],
          borderWidth: 1,
          tension: 0.2,
          pointRadius: 0,
          pointHoverRadius: 3,
          fill: false,
          order: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            // Header: which question + when it was answered.
            title: items => {
              const i = items[0].raw.i;
              return `Q${i + 1}  ·  ${round1(elapsed[i])}s in`;
            },
            // Body: the actual question, time taken, and projected scores.
            label: item => {
              const i = item.raw.i;
              const q = qs[i];
              if (item.dataset.label === 'Projected score') {
                const lines = [
                  `${q.display} = ${q.answer}`,
                  `Time: ${(q.timeMs / 1000).toFixed(2)}s`,
                  `Projected: ${Math.round(item.parsed.y)}`,
                ];
                if (q.hadMistake) lines.push(`✗ tried: ${q.mistakeValues.join(', ')}`);
                return lines;
              }
              return `Instant: ${Math.round(item.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Seconds', font: { size: 11 } },
          min: 0,
          max: duration || undefined,
          grid: { color: '#eee' },
          ticks: { font: { size: 11 }, maxTicksLimit: 12 },
        },
        y: {
          beginAtZero: false,
          title: { display: true, text: 'Projected score', font: { size: 11 } },
          grid: { color: '#eee' },
          ticks: { font: { size: 11 }, precision: 0 },
        },
      },
    },
  });
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function renderBreakdown(session) {
  const tbody = document.getElementById('breakdown-tbody');
  session.questions.forEach((q, i) => {
    const tr = document.createElement('tr');
    if (q.hadMistake) tr.classList.add('had-mistake');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${q.display} = <strong>${q.answer}</strong></td>
      <td>${(q.timeMs / 1000).toFixed(2)}s</td>
      <td>${q.hadMistake
        ? `<span class="mistake-yes">\u2717 tried: ${q.mistakeValues.join(', ')}</span>`
        : '<span class="mistake-no">\u2014</span>'
      }</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderFeedback(session) {
  const { questions } = session;
  const container = document.getElementById('feedback-content');

  if (questions.length === 0) {
    container.innerHTML = '<p class="no-data">No questions completed.</p>';
    return;
  }

  // Slowest 5
  const byTime  = [...questions].sort((a, b) => b.timeMs - a.timeMs);
  const slowest = byTime.slice(0, Math.min(5, byTime.length));

  // Questions with initial mistakes
  const mistakes = questions.filter(q => q.hadMistake);

  // Stats per operation
  const byOp = {};
  for (const q of questions) {
    if (!byOp[q.operation]) byOp[q.operation] = { count: 0, totalMs: 0, mistakes: 0 };
    byOp[q.operation].count++;
    byOp[q.operation].totalMs += q.timeMs;
    if (q.hadMistake) byOp[q.operation].mistakes++;
  }
  const opStats = Object.entries(byOp)
    .map(([op, d]) => ({ op, count: d.count, avgMs: d.totalMs / d.count, mistakes: d.mistakes }))
    .sort((a, b) => b.avgMs - a.avgMs);

  const slowestOp = opStats[0];

  container.innerHTML = `
    <div class="feedback-section">
      <h3>Slowest Questions</h3>
      <ul class="feedback-list">
        ${slowest.map(q => {
          const tip = getTip(q);
          return `<li>
            <span>${q.display} = ${q.answer}&nbsp;&nbsp;&mdash;&nbsp;&nbsp;<strong>${(q.timeMs / 1000).toFixed(2)}s</strong></span>
            ${tip ? `<span class="tip">\uD83D\uDCA1 ${tip}</span>` : ''}
          </li>`;
        }).join('')}
      </ul>
    </div>

    <div class="feedback-section">
      <h3>Questions with Initial Mistakes (${mistakes.length})</h3>
      ${mistakes.length === 0
        ? '<p class="no-data">None &mdash; great accuracy!</p>'
        : `<ul class="feedback-list">
            ${mistakes.map(q => {
              const tip = getTip(q);
              return `<li>
                <span>${q.display} = ${q.answer}&nbsp;&nbsp;&mdash;&nbsp;&nbsp;tried: <em>${q.mistakeValues.join(', ')}</em></span>
                ${tip ? `<span class="tip">\uD83D\uDCA1 ${tip}</span>` : ''}
              </li>`;
            }).join('')}
          </ul>`
      }
    </div>

    <div class="feedback-section">
      <h3>Performance by Operation</h3>
      <div class="op-stat-grid">
        ${opStats.map(s => `
          <div class="op-stat-card">
            <div class="op-stat-name">${s.op}</div>
            <div class="op-stat-detail">
              ${s.count} question${s.count !== 1 ? 's' : ''}<br>
              Avg time: ${(s.avgMs / 1000).toFixed(2)}s<br>
              Mistakes: ${s.mistakes}
            </div>
          </div>
        `).join('')}
      </div>
      ${slowestOp
        ? `<p class="feedback-insight">Your slowest operation is <strong>${slowestOp.op}</strong> &mdash; consider focused practice on it.</p>`
        : ''
      }
    </div>
  `;
}

// ── Tips ──────────────────────────────────────────────────────────

function getTip(q) {
  try {
    if (q.operation === 'multiplication') return getMultiplicationTip(q);
    if (q.operation === 'division')       return getDivisionTip(q);
    if (q.operation === 'addition')       return getAdditionTip(q);
    if (q.operation === 'subtraction')    return getSubtractionTip(q);
  } catch (_) {}
  return '';
}

function parseTwo(display, sep) {
  const parts = display.split(sep);
  return [parseInt(parts[0].trim(), 10), parseInt(parts[1].trim(), 10)];
}

function getMultiplicationTip(q) {
  const [a, b] = parseTwo(q.display, '\u00d7');
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const ans = q.answer;

  // Tricks for each small multiplier (default config mulMin1=2, mulMax1=12)
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
    // Digit-sandwich trick for 2-digit numbers: 11 \u00d7 AB = A(A+B)B
    if (hi >= 10 && hi <= 99) {
      const d1 = Math.floor(hi / 10), d2 = hi % 10, s = d1 + d2;
      if (s < 10)
        return `\u00d711 trick: put digit-sum (${d1}+${d2}=${s}) between the digits: ${d1}|${s}|${d2} = ${ans}`;
      else
        return `\u00d711 trick: digit-sum ${d1}+${d2}=${s} (carry 1): ${d1 + 1}|${s - 10}|${d2} = ${ans}`;
    }
    return `\u00d711: ${hi}\u00d710 + ${hi}: ${hi * 10} + ${hi} = ${ans}`;
  }

  if (lo === 12) return `\u00d712: ${hi}\u00d710 + ${hi}\u00d72: ${hi * 10} + ${hi * 2} = ${ans}`;

  // Fallback: round nearest factor to multiple of 10 and compensate
  const roundHi = Math.round(hi / 10) * 10, diff = hi - roundHi;
  if (roundHi !== 0 && Math.abs(diff) <= 2 && diff !== 0) {
    const sign = diff > 0 ? '+' : '\u2212';
    return `Round: ${lo}\u00d7${roundHi} = ${lo * roundHi}, ${sign} ${lo}\u00d7${Math.abs(diff)} = ${Math.abs(lo * diff)} \u2192 ${ans}`;
  }

  // Split larger factor: lo\u00d7hi = lo\u00d7(tens+ones)
  const tens = Math.floor(hi / 10) * 10, ones = hi % 10;
  if (tens > 0 && ones > 0)
    return `Split: ${lo}\u00d7${tens} + ${lo}\u00d7${ones} = ${lo * tens} + ${lo * ones} = ${ans}`;

  return '';
}

function getDivisionTip(q) {
  const [a, b] = parseTwo(q.display, '\u00f7');
  const ans = q.answer;

  // Small divisor tricks (b = 2\u201312)
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

  // Large divisor (b > 12): ans is the small factor; tip based on ans's multiplication trick
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

  // Near-doubles: when both numbers are equal or differ by 1\u20132
  const diff = Math.abs(a - b);
  if (diff <= 2) {
    const smaller = Math.min(a, b);
    if (diff === 0) return `Doubles: ${a} + ${a} = ${ans}`;
    return `Near-doubles: ${smaller} + ${smaller} = ${smaller * 2}, + ${diff} = ${ans}`;
  }

  // Bridge through nearest multiple of 10: take from one addend to round the other
  const ceilA = Math.ceil(a / 10) * 10, toA = ceilA - a;
  if (toA > 0 && toA <= 4 && b >= toA)
    return `Bridge through ${ceilA}: ${a} + ${toA} = ${ceilA}, + ${b - toA} = ${ans}`;

  const ceilB = Math.ceil(b / 10) * 10, toB = ceilB - b;
  if (toB > 0 && toB <= 4 && a >= toB)
    return `Bridge through ${ceilB}: ${b} + ${toB} = ${ceilB}, + ${a - toB} = ${ans}`;

  // Round and compensate: round the near-10 addend, adjust the other
  const roundA = Math.round(a / 10) * 10, gapA = roundA - a; // positive = rounded up
  if (gapA >= 1 && gapA <= 4 && b >= gapA)
    return `Round ${a}\u2192${roundA}: ${roundA} + ${b - gapA} = ${ans}`;

  const roundB = Math.round(b / 10) * 10, gapB = roundB - b;
  if (gapB >= 1 && gapB <= 4 && a >= gapB)
    return `Round ${b}\u2192${roundB}: ${a - gapB} + ${roundB} = ${ans}`;

  // Left-to-right: add tens then ones
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
  // Display uses U+2212 (\u2212) as minus sign
  const [a, b] = parseTwo(q.display, '\u2212');
  const ans = q.answer;

  // Count up when the answer is small (numbers are close)
  if (ans <= 15)
    return `Count up: ${b} + ${ans} = ${a}`;

  // Round subtrahend to nearest 10 and adjust
  // diffB = b \u2212 roundB: negative means b was rounded UP (over-subtracted \u2192 add back)
  //                          positive means b was rounded DOWN (under-subtracted \u2192 subtract more)
  const roundB = Math.round(b / 10) * 10, diffB = b - roundB;
  if (Math.abs(diffB) <= 4 && diffB !== 0) {
    if (diffB < 0) {
      // e.g. b=29, roundB=30: over-subtracted by 1, add back Math.abs(diffB)
      return `Round up: ${a} \u2212 ${roundB} = ${a - roundB}, add back ${Math.abs(diffB)} \u2192 ${ans}`;
    } else {
      // e.g. b=31, roundB=30: under-subtracted by 1, subtract diffB more
      return `Round down: ${a} \u2212 ${roundB} = ${a - roundB}, \u2212 ${diffB} more \u2192 ${ans}`;
    }
  }

  // Left-to-right: subtract tens then ones
  const tensA = Math.floor(a / 10) * 10, onesA = a % 10;
  const tensB = Math.floor(b / 10) * 10, onesB = b % 10;
  if (onesA >= onesB)
    return `Left-to-right: ${tensA}\u2212${tensB}=${tensA - tensB}, then \u2212${onesB}+${onesA} \u2192 ${ans}`;

  // Need to borrow: subtract rounded tens, then handle ones
  return `Left-to-right: ${a}\u2212${tensB}=${a - tensB}, then \u2212${onesB} \u2192 ${ans}`;
}
