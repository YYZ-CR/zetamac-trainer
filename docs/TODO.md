# TODO

Written so this survives a lost conversation. Anything here should be actionable
without context from a chat log.

Read `CLAUDE.md` first (conventions, security posture, sandbox gotchas), then
`README.md` (what exists, how to run and test it).

---

## Where things stand

Built and tested: the game, run analysis, adaptive practice, public profiles +
percentiles, the share card, Zetamac Daily, duels with a real two-player pace graph,
steal mode, leaderboards and clans, a settings page with account deletion, and the first-run
walkthrough.

**Nothing below is blocked on more code.** What is left is the deploy checklist in
§1, one manual check per feature against the real project, and the demo video.

Verification currently in the repo:

```bash
npm test                                    # unit + the username-rule parity check
npm run test:sql                            # 8 SQL contract suites
npm run test:browser                        # 9 browser suites
supabase/test/race-duel-claim.sh            # concurrent duel-slot claim
supabase/test/race-league-cap.sh            # concurrent clan-cap race (schema: league)
supabase/test/race-steal-point.sh           # concurrent steal claims, with a control
```

All of it also runs on every push — `.github/workflows/ci.yml`.

Sandbox: Postgres on socket `/var/run/postgresql` port **5433**
(`ZT_SU=1 PGHOST=/var/run/postgresql PGPORT=5433 supabase/test/run.sh`).
Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Serve with `python3 -m http.server 8099 --bind 127.0.0.1` — never `npx serve`.

---

## 0. Steal mode could not score at all — fixed, and worth reading once

Landed in `1e5a1d7`, whose message is about leaderboards and does not mention it.
Recorded here because otherwise it is unfindable.

`js/db.js`'s `claimDuelPoint()` never sent `p_answer`. The server checks the answer
against the stored question and a missing argument arrives as NULL, which is the
first branch of that check — so **every claim returned `{ok:false, error:'wrong'}`**,
no row was ever inserted into `duel_points`, the server's next-expected index stayed
at 0 forever, and from the second question on every claim came back `stale_index`.
Steal mode could not score, in a two-player game or alone.

The client then made it look like something else entirely: on a refused claim it
*guessed* the other player had won and wrote that guess into the scoreline. A player
answering alone watched nine phantom points accrue to an idle opponent, each
announced as "Stolen". Both are fixed — the answer is sent, and a refusal that names
no winner now marks the index unknown and counts for nobody, with both scores shown
muted while any index is unresolved.

The scoreline shows usernames rather than "You" and "Them".

**Three things the steal client still offers that the database does not implement:**

- [ ] `end_duel_early` and `convert_duel_to_classic` are called by `js/db.js` and
      exist nowhere in `supabase/steal.sql`. Both will raise `PGRST202`. The client
      degrades survivably, but the ended-early flow and the convert button are not
      working features.
- [ ] **A reconnecting player re-enters at question 0** and re-answers everything,
      every one of which is `stale_index`. `claim_duel_point` now returns
      `current_index` on that refusal, which is exactly the missing datum —
      `start_duel_run` should return it too.
- [ ] **`stealOnBye` ends the run on an untrusted broadcast**, with no grace and no
      presence corroboration. A forged `bye` ends somebody's duel. It cannot move a
      score, so it is not a cheat, but it is a denial of service on a live game.

---

## 1. Deploy — all nine migrations are applied

A checker run against the real project reports every file OK. One thing is
outstanding and it is one statement:

- [ ] **`DROP FUNCTION IF EXISTS public.create_duel(INTEGER);`** — `duels.sql` was
      applied after `steal.sql` at some point, which put the old one-argument
      `create_duel` back alongside the two-argument version. Both match a
      one-argument call, so Postgres refuses to pick and **duel creation fails
      entirely**. Re-applying `steal.sql` does the same thing; the `DROP` is line
      152 of it.

**The rule that caused it: `duels.sql` and `steal.sql` are a pair.** Re-apply
`steal.sql` immediately after any re-application of `duels.sql`, forever.

Still worth doing by hand, because no test here can reach them:

- [ ] **A steal duel in two windows.** The browser suite stubs the Realtime
      channel; two live clients over a real socket is the part most likely to
      differ in production. Confirm that when one side answers, *both* screens
      advance.
