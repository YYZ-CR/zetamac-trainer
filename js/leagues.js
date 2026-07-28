// Private leagues — leagues.html
//
// A named group, an invite code, and its own leaderboard over the daily. The
// page is a small state machine over what get_league says, and it is
// deliberately the same machine duel.html runs — resolve a payload, pick a
// state, render exactly one of them — because it is the same problem.
//
//   signed out      → what a league is, and why this one needs an account.
//   no ?l=          → your leagues, plus "create one" and "join with a code".
//   ?l=, not a      → the join screen: name, owner, member count, and what
//     member          joining reveals about you. Never a roster.
//   ?l=, member     → the board. Today / Week / Best.
//   owner leaving   → what leaving does BEFORE it is done, and what it
//                     actually did afterwards.
//   full league     → say so on the join screen.
//   unknown code /  → a readable page, never a blank one.
//     no migration
//
// Four rules run through all of it:
//
//   * Accounts are required, and the copy says why rather than just asking.
//     The board ranks members by their result on the day's puzzle, and one
//     attempt per person cannot be enforced against an anonymous player — they
//     can come back as somebody else. That is the whole reason, and it is the
//     one thing a login wall owes the person it stops.
//   * The roster belongs to members. get_league carries a member COUNT and no
//     names, and this file never invents any: the join screen has nothing to
//     list, and it does not pretend otherwise.
//   * `is_public` decides whether a username may be LINKED, never whether it
//     is shown. Joining a league does not publish anybody's profile, so a
//     member who has not published theirs appears as plain text — not as a
//     link to a page that would tell the viewer the profile does not exist.
//   * A member who has not played shows as "hasn't played". Not as a zero,
//     which is a score they did not get, and not omitted, because a league of
//     six where two are missing should look like a league of six.
//
// League names and usernames are BOTH user-controlled, and a league name is
// the more dangerous of the two: one person names a thing that many others
// then load. Everything from a payload goes through escapeHtml() on its way to
// innerHTML, or through textContent.

// The three scopes get_league_board accepts, in the order they are offered.
// 'today' is first and is the default: it is the day's puzzle, and it is the
// reason to come back.
const LEAGUE_SCOPES = [
  { id: 'today', label: 'Today' },
  { id: 'week',  label: 'Week'  },
  { id: 'best',  label: 'Best'  },
];

// ── State ─────────────────────────────────────────────────────

let leagueKey      = '';        // from ?l= or /l/<code>, normalised
let leaguePayload  = null;      // last get_league / join_league payload
let leagueScope    = 'today';   // which board is on screen
let leagueBoardSeq = 0;         // guards against two scope clicks racing
let leagueLeaveArmed = false;   // the leave button's second click

// Which user the current view was built for. `undefined` means never resolved,
// which is distinct from null (resolved, signed out).
let leagueViewUserId = undefined;
let leagueResolving  = false;

// ── URL ───────────────────────────────────────────────────────

// leagues.html?l=<code>, or the clean /l/<code> a rewrite would serve. The
// clean form has to be read from the PATHNAME: a server-side rewrite is
// invisible to the browser, location.search is EMPTY, and a page that only
// looked at the query string would show "your leagues" to somebody who
// followed an invite. Same shape as readUsernameFromUrl() in js/profile.js.
function readLeagueKeyFromUrl() {
  const q = new URLSearchParams(window.location.search).get('l');
  if (q && q.trim()) return normalizeLeagueKey(q);

  const m = window.location.pathname.match(/^\/l\/([^/]+)\/?$/);
  if (!m) return '';
  // decodeURIComponent throws on a malformed escape (a bare '%' in the path),
  // which would otherwise take the whole page down before it renders.
  let raw = m[1];
  try { raw = decodeURIComponent(m[1]); } catch (_) { /* use it as-is */ }
  return normalizeLeagueKey(raw);
}

function leagueUrlFor(key) {
  try {
    return window.location.origin + '/leagues.html?l=' + encodeURIComponent(key);
  } catch (_) {
    return 'leagues.html?l=' + encodeURIComponent(key);
  }
}

// ── Boot ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const topBar = document.getElementById('top-bar');

  // The auth bar is decoration: a broken client must not stop the page from
  // rendering a readable explanation of why leagues are unavailable.
  try {
    createAuthModal();
    let user = null;
    try {
      user = await initAuth({
        onAuthChange: (u) => { renderAuthBar(u, topBar); onLeagueAuthChange(u); },
      });
    } catch (e) { console.warn('initAuth failed:', e); }
    renderAuthBar(user, topBar);
  } catch (e) {
    console.warn('auth bar unavailable:', e);
    if (typeof renderThemeToggle === 'function') renderThemeToggle(topBar);
  }

  leagueKey = readLeagueKeyFromUrl();
  await resolveLeagueState();
});

