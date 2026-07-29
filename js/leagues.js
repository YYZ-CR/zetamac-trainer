// Leaderboards — leagues.html
//
// One page, two halves, in this order:
//
//   1. THE GLOBAL BOARDS. Three tabs — All-Time Best, Today's Best, Today's
//      Daily — from get_global_board(). No account needed, because a
//      leaderboard nobody can read while signed out is not a leaderboard, and
//      this is the one page worth landing a stranger on.
//   2. YOUR CLANS. A named group, an invite code, and its own board over the
//      daily. Accounts only.
//
// A clan board and a global board are the same object at two scales, and they
// are rendered to look like it: the same `.league-board-table`, the same
// rank / player / score columns, the same tab control. What a clan board adds
// — an owner tag, a "you" tag, members who have not played, and a puzzle count
// beside a mean — it adds because a clan has a fixed known ROSTER and the
// global boards have none. There is nobody a global board could list as
// missing, no owner to mark, and no mean to give a denominator for.
//
// The FILE, the ids, the classes and the RPCs all still say "league". The
// product says "clan". docs/leaderboards-design.md is where that gap is
// written down and why it is not worth a migration to close.
//
// The clan half is a small state machine over what get_league says, the same
// machine duel.html runs — resolve a payload, pick a state, render exactly one
// of them — because it is the same problem.
//
//   signed out      → what a clan is, and why this one needs an account.
//   no ?l=          → your clans, plus "create one" and "join with a code".
//   ?l=, not a      → the join screen: name, owner, member count, and what
//     member          joining reveals about you. Never a roster.
//   ?l=, member     → the board. Today / Week / Best.
//   owner leaving   → what leaving does BEFORE it is done, and what it
//                     actually did afterwards.
//   full clan       → say so on the join screen.
//   unknown code /  → a readable page, never a blank one.
//     no migration
//
// Five rules run through all of it:
//
//   * Accounts are required for a CLAN, and the copy says why rather than just
//     asking. The board ranks members by their result on the day's puzzle, and
//     one attempt per person cannot be enforced against an anonymous player —
//     they can come back as somebody else. That is the whole reason, and it is
//     the one thing a login wall owes the person it stops. The global boards
//     above it need no account at all, so the wall is on the smaller half.
//   * The roster belongs to members. get_league carries a member COUNT and no
//     names, and this file never invents any: the join screen has nothing to
//     list, and it does not pretend otherwise.
//   * `is_public` decides whether a username may be LINKED, never whether it
//     is shown. Joining a clan does not publish anybody's profile, so a member
//     who has not published theirs appears as plain text — not as a link to a
//     page that would tell the viewer the profile does not exist. A GLOBAL row
//     carries no such flag and is therefore never linked; see
//     globalBoardRow().
//   * A member who has not played shows as "hasn't played". Not as a zero,
//     which is a score they did not get, and not omitted, because a clan of
//     six where two are missing should look like a clan of six.
//   * An empty board and a failed board are different pages. Nobody having
//     played today is the ordinary case right now and reads as an invitation;
//     a board that could not be loaded says so. Rendering the first for the
//     second makes a broken deployment look like an unpopular site.
//
// Clan names and usernames are BOTH user-controlled, and a clan name is the
// more dangerous of the two: one person names a thing that many others then
// load. A global board is worse again — those usernames belong to strangers.
// Everything from a payload goes through escapeHtml() on its way to innerHTML,
// or through textContent.

// The three scopes get_league_board accepts, in the order they are offered.
// 'today' is first and is the default: it is the day's puzzle, and it is the
// reason to come back.
const LEAGUE_SCOPES = [
  { id: 'today', label: 'Today' },
  { id: 'week',  label: 'Week'  },
  { id: 'best',  label: 'Best'  },
];

// The three global boards, in the order they are offered. 'all_time' is first
// and is the default: it is the board a stranger landing here is asking about
// — who is best at this — and it is the only one of the three that is never
// empty once anybody has ever played.
//
// 'daily' was first in an earlier revision, on the argument that it is the
// most defensible ranking on the site: one puzzle, the same questions for
// everyone, one attempt. That is still true and is still what its own footer
// says, but it is an argument about trustworthiness rather than about what
// somebody opened the page to see, and it put the narrowest board in front of
// the broadest. It is now last, where it reads as the specialist board it is.
//
// The ids are the p_scope values get_global_board takes. GLOBAL_BOARD_SCOPES
// in js/db.js is the same list; this one carries the labels.
const GLOBAL_BOARDS = [
  { id: 'all_time', label: 'All-Time Best' },
  { id: 'today',    label: "Today's Best"  },
  { id: 'daily',    label: "Today's Daily" },
];

