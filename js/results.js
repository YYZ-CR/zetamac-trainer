// Kept so the chart can be rebuilt when the theme changes — Chart.js resolves
// colours once, at construction.
let runChart      = null;
let loadedSession = null;

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
  // Both fallbacks are one-shot. zt_last_session used to persist forever, so
  // any later visit to a bare results.html silently re-rendered the most
  // recent game instead of redirecting home.
  localStorage.removeItem('zt_pending_session');
  localStorage.removeItem('zt_last_session');
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

  loadedSession = session;
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
    // Build the link from the session key rather than reading location.href.
    // When the page was reached through a localStorage fallback the URL has no
    // ?session= at all, so copying it handed out a link that resolves to the
    // recipient's own last game.
    const shareUrl = new URL('results.html', window.location.href);
    shareUrl.search = '?session=' + encodeURIComponent(sessionKey);
    const link = shareUrl.toString();
    navigator.clipboard.writeText(link).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy Results Link'; }, 2000);
    }).catch(() => {
      prompt('Copy this link:', link);
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
// Monkeytype-style per-run chart, plotting SPEED over time rather than a
// projected final total.
//
// Projecting a final score is what the earlier versions of this chart did, and
// it is unstable by construction: the projection multiplies a pace estimate by
// the seconds remaining, so a quick opening answer with 118 seconds left reads
// as a score of 150 and flattens the rest of the run into the floor of the
// axis. Monkeytype avoids this by charting a rate (wpm), which is bounded and
// stays comparable all the way through the run. Same idea here: answers per
// minute, as a running average plus a rolling window.
function renderRunGraph(session) {
  const panel  = document.getElementById('run-graph-panel');
  const canvas = document.getElementById('run-chart');
  const qs     = session.questions || [];

  // Below a handful of questions the curves are noise, not signal.
  if (qs.length < 5 || typeof Chart === 'undefined' || !canvas) {
    if (panel) panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  if (runChart) { runChart.destroy(); runChart = null; }

  const duration = session.durationSeconds || 0;

  // Cumulative elapsed time (seconds) at the moment each question was answered.
  const elapsed = [];
  let acc = 0;
  for (const q of qs) { acc += q.timeMs; elapsed.push(acc / 1000); }

  const RECENT_K   = 5;  // window (questions) for the rolling rate
  const WARMUP_Q   = 3;  // a rate off one or two answers is meaningless
  const WARMUP_SEC = 5;  // ...and a per-minute rate measured over <5s is noise

  // Per-point series, all carrying the question index so the tooltip can show
  // exactly what was happening at that instant.
  const rawPts    = [];   // rolling-window rate
  const smoothPts = [];   // running-average rate (main line)

  for (let i = 0; i < qs.length; i++) {
    const x      = elapsed[i];
    const banked = i + 1;   // questions answered so far
    if (x <= 0) continue;

    // Running average: answers per minute across everything so far. Converges
    // on the session's true rate and is what the final score reduces to.
    if (banked >= WARMUP_Q && x >= WARMUP_SEC) {
      smoothPts.push({ x, y: round1(banked / x * 60), i });
    }

    // Rolling: rate over the last RECENT_K questions only. Emitted only once a
    // FULL window exists — a left-truncated window is arithmetically identical
    // to the running average, which is why this line used to hide underneath
    // the main one for the first five questions.
    if (i >= RECENT_K - 1 && x >= WARMUP_SEC) {
      // Window covers questions i-K+1 … i; the span before the first of them
      // is 0, not elapsed[-1].
      const windowStart = i - RECENT_K >= 0 ? elapsed[i - RECENT_K] : 0;
      const windowSec   = x - windowStart;
      if (windowSec > 0) {
        rawPts.push({ x, y: round1(RECENT_K / windowSec * 60), i });
      }
    }
  }

  // Terminal point: the session's true overall rate, which is exactly the
  // score on the card next to the chart. The last answered question lands
  // short of the duration (the question still on screen at the whistle is
  // never recorded), so without this the line stops early and slightly high.
  const finalScore = session.score ?? qs.length;
  const finalRate  = duration > 0 ? round1(finalScore / duration * 60) : null;
  if (finalRate != null) {
    smoothPts.push({ x: duration, y: finalRate, i: qs.length - 1, final: true });
  }

  // Bound the y-axis around the bulk of the data. The rolling line can still
  // spike on a lucky streak; letting Chart.js autoscale to that squashes the
  // rest of the run flat.
  // The average line is the primary series and must always fit on the canvas;
  // only the noisier rolling line is allowed to clip, at its 95th percentile.
  const mainYs = smoothPts.map(p => p.y);
  const rollYs = [...rawPts.map(p => p.y)].sort((a, b) => a - b);
  const pct    = f => rollYs.length
    ? rollYs[Math.min(rollYs.length - 1, Math.floor(rollYs.length * f))]
    : null;
  const anchors = [...mainYs, finalRate, pct(0.05), pct(0.95)].filter(v => v != null);
  const lo  = Math.min(...anchors);
  const hi  = Math.max(...anchors);
  const pad = Math.max(2, (hi - lo) * 0.15);
  const yLo = Math.max(0, lo - pad);
  const yHi = hi + pad;

  // Mistakes are drawn as red ✗ points directly on the smoothed line. The
  // series no longer starts at question 0 (warm-up points are skipped), so
  // look the question up through the point's own stored index.
  const isMistake = ctx => {
    const p = ctx.dataset.data[ctx.dataIndex];
    return !!p && !p.final && !!qs[p.i]?.hadMistake;
  };

  // Chart.js needs concrete colours, so resolve the theme tokens here. The
  // chart is rebuilt on zt-theme-change (see the listener at the bottom).
  const cLine  = themeColor('--c-chart-line', '#333');
  const cFill  = themeColor('--c-chart-fill', 'rgba(50,50,50,0.06)');
  const cRoll  = themeColor('--c-chart-rolling', 'rgba(150,150,150,0.7)');
  const cBad   = themeColor('--c-danger', '#c44');
  const cGrid  = themeColor('--c-rule', '#eee');
  const cText  = themeColor('--c-ink-muted', '#555');

  const ctx = canvas.getContext('2d');
  runChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Average pace',
          data: smoothPts,
          borderColor: cLine,
          backgroundColor: cFill,
          borderWidth: 2,
          tension: 0.3,
          pointRadius:      ctx => isMistake(ctx) ? 6 : 0,
          pointHoverRadius: ctx => isMistake(ctx) ? 8 : 4,
          pointStyle:       ctx => isMistake(ctx) ? 'crossRot' : 'circle',
          pointBorderColor: ctx => isMistake(ctx) ? cBad : cLine,
          pointBackgroundColor: ctx => isMistake(ctx) ? cBad : cLine,
          pointBorderWidth: 2,
          fill: true,
          order: 2,
        },
        {
          label: `Last ${RECENT_K}`,
          data: rawPts,
          borderColor: cRoll,
          borderDash: [5, 4],
          borderWidth: 1,
          tension: 0.2,
          pointRadius: 0,
          pointHoverRadius: 3,
          fill: false,
          order: 3,
        },
      ].filter(d => d.data.length >= 2),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // The two series no longer share an index (warm-up points are skipped),
      // so match by nearest x rather than by dataIndex.
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 }, color: cText },
        },
        tooltip: {
          callbacks: {
            // Header: which question + when it was answered.
            title: items => {
              const p = items[0].raw;
              if (p.final) return `Final  ·  ${round1(p.x)}s`;
              return `Q${p.i + 1}  ·  ${round1(elapsed[p.i])}s in`;
            },
            // Body: the actual question, time taken, and projected scores.
            label: item => {
              const p = item.raw;
              if (p.final) return `Final: ${finalScore} in ${duration}s  ·  ${Math.round(item.parsed.y)}/min`;
              const q = qs[p.i];
              if (!q) return '';
              if (item.dataset.label === 'Average pace') {
                const lines = [
                  `${q.display} = ${q.answer}`,
                  `Time: ${(q.timeMs / 1000).toFixed(2)}s`,
                  `Score so far: ${p.i + 1}`,
                  `Average: ${Math.round(item.parsed.y)}/min`,
                ];
                if (q.hadMistake) lines.push(`✗ tried: ${(q.mistakeValues || []).join(', ')}`);
                return lines;
              }
              return `Last ${RECENT_K}: ${Math.round(item.parsed.y)}/min`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Seconds', font: { size: 11 }, color: cText },
          min: 0,
          max: duration || undefined,
          grid: { color: cGrid },
          ticks: { font: { size: 11 }, maxTicksLimit: 12, color: cText },
        },
        y: {
          beginAtZero: false,
          min: Math.floor(yLo),
          max: Math.ceil(yHi),
          title: { display: true, text: 'Answers per minute', font: { size: 11 }, color: cText },
          grid: { color: cGrid },
          ticks: { font: { size: 11 }, precision: 0, color: cText },
        },
      },
    },
  });
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// A 200-question run rendered every row at once — a 6000px wall of table.
// Show a first page and let the user pull in the rest.
const BREAKDOWN_PAGE = 25;

