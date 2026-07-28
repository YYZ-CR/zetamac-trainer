// Settings — the one page that changes things rather than showing them.
//
// Four sections, and the ordering is deliberate: the username gates the
// visibility toggle (there is no /@you without a name), so it comes first and
// the toggle below it says so rather than sitting there inert.
//
// The username rules are NOT enforced here. supabase/settings.sql owns them —
// 3-20 characters, [A-Za-z0-9_-], no case collisions, 30 days between changes
// — and it returns its refusals as `{ok:false, error:'…'}` rather than raising
// them. This file's job is to state the rules before they are broken, disable
// what cannot be used, and turn a refusal code into a sentence. The one check
// it makes itself is "the box is empty", because a round trip to be told that
// is a round trip wasted.

// The signed-in user and their profile row, as last known. The profile is
// re-derived from set_username's payload after a successful change rather than
// re-fetched: the payload already carries the name and the next allowed change,
// which is everything the two panels render from.
let settingsUser    = null;
let settingsProfile = null;

// When the next username change becomes possible, in epoch ms, or null when
// one is possible now. Derived from profiles.username_changed_at on load and
// from set_username's next_change_allowed_at after every call.
let settingsNextChangeAt = null;

document.addEventListener('DOMContentLoaded', async () => {
  createAuthModal();

  let prevUserId = null;
  try {
    settingsUser = await initAuth({
      onAuthChange: (u) => {
        const id = u?.id ?? null;
        if (id !== prevUserId) { prevUserId = id; window.location.reload(); }
      },
    });
    prevUserId = settingsUser?.id ?? null;
  } catch (e) {
    console.warn('initAuth failed:', e);
  }

  renderAuthBar(settingsUser, document.getElementById('top-bar'));
  settingsHide('settings-loading');

  if (!settingsUser) {
    settingsShow('settings-signed-out');
    document.getElementById('settings-login-btn')
      .addEventListener('click', () => showAuthModal('login'));
    document.getElementById('settings-register-btn')
      .addEventListener('click', () => showAuthModal('register'));
    return;
  }

  // Null here is the ordinary "this account has no profile row" state, not an
  // error: with email confirmation on, registration creates the auth user and
  // the profile insert is refused because there is no session yet. The
  // username section below is the way out of it.
  settingsProfile = await getProfile(settingsUser.id);

  document.getElementById('settings-subtitle').textContent =
    settingsProfile?.username
      ? `Signed in as ${settingsProfile.username}`
      : (settingsUser.email || 'Signed in');

  settingsNextChangeAt = settingsNextFrom(settingsProfile?.username_changed_at);

  settingsShow('settings-signed-in');
  renderSettingsUsername();
  renderSettingsVisibility();
  renderSettingsAppearance();
  renderSettingsAccount();
  renderSettingsDanger();
});

// ── 1. Username ───────────────────────────────────────────────

function renderSettingsUsername() {
  const current = settingsProfile?.username ? String(settingsProfile.username) : '';
  const input   = document.getElementById('username-input');
  const btn     = document.getElementById('username-save-btn');
  const badge   = document.getElementById('username-panel-note');
  const intro   = document.getElementById('username-intro');
  const rules   = document.getElementById('username-rules');
  const nameEl  = document.getElementById('username-current');

  const cooling = settingsNextChangeAt !== null && settingsNextChangeAt > Date.now();
  const when    = settingsDateText(settingsNextChangeAt);

  // The name itself is user-controlled and goes through escapeHtml. It is
  // also the value most likely to be hostile on this page, because its owner
  // chose it.
  nameEl.innerHTML = current
    ? `Your username is <strong class="settings-strong">${escapeHtml(current)}</strong>`
    : '';
  nameEl.style.display = current ? 'block' : 'none';

  document.getElementById('username-error').textContent  = '';
  document.getElementById('username-status').textContent = '';

  if (!current) {
    // The claim flow. There is no cooldown to serve, and saying so matters:
    // the rules line immediately below mentions a 30-day wait, and a first-time
    // user would otherwise read that as applying to the name they are about to
    // pick.
    badge.textContent = 'Not set';
    intro.textContent =
      "You don't have a username yet, so nothing on a leaderboard, a clan board " +
      'or a duel can name you. Claiming your first one is free and takes effect ' +
      'immediately — the 30-day wait only starts once you have one.';
    rules.textContent = SETTINGS_USERNAME_RULES;
    input.value       = '';
    input.disabled    = false;
    input.placeholder = 'Pick a username';
    btn.disabled      = false;
    btn.textContent   = 'Claim username';
  } else if (cooling) {
    badge.textContent = 'Locked';
    intro.textContent = when
      ? `You changed your username recently. You can change it again on ${when}.`
      : 'You changed your username recently and cannot change it again yet.';
    rules.textContent = SETTINGS_USERNAME_RULES;
    input.value       = current;
    input.disabled    = true;
    btn.disabled      = true;
    btn.textContent   = 'Save';
  } else {
    badge.textContent = 'Set';
    intro.textContent =
      'This is the name every leaderboard, clan board and duel shows for you. ' +
      'Changing it starts a 30-day wait before the next change.';
    rules.textContent = SETTINGS_USERNAME_RULES;
    input.value       = current;
    input.disabled    = false;
    btn.disabled      = false;
    btn.textContent   = 'Save';
  }
}