- [ ] **Delete a throwaway account** that owns a clan with other members in it, and
      confirm the clan survives with a new owner. Local Postgres cannot exercise
      Supabase's real `auth.users` cascade.
- [ ] **One daily and one guest duel** against the real project. `auth.uid()` behind
      the real PostgREST gateway is the one thing `00-shim.sql` stands in for, and
      guest duels are the least shim-like path.

---

## 1b. Leaderboards and clans — CLIENT BUILT, server side pending

Contract: **`docs/leaderboards-design.md`**.

**The client half is done.** Leagues are **Leaderboards** in the nav and **clans** as
the noun everywhere a person reads. `leagues.html` now shows the three global boards
first — All-Time Best, Today's Best, Today's Daily, behind a tab control, All-Time
Best landing — and your
clans below them. `getGlobalBoard(scope, limit)` in `js/db.js` calls
`get_global_board(p_scope, p_limit)`; the page renders signed out, treats an empty
board as an invitation and a failed call as a visibly different error state, and
escapes every username. `test/browser/leagues.mjs` covers it (629 assertions,
including a walk of every page's rendered text for the word "league"), `tour.mjs`
was re-pointed and `TOUR_VERSION` bumped to `'3'` (400 assertions).

**What is still outstanding:**

- Deploying `supabase/leaderboards.sql` (written in parallel — it holds
  `get_global_board` and three indexes, and goes **after `steal.sql`**). Until it is
  applied the page renders its error state, which is the intended behaviour for a
  missing migration and is covered by a test.
- **The design doc contradicts itself on linking a username** and the client had to
  pick. The payload is specified as `{rank, username, score}` with no `is_public`,
  but the prose says "the row's name links there only when it is [public]". The
  client links **nothing** on a global board, so that a linked username on this site
  always means a published profile. If the server ever adds `is_public` to the row,
  `globalBoardRow()` in `js/leagues.js` is the one place to change.
- **The error payload shape for an unknown scope is unspecified.** The doc says an
  unknown scope is "an error payload, not an exception". `getGlobalBoard()` treats
  any payload without a `rows` array as a failure, which covers whatever shape it
  turns out to be, but the doc should name it.
- Nothing here renames the schema. `league` in the database still means `clan` in
  the product, and that is written down rather than left to be found.

**The decision the whole design turns on, and the decision that reversed it.**

The boards shipped reading only `daily_attempts` and `duel_runs`, which the server
scores itself, because `game_sessions` is written straight from the browser —

```sql
CREATE POLICY "sessions_insert" ON public.game_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
```

— and the anon key is public, so anyone can insert any score for themselves. On a
public ranking, the top of the board is whoever first types a large number.

**That was then reversed by an explicit owner decision:** the `today` and `all_time`
boards now rank `game_sessions` too, because a leaderboard none of your normal games
appear on is not the leaderboard that was wanted. The forgeability is a known,
accepted, documented cost. `daily` still reads `daily_attempts` alone and is still
unforgeable.

Comparability was **not** relaxed with it: a solo run qualifies only at 120 seconds
**and** on a config equal to `daily_default_config()`. Without that second rule the
board is meaningless even with nobody cheating, since `index.html` will happily
produce 120 seconds of one-digit addition.

→ **Open work item: server-scored solo runs.** A `start_run` / `submit_run` pair
mirroring `start_daily` / `submit_daily` — the server generates and stores the
questions, the client sends answers, the server counts them. That is what makes the
two Best boards trustworthy, and it is a feature rather than a patch. Until it lands,
`§1` of `supabase/test/09-leaderboards-test.sql` asserts the forgeable behaviour on
purpose and says so at the top, so nobody reads a green suite as evidence the scores
were checked.

---

## 2. ~~First-run walkthrough~~ — BUILT

`js/tour.js`, contract in `docs/walkthrough-design.md`, tested by
`test/browser/tour.mjs` (400 assertions). **Seven** steps in one array — a welcome,
then the six features — a modal on
`index.html` only — but never `index.html?key=…`, which is a shared configuration
link somebody followed to play that config — `localStorage['zt_tour_seen']` holding
`TOUR_VERSION` (now `'3'`), five
dismissal routes that all mark it seen, and a "How this works" link in the footer
that re-opens it.

Three things to keep true rather than rediscover:

- **The step list is `TOUR_STEPS`, one array at the top of the file.** A new feature
  means one more object there. `tour.mjs` asserts the rendered step count equals the
  array's length *and* that the length is seven, so an eighth step is a decision
  somebody makes deliberately — seven is the ceiling, and past it people start
  clicking Skip. The step → target pairs are also asserted **literally**, because
  inserting a step at the front shifts every one of them by one.
- **Bump `TOUR_VERSION` when the tour materially changes, never for a typo.** A tour
  that reappears for no reason trains people to dismiss it unread. Steal mode was
  folded into the duels step rather than added as a step of its own, for the same
  reason. `'1'` → `'2'` was the welcome step plus the closing line: both are things
  a `'1'` dismisser has not read.
- **The seen check runs before anything is built, not after.** A returning visitor
  gets no element at all. `tour.mjs` proves it with a `MutationObserver` installed at
  `document_start`, so a tour that renders and then hides itself would fail — and
  proves the assertion has teeth: deleting the check turns 11 assertions red.

---

## 3. ~~Steal mode for duels~~ — BUILT

`supabase/steal.sql` and the steal half of `js/duel.js`, contract in
`docs/steal-mode-design.md`, tested by `supabase/test/08-steal-test.sql`,
`test/browser/steal.mjs` (185 assertions) and `supabase/test/race-steal-point.sh`.

Three things to keep true:

- **Arbitration is on clamped client time, never on arrival order.** The race script
  fires two real concurrent claims with the *slower* player going first, and ends on
  a negative control — the same race against first-message-wins, which awards the
  point to the slower player. Without that control the test proves nothing.
- **`steal.sql` goes immediately after `duels.sql`.** It drops the one-argument
  `create_duel`, so re-applying `duels.sql` on its own afterwards makes
  `create_duel(120)` ambiguous and breaks duel creation.
- **Broadcast is a hint, never authority.** Everything a message asserts is
  re-derived from the RPC's return value; `steal.mjs` asserts a forged broadcast
  moves a screen and cannot move a score.

**What no test here covers: two live clients over real Supabase Realtime.** The
browser suite stubs the channel. Play one steal duel against yourself in two windows
before telling anybody it works.

---

## 4. ~~Delete account~~ — BUILT

Contract: `docs/account-deletion.md`. Database side: `supabase/account.sql` —
`delete_account(p_confirm TEXT) → JSONB`, one `SECURITY DEFINER` function that does
the whole thing in one transaction, in the order the doc states, with the
`auth.users` row deleted last.

- [ ] **Apply `supabase/account.sql`** in the Supabase SQL editor. It goes **last**,
      after `settings.sql` — its body reads tables from every earlier file and
      plpgsql resolves those names at call time, so applying it early looks fine and
      fails on the first real deletion.
- [ ] **Delete a throwaway account against the real project**, one that owns a clan
      with other members in it. Local Postgres cannot exercise the `auth.users`
      cascade Supabase actually has (`auth.identities`, `auth.sessions`,
      `auth.refresh_tokens`), and the function's own `DELETE FROM auth.users` depends
      on the function owner having rights in the `auth` schema — which is true of the
      role the SQL editor runs as, and is worth seeing once.

Two things not to "simplify" later:

- **The clan rule is duplicated from `leave_league` on purpose** — same removal,
  same "last member out deletes the clan", same successor tie-break
  (`ORDER BY joined_at ASC, user_id ASC`). `05-leagues-test.sql` and the account
  suite each assert one copy; change one and the other must change.
- **`game_sessions` are deleted, not orphaned.** The FK is `ON DELETE SET NULL`, and
  unowned rows keep feeding `get_score_percentile` forever.

---

## 5. Demo video

**Planned in full: `docs/demo-video-plan.md`** — outline, shot-by-shot script,
storyboard, capture plan and export matrix. `docs/demo-video-guide.md` remains the
technical reference (Remotion, the harness, ffmpeg). Nothing has been shot.

Read the plan's evidence-quality section first. Research was web search only —
`WebFetch` is blocked by this environment, so no primary source was opened — and
every claim is labelled evidenced, convention or inference.

Three things from it worth knowing before you spend a weekend on this:

- **No product in this genre appears to have a brand-made launch video.**
  Monkeytype started with a rough Reddit post and a streamer picking it up six days
  later. The video is what you hand a creator; it is not the growth mechanism.
- **69% of social video is watched muted** (Verizon Media / Publicis Media, 2019,
  n=5,616). The burned-in text is the script. Skip the voiceover.
- **Never speed-ramp a shot with the countdown timer in frame.** It is the fastest
  way to make this specific product look staged.

Two numbers in the plan are unverified and would break the edit if wrong: X's
free-tier length limit, and the 60-second Shorts ceiling that sets the master's
length.

### A product change the video research turned up

- [ ] **The share card leads with a score, and a score may be the wrong shape to
      spread.** Wordle's grid worked because it was spoiler-free and comparable at a
      glance; Nerdle shares a score and still reaches for a glyph sequence rather
      than a bare number. A card that led with the **pace curve** — a shape you can
      hold next to somebody else's without knowing the questions — is closer to the
      mechanic that demonstrably travels. Cheap to try: the curve is already drawn.

## 5b. Privacy policy and terms — BUILT, one placeholder left

`privacy.html` and `terms.html`, linked from the footer of every page that has one,
styled by the appended block at the end of `css/style.css`, and driven by `js/legal.js`
(which exists only to build the shared top bar). Covered by sections 5 and 17 of
`test/browser/tour.mjs` and by `test/browser/nav.mjs`.

- [ ] **Fill in `[contact email]`.** It appears once on each page — "Getting in touch"
      on both — and is deliberately written as a visible placeholder rather than a
      guess. `tour.mjs` asserts the marker is present, so **the two assertions
      `privacy: the contact placeholder…` and `terms: the contact placeholder…` must
      be inverted or deleted in the same commit that fills them in**, or the suite
      goes red.
- [ ] **Add the footer to `dashboard.html` and `profile.html`.** They are the only two
      pages with a top bar and no footer; they were owned by another session when this
      landed. Copy the six-line block from `daily.html` verbatim.

The content is written against what this site actually does and is asserted as such:
no analytics of any kind, the three third parties that see a request (Supabase, the
host, jsDelivr — which sees an IP on every page load), the `localStorage` keys by
name, opt-in public profiles, and a deletion section that agrees with
`docs/account-deletion.md` line for line. **If `account.sql` ever changes what
survives a deletion, `privacy.html` changes in the same commit** — the test asserts
the clan-succession rule and the duel rule by name, so it will tell you.

---

## 6. The dashboard and the public profile are one design

Both pages render the same three things in the same order — a five-tile record strip
(total games, questions, best, days practiced, day streak), score over time, and a
per-operation breakdown — from `js/stats.js`. The dashboard adds Recent Games below
that; the public page stops.

Five things to keep true rather than rediscover:

- **The Best tile is never a max across durations.** Scores at different run lengths
  are different measurements — a 300-second run scores about two and a half times a
  120-second one — so the tile shows the best at the duration played *most* and names
  that duration in its label (`BEST · 120S`). Ties on games played go to the longer
  duration. `pickBestDuration` in `js/stats.js` is the whole rule; both browser suites
  feed it a payload whose biggest number sits at its least-played duration, and a
  pooled max fails them. This replaced a Personal Bests panel that showed one card per
  duration for exactly this reason, so a single number that ignores duration would be
  the same bug wearing a smaller hat.
- **The strip has no accuracy tile** (removed on request) and no Personal Bests panel.
  The two figures the panel carried — the rolling average of the last 10 games and the
  percentile — are one sentence in the note under the strip (`#stats-note`, on both
  pages). Deleting either from that note loses a figure the site computes and shows
  nowhere else.

- **`js/stats.js` is the single copy.** Adding a tile means editing one file, and both
  pages get it. `test/browser/dashboard.mjs` and `test/browser/profile.mjs` feed the
  same stubbed payload through both pages and assert the same numbers out of each.
- **Recent Games never goes on the public profile.** `get_public_profile` returns a
  fixed, minimal projection with no per-session rows in it, and widening it to add them
  is the cross-user exposure the security posture exists to prevent. `profile.mjs`
  asserts the absence positively, including that the page never touches
  `game_sessions`.
- **The dashboard prefers `get_public_profile` and falls back to computing the same
  shape locally** (`recordFromSessions` in `js/dashboard.js`) when the account has no
  username yet, or when `social.sql` is not applied. The fallback covers the loaded
  session window rather than all time, and the note under the strip says so. If the two
  ever disagree about a figure, the SQL is right and the fallback is the copy to fix.
- **The Share button beside the username is one control on both pages.**
  `renderShareControl()` in `js/util.js` fills the same two slots on each —
  `#share-slot` next to the name, `#share-note` under it. Four things it must keep
  doing: share the **absolute `/@name` URL**, percent-encoded (usernames are
  user-controlled and go straight into a path); say so when the profile is private,
  because a silently copied link that renders "no such profile" for the recipient is
  a trap; stay silent when the native sheet is dismissed (`AbortError` is somebody
  changing their mind, not a failure); and render **nothing at all** without a
  username — there is no `/@` nothing. The clipboard half is `copyLinkToClipboard()`
  in the same file, which Settings' Copy link button calls too: one implementation of
  the clipboard's failure modes, not three. `navigator.clipboard` is **undefined**
  outside a secure context and the unguarded call throws there, which is why that
  helper exists at all.
- **The dashboard no longer holds the public-profile link or the clans list.** The
  link and the public/private toggle live in `settings.html`; clans live in
  `leagues.html`. Both panels were removed on request, and `leagues.mjs` now guards
  against the clans one reappearing.

- [ ] **The public profile no longer offers a Share Image.** It went with the panel it
      sat in. `js/sharecard.js` is still loaded by `results.html`, so the card itself is
      alive, but `shareCardDataFromProfile()` in that file is now unreferenced — delete
      it, or give the button a home again, when §5's "lead with the pace curve"
      question is settled.

---

## 7. Known gaps, none blocking

- [x] ~~Dead code in `js/db.js`~~ — the `isUsernameAvailable` fallback is gone. It
      was worse than dead: post-hardening it answered "available" for every name on
      the site. `getSession`'s fallback stays; that one is the deliberate
      works-on-both-sides-of-a-migration pattern CLAUDE.md describes.
- [x] ~~`session_key` is 32-bit~~ — `randomKey()` now draws 96 bits. Old keys keep
      working; the column has no length constraint and nothing parses a key.
- [ ] **`config_key` is still a 32-bit content hash.** Different configurations can
      collide, and two users would then share a config row. Widening it changes the
      identity of every config, so existing shared links would resolve to a new row
      rather than the one they were made from — worth doing, worth doing carefully.
- [ ] **Background-tab timer drift is unverified.** The fix anchors to a wall-clock
      deadline rather than accumulated ticks, but headless Chromium does not throttle
      background tabs, so the condition could not be reproduced. Needs a real browser,
      backgrounded, mid-run.
- [ ] **Cold start.** Percentiles suppress below 5 players and hide below 20; the
      global boards will be thin for a while — the client already treats that as an
      invitation rather than a failure, and never draws a placeholder row. The daily
      and clans are the two mechanics that work at low player counts — lead with those.

---

## Invariants — do not break these

Each is enforced by a test; if you change one, the test should fail first.

1. **Scores are never taken from the client.** The server recomputes from stored
   questions. `submit_daily` and `submit_duel_run` ignore any client-supplied score.
2. **A completed or expired daily attempt returns no questions.** Otherwise someone
   burns an attempt at 00:01, reads the puzzle, and studies it.
3. **Neither duellist sees a score until both are done.** Knowing the target turns a
   run into a chase.
4. **A duel's creator cannot play both sides.** Enforced in the RPC *and* by a CHECK
   constraint.
5. **A clan invite code is not a directory.** Non-members see the name, the owner
   and a count — never the roster.
6. **`profiles.username` is not writable by the client.** `set_username` is the only
   path, enforced by column-level grants rather than by a policy.
7. **New tables have RLS enabled with no policies and revoked grants.** The anon key
   is public, so a permissive policy is a public API.
8. **Write contract tests before reading an implementation.** That order has caught
   several real defects here that a test written afterwards would have been shaped
   around.
