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

  renderAuthBar(user, document.getElementById('top-bar'));

  if (!user) {
    document.getElementById('auth-prompt').style.display = 'block';
    document.getElementById('prompt-login-btn').addEventListener('click', () => showAuthModal('login'));
    document.getElementById('prompt-register-btn').addEventListener('click', () => showAuthModal('register'));
    return;
  }

  // ── Load data ─────────────────────────────────────────────
  const SESSION_WINDOW = 500;   // rows pulled for the chart and table
  const [profile, sessions, totalGames] = await Promise.all([
    getProfile(user.id),
    getUserSessions(user.id, SESSION_WINDOW),
    countUserSessions(user.id),
  ]);
  // countUserSessions returns null when the client is unavailable; fall back to
  // what we actually loaded rather than showing nothing.
  const trueTotal = typeof totalGames === 'number' ? totalGames : sessions.length;
  const truncated = trueTotal > sessions.length;

  document.getElementById('username-display').textContent =
    profile?.username ? `Logged in as ${profile.username}` : user.email;

  // An account with no profile row is a dead end everywhere else in the app:
  // the register flow already says "try logging in and setting it again", but
  // until now there was nowhere to set it. This is that place.
  if (!profile?.username) renderUsernameClaim(user);

  // Before the empty-state return below: a user with no games still has a
  // profile to publish, and the link is how anyone finds it.
  renderProfilePanel(profile);

  // Same reason — somebody with no games can still be in a league, and the
  // league is a reason to go and play one. Not awaited: a slow or absent
  // leagues migration must not hold up the rest of the dashboard.
  renderDashboardLeagues();

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
  document.getElementById('stat-games').textContent = trueTotal;
  document.getElementById('stats-row').style.display = 'flex';

  // Be explicit when the other figures only cover the loaded window, instead
  // of quietly presenting them as all-time.
  const note = document.getElementById('stats-note');
  if (note) {
    if (truncated) {
      note.textContent =
        `Personal best, the chart and the table cover your most recent ${sessions.length} games of ${trueTotal}.`;
      note.style.display = 'block';
    } else {
      note.style.display = 'none';
    }
  }

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

  // Chart.js resolves colours at construction, so rebuild on theme change.
  window.addEventListener('zt-theme-change', () => {
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    redrawChart();
  });

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

// ── Public profile controls ───────────────────────────────────
// The dashboard is where a profile is published, unpublished and shared. It
// needs a profile row to have anything to say: a signed-in user without one
// has no username, so there is no URL to show and nothing to publish.