// How many rows to ask for. The server clamps its own maximum; this is how
// many a page can show before it stops being a leaderboard and starts being a
// directory.
const GLOBAL_BOARD_LIMIT = 25;

// The duration every global board is fixed at, used only until a payload
// arrives with its own. A 300-second run is not a better result, it is a
// longer one, so the boards restrict rather than mix — and the page has to say
// so before the first render, not after it.
const GLOBAL_BOARD_FALLBACK_SECONDS = 120;

// ── State ─────────────────────────────────────────────────────

let leagueKey      = '';        // from ?l= or /l/<code>, normalised
let leaguePayload  = null;      // last get_league / join_league payload
let leagueScope    = 'today';   // which board is on screen
let leagueBoardSeq = 0;         // guards against two scope clicks racing
let leagueLeaveArmed = false;   // the leave button's second click

// Kept in step with GLOBAL_BOARDS[0] rather than written out, so the default
// board and the first tab cannot drift apart — a reorder that left this on the
// old value would render three tabs with none of them active.
let globalScope    = GLOBAL_BOARDS[0].id;
let globalBoardSeq = 0;         // same race, same guard

// Which user the current view was built for. `undefined` means never resolved,
// which is distinct from null (resolved, signed out).
let leagueViewUserId = undefined;
let leagueResolving  = false;

// ── URL ───────────────────────────────────────────────────────

// leagues.html?l=<code>, or the clean /l/<code> a rewrite would serve. The
// clean form has to be read from the PATHNAME: a server-side rewrite is
// invisible to the browser, location.search is EMPTY, and a page that only
// looked at the query string would show "your clans" to somebody who
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

  leagueKey = readLeagueKeyFromUrl();

  // The global boards go up FIRST and do not wait for the session lookup: they
  // need no account, so a visitor with a slow or failing auth round trip still
  // gets the thing they came for. Only the index view has them — a clan's own
  // page is about that clan.
  if (!leagueKey) showGlobalBoards();

  // The auth bar is decoration: a broken client must not stop the page from
  // rendering a readable explanation of why clans are unavailable.
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

  await resolveLeagueState();
});

// ── The global boards ─────────────────────────────────────────
// Three tabs over get_global_board(). Nothing in here reads currentUser: the
// RPC is granted to `anon`, the payload carries no is_you flag, and the board
// looks exactly the same signed in as signed out. That is deliberate — it is
// the half of this page a stranger can use.

function showGlobalBoards() {
  const panel = document.getElementById('global-panel');
  if (!panel) return;
  panel.style.display = 'block';
  renderGlobalLede(GLOBAL_BOARD_FALLBACK_SECONDS);
  renderGlobalTabs();
  loadGlobalBoard(globalScope);
}

// The one sentence the design doc requires: how long the runs are, which runs
// count, and — the question somebody actually has — why a run of theirs that
// they remember scoring higher is not here. It is almost always the clock or
// the settings. Written from the payload's own duration where there is one, so
// the page cannot claim 120 while ranking something else.
function renderGlobalLede(seconds) {
  const el = document.getElementById('global-lede');
  if (!el) return;
  const s = leagueNumber(seconds) ?? GLOBAL_BOARD_FALLBACK_SECONDS;
  el.textContent =
    `Every board here ranks ${s}-second runs on the default settings — daily, `
    + 'duels and your own games all count. A custom game or a different clock is a '
    + 'different game, so it stays on your dashboard rather than out here.';
}

function renderGlobalTabs() {
  const el = document.getElementById('global-scopes');
  if (!el) return;

  // Toggle buttons with aria-pressed rather than role="tab": a real tablist
  // owes a screen reader arrow-key navigation and a wired-up tabpanel, and
  // claiming the role without them is worse than not claiming it. Same control
  // as the clan board's scope buttons, which is the point.
  el.innerHTML = GLOBAL_BOARDS.map(b =>
    `<button class="league-scope-btn${b.id === globalScope ? ' active' : ''}"`
    + ` aria-pressed="${b.id === globalScope}" data-scope="${b.id}">${escapeHtml(b.label)}</button>`
  ).join('');

  el.querySelectorAll('.league-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.scope;
      if (!scope || scope === globalScope) return;
      globalScope = scope;
      el.querySelectorAll('.league-scope-btn').forEach(b => {
        const on = b.dataset.scope === globalScope;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      loadGlobalBoard(globalScope);
    });
  });
}

