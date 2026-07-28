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

// ── Sharing a profile link ────────────────────────────────────
// One implementation of "hand this URL to somebody else", used by the Share
// control beside the username on the dashboard and on a profile page, and by
// the Copy link button in Settings. It lives here because js/util.js is the
// one file every page loads, and because the clipboard has enough failure
// modes that a second copy of this would be a second set of them.

// How long "Copied!" sits on a button before it goes back to its own label.
const SHARE_COPIED_MS = 2000;

// Copy `text`, calling onCopied() only when the write actually lands.
//
// navigator.clipboard is undefined outside a secure context — and over plain
// http the unguarded call THROWS rather than returning a rejected promise — so
// this has to survive the property being missing, the call throwing, and the
// promise rejecting (the write is also refused when the document is not
// focused, or when permission is denied). The prompt is the last resort that
// still puts the text somewhere a person can select it by hand; onFallback
// says that is what happened, because nothing was copied.
function copyLinkToClipboard(text, onCopied, onFallback) {
  const url = String(text ?? '');

  const fallback = () => {
    // prompt() is itself blockable — a page with too many dialogs loses it.
    try { window.prompt('Copy this link:', url); } catch (_) { /* nothing else to try */ }
    if (typeof onFallback === 'function') onFallback();
  };

  let p = null;
  try { p = navigator.clipboard?.writeText(url); } catch (_) { p = null; }

  if (p && typeof p.then === 'function') {
    p.then(() => { if (typeof onCopied === 'function') onCopied(); }).catch(fallback);
  } else {
    fallback();
  }
}

// Hand `url` to the platform share sheet when there is one, and fall back to
// the clipboard when there is not.
//
// Separate callbacks rather than one "done": a native share and a silent
// clipboard write are different events to the person who triggered them — the
// sheet is its own confirmation, a copy is not — and the caller words them
// differently.
//
// A dismissed sheet rejects with AbortError. That is somebody changing their
// mind, not a failure: it must produce no message, and no copy they did not
// ask for. Any other rejection is a share that did not happen, so the
// clipboard is tried instead of leaving the click with no effect at all.
function shareOrCopyLink(url, opts) {
  const o    = opts || {};
  const copy = () => copyLinkToClipboard(url, o.onCopied, o.onFallback);

  let p = null;
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const payload = { url: String(url) };
    if (o.title) payload.title = String(o.title);
    // navigator.share throws synchronously when the data is rejected outright.
    try { p = navigator.share(payload); } catch (_) { p = null; }
  }

  if (!p || typeof p.then !== 'function') { copy(); return; }

  p.then(() => { if (typeof o.onShared === 'function') o.onShared(); })
   .catch((err) => {
     if (err && err.name === 'AbortError') return;
     console.warn('share failed, copying instead:', err);
     copy();
   });
}

// The public profile URL for a username, absolute — the copied form is going
// somewhere else entirely, so a relative one is worthless. /@name is what
// vercel.json rewrites to profile.html?u=name, and it is the form worth
// handing out.
//
// encodeURIComponent, not the raw name: usernames are user-controlled, and an
// unencoded one puts '<', '"', '#' and '?' straight into the path, which
// truncates the link at best.
function profileShareUrl(username) {
  const name = String(username ?? '').trim();
  if (!name) return '';
  return new URL('/@' + encodeURIComponent(name), window.location.href).toString();
}

// The Share control beside the username on the dashboard and on a profile
// page. Both carry the same two empty slots — #share-slot next to the name,
// #share-note under it — and this fills them.
//
//   username  the profile being shared
//   isPrivate true only when the link works for nobody but the viewer, i.e.
//             it is the viewer's own profile and it is not public. Sharing is
//             still allowed — it is a trap only if nobody says so.
//   title     share-sheet title; ignored by the clipboard path
//
// Renders nothing at all without a username. Registration with email
// confirmation can leave an account without one, there is no /@ nothing, and a
// button that copies /@undefined is worse than no button.
function renderShareControl(opts) {
  const o    = opts || {};
  const slot = document.getElementById('share-slot');
  const note = document.getElementById('share-note');
  if (!slot) return null;

  slot.textContent = '';
  clearShareNote(note);

  const url = profileShareUrl(o.username);
  if (!url) return null;

  const btn = document.createElement('button');
  btn.type        = 'button';
  btn.className   = 'btn share-btn';
  btn.id          = 'share-profile-btn';
  // Text, not an icon: "Share" is the accessible name as well as the label,
  // and it is what changes to "Copied!" when there is nothing else to show.
  btn.textContent = 'Share';
  slot.appendChild(btn);

  // Static strings from this file, never interpolated profile data — the link
  // is the reason this is innerHTML rather than textContent.
  const CAVEAT =
    'your profile is private, so only you can see it. ' +
    'Make it public in <a href="settings.html">Settings</a>.';

  let revert = null;
  const flashCopied = () => {
    btn.textContent = 'Copied!';
    clearTimeout(revert);
    revert = setTimeout(() => { btn.textContent = 'Share'; }, SHARE_COPIED_MS);
  };

  const showNote = (html) => {
    if (!note) return;
    note.innerHTML = html;
    note.style.display = 'block';
  };

  btn.addEventListener('click', () => {
    clearShareNote(note);
    shareOrCopyLink(url, {
      title: o.title,
      // The sheet already told them it went; the caveat has not.
      onShared:   () => { if (o.isPrivate) showNote('Shared — ' + CAVEAT); },
      onCopied:   () => { flashCopied(); if (o.isPrivate) showNote('Copied — ' + CAVEAT); },
      // Nothing was copied on this path — the URL is sitting in a prompt — so
      // the button must not claim it was.
      onFallback: () => { if (o.isPrivate) showNote('Also worth knowing: ' + CAVEAT); },
    });
  });

  return btn;
}

function clearShareNote(note) {
  if (!note) return;
  note.textContent   = '';
  note.style.display = 'none';
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