// Logging in or out changes which state applies — every league RPC requires an
// account, so a signed-out visitor has no list and no board.
function onLeagueAuthChange(user) {
  const id = user ? user.id : null;
  if (id === leagueViewUserId) return;   // onAuthStateChange also fires on load
  resolveLeagueState();
}

// ── State machine ─────────────────────────────────────────────

async function resolveLeagueState() {
  if (leagueResolving) return;
  leagueResolving = true;

  try {
    const user = (typeof currentUser !== 'undefined') ? currentUser : null;
    leagueViewUserId = user ? user.id : null;
    resetLeagueView();

    // db.js did not load at all (blocked CDN, file missing).
    if (typeof getLeague !== 'function' || typeof getMyLeagues !== 'function') {
      showLeagueUnavailable();
      return;
    }

    // ── 1. Signed out ───────────────────────────────────────
    if (!user) {
      showLeagueSignedOut();
      return;
    }

    // ── 2. No code: your leagues ────────────────────────────
    if (!leagueKey) {
      await showLeagueIndex();
      return;
    }

    const l = await getLeague(leagueKey);

    if (!l) {
      // get_league returns SQL NULL for an unknown code and raises for
      // nothing a code-holder can trigger — so a null payload with no
      // recorded code is a real answer ("no such league"), and a null payload
      // WITH one is infrastructure.
      if (typeof lastLeagueCode !== 'undefined' && lastLeagueCode) showLeagueUnavailable();
      else showLeagueNotFound();
      return;
    }

    leaguePayload = l;
    leagueShow('league-back', 'inline-block');

    // ── 4. A member: the board ──────────────────────────────
    if (l.is_member === true) {
      await showLeagueBoardView(l);
      return;
    }

    // ── 3/6. Not a member: the join screen, full or not ─────
    showLeagueJoin(l);
  } catch (e) {
    console.error('resolveLeagueState failed:', e);
    showLeagueUnavailable();
  } finally {
    leagueResolving = false;
  }
}

// Clears everything the previous state put on the page.
function resetLeagueView() {
  leagueLeaveArmed = false;
  leagueBoardSeq++;

  leagueHide('league-notice');
  leagueHide('league-panel');
  leagueHide('league-board-panel');
  leagueHide('league-share');
  leagueHide('league-forms');
  leagueHide('league-manage');
  leagueHide('league-back');
  leagueShow('league-loading');

  document.getElementById('league-notice').innerHTML = '';
  document.getElementById('league-panel').innerHTML  = '';
  document.getElementById('league-forms').innerHTML  = '';
  document.getElementById('league-manage').innerHTML = '';
  document.getElementById('league-board').innerHTML  = '';
  document.getElementById('league-scopes').innerHTML = '';
  document.getElementById('league-board-note').textContent = '';
  document.getElementById('league-meta').textContent = '';
  document.getElementById('league-title').textContent = 'Leagues';
}

// ── 1. Signed out ─────────────────────────────────────────────
// Accounts are required here, unlike duels, and the copy has to earn that.
// The board ranks members by the day's puzzle, and one attempt per person is
// not enforceable against somebody who can come back as somebody else.

function showLeagueSignedOut() {
  leagueHide('league-loading');
  document.getElementById('league-title').textContent =
    leagueKey ? "You've been invited to a league" : 'Leagues';

  const invited = leagueKey
    ? `<p>
         The invite works — it just needs an account behind it. Log in and
         this page will show you the league and ask whether you want to join.
       </p>`
    : '';

  const el = document.getElementById('league-notice');
  el.innerHTML = `
    <strong>Leagues need an account.</strong>
    <p>
      A league is a private leaderboard over Zetamac Daily: everyone in it gets
      the same questions on the same day, so the scores are directly
      comparable. Being 3rd of 6 behind people you know is the entire reason
      anyone practices.
    </p>
    <p>
      That only works with one attempt each, and one attempt can only be
      enforced against an account — an anonymous player can come back as
      somebody else, so an anonymous member could not be ranked and could not
      be told apart from a second one. A league is also a group of known
      people: the others see a username, not a browser.
    </p>
    ${invited}
    <div class="league-notice-actions">
      <button class="btn btn-primary" id="league-login-btn">Log in or register</button>
      <a href="daily.html">Play today's daily</a>
      <a href="index.html">Play a solo game</a>
    </div>
  `;
  el.style.display = 'block';

  document.getElementById('league-login-btn').addEventListener('click', () => {
    if (typeof showAuthModal === 'function') showAuthModal('login');
  });
}