async function loadGlobalBoard(scope) {
  const board = document.getElementById('global-board');
  const note  = document.getElementById('global-note');
  if (!board) return;

  // Two tab clicks in quick succession would otherwise let the slower response
  // paint over the faster one.
  const seq = ++globalBoardSeq;

  board.innerHTML = '<p class="league-board-empty">Loading…</p>';
  if (note) note.textContent = '';

  // db.js did not load at all, or is older than this page.
  if (typeof getGlobalBoard !== 'function') {
    showGlobalBoardError(board, 'Leaderboards are unavailable right now.');
    return;
  }

  const data = await getGlobalBoard(scope, GLOBAL_BOARD_LIMIT);
  if (seq !== globalBoardSeq) return;

  // A failure is NOT an empty board, and the two must never render the same.
  // An empty board says nobody has played yet; this says the page could not
  // find out. Confusing them makes a broken deployment look like a dead site.
  if (!data) {
    showGlobalBoardError(board,
      (typeof lastGlobalBoardError !== 'undefined' && lastGlobalBoardError)
        || 'Leaderboards are unavailable right now.');
    return;
  }

  const shown = String(data.scope || scope);
  renderGlobalLede(data.duration_seconds);

  // A row with no username has no name to show. get_global_board is specified
  // never to emit one; if one arrives anyway it is dropped rather than
  // rendered as a dash, because a row of anonymous placeholders at the top of
  // a public board is worse than a shorter board.
  const rows = (Array.isArray(data.rows) ? data.rows : [])
    .filter(r => r && String(r.username ?? '').trim() !== '');

  if (note) note.textContent = globalBoardNote(rows.length, data);

  if (!rows.length) {
    // An invitation, not a failure. Nobody having played today's puzzle yet is
    // the ordinary state of this board, and NO row is invented to fill it.
    board.innerHTML = `
      <p class="league-board-empty">${escapeHtml(globalBoardEmptyText(shown))}</p>
      <div class="league-notice-actions">
        <a class="btn btn-primary" href="daily.html">Play today's daily</a>
        <a href="duel.html">Start a duel</a>
      </div>
    `;
    return;
  }

  board.innerHTML = `
    <table class="league-board-table">
      <thead><tr><th class="col-rank">#</th><th>Player</th><th class="col-num">Score</th></tr></thead>
      <tbody>${rows.map(globalBoardRow).join('')}</tbody>
    </table>
    <p class="league-board-foot">${escapeHtml(globalBoardFoot(shown))}</p>
  `;
}

// Its own class, and its own words, so that "nobody has played" and "this did
// not load" cannot be mistaken for each other by a person or by a test.
function showGlobalBoardError(board, message) {
  board.innerHTML = `
    <p class="league-board-error">${escapeHtml(message)}</p>
    <p class="league-board-foot">This is usually temporary. The boards are not
      empty — the page could not reach them.</p>
    <div class="league-notice-actions">
      <button class="btn" id="global-retry-btn">Try again</button>
    </div>
  `;
  const btn = document.getElementById('global-retry-btn');
  if (btn) btn.addEventListener('click', () => loadGlobalBoard(globalScope));
}

// One global row: rank, name, score, and nothing else, because the payload
// carries nothing else.
//
// Names here are NOT links, and that is a decision rather than an oversight.
// get_global_board returns no `is_public` flag — by design, it returns no
// identifier of any kind beyond the name — so this page cannot tell a
// published profile from an unpublished one. Linking every name would send
// most people to "this profile is private", because a public profile is opt-in
// and off by default, and a link that usually fails teaches people not to
// press the ones that work.
//
// So the site keeps one rule everywhere: a linked username always means a
// published profile. A clan board has the flag and does link; a global board
// does not have it and does not.
function globalBoardRow(r) {
  const rank = leagueNumber(r.rank);
  return `
    <tr>
      <td class="col-rank">${escapeHtml(rank === null ? '—' : rank)}</td>
      <td class="col-name">${escapeHtml(String(r.username ?? '').trim())}</td>
      <td class="col-num">${escapeHtml(leagueScoreText(r.score))}</td>
    </tr>
  `;
}