function renderBreakdown(session) {
  const tbody = document.getElementById('breakdown-tbody');
  const more  = document.getElementById('breakdown-more');
  const btn   = document.getElementById('breakdown-more-btn');
  const total = session.questions.length;
  let shown   = 0;

  function paint() {
    const next = Math.min(shown + BREAKDOWN_PAGE, total);
    appendRows(tbody, session.questions, shown, next);
    shown = next;
    if (!more || !btn) return;
    if (shown >= total) {
      more.style.display = 'none';
    } else {
      more.style.display = 'block';
      const remaining = total - shown;
      btn.textContent = `Show ${Math.min(BREAKDOWN_PAGE, remaining)} more (${remaining} left)`;
    }
  }

  if (btn) btn.addEventListener('click', paint);
  paint();
}

function appendRows(tbody, questions, from, to) {
  for (let i = from; i < to; i++) {
    const q = questions[i];
    const tr = document.createElement('tr');
    if (q.hadMistake) tr.classList.add('had-mistake');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(q.display)} = <strong>${escapeHtml(q.answer)}</strong></td>
      <td>${(q.timeMs / 1000).toFixed(2)}s</td>
      <td>${q.hadMistake
        ? `<span class="mistake-yes">\u2717 tried: ${escapeHtml((q.mistakeValues || []).join(', '))}</span>`
        : '<span class="mistake-no">\u2014</span>'
      }</td>
    `;
    tbody.appendChild(tr);
  }
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
            <span>${escapeHtml(q.display)} = ${escapeHtml(q.answer)}&nbsp;&nbsp;&mdash;&nbsp;&nbsp;<strong>${(q.timeMs / 1000).toFixed(2)}s</strong></span>
            ${tip ? `<span class="tip">\uD83D\uDCA1 ${escapeHtml(tip)}</span>` : ''}
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
                <span>${escapeHtml(q.display)} = ${escapeHtml(q.answer)}&nbsp;&nbsp;&mdash;&nbsp;&nbsp;tried: <em>${escapeHtml((q.mistakeValues || []).join(', '))}</em></span>
                ${tip ? `<span class="tip">\uD83D\uDCA1 ${escapeHtml(tip)}</span>` : ''}
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
            <div class="op-stat-name">${escapeHtml(s.op)}</div>
            <div class="op-stat-detail">
              ${s.count} question${s.count !== 1 ? 's' : ''}<br>
              Avg time: ${(s.avgMs / 1000).toFixed(2)}s<br>
              Mistakes: ${s.mistakes}
            </div>
          </div>
        `).join('')}
      </div>
      ${slowestOp
        ? `<p class="feedback-insight">Your slowest operation is <strong>${escapeHtml(slowestOp.op)}</strong> &mdash; consider focused practice on it.</p>`
        : ''
      }
    </div>
  `;
}

// Mental-math tips live in js/tips.js, shared with practice mode.

// Rebuild the run graph in the new palette when the theme is toggled.
window.addEventListener('zt-theme-change', () => {
  if (loadedSession) renderRunGraph(loadedSession);
});
