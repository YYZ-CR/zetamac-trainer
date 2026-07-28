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

// ── Username shape ────────────────────────────────────────────
// The same rule supabase/settings.sql enforces, restated here only so a user
// is told BEFORE an account is created rather than after. The database is
// authoritative: set_username re-checks every one of these, and a CHECK
// constraint on profiles blocks the registration insert outright.
//
// That constraint is why this exists. Registration inserts the profile row
// directly, so without a matching check up front, signing up as "Yang Yang"
// creates the account, fails the insert, and leaves a user with no username —
// the exact dead end the claim panel had to be built to escape.
const USERNAME_MIN     = 3;
const USERNAME_MAX     = 20;
const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;

// Null when the name is acceptable, otherwise the reason, phrased for a user.
// Reports the most specific problem rather than the first one tripped: told
// only "3 to 20 characters", someone typing "Yang Yang" would shorten it and
// fail again on the space.
function usernameProblem(value) {
  const name = String(value ?? '').trim();
  if (!name)                    return 'Please choose a username.';
  if (!USERNAME_PATTERN.test(name)) {
    return /\s/.test(name)
      ? 'Usernames cannot contain spaces — try a hyphen or underscore.'
      : 'Usernames can only use letters, numbers, hyphens and underscores.';
  }
  if (name.length < USERNAME_MIN) return `Usernames are at least ${USERNAME_MIN} characters.`;
  if (name.length > USERNAME_MAX) return `Usernames are at most ${USERNAME_MAX} characters.`;
  return null;
}