// Beside the heading: how many players are on the board, and when it was read.
// Both come off the payload — a leaderboard that does not say how fresh it is
// invites the reader to assume it is live.
function globalBoardNote(count, data) {
  const who = count === 1 ? '1 player' : count + ' players';
  const at  = globalBoardTime(data && data.generated_at);
  return at ? `${who} · as of ${at}` : who;
}

function globalBoardTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

// The empty state, per board. Each one names the thing that would fill it and
// invites the reader to be it, because right now being first is genuinely
// available. None of them reports a failure, and none of them is a dash.
function globalBoardEmptyText(scope) {
  if (scope === 'today') {
    return 'No qualifying runs today yet. Play a default 120-second game, the daily '
      + 'or a duel, and this board opens with your name on it.';
  }
  if (scope === 'all_time') {
    return 'No qualifying runs yet at all. The first default 120-second game to '
      + 'finish starts this board off.';
  }
  return "Nobody has played today's daily yet. Play it and you hold rank 1 until "
    + 'somebody beats you.';
}

// What the ranking rule actually is, under each board. A leaderboard that does
// not say how it ranks is asking to be argued with.
function globalBoardFoot(scope) {
  if (scope === 'today') {
    return 'The best run today, one row per player, across your own games, the daily '
      + 'and duels. A tie goes to whoever got there first.';
  }
  if (scope === 'all_time') {
    return "Everyone's best run, whenever they set it. One row per player, so a "
      + 'second good run of your own never pushes somebody else down.';
  }
  return "Today's puzzle: the same questions for everyone, one attempt each. This "
    + 'is the only ranking here where everybody answered the same sequence.';
}

// Logging in or out changes which clan state applies — every clan RPC requires
// an account, so a signed-out visitor has no list and no clan board. The
// global boards above are unaffected and are not re-rendered.
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

    // ── 2. No code: your clans ──────────────────────────────
    if (!leagueKey) {
      await showLeagueIndex();
      return;
    }

    const l = await getLeague(leagueKey);

    if (!l) {
      // get_league returns SQL NULL for an unknown code and raises for
      // nothing a code-holder can trigger — so a null payload with no
      // recorded code is a real answer ("no such clan"), and a null payload
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
  // On the index view the heading belongs to the page, not to the clan half —
  // the global boards are above it and they are leaderboards too.
  document.getElementById('league-title').textContent = 'Leaderboards';
}

// ── 1. Signed out ─────────────────────────────────────────────
// Accounts are required here, unlike duels, and the copy has to earn that.
// The board ranks members by the day's puzzle, and one attempt per person is
// not enforceable against somebody who can come back as somebody else.