function renderProfilePanel(profile) {
  const panel = document.getElementById('profile-panel');
  if (!panel || !profile || !profile.username) return;

  const username = String(profile.username);

  // vercel.json rewrites /@name to profile.html?u=name, so /@name is the form
  // worth showing — but the href must be the real query-string URL, or the
  // link is broken everywhere except production (there are no rewrites under
  // a plain static server).
  const href = 'profile.html?u=' + encodeURIComponent(username);
  const link = document.getElementById('profile-link');
  link.setAttribute('href', href);
  // textContent, not innerHTML: the username is user-controlled.
  link.textContent = '/@' + username;

  // Absolute, because the copied form is going somewhere else entirely.
  const absoluteUrl = new URL(href, window.location.href).toString();

  const check  = document.getElementById('profile-public-check');
  const badge  = document.getElementById('profile-visibility-badge');
  const note   = document.getElementById('profile-visibility-note');
  const status = document.getElementById('profile-visibility-status');

  // profiles.is_public arrives with social.sql. Until that migration is
  // applied the column is simply absent from the row, and `undefined` would
  // read as "private" from a control that could never make it public. Offer
  // the link, disable the toggle, and say which of the two it is.
  const hasVisibility = Object.prototype.hasOwnProperty.call(profile, 'is_public');
  let isPublic = hasVisibility && !!profile.is_public;

  check.checked  = isPublic;
  check.disabled = !hasVisibility;

  function describe() {
    if (!hasVisibility) {
      badge.textContent = 'Unavailable';
      note.textContent  =
        'Publishing is unavailable on this deployment — the database is missing the ' +
        'visibility column. Your profile stays private, and only you can open this link.';
      return;
    }
    badge.textContent = isPublic ? 'Public' : 'Private';
    note.textContent  = isPublic
      ? 'Anyone with this link can see your stats.'
      : 'This link only works for you while your profile is private — everyone else ' +
        'opening it is told the profile does not exist.';
  }
  describe();

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'profile-visibility-status' + (kind ? ' is-' + kind : '');
  }

  check.addEventListener('change', async () => {
    if (!hasVisibility) return;

    const wanted   = check.checked;
    const previous = isPublic;

    // Disabled for the whole round trip: a fast double-click would otherwise
    // put two updates in flight and let whichever landed last decide the
    // database, while the checkbox showed whichever was clicked last.
    check.disabled = true;
    setStatus(wanted ? 'Publishing…' : 'Making private…', 'pending');

    const ok = typeof setProfileVisibility === 'function'
      ? await setProfileVisibility(wanted)
      : false;

    check.disabled = false;

    if (ok) {
      isPublic = wanted;
      setStatus(wanted
        ? 'Your profile is now public.'
        : 'Your profile is now private.', 'ok');
    } else {
      // Never leave the box claiming a state the database does not have.
      check.checked = previous;
      setStatus(`Couldn't save that — your profile is still ${previous ? 'public' : 'private'}. Try again.`, 'error');
    }
    describe();
  });

  const copyBtn = document.getElementById('copy-profile-link-btn');
  copyBtn.addEventListener('click', () => {
    const done = () => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
    };
    // navigator.clipboard is undefined outside a secure context, so this has
    // to survive the property being missing as well as the promise rejecting
    // — over plain http the unguarded call throws instead of failing.
    let p = null;
    try { p = navigator.clipboard?.writeText(absoluteUrl); } catch (_) { p = null; }
    if (p && typeof p.then === 'function') {
      p.then(done).catch(() => { prompt('Copy this link:', absoluteUrl); });
    } else {
      prompt('Copy this link:', absoluteUrl);
    }
  });

  panel.style.display = 'block';
}

// ── Private leagues, compactly ────────────────────────────────
// A list of doors, nothing more: names, sizes, and a link to leagues.html,
// which owns every other league state. The boards themselves are not rendered
// here — one board is a table, and five would be the whole dashboard.
//
// The panel stays hidden when getMyLeagues() fails. supabase/leagues.sql is
// applied by hand, so "leagues are not deployed on this project" is a normal
// state for this page to be in, and it is not an error the owner of the
// dashboard can do anything about.

const DASH_LEAGUE_LIMIT = 5;