// One sentence, stated once, in the place people read before typing. The
// numbers are supabase/settings.sql's; see USERNAME_COOLDOWN_DAYS in js/db.js
// for why a copy of the 30 lives on this side at all.
const SETTINGS_USERNAME_RULES =
  '3 to 20 characters. Letters, numbers, hyphens and underscores only — ' +
  'no spaces. You can change it once every ' + USERNAME_COOLDOWN_DAYS + ' days.';

async function saveSettingsUsername() {
  const input  = document.getElementById('username-input');
  const btn    = document.getElementById('username-save-btn');
  const err    = document.getElementById('username-error');
  const status = document.getElementById('username-status');

  err.textContent    = '';
  status.textContent = '';

  const wanted = input.value.trim();
  if (!wanted) {
    err.textContent = USERNAME_REFUSALS.username_empty;
    return;
  }

  const wasLabel = btn.textContent;
  btn.disabled   = true;
  input.disabled = true;
  btn.textContent = 'Saving…';

  const res = await setUsername(wanted);

  // Whatever happened, the server's view of the cooldown is now the one to
  // render from — including on a refusal, which is where it is most useful.
  if (res.next_change_allowed_at) {
    settingsNextChangeAt = settingsMs(res.next_change_allowed_at);
  }

  if (res.ok) {
    settingsProfile = Object.assign({}, settingsProfile || {}, {
      username: res.username,
      username_changed_at: new Date().toISOString(),
    });
    // A profile row that has just been created has is_public FALSE, which is
    // the column default. Recording it keeps the toggle below from reading
    // "unavailable" purely because the row we loaded at startup did not exist.
    if (!Object.prototype.hasOwnProperty.call(settingsProfile, 'is_public')) {
      settingsProfile.is_public = false;
    }

    document.getElementById('settings-subtitle').textContent =
      `Signed in as ${res.username}`;

    renderSettingsUsername();
    renderSettingsVisibility();
    // The string the Danger zone asks for IS the username, so it moves with
    // it. Anything already typed into that field now confirms nothing, which
    // is the correct outcome — renderSettingsDanger re-derives the button.
    renderSettingsDanger();
    // textContent, not innerHTML: this is the name they just chose.
    document.getElementById('username-status').textContent =
      `Saved. You are now ${res.username}.`;
    return;
  }

  // Re-render first — a cooldown refusal has to lock the input — then say why,
  // because re-rendering clears the message.
  btn.textContent = wasLabel;
  btn.disabled    = false;
  input.disabled  = false;
  renderSettingsUsername();
  input.value = wanted;
  document.getElementById('username-error').textContent = settingsUsernameMessage(res);
}

// The sentence for a refusal. Only the cooldown needs assembling: it is the
// one refusal where the useful half of the answer is a date, and js/db.js
// deliberately does not have it.
function settingsUsernameMessage(res) {
  const base = USERNAME_REFUSALS[res.error] || USERNAME_REFUSALS.username_unavailable;
  if (res.error === 'username_cooldown') {
    const when = settingsDateText(settingsMs(res.next_change_allowed_at));
    if (when) return `${base} You can change it again on ${when}.`;
  }
  return base;
}

// ── 2. Profile visibility ─────────────────────────────────────
// Lifted from the dashboard unchanged in behaviour, with one addition: a
// profile with no username cannot be published, because /@ nothing is not a
// URL. The toggle is disabled and says which of the two reasons it is.

// Nothing below closes over the profile. This panel is re-rendered when the
// username changes — claiming a name turns the toggle from unusable to usable —
// and an event handler bound to the FIRST render's closure would still believe
// there was no username, and would rewrite the panel to say so the next time
// anybody touched the checkbox. State lives here; the handlers read it.
let settingsIsPublic = false;