// ── 2. Your leagues ───────────────────────────────────────────

async function showLeagueIndex() {
  const leagues = await getMyLeagues();

  // null is a failed call, never "no leagues" — getMyLeagues returns [] for
  // that. Getting the two the wrong way round would show somebody an empty
  // state while their leagues were simply unreachable.
  if (leagues === null) {
    showLeagueUnavailable();
    return;
  }

  leagueHide('league-loading');
  document.getElementById('league-title').textContent = 'Your leagues';

  const el = document.getElementById('league-panel');

  if (!leagues.length) {
    // An empty state that invites rather than reports. A dash here would be
    // the single least useful thing this page could say.
    el.innerHTML = `
      <div class="panel-head">
        <h2>You're not in a league yet</h2>
      </div>
      <p class="league-lede">
        A league is a private leaderboard over Zetamac Daily — same questions,
        same day, one attempt each. Create one, send the code to four people
        you would actually like to beat, and the daily stops being a solo
        habit.
      </p>
      <p class="league-lede">
        Or paste a code somebody sent you below.
      </p>
    `;
  } else {
    const rows = leagues.map(leagueIndexRow).join('');
    el.innerHTML = `
      <div class="panel-head">
        <h2>Your leagues</h2>
        <span class="panel-note">${escapeHtml(leagues.length)} of 20</span>
      </div>
      <ul class="league-list">${rows}</ul>
    `;
  }
  el.style.display = 'block';

  renderLeagueForms();
}

// One league in the index list. `name` and `owner_username` are both
// user-controlled and both reach innerHTML.
function leagueIndexRow(l) {
  const key   = String(l.league_key ?? '');
  const name  = String(l.name ?? 'Untitled league');
  const n     = leagueNumber(l.member_count);
  const max   = leagueNumber(l.max_members) ?? 100;
  const owner = leagueOwnerText(l.owner_username);
  const count = n === null
    ? ''
    : (n === 1 ? '1 member' : `${n} members`) + ` of ${max}`;

  return `
    <li class="league-list-item">
      <a class="league-list-name" href="leagues.html?l=${escapeHtml(encodeURIComponent(key))}">${escapeHtml(name)}</a>
      <div class="league-list-meta">
        ${l.is_owner === true
          // "you own this" and "owned by <somebody>" are two answers to the
          // same question, so only one of them is ever shown.
          ? '<span class="league-tag">you own this</span>'
          : `<span>${escapeHtml(owner)}</span>`}
        <span>${escapeHtml(count)}</span>
        <span class="league-list-code">${escapeHtml(key)}</span>
      </div>
    </li>
  `;
}

// "owned by hexadecimal", or an honest stand-in. get_my_leagues LEFT JOINs
// profiles, so an owner with no profile row comes back null rather than
// dropping the league out of the caller's own list.
function leagueOwnerText(username) {
  const u = String(username ?? '').trim();
  return u ? 'owned by ' + u : 'owner has no username yet';
}

// Create and join, side by side, below whichever list state rendered above.
function renderLeagueForms() {
  const el = document.getElementById('league-forms');
  el.innerHTML = `
    <div class="panel league-form-panel">
      <div class="panel-head"><h2>Create a league</h2></div>
      <p class="league-lede">
        You get an invite code to send round. Anyone with the code can join,
        so send it to people, not to the internet.
      </p>
      <div class="league-form-row">
        <label class="league-form-label" for="league-name-input">Name</label>
        <input type="text" id="league-name-input" class="league-form-input"
               maxlength="60" placeholder="Desk Six" autocomplete="off">
        <button class="btn btn-primary" id="league-create-btn">Create league</button>
      </div>
      <p class="league-form-status" id="league-create-status" role="status" aria-live="polite"></p>
    </div>

    <div class="panel league-form-panel">
      <div class="panel-head"><h2>Join with a code</h2></div>
      <p class="league-lede">
        Joining shows the other members your username and your daily scores.
        It does not publish your profile.
      </p>
      <div class="league-form-row">
        <label class="league-form-label" for="league-code-input">Code</label>
        <input type="text" id="league-code-input" class="league-form-input league-code-input"
               maxlength="32" placeholder="WPQ7K3NDRX" autocomplete="off"
               autocorrect="off" autocapitalize="characters" spellcheck="false">
        <button class="btn btn-primary" id="league-join-code-btn">Join</button>
      </div>
      <p class="league-form-status" id="league-join-status" role="status" aria-live="polite"></p>
    </div>
  `;
  el.style.display = 'block';

  const nameInput = document.getElementById('league-name-input');
  const codeInput = document.getElementById('league-code-input');

  // Normalised as it is typed. Somebody will paste "  wpq7-k3nd rx " out of a
  // chat window, and a field that showed that back — or a lookup that failed
  // on a trailing space — would look broken when it is not. The SQL normalises
  // too; this is so the input never disagrees with what will be sent.
  codeInput.addEventListener('input', () => {
    const norm = normalizeLeagueKey(codeInput.value);
    if (norm !== codeInput.value) codeInput.value = norm;
  });

  document.getElementById('league-create-btn').addEventListener('click', createLeagueNow);
  document.getElementById('league-join-code-btn').addEventListener('click', joinLeagueByCode);

  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createLeagueNow(); });
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinLeagueByCode(); });
}

