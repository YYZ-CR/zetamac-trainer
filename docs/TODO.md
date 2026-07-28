# TODO

Written so this survives a lost conversation. Anything here should be actionable
without context from a chat log.

Read `CLAUDE.md` first (conventions, security posture, sandbox gotchas), then
`README.md` (what exists, how to run and test it).

---

## Where things stand

Built and tested: the game, run analysis, adaptive practice, public profiles +
percentiles, the share card, Zetamac Daily, duels with a real two-player pace graph,
steal mode, private leagues, a settings page with account deletion, and the first-run
walkthrough.

**Nothing below is blocked on more code.** What is left is the deploy checklist in
§1, one manual check per feature against the real project, and the demo video.

Verification currently in the repo:

```bash
npm test                                    # unit + the username-rule parity check
npm run test:sql                            # 8 SQL contract suites
npm run test:browser                        # 9 browser suites
supabase/test/race-duel-claim.sh            # concurrent duel-slot claim
supabase/test/race-league-cap.sh            # concurrent league-cap race
supabase/test/race-steal-point.sh           # concurrent steal claims, with a control
```

All of it also runs on every push — `.github/workflows/ci.yml`.

Sandbox: Postgres on socket `/var/run/postgresql` port **5433**
(`ZT_SU=1 PGHOST=/var/run/postgresql PGPORT=5433 supabase/test/run.sh`).
Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Serve with `python3 -m http.server 8099 --bind 127.0.0.1` — never `npx serve`.

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

## 1b. Leaderboards and clans — designed, not built

Contract: **`docs/leaderboards-design.md`**. Nothing is blocking it.

Leagues become **Leaderboards** in the nav and **clans** as the noun; the page holds
the global boards and your clans. Three global boards: today's daily, today's best,
all-time best, all fixed at 120 seconds.

**The decision the whole design turns on:** global boards are built only from
`daily_attempts` and `duel_runs`, which the server scores itself. `game_sessions` is
written straight from the browser —

```sql
CREATE POLICY "sessions_insert" ON public.game_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
```

— and the anon key is public, so anyone can insert any score for themselves. That
has never mattered while those rows only fed their owner's dashboard. On a public
ranking, the top of the board is whoever first types a large number.

The first contract test to write is that a forged 9999 session reaches no board.

Consequence, stated rather than hidden: **solo and practice runs will not appear on
any global board.** Making them eligible means the server generating and storing
questions for every run, the way the daily does — a real feature, not a patch.

---

## 2. ~~First-run walkthrough~~ — BUILT

`js/tour.js`, contract in `docs/walkthrough-design.md`, tested by
`test/browser/tour.mjs` (393 assertions). **Seven** steps in one array — a welcome,
then the six features — a modal on
`index.html` only — but never `index.html?key=…`, which is a shared configuration
link somebody followed to play that config — `localStorage['zt_tour_seen']` holding
`TOUR_VERSION` (now `'2'`), five
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
- [ ] **Delete a throwaway account against the real project**, one that owns a league
      with other members in it. Local Postgres cannot exercise the `auth.users`
      cascade Supabase actually has (`auth.identities`, `auth.sessions`,
      `auth.refresh_tokens`), and the function's own `DELETE FROM auth.users` depends
      on the function owner having rights in the `auth` schema — which is true of the
      role the SQL editor runs as, and is worth seeing once.

Two things not to "simplify" later:

- **The league rule is duplicated from `leave_league` on purpose** — same removal,
  same "last member out deletes the league", same successor tie-break
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
the league-succession rule and the duel rule by name, so it will tell you.

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
- **The dashboard no longer holds the public-profile link or the leagues list.** The
  link and the public/private toggle live in `settings.html`; leagues live in
  `leagues.html`. Both panels were removed on request, and `leagues.mjs` now guards
  against the leagues one reappearing.

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
      global board will be uninteresting for a while. The daily and private leagues
      are the two mechanics that work at low player counts — lead with those.

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
5. **A league invite code is not a directory.** Non-members see the name, the owner
   and a count — never the roster.
6. **`profiles.username` is not writable by the client.** `set_username` is the only
   path, enforced by column-level grants rather than by a policy.
7. **New tables have RLS enabled with no policies and revoked grants.** The anon key
   is public, so a permissive policy is a public API.
8. **Write contract tests before reading an implementation.** That order has caught
   several real defects here that a test written afterwards would have been shaped
   around.
