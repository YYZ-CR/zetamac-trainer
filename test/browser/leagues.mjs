// Browser verification of leagues.html — the Leaderboards page — written
// against docs/leaderboards-design.md, docs/leagues-design.md and the payload
// shapes in supabase/leagues.sql.
//
// The page has two halves and this suite covers both: the GLOBAL boards from
// get_global_board(), which need no account, and the CLAN half, whose
// mechanics are unchanged from when it was called a league. The rename is
// pinned at the bottom by walking the rendered text of every page on the site
// for the word "league": ids, classes, hrefs and wire error codes still say
// it, and must; a sentence somebody reads must not.
//
// Every assertion below names a SPECIFIC expected string. This repo has three
// times shipped a green suite that only proved "something rendered" and was
// passing against the wrong page state, so a non-emptiness check is not a test
// here. Where a row must NOT say something — a member who has not played must
// not show a zero, a private member's name must not be a link — the assertion
// is on that row's own cells, not on the page as a whole, because the page as
// a whole contains plenty of other digits and plenty of other links.
import { chromium } from 'playwright';

// Playwright's bundled build and the one on PATH often disagree; point
// ZT_CHROMIUM at a specific binary when the default launch fails.
const EXE = process.env.ZT_CHROMIUM || undefined;
// Serve with `python3 -m http.server`, NOT `npx serve` — serve's clean-URLs
// default silently strips the query string on its /page.html -> /page
// redirect, which makes assertions pass against the wrong page state.
const BASE  = process.env.ZT_BASE  || 'http://127.0.0.1:8099';
const SHOTS = process.env.ZT_SHOTS || '/tmp/shots';
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log('  pass:', label); }
                           else { fail++; console.log('  FAIL:', label); } };

// Copy in these pages is wrapped across source lines, so a sentence in the DOM
// carries newlines and runs of spaces. Assertions on a whole sentence run
// against this rather than against a regex that has to know where the wrap is.
const flat = s => String(s || '').replace(/\s+/g, ' ');

// Stub CDN (jsdelivr is blocked in the sandbox) + a Supabase client whose
// rpc() is driven by `window.__rpc`. leagues.html loads no Chart.js, so there
// is no chart to stub and no blank-canvas failure mode to guard against.
const CDN = `
window.supabase = { createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session: window.__session ?? null }, error: null }),
    getUser:    async () => ({ data: { user: window.__session?.user ?? null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
    signOut: async () => ({ error: null }),
  },
  from: () => ({ select(){return this}, eq(){return this}, is(){return this},
                 order(){return this}, limit(){return this},
                 single: async () => ({ data: null, error: { message: 'stub' } }),
                 maybeSingle: async () => ({ data: null, error: null }),
                 insert: async () => ({ error: null }), update: async () => ({ error: null }),
                 upsert: async () => ({ error: null }) }),
  rpc: async (name, args) => {
    window.__rpcCalls = window.__rpcCalls || [];
    window.__rpcCalls.push([name, args]);
    // Mirrored into sessionStorage so a call made immediately before a
    // navigation (joining, which lands on the league's own URL) is still
    // inspectable afterwards. window.__rpcCalls does not survive that.
    // APPENDED, not replaced: the page after the navigation starts with an
    // empty window.__rpcCalls, and writing that over the log would erase the
    // very call the navigation was caused by.
    try {
      const log = JSON.parse(sessionStorage.getItem('__rpcLog') || '[]');
      log.push([name, args]);
      sessionStorage.setItem('__rpcLog', JSON.stringify(log));
    } catch (_) {}
    const h = (window.__rpc || {})[name];
    if (!h) return { data: null, error: { message: 'function ' + name + ' does not exist', code: 'PGRST202' } };
    const out = (typeof h === 'function' ? h(args) : h);
    // A handler may raise the way supabase/leagues.sql does: { __error: {...} }
    if (out && out.__error) return { data: null, error: out.__error };
    return { data: out, error: null };
  },
}) };
`;

