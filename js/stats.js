// Shared record rendering for the two pages that show a player's history:
// dashboard.html (your own) and profile.html (anybody's public page).
//
// Both pages render the SAME three things in the same order — a five-tile stat
// strip, score over time, and a per-operation breakdown — so the markup that
// produces them lives in one file rather than being written twice and
// drifting. The dashboard adds Recent Games below all of it; the
// public page deliberately does not, because per-session history is not part
// of the fixed projection get_public_profile returns and publishing it would
// be a cross-user data exposure (see docs/social-api.md).
//
// The shape every function here consumes is the get_public_profile payload:
//
//   { total_games, total_questions, accuracy, days_practiced, streak,
//     bests:   { "120": 84, … },
//     history: [ { d: "2026-07-21", score: 75, duration: 120 }, … ],
//     ops:     { addition: { avg_ms, count, accuracy }, … } }
//
// `accuracy` is still part of that contract and is still computed by the
// database; it simply has no tile any more. The strip shows the record's
// volume plus one score, and the score is the Best tile below.
//
// The dashboard prefers that payload and falls back to computing the same
// shape from the sessions it already loaded, so the page works before
// supabase/social.sql is applied and for an account that has no username yet.
//
// No build step: this is a classic script sharing one global scope with
// js/util.js, js/db.js and the page script, and it must be loaded before the
// page script. Every name below is prefixed or unique for that reason.

// Whitelisted, in the order they are shown. get_public_profile applies the
// same whitelist server-side; anything else in a client-written `questions`
// payload is dropped rather than rendered.
const STAT_OP_ORDER  = ['addition', 'subtraction', 'multiplication', 'division'];
const STAT_OP_SYMBOL = { addition: '+', subtraction: '−', multiplication: '×', division: '÷' };

// ── Formatting ────────────────────────────────────────────────

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatCount(v) {
  const n = numberOrNull(v);
  return n === null ? '—' : n.toLocaleString('en-US');
}

function formatPercent(v) {
  const n = numberOrNull(v);
  if (n === null) return '—';
  // The contract gives fractions (0.962); tolerate a percentage just in case.
  const frac = n > 1 ? n / 100 : n;
  return `${Math.round(frac * 1000) / 10}%`;
}

function formatSeconds(ms) {
  const n = numberOrNull(ms);
  return n === null ? '—' : `${(n / 1000).toFixed(2)}s`;
}

// ── The best tile ─────────────────────────────────────────────
// The strip's third tile is one personal best. Picking it is the whole
// problem: scores at different run lengths are different measurements, and a
// 300-second run scores roughly two and a half times a 120-second one, so
// MAX() across durations is a 300s number for anybody who has ever tried one
// long run. That is precisely the mistake the old per-duration Personal Bests
// panel existed to avoid, and it must not come back in through this tile.
//
// So the tile shows the best at the duration the player has played MOST, and
// the label names that duration — `Best · 120s` — so the number is never
// ambiguous about which measurement it is.

