// Browser verification of steal mode on duel.html, written against
// docs/steal-mode-design.md.
//
// Every assertion below names a SPECIFIC expected string or number. This repo
// has twice shipped a green suite that only proved "something rendered", so a
// non-emptiness check is not a test here.
//
// WHAT THIS CANNOT PROVE, stated plainly rather than implied away: there is no
// real Supabase Realtime in this sandbox — supabase.co is unreachable and
// jsdelivr is blocked — so the channel below is a STUB. What is tested is this
// client's behaviour given a message, not that two live browsers actually
// exchange one. Two-client verification over the real project is a manual
// step. Arbitration, clamping, the grace window and the tie-break are SQL and
// belong to the SQL suite; nothing here asserts them.
import { chromium } from 'playwright';

const EXE   = process.env.ZT_CHROMIUM || undefined;
// Serve with `python3 -m http.server`, NOT `npx serve` — serve's clean-URLs
// default strips the query string on its /page.html -> /page redirect, which
// makes assertions pass against the wrong page state.
const BASE  = process.env.ZT_BASE  || 'http://127.0.0.1:8099';
const SHOTS = process.env.ZT_SHOTS || '/tmp/shots';
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log('  pass:', label); }
                           else { fail++; console.log('  FAIL:', label); } };

// Question i is "(i+2) + (i+3)". So q0 is "2 + 3 =" (5), q1 is "3 + 4 =" (7),
// q2 is "4 + 5 =" (9). The tests type those answers by hand, so a question
// that did not change is a question the assertion can see.
function makeQuestions(n) {
  return Array.from({ length: n }, (_, i) => ({
    display: `${i + 2} + ${i + 3}`, operation: 'addition', answer: (i + 2) + (i + 3),
  }));
}
const ANSWER = i => (i + 2) + (i + 3);
const SHOWN  = i => `${i + 2} + ${i + 3} =`;

// The stubbed CDN: a Supabase client whose rpc() is driven by window.__rpc and
// whose channel() is a fake Realtime channel the test can push messages into.
//
// Date.now() is patched to add window.__skew so a test can move the WALL CLOCK
// forward without waiting. That is the whole point of assertions 6 and 7: a
// countdown or a grace timer built on accumulated setInterval ticks does not
// move when the clock does, and one anchored to a deadline does.
const CDN = `
window.__skew = 0;
(function () {
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + (window.__skew || 0);
})();
window.__advanceClock = ms => { window.__skew = (window.__skew || 0) + ms; };

window.__sent = [];
window.__chan = null;
window.__unsub = 0;

function ZTChannel(name, opts) {
  this.name = name;
  this.opts = opts || {};
  this.handlers = { broadcast: {}, presence: {} };
  this.presence = {};
  this.subscribed = false;
}
ZTChannel.prototype.on = function (type, filter, cb) {
  const ev = (filter && filter.event) || '*';
  this.handlers[type] = this.handlers[type] || {};
  (this.handlers[type][ev] = this.handlers[type][ev] || []).push(cb);
  return this;
};
ZTChannel.prototype.subscribe = function (cb) {
  this.subscribed = true;
  setTimeout(() => { if (cb) cb('SUBSCRIBED'); }, 0);
  return this;
};
ZTChannel.prototype.send = function (msg) { window.__sent.push(msg); return Promise.resolve('ok'); };
ZTChannel.prototype.track = function (meta) {
  const key = (this.opts.config && this.opts.config.presence && this.opts.config.presence.key) || 'self';
  this.presence[key] = [meta];
  this.sync();
  return Promise.resolve('ok');
};
ZTChannel.prototype.untrack = function () {
  for (const k of Object.keys(this.presence)) if (k !== 'peer') delete this.presence[k];
  return Promise.resolve('ok');
};
ZTChannel.prototype.unsubscribe = function () { window.__unsub++; return Promise.resolve('ok'); };
ZTChannel.prototype.presenceState = function () { return this.presence; };
ZTChannel.prototype.sync = function () {
  for (const cb of ((this.handlers.presence || {}).sync || [])) cb({ event: 'sync' });
};
ZTChannel.prototype.push = function (event, payload) {
  for (const cb of ((this.handlers.broadcast || {})[event] || [])) {
    cb({ event, type: 'broadcast', payload });
  }
};

// What the test drives the other player with.
window.__push      = (event, payload) => window.__chan && window.__chan.push(event, payload);
window.__peer      = meta => { window.__chan.presence.peer = [meta]; window.__chan.sync(); };
window.__peerGone  = () => { delete window.__chan.presence.peer; window.__chan.sync(); };

window.supabase = { createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session: window.__session ?? null }, error: null }),
    getUser:    async () => ({ data: { user: window.__session?.user ?? null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
    signOut: async () => ({ error: null }),
  },
  from: () => ({ select(){return this}, eq(){return this}, is(){return this},
                 order(){return this}, limit(){return this},
                 // getProfile() reads through here. window.__profile is how a
                 // test gives the LOCAL player a username, which the scoreline
                 // now shows; left null it is a player with no username, which
                 // is every guest.
                 single: async () => (window.__profile
                   ? { data: window.__profile, error: null }
                   : { data: null, error: { message: 'stub' } }),
                 maybeSingle: async () => ({ data: null, error: null }),
                 insert: async () => ({ error: null }), update: async () => ({ error: null }),
                 upsert: async () => ({ error: null }) }),
  channel: (name, opts) => (window.__chan = new ZTChannel(name, opts)),
  rpc: async (name, args) => {
    window.__rpcCalls = window.__rpcCalls || [];
    window.__rpcCalls.push([name, args]);
    const h = (window.__rpc || {})[name];
    if (!h) return { data: null, error: { message: 'function ' + name + ' does not exist', code: 'PGRST202' } };
    // Awaited, so a handler can return a promise and HANG — which is how the
    // optimistic-advance assertion proves the screen moved before the claim
    // resolved rather than after it.
    const out = await (typeof h === 'function' ? h(args) : h);
    if (out && out.__error) return { data: null, error: out.__error };
    return { data: out, error: null };
  },
}) };
window.__charts = [];
window.Chart = function(ctx, cfg){
  window.__charts.push(cfg);
  this.destroy=function(){}; this.update=function(){};
  this.data=cfg.data; this.options=cfg.options;
};
window.Chart.defaults = { font: {} };
`;

