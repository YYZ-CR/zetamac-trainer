document.addEventListener('DOMContentLoaded', async () => {
  createAuthModal();

  let user = null;
  let prevUserId = null;
  try {
    user = await initAuth({
      onAuthChange: (u) => {
        const newId = u?.id ?? null;
        if (newId !== prevUserId) {
          prevUserId = newId;
          window.location.reload();
        }
      },
    });
    prevUserId = user?.id ?? null;
  } catch (e) { console.warn('initAuth failed:', e); }

  // Build the top bar manually (Play instead of Dashboard)
  const topBar = document.getElementById('top-bar');
  if (user) {
    topBar.innerHTML = `
      <a href="index.html">Play</a>
      <span class="sep">|</span>
      <button class="link-btn" id="logout-btn">Log out</button>
    `;
    document.getElementById('logout-btn').addEventListener('click', () => logout());
  } else {
    topBar.innerHTML = `
      <a href="index.html">Play</a>
      <span class="sep">|</span>
      <button class="link-btn" id="login-btn">Log in</button>
      <span class="sep">|</span>
      <button class="link-btn" id="register-btn">Register</button>
    `;
    document.getElementById('login-btn').addEventListener('click', () => showAuthModal('login'));
    document.getElementById('register-btn').addEventListener('click', () => showAuthModal('register'));
  }

  if (!user) {
    document.getElementById('auth-prompt').style.display = 'block';
    document.getElementById('prompt-login-btn').addEventListener('click', () => showAuthModal('login'));
    document.getElementById('prompt-register-btn').addEventListener('click', () => showAuthModal('register'));
    return;
  }

  // ── Load data ─────────────────────────────────────────────
  const [profile, sessions] = await Promise.all([
    getProfile(user.id),
    getUserSessions(user.id, 500),
  ]);

  document.getElementById('username-display').textContent =
    profile?.username ? `Logged in as ${profile.username}` : user.email;

  if (sessions.length === 0) {
    document.getElementById('games-panel').style.display = 'block';
    document.getElementById('games-tbody').innerHTML =
      '<tr><td colspan="5" class="no-data">No games yet. <a href="index.html">Play one!</a></td></tr>';
    return;
  }

  // ── Stats ─────────────────────────────────────────────────
  const scores = sessions.map(s => s.score);
  const best   = Math.max(...scores);
  const avg10  = Math.round(scores.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, scores.length));

  document.getElementById('stat-best').textContent  = best;
  document.getElementById('stat-avg').textContent   = avg10;
  document.getElementById('stat-games').textContent = sessions.length;
  document.getElementById('stats-row').style.display = 'flex';

  // ── Chart ─────────────────────────────────────────────────
  document.getElementById('chart-panel').style.display = 'block';
  let chartInstance = null;
  let currentSlice  = [];

  function redrawChart() {
    const n      = currentSlice.length;
    const scores = currentSlice.map(s => s.score);
    const labels = currentSlice.map(s => {
      const d = new Date(s.created_at);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    if (!chartInstance) {
      chartInstance = renderChart(labels, scores, n);
      return;
    }

    // Update existing chart in-place to avoid destroy/recreate canvas bugs
    const pr = n > 100 ? 0 : n > 40 ? 2 : 4;
    chartInstance.data.labels                          = labels;
    chartInstance.data.datasets[0].data               = scores;
    chartInstance.data.datasets[0].pointRadius        = pr;
    chartInstance.data.datasets[0].pointHoverRadius   = pr > 0 ? pr + 2 : 3;
    chartInstance.data.datasets[1].data               = calcTrendline(scores);
    chartInstance.options.scales.x.ticks.maxTicksLimit = n > 60 ? 8 : 12;
    chartInstance.update();
  }

  function setChartRange(range) {
    const slice  = range === 'all' ? sessions : sessions.slice(0, range);
    currentSlice = [...slice].reverse(); // oldest → newest
    redrawChart();
    document.querySelectorAll('.chart-range-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.range === String(range));
    });
  }

  document.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.range;
      setChartRange(r === 'all' ? 'all' : parseInt(r));
    });
  });

  setChartRange(20);

  // ── Recent games ──────────────────────────────────────────
  document.getElementById('games-panel').style.display = 'block';
  let currentPage = 0;
  let pageSize    = 20;

  function renderPage() {
    const start       = currentPage * pageSize;
    const pageSessions = sessions.slice(start, start + pageSize);
    renderRecentGames(pageSessions);

    const totalPages = Math.ceil(sessions.length / pageSize);
    document.getElementById('page-info').textContent =
      `Page ${currentPage + 1} of ${totalPages} (${sessions.length} total)`;
    document.getElementById('prev-btn').disabled = currentPage === 0;
    document.getElementById('next-btn').disabled = currentPage >= totalPages - 1;
  }

  document.getElementById('page-size-select').addEventListener('change', e => {
    pageSize    = parseInt(e.target.value);
    currentPage = 0;
    renderPage();
  });

  document.getElementById('prev-btn').addEventListener('click', () => {
    if (currentPage > 0) { currentPage--; renderPage(); }
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    if (currentPage < Math.ceil(sessions.length / pageSize) - 1) {
      currentPage++;
      renderPage();
    }
  });

  renderPage();
});