async function createLeagueNow() {
  const btn    = document.getElementById('league-create-btn');
  const input  = document.getElementById('league-name-input');
  const status = document.getElementById('league-create-status');
  if (!btn || btn.disabled) return;

  const name = String(input ? input.value : '').trim();
  if (!name) {
    leagueSetStatus(status, 'Give the league a name first.', 'error');
    if (input) input.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating…';
  leagueSetStatus(status, '', '');

  const res = await createLeague(name);

  if (!res || !res.league_key) {
    btn.disabled = false;
    btn.textContent = 'Create league';
    leagueSetStatus(status,
      (typeof lastLeagueError !== 'undefined' && lastLeagueError)
        || "Couldn't create that league — try again in a moment.",
      'error');
    return;
  }

  showLeagueCreated(res);
}

// The confirmation, with the code and the link, because the next thing that
// has to happen is sending it to somebody.
function showLeagueCreated(res) {
  const key  = String(res.league_key);
  const name = String(res.name ?? '');

  leagueHide('league-forms');
  leagueHide('league-loading');
  document.getElementById('league-title').textContent = name || 'League created';

  const el = document.getElementById('league-panel');
  el.innerHTML = `
    <div class="panel-head">
      <h2>Your league is ready</h2>
      <span class="panel-note">You own it</span>
    </div>
    <p class="league-lede">
      Send the code below to the people you want in it. They will need an
      account — the board is over the daily, and one attempt each only means
      something when everyone is somebody.
    </p>
    <div class="league-created-actions">
      <a class="btn btn-primary" href="leagues.html?l=${escapeHtml(encodeURIComponent(key))}">Open the board</a>
      <a href="daily.html">Play today's daily</a>
    </div>
  `;
  el.style.display = 'block';

  showLeagueInvite(key);
}

async function joinLeagueByCode() {
  const btn    = document.getElementById('league-join-code-btn');
  const input  = document.getElementById('league-code-input');
  const status = document.getElementById('league-join-status');
  if (!btn || btn.disabled) return;

  const code = normalizeLeagueKey(input ? input.value : '');
  if (!code) {
    leagueSetStatus(status, 'Paste the invite code somebody sent you.', 'error');
    if (input) input.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Joining…';
  leagueSetStatus(status, '', '');

  const res = await joinLeague(code);

  if (!res || !res.league_key) {
    btn.disabled = false;
    btn.textContent = 'Join';
    leagueSetStatus(status,
      (typeof lastLeagueError !== 'undefined' && lastLeagueError)
        || "Couldn't join that league — try again in a moment.",
      'error');
    return;
  }

  // Straight to the board. The URL has to change with it, or a refresh would
  // land back on the index.
  window.location.href = 'leagues.html?l=' + encodeURIComponent(String(res.league_key));
}

// ── 3/6. The join screen ──────────────────────────────────────
// Name, owner, member count, and what joining reveals. NO roster: get_league
// carries none, deliberately — an invite code should not be a directory of who
// is in it — and this screen does not invent one.

function showLeagueJoin(l) {
  leagueHide('league-loading');

  const name  = String(l.name ?? 'This league');
  const n     = leagueNumber(l.member_count) ?? 0;
  const max   = leagueNumber(l.max_members) ?? 100;
  const full  = n >= max;

  document.getElementById('league-title').textContent = name;
  renderLeagueMeta(l);

  const fullNote = full
    ? `<p class="league-warn">
         This league is full — it already has all ${escapeHtml(max)} of its members.
         Somebody has to leave before anyone else can join.
       </p>`
    : '';

  const el = document.getElementById('league-panel');
  el.innerHTML = `
    <div class="panel-head">
      <h2>Join ${escapeHtml(name)}?</h2>
      <span class="panel-note">${escapeHtml(n === 1 ? '1 member' : n + ' members')}</span>
    </div>

    <p class="league-lede">
      ${escapeHtml(leagueOwnerText(l.owner_username))}. There are
      ${escapeHtml(n)} of a maximum ${escapeHtml(max)} members.
    </p>

    <ul class="league-rules">
      <li><strong>The other members will see your username and your daily scores.</strong>
        That is what joining is — a league is a leaderboard, and a leaderboard
        is a list of names. Join people you are happy to be compared with.</li>
      <li><strong>It does not publish your profile.</strong> Your profile page
        stays exactly as private as it is now; the board links to a member's
        profile only when they have published it themselves.</li>
      <li><strong>The board is over Zetamac Daily.</strong> Same questions,
        same day, one attempt each — the only comparison here that is already
        fair.</li>
      <li><strong>You can leave whenever you like.</strong> Leaving takes you
        off the board, and you can rejoin later with the same code.</li>
    </ul>

    ${fullNote}

    <p class="league-noroster">
      Who else is in it is not shown until you join. An invite code is a way in,
      not a list of who is already here.
    </p>

    <div class="league-start-row">
      <button class="btn-start" id="league-join-btn"${full ? ' disabled' : ''}>Join this league</button>
      <span class="league-form-status" id="league-join-status" role="status" aria-live="polite"></span>
    </div>
  `;
  el.style.display = 'block';

  const btn = document.getElementById('league-join-btn');
  if (btn && !full) btn.addEventListener('click', joinThisLeague);
}

async function joinThisLeague() {
  const btn    = document.getElementById('league-join-btn');
  const status = document.getElementById('league-join-status');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = 'Joining…';
  leagueSetStatus(status, '', '');

  const res = await joinLeague(leagueKey);

  if (!res || !res.league_key) {
    btn.disabled = false;
    btn.textContent = 'Join this league';
    leagueSetStatus(status,
      (typeof lastLeagueError !== 'undefined' && lastLeagueError)
        || "Couldn't join that league — try again in a moment.",
      'error');
    return;
  }

  // join_league returns the league payload, so the board can be rendered from
  // it directly rather than round-tripping get_league again.
  leaguePayload = res;
  resetLeagueView();
  leagueShow('league-back', 'inline-block');
  await showLeagueBoardView(res);
}

// ── 4. The board ──────────────────────────────────────────────

async function showLeagueBoardView(l) {
  leagueHide('league-loading');

  document.getElementById('league-title').textContent = String(l.name ?? 'League');
  renderLeagueMeta(l);

  renderLeagueScopes();
  leagueShow('league-board-panel');

  showLeagueInvite(String(l.league_key ?? leagueKey));
  renderLeagueManage(l);

  await loadLeagueBoard(leagueScope);
}

function renderLeagueScopes() {
  const el = document.getElementById('league-scopes');
  el.innerHTML = LEAGUE_SCOPES.map(s =>
    `<button class="league-scope-btn${s.id === leagueScope ? ' active' : ''}" data-scope="${s.id}">${s.label}</button>`
  ).join('');

  el.querySelectorAll('.league-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.scope;
      if (!scope || scope === leagueScope) return;
      leagueScope = scope;
      el.querySelectorAll('.league-scope-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.scope === leagueScope));
      loadLeagueBoard(leagueScope);
    });
  });
}