async function renderDashboardLeagues() {
  const panel = document.getElementById('leagues-panel');
  const body  = document.getElementById('leagues-panel-body');
  const note  = document.getElementById('leagues-panel-note');
  if (!panel || !body || typeof getMyLeagues !== 'function') return;

  let leagues = null;
  try {
    leagues = await getMyLeagues();
  } catch (e) {
    console.warn('renderDashboardLeagues:', e);
    return;
  }

  // null is a failed call; [] is "in no leagues" and has its own copy.
  if (leagues === null) return;

  if (!leagues.length) {
    if (note) note.textContent = '';
    body.innerHTML = `
      <p class="dash-league-empty">
        You're not in a league yet. A league is a private leaderboard over the
        daily — same questions, same day — for people you actually know.
      </p>
      <p class="dash-league-more"><a href="leagues.html">Create one or join with a code</a></p>
    `;
    panel.style.display = 'block';
    return;
  }

  if (note) note.textContent = leagues.length === 1 ? '1 league' : leagues.length + ' leagues';

  const shown = leagues.slice(0, DASH_LEAGUE_LIMIT);
  const items = shown.map(l => {
    const key   = String(l.league_key ?? '');
    const name  = String(l.name ?? 'Untitled league');
    const n     = Number(l.member_count);
    const count = Number.isFinite(n) ? (n === 1 ? '1 member' : n + ' members') : '';
    const owner = l.is_owner === true ? ' · you own it' : '';
    // League names are user-controlled — one person names a thing that
    // everybody else's dashboard then renders.
    return `
      <li class="dash-league-item">
        <a class="dash-league-name" href="leagues.html?l=${escapeHtml(encodeURIComponent(key))}">${escapeHtml(name)}</a>
        <span class="dash-league-meta">${escapeHtml(count + owner)}</span>
      </li>
    `;
  }).join('');

  const more = leagues.length > shown.length
    ? `<p class="dash-league-more"><a href="leagues.html">All ${escapeHtml(leagues.length)} leagues</a></p>`
    : `<p class="dash-league-more"><a href="leagues.html">Manage your leagues</a></p>`;

  body.innerHTML = `<ul class="dash-league-list">${items}</ul>${more}`;
  panel.style.display = 'block';
}

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
          borderColor: themeColor('--c-chart-line', '#333'),
          backgroundColor: themeColor('--c-chart-fill', 'rgba(50,50,50,0.06)'),
          tension: 0.2,
          pointRadius,
          pointBackgroundColor: themeColor('--c-chart-line', '#333'),
          pointHoverRadius: pointRadius > 0 ? pointRadius + 2 : 3,
          fill: true,
          order: 1, // draw beneath the trend line
        },
        {
          label: 'Trend',
          data: calcTrendline(scores),
          borderColor: themeColor('--c-danger', '#c44'),
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
          grid: { color: themeColor('--c-rule', '#eee') },
          ticks: { font: { size: 11 }, maxTicksLimit: maxTicks },
        },
        y: {
          beginAtZero: false,
          grid: { color: themeColor('--c-rule', '#eee') },
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
    const key = encodeURIComponent(s.session_key);
    tr.innerHTML = `
      <td>${escapeHtml(dateStr)}</td>
      <td><strong>${escapeHtml(s.score)}</strong></td>
      <td>${escapeHtml(s.duration_seconds)}s</td>
      <td>${escapeHtml(acc)}</td>
      <td><a href="results.html?session=${key}" class="view-session-link" data-session="${escapeHtml(s.session_key)}">View</a></td>
    `;
    tr.querySelector('.view-session-link').addEventListener('click', function (e) {
      e.preventDefault();
      localStorage.setItem('zt_pending_session', this.dataset.session);
      window.location.href = this.href;
    });
    tbody.appendChild(tr);
  }
}

// ── Claiming a username after the fact ────────────────────────
// Reachable when a logged-in account has no profiles row. That happens when
// registration created the auth user but the profile insert was refused —
// with email confirmation enabled, signUp returns a user and no session, so
// auth.uid() is null at that moment and the RLS check fails.
//
// The UNIQUE constraint on profiles.username is the real guard. The
// availability check here only exists to give a better message than a
// constraint violation, and it is deliberately re-checked by the insert.
function renderUsernameClaim(user) {
  const panel = document.getElementById('username-claim');
  const input = document.getElementById('claim-username');
  const btn   = document.getElementById('claim-btn');
  const err   = document.getElementById('claim-error');
  if (!panel || !input || !btn) return;

  panel.style.display = 'block';

  const fail = (msg) => {
    err.textContent = msg;
    btn.disabled = false;
    btn.textContent = 'Save';
  };

  btn.addEventListener('click', async () => {
    const username = input.value.trim();
    err.textContent = '';

    if (!username)            return fail('Pick a username first.');
    if (username.length > 40) return fail('Usernames are at most 40 characters.');

    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      if (!(await isUsernameAvailable(username))) {
        return fail(`"${username}" is taken — try another.`);
      }
      if (!(await createProfile(user.id, username))) {
        // Most likely the UNIQUE constraint, i.e. someone took it between the
        // check above and this insert. Naming that beats a generic failure.
        return fail('That username could not be saved. It may have just been taken.');
      }
      window.location.reload();
    } catch (e) {
      console.error('username claim failed:', e);
      fail('Something went wrong saving that username.');
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn.click();
  });
}