// Games played per duration, as { "120": 12, … }. Two sources, in order:
//
//   games_by_duration  the dashboard's local fallback counts the sessions it
//                      loaded and attaches this (see recordFromSessions)
//   history            get_public_profile's recent rows, each carrying its
//                      own duration — the only per-session data the public
//                      payload contains
//
// The dashboard deliberately does NOT attach games_by_duration when it got a
// server payload, even though it has more sessions in memory than history
// carries: both pages must pick the same duration for the same account, and
// they only do that if they count the same rows.
function playCountsByDuration(record) {
  const source = record && typeof record === 'object' ? record : {};
  const counts = {};

  const explicit = source.games_by_duration;
  if (explicit && typeof explicit === 'object') {
    for (const key of Object.keys(explicit)) {
      const n = numberOrNull(explicit[key]);
      if (n !== null) counts[String(key)] = n;
    }
    return counts;
  }

  for (const row of Array.isArray(source.history) ? source.history : []) {
    const d = row && numberOrNull(row.duration);
    if (d === null) continue;
    const key = String(d);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// Returns { d, score } for the tile, or null when there is no best to show.
//
// Ties on games played go to the LONGER duration. It needs to be a rule and
// not an accident of key order — Object.keys order for integer-like keys is
// ascending numeric, so "whichever came first" would silently mean "shortest"
// and would flip the day someone's bests arrived in a different shape.
function pickBestDuration(bests, counts) {
  const source = bests && typeof bests === 'object' ? bests : {};
  const plays  = counts && typeof counts === 'object' ? counts : {};
  const played = (d) => numberOrNull(plays[String(d)]) ?? 0;

  const candidates = Object.keys(source)
    .map(k => ({ d: numberOrNull(k), score: numberOrNull(source[k]) }))
    .filter(c => c.d !== null && c.score !== null)
    .sort((a, b) => (played(b.d) - played(a.d)) || (b.d - a.d));

  return candidates.length ? candidates[0] : null;
}

// ── The stat strip ────────────────────────────────────────────
// Five tiles, in this order, on both pages. Every value is escaped even though
// four of the five are numbers: on the public page they arrive from a database
// row that a stranger's account produced, and "it is a number today" is not a
// property this function can check for its callers.

function renderStatStrip(el, stats) {
  if (!el) return false;
  const source = stats && typeof stats === 'object' ? stats : {};

  const best = pickBestDuration(source.bests, playCountsByDuration(source));

  const tiles = [
    { value: formatCount(source.total_games),     label: 'Total Games' },
    { value: formatCount(source.total_questions), label: 'Questions' },
    { value: best ? formatCount(best.score) : '—',
      label: best ? `Best · ${best.d}s` : 'Best' },
    { value: formatCount(source.days_practiced),  label: 'Days Practiced' },
    { value: formatCount(source.streak),          label: 'Day Streak' },
  ];

  // Five dashes is not a record, it is a failed load pretending to be one.
  // Callers hide the strip rather than show it, and get told so here.
  if (tiles.every(t => t.value === '—')) return false;

  el.innerHTML = tiles.map(t => `
    <div class="stat-card">
      <div class="stat-value">${escapeHtml(t.value)}</div>
      <div class="stat-label">${escapeHtml(t.label)}</div>
    </div>
  `).join('');
  el.style.display = 'grid';
  return true;
}

// ── The note under the strip ──────────────────────────────────
// The rolling average has no tile: the strip is all-time, and this is a
// recent-form figure that would be read as all-time if it sat beside four
// numbers that are. It goes in the small note under the strip instead, as a
// clause other clauses can be joined to (the public profile appends the
// percentile to it), which is why it is returned without a full stop.
//
// `scores` is newest-first.
function averageOfLast(scores, n) {
  const nums = (Array.isArray(scores) ? scores : [])
    .map(numberOrNull)
    .filter(v => v !== null)
    .slice(0, n);
  if (!nums.length) return null;
  // The count is the number of scores actually averaged, not min(n, length):
  // a history row with a null score is skipped above, and saying "the last 10
  // games" over nine of them is a small lie the sentence does not need.
  return { avg: Math.round(nums.reduce((a, b) => a + b, 0) / nums.length), count: nums.length };
}

// Neutral about whose record it is: the same sentence runs on your own
// dashboard and on a stranger's public profile, so it says neither "you" nor
// a username.
function recentAverageText(scores, n) {
  const r = averageOfLast(scores, n);
  if (r === null) return '';
  return r.count === 1
    ? `The last game scored ${r.avg}`
    : `Averaging ${r.avg} across the last ${r.count} games`;
}

// ── Per-operation breakdown ───────────────────────────────────

function renderOpBars(el, ops) {
  if (!el) return false;
  const source = ops && typeof ops === 'object' ? ops : {};

  const rows = STAT_OP_ORDER
    .map(name => ({ name, stat: source[name] }))
    .filter(r => r.stat && numberOrNull(r.stat.avg_ms) !== null)
    .map(r => ({
      name:     r.name,
      avgMs:    Number(r.stat.avg_ms),
      count:    numberOrNull(r.stat.count),
      accuracy: numberOrNull(r.stat.accuracy),
    }));

  if (!rows.length) return false;

  // Bars are scaled against the slowest operation, so the shape of the chart
  // answers the question people actually have: which one is dragging?
  const maxMs = Math.max(...rows.map(r => r.avgMs), 1);

  el.innerHTML = rows.map(r => {
    const width = Math.max(4, Math.round((r.avgMs / maxMs) * 100));
    const meta  = [
      r.accuracy !== null ? `${formatPercent(r.accuracy)} correct` : null,
      r.count !== null ? `${formatCount(r.count)} questions` : null,
    ].filter(Boolean).join(' · ');

    return `
      <div class="op-bar-row">
        <div class="op-bar-label">
          <span class="op-bar-symbol">${escapeHtml(STAT_OP_SYMBOL[r.name] || '')}</span>
          <span class="op-bar-name">${escapeHtml(r.name)}</span>
        </div>
        <div class="op-bar-track">
          <div class="op-bar-fill" style="width:${escapeHtml(width)}%"></div>
        </div>
        <div class="op-bar-value">${escapeHtml(formatSeconds(r.avgMs))}</div>
        <div class="op-bar-meta">${escapeHtml(meta)}</div>
      </div>
    `;
  }).join('');
  return true;
}
