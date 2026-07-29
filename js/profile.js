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

// How many recent games the note under the strip averages over, matching the
// dashboard.
const PROFILE_AVG_WINDOW = 10;

// STAT_OP_ORDER, numberOrNull, formatCount, formatPercent, formatSeconds,
// renderStatStrip, recentAverageText and renderOpBars come from js/stats.js,
// which dashboard.html loads too. This page and the dashboard show the same
// record of the same account, so they render it with the same code rather
// than with two copies that drift.

// Kept so the chart can be rebuilt when the theme changes — Chart.js resolves
// colours once, at construction.
//
// profileHistoryAll is every row the server sent, oldest-first;
// profileHistory is the slice the range buttons have selected and the only
// one drawHistoryChart ever reads. Keeping both means switching range is a
// re-slice of data already in hand rather than another round trip.
let profileChart      = null;
let profileHistory    = [];
let profileHistoryAll = [];

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
  const minePrivate = !!(profile.is_owner && !profile.is_public);
  if (minePrivate) {
    renderOwnerBanner();
  }

  // Copy a link to this profile's /@name. Linking the page you are looking at
  // is normal, so the button is here on somebody else's profile too — and a
  // public profile, mine or not, gets no caveat. The only link that needs one
  // is the one nobody but its owner can open, which is exactly the case the
  // banner above covers, computed once and used by both.
  renderShareControl({
    username:  username,
    isPrivate: minePrivate,
  });

  const totalGames = Number(profile.total_games) || 0;
  if (totalGames === 0) {
    show('profile-empty');
    return;
  }

  // Same panels as the dashboard, in the same order: strip → note → score
  // over time → by operation → recent games. The dashboard reads
  // game_sessions directly; everything here comes out of `history`, which
  // get_public_profile bounds to the same 500-session window the dashboard
  // pulls. Two pages showing one player must not disagree about the span.
  renderStatStrip(document.getElementById('stat-strip'), profile);
  renderRecentAverage(profile);
  renderHistoryChart(profile.history);
  renderOps(profile.ops);
  renderGamesPanel(profile.history, profile.is_owner === true);
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

// ── The note under the strip ──────────────────────────────────
// Both figures the Personal Bests panel used to carry live here now: the
// rolling average that sat in its head, and the percentile that sat at its
// foot. They are written as one sentence rather than two stacked fragments,
// because two orphaned clauses under a strip of tiles read as leftovers.
//
// The percentile arrives from a second RPC after the rest of the page has
// rendered, so the note is composed by one function that both halves call and
// that is safe to run twice.

let profileNoteAvg = '';    // "Averaging 75 across the last 3 games", or ''
let profileNotePct = null;  // whole-number percentile, or null

function renderProfileNote() {
  const el = document.getElementById('stats-note');
  if (!el) return;

  const parts = [];
  if (profileNoteAvg) parts.push(escapeHtml(profileNoteAvg));
  if (profileNotePct !== null) {
    // Capitalised only when it leads: with the average present it is the
    // second half of that sentence, not a new one.
    const faster = parts.length ? 'faster' : 'Faster';
    parts.push(
      `${faster} than <strong>${escapeHtml(profileNotePct)}%</strong> ` +
      `of players at ${escapeHtml(PERCENTILE_DURATION)} seconds`
    );
  }

  if (!parts.length) { el.style.display = 'none'; return; }
  el.innerHTML = `${parts.join(' — ')}.`;
  el.style.display = 'block';
}

function renderRecentAverage(profile) {
  // history arrives oldest-first, so the last entries are the recent games.
  const recent = Array.isArray(profile.history) ? [...profile.history].reverse() : [];
  profileNoteAvg = recentAverageText(recent.map(h => h && h.score), PROFILE_AVG_WINDOW);
  renderProfileNote();
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

  // Below the threshold this returns null and the clause stays absent: a
  // percentile drawn from a dozen people is noise dressed up as a measurement.
  const pct = percentilePercent(res);
  if (pct === null) return;

  profileNotePct = pct;
  renderProfileNote();
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

  profileHistoryAll = rows;
  show('chart-panel');

  // The same three ranges as the dashboard, wired the same way. `history` is
  // oldest-first, so a range is the LAST n rows — the dashboard slices the
  // first n of a newest-first list and reverses, which is the same window
  // written the other way round.
  document.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.range;
      setProfileChartRange(r === 'all' ? 'all' : parseInt(r, 10));
    });
  });

  setProfileChartRange(20);

  // Chart.js resolves colours at construction, so rebuild on theme change.
  window.addEventListener('zt-theme-change', () => {
    if (profileChart) { profileChart.destroy(); profileChart = null; }
    drawHistoryChart();
  });
}