function renderSettingsVisibility() {
  const check = document.getElementById('visibility-check');
  const link  = document.getElementById('visibility-link');

  const username  = settingsUsernameNow();
  const hasColumn = settingsHasVisibilityColumn();

  settingsIsPublic = !!username && hasColumn && !!settingsProfile.is_public;

  check.checked  = settingsIsPublic;
  check.disabled = !(username && hasColumn);

  settingsVisibilityStatus('', null);

  // vercel.json rewrites /@name to profile.html?u=name, so /@name is the form
  // worth showing — but the href has to be the real query-string URL, or the
  // link is broken everywhere except production.
  if (username) {
    link.setAttribute('href', 'profile.html?u=' + encodeURIComponent(username));
    // textContent, not innerHTML: the username is user-controlled.
    link.textContent = '/@' + username;
  }

  describeSettingsVisibility();
}

function describeSettingsVisibility() {
  const badge   = document.getElementById('visibility-badge');
  const note    = document.getElementById('visibility-note');
  const linkRow = document.getElementById('visibility-link-row');

  if (!settingsUsernameNow()) {
    badge.textContent = 'Needs a username';
    note.textContent =
      'Your profile lives at /@your-username, so you need a username before it can ' +
      'be public. Set one above and this unlocks.';
    linkRow.style.display = 'none';
    return;
  }
  if (!settingsHasVisibilityColumn()) {
    badge.textContent = 'Unavailable';
    note.textContent =
      'Publishing is unavailable on this deployment — the database is missing the ' +
      'visibility column. Your profile stays private, and only you can open its link.';
    linkRow.style.display = 'none';
    return;
  }
  badge.textContent = settingsIsPublic ? 'Public' : 'Private';
  note.textContent  = settingsIsPublic
    ? 'Anyone with this link can see your stats, your per-operation breakdown and ' +
      'your recent scores.'
    : 'Only you can open your profile while it is private — everyone else is told ' +
      'the profile does not exist. Turn this on to get a link worth sharing.';
  linkRow.style.display = settingsIsPublic ? 'flex' : 'none';
}

function settingsVisibilityStatus(text, kind) {
  const status = document.getElementById('visibility-status');
  status.textContent = text;
  status.className = 'profile-visibility-status' + (kind ? ' is-' + kind : '');
}

async function onSettingsVisibilityChange() {
  const check = document.getElementById('visibility-check');
  if (check.disabled) return;

  const wanted   = check.checked;
  const previous = settingsIsPublic;

  // Disabled for the whole round trip: a fast double-click would otherwise put
  // two updates in flight and let whichever landed last decide the database,
  // while the checkbox showed whichever was clicked last.
  check.disabled = true;
  settingsVisibilityStatus(wanted ? 'Publishing…' : 'Making private…', 'pending');

  const ok = typeof setProfileVisibility === 'function'
    ? await setProfileVisibility(wanted)
    : false;

  check.disabled = false;

  if (ok) {
    settingsIsPublic = wanted;
    if (settingsProfile) settingsProfile.is_public = wanted;
    describeSettingsVisibility();
    settingsVisibilityStatus(
      wanted ? 'Your profile is now public.' : 'Your profile is now private.', 'ok');
  } else {
    // Never leave the box claiming a state the database does not have.
    check.checked    = previous;
    settingsIsPublic = previous;
    describeSettingsVisibility();
    settingsVisibilityStatus(
      `Couldn't save that — your profile is still ${previous ? 'public' : 'private'}. Try again.`,
      'error');
  }
}

function copySettingsProfileLink() {
  const link    = document.getElementById('visibility-link');
  const copyBtn = document.getElementById('visibility-copy-btn');
  const href    = link.getAttribute('href');
  if (!href) return;

  // Absolute, because the copied form is going somewhere else entirely.
  const url = new URL(href, window.location.href).toString();

  // copyLinkToClipboard (js/util.js) carries the clipboard's failure modes:
  // the property is undefined outside a secure context, the unguarded call
  // throws there rather than rejecting, and the write is refused when the
  // document is not focused. The Share buttons on the dashboard and the
  // profile page go through the same helper, so there is one of this, not
  // three.
  copyLinkToClipboard(url, () => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy link'; }, SHARE_COPIED_MS);
  });
}

// The current username, or '' — the one place that decides what "has a
// username" means, so the two panels cannot disagree about it.
function settingsUsernameNow() {
  return settingsProfile?.username ? String(settingsProfile.username) : '';
}

// profiles.is_public arrives with social.sql. Before that migration the column
// is simply absent from the row, and `undefined` would read as "private" from a
// control that could never make it public.
function settingsHasVisibilityColumn() {
  return !!settingsProfile &&
    Object.prototype.hasOwnProperty.call(settingsProfile, 'is_public');
}

