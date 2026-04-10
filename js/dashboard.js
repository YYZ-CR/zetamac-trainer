document.addEventListener('DOMContentLoaded', async () => {
  createAuthModal();

  let user = null;
  try {
    user = await initAuth({
      onAuthChange: (u, event) => {
        if (event === 'SIGNED_IN')  window.location.reload();
        if (event === 'SIGNED_OUT') window.location.reload();
      },
    });
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
    getUserSessions(user.id, 30),
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
  const scores  = sessions.map(s => s.score);
  const best    = Math.max(...scores);
  const recent  = scores.slice(0, 10);
  const avg10   = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);

  document.getElementById('stat-best').textContent  = best;
  document.getElementById('stat-avg').textContent   = avg10;
  document.getElementById('stat-games').textContent = sessions.length;
  document.getElementById('stats-row').style.display = 'flex';

  // ── Chart ─────────────────────────────────────────────────
  // Show oldest-to-newest (up to 20 games)
  const chartSessions = sessions.slice(0, 20).reverse();
  document.getElementById('chart-panel').style.display = 'block';
  renderChart(chartSessions);

  // ── Recent games ──────────────────────────────────────────
  document.getElementById('games-panel').style.display = 'block';
  renderRecentGames(sessions.slice(0, 15));
});

function renderChart(sessions) {
  const ctx = document.getElementById('score-chart').getContext('2d');

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: sessions.map(s => {
        const d = new Date(s.created_at);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }),
      datasets: [{
        label: 'Score',
        data: sessions.map(s => s.score),
        borderColor: '#333',
        backgroundColor: 'rgba(50,50,50,0.06)',
        tension: 0.2,
        pointRadius: 4,
        pointBackgroundColor: '#333',
        pointHoverRadius: 6,
        fill: true,
      }],
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
          ticks: { font: { size: 11 }, maxTicksLimit: 10 },
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
    // Store session key in localStorage before navigating so query-stripping servers still work
    tr.querySelector('.view-session-link').addEventListener('click', function (e) {
      e.preventDefault();
      localStorage.setItem('zt_pending_session', this.dataset.session);
      window.location.href = this.href;
    });
    tbody.appendChild(tr);
  }
}