function showLeagueSignedOut() {
  leagueHide('league-loading');
  // On the index the heading stays "Leaderboards": the global boards above are
  // readable right now, and retitling the page after the half that is locked
  // would say the opposite.
  document.getElementById('league-title').textContent =
    leagueKey ? "You've been invited to a clan" : 'Leaderboards';

  const invited = leagueKey
    ? `<p>
         The invite works — it just needs an account behind it. Log in and
         this page will show you the clan and ask whether you want to join.
       </p>`
    : '';

  const el = document.getElementById('league-notice');
  el.innerHTML = `
    <strong>Clans need an account.</strong>
    <p>
      The boards above are open to everyone. A clan is the private version: a
      leaderboard over Zetamac Daily for a group you invite, where everyone
      gets the same questions on the same day, so the scores are directly
      comparable. Being 3rd of 6 behind people you know is the entire reason
      anyone practices.
    </p>
    <p>
      That only works with one attempt each, and one attempt can only be
      enforced against an account — an anonymous player can come back as
      somebody else, so an anonymous member could not be ranked and could not
      be told apart from a second one. A clan is also a group of known people:
      the others see a username, not a browser.
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

// ── 2. Your clans ─────────────────────────────────────────────

async function showLeagueIndex() {
  const leagues = await getMyLeagues();

  // null is a failed call, never "no clans" — getMyLeagues returns [] for
  // that. Getting the two the wrong way round would show somebody an empty
  // state while their clans were simply unreachable.
  if (leagues === null) {
    showLeagueUnavailable();
    return;
  }

  leagueHide('league-loading');

  const el = document.getElementById('league-panel');

  if (!leagues.length) {
    // An empty state that invites rather than reports. A dash here would be
    // the single least useful thing this page could say.
    el.innerHTML = `
      <div class="panel-head">
        <h2>You're not in a clan yet</h2>
      </div>
      <p class="league-lede">
        A clan is a private leaderboard over Zetamac Daily — same questions,
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
        <h2>Your clans</h2>
        <span class="panel-note">${escapeHtml(leagues.length)} of 20</span>
      </div>
      <ul class="league-list">${rows}</ul>
    `;
  }
  el.style.display = 'block';

  renderLeagueForms();
}

// One clan in the index list. `name` and `owner_username` are both
// user-controlled and both reach innerHTML.
function leagueIndexRow(l) {
  const key   = String(l.league_key ?? '');
  const name  = String(l.name ?? 'Untitled clan');
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
// dropping the clan out of the caller's own list.
function leagueOwnerText(username) {
  const u = String(username ?? '').trim();
  return u ? 'owned by ' + u : 'owner has no username yet';
}

// Create and join, side by side, below whichever list state rendered above.
function renderLeagueForms() {
  const el = document.getElementById('league-forms');
  el.innerHTML = `
    <div class="panel league-form-panel">
      <div class="panel-head"><h2>Create a clan</h2></div>
      <p class="league-lede">
        You get an invite code to send round. Anyone with the code can join,
        so send it to people, not to the internet.
      </p>
      <div class="league-form-row">
        <label class="league-form-label" for="league-name-input">Name</label>
        <input type="text" id="league-name-input" class="league-form-input"
               maxlength="60" placeholder="Desk Six" autocomplete="off">
        <button class="btn btn-primary" id="league-create-btn">Create clan</button>
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
    leagueSetStatus(status, 'Give the clan a name first.', 'error');
    if (input) input.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating…';
  leagueSetStatus(status, '', '');

  const res = await createLeague(name);

  if (!res || !res.league_key) {
    btn.disabled = false;
    btn.textContent = 'Create clan';
    leagueSetStatus(status,
      (typeof lastLeagueError !== 'undefined' && lastLeagueError)
        || "Couldn't create that clan — try again in a moment.",
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
  // The view is about this clan now, not about the index it was reached from,
  // so the global boards step aside and the way back appears.
  leagueHide('global-panel');
  leagueShow('league-back', 'inline-block');
  document.getElementById('league-title').textContent = name || 'Clan created';

  const el = document.getElementById('league-panel');
  el.innerHTML = `
    <div class="panel-head">
      <h2>Your clan is ready</h2>
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
        || "Couldn't join that clan — try again in a moment.",
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

  const name  = String(l.name ?? 'This clan');
  const n     = leagueNumber(l.member_count) ?? 0;
  const max   = leagueNumber(l.max_members) ?? 100;
  const full  = n >= max;

  document.getElementById('league-title').textContent = name;
  renderLeagueMeta(l);

  const fullNote = full
    ? `<p class="league-warn">
         This clan is full — it already has all ${escapeHtml(max)} of its members.
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
        That is what joining is — a clan is a leaderboard, and a leaderboard
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
      <button class="btn-start" id="league-join-btn"${full ? ' disabled' : ''}>Join this clan</button>
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
    btn.textContent = 'Join this clan';
    leagueSetStatus(status,
      (typeof lastLeagueError !== 'undefined' && lastLeagueError)
        || "Couldn't join that clan — try again in a moment.",
      'error');
    return;
  }

  // join_league returns the clan payload, so the board can be rendered from
  // it directly rather than round-tripping get_league again.
  leaguePayload = res;
  resetLeagueView();
  leagueShow('league-back', 'inline-block');
  await showLeagueBoardView(res);
}

// ── 4. The board ──────────────────────────────────────────────

async function showLeagueBoardView(l) {
  leagueHide('league-loading');

  document.getElementById('league-title').textContent = String(l.name ?? 'Clan');
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
      || "This clan's board couldn't be loaded right now.";
    board.innerHTML = `<p class="league-board-empty">${escapeHtml(msg)}</p>`;
    return;
  }

  const rows    = Array.isArray(data.rows) ? data.rows : [];
  const shown   = String(data.scope || scope);
  const members = leagueNumber(data.member_count) ?? rows.length;

  note.textContent = leagueScopeNote(shown, data, members);

  if (!rows.length) {
    board.innerHTML = `<p class="league-board-empty">This clan has no members yet.</p>`;
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
    + 'because a clan of six where two are missing is still a clan of six.';
}

// The same three columns a global board has — rank, player, score — because a
// clan board is the same object at a smaller scale. `week` and `best` add a
// fourth for the denominator: a mean without its puzzle count is a number
// somebody can argue with, and the global boards never show a mean.
function leagueBoardHeaders(scope) {
  if (scope === 'week') {
    return '<th class="col-rank">#</th><th>Player</th><th class="col-num">Mean</th><th class="col-num">Puzzles</th>';
  }
  if (scope === 'best') {
    return '<th class="col-rank">#</th><th>Player</th><th class="col-num">Best</th><th class="col-num">Dailies</th>';
  }
  return '<th class="col-rank">#</th><th>Player</th><th class="col-num">Score</th>';
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
      <span class="panel-note">${l.is_owner === true ? 'You own this clan' : 'You are a member'}</span>
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
    return 'You are the only member, so leaving deletes this clan outright. '
      + 'Its invite code stops working, and nobody — including you — can rejoin it.';
  }
  if (l.is_owner === true) {
    return 'You own this clan. Leaving hands it to whoever has been in it longest, '
      + 'and the clan and its code carry on without you. A clan with no owner would be '
      + 'unreachable, so ownership always moves rather than being dropped.';
  }
  return 'Leaving takes you off the board and stops your daily scores appearing to the '
    + 'other members. Nothing else changes, and you can rejoin later with the same code.';
}

