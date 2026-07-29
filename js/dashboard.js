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

  // Copy a link to your own /@name. renderShareControl (js/util.js) draws
  // nothing without a username, which is the state directly below this line.
  //
  // is_public arrives with supabase/social.sql; before that migration the key
  // is simply absent, and "absent" is correctly private here — with no
  // get_public_profile there is nobody the link works for but its owner.
  renderShareControl({
    username:  profile?.username,
    isPrivate: profile?.is_public !== true,
  });

  // An account with no profile row is a dead end everywhere else in the app:
  // the register flow already says "try logging in and setting it again", but
  // until now there was nowhere to set it. This is that place.
  if (!profile?.username) renderUsernameClaim(user);

  if (sessions.length === 0) {
    document.getElementById('games-panel').style.display = 'block';
    document.getElementById('games-tbody').innerHTML =
      '<tr><td colspan="5" class="no-data">No games yet. <a href="index.html">Play one!</a></td></tr>';
    return;
  }

  // ── The record: strip, bests, operations ──────────────────
  // Preferred source is get_public_profile, the same payload profile.html
  // renders — its figures are all-time and computed by the database, and one
  // source for both pages is what stops your dashboard and your public page
  // disagreeing about how many games you have played.
  //
  // It needs a username to look the profile up by, and it needs
  // supabase/social.sql to be applied. Neither is guaranteed: registration
  // with email confirmation can leave an account with no profile row at all,
  // and migrations here are applied by hand. So the same shape is computed
  // from the sessions already in memory when the call cannot be made or comes
  // back empty — a strip of five em-dashes would be a failed load pretending
  // to be a record.
  let record = null;
  if (profile?.username && typeof getPublicProfile === 'function') {
    try {
      record = await getPublicProfile(profile.username);
    } catch (e) {
      console.warn('getPublicProfile failed on the dashboard:', e);
    }
  }
  const fromServer = !!record;
  if (!record) record = recordFromSessions(sessions, trueTotal);

  renderStatStrip(document.getElementById('stat-strip'), record);

  // The note under the strip carries the recent-form average — the figure the
  // Personal Bests panel used to show in its head — and then any caveat about
  // what the figures cover, so a window is never quietly presented as all
  // time. Sentences, joined, rather than a row of orphaned labels.
  const note = document.getElementById('stats-note');
  if (note) {
    const parts = [];
    const avg = recentAverageText(sessions.map(s => s.score), DASH_AVG_WINDOW);
    if (avg) parts.push(`${avg}.`);
    if (!fromServer) {
      parts.push('These figures are computed from the games loaded on this page.');
    }
    if (truncated) {
      parts.push(
        `The chart and the table cover your most recent ${sessions.length} games of ${trueTotal}.`
      );
    }
    note.textContent = parts.join(' ');
    note.style.display = parts.length ? 'block' : 'none';
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

  // ── By operation ──────────────────────────────────────────
  // Between the chart and the table, in the same place as on the public page.
  if (renderOpBars(document.getElementById('op-bars'), record.ops)) {
    document.getElementById('ops-panel').style.display = 'block';
  }

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

// ── The record, computed locally ──────────────────────────────
// The fallback for the strip and the operation bars when
// get_public_profile cannot be reached — no username yet, or
// supabase/social.sql not applied on this deployment. It returns the same
// shape that function does, so nothing downstream has to know which source it
// got. See docs/social-api.md for the contract.
//
// Two honest differences from the server's version, both stated in the note
// under the strip: every figure except total_games covers the sessions this
// page loaded rather than all time, and the days are the caller's own UTC
// days derived from created_at.

const DASH_AVG_WINDOW = 10;   // games behind "Avg last 10"
const DASH_OPS_WINDOW = 200;  // sessions the operation bars average over

function recordFromSessions(sessions, totalGames) {
  let questions = 0;
  let mistakes  = 0;
  const bests  = {};
  const played = {};   // games per duration — see games_by_duration below
  const days   = new Set();

  for (const s of sessions) {
    const qs = Array.isArray(s.questions) ? s.questions : [];
    questions += qs.length;
    for (const q of qs) {
      // Total by construction, exactly as the SQL is: anything that is not
      // literal true — false, absent, the wrong type — is not a mistake.
      if (q && q.hadMistake === true) mistakes++;
    }

    const duration = numberOrNull(s.duration_seconds);
    const score    = numberOrNull(s.score);
    if (duration !== null) played[String(duration)] = (played[String(duration)] || 0) + 1;

    if (duration !== null && score !== null) {
      const key = String(duration);
      if (!(key in bests) || score > bests[key]) bests[key] = score;
    }

    const day = utcDayOf(s.created_at);
    if (day) days.add(day);
  }

  return {
    total_games:     totalGames,
    total_questions: questions,
    // 0/0 is not 1.0, it is unknown. A flattering 100% would be a lie.
    accuracy:        questions > 0 ? 1 - mistakes / questions : null,
    days_practiced:  days.size,
    streak:          streakFromDays(days),
    bests,
    // Not part of the get_public_profile payload: the server's own answer to
    // "which duration is played most" is the `duration` on each history row,
    // and this path has no history. renderStatStrip prefers this key when it
    // is present and falls back to counting history when it is not, so the
    // Best tile picks a duration on both paths.
    games_by_duration: played,
    ops:             opsFromSessions(sessions),
  };
}

// "YYYY-MM-DD" in UTC, matching get_public_profile, which counts UTC calendar
// days. Doing this in local time would put a late-evening game in tomorrow for
// half the world and disagree with the public page for the same account.
function utcDayOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// The run of consecutive days ending today or yesterday. Yesterday counts
// because somebody mid-streak has not necessarily played yet today and should
// not be told the streak is over — the same rule the SQL applies.
function streakFromDays(days) {
  if (!days.size) return 0;

  const today     = new Date();
  const todayUtc  = today.toISOString().slice(0, 10);
  const yesterday = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1
  )).toISOString().slice(0, 10);

  let cursor;
  if (days.has(todayUtc))          cursor = todayUtc;
  else if (days.has(yesterday))    cursor = yesterday;
  else                             return 0;

  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    const d = new Date(cursor + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return streak;
}

// Per-operation averages over the most recent DASH_OPS_WINDOW sessions —
// the same bound get_public_profile uses, so the two pages average over the
// same window rather than one of them quietly covering more history.
// getUserSessions returns newest-first, so the slice is the recent end.
function opsFromSessions(sessions) {
  const acc = {};

  for (const s of sessions.slice(0, DASH_OPS_WINDOW)) {
    const qs = Array.isArray(s.questions) ? s.questions : [];
    for (const q of qs) {
      if (!q || typeof q !== 'object') continue;
      // Whitelisted, like the SQL: `operation` is written by the client and
      // an unknown value must be dropped rather than rendered as a row.
      if (!STAT_OP_ORDER.includes(q.operation)) continue;

      const a = acc[q.operation] || (acc[q.operation] = { n: 0, mistakes: 0, timed: 0, ms: 0 });
      a.n++;
      if (q.hadMistake === true) a.mistakes++;
      const ms = numberOrNull(q.timeMs);
      if (ms !== null) { a.ms += ms; a.timed++; }
    }
  }

  const ops = {};
  for (const [name, a] of Object.entries(acc)) {
    // No timed question means no average, and a bar with no length is worse
    // than an absent row.
    if (!a.timed) continue;
    ops[name] = {
      avg_ms:   Math.round(a.ms / a.timed),
      count:    a.n,
      accuracy: 1 - a.mistakes / a.n,
    };
  }
  return ops;
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