// ── 3. Appearance ─────────────────────────────────────────────
// js/theme.js is the only theme store there is. These radios call applyTheme()
// and then re-read the attribute it set, so the header toggle and this control
// cannot disagree: whichever one is used, both re-render from the same source.

function renderSettingsAppearance() {
  const theme = document.documentElement.getAttribute('data-theme') === 'dark'
    ? 'dark' : 'zetamac';

  const light = document.getElementById('theme-zetamac');
  const dark  = document.getElementById('theme-dark');
  light.checked = theme === 'zetamac';
  dark.checked  = theme === 'dark';

  document.getElementById('appearance-badge').textContent =
    theme === 'dark' ? 'Dark' : 'Zetamac';

  [light, dark].forEach(radio => {
    if (radio.dataset.wired) return;
    radio.dataset.wired = '1';
    radio.addEventListener('change', () => {
      if (radio.checked) applyTheme(radio.value);
    });
  });
}

// applyTheme fires this, so a change from the header toggle lands here too.
window.addEventListener('zt-theme-change', () => {
  if (document.getElementById('theme-dark')) renderSettingsAppearance();
});

// ── 4. Account ────────────────────────────────────────────────

function renderSettingsAccount() {
  document.getElementById('account-email').textContent =
    settingsUser?.email || 'Not available';

  const btn = document.getElementById('settings-logout-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Logging out…';
    try { await logout(); } catch (e) { console.warn('logout failed:', e); }
    // Not a reload: this page has nothing to show a signed-out visitor, and
    // sending them to a signed-out Settings page would be a dead end.
    window.location.href = 'index.html';
  });
}

// ── 5. Danger zone ────────────────────────────────────────────
// The one control on this site that destroys something nobody can put back.
// Three things keep it from firing by accident: it is last on the page, it is
// collapsed until it is asked for, and the button that does it stays disabled
// until the account's own name has been typed out. The last of those is the
// only one the server also enforces — supabase/account.sql refuses any
// p_confirm that is not the caller's username — so the page and the database
// agree about what counts as confirmation rather than the page merely being
// careful.

// The exact string the confirmation field has to contain: the username, or the
// literal DELETE for an account that has none (there is nothing else only its
// owner is looking at).
function settingsDeletePhrase() {
  return settingsUsernameNow() || 'DELETE';
}

// Whether what has been typed confirms the delete. Trimmed and case-folded,
// which is exactly the comparison delete_account makes: a button that enables
// on a string the server will reject is a lie, and one that stays disabled on
// a string the server would accept is a dead end with no way out of it.
function settingsDeleteMatches(typed) {
  const want = settingsDeletePhrase().trim().toLowerCase();
  const got  = String(typed ?? '').trim().toLowerCase();
  // An empty string never confirms, which is also stated in the contract: a
  // username of nothing but spaces would otherwise trim to '' on both sides
  // and arm the button over an empty field, on a call the server refuses.
  if (!got || !want) return false;
  return got === want;
}

// Re-rendered after a username change as well as on load: the phrase to type
// is the username, so claiming or changing one moves it.
function renderSettingsDanger() {
  const phrase = settingsDeletePhrase();
  const input  = document.getElementById('danger-input');

  // The phrase is the username, which is user-controlled and is the value on
  // this page most likely to be hostile — its owner chose it.
  document.getElementById('danger-prompt').innerHTML =
    `To confirm, type <strong class="settings-strong">${escapeHtml(phrase)}</strong> ` +
    'in the box below.';

  input.placeholder = phrase;
  settingsDeleteEnable();
}

// The button's disabled state is derived from the field, never set anywhere
// else, so there is no path that leaves it enabled over a stale value.
function settingsDeleteEnable() {
  const input = document.getElementById('danger-input');
  const btn   = document.getElementById('danger-delete-btn');
  if (!input || !btn) return;
  btn.disabled = input.disabled || !settingsDeleteMatches(input.value);
}

function openSettingsDanger(open) {
  document.getElementById('danger-zone').style.display = open ? 'block' : 'none';
  document.getElementById('danger-open-btn').style.display = open ? 'none' : 'inline-block';

  if (!open) {
    const input = document.getElementById('danger-input');
    input.value = '';
    document.getElementById('danger-error').textContent  = '';
    document.getElementById('danger-status').textContent = '';
    settingsDeleteEnable();
  }
}

