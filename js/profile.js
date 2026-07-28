// Public profile page — profile.html?u=<username>
//
// Everything on this page comes from the single get_public_profile RPC (see
// docs/social-api.md); the tables behind it are owner-only. The page is a
// public URL, so the username and every figure derived from a profile is
// user-controlled and must be escaped before it reaches innerHTML.

// PERCENTILE_MIN_PLAYERS and percentilePercent() come from js/util.js, which
// every page loads. The results page shows the same figure, and a threshold
// kept in two files drifts — invisibly, until someone compares two pages.

// Percentile is shown for one duration only. 120s is the standard Zetamac run
// and by far the most played, so it is the one comparison worth making.
const PERCENTILE_DURATION = 120;

// How many recent games the bests panel averages over, matching the dashboard.
const PROFILE_AVG_WINDOW = 10;

// STAT_DURATIONS, STAT_OP_ORDER, numberOrNull, formatCount, formatPercent,
// formatSeconds, renderStatStrip, renderBestCards and renderOpBars come from
// js/stats.js, which dashboard.html loads too. This page and the dashboard
// show the same record of the same account, so they render it with the same
// code rather than with two copies that drift.

// Kept so the chart can be rebuilt when the theme changes — Chart.js resolves
// colours once, at construction.
let profileChart   = null;
let profileHistory = [];

// Which profile to show. Three URL shapes reach this page:
//
//   /profile.html?u=name   direct, and the only shape that works locally
//   /@name                 vercel.json rewrite
//   /u/name                vercel.json rewrite
//
// The rewrites are resolved server-side, so for those two the browser URL
// keeps the original path and location.search is EMPTY — reading the query
// string alone would render "no profile requested" for every clean URL.
function readUsernameFromUrl() {
  const q = new URLSearchParams(window.location.search).get('u');
  if (q && q.trim()) return q.trim();

  // decodeURIComponent throws on a malformed escape (a bare '%' in the path),
  // which would otherwise take the whole page down before it renders.
  const m = window.location.pathname.match(/^\/(?:@|u\/)([^/]+)\/?$/);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).trim();
  } catch (_) {
    return m[1].trim();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const topBar = document.getElementById('top-bar');

  // The auth bar is decoration here: a broken client must not stop the page
  // from rendering a profile (or a readable failure).
  try {
    createAuthModal();
    let user = null;
    try {
      user = await initAuth({ onAuthChange: (u) => renderAuthBar(u, topBar) });
    } catch (e) { console.warn('initAuth failed:', e); }
    renderAuthBar(user, topBar);
  } catch (e) {
    console.warn('auth bar unavailable:', e);
    if (typeof renderThemeToggle === 'function') renderThemeToggle(topBar);
  }

  const username = readUsernameFromUrl();

  if (!username) {
    showNotice(`
      <strong>No profile requested.</strong>
      <p>Profile links look like <code>profile.html?u=username</code>.</p>
      <p><a href="settings.html">Go to Settings</a> to find and publish your own.</p>
    `);
    return;
  }

  // ── Load ──────────────────────────────────────────────────
  let profile = null;
  let loadError = null;

  if (typeof getPublicProfile !== 'function') {
    // db.js did not load at all (blocked CDN, file missing).
    loadError = 'db.js unavailable';
  } else {
    try {
      profile = await getPublicProfile(username);
      // Set by db.js when the call failed for an infrastructure reason rather
      // than because there is no such profile. The two need different words.
      if (!profile && typeof lastSocialError !== 'undefined' && lastSocialError) {
        loadError = lastSocialError;
      }
    } catch (e) {
      console.warn('getPublicProfile threw:', e);
      loadError = String(e?.message ?? e);
    }
  }

  if (loadError) {
    console.warn('profile load failed:', loadError);
    showNotice(`
      <strong>Profiles aren't available right now.</strong>
      <p>The page couldn't reach the database. This is usually temporary — try again in a moment.</p>
      <p><a href="index.html">Play a game</a> · <a href="dashboard.html">Dashboard</a></p>
    `);
    return;
  }

  if (!profile) {
    // Deliberately one message for both cases: saying which would tell an
    // anonymous visitor that a private account exists under that name.
    showNotice(`
      <strong>This profile is private or doesn't exist.</strong>
      <p>Nothing to see here.</p>
      <p><a href="index.html">Play a game</a> · <a href="dashboard.html">Dashboard</a></p>
    `);
    return;
  }

  try {
    await renderProfile(profile);
  } catch (e) {
    console.error('renderProfile failed:', e);
    showNotice(`
      <strong>This profile couldn't be displayed.</strong>
      <p>Something went wrong rendering it. Reloading may help.</p>
    `);
  }
});

// ── Shell helpers ─────────────────────────────────────────────

// `html` is always a literal from this file — never interpolated profile data.
function showNotice(html) {
  hide('profile-loading');
  hide('profile-content');
  const el = document.getElementById('profile-notice');
  el.innerHTML = html;
  el.style.display = 'block';
}

function show(id, display = 'block') {
  const el = document.getElementById(id);
  if (el) el.style.display = display;
}

function hide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ── Render ────────────────────────────────────────────────────

async function renderProfile(profile) {
  hide('profile-loading');
  show('profile-content');

  const username = String(profile.username ?? '');
  // textContent, not innerHTML: usernames are user-controlled.
  document.getElementById('profile-name').textContent = username;
  document.title = username ? `${username} — Arithmetic Trainer` : 'Profile — Arithmetic Trainer';

  document.getElementById('profile-member-since').textContent = memberSinceText(profile.member_since);

  // The owner can always see their own profile so they can preview it before
  // publishing — say so plainly, or they'll assume everyone else sees this.
  if (profile.is_owner && !profile.is_public) {
    renderOwnerBanner();
  }

  const totalGames = Number(profile.total_games) || 0;
  if (totalGames === 0) {
    show('profile-empty');
    return;
  }

  // Same order as the dashboard: strip → bests → score over time → by
  // operation. Recent Games is the dashboard's alone.
  renderStatStrip(document.getElementById('stat-strip'), profile);
  renderBests(profile);
  renderHistoryChart(profile.history);
  renderOps(profile.ops);
  await renderPercentile(profile.bests);
}