async function loadLeagueBoard(scope) {
  const board = document.getElementById('league-board');
  const note  = document.getElementById('league-board-note');
  if (!board) return;

  // Two clicks in quick succession would otherwise let the slower response
  // paint over the faster one; the payload echoes `scope` back for exactly
  // this reason, and the sequence number covers the rest.
  const seq = ++leagueBoardSeq;

  board.innerHTML = '<p class="league-board-empty">Loading…</p>';
  note.textContent = '';

  const data = await getLeagueBoard(leagueKey, scope);
  if (seq !== leagueBoardSeq) return;

  if (!data) {
    // Every sentence here comes from LEAGUE_REFUSALS in js/db.js — a raised
    // 'league_forbidden' becomes "Only members can see this league", never a
    // SQLSTATE. The raw message is logged there and shown nowhere.
    const msg = (typeof lastLeagueError !== 'undefined' && lastLeagueError)
      || "This league's board couldn't be loaded right now.";
    board.innerHTML = `<p class="league-board-empty">${escapeHtml(msg)}</p>`;
    return;
  }

  const rows    = Array.isArray(data.rows) ? data.rows : [];
  const shown   = String(data.scope || scope);
  const members = leagueNumber(data.member_count) ?? rows.length;

  note.textContent = leagueScopeNote(shown, data, members);

  if (!rows.length) {
    board.innerHTML = `<p class="league-board-empty">This league has no members yet.</p>`;
    return;
  }

  const headers = leagueBoardHeaders(shown);
  board.innerHTML = `
    <table class="league-board-table">
      <thead><tr>${headers}</tr></thead>
      <tbody>${rows.map(r => leagueBoardRow(r, shown)).join('')}</tbody>
    </table>
    <p class="league-board-foot">${escapeHtml(leagueScopeFoot(shown, data))}</p>
  `;
}