async function deleteThisAccount() {
  const input  = document.getElementById('danger-input');
  const btn    = document.getElementById('danger-delete-btn');
  const cancel = document.getElementById('danger-cancel-btn');
  const err    = document.getElementById('danger-error');
  const status = document.getElementById('danger-status');

  // Re-checked rather than trusted: a keyboard Enter, a double-fired click or
  // a disabled attribute somebody removed in devtools all arrive here.
  if (btn.disabled || !settingsDeleteMatches(input.value)) return;

  const typed = input.value;
  err.textContent = '';
  settingsDangerStatus('Deleting your account…', 'pending');

  btn.disabled    = true;
  cancel.disabled = true;
  input.disabled  = true;
  btn.textContent = 'Deleting…';

  const res = await deleteAccount(typed.trim());

  if (res.ok) {
    // Sign out FIRST, before anything else and before leaving the page. The
    // account row is gone, but the access token in this browser stays valid
    // until it expires on its own — a redirect that skips this leaves a live
    // session for an account that no longer exists, and every page that reads
    // it renders a signed-in header for a deleted user.
    settingsDangerStatus('Your account has been deleted. Signing you out…', 'ok');
    try {
      await logout();
    } catch (e) {
      console.warn('sign-out after delete failed:', e);
    }
    // Not a reload: there is no account left for this page to render.
    window.location.href = 'index.html';
    return;
  }

  // Still here, so the account still exists. Put the controls back the way
  // they were — a mismatch is something you fix by typing.
  btn.disabled    = false;
  cancel.disabled = false;
  input.disabled  = false;
  btn.textContent = 'Delete my account';
  input.value     = typed;
  settingsDeleteEnable();

  settingsDangerStatus('', null);
  err.textContent = ACCOUNT_REFUSALS[res.error] || ACCOUNT_REFUSALS.account_unavailable;
}

function settingsDangerStatus(text, kind) {
  const status = document.getElementById('danger-status');
  status.textContent = text;
  status.className = 'profile-visibility-status' + (kind ? ' is-' + kind : '');
}

// ── Small shared helpers ──────────────────────────────────────

// When the next change is allowed, in epoch ms, given a username_changed_at —
// or null when there has never been a change and one is free.
function settingsNextFrom(changedAt) {
  const t = settingsMs(changedAt);
  if (t === null) return null;
  return t + USERNAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
}

// Epoch ms for a timestamp from the database, or null for anything unusable.
// Postgres renders timestamptz as "2026-07-28 05:40:00+00", which Safari
// refuses to parse; the space becomes a T so every browser reads it the same.
function settingsMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = Date.parse(String(value).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

// A date somebody can act on — "3 September 2026" — or null. Deliberately no
// time of day: the cooldown is 30 days and an hour on the clock implies a
// precision the user has no reason to plan around.
function settingsDateText(value) {
  const t = settingsMs(value);
  if (t === null) return null;
  try {
    return new Date(t).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch (_) {
    return new Date(t).toDateString();
  }
}

function settingsShow(id, display = 'block') {
  const el = document.getElementById(id);
  if (el) el.style.display = display;
}

function settingsHide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// Every handler on this page is bound exactly once, here. The render functions
// run again after a save, and a listener attached inside one of them would be
// attached twice — which for the Save button means two set_username calls, the
// second of which is refused by the cooldown the first has just started.
document.addEventListener('DOMContentLoaded', () => {
  const saveBtn = document.getElementById('username-save-btn');
  const input   = document.getElementById('username-input');
  if (saveBtn) saveBtn.addEventListener('click', saveSettingsUsername);
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !input.disabled) saveSettingsUsername();
  });

  const check = document.getElementById('visibility-check');
  if (check) check.addEventListener('change', onSettingsVisibilityChange);

  const copyBtn = document.getElementById('visibility-copy-btn');
  if (copyBtn) copyBtn.addEventListener('click', copySettingsProfileLink);

  const openBtn   = document.getElementById('danger-open-btn');
  const cancelBtn = document.getElementById('danger-cancel-btn');
  const delInput  = document.getElementById('danger-input');
  const delBtn    = document.getElementById('danger-delete-btn');
  if (openBtn)   openBtn.addEventListener('click', () => openSettingsDanger(true));
  if (cancelBtn) cancelBtn.addEventListener('click', () => openSettingsDanger(false));
  // 'input' rather than 'change': the button has to follow the field as it is
  // typed, not when it is blurred.
  if (delInput) {
    delInput.addEventListener('input', settingsDeleteEnable);
    delInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') deleteThisAccount();
    });
  }
  if (delBtn) delBtn.addEventListener('click', deleteThisAccount);
});