function memberSinceText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `Member since ${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
}

function renderOwnerBanner() {
  const banner = document.getElementById('owner-banner');
  banner.innerHTML = `
    <strong>This profile is private.</strong>
    Only you can see it — anyone else opening this link is told it doesn't exist.
    <span class="banner-actions">
      <button class="btn" id="publish-btn">Make it public</button>
      <a href="settings.html">Manage in Settings</a>
    </span>
    <span class="banner-status" id="publish-status"></span>
  `;
  banner.style.display = 'block';

  document.getElementById('publish-btn').addEventListener('click', async () => {
    const btn    = document.getElementById('publish-btn');
    const status = document.getElementById('publish-status');
    btn.disabled = true;
    status.textContent = 'Publishing…';
    const ok = typeof setProfileVisibility === 'function'
      ? await setProfileVisibility(true)
      : false;
    if (ok) {
      status.textContent = 'Published. Reloading…';
      window.location.reload();
    } else {
      btn.disabled = false;
      status.textContent = "Couldn't publish — try again from Settings.";
    }
  });
}

// ── Personal bests ────────────────────────────────────────────

function renderBests(profile) {
  if (!renderBestCards(document.getElementById('best-row'), profile.bests)) return;

  // history arrives oldest-first, so the last entries are the recent games.
  const recent = Array.isArray(profile.history) ? [...profile.history].reverse() : [];
  const note   = document.getElementById('bests-note');
  if (note) note.textContent = bestsNoteText(recent.map(h => h && h.score), PROFILE_AVG_WINDOW);

  show('bests-panel');
}

async function renderPercentile(bests) {
  const source = bests && typeof bests === 'object' ? bests : {};
  const best   = numberOrNull(source[String(PERCENTILE_DURATION)] ?? source[PERCENTILE_DURATION]);
  if (best === null || typeof getScorePercentile !== 'function') return;

  let res = null;
  try {
    res = await getScorePercentile(best, PERCENTILE_DURATION);
  } catch (e) {
    console.warn('getScorePercentile threw:', e);
    return;
  }
  if (!res) return;

  // Below the threshold this returns null and the line stays hidden: a
  // percentile drawn from a dozen people is noise dressed up as a measurement.
  const pct = percentilePercent(res);
  if (pct === null) return;

  const el = document.getElementById('percentile-line');
  el.innerHTML = `Faster than <strong>${escapeHtml(pct)}%</strong> of players at ${escapeHtml(PERCENTILE_DURATION)} seconds.`;
  el.style.display = 'block';
}

// ── Per-operation breakdown ───────────────────────────────────

function renderOps(ops) {
  if (renderOpBars(document.getElementById('op-bars'), ops)) show('ops-panel');
}

// ── Score over time ───────────────────────────────────────────

function renderHistoryChart(history) {
  const rows = Array.isArray(history)
    ? history.filter(h => h && numberOrNull(h.score) !== null)
    : [];
  // One point is not a line, and Chart.js may not have loaded at all.
  if (rows.length < 2 || typeof Chart === 'undefined') return;

  profileHistory = rows;
  show('chart-panel');
  drawHistoryChart();

  // Chart.js resolves colours at construction, so rebuild on theme change.
  window.addEventListener('zt-theme-change', () => {
    if (profileChart) { profileChart.destroy(); profileChart = null; }
    drawHistoryChart();
  });
}

function drawHistoryChart() {
  const canvas = document.getElementById('profile-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const rows   = profileHistory;
  const n      = rows.length;
  const scores = rows.map(r => Number(r.score));
  const labels = rows.map(r => formatHistoryDate(r.d));
  const pointRadius = n > 100 ? 0 : n > 40 ? 2 : 4;

  profileChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Score',
        data: scores,
        borderColor: themeColor('--c-chart-line', '#333'),
        backgroundColor: themeColor('--c-chart-fill', 'rgba(50,50,50,0.06)'),
        tension: 0.2,
        pointRadius,
        pointBackgroundColor: themeColor('--c-chart-line', '#333'),
        pointHoverRadius: pointRadius > 0 ? pointRadius + 2 : 3,
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
            // Scores are only comparable within a duration, so never show one
            // without saying which run length it came from.
            label: ctx => {
              const row = rows[ctx.dataIndex] || {};
              const dur = numberOrNull(row.duration);
              return dur === null
                ? ` Score: ${ctx.parsed.y}`
                : ` Score: ${ctx.parsed.y} (${dur}s)`;
            },
          },
        },
      },
      scales: {
        x: {
          grid:  { color: themeColor('--c-rule', '#eee') },
          ticks: { font: { size: 11 }, maxTicksLimit: n > 60 ? 8 : 12 },
        },
        y: {
          beginAtZero: false,
          grid:  { color: themeColor('--c-rule', '#eee') },
          ticks: { font: { size: 11 }, precision: 0 },
        },
      },
    },
  });
}

// ── Formatting ────────────────────────────────────────────────
// numberOrNull, formatCount, formatPercent and formatSeconds live in
// js/stats.js — the dashboard needs the same four.

function formatHistoryDate(d) {
  if (!d) return '';
  // "2026-07-21" parses as UTC midnight; pinning the time keeps the label from
  // sliding a day backwards for viewers west of Greenwich.
  const date = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