// ── Chart ─────────────────────────────────────────────────────

// Solve a linear system A·x = b (A is n×n, b is length n) via Gaussian
// elimination with partial pivoting. Returns null if singular.
function solveLinearSystem(A, b) {
  const n = A.length;
  // Work on copies so callers' arrays stay intact.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Partial pivot: move the row with the largest |value| into place.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null; // singular
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Least-squares fit of y = c0·b0(x) + c1·b1(x) + ... for the given basis
// functions. Returns { predict, rss } or null if it can't be solved.
function fitLinearModel(xs, ys, basis) {
  const n = xs.length;
  const k = basis.length;
  // Design matrix rows: B[i] = [b0(xi), b1(xi), ...]
  const B = xs.map(x => basis.map(fn => fn(x)));
  // Normal equations: (BᵀB) c = Bᵀy
  const BtB = Array.from({ length: k }, () => new Array(k).fill(0));
  const Bty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Bty[a] += B[i][a] * ys[i];
      for (let bIdx = 0; bIdx < k; bIdx++) BtB[a][bIdx] += B[i][a] * B[i][bIdx];
    }
  }
  const coeffs = solveLinearSystem(BtB, Bty);
  if (!coeffs || coeffs.some(c => !isFinite(c))) return null;

  const predict = x => basis.reduce((sum, fn, idx) => sum + coeffs[idx] * fn(x), 0);
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - predict(xs[i]);
    rss += e * e;
  }
  return { predict, rss, k };
}

// Fit several candidate curve shapes and return the predicted values from the
// model with the best adjusted R² (penalises models for using more params, so
// the quadratic doesn't win just by having an extra degree of freedom).
function calcTrendline(scores) {
  const n = scores.length;
  if (n < 2) return scores.map(() => scores[0]);

  // x starts at 1 so log/sqrt are well defined and meaningful.
  const xs = scores.map((_, i) => i + 1);
  const ys = scores;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let tss = 0;
  for (const y of ys) tss += (y - meanY) ** 2;

  const candidates = [
    { name: 'linear',      basis: [() => 1, x => x] },
    { name: 'logarithmic', basis: [() => 1, x => Math.log(x)] },
    { name: 'sqrt',        basis: [() => 1, x => Math.sqrt(x)] },
    { name: 'quadratic',   basis: [() => 1, x => x, x => x * x] },
  ];

  let best = null;
  for (const cand of candidates) {
    const fit = fitLinearModel(xs, ys, cand.basis);
    if (!fit) continue;
    // Adjusted R² = 1 - (RSS/(n-k)) / (TSS/(n-1)); needs n > k for a valid value.
    const adjR2 = tss === 0 || n <= fit.k
      ? -Infinity
      : 1 - (fit.rss / (n - fit.k)) / (tss / (n - 1));
    if (!best || adjR2 > best.adjR2) best = { ...cand, fit, adjR2 };
  }

  if (!best) { // fallback: flat line at the mean
    return ys.map(() => Math.round(meanY * 10) / 10);
  }
  return xs.map(x => Math.round(best.fit.predict(x) * 10) / 10);
}

function renderChart(labels, scores, n) {
  const ctx         = document.getElementById('score-chart').getContext('2d');
  const pointRadius = n > 100 ? 0 : n > 40 ? 2 : 4;
  const maxTicks    = n > 60  ? 8 : 12;

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Score',
          data: scores,
          borderColor: '#333',
          backgroundColor: 'rgba(50,50,50,0.06)',
          tension: 0.2,
          pointRadius,
          pointBackgroundColor: '#333',
          pointHoverRadius: pointRadius > 0 ? pointRadius + 2 : 3,
          fill: true,
          order: 1, // draw beneath the trend line
        },
        {
          label: 'Trend',
          data: calcTrendline(scores),
          borderColor: '#c44',
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: false,
          tension: 0,
          order: 0, // draw on top of the score line
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` Score: ${ctx.parsed.y}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: '#eee' },
          ticks: { font: { size: 11 }, maxTicksLimit: maxTicks },
        },
        y: {
          beginAtZero: false,
          grid: { color: '#eee' },
          ticks: { font: { size: 11 }, precision: 0 },
        },
      },
    },
  });
}

// ── Recent games table ────────────────────────────────────────

function renderRecentGames(sessions) {
  const tbody = document.getElementById('games-tbody');
  tbody.innerHTML = '';

  for (const s of sessions) {
    const d       = new Date(s.created_at);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const qs      = s.questions || [];
    const mistakes = qs.filter(q => q.hadMistake).length;
    const acc = qs.length > 0
      ? Math.round(((qs.length - mistakes) / qs.length) * 100) + '%'
      : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${dateStr}</td>
      <td><strong>${s.score}</strong></td>
      <td>${s.duration_seconds}s</td>
      <td>${acc}</td>
      <td><a href="results.html?session=${s.session_key}" class="view-session-link" data-session="${s.session_key}">View</a></td>
    `;
    tr.querySelector('.view-session-link').addEventListener('click', function (e) {
      e.preventDefault();
      localStorage.setItem('zt_pending_session', this.dataset.session);
      window.location.href = this.href;
    });
    tbody.appendChild(tr);
  }
}