function renderLeagueLeaveButton() {
  const row = document.getElementById('league-leave-row');
  if (!row) return;

  if (!leagueLeaveArmed) {
    row.innerHTML = `<button class="btn" id="league-leave-btn">Leave this clan</button>`;
    document.getElementById('league-leave-btn').addEventListener('click', () => {
      leagueLeaveArmed = true;
      renderLeagueLeaveButton();
    });
    return;
  }

  // The second click, and it is deliberately a different button in a different
  // place — a single-click "Leave" beside a board is one mis-tap away from
  // deleting a clan.
  const name = String((leaguePayload && leaguePayload.name) || 'this clan');
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
        || "Couldn't leave that clan — try again in a moment.",
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

  const name = String(res.name || (leaguePayload && leaguePayload.name) || 'that clan');
  const n    = leagueNumber(res.member_count) ?? 0;

  let heading = 'You left ' + name;
  let body    = '';

  if (res.league_deleted === true) {
    heading = name + ' has been deleted';
    body = 'You were its last member, so the clan went with you. Its invite code '
      + 'no longer resolves, and a clan with no members is litter rather than history.';
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
      <a class="btn btn-primary" href="leagues.html">All leaderboards</a>
      <a href="daily.html">Play today's daily</a>
    </div>
  `;
  el.style.display = 'block';
  document.getElementById('league-title').textContent = 'Left the clan';
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
      console.warn('clan invite link: clipboard write failed, falling back:', e);
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
    console.warn('clan invite link: execCommand copy failed:', e);
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
  document.getElementById('league-title').textContent = 'No such clan';

  const el = document.getElementById('league-notice');
  el.innerHTML = `
    <strong>There's no clan with that code.</strong>
    <p>
      Either the code was mistyped or the clan has been deleted — a clan
      disappears when its last member leaves. Codes are ten characters and
      never contain the letters I, L, O or U, or the digits 0 or 1, so those
      are the ones worth checking.
    </p>
    <div class="league-notice-actions">
      <a class="btn btn-primary" href="leagues.html">All leaderboards</a>
      <a href="daily.html">Play today's daily</a>
    </div>
  `;
  el.style.display = 'block';
}

function showLeagueUnavailable() {
  leagueHide('league-loading');
  // On the index the global boards may well have rendered fine, so the page
  // heading must not announce a total outage on behalf of the clan half alone.
  document.getElementById('league-title').textContent =
    leagueKey ? 'Clans are unavailable' : 'Leaderboards';

  // Literal text only — the database's own message is logged, never shown.
  const el = document.getElementById('league-notice');
  el.innerHTML = `
    <strong>Clans aren't available right now.</strong>
    <p>
      The page couldn't reach the clan service. This is usually temporary —
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
  // textContent: the clan name, the owner's username and the code are all
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
