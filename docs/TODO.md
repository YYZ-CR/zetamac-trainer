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
npm run test:browser                        # 8 browser suites, ~1250 assertions
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

## 1. Blocking deploy

The order is the README's table. When in doubt, re-apply the lot in that order —
every file is idempotent and that is the supported way to deploy a change.

- [ ] **Re-apply `supabase/daily.sql`** — it carries the scoring fix. Any daily
      score recorded before it is wrong (too low): every question a player fumbled
      scored zero. Existing rows are not corrected by re-applying; if the
      leaderboard already has real scores on it, they were computed under the old
      rule.
- [ ] **Re-apply `supabase/duels.sql`.** Three changes since it was last applied:
      the same scoring fix; `duel_pace_points`, which is what makes the opponent's
      line on the pace graph a real curve instead of their final score held flat;
      and `duel_side_played`, which stops a stranger inheriting the finished run of
      an opponent who deleted their account.
- [ ] **Apply `supabase/steal.sql`**, immediately after `duels.sql`. It replaces
      `create_duel` with a version taking a mode argument and drops the
      one-argument original — so if you ever re-apply `duels.sql` on its own
      afterwards, `create_duel(120)` becomes ambiguous and duel creation breaks.
      Re-apply `steal.sql` straight after any re-application of `duels.sql`.
- [ ] **Apply `supabase/account.sql`**, last of all.
- [ ] **Apply `supabase/settings.sql`** in the Supabase SQL editor, after
      `leagues.sql`. It revokes the client's column grants on `profiles` and
      replaces `username_available`; re-running `hardening.sql` afterwards undoes
      half of it. Supabase will warn about "destructive operations" — that is the
      `REVOKE`s and a `DELETE` inside a function body, not a `DROP`.
- [ ] **Play one daily, one duel (accept it from a private window), and one league
      join against the real project.** Everything in this repo was verified against
      local Postgres with `supabase/test/00-shim.sql` standing in for Supabase's
      `auth` schema. **`auth.uid()` behind the real PostgREST gateway is the one
      thing no test here can exercise.** Guest duels are the least shim-like path
      and the most likely to differ.

---

## 2. ~~First-run walkthrough~~ — BUILT

`js/tour.js`, contract in `docs/walkthrough-design.md`, tested by
`test/browser/tour.mjs` (120 assertions). Six steps in one array, a modal on
`index.html` only — but never `index.html?key=…`, which is a shared configuration
link somebody followed to play that config — `localStorage['zt_tour_seen']` holding
`TOUR_VERSION`, five
dismissal routes that all mark it seen, and a "How this works" link in the footer
that re-opens it.

Three things to keep true rather than rediscover:

- **The step list is `TOUR_STEPS`, one array at the top of the file.** A new feature
  means one more object there. `tour.mjs` asserts the rendered step count equals the
  array's length *and* that the length is six, so a seventh step is a decision
  somebody makes deliberately — six is where people start clicking Skip.
- **Bump `TOUR_VERSION` when the tour materially changes, never for a typo.** A tour
  that reappears for no reason trains people to dismiss it unread. Steal mode was
  folded into the duels step rather than added as a seventh, for the same reason.
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

## 6. Known gaps, none blocking

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
