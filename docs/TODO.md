# TODO

Written so this survives a lost conversation. Anything here should be actionable
without context from a chat log.

Read `CLAUDE.md` first (conventions, security posture, sandbox gotchas), then
`README.md` (what exists, how to run and test it).

---

## Where things stand

Built, tested and merged to `master`: the game, run analysis, adaptive practice,
public profiles + percentiles, the share card, Zetamac Daily, duels with a pace
graph, private leagues, and a settings page.

Verification currently in the repo:

```bash
npm test                                    # unit + the username-rule parity check
supabase/test/run.sh                        # 5 SQL contract suites (~313 assertions)
supabase/test/race-duel-claim.sh            # concurrent duel-slot claim
supabase/test/race-league-cap.sh            # concurrent league-cap race
ZT_CHROMIUM=<path> node test/browser/{nav,daily,duel,leagues,dashboard,settings}.mjs
```

Sandbox: Postgres on socket `/var/run/postgresql` port **5433**
(`ZT_SU=1 PGHOST=/var/run/postgresql PGPORT=5433 supabase/test/run.sh`).
Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Serve with `python3 -m http.server 8099 --bind 127.0.0.1` — never `npx serve`.

---

## 1. Blocking deploy

- [ ] **Apply `supabase/settings.sql`** in the Supabase SQL editor. It must go
      **last**, after `leagues.sql`. It revokes the client's column grants on
      `profiles` and replaces `username_available`; re-running `hardening.sql`
      afterwards undoes half of it. Supabase will warn about "destructive
      operations" — that is the `REVOKE`s and a `DELETE` inside a function body,
      not a `DROP`.
- [ ] **Play one daily, one duel (accept it from a private window), and one league
      join against the real project.** Everything in this repo was verified against
      local Postgres with `supabase/test/00-shim.sql` standing in for Supabase's
      `auth` schema. **`auth.uid()` behind the real PostgREST gateway is the one
      thing no test here can exercise.** Guest duels are the least shim-like path
      and the most likely to differ.

---

## 2. First-run walkthrough — do this LAST

A one-time popup for a first-time visitor describing every feature: the daily,
duels, leagues, practice mode, the run analysis, profiles and the share card.
Dismissible, never shown twice.

**Why last:** a walkthrough is a description of the product, so every feature added
before it is written is a feature the tour has to be rewritten for.

Decisions to make before building:

- **Where "seen it" is stored.** `localStorage` reappears on a second device; a
  `profiles` column follows the account but does nothing for signed-out visitors —
  and the whole point is first-time visitors, most of whom have no account. Probably
  localStorage, with the profile column only as a later refinement.
- **Whether it blocks.** A modal over the config screen interrupts someone who came
  to play. A dismissible strip, or a tour that only starts on request, respects that.
- **Ordering.** Lead with what is different from Zetamac (the analysis, the daily),
  not with a feature list.

Must respect the existing conventions: `escapeHtml` on anything user-controlled,
`--c-*` tokens only, no build step, and a browser test asserting it appears once and
not twice.

---

## 3. Steal mode for duels

Designed but not built — see `docs/duels-design.md`, final section.

First correct answer takes the point and both players jump to the next question.
It is a real-time distributed system, not an extension of classic duels:

- **Arbitration cannot be first-message-wins.** If A answers at 1000 ms and B at
  1005 ms but A's packet takes 80 ms, the server sees B first — the game would
  reward ping, not speed. Arbitrate on client-reported time-since-render, clamped
  against the server's own send and receive times.
- **Advance must be optimistic.** Waiting for arbitration before moving on puts a
  visible stall on every question. Advance locally at once, settle the point a beat
  later, and be honest in the UI that the score is briefly provisional.
- **The steal must be legible.** A question changing mid-keystroke is disorienting
  unless the interface explains it in the same instant.
- **Disconnects need a policy.** Suggested: 10s presence grace, then the duel ends
  early on the score so far, marked as such. Awarding the remainder to whoever
  stayed invites pulling your ethernet cable.
- **It needs two people online simultaneously**, which at current traffic may be a
  feature nobody can use. Consider a lobby or matchmaking first.

Transport: Supabase Realtime Broadcast for advance, Presence for liveness,
a `SECURITY DEFINER` RPC for arbitration (`duel_points` keyed
`PRIMARY KEY (duel_id, question_index)` so the award is one conflicting insert).
Check Realtime's free-tier concurrent-connection and message caps before committing.

---

## 4. Delete account

Deliberately cut from the settings page. Needs a proper cascade:

- `game_sessions`, `daily_attempts`, `duel_runs`, `league_members`
- **League ownership transfer** — the same rule `leave_league` already implements
  (longest-standing member inherits; last member out deletes the league)
- Duels in flight — an opponent mid-run should get a coherent outcome, not a
  dangling reference
- The `auth.users` row itself, which needs a `SECURITY DEFINER` function

A half-done delete is worse than none. Model it on `leave_league`.

---

## 5. Demo video

Originally requested, deferred in favour of the social features (a share loop
compounds; a video decays). The case is stronger now that there is a product to
show.

`docs/demo-video-guide.md` is a full reference — structure, capture pipeline,
anti-slop checklist, motion/type/colour/sound tokens. A capture harness approach was
verified: Playwright with `deviceScaleFactor: 2` **and**
`--force-device-scale-factor=2` (both, or you get gray padding), seeded RNG for
determinism, screenshot-per-frame.

**Watch for:** a stubbed or failed dependency renders a blank frame while reporting
success. This has happened twice in this project (a HyperFrames render, and a
Chart.js-stubbed pace graph). Always extract a frame and look at it.

---

## 6. Known gaps, none blocking

- [ ] **Dead code in `js/db.js`** — pre-hardening fallback branches that can no
      longer be reached now the migrations are applied. Harmless, misleading to read.
- [ ] **`session_key` / `config_key` are 32-bit** and enumerable. Duel keys are 48
      bits, league codes ~49. These two predate the social work.
- [ ] **Background-tab timer drift is unverified.** The fix anchors to a wall-clock
      deadline rather than accumulated ticks, but headless Chromium does not throttle
      background tabs, so the condition could not be reproduced. Needs a real browser,
      backgrounded, mid-run.
- [ ] **No CI.** Everything above is run by hand. A GitHub Action running `npm test`
      plus the browser suites would catch regressions on push.
- [ ] **No LICENSE.**
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
