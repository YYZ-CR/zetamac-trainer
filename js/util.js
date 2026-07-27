// Shared helpers loaded before every other page script.

// Split a rendered problem ("84 ÷ 7") back into its two operands. The game
// stores only the display string and the answer, not the operands, so both
// the classifier and the tip engine have to re-parse it. `sep` is the literal
// glyph used in the display: '+', '−' (U+2212), '×' (U+00D7) or '÷' (U+00F7).
function parseTwo(display, sep) {
  const parts = String(display).split(sep);
  return [parseInt(parts[0].trim(), 10), parseInt(parts[1].trim(), 10)];
}

// ── Percentiles ──────────────────────────────────────────────
// get_score_percentile already returns null below five ranked players, but a
// figure drawn from a dozen people is a statement about a dozen named
// individuals rather than about "players". The client holds a higher bar and
// says nothing rather than something misleading.
//
// This lives here, in the one file every page loads, because both the profile
// page and the results page render the same figure — two copies of a threshold
// drift, and the drift is invisible until someone compares two pages.
const PERCENTILE_MIN_PLAYERS = 20;

// The whole-percent figure worth displaying for a get_score_percentile
// payload, or null when there is nothing worth saying. Pages differ in how
// they word it, so this returns the number and leaves the sentence to them —
// what is shared is the decision of whether to speak at all.
function percentilePercent(res) {
  if (!res) return null;
  // Number(null) is 0, not NaN, so a null percentile — which is exactly what
  // the RPC returns when the population is too thin — would otherwise render
  // as a confident "faster than 0% of players".
  if (res.percentile === null || res.percentile === undefined) return null;

  const pct     = Number(res.percentile);
  const players = Number(res.players);
  if (!Number.isFinite(pct) || !Number.isFinite(players)) return null;
  if (players < PERCENTILE_MIN_PLAYERS) return null;

  // Round to a whole percent, but never claim 100: somebody is always at the
  // top of the field, and "faster than 100% of players" would include them.
  const whole = Math.round(pct * 100);
  return pct < 1 ? Math.min(whole, 99) : whole;
}

// Escape a value for safe interpolation into an HTML template string.
// Session `questions` payloads are stored as free-form JSONB and are readable
// (and, under the current RLS policies, writable) by anyone holding the anon
// key, so anything sourced from a session must be escaped before it reaches
// innerHTML.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
