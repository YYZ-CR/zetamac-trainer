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
        ${slowest.map(q =>
          `<li>${q.display} = ${q.answer}&nbsp;&nbsp;&mdash;&nbsp;&nbsp;<strong>${(q.timeMs / 1000).toFixed(2)}s</strong></li>`
        ).join('')}
      </ul>
    </div>

    <div class="feedback-section">
      <h3>Questions with Initial Mistakes (${mistakes.length})</h3>
      ${mistakes.length === 0
        ? '<p class="no-data">None &mdash; great accuracy!</p>'
        : `<ul class="feedback-list">
            ${mistakes.map(q =>
              `<li>${q.display} = ${q.answer}&nbsp;&nbsp;&mdash;&nbsp;&nbsp;tried: <em>${q.mistakeValues.join(', ')}</em></li>`
            ).join('')}
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