async function newPage(browser, { theme = 'dark', session, rpc, storage, profile } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/cdn.jsdelivr.net/**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: CDN }));
  await page.addInitScript(([t, s, r, st, pr]) => {
    localStorage.setItem('zt_theme', t);
    for (const [k, v] of Object.entries(st || {})) localStorage.setItem(k, v);
    window.__session = s;
    window.__profile = pr;
    window.__rpc = {};
    for (const [k, v] of Object.entries(r)) window.__rpc[k] = eval('(' + v + ')');
  }, [theme, session ?? null, rpc ?? {}, storage ?? {}, profile ?? null]);
  return { ctx, page, errors };
}

const SESSION = { user: { id: 'u1', email: 'a@b.c' } };
const KEY     = 'steal1234';

// A get_duel_by_key payload for a STEAL duel. `mode` is the flag the design
// doc adds to duels; everything else is the shape duels.sql already emits.
function stealPayload(over = {}) {
  return Object.assign({
    duel_key: KEY,
    mode: 'steal',
    duration_seconds: 120,
    created_at: '2026-07-28T00:00:00Z',
    expires_at: '2026-07-30T00:00:00Z',
    expired: false,
    status: 'open',
    seconds_until_expiry: 100000,
    your_side: 'creator',
    opponent_claimed: false,
    scores_revealed: false,
    outcome: null,
    creator:  { played: false, status: null, submitted_at: null, score: null, is_you: true },
    opponent: { played: false, status: null, submitted_at: null, score: null, is_you: false },
  }, over);
}

const src = v => JSON.stringify(v);

const START_RUN = `() => ({ duel_key: ${src(KEY)}, side: 'creator', duration_seconds: 120,
  started_at: '2026-07-28T00:01:00Z', seconds_remaining: 120, status: 'in_progress',
  questions: ${src(makeQuestions(60))}, duel: ${src(stealPayload())} })`;

// Room → both ready → creator starts → clock jumped past the shared deadline →
// the run. Used by every in-run assertion; the room's own behaviour is
// asserted separately in section 1.
//
// The peer's presence name is 'Rival' unless a test says otherwise, and the
// scoreline shows it — so an assertion reading "Rival 0" is asserting that the
// OTHER browser's name reached the HUD, not that a placeholder rendered.
async function enterRun(page, peer = { side: 'opponent', name: 'Rival', ready: true }) {
  await page.click('#steal-ready-btn');
  await page.evaluate(p => window.__peer(p), peer);
  await page.waitForTimeout(60);
  await page.click('#steal-start-btn');
  await page.evaluate(() => window.__advanceClock(4000));
  await page.waitForFunction(() => {
    const el = document.getElementById('steal-game');
    return el && el.style.display !== 'none';
  }, null, { timeout: 4000 });
  await page.waitForTimeout(80);
}

const scores = page => page.evaluate(() => ({
  you:  document.getElementById('steal-score-you').textContent,
  them: document.getElementById('steal-score-them').textContent,
  youClass:  document.getElementById('steal-score-you').className,
  themClass: document.getElementById('steal-score-them').className,
  youHtml:   document.getElementById('steal-score-you').innerHTML,
  themHtml:  document.getElementById('steal-score-them').innerHTML,
}));

const line = page => page.evaluate(() =>
  (document.getElementById('steal-line').textContent || '').trim());

const question = page => page.evaluate(() =>
  (document.getElementById('steal-question').textContent || '').trim());

(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

  for (const theme of ['dark', 'zetamac']) {
    const tag = theme === 'dark' ? 'dark' : 'light';
    console.log(`\n══════ theme: ${tag} ══════`);

    // ── 1. The room ─────────────────────────────────────────
    // Both players are shown, and the countdown is not startable until both
    // of them are actually ready.
    {
      console.log('[1 the room — presence, Ready, and the gate on Start]');
      const rpc = { get_duel_by_key: `() => (${src(stealPayload())})` };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      let body = (await page.textContent('body')) || '';
      ok(await page.isVisible('#steal-room'), 'a steal duel opens a room, not a Start button');
      ok(!(await page.isVisible('#duel-panel')), 'the classic intro panel is not shown');
      ok(/first correct answer takes the point/i.test(body),
         'the room states the rule that makes steal mode different');
      ok(body.includes('Creator') && body.includes('Opponent'),
         'both seats are listed by role');
      ok(body.includes('Not here yet'), 'the absent player is shown as absent');
      ok(body.includes('Waiting for your opponent to open the link'),
         'and the status line says what is being waited for');
      ok(await page.isDisabled('#steal-start-btn'),
         'Start is disabled while the opponent is not here');
      ok((await page.textContent('#steal-countdown')).trim() === '',
         'no countdown is running yet');

      // Only this side is ready.
      await page.click('#steal-ready-btn');
      await page.waitForTimeout(60);
      ok(await page.isDisabled('#steal-start-btn'),
         'Start is STILL disabled when only one side has pressed Ready');

      // The opponent arrives, present but not ready. Their name is
      // user-controlled text from another browser, so it is also the XSS test.
      await page.evaluate(() => window.__peer({
        side: 'opponent', name: '<img src=x onerror="window.__xss=1">', ready: false,
      }));
      await page.waitForTimeout(80);
      body = (await page.textContent('body')) || '';
      ok(body.includes('Here — not ready'), 'a present-but-not-ready opponent is shown as such');
      ok(await page.isDisabled('#steal-start-btn'),
         'Start is disabled while the opponent is present but not ready');
      ok(await page.evaluate(() => window.__xss === undefined),
         "a username from the other browser does not execute");
      ok(await page.evaluate(() => document.querySelectorAll('.steal-player-name img').length === 0),
         'and does not become an element');
      ok((await page.innerHTML('.steal-players')).includes('&lt;img'),
         'it is escaped into the markup instead');

      // Both ready.
      await page.evaluate(() => window.__peer({
        side: 'opponent', name: 'Rival', ready: true,
      }));
      await page.waitForTimeout(80);
      ok(!(await page.isDisabled('#steal-start-btn')),
         'Start unlocks only once BOTH sides are ready');
      ok(((await page.textContent('body')) || '').includes('Both ready'),
         'and the status line says so');

      const track = await page.evaluate(() => window.__chan && window.__chan.presence);
      ok(track && Object.keys(track).some(k => k !== 'peer'),
         'this client tracked its own presence on the channel');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/steal-1-room-${tag}.png` });
      await ctx.close();
    }

    // ── 2. The countdown runs off a SHARED DEADLINE ─────────
    // The clock is moved rather than time being waited out. A countdown built
    // on accumulated setInterval ticks would still read "3" here.
    {
      console.log('[2 countdown — a shared deadline, not a tick count]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);

      await page.click('#steal-ready-btn');
      await page.evaluate(() => window.__peer({ side: 'opponent', name: 'Rival', ready: true }));
      await page.waitForTimeout(60);
      await page.click('#steal-start-btn');
      await page.waitForTimeout(120);

      ok((await page.textContent('#steal-countdown')).trim() === '3',
         'the countdown opens on 3');
      const startMsg = await page.evaluate(() =>
        window.__sent.filter(m => m.event === 'start').map(m => m.payload));
      ok(startMsg.length === 1 && Number.isFinite(startMsg[0].at),
         'a single `start` carrying a timestamp was broadcast');
      const at = startMsg[0].at;

      // 2.0 seconds of WALL CLOCK in ~0.1s of real time. A tick-driven
      // countdown would still be showing 3, having run about one tick.
      //
      // The number is checked against the deadline arithmetic rather than
      // against a hardcoded '2': the assertion is "the display follows
      // stealStartAt", and pinning a literal would make it also assert how
      // fast this test itself runs, which is not a property of the app.
      // Read the clock and the text in ONE evaluate so they cannot disagree.
      await page.evaluate(() => window.__advanceClock(2000));
      await page.waitForTimeout(140);
      const seen = await page.evaluate(() => ({
        text: (document.getElementById('steal-countdown').textContent || '').trim(),
        now:  Date.now(),
      }));
      const left     = at - seen.now;
      const expected = left <= 0
        ? 'Go'
        : String(Math.min(3, Math.max(1, Math.ceil(left / 1000))));
      ok(seen.text === expected,
         `the countdown reads what the deadline says (${left}ms left → "${expected}", got "${seen.text}")`);
      ok(seen.text !== '3',
         'and it is no longer 3, though barely any ticks have run — it follows the clock, not the ticks');

      await page.evaluate(() => window.__advanceClock(1400));
      await page.waitForFunction(() => {
        const el = document.getElementById('steal-game');
        return el && el.style.display !== 'none';
      }, null, { timeout: 4000 });
      ok(true, 'passing the deadline starts the run');

      const called = await page.evaluate(() =>
        window.__rpcCalls.filter(c => c[0] === 'start_duel_run').length);
      ok(called === 1, 'start_duel_run was called exactly once, at zero — not at the start of the countdown');
      ok((await question(page)) === SHOWN(0),
         `the first question is on screen (got "${await question(page)}")`);
      ok((await page.textContent('#steal-timer')).includes('Seconds left: 12'),
         "the run clock is the server's 120 seconds");
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 3. Optimistic advance ───────────────────────────────
    // The screen must move BEFORE the claim resolves. The stub hangs on
    // purpose, so the assertion is made while the RPC is still in flight.
    {
      console.log('[3 optimistic advance — the question moves before the claim resolves]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
        claim_duel_point: `(a) => { window.__claimArgs = a; window.__claimPending = true;
          return new Promise(res => { window.__settleClaim = v => { window.__claimPending = false; res(v); }; }); }`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await enterRun(page);

      ok((await question(page)) === SHOWN(0), 'starts on question 0');
      await page.fill('#steal-input', String(ANSWER(0)));
      await page.waitForTimeout(50);

      ok(await page.evaluate(() => window.__claimPending === true),
         'the claim is still in flight');
      ok((await question(page)) === SHOWN(1),
         `the question ALREADY advanced while the claim was pending (got "${await question(page)}")`);
      let s = await scores(page);
      ok(s.you === 'You 1', 'the point shows immediately');
      ok(/is-provisional/.test(s.youClass),
         'and is shown muted, because the server has not confirmed it yet');
      ok(await page.evaluate(() => (document.getElementById('steal-input').value || '') === ''),
         'the answer field is cleared for the new question');

      const bc = await page.evaluate(() =>
        window.__sent.filter(m => m.event === 'advance').map(m => m.payload));
      ok(bc.length === 1 && bc[0].index === 0 && bc[0].by === 'creator' && Number.isFinite(bc[0].ms),
         'an `advance` hint carrying {index, by, ms} went out');
      const args = await page.evaluate(() => window.__claimArgs);
      ok(args && args.p_index === 0 && Number.isFinite(args.p_elapsed_ms) && args.p_elapsed_ms >= 0,
         'the claim carries the index and the time since the question was rendered');

      // Now let arbitration agree, inside the grace window.
      await page.evaluate(() => window.__settleClaim(
        { ok: true, index: 0, winner: 'creator', elapsed_ms: 900, provisional: true }));
      await page.waitForTimeout(120);
      s = await scores(page);
      ok(s.you === 'You 1' && /is-provisional/.test(s.youClass),
         'a provisional award stays muted while it could still move');
      await page.waitForTimeout(500);
      s = await scores(page);
      ok(s.you === 'You 1' && !/is-provisional/.test(s.youClass),
         'and firms up once the window has passed — never shown and then snatched away');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 4. An incoming steal, announced in place ────────────
    {
      console.log('[4 incoming advance — this client moves too, and is told why]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await enterRun(page);

      await page.fill('#steal-input', '1');   // mid-keystroke, on the old question
      await page.evaluate(() => window.__push('advance', { index: 0, by: 'opponent', ms: 1400 }));
      await page.waitForTimeout(80);

      ok((await question(page)) === SHOWN(1),
         `an incoming advance moves this client on too (got "${await question(page)}")`);
      const line = (await page.textContent('#steal-line')).trim();
      ok(line === 'Stolen — they had it in 1.4s',
         `the steal is announced in place, with who and how fast (got "${line}")`);
      ok(await page.evaluate(() =>
        document.getElementById('steal-line').className.includes('is-them')),
         'in the losing colour');
      ok(await page.evaluate(() =>
        document.getElementById('steal-area').classList.contains('is-stolen')),
         'the question area flashes the loser state');
      ok(await page.evaluate(() => (document.getElementById('steal-input').value || '') === ''),
         'the half-typed answer is cleared, because it was for a question that is gone');
      ok(await page.evaluate(() => {
        const el = document.getElementById('steal-line');
        return el && el.parentElement && el.parentElement.id === 'steal-game';
      }), 'the line is in the page, not a toast overlay covering the next question');

      await page.screenshot({ path: `${SHOTS}/steal-4-steal-${tag}.png` });

      // Now one of ours, to check the winning wording and colour.
      await page.fill('#steal-input', String(ANSWER(1)));
      await page.waitForTimeout(80);
      const mine = (await page.textContent('#steal-line')).trim();
      ok(/^Stolen — you had it in \d+(\.\d)?s$/.test(mine),
         `a steal by you says so in the winning colour (got "${mine}")`);
      ok(await page.evaluate(() =>
        document.getElementById('steal-line').className.includes('is-you')),
         'with the winning class');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 5. Losing arbitration corrects the SCORE ONLY ───────
    // The claim comes back naming the other side. The score must move and the
    // question must not: a question rewinding underneath a player is far more
    // disorienting than a number moving by one.
    {
      console.log('[5 arbitration lost — the score corrects, the question does not rewind]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
        claim_duel_point: `(a) => { window.__claimPending = true;
          return new Promise(res => { window.__settleClaim = v => { window.__claimPending = false; res(v); }; }); }`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await enterRun(page);

      await page.fill('#steal-input', String(ANSWER(0)));
      await page.waitForTimeout(50);
      ok((await question(page)) === SHOWN(1), 'optimistically on question 1');
      ok((await scores(page)).you === 'You 1', 'optimistically one point up');

      // Arbitration disagrees: the opponent was faster.
      await page.evaluate(() => window.__settleClaim(
        { ok: true, index: 0, winner: 'opponent', elapsed_ms: 820, provisional: false }));
      await page.waitForTimeout(120);

      ok((await question(page)) === SHOWN(1),
         `the question did NOT rewind (got "${await question(page)}")`);
      const s = await scores(page);
      ok(s.you === 'You 0',  'the optimistic point was taken off our score');
      ok(s.them === 'Rival 1', "and given to them, under the opponent's own name");
      const line = (await page.textContent('#steal-line')).trim();
      ok(line === 'Stolen — they had it in 0.8s',
         `and the line says who actually had it, and how fast (got "${line}")`);
      const settled = await page.evaluate(() =>
        window.__sent.filter(m => m.event === 'settled').map(m => m.payload));
      ok(settled.length === 1 && settled[0].index === 0 && settled[0].winner === 'opponent',
         'a `settled` message told the other side arbitration had disagreed');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 6. A forged broadcast cannot change a score ─────────
    // claim_duel_point is deliberately NOT stubbed here, so nothing on this
    // page has any server backing at all. Messages may move the screen; the
    // moment one can move a number, a forged message is a cheat.
    {
      console.log('[6 forged broadcast — screens move, scores do not]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await enterRun(page);

      const before = await scores(page);
      ok(before.you === 'You 0' && before.them === 'Rival 0', 'the run opens level');

      await page.evaluate(() => {
        window.__push('advance', { index: 0, by: 'opponent', ms: 500 });
        window.__push('settled', { index: 0, winner: 'opponent' });
      });
      await page.waitForTimeout(120);

      let s = await scores(page);
      ok(s.them === 'Rival 0',
         `an advance + settled claiming a point for them, with no RPC behind it, moved nothing (got "${s.them}")`);
      ok(s.you === 'You 0', 'and did not move our score either');
      ok((await question(page)) === SHOWN(1), 'though the screen did advance — a hint may do that');

      // Our own point, then a forged `settled` claiming it for them.
      await page.fill('#steal-input', String(ANSWER(1)));
      await page.waitForTimeout(80);
      ok((await scores(page)).you === 'You 1', 'our own answer banks a point optimistically');

      await page.evaluate(() => window.__push('settled', { index: 1, winner: 'opponent' }));
      await page.waitForTimeout(120);
      s = await scores(page);
      ok(s.you === 'You 1' && s.them === 'Rival 0',
         `a forged settled cannot take a banked point away either (got "${s.you} / ${s.them}")`);
      ok(/is-provisional/.test(s.youClass),
         'it stays muted instead — the server has the last word, and the display says so');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 7. Disconnect: ten seconds, then ended early ────────
    {
      console.log('[7 disconnect — grace, then ended early on the score so far]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
        claim_duel_point: `(a) => ({ ok: true, index: a.p_index, winner: 'creator',
          elapsed_ms: 700, provisional: false })`,
        end_duel_early: `(a) => { window.__endArgs = a;
          return { ended_early: true, reason: a.p_reason, creator_score: 1, opponent_score: 3 }; }`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await enterRun(page);

      // Bank one real point so "the score so far" is a real thing.
      await page.fill('#steal-input', String(ANSWER(0)));
      await page.waitForTimeout(150);
      ok((await scores(page)).you === 'You 1', 'one point banked before the drop');

      await page.evaluate(() => window.__peerGone());
      await page.waitForTimeout(120);
      const banner = (await page.textContent('#steal-banner')).trim();
      ok(/Your opponent has dropped out\. Ending the duel in \d+s/.test(banner),
         `the grace is announced with a countdown (got "${banner}")`);
      ok(await page.isVisible('#steal-banner'), 'and is visible during the run');
      ok(!(await page.evaluate(() => {
        const el = document.getElementById('duel-result');
        return el && el.style.display === 'block';
      })), 'the duel has NOT ended yet — the grace is a grace');

      // Eleven seconds of wall clock, a quarter second of real time.
      await page.evaluate(() => window.__advanceClock(11000));
      await page.waitForFunction(() => {
        const el = document.getElementById('duel-result');
        return el && el.style.display === 'block';
      }, null, { timeout: 4000 });
      await page.waitForTimeout(150);

      const body = (await page.textContent('body')) || '';
      ok(body.includes('Ended early'), 'the duel ends early once the grace expires');
      ok(!/You won|You lost|Walkover/.test(body),
         'and is NOT shown as a win for anybody');
      ok(/not a win for anybody/.test(body),
         'the copy says so in as many words');
      const args = await page.evaluate(() => window.__endArgs);
      ok(args && args.p_reason === 'opponent_left' && args.p_key === 'steal1234',
         'end_duel_early was called with the reason');
      const cards = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#duel-result .stat-value')).map(e => e.textContent.trim()));
      ok(cards[0] === '1' && cards[1] === '3',
         `the score so far is the SERVER's, not this client's tally (got ${JSON.stringify(cards)})`);
      ok(!(await page.isVisible('#steal-game')), 'the run is gone');
      ok(await page.evaluate(() => window.__unsub >= 1), 'the channel was left');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await page.screenshot({ path: `${SHOTS}/steal-7-endedearly-${tag}.png` });
      await ctx.close();
    }

    // ── 8. The offer to fall back to a classic duel ─────────
    {
      console.log('[8 nobody came — convert to a classic duel]');
      const rpc = {
        get_duel_by_key: `() => (window.__converted
          ? (${src(stealPayload({ mode: 'classic' }))})
          : (${src(stealPayload())}))`,
        convert_duel_to_classic: `(a) => { window.__converted = true; window.__convertArgs = a;
          return { duel_key: a.p_key, mode: 'classic' }; }`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      const body = (await page.textContent('body')) || '';
      ok(body.includes('Nobody has taken the other side yet'),
         'the room says plainly that nobody has arrived');
      ok(/classic duel needs nobody to be awake/.test(body),
         'and offers the fallback with the reason it works');
      ok(await page.isVisible('#steal-convert-btn'), 'a convert button is offered');

      await page.click('#steal-convert-btn');
      await page.waitForTimeout(600);
      const after = (await page.textContent('body')) || '';
      ok(await page.evaluate(() => !!window.__convertArgs),
         'convert_duel_to_classic was called');
      ok(!(await page.isVisible('#steal-room')), 'the room is gone once it is a classic duel');
      ok(after.includes('One run per side') || after.includes('Start your run'),
         'and the ordinary classic intro takes over');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 9. Creating a steal duel ────────────────────────────
    {
      console.log('[9 create — the mode choice]');
      const rpc = { create_duel: `(a) => ({ duel_key: ${src(KEY)}, mode: a.p_mode || 'classic',
        expires_at: '2099-01-01T00:00:00Z', duration_seconds: a.p_duration })` };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);

      const body = (await page.textContent('body')) || '';
      ok(await page.isVisible('#duel-mode-steal'), 'a mode choice is offered');
      ok(/each play the same questions whenever you like/.test(body),
         'classic is described in one sentence');
      ok(/first correct answer takes the point and you both jump to the next question/.test(body),
         'and so is steal');
      ok(await page.isChecked('#duel-mode-classic'), 'classic is the default');

      // A classic create must send EXACTLY the call it sent before the mode
      // flag existed, so a database without the migration still answers it.
      await page.click('#duel-create-btn');
      await page.waitForTimeout(300);
      const classicArgs = await page.evaluate(() =>
        window.__rpcCalls.filter(c => c[0] === 'create_duel').map(c => c[1]));
      ok(classicArgs.length === 1 && Object.keys(classicArgs[0]).join() === 'p_duration',
         `a classic create still sends p_duration alone (got ${JSON.stringify(classicArgs[0])})`);

      await page.goto(`${BASE}/duel.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.check('#duel-mode-steal');
      await page.click('#duel-create-btn');
      await page.waitForTimeout(300);
      const stealArgs = await page.evaluate(() =>
        window.__rpcCalls.filter(c => c[0] === 'create_duel').map(c => c[1]));
      ok(stealArgs.length === 1 && stealArgs[0].p_mode === 'steal',
         'a steal create sends p_mode');
      const after = (await page.textContent('body')) || '';
      ok(after.includes('Steal'), 'the confirmation says which mode it made');
      ok(/It opens a room/.test(after), 'and tells the creator the link opens a room');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 10. THE CASCADE — the regression test for the report ─
    // Reported from a real two-player game: a player answered nine questions
    // alone and all nine were credited to an opponent who was not playing,
    // "Stolen — they took it" each time. The mechanism was that a refused
    // claim was read as "then it must have been them" — and one refusal leaves
    // the client's index ahead of the server's, so every later claim came back
    // stale_index and handed out another invented point.
    //
    // This is written first and it is the assertion that matters most: drive a
    // wall of refusals and the opponent's score must not move off zero.
    {
      console.log('[10 the cascade — consecutive refusals invent NOTHING]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
        // Exactly what supabase/steal.sql returns for a client whose index has
        // run ahead of the server's: refused, and naming nobody.
        claim_duel_point: `(a) => ({ ok: false, error: 'stale_index',
          index: a.p_index, current_index: 0 })`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await enterRun(page);

      const before = await scores(page);
      ok(before.you === 'You 0' && before.them === 'Rival 0',
         `the run opens level (got "${before.you} / ${before.them}")`);

      // Nine answers, alone, exactly as reported.
      for (let i = 0; i < 9; i++) {
        await page.fill('#steal-input', String(ANSWER(i)));
        await page.waitForTimeout(70);
      }

      const claims = await page.evaluate(() =>
        window.__rpcCalls.filter(c => c[0] === 'claim_duel_point').length);
      ok(claims === 9,
         `nine claims really were made and really were refused (got ${claims})`);
      ok((await question(page)) === SHOWN(9),
         `nine questions really were answered (got "${await question(page)}")`);

      const after = await scores(page);
      ok(after.them === 'Rival 0',
         `NINE refusals gave the opponent nothing (got "${after.them}")`);
      ok(after.you === 'You 0',
         `and gave us nothing either — a refused claim is not a point (got "${after.you}")`);
      ok(!/Stolen/.test(await line(page)),
         `"Stolen" was never announced, because nobody was ever named (got "${await line(page)}")`);
      ok(await page.evaluate(() =>
           !document.getElementById('steal-line').className.includes('is-them')),
         'and the losing colour was never used');

      // The unknown indexes are visible as unknown: both numbers are muted,
      // because both are incomplete.
      ok(/is-provisional/.test(after.youClass) && /is-provisional/.test(after.themClass),
         'both numbers are muted, saying the scoreline is incomplete rather than wrong');

      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 11. A single refusal, in detail ─────────────────────
    {
      console.log('[11 one refusal — point_taken and stale_index, neither a scoring event]');

      // 11a. point_taken with nobody named. The RAISEd shape: an error object,
      // no payload at all.
      {
        const rpc = {
          get_duel_by_key: `() => (${src(stealPayload())})`,
          start_duel_run: START_RUN,
          claim_duel_point: `() => ({ __error: { message: 'point_taken' } })`,
        };
        const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
        await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await enterRun(page);

        const before = await scores(page);
        ok(before.you === 'You 0' && before.them === 'Rival 0', 'level before the claim');

        await page.fill('#steal-input', String(ANSWER(0)));
        await page.waitForTimeout(150);

        const after = await scores(page);
        ok(after.them === 'Rival 0',
           `a point_taken refusal did NOT give them a point (got "${after.them}")`);
        ok(after.you === 'You 0',
           `and took our optimistic one back off (got "${after.you}")`);
        ok(!/Stolen/.test(await line(page)),
           `no steal was announced (got "${await line(page)}")`);
        ok((await line(page)) === 'That one was not yours — waiting for the server to say who took it.',
           `the line says exactly what is known and no more (got "${await line(page)}")`);
        ok((await question(page)) === SHOWN(1),
           'and the question did not rewind');
        ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
        await ctx.close();
      }

      // 11b. stale_index — a resync condition, and it says so on screen.
      {
        const rpc = {
          get_duel_by_key: `() => (${src(stealPayload())})`,
          start_duel_run: START_RUN,
          claim_duel_point: `(a) => ({ ok: false, error: 'stale_index',
            index: a.p_index, current_index: 0 })`,
        };
        const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
        await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await enterRun(page);

        ok(!(await page.isVisible('#steal-banner')), 'no banner before the disagreement');

        await page.fill('#steal-input', String(ANSWER(0)));
        await page.waitForTimeout(150);

        const after = await scores(page);
        ok(after.you === 'You 0' && after.them === 'Rival 0',
           `a stale_index refusal moved neither score (got "${after.you} / ${after.them}")`);
        ok(await page.isVisible('#steal-banner'), 'the client went into a resync state');
        const banner = (await page.textContent('#steal-banner')).trim();
        ok(banner === 'Out of step with the server — points may not be counted until the next question is decided.',
           `and says so, in as many words (got "${banner}")`);

        // The resync clears when the game catches up with this client: an
        // `advance` hint at or ahead of our own index.
        await page.evaluate(() => window.__push('advance', { index: 1, by: 'opponent', ms: 900 }));
        await page.waitForTimeout(120);
        ok(!(await page.isVisible('#steal-banner')),
           'and clears once an advance shows the game has caught up');
        const s = await scores(page);
        ok(s.them === 'Rival 0',
           `that advance was still only a hint — it awarded nothing (got "${s.them}")`);
        ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
        await ctx.close();
      }
    }

    // ── 12. A genuine server award still scores ─────────────
    // supabase/steal.sql returns point_taken WITH `winner`, `elapsed_ms` and
    // `provisional`: it is a refusal of the claim and an award of the point in
    // one payload. That named winner is the server's word and must still score
    // and still announce — the fix must not have made the client deaf.
    {
      console.log('[12 a named winner still scores and still announces]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
        claim_duel_point: `(a) => (a.p_index === 0
          ? { ok: false, error: 'point_taken', index: 0, side: 'creator',
              winner: 'opponent', elapsed_ms: 820, provisional: false }
          : { ok: true, index: a.p_index, side: 'creator', winner: 'creator',
              elapsed_ms: 640, provisional: false })`,
      };
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await enterRun(page);

      await page.fill('#steal-input', String(ANSWER(0)));
      await page.waitForTimeout(150);
      let s = await scores(page);
      ok(s.them === 'Rival 1',
         `a point_taken that NAMES the winner scores for them (got "${s.them}")`);
      ok(s.you === 'You 0', 'and our optimistic point came off');
      ok((await line(page)) === 'Stolen — they had it in 0.8s',
         `"Stolen" is announced, because the server named somebody (got "${await line(page)}")`);
      ok(!/is-provisional/.test(s.themClass),
         'a settled award is not muted');

      await page.fill('#steal-input', String(ANSWER(1)));
      await page.waitForTimeout(150);
      s = await scores(page);
      ok(s.you === 'You 1' && s.them === 'Rival 1',
         `an ok:true award still scores for us (got "${s.you} / ${s.them}")`);
      ok(!/is-provisional/.test(s.youClass) && !/is-provisional/.test(s.themClass),
         'and with nothing unknown left, neither number is muted');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 13. The scoreline is two usernames ──────────────────
    {
      console.log('[13 the scoreline — usernames, escaped, and yours identifiable]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
        claim_duel_point: `(a) => ({ ok: true, index: a.p_index, side: 'creator',
          winner: 'creator', elapsed_ms: 640, provisional: false })`,
      };
      const { ctx, page, errors } = await newPage(browser, {
        theme, session: SESSION, rpc, profile: { id: 'u1', username: 'Ada' },
      });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await enterRun(page);

      let s = await scores(page);
      ok(s.you === 'Ada (you) 0',
         `our own username is on the scoreline, marked as ours (got "${s.you}")`);
      ok(s.them === 'Rival 0',
         `and the opponent's name, from their presence payload (got "${s.them}")`);
      ok(!/\bYou\b|\bThem\b/.test(s.you + ' ' + s.them),
         `neither placeholder survives (got "${s.you} / ${s.them}")`);
      ok(s.youHtml.includes('(you)') && !s.themHtml.includes('(you)'),
         'only our own side carries the marker');

      await page.fill('#steal-input', String(ANSWER(0)));
      await page.waitForTimeout(150);
      s = await scores(page);
      ok(s.you === 'Ada (you) 1' && s.them === 'Rival 0',
         `the number sits beside the name and moves (got "${s.you} / ${s.them}")`);
      ok(!/is-provisional/.test(s.youClass) && !/is-provisional/.test(s.themClass),
         'a settled award is not muted, so both names render in the HUD ink');
      const inks = await page.evaluate(() => [
        getComputedStyle(document.getElementById('steal-score-you')).color,
        getComputedStyle(document.getElementById('steal-score-them')).color,
      ]);
      ok(inks[0] === inks[1],
         `both sides of the scoreline are the same colour (got ${JSON.stringify(inks)})`);

      await page.screenshot({ path: `${SHOTS}/steal-13-names-${tag}.png` });

      // A hostile name from the other browser. It reaches the HUD through a
      // presence payload, so it is exactly as attacker-controlled as the room's.
      await page.evaluate(() => window.__peer({
        side: 'opponent', name: '<img src=x onerror="window.__xss=1">', ready: true,
      }));
      await page.waitForTimeout(120);
      ok(await page.evaluate(() => window.__xss === undefined),
         'a hostile peer name on the scoreline does not execute');
      ok(await page.evaluate(() =>
           document.querySelectorAll('#steal-score img').length === 0),
         'and does not become an element');
      ok((await page.innerHTML('#steal-score-them')).includes('&lt;img'),
         'it is escaped into the markup instead');

      // A long name must lose its own tail, not the timer.
      await page.evaluate(() => window.__peer({
        side: 'opponent', name: 'Bartholomew Featherstonehaugh III', ready: true,
      }));
      await page.waitForTimeout(120);
      await page.screenshot({ path: `${SHOTS}/steal-13-longname-${tag}.png` });
      const layout = await page.evaluate(() => {
        const t = document.getElementById('steal-timer').getBoundingClientRect();
        const sc = document.getElementById('steal-score').getBoundingClientRect();
        const nm = document.querySelector('#steal-score-them .steal-score-name');
        return {
          gap: Math.round(sc.left - t.right),
          // #steal-game's HUD specifically. `.game-hud` alone matches the
          // CLASSIC run's hidden one first, which is 0px tall and would make
          // the one-line assertion below pass without measuring anything.
          hudLines: Math.round(
            document.querySelector('#steal-game .game-hud').getBoundingClientRect().height),
          clipped: nm.scrollWidth > nm.clientWidth,
          ellipsis: getComputedStyle(nm).textOverflow,
        };
      });
      ok(layout.gap > 0,
         `a long name does not push the timer off the left (gap ${layout.gap}px)`);
      ok(layout.clipped && layout.ellipsis === 'ellipsis',
         'it is truncated with an ellipsis rather than wrapped');
      ok(layout.hudLines > 20 && layout.hudLines < 45,
         `and the HUD is still one line, not two (${layout.hudLines}px)`);
      ok((await scores(page)).them.endsWith(' 0'),
         'the number survives the truncation — only the name is clipped');
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }

    // ── 14. A guest has no username ─────────────────────────
    {
      console.log('[14 a guest — an honest fallback, never blank or undefined]');
      const rpc = {
        get_duel_by_key: `() => (${src(stealPayload())})`,
        start_duel_run: START_RUN,
      };
      // No profile for us, and a peer whose presence carries no name at all.
      const { ctx, page, errors } = await newPage(browser, { theme, session: SESSION, rpc });
      await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await enterRun(page, { side: 'opponent', ready: true });

      const s = await scores(page);
      ok(s.you === 'You 0',
         `a player with no username falls back to "You" (got "${s.you}")`);
      ok(s.them === 'Them 0',
         `and a nameless guest to "Them" (got "${s.them}")`);
      ok(!/undefined|null/.test(s.youHtml + s.themHtml),
         'with no "undefined" and no "null" anywhere in the markup');
      ok(!s.youHtml.includes('(you)'),
         'and no "(you)" marker on a name that is already the word "You"');

      // An empty-string name is a name too, and must not render as a blank.
      await page.evaluate(() => window.__peer({ side: 'opponent', name: '   ', ready: true }));
      await page.waitForTimeout(120);
      ok((await scores(page)).them === 'Them 0',
         `a whitespace-only name falls back rather than rendering blank (got "${(await scores(page)).them}")`);
      ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
      await ctx.close();
    }
  }

  // ── Realtime missing altogether ───────────────────────────
  // An older supabase-js, or a blocked WebSocket. The room must say so rather
  // than sit there looking like it is working.
  {
    console.log('\n[no realtime — the room says so]');
    const rpc = { get_duel_by_key: `() => (${src(stealPayload())})` };
    const { ctx, page, errors } = await newPage(browser, { session: SESSION, rpc });
    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {});
    });
    // Strip channel() off the client the moment it exists.
    await page.route('**/cdn.jsdelivr.net/**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript',
                  body: CDN + '\nwindow.supabase.createClient = (function (orig) { return function () { const c = orig(); delete c.channel; return c; }; })(window.supabase.createClient);' }));
    await page.goto(`${BASE}/duel.html?d=${KEY}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const body = (await page.textContent('body')) || '';
    ok(/couldn't open a real-time connection/.test(body),
       'the room says a steal duel cannot be played here');
    ok(await page.isVisible('#steal-convert-btn'),
       'and the classic fallback is still on offer');
    ok(errors.length === 0, `no uncaught page errors (${errors[0] ?? ''})`);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