function leagueScopeNote(scope, data, members) {
  const who = members === 1 ? '1 member' : members + ' members';
  if (scope === 'week') {
    const days = leagueNumber(data.window_days);
    return `${who} · mean of the last ${days === null ? 7 : days} puzzles`;
  }
  if (scope === 'best') return `${who} · best daily score ever`;
  const date = String(data.puzzle_date ?? '');
  return date ? `${who} · ${date}` : who;
}

function leagueScopeFoot(scope, data) {
  if (scope === 'week') {
    const days = leagueNumber(data.window_days);
    return 'A mean, not a total, so playing more days cannot win it on its own — '
      + `the puzzle count beside each score says how much of the last ${days === null ? 7 : days} it is drawn from.`;
  }
  if (scope === 'best') {
    return 'Everyone’s best daily score, whenever they set it.';
  }
  return "Today's puzzle. Members who haven't played it yet are listed at the bottom, "
    + 'because a league of six where two are missing is still a league of six.';
}

function leagueBoardHeaders(scope) {
  if (scope === 'week') {
    return '<th class="col-rank">#</th><th>Member</th><th class="col-num">Mean</th><th class="col-num">Puzzles</th>';
  }
  if (scope === 'best') {
    return '<th class="col-rank">#</th><th>Member</th><th class="col-num">Best</th><th class="col-num">Dailies</th>';
  }
  return '<th class="col-rank">#</th><th>Member</th><th class="col-num">Score</th>';
}

// One board row. Everything user-controlled in here — the username — is
// escaped, and `played` / `is_public` are read as the flags they are rather
// than inferred from whether a field happened to be null.
function leagueBoardRow(r, scope) {
  const mine   = r.is_you === true;
  const played = r.played === true;

  // A rank for somebody who has not played is a placing in a race they did not
  // enter. The SQL gives every non-player the same trailing rank (NULLS LAST);
  // showing it as a number would read as a result.
  const rank = played ? (leagueNumber(r.rank) ?? '—') : '—';

  const score = played
    ? escapeHtml(leagueScoreText(r.score))
    : '<span class="league-noplay">hasn’t played</span>';

  const games = leagueNumber(r.games);
  const gamesCell = (scope === 'week' || scope === 'best')
    ? `<td class="col-num">${played && games !== null ? escapeHtml(games) : '—'}</td>`
    : '';

  return `
    <tr class="${mine ? 'is-you' : ''}${played ? '' : ' league-row-idle'}">
      <td class="col-rank">${escapeHtml(rank)}</td>
      <td class="col-name">${leagueMemberName(r)}${mine ? '<span class="league-you-tag">you</span>' : ''}${r.is_owner === true ? '<span class="league-owner-tag">owner</span>' : ''}</td>
      <td class="col-num">${score}</td>
      ${gamesCell}
    </tr>
  `;
}

// A member's name, LINKED only when they have published their profile.
//
// This is the whole point of `is_public` on a board row. Membership does not
// publish anybody — supabase/leagues.sql never touches profiles.is_public —
// so linking a private member's name would produce a dead link that tells the
// viewer the profile does not exist, which is both broken and a small leak of
// somebody else's setting.
function leagueMemberName(r) {
  const u = String(r.username ?? '').trim();
  if (!u) return '<span class="league-noname">member without a username</span>';
  if (r.is_public === true) {
    return `<a href="profile.html?u=${escapeHtml(encodeURIComponent(u))}">${escapeHtml(u)}</a>`;
  }
  return escapeHtml(u);
}

