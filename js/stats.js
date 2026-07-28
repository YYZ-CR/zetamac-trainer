// Shared record rendering for the two pages that show a player's history:
// dashboard.html (your own) and profile.html (anybody's public page).
//
// Both pages render the SAME four things in the same order — a five-tile stat
// strip, personal bests, score over time, and a per-operation breakdown — so
// the markup that produces them lives in one file rather than being written
// twice and drifting. The dashboard adds Recent Games below all of it; the
// public page deliberately does not, because per-session history is not part
// of the fixed projection get_public_profile returns and publishing it would
// be a cross-user data exposure (see docs/social-api.md).
//
// The shape every function here consumes is the get_public_profile payload:
//
//   { total_games, total_questions, accuracy, days_practiced, streak,
//     bests: { "120": 84, … }, ops: { addition: { avg_ms, count, accuracy }, … } }
//
// The dashboard prefers that payload and falls back to computing the same
// shape from the sessions it already loaded, so the page works before
// supabase/social.sql is applied and for an account that has no username yet.
//
// No build step: this is a classic script sharing one global scope with
// js/util.js, js/db.js and the page script, and it must be loaded before the
// page script. Every name below is prefixed or unique for that reason.

const STAT_DURATIONS = [60, 120, 180, 300];

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

// ── The stat strip ────────────────────────────────────────────
// Five tiles, in this order, on both pages. Every value is escaped even though
// all five are numbers: on the public page they arrive from a database row
// that a stranger's account produced, and "it is a number today" is not a
// property this function can check for its callers.

function renderStatStrip(el, stats) {
  if (!el) return false;
  const source = stats && typeof stats === 'object' ? stats : {};

  const tiles = [
    { value: formatCount(source.total_games),     label: 'Total Games' },
    { value: formatCount(source.total_questions), label: 'Questions' },
    { value: formatPercent(source.accuracy),      label: 'Accuracy' },
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

// ── Personal bests ────────────────────────────────────────────
// One card per duration actually played. A duration nobody has touched is
// absent rather than shown as a zero, and the scores are never pooled across
// durations — a 60-second best and a 300-second best are not the same
// measurement, so there is no single "personal best" figure here.

function renderBestCards(el, bests) {
  if (!el) return false;
  const source = bests && typeof bests === 'object' ? bests : {};

  const cards = STAT_DURATIONS
    .map(d => ({ d, score: numberOrNull(source[String(d)] ?? source[d]) }))
    .filter(x => x.score !== null);

  if (!cards.length) return false;

  el.innerHTML = cards.map(({ d, score }) => `
    <div class="best-card">
      <div class="best-score">${escapeHtml(score)}</div>
      <div class="best-duration">${escapeHtml(d)}s</div>
    </div>
  `).join('');
  return true;
}

// The rolling figure that used to have its own tile on the dashboard. It sits
// in the bests panel's head instead of the strip: the strip is all-time
// volume, and this is a score, so it belongs beside the other scores.
// `scores` is newest-first.
function averageOfLast(scores, n) {
  const nums = (Array.isArray(scores) ? scores : [])
    .map(numberOrNull)
    .filter(v => v !== null)
    .slice(0, n);
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function bestsNoteText(scores, n) {
  const avg = averageOfLast(scores, n);
  if (avg === null) return '';
  const count = Math.min(n, scores.length);
  return count === 1 ? `Last game · ${avg}` : `Avg last ${count} · ${avg}`;
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