function setProfileChartRange(range) {
  profileHistory = range === 'all'
    ? profileHistoryAll
    : profileHistoryAll.slice(-range);

  if (profileChart) { profileChart.destroy(); profileChart = null; }
  drawHistoryChart();

  document.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === String(range));
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

// ── Recent games ──────────────────────────────────────────────
// The dashboard's table, over the same window, drawn from `history` instead
// of from game_sessions — a visitor cannot read that table, which is the
// whole reason get_public_profile exists.
//
// The Review column is the one difference between what the owner sees and
// what a visitor sees, and it is a difference in the DATA, not in the CSS: a
// review link needs a session key, and get_public_profile emits `key` only
// when is_owner. So the column is removed outright rather than rendered
// empty — a header over four hundred blank cells is a promise the page
// cannot keep. `hasReview` is computed from the payload rather than from
// is_owner alone, so an owner whose rows somehow arrive without keys gets
// the four-column table rather than a column of broken links.
function renderGamesPanel(history, isOwner) {
  const rows = Array.isArray(history) ? history.filter(Boolean) : [];
  if (!rows.length) return;

  // Newest first, the order the table is read in. history arrives
  // oldest-first because that is the order the chart wants.
  const games     = [...rows].reverse();
  const hasReview = isOwner && games.some(g => typeof g.key === 'string' && g.key);

  const th = document.getElementById('games-review-th');
  if (th && !hasReview) th.remove();

  show('games-panel');

  let currentPage = 0;
  let pageSize    = 20;

  const renderPage = () => {
    const start = currentPage * pageSize;
    renderGamesRows(games.slice(start, start + pageSize), hasReview);

    // Math.max(1, …): an empty page count would render "Page 1 of 0".
    const totalPages = Math.max(1, Math.ceil(games.length / pageSize));
    document.getElementById('page-info').textContent =
      `Page ${currentPage + 1} of ${totalPages} (${games.length} total)`;
    document.getElementById('prev-btn').disabled = currentPage === 0;
    document.getElementById('next-btn').disabled = currentPage >= totalPages - 1;
  };

  document.getElementById('page-size-select').addEventListener('change', e => {
    pageSize    = parseInt(e.target.value, 10) || 20;
    currentPage = 0;
    renderPage();
  });

  document.getElementById('prev-btn').addEventListener('click', () => {
    if (currentPage > 0) { currentPage--; renderPage(); }
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    if (currentPage < Math.ceil(games.length / pageSize) - 1) {
      currentPage++;
      renderPage();
    }
  });

  renderPage();
}

function renderGamesRows(games, hasReview) {
  const tbody = document.getElementById('games-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  for (const g of games) {
    const score = numberOrNull(g.score);
    const dur   = numberOrNull(g.duration);
    // A null `acc` is a session that stored no questions. An em dash, not 0%
    // — "no data" and "got everything wrong" are different claims.
    const acc   = numberOrNull(g.acc);

    const tr = document.createElement('tr');
    // escapeHtml on every one of these: `d` and the numbers come from another
    // user's row, and this page renders profiles that are not the viewer's.
    tr.innerHTML = `
      <td>${escapeHtml(formatGameDate(g.d))}</td>
      <td><strong>${escapeHtml(score === null ? '—' : score)}</strong></td>
      <td>${escapeHtml(dur === null ? '—' : dur + 's')}</td>
      <td>${escapeHtml(acc === null ? '—' : acc + '%')}</td>
    `;

    if (hasReview) {
      const td = document.createElement('td');
      const key = typeof g.key === 'string' ? g.key : '';
      if (key) {
        const a = document.createElement('a');
        a.className = 'view-session-link';
        a.href      = 'results.html?session=' + encodeURIComponent(key);
        a.textContent = 'View';
        // Same handoff the dashboard uses: results.html reads the key from
        // localStorage, so it has to be there before the navigation.
        a.addEventListener('click', (e) => {
          e.preventDefault();
          localStorage.setItem('zt_pending_session', key);
          window.location.href = a.href;
        });
        td.appendChild(a);
      } else {
        td.textContent = '—';
      }
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
}

// ── Formatting ────────────────────────────────────────────────
// numberOrNull, formatCount, formatPercent and formatSeconds live in
// js/stats.js — the dashboard needs the same four.

// The table's date carries the year; the chart's axis label does not, because
// it is one tick among many. Same midday pinning as formatHistoryDate, for
// the same reason.
function formatGameDate(d) {
  if (!d) return '—';
  const date = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatHistoryDate(d) {
  if (!d) return '';
  // "2026-07-21" parses as UTC midnight; pinning the time keeps the label from
  // sliding a day backwards for viewers west of Greenwich.
  const date = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