async function newPage(browser, { theme = 'dark', session, rpc, storage } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/cdn.jsdelivr.net/**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: CDN }));
  await page.addInitScript(([t, s, r, st]) => {
    localStorage.setItem('zt_theme', t);
    for (const [k, v] of Object.entries(st || {})) localStorage.setItem(k, v);
    window.__session = s;
    // Handlers are shipped as source strings because addInitScript cannot
    // serialise functions.
    window.__rpc = {};
    for (const [k, v] of Object.entries(r)) window.__rpc[k] = eval('(' + v + ')');
  }, [theme, session ?? null, rpc ?? {}, storage ?? {}]);
  return { ctx, page, errors };
}

const SESSION = { user: { id: 'u1', email: 'a@b.c' } };
// A real-shaped code: ten characters from the 30-glyph alphabet, which
// excludes O/0/I/L/1/U.
const KEY = 'WPQ7K3NDRX';

// A get_league / join_league payload with the fields supabase/leagues.sql
// actually emits. Note there is no roster in it — that is the point.
function leaguePayload(over = {}) {
  return Object.assign({
    league_key:     KEY,
    name:           'Desk Six',
    owner_username: 'hexadecimal',
    member_count:   4,
    is_member:      true,
    is_owner:       false,
    max_members:    100,
    created_at:     '2026-07-01T00:00:00Z',
  }, over);
}

// Four members: the owner (published profile), the caller (unpublished), one
// more, and one who has not played today.
const TODAY_ROWS = [
  { rank: 1, username: 'hexadecimal', is_public: true,  score: 74,   played: true,  games: 1, is_you: false, is_owner: true  },
  { rank: 2, username: 'quietstorm',  is_public: false, score: 58,   played: true,  games: 1, is_you: true,  is_owner: false },
  { rank: 3, username: 'marchhare',   is_public: true,  score: 41,   played: true,  games: 1, is_you: false, is_owner: false },
  { rank: 4, username: 'sleepydog',   is_public: false, score: null, played: false, games: 0, is_you: false, is_owner: false },
];

const WEEK_ROWS = [
  { rank: 1, username: 'hexadecimal', is_public: true,  score: 61.5, played: true,  games: 7, is_you: false, is_owner: true  },
  { rank: 2, username: 'quietstorm',  is_public: false, score: 55.2, played: true,  games: 4, is_you: true,  is_owner: false },
  { rank: 3, username: 'marchhare',   is_public: true,  score: 40,   played: true,  games: 2, is_you: false, is_owner: false },
  { rank: 4, username: 'sleepydog',   is_public: false, score: null, played: false, games: 0, is_you: false, is_owner: false },
];

function boardPayload(over = {}) {
  return Object.assign({
    league_key:   KEY,
    name:         'Desk Six',
    scope:        'today',
    member_count: 4,
    puzzle_date:  '2026-07-28',
    window_days:  null,
    rows:         TODAY_ROWS,
  }, over);
}

const src = v => JSON.stringify(v);

// ── The global boards ────────────────────────────────────────
// get_global_board(p_scope, p_limit) → { scope, duration_seconds,
// generated_at, rows: [{ rank, username, score }] }. Three distinct boards
// with DIFFERENT rows and different lengths, so "the tab switched" cannot pass
// by rendering the same table three times.
const GLOBAL_DAILY_ROWS = [
  { rank: 1, username: 'hexadecimal', score: 91 },
  { rank: 2, username: 'quietstorm',  score: 77 },
  { rank: 3, username: 'marchhare',   score: 64 },
];
const GLOBAL_TODAY_ROWS = [
  { rank: 1, username: 'sleepydog',   score: 103 },
  { rank: 2, username: 'hexadecimal', score: 91  },
];
const GLOBAL_ALLTIME_ROWS = [
  { rank: 1, username: 'marchhare',   score: 142 },
  { rank: 2, username: 'sleepydog',   score: 118 },
  { rank: 3, username: 'quietstorm',  score: 109 },
  { rank: 4, username: 'hexadecimal', score: 91  },
];

function globalPayload(scope, rows) {
  return { scope, duration_seconds: 120, generated_at: '2026-07-28T14:32:00Z', rows };
}

// STRICT: an unrecognised scope is an error, never a quiet fall back to the
// daily board. A client that sent the wrong p_scope would otherwise render a
// perfectly good table and pass.
const GLOBAL_HANDLER = `(a) => {
  const m = {
    daily:    ${src(globalPayload('daily', GLOBAL_DAILY_ROWS))},
    today:    ${src(globalPayload('today', GLOBAL_TODAY_ROWS))},
    all_time: ${src(globalPayload('all_time', GLOBAL_ALLTIME_ROWS))},
  };
  return m[a.p_scope] || { __error: { message: 'bad scope ' + a.p_scope } };
}`;

// Every rendered row of the global board, in DOM order.
async function globalRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#global-board .league-board-table tbody tr')].map(tr => ({
      cells: [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()),
      links: tr.querySelectorAll('a').length,
    })));
}

// The last get_global_board call, with its arguments.
async function lastGlobalCall(page) {
  return page.evaluate(() =>
    (window.__rpcCalls || []).filter(c => c[0] === 'get_global_board').pop());
}

// A board handler that answers all three scopes from one stub, so a scope
// switch is exercised end to end rather than mocked per test.
const BOARD_HANDLER = `(a) => {
  if (a.p_scope === 'week') return ${src(boardPayload({ scope: 'week', window_days: 7, rows: WEEK_ROWS }))};
  if (a.p_scope === 'best') return ${src(boardPayload({ scope: 'best', rows: WEEK_ROWS.map(r => ({ ...r, score: r.score === null ? null : Math.round(r.score) + 10, games: r.games * 3 })) }))};
  return ${src(boardPayload())};
}`;

// The cells of the board row whose Player column contains `name`.
async function boardRow(page, name) {
  return page.evaluate(n => {
    const rows = [...document.querySelectorAll('.league-board-table tbody tr')];
    const tr = rows.find(r => (r.querySelector('.col-name')?.textContent || '').includes(n));
    if (!tr) return null;
    return {
      cells: [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()),
      links: tr.querySelectorAll('a').length,
      hrefs: [...tr.querySelectorAll('a')].map(a => a.getAttribute('href')),
      isYou: tr.classList.contains('is-you'),
      idle:  tr.classList.contains('league-row-idle'),
      html:  tr.innerHTML,
    };
  }, name);
}

(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

  for (const theme of ['dark', 'zetamac']) {
    const tag = theme === 'dark' ? 'dark' : 'light';
    console.log(`\n══════ theme: ${tag} ══════`);

    // ── Global G1. The three boards, signed in ──────────────
    // The boards come FIRST on the page and are the reason a stranger would
    // land on it. Every expected rank, name and score is written out; a
    // non-emptiness check here would pass against the wrong board.
    {
      console.log('[G1 global boards — three tabs, three payloads]');
      const rpc = { get_my_leagues: `() => []`, get_global_board: GLOBAL_HANDLER };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      ok((await page.textContent('h1')).trim() === 'Leaderboards',
         'the page is called Leaderboards');
      ok((await page.title()).startsWith('Leaderboards'), 'and so is the document title');
      ok(await page.isVisible('#global-panel'), 'the global boards are on the index view');

      // The boards are above the clans. Not decoration: they are the half that
      // works without an account.
      const order = await page.evaluate(() => {
        const g = document.getElementById('global-panel');
        const c = document.getElementById('league-panel');
        return g.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING ? 'global-first' : 'clans-first';
      });
      ok(order === 'global-first', `the global boards come before the clans (${order})`);

      const tabs = await page.$$eval('#global-scopes .league-scope-btn',
        els => els.map(e => [e.textContent.trim(), e.dataset.scope, e.classList.contains('active')]));
      ok(JSON.stringify(tabs) === JSON.stringify([
        ["Today's Daily", 'daily', true],
        ["Today's Best", 'today', false],
        ['All-Time Best', 'all_time', false],
      ]), `three tabs, Today's Daily first and active (${JSON.stringify(tabs)})`);

      // The heading has to carry BOTH facts: 120 seconds, and server-scored
      // only. Somebody whose practice score is missing needs to know why
      // without asking.
      const lede = flat(await page.textContent('#global-lede'));
      ok(lede.includes('120-second runs'), `the copy says 120-second runs (got "${lede}")`);
      ok(/server scored itself/.test(lede), 'and that the server scored them');
      ok(/daily and duels/.test(lede), 'and names the two eligible sources');
      ok(/practice and solo runs stay on your own dashboard/.test(lede),
         'and says where a practice score went instead');

      // 1. Today's Daily.
      let rows = await globalRows(page);
      ok(JSON.stringify(rows.map(r => r.cells)) === JSON.stringify([
        ['1', 'hexadecimal', '91'], ['2', 'quietstorm', '77'], ['3', 'marchhare', '64'],
      ]), `the daily board is exactly its three rows in order (${JSON.stringify(rows.map(r => r.cells))})`);
      ok(rows.every(r => r.links === 0),
         'no row links anywhere — the payload carries no is_public, so nothing is linked');
      const head = await page.$$eval('#global-board .league-board-table th',
        els => els.map(e => e.textContent.trim()));
      ok(JSON.stringify(head) === JSON.stringify(['#', 'Player', 'Score']),
         `rank / player / score, the same columns a clan board has (${head})`);
      ok(flat(await page.textContent('#global-note')).includes('3 players'),
         'the note counts the players on the board');
      ok(/the same questions for everyone, one attempt each/.test(flat(await page.textContent('#global-board'))),
         'and the foot says how the daily board ranks');

      const first = await lastGlobalCall(page);
      ok(first && first[1].p_scope === 'daily', `the first call asked for daily (${first && first[1].p_scope})`);
      ok(first && typeof first[1].p_limit === 'number' && first[1].p_limit > 0,
         `and passed a numeric limit (${first && first[1].p_limit})`);
      await page.screenshot({ path: `${SHOTS}/global-1-daily-${tag}.png`, fullPage: true });

      // 2. Today's Best — the ARGUMENT is asserted, not just that something moved.
      await page.click('#global-scopes .league-scope-btn[data-scope="today"]');
      await page.waitForTimeout(400);
      const c2 = await lastGlobalCall(page);
      ok(c2 && c2[1].p_scope === 'today', `switching tabs sent p_scope=today (got ${c2 && c2[1].p_scope})`);
      rows = await globalRows(page);
      ok(JSON.stringify(rows.map(r => r.cells)) === JSON.stringify([
        ['1', 'sleepydog', '103'], ['2', 'hexadecimal', '91'],
      ]), `and rendered THAT board, two rows (${JSON.stringify(rows.map(r => r.cells))})`);
      ok(/A tie goes to whoever got there first/.test(flat(await page.textContent('#global-board'))),
         'the tiebreak is stated');
      await page.screenshot({ path: `${SHOTS}/global-2-today-${tag}.png`, fullPage: true });

      // 3. All-Time Best.
      await page.click('#global-scopes .league-scope-btn[data-scope="all_time"]');
      await page.waitForTimeout(400);
      const c3 = await lastGlobalCall(page);
      ok(c3 && c3[1].p_scope === 'all_time', `and p_scope=all_time (got ${c3 && c3[1].p_scope})`);
      rows = await globalRows(page);
      ok(JSON.stringify(rows.map(r => r.cells)) === JSON.stringify([
        ['1', 'marchhare', '142'], ['2', 'sleepydog', '118'],
        ['3', 'quietstorm', '109'], ['4', 'hexadecimal', '91'],
      ]), `four rows, all-time order (${JSON.stringify(rows.map(r => r.cells))})`);
      ok(/One row per player/.test(flat(await page.textContent('#global-board'))),
         'and says one row per player, so a second good run does not displace anybody');
      const active = await page.$$eval('#global-scopes .league-scope-btn.active',
        els => els.map(e => e.dataset.scope));
      ok(JSON.stringify(active) === JSON.stringify(['all_time']),
         `exactly one tab is active and it is the one showing (${active})`);
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/global-3-alltime-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── Global G2. Signed out ───────────────────────────────
    // The whole point of granting the RPC to anon. The boards render; the
    // clans below them ask for an account and say why.
    {
      console.log('[G2 global boards — signed OUT]');
      const rpc = { get_global_board: GLOBAL_HANDLER };
      const { ctx, page, errors } = await newPage(browser, { theme, session: null, rpc });
      await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      const rows = await globalRows(page);
      ok(JSON.stringify(rows.map(r => r.cells)) === JSON.stringify([
        ['1', 'hexadecimal', '91'], ['2', 'quietstorm', '77'], ['3', 'marchhare', '64'],
      ]), `signed out, the daily board still renders in full (${JSON.stringify(rows.map(r => r.cells))})`);
      ok(flat(await page.textContent('#global-lede')).includes('120-second runs'),
         'and still says what it is ranking');

      // Switching boards works signed out too — a read-only page that needs an
      // account to change tabs would be worse than no page.
      await page.click('#global-scopes .league-scope-btn[data-scope="all_time"]');
      await page.waitForTimeout(400);
      const call = await lastGlobalCall(page);
      ok(call && call[1].p_scope === 'all_time', 'and the tabs work without an account');
      ok((await globalRows(page)).length === 4, 'rendering the all-time board');

      const body = (await page.textContent('body')) || '';
      ok(body.includes('Clans need an account'), 'the clans half asks for an account');
      ok(await page.isVisible('#league-login-btn'), 'and offers a way to get one');
      ok(flat(body).includes('The boards above are open to everyone'),
         'and distinguishes itself from the boards, which are not gated');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/global-4-signedout-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── Global G3. An EMPTY board ───────────────────────────
    // The normal case right now, and it must read as an invitation. The
    // load-bearing assertion is the row COUNT: a placeholder row would satisfy
    // every "the empty copy is there" check.
    {
      console.log('[G3 global board — empty]');
      const rpc = {
        get_my_leagues: `() => []`,
        get_global_board: `(a) => ({ scope: a.p_scope, duration_seconds: 120,
          generated_at: '2026-07-28T14:32:00Z', rows: [] })`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      const rows = await globalRows(page);
      ok(rows.length === 0, `an empty board renders ZERO rows (got ${rows.length})`);
      const tables = await page.evaluate(() =>
        document.querySelectorAll('#global-board .league-board-table').length);
      ok(tables === 0, 'and no empty table shell either');

      const txt = flat(await page.textContent('#global-board'));
      ok(/Nobody has played today's daily yet/.test(txt),
         `the empty state says so plainly (got "${txt}")`);
      ok(/you hold rank 1 until somebody beats you/.test(txt),
         'and invites rather than reports');
      ok(!/unavailable|couldn't|error/i.test(txt),
         'and is NOT worded as a failure');
      ok(await page.evaluate(() =>
        document.querySelectorAll('#global-board .league-board-error').length) === 0,
         'and carries no error class');
      const links = await page.$$eval('#global-board a', els => els.map(e => e.getAttribute('href')));
      ok(links.includes('daily.html') && links.includes('duel.html'),
         `the invitation is actionable (${links})`);
      ok(!/undefined|NaN|\[object/i.test(txt), 'and invented nothing');

      // Switching to another empty board changes the sentence with the scope.
      await page.click('#global-scopes .league-scope-btn[data-scope="all_time"]');
      await page.waitForTimeout(400);
      ok((await globalRows(page)).length === 0, 'the all-time board is empty too');
      ok(/No server-scored runs yet at all/.test(flat(await page.textContent('#global-board'))),
         'and says something true of THAT board, not the daily one');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/global-5-empty-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── Global G4. The RPC fails ────────────────────────────
    // A broken deployment must not look like an unpopular site. This is the
    // pair to G3 and the two are asserted against each other.
    {
      console.log('[G4 global board — RPC error]');
      const rpc = {
        get_my_leagues: `() => []`,
        get_global_board: `() => ({ __error: { message: 'function get_global_board does not exist',
          code: 'PGRST202' } })`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      ok((await globalRows(page)).length === 0, 'a failed call renders no rows');
      const err = await page.evaluate(() => {
        const el = document.querySelector('#global-board .league-board-error');
        return el ? (el.textContent || '').trim() : null;
      });
      ok(err !== null, 'an error state is rendered, with its own class');
      ok(/Leaderboards are unavailable right now/.test(err || ''),
         `and says the boards could not be loaded (got "${err}")`);
      const txt = flat(await page.textContent('#global-board'));
      ok(/The boards are not empty/.test(txt),
         'and says explicitly that this is not an empty board');
      ok(!/Nobody has played/.test(txt),
         'the EMPTY copy is not shown for a FAILURE — the two are distinguishable');
      ok(!/PGRST202|does not exist|schema cache/i.test(txt),
         'the raw database error is not shown');
      ok(await page.isVisible('#global-retry-btn'), 'and a retry is offered');

      // The clan half is unaffected: two calls, two error slots.
      ok((await page.textContent('body')).includes("You're not in a clan yet"),
         'a failed global board does not take the clans down with it');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/global-6-error-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 1a. Signed out, no code ───────────────────────
    {
      console.log('[1a signed out — index]');
      const { ctx, page, errors } = await newPage(browser, { theme, session: null, rpc: {} });
      await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const body = (await page.textContent('body')) || '';
      ok(body.includes('Clans need an account'), 'a signed-out visitor is told an account is required for a CLAN');
      ok(flat(body).includes('one attempt can only be enforced against an account'),
         'and WHY: one attempt cannot be enforced anonymously');
      ok(flat(body).includes('an anonymous player can come back as somebody else'),
         'the reason is spelled out — an anonymous player can come back as somebody else');
      ok(await page.isVisible('#league-login-btn'), 'a log-in button is offered');
      ok(!(await page.isVisible('#league-forms')), 'no create/join forms are offered to a signed-out visitor');
      ok(!/undefined|NaN|\[object/i.test(body), 'no undefined/NaN leaked into the copy');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-1a-signedout-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 1b. Signed out, holding an invite ─────────────
    {
      console.log('[1b signed out — with an invite code]');
      const { ctx, page, errors } = await newPage(browser, { theme, session: null, rpc: {} });
      await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const body = (await page.textContent('body')) || '';
      ok(body.includes("You've been invited to a clan"), 'an invited visitor is greeted as invited');
      ok(/The invite works — it just needs an account behind it/.test(body),
         'and is told the invite is fine, it is the account that is missing');
      ok(!body.includes('Desk Six'), 'no clan detail is shown before signing in');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-1b-signedout-invite-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 2a. Index, empty ──────────────────────────────
    {
      console.log('[2a index — no leagues yet]');
      const rpc = { get_my_leagues: `() => []`, get_global_board: GLOBAL_HANDLER };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const body = (await page.textContent('body')) || '';
      ok(body.includes("You're not in a clan yet"), 'the empty state names itself');
      ok(flat(body).includes('send the code to four people you would actually like to beat'),
         'the empty state invites rather than reporting — it is not a dash');
      ok(body.includes('Create a clan'), 'a create form is offered');
      ok(body.includes('Join with a code'), 'a join-with-a-code form is offered');
      ok(await page.isVisible('#league-name-input'), 'the name field is there');
      ok(await page.isVisible('#league-code-input'), 'the code field is there');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-2a-index-empty-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 2b. Index, with leagues (a BARE ARRAY) ────────
    // get_my_leagues returns a bare JSON array, not { leagues: [...] }. A
    // client that ran it through unwrapRpc() would show exactly one league,
    // so the stub deliberately returns two and both must appear.
    {
      console.log('[2b index — two leagues, from a bare array]');
      const mine = [
        { league_key: KEY, name: 'Desk Six', owner_username: 'hexadecimal', member_count: 4,
          is_owner: false, max_members: 100, joined_at: '2026-07-02T00:00:00Z', created_at: '2026-07-01T00:00:00Z' },
        { league_key: 'ZK4M9TQBVR', name: 'Maths Club', owner_username: 'quietstorm', member_count: 12,
          is_owner: true, max_members: 100, joined_at: '2026-06-02T00:00:00Z', created_at: '2026-06-01T00:00:00Z' },
      ];
      const rpc = { get_my_leagues: `() => (${src(mine)})`, get_global_board: GLOBAL_HANDLER };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const body = (await page.textContent('body')) || '';
      ok(body.includes('Desk Six') && body.includes('Maths Club'),
         'BOTH clans render — the payload is a bare array, not an object wrapper');
      ok(body.includes('4 members of 100'), 'the member count and cap are shown');
      ok(body.includes('12 members of 100'), 'and for the second league too');
      ok(body.includes('owned by hexadecimal'), 'the owner of a clan you do not own is named');
      ok(body.includes('you own this'), 'a clan you own is marked as yours');
      const hrefs = await page.$$eval('.league-list-name', els => els.map(e => e.getAttribute('href')));
      ok(hrefs.includes(`leagues.html?l=${KEY}`), `each clan links to its own board (${hrefs.join(', ')})`);
      ok(body.includes('2 of 20'), 'the per-account cap is visible');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-2b-index-list-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 3. Holding a code, NOT a member ───────────────
    {
      console.log('[3 join screen — not a member]');
      const rpc = { get_league: `() => (${src(leaguePayload({ is_member: false, member_count: 6 }))})` };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const body = (await page.textContent('body')) || '';
      ok(body.includes('Join Desk Six?'), 'the clan is named on the join screen');
      ok(body.includes('owned by hexadecimal'), 'the owner is named');
      ok(body.includes('6 members'), 'the member count is shown');
      ok(/The other members will see your username and your daily scores/.test(body),
         'joining is said plainly to reveal username and daily scores');
      ok(/It does not publish your profile/.test(body),
         'and is distinguished from publishing a profile');
      ok(await page.isVisible('#league-join-btn'), 'a Join button is offered');

      // The payload has no roster and the screen must not invent one.
      const tables = await page.evaluate(() => document.querySelectorAll('.league-board-table').length);
      ok(tables === 0, 'no roster table is rendered on the join screen');
      ok(!/quietstorm|marchhare|sleepydog/.test(body),
         'no member names appear anywhere — an invite code is not a directory');
      ok(/not shown until you join/.test(body), 'and the page says so out loud');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-3-join-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 4. A member: the board ────────────────────────
    {
      console.log('[4 board — member]');
      const rpc = {
        get_league: `() => (${src(leaguePayload())})`,
        get_league_board: BOARD_HANDLER,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const body = (await page.textContent('body')) || '';

      ok((await page.textContent('#league-title')) === 'Desk Six', 'the clan name is the page title');
      ok(body.includes('74') && body.includes('58') && body.includes('41'),
         'the three played scores are on the board');
      ok(body.includes('4 members · 2026-07-28'), 'the note names the puzzle date and the size');

      const you = await boardRow(page, 'quietstorm');
      ok(you && you.isYou, "the caller's own row carries the is-you class");
      ok(you && you.cells[0] === '2' && you.cells[2] === '58', `own row reads rank 2, score 58 (${you && you.cells})`);
      ok(you && you.html.includes('league-you-tag'), 'and is tagged "you"');
      ok(you && you.links === 0,
         'an UNPUBLISHED profile is plain text, not a dead link');

      const owner = await boardRow(page, 'hexadecimal');
      ok(owner && owner.links === 1 && owner.hrefs[0] === 'profile.html?u=hexadecimal',
         `a PUBLISHED profile is linked (${owner && owner.hrefs})`);
      ok(owner && owner.html.includes('league-owner-tag'), 'the owner is marked as the owner');

      const idle = await boardRow(page, 'sleepydog');
      ok(idle !== null, 'a member who has not played still APPEARS on the board');
      ok(idle && /hasn[’']t played/.test(idle.cells[2]),
         `their score cell says "hasn't played" (got "${idle && idle.cells[2]}")`);
      ok(idle && !/\d/.test(idle.cells.join(' ')),
         `and contains no digit at all — not a 0, not a rank (got "${idle && idle.cells}")`);
      ok(idle && idle.idle, 'their row is marked idle');

      ok(await page.isVisible('#league-share-text'), 'the invite link is offered to a member');
      ok((await page.textContent('#league-code')) === KEY, 'the invite CODE is shown, not just the link');
      const link = await page.inputValue('#league-share-text');
      ok(link.endsWith(`/leagues.html?l=${KEY}`), `the invite link carries the code (got "${link}")`);
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-4-board-today-${tag}.png`, fullPage: true });

      // ── Scope switch: Week ────────────────────────────────
      await page.click('.league-scope-btn[data-scope="week"]');
      await page.waitForTimeout(400);
      const wBody = (await page.textContent('body')) || '';
      const call = await page.evaluate(() =>
        (window.__rpcCalls || []).filter(c => c[0] === 'get_league_board').pop());
      ok(call && call[1].p_scope === 'week', `the week board was requested (p_scope=${call && call[1].p_scope})`);
      ok(wBody.includes('61.5'), 'a one-decimal mean renders as 61.5, not 61 or 61.50');
      ok(wBody.includes('mean of the last 7 puzzles'), 'the window is stated');
      ok(/A mean, not a total/.test(wBody), 'and why it is a mean rather than a total');
      const wYou = await boardRow(page, 'quietstorm');
      ok(wYou && wYou.cells[3] === '4', `the puzzle count is carried alongside the mean (got "${wYou && wYou.cells[3]}")`);
      const wIdle = await boardRow(page, 'sleepydog');
      ok(wIdle && !/\d/.test(wIdle.cells.join(' ')),
         `a non-player shows no 0 in the week scope either (got "${wIdle && wIdle.cells}")`);
      await page.screenshot({ path: `${SHOTS}/leagues-4b-board-week-${tag}.png`, fullPage: true });

      // ── Scope switch: Best ────────────────────────────────
      await page.click('.league-scope-btn[data-scope="best"]');
      await page.waitForTimeout(400);
      const bBody = (await page.textContent('body')) || '';
      const bCall = await page.evaluate(() =>
        (window.__rpcCalls || []).filter(c => c[0] === 'get_league_board').pop());
      ok(bCall && bCall[1].p_scope === 'best', 'the best board was requested');
      ok(bBody.includes('best daily score ever'), 'the best scope says what it is');
      ok(bBody.includes('72'), 'the best-ever score renders (61.5 + 10 → 72)');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-4c-board-best-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 5. Owner leaving — ownership transfers ────────
    {
      console.log('[5 owner leaves — ownership transfers]');
      const rpc = {
        get_league: `() => (${src(leaguePayload({ is_owner: true, member_count: 6 }))})`,
        get_league_board: BOARD_HANDLER,
        leave_league: `() => ({ league_key: ${src(KEY)}, name: 'Desk Six', left: true,
          league_deleted: false, ownership_transferred: true,
          new_owner_username: 'quietstorm', member_count: 5 })`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      let body = (await page.textContent('body')) || '';
      ok(body.includes('You own this clan'), 'the owner is told they own it');
      ok(/Leaving hands it to whoever has been in it longest/.test(body),
         'the warning says what leaving does BEFORE the button is pressed');
      ok(!/deletes this clan outright/.test(body),
         'and does NOT threaten deletion when there are other members');

      await page.click('#league-leave-btn');
      await page.waitForTimeout(200);
      body = (await page.textContent('body')) || '';
      ok(body.includes('Leave Desk Six?'), 'leaving takes a second, explicit confirmation');
      ok(await page.isVisible('#league-leave-confirm-btn'), 'a confirm button appears');
      await page.screenshot({ path: `${SHOTS}/leagues-5-leave-confirm-${tag}.png`, fullPage: true });

      await page.click('#league-leave-confirm-btn');
      await page.waitForTimeout(400);
      body = (await page.textContent('body')) || '';
      ok(body.includes('You left Desk Six'), 'the outcome is reported');
      ok(/ownership passed to quietstorm/.test(body),
         'the NEW OWNER from the leave_league payload is named');
      ok(body.includes('5 members remain'), 'and the remaining count comes from the payload');
      ok(!/has been deleted/.test(body), 'the clan is not reported as deleted');
      ok(!(await page.isVisible('#league-board-panel')), 'the board is gone once you have left');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-5b-left-transferred-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 5b. Last member leaving — league deleted ──────
    {
      console.log('[5b last member leaves — league deleted]');
      const rpc = {
        get_league: `() => (${src(leaguePayload({ is_owner: true, member_count: 1 }))})`,
        get_league_board: `() => (${src(boardPayload({ member_count: 1, rows: [TODAY_ROWS[1]] }))})`,
        leave_league: `() => ({ league_key: ${src(KEY)}, name: 'Desk Six', left: true,
          league_deleted: true, ownership_transferred: false,
          new_owner_username: null, member_count: 0 })`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      let body = (await page.textContent('body')) || '';
      ok(/You are the only member, so leaving deletes this clan outright/.test(body),
         'the last member is warned that leaving DELETES the clan');
      ok(/invite code stops working/.test(body), 'and that its code stops working');

      await page.click('#league-leave-btn');
      await page.waitForTimeout(200);
      await page.click('#league-leave-confirm-btn');
      await page.waitForTimeout(400);
      body = (await page.textContent('body')) || '';
      ok(body.includes('Desk Six has been deleted'), 'the deletion is reported as a deletion');
      ok(/no longer resolves/.test(body), 'and the code is said to be dead');
      ok(!/ownership passed/.test(body), 'no ownership transfer is claimed');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-5c-left-deleted-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 6. Full league ────────────────────────────────
    {
      console.log('[6 full league]');
      const rpc = {
        get_league: `() => (${src(leaguePayload({ is_member: false, member_count: 100, max_members: 100 }))})`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const body = (await page.textContent('body')) || '';
      ok(/This clan is full — it already has all 100 of its members/.test(body),
         'a full clan says so on the join screen');
      ok(/Somebody has to leave before anyone else can join/.test(body),
         'and says what would have to change');
      ok(await page.isDisabled('#league-join-btn'), 'the Join button is disabled');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-6-full-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 7a. Unknown code (RPC returns SQL NULL) ───────
    {
      console.log('[7a unknown code]');
      const rpc = { get_league: `() => null` };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/leagues.html?l=ZZZZZZZZZZ`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const body = (await page.textContent('body')) || '';
      ok(body.includes("There's no clan with that code"), 'an unknown code gets its own page');
      ok(/never contain the letters I, L, O or U/.test(body),
         'and names the excluded glyphs, which is what a mistyped code usually is');
      ok(!/unavailable|couldn't reach/i.test(body),
         'and is NOT confused with an infrastructure failure');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-7a-notfound-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 7b. Migration not applied at all ──────────────
    {
      console.log('[7b RPCs missing]');
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc: {} });
      await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const body = (await page.textContent('body')) || '';
      ok(body.includes("Clans aren't available right now"),
         'a missing migration produces a readable page, not a blank one');
      ok(!/PGRST202|does not exist|schema cache/i.test(body),
         'the raw database error is not shown to the user');
      ok(!/undefined|NaN|\[object Object\]/.test(body), 'no raw objects leaked into the copy');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/leagues-7b-nomigration-${tag}.png`, fullPage: true });
      await ctx.close();
    }

    // ── State 7c. Index page with the migration missing ─────
    {
      console.log('[7c index with RPCs missing]');
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc: {} });
      await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const body = (await page.textContent('body')) || '';
      ok(body.includes("Clans aren't available right now"),
         'a failed get_my_leagues is not rendered as an empty clan list');
      ok(!body.includes("You're not in a clan yet"),
         'null and [] are NOT confused — a failed call is not an empty state');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }
  }

  // ══════ Theme-independent checks ══════
  console.log('\n══════ contract checks ══════');

  // A hostile CLAN NAME. One person names a thing that everybody else then
  // loads, which makes this the more dangerous of the two user-controlled
  // strings on the clan half of this page.
  {
    console.log('[hostile clan name]');
    const XSS = `<img src=x onerror="window.__pwned=1">`;
    const rpc = { get_league: `() => (${src(leaguePayload({ is_member: false, name: XSS }))})` };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const pwned = await page.evaluate(() => window.__pwned === 1);
    const imgs  = await page.evaluate(() => document.querySelectorAll('.league-wrap img').length);
    const body  = (await page.textContent('body')) || '';
    ok(!pwned, 'hostile clan name did NOT execute');
    ok(imgs === 0, 'hostile clan name produced no live element in the DOM');
    ok(body.includes(XSS), 'hostile clan name is rendered as literal text');
    ok((await page.textContent('#league-title')) === XSS, 'including in the page heading');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // A hostile USERNAME on the board, in both the linked and unlinked cases.
  {
    console.log('[hostile username on the board]');
    const XSS  = `<img src=x onerror="window.__pwned=1">`;
    const XSS2 = `<svg onload="window.__pwned2=1">`;
    const rows = [
      { rank: 1, username: XSS,  is_public: false, score: 80, played: true, games: 1, is_you: false, is_owner: false },
      { rank: 2, username: XSS2, is_public: true,  score: 70, played: true, games: 1, is_you: true,  is_owner: false },
    ];
    const rpc = {
      get_league: `() => (${src(leaguePayload())})`,
      get_league_board: `() => (${src(boardPayload({ member_count: 2, rows }))})`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => ({
      pwned: window.__pwned === 1 || window.__pwned2 === 1,
      imgs:  document.querySelectorAll('.league-wrap img').length,
      svgs:  document.querySelectorAll('.league-wrap svg').length,
    }));
    const body = (await page.textContent('body')) || '';
    ok(!state.pwned, 'hostile usernames did NOT execute');
    ok(state.imgs === 0 && state.svgs === 0,
       `hostile usernames produced no live element in the DOM (img ${state.imgs}, svg ${state.svgs})`);
    ok(body.includes(XSS) && body.includes(XSS2), 'both are rendered as literal text');
    const unpub = await boardRow(page, XSS);
    ok(unpub && unpub.links === 0, 'the unpublished hostile name is NOT a link');
    const pub = await boardRow(page, XSS2);
    ok(pub && pub.links === 1 && /^profile\.html\?u=%3Csvg/.test(pub.hrefs[0]),
       `the published one is a link with a percent-encoded href (${pub && pub.hrefs})`);
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // A refusal raised by the database arrives as `error`, not as a thrown JS
  // exception. get_league_board RAISEs league_forbidden (SQLSTATE 42501) for a
  // non-member; the page must say something a person can read, and must not
  // show a code or a SQLSTATE.
  {
    console.log('[non-member refused the board]');
    const rpc = {
      // Deliberately hostile: get_league claims membership, the board refuses.
      // That is the real race (leaving in another tab), and it is also the
      // only way to reach this branch without trusting the client.
      get_league: `() => (${src(leaguePayload())})`,
      get_league_board: `() => ({ __error: { message: 'league_forbidden', code: '42501',
        hint: 'Join this league to see its board.' } })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const body = (await page.textContent('body')) || '';
    ok(/Only members can see this clan/.test(body),
       'a raised refusal becomes a human sentence');
    ok(!/league_forbidden/.test(body), 'the raised code is NOT shown');
    ok(!/42501/.test(body), 'the SQLSTATE is NOT shown');
    ok(!/undefined|\[object Object\]/.test(body), 'and nothing raw leaked in its place');
    const tables = await page.evaluate(() => document.querySelectorAll('.league-board-table').length);
    ok(tables === 0, 'and no empty table is drawn in place of the refused board');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // league_full raised by join_league, rather than predicted from the count.
  {
    console.log('[join refused: league_full]');
    const rpc = {
      get_league: `() => (${src(leaguePayload({ is_member: false, member_count: 99 }))})`,
      join_league: `() => ({ __error: { message: 'league_full', code: '23514', hint: 'This league is full.' } })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html?l=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.click('#league-join-btn');
    await page.waitForTimeout(400);
    const status = (await page.textContent('#league-join-status')) || '';
    ok(/This clan is full — it already has the maximum of 100 members/.test(status),
       `league_full becomes a sentence that says CLAN (got "${status.trim()}")`);
    ok(!/league_full|23514/.test(await page.textContent('body')), 'the raw code is not shown');
    ok(await page.isEnabled('#league-join-btn'), 'the button is re-enabled so the page is not stuck');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // league_limit_reached raised by create_league.
  {
    console.log('[create refused: league_limit_reached]');
    const rpc = {
      get_my_leagues: `() => []`,
      create_league: `() => ({ __error: { message: 'league_limit_reached', code: '23514' } })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.fill('#league-name-input', 'One Too Many');
    await page.click('#league-create-btn');
    await page.waitForTimeout(400);
    const status = (await page.textContent('#league-create-status')) || '';
    ok(/already in the maximum of 20 clans/.test(status),
       `league_limit_reached becomes a sentence (got "${status.trim()}")`);
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // Create a league end to end: the name goes to the server, the code and the
  // invite link come back, and the copy button says which of the two things
  // happened when it is pressed.
  {
    console.log('[create a league → code, link, copy]');
    const rpc = {
      get_my_leagues: `() => []`,
      create_league: `(a) => ({ league_key: ${src(KEY)}, name: a.p_name })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.fill('#league-name-input', '  Desk Six  ');
    await page.click('#league-create-btn');
    await page.waitForTimeout(400);

    const sent = await page.evaluate(() => window.__rpcCalls.find(c => c[0] === 'create_league'));
    ok(sent && sent[1].p_name === 'Desk Six', `the trimmed name was sent (got "${sent && sent[1].p_name}")`);
    const body = (await page.textContent('body')) || '';
    ok(body.includes('Your clan is ready'), 'creation confirms');
    ok((await page.textContent('#league-code')) === KEY, 'the invite code is shown');
    const link = await page.inputValue('#league-share-text');
    ok(link.endsWith(`/leagues.html?l=${KEY}`), `the invite link carries the code (got "${link}")`);
    ok(!(await page.isVisible('#league-forms')), 'the forms step aside once the clan exists');

    await page.click('#league-share-btn');
    await page.waitForTimeout(400);
    const status = (await page.textContent('#league-share-status')) || '';
    ok(status === 'Copied — paste it anywhere.'
       || status.startsWith("This browser wouldn't let the page copy"),
       `the copy button SAYS which of the two happened (got "${status}")`);
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // A pasted code with the punctuation of wherever it was found. The field
  // must not look broken while it is being typed, and the server must get the
  // normalised form.
  {
    console.log('[hostile-ish paste into the join field]');
    // The stub echoes back the key it was given, so the URL joining lands on
    // is itself evidence of what was actually sent.
    const rpc = {
      get_my_leagues: `() => []`,
      get_league: `() => (${src(leaguePayload())})`,
      get_league_board: BOARD_HANDLER,
      join_league: `(a) => Object.assign(${src(leaguePayload())}, { league_key: a.p_key })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.fill('#league-code-input', '  wpq7-k3nd rx ');
    await page.waitForTimeout(150);
    const shown = await page.inputValue('#league-code-input');
    ok(shown === KEY, `the field normalises as you type (got "${shown}")`);

    await page.click('#league-join-code-btn');
    await page.waitForTimeout(700);
    const call = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('__rpcLog') || '[]').find(c => c[0] === 'join_league'));
    ok(call && call[1].p_key === KEY, `join_league received the normalised code (got ${call && call[1].p_key})`);
    ok(page.url().includes(`leagues.html?l=${KEY}`),
       `joining navigates to the league so a refresh still works (got ${page.url()})`);
    ok((await page.textContent('body')).includes('hexadecimal'),
       'and the board it lands on renders');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // The clean /l/<code> URL: a Vercel rewrite is server-side, so
  // location.search is EMPTY and only the pathname carries the code.
  {
    console.log('[clean /l/<code> URL]');
    const rpc = {
      get_league: `() => (${src(leaguePayload())})`,
      get_league_board: BOARD_HANDLER,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    // Stand in for the Vercel rewrite: /l/<code> serves leagues.html's bytes.
    // Its own relative assets then resolve under /l/, so those are mapped back
    // to the root — exactly what a real server does and what the browser
    // cannot see, which is the whole reason location.search is empty here.
    await page.route(`${BASE}/l/**`, async r => {
      const path = new URL(r.request().url()).pathname;
      const target = /^\/l\/[^/]+$/.test(path) ? '/leagues.html' : path.replace(/^\/l\//, '/');
      const res = await page.request.get(BASE + target);
      r.fulfill({
        status: res.status(),
        contentType: res.headers()['content-type'] || 'text/plain',
        body: await res.text(),
      });
    });
    await page.goto(`${BASE}/l/${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const search = await page.evaluate(() => window.location.search);
    ok(search === '', 'location.search really is empty on the clean URL');
    const call = await page.evaluate(() => (window.__rpcCalls || []).find(c => c[0] === 'get_league'));
    ok(call && call[1].p_key === KEY, `the code was read from the PATHNAME (got ${call ? call[1].p_key : 'no call'})`);
    ok((await page.textContent('body')).includes('hexadecimal'),
       'and the board rendered, not the index page');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // A lower-case /l/<code> is the same league: the rewrite passes the path
  // through verbatim and normalisation is the client's job before the call.
  {
    console.log('[clean URL, lower case]');
    const rpc = { get_league: `() => (${src(leaguePayload({ is_member: false }))})` };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.route(`${BASE}/l/**`, async r => {
      const path = new URL(r.request().url()).pathname;
      const target = /^\/l\/[^/]+$/.test(path) ? '/leagues.html' : path.replace(/^\/l\//, '/');
      const res = await page.request.get(BASE + target);
      r.fulfill({ status: res.status(),
                  contentType: res.headers()['content-type'] || 'text/plain',
                  body: await res.text() });
    });
    await page.goto(`${BASE}/l/${KEY.toLowerCase()}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const call = await page.evaluate(() => (window.__rpcCalls || []).find(c => c[0] === 'get_league'));
    ok(call && call[1].p_key === KEY, `a lower-case path is upper-cased before the call (got ${call && call[1].p_key})`);
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // The dashboard used to carry a compact copy of this list. It does not any
  // more — the dashboard is the five-tile record, the chart, the operation
  // bars and Recent Games, and nothing else. leagues.html owns every clan
  // state, and this is the guard against the panel quietly coming back.
  {
    console.log('[the dashboard no longer carries a clans panel]');
    const XSS = `<img src=x onerror="window.__pwned=1">`;
    const mine = [
      { league_key: KEY, name: XSS, owner_username: 'hexadecimal', member_count: 4,
        is_owner: true, max_members: 100, joined_at: '2026-07-02T00:00:00Z', created_at: '2026-07-01T00:00:00Z' },
      { league_key: 'ZK4M9TQBVR', name: 'Maths Club', owner_username: 'quietstorm', member_count: 12,
        is_owner: false, max_members: 100, joined_at: '2026-06-02T00:00:00Z', created_at: '2026-06-01T00:00:00Z' },
    ];
    const rpc = { get_my_leagues: `() => (${src(mine)})` };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    ok(await page.evaluate(() => document.getElementById('leagues-panel') === null),
       'no #leagues-panel element exists on the dashboard at all');
    const body = (await page.textContent('body')) || '';
    ok(!body.includes('Maths Club'), 'no clan is listed there');
    ok(!/Your Leagues|Your Clans/i.test(body), 'and the heading is gone with it');
    ok(await page.evaluate(() => document.querySelectorAll('.dashboard-wrap img').length) === 0,
       'a hostile clan name still produces no live element on that page');
    ok(await page.evaluate(() => window.__pwned !== 1), 'nothing executed');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // A hostile USERNAME on a GLOBAL board. This is the largest XSS surface on
  // the site: a public page, readable signed out, rendering names chosen by
  // strangers. The clan board's version of this test is above; this one is
  // separate because the two use different renderers.
  {
    console.log('[hostile username on a global board]');
    const XSS  = `"><img src=x onerror=window.__pwned=1>`;
    const XSS2 = `<svg onload="window.__pwned2=1">`;
    const rows = [
      { rank: 1, username: XSS,  score: 88 },
      { rank: 2, username: XSS2, score: 71 },
    ];
    const rpc = {
      get_my_leagues: `() => []`,
      get_global_board: `(a) => ({ scope: a.p_scope, duration_seconds: 120,
        generated_at: '2026-07-28T14:32:00Z', rows: ${src(rows)} })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    const state = await page.evaluate(() => ({
      pwned: window.__pwned === 1 || window.__pwned2 === 1,
      imgs:  document.querySelectorAll('#global-board img').length,
      svgs:  document.querySelectorAll('#global-board svg').length,
      anyImg: document.querySelectorAll('.league-wrap img').length,
    }));
    ok(!state.pwned, 'a hostile username on a public board did NOT execute');
    ok(state.imgs === 0, `no img element was created (${state.imgs})`);
    ok(state.svgs === 0, `no svg element was created (${state.svgs})`);
    ok(state.anyImg === 0, 'and none anywhere else in the page either');

    const r = await globalRows(page);
    ok(r.length === 2, `both hostile rows still rendered (${r.length})`);
    ok(r[0].cells[1] === XSS, 'the first is literal text, verbatim');
    ok(r[1].cells[1] === XSS2, 'and so is the second');
    ok(r.every(x => x.links === 0), 'and neither is a link');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // A row with no username. get_global_board is specified never to emit one;
  // if one arrives it must be DROPPED, not rendered as a dash. A public board
  // topped by anonymous placeholders is worse than a shorter board.
  {
    console.log('[global board — a row with no username]');
    const rows = [
      { rank: 1, username: null, score: 200 },
      { rank: 2, username: '',   score: 150 },
      { rank: 3, username: 'hexadecimal', score: 91 },
    ];
    const rpc = {
      get_my_leagues: `() => []`,
      get_global_board: `(a) => ({ scope: a.p_scope, duration_seconds: 120,
        generated_at: '2026-07-28T14:32:00Z', rows: ${src(rows)} })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const r = await globalRows(page);
    ok(JSON.stringify(r.map(x => x.cells)) === JSON.stringify([['3', 'hexadecimal', '91']]),
       `only the named row survives (${JSON.stringify(r.map(x => x.cells))})`);
    const txt = flat(await page.textContent('#global-board'));
    ok(!txt.includes('200') && !txt.includes('150'), 'their scores are not shown against nobody');
    ok(flat(await page.textContent('#global-note')).includes('1 player'),
       'and the count reflects what was actually rendered');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // The boards are 120 seconds because that is what the payload says, not
  // because the page hardcoded it. If the server ever changed it the sentence
  // has to change with it, or the page is lying about what it ranks.
  {
    console.log('[the duration comes off the payload]');
    const rpc = {
      get_my_leagues: `() => []`,
      get_global_board: `(a) => ({ scope: a.p_scope, duration_seconds: 60,
        generated_at: '2026-07-28T14:32:00Z', rows: [{ rank: 1, username: 'hexadecimal', score: 44 }] })`,
    };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.goto(`${BASE}/leagues.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const lede = flat(await page.textContent('#global-lede'));
    ok(lede.includes('60-second runs'), `the copy follows the payload (got "${lede}")`);
    ok(!lede.includes('120-second'), 'and does not still claim 120');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  // ══════ The rename ══════
  // "League" is gone from everything a person READS. It is still in the file
  // name, the element ids, the CSS classes and the RPC error codes — those are
  // wire identifiers and renaming them buys nothing a user can see. So this
  // walks the rendered TEXT of every page, in both themes, rather than
  // grepping the source.
  {
    console.log('[the word "league" is gone from every rendered page]');
    const RENAME_PAGES = [
      ['index.html', {}],
      ['dashboard.html', {}],
      ['daily.html', {}],
      ['duel.html', {}],
      ['practice.html', {}],
      ['results.html', {}],
      ['profile.html?u=hexadecimal', {}],
      ['settings.html', {}],
      ['privacy.html', {}],
      ['terms.html', {}],
      // Every state of the Leaderboards page itself, because that is where
      // the word lived.
      ['leagues.html', { get_my_leagues: `() => []`, get_global_board: GLOBAL_HANDLER }],
      ['leagues.html', { get_my_leagues: `() => (${src([{ league_key: KEY, name: 'Desk Six',
          owner_username: 'hexadecimal', member_count: 4, is_owner: true, max_members: 100,
          joined_at: '2026-07-02T00:00:00Z', created_at: '2026-07-01T00:00:00Z' }])})`,
        get_global_board: GLOBAL_HANDLER }],
      ['leagues.html', {}],                                   // nothing deployed
      [`leagues.html?l=${KEY}`, { get_league: `() => (${src(leaguePayload({ is_member: false }))})` }],
      [`leagues.html?l=${KEY}`, { get_league: `() => (${src(leaguePayload())})`,
        get_league_board: BOARD_HANDLER }],
      [`leagues.html?l=${KEY}`, { get_league: `() => null` }], // unknown code
      [`leagues.html?l=${KEY}`, { get_league: `() => (${src(leaguePayload())})`,
        get_league_board: `() => ({ __error: { message: 'league_forbidden', code: '42501' } })` }],
    ];

    for (const theme of ['dark', 'zetamac']) {
      for (const signedIn of [true, false]) {
        for (const [pg, rpc] of RENAME_PAGES) {
          const { ctx, page, errors } = await newPage(browser,
            { theme, session: signedIn ? SESSION : null, rpc });
          await page.goto(`${BASE}/${pg}`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(450);

          // innerText, not textContent: it is what is actually painted, and it
          // excludes the <input> value carrying the leagues.html invite URL,
          // which is a file name and is allowed to keep it.
          const seen = await page.evaluate(() => {
            const hits = [];
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = walk.nextNode(); n; n = walk.nextNode()) {
              const el = n.parentElement;
              if (!el || el.offsetParent === null && el.tagName !== 'BODY') continue;
              const t = (n.nodeValue || '');
              if (/league/i.test(t)) hits.push(t.replace(/\s+/g, ' ').trim().slice(0, 90));
            }
            return hits;
          });
          ok(seen.length === 0,
             `${theme} signed-${signedIn ? 'in' : 'out'} ${pg}: rendered text says "league" — ${JSON.stringify(seen).slice(0, 300)}`);

          const bar = flat(await page.textContent('#top-bar'));
          ok(bar.includes('Leaderboards'), `${theme} ${pg}: the nav says Leaderboards (${bar})`);
          ok(!/\bLeagues\b/.test(bar), `${theme} ${pg}: and no longer says Leagues`);
          ok(errors.length === 0, `${theme} ${pg}: no uncaught page errors (${errors[0] ?? ''})`);
          await ctx.close();
        }
      }
    }
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