// today and best are whole numbers; week is a mean rounded to one decimal by
// the database. Trailing ".0" is noise, so it goes.
function leagueScoreText(score) {
  const n = leagueNumber(score);
  if (n === null) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ── 5. Leaving ────────────────────────────────────────────────
// What leaving does is said BEFORE the button, because two of the three
// outcomes are irreversible for somebody. What it DID is taken from the
// leave_league payload afterwards, never assumed from what was predicted —
// the last member can stop being the last member between the two.

function renderLeagueManage(l) {
  const el = document.getElementById('league-manage');
  el.innerHTML = `
    <div class="panel-head">
      <h2>Membership</h2>
      <span class="panel-note">${l.is_owner === true ? 'You own this league' : 'You are a member'}</span>
    </div>
    <p class="league-leave-warn">${escapeHtml(leagueLeaveWarning(l))}</p>
    <div class="league-leave-row" id="league-leave-row"></div>
    <p class="league-form-status" id="league-leave-status" role="status" aria-live="polite"></p>
  `;
  el.style.display = 'block';
  renderLeagueLeaveButton();
}

function leagueLeaveWarning(l) {
  const n = leagueNumber(l.member_count) ?? 0;
  if (n <= 1) {
    return 'You are the only member, so leaving deletes this league outright. '
      + 'Its invite code stops working, and nobody — including you — can rejoin it.';
  }
  if (l.is_owner === true) {
    return 'You own this league. Leaving hands it to whoever has been in it longest, '
      + 'and the league and its code carry on without you. A league with no owner would be '
      + 'unreachable, so ownership always moves rather than being dropped.';
  }
  return 'Leaving takes you off the board and stops your daily scores appearing to the '
    + 'other members. Nothing else changes, and you can rejoin later with the same code.';
}

function renderLeagueLeaveButton() {
  const row = document.getElementById('league-leave-row');
  if (!row) return;

  if (!leagueLeaveArmed) {
    row.innerHTML = `<button class="btn" id="league-leave-btn">Leave this league</button>`;
    document.getElementById('league-leave-btn').addEventListener('click', () => {
      leagueLeaveArmed = true;
      renderLeagueLeaveButton();
    });
    return;
  }

  // The second click, and it is deliberately a different button in a different
  // place — a single-click "Leave" beside a board is one mis-tap away from
  // deleting a league.
  const name = String((leaguePayload && leaguePayload.name) || 'this league');
  row.innerHTML = `
    <span class="league-leave-confirm">Leave ${escapeHtml(name)}?</span>
    <button class="btn btn-danger" id="league-leave-confirm-btn">Yes, leave</button>
    <button class="btn" id="league-leave-cancel-btn">Cancel</button>
  `;
  document.getElementById('league-leave-confirm-btn').addEventListener('click', leaveThisLeague);
  document.getElementById('league-leave-cancel-btn').addEventListener('click', () => {
    leagueLeaveArmed = false;
    renderLeagueLeaveButton();
  });
}

async function leaveThisLeague() {
  const btn    = document.getElementById('league-leave-confirm-btn');
  const status = document.getElementById('league-leave-status');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = 'Leaving…';
  leagueSetStatus(status, '', '');

  const res = await leaveLeague(leagueKey);

  if (!res || res.left !== true) {
    btn.disabled = false;
    btn.textContent = 'Yes, leave';
    leagueSetStatus(status,
      (typeof lastLeagueError !== 'undefined' && lastLeagueError)
        || "Couldn't leave that league — try again in a moment.",
      'error');
    return;
  }

  showLeagueLeft(res);
}

// What actually happened, from the payload rather than from what the warning
// predicted. leave_league reports all three outcomes explicitly for this
// reason: the last member can stop being the last member while the page is
// open, and an owner can stop being the owner.
function showLeagueLeft(res) {
  resetLeagueView();
  leagueHide('league-loading');

  const name = String(res.name || (leaguePayload && leaguePayload.name) || 'that league');
  const n    = leagueNumber(res.member_count) ?? 0;

  let heading = 'You left ' + name;
  let body    = '';

  if (res.league_deleted === true) {
    heading = name + ' has been deleted';
    body = 'You were its last member, so the league went with you. Its invite code '
      + 'no longer resolves, and a league with no members is litter rather than history.';
  } else if (res.ownership_transferred === true) {
    const owner = String(res.new_owner_username ?? '').trim();
    body = 'You owned it, so ownership passed to '
      + (owner ? owner : 'the member who has been in it longest')
      + '. ' + (n === 1 ? 'One member remains.' : n + ' members remain.')
      + ' Your scores no longer appear on its board.';
  } else {
    body = (n === 1 ? 'One member remains.' : n + ' members remain.')
      + ' Your scores no longer appear on its board, and you can rejoin later with the same code.';
  }

  const el = document.getElementById('league-notice');
  el.innerHTML = `
    <strong>${escapeHtml(heading)}.</strong>
    <p>${escapeHtml(body)}</p>
    <div class="league-notice-actions">
      <a class="btn btn-primary" href="leagues.html">Your leagues</a>
      <a href="daily.html">Play today's daily</a>
    </div>
  `;
  el.style.display = 'block';
  document.getElementById('league-title').textContent = 'Left the league';
}

// ── The invite code and its link ──────────────────────────────

function showLeagueInvite(key) {
  const wrap  = document.getElementById('league-share');
  const field = document.getElementById('league-share-text');
  const code  = document.getElementById('league-code');
  if (!wrap || !field) return;

  // textContent: the code came off a payload, and this file does not decide
  // what is in it.
  if (code) code.textContent = String(key);

  const url = leagueUrlFor(key);
  field.value = url;
  wrap.style.display = 'block';
  wireLeagueCopyButton(url);
}

// Text clipboard writes fail in situations real people are actually in — any
// plain-http page (isSecureContext false) and older Safari — so the fallback
// is chosen up front rather than after a rejection they have already waited
// on. The link is always visible in the field, so manual copy is the floor.
// Same shape, and the same reasoning, as copyDuelLink() in js/duel.js and
// copyDailyShare() in js/daily.js.
function leagueCanCopyText() {
  try {
    return !!(window.isSecureContext
      && navigator.clipboard
      && typeof navigator.clipboard.writeText === 'function');
  } catch (_) {
    return false;
  }
}

async function copyLeagueLink(text) {
  if (leagueCanCopyText()) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch (e) {
      console.warn('league link: clipboard write failed, falling back:', e);
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    if (ok) return 'copied';
  } catch (e) {
    console.warn('league link: execCommand copy failed:', e);
  }

  return 'manual';
}

function wireLeagueCopyButton(url) {
  const btn    = document.getElementById('league-share-btn');
  const status = document.getElementById('league-share-status');
  const field  = document.getElementById('league-share-text');
  if (!btn) return;

  // The button survives across states, so replace it rather than stacking a
  // second listener that copies a stale link.
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);

  fresh.addEventListener('click', async () => {
    if (fresh.disabled) return;
    fresh.disabled = true;

    const outcome = await copyLeagueLink(url);

    fresh.disabled = false;
    // Which of the two happened is always said out loud. A button that
    // silently did nothing is indistinguishable from one that worked.
    if (outcome === 'copied') {
      status.textContent = 'Copied — paste it anywhere.';
      status.className   = 'league-share-status is-ok';
    } else {
      status.textContent = "This browser wouldn't let the page copy. The link is selected — press Ctrl/Cmd+C.";
      status.className   = 'league-share-status is-error';
      if (field) { field.focus(); field.select(); }
    }
  });
}

