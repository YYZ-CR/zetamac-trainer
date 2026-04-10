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

  if (lo === 2)  return `\u00d72: just double \u2192 ${hi} + ${hi} = ${q.answer}`;
  if (lo === 3)  return `\u00d73: double then add once more \u2192 ${hi * 2} + ${hi} = ${q.answer}`;
  if (lo === 4)  return `\u00d74: double twice \u2192 ${hi} \u2192 ${hi * 2} \u2192 ${hi * 4}`;
  if (lo === 5)  return `\u00d75: multiply by 10 then halve \u2192 ${hi * 10} \u00f7 2 = ${q.answer}`;
  if (lo === 6)  return `\u00d76: think 5\u00d7${hi} + ${hi} = ${hi * 5} + ${hi} = ${q.answer}`;
  if (lo === 8)  return `\u00d78: double three times \u2192 ${hi} \u2192 ${hi * 2} \u2192 ${hi * 4} \u2192 ${hi * 8}`;
  if (lo === 9)  return `\u00d79: think ${hi}\u00d710 \u2212 ${hi} = ${hi * 10} \u2212 ${hi} = ${q.answer}`;
  if (lo === 11) return `\u00d711: think ${hi}\u00d710 + ${hi} = ${hi * 10} + ${hi} = ${q.answer}`;
  if (lo === 12) return `\u00d712: think ${hi}\u00d710 + ${hi}\u00d72 = ${hi * 10} + ${hi * 2} = ${q.answer}`;

  // Round the larger factor to nearest 10
  const roundB = Math.round(b / 10) * 10;
  const diffB  = b - roundB;
  if (roundB !== 0 && Math.abs(diffB) <= 2 && diffB !== 0) {
    const sign = diffB > 0 ? '+' : '\u2212';
    return `${a}\u00d7${b}: round \u2192 ${a}\u00d7${roundB} = ${a * roundB}, ${sign} ${a}\u00d7${Math.abs(diffB)} = ${Math.abs(a * diffB)} \u2192 ${q.answer}`;
  }

  // Split larger factor into tens + ones
  const tens = Math.floor(hi / 10) * 10, ones = hi % 10;
  if (tens > 0 && ones > 0) {
    return `${lo}\u00d7${hi}: split \u2192 ${lo}\u00d7${tens} + ${lo}\u00d7${ones} = ${lo * tens} + ${lo * ones} = ${q.answer}`;
  }

  return '';
}

function getDivisionTip(q) {
  const [a, b] = parseTwo(q.display, '\u00f7');
  const ans = q.answer;

  if (b === 2)  return `\u00f72: just halve \u2192 ${a} \u00f7 2 = ${ans}`;
  if (b === 4)  return `\u00f74: halve twice \u2192 ${a} \u2192 ${a / 2} \u2192 ${ans}`;
  if (b === 5)  return `\u00f75: multiply by 2 then \u00f710 \u2192 ${a}\u00d72 = ${a * 2}, \u00f710 = ${ans}`;
  if (b === 8)  return `\u00f78: halve three times \u2192 ${a} \u2192 ${a / 2} \u2192 ${a / 4} \u2192 ${ans}`;
  if (b === 9)  return `\u00f79: think what \u00d79 = ${a}? \u2192 ${ans}\u00d710 \u2212 ${ans} = ${a}`;
  if (b === 11) return `\u00f711: think what \u00d711 = ${a}? \u2192 ${ans}\u00d710 + ${ans} = ${a}`;

  return `\u00f7${b}: ask \u201cwhat \u00d7 ${b} = ${a}?\u201d \u2192 ${ans} \u00d7 ${b} = ${a}`;
}

function getAdditionTip(q) {
  const [a, b] = parseTwo(q.display, '+');

  // Round one addend up to nearest 10, compensate from the other
  const ceilA = Math.ceil(a / 10) * 10, toA = ceilA - a;
  if (toA > 0 && toA <= 4) {
    return `${a} + ${b}: round up \u2192 ${ceilA} + ${b - toA} = ${q.answer}`;
  }
  const ceilB = Math.ceil(b / 10) * 10, toB = ceilB - b;
  if (toB > 0 && toB <= 4) {
    return `${a} + ${b}: round up \u2192 ${a - toB} + ${ceilB} = ${q.answer}`;
  }

  // Add tens then ones
  const tensA = Math.floor(a / 10) * 10, onesA = a % 10;
  const tensB = Math.floor(b / 10) * 10, onesB = b % 10;
  if (tensA > 0 && tensB > 0) {
    return `${a} + ${b}: tens first \u2192 ${tensA} + ${tensB} = ${tensA + tensB}, then + ${onesA + onesB} = ${q.answer}`;
  }

  return '';
}

function getSubtractionTip(q) {
  // Display: "sum \u2212 part", answer is the other part. Separator is U+2212.
  const [a, b] = parseTwo(q.display, '\u2212');

  // Round subtrahend to nearest 10 and adjust
  const roundB = Math.round(b / 10) * 10, diffB = b - roundB;
  if (Math.abs(diffB) <= 3 && diffB !== 0) {
    const adj = diffB > 0 ? `add back ${diffB}` : `subtract ${Math.abs(diffB)}`;
    return `${a} \u2212 ${b}: round \u2192 ${a} \u2212 ${roundB} = ${a - roundB}, then ${adj} \u2192 ${q.answer}`;
  }

  // Count up from subtrahend to minuend
  return `${a} \u2212 ${b}: count up \u2192 ${b} + ${q.answer} = ${a}`;
}
