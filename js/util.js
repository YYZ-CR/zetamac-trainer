// Shared helpers loaded before every other page script.

// Split a rendered problem ("84 ÷ 7") back into its two operands. The game
// stores only the display string and the answer, not the operands, so both
// the classifier and the tip engine have to re-parse it. `sep` is the literal
// glyph used in the display: '+', '−' (U+2212), '×' (U+00D7) or '÷' (U+00F7).
function parseTwo(display, sep) {
  const parts = String(display).split(sep);
  return [parseInt(parts[0].trim(), 10), parseInt(parts[1].trim(), 10)];
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