// ── 7. Unknown code, and no migration ─────────────────────────

function showLeagueNotFound() {
  leagueHide('league-loading');
  document.getElementById('league-title').textContent = 'No such league';

  const el = document.getElementById('league-notice');
  el.innerHTML = `
    <strong>There's no league with that code.</strong>
    <p>
      Either the code was mistyped or the league has been deleted — a league
      disappears when its last member leaves. Codes are ten characters and
      never contain the letters I, L, O or U, or the digits 0 or 1, so those
      are the ones worth checking.
    </p>
    <div class="league-notice-actions">
      <a class="btn btn-primary" href="leagues.html">Your leagues</a>
      <a href="daily.html">Play today's daily</a>
    </div>
  `;
  el.style.display = 'block';
}

function showLeagueUnavailable() {
  leagueHide('league-loading');
  document.getElementById('league-title').textContent = 'Leagues are unavailable';

  // Literal text only — the database's own message is logged, never shown.
  const el = document.getElementById('league-notice');
  el.innerHTML = `
    <strong>Leagues aren't available right now.</strong>
    <p>
      The page couldn't reach the league service. This is usually temporary —
      try again in a moment.
    </p>
    <div class="league-notice-actions">
      <a href="daily.html">Play the daily</a>
      <a href="index.html">Play a solo game</a>
    </div>
  `;
  el.style.display = 'block';
}

// ── Shell helpers ─────────────────────────────────────────────

function renderLeagueMeta(l) {
  const el = document.getElementById('league-meta');
  if (!el) return;
  const bits = [];
  const owner = String(l && l.owner_username ? l.owner_username : '').trim();
  if (owner) bits.push('owned by ' + owner);
  const n = leagueNumber(l && l.member_count);
  if (n !== null) {
    const max = leagueNumber(l && l.max_members) ?? 100;
    bits.push(`${n} of ${max} members`);
  }
  if (l && l.league_key) bits.push('code ' + String(l.league_key));
  // textContent: the league name, the owner's username and the code are all
  // somebody else's text.
  el.textContent = bits.join(' · ');
}

function leagueSetStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = 'league-form-status' + (kind ? ' is-' + kind : '');
}

function leagueShow(id, display = 'block') {
  const el = document.getElementById(id);
  if (el) el.style.display = display;
}

function leagueHide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function leagueNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
