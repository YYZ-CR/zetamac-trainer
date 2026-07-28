# Arithmetic Trainer

A mental-arithmetic trainer in the style of [Zetamac](https://arithmetic.zetamac.com),
with the part that was missing: it tells you *why* your score is what it is, and it
gives you people to measure it against.

Static site, no build step. Supabase behind it.

## What it does

**The game** — the same 120-second arithmetic drill, with the original's look and
feel preserved exactly. Configurable operations, ranges and duration.

**Analysis instead of a bare number.** Every question is timed to the millisecond,
so a finished run yields a run graph (projected score over the run, showing where you
sagged), a per-question breakdown, and concrete technique tips for the questions that
cost you — `84 ÷ 7` → `70 ÷ 7 = 10`, `14 ÷ 7 = 2`, `= 12`.

**Practice mode** weights your weakest question types higher, so drilling goes where
the time is actually being lost rather than where it is comfortable.

**Zetamac Daily** — one puzzle a day, the same questions for everyone, one attempt.
The shared sequence is what makes a leaderboard defensible: the usual objection to
any arithmetic ranking is "you got easier problems", and this removes it.

**Duels** — send a link, you both answer the same sequence, neither sees a score
until both are done. Ends on a pace graph of both players' runs. Guests can play
without an account.

**Steal mode** — the same link, played live. The first correct answer takes the
point and *both* players jump to the next question, so every question is a race.
Arbitration runs on time-since-the-question-appeared, clamped against what the
server itself observed, because awarding the point to whoever's packet arrived
first would make it a contest of who has the better connection.

**Private leagues** — an invite code, a named group, and a board over the day's
puzzle. Being 3rd of 6 behind people you know is a better reason to practice than
being 4,000th behind strangers.

**Your dashboard** opens on a five-tile record of everything you have done — total
games, questions answered, your best score, days practiced and current day streak —
over a score-over-time chart, a per-operation breakdown and a paged list of recent
games. The Best tile is the best at the duration you play most and says which
(`BEST · 120S`): scores at different run lengths are different measurements, and a
single figure pooled across them would just be your longest run every time. A line
under the tiles carries the average of your last 10 games.

**Public profiles** at `/@username` are the same page for somebody else to read: the
same five tiles, the same chart and the same per-operation breakdown
(`+ 1.42s · − 1.66s · × 1.98s · ÷ 2.31s`), with a percentile in the line under the
tiles. Private by default.
**Recent games are the dashboard's alone** — `get_public_profile` returns no
per-session rows, and a public page listing them would be a cross-user data exposure.

**A share card** rendered client-side to a canvas, in whichever theme you are using,
offered at the end of a run.

**Settings** at `/settings.html` — username, profile visibility, theme and account in
one place. The public/private toggle lives here rather than on the dashboard: the
dashboard is about what you have scored, and this is about who may see it.

A username is the identity every leaderboard, league board and duel names you by, so
it is held to it: 3–20 characters of `A-Za-z0-9_-`, no name that collides with an
existing one by case alone, and **one change every 30 days** — the first one you set
is free. The rules are the database's, not the page's. `set_username` is the only way
a username is ever written, and the client's permission to update the column is
revoked outright, by a column-level grant rather than by a policy. `supabase/settings.sql`
says why each rule is there.

If an account ends up without a username — registration can leave it that way when
email confirmation is enabled — both Settings and the dashboard offer a way to claim
one.

**Deleting an account** is at the bottom of the same page, fenced off in a Danger
zone: collapsed until you ask for it, and it lists what goes before it shows you the
field. To confirm you type your own username (or the literal `DELETE` if you never
set one), and the button stays disabled until that matches. The delete itself is one
`delete_account` call — the client never names an account, and the id deleted is
always the caller's. On success the page signs you out before it navigates, because
the access token stays valid until it expires on its own.

Deletion is not a `DELETE FROM auth.users`: a league you own would take every other
member's board down with it, and your old sessions would keep feeding everybody's
percentile. So each row has a stated fate — leagues you own are handed to their
longest-standing remaining member, duels you created go with you, duels you only
played in stay and show you as a deleted account, and your username is released.
`docs/account-deletion.md` is the contract, and `supabase/account.sql` implements it.

**A first-run walkthrough.** A first visit to the home page opens a seven-step tour:
a welcome, then the analysis, practice mode, the daily, duels, leagues and the
profile — because all of it sits *behind* a run the visitor has not done yet. The
welcome step answers the two questions that come before any feature — **playing needs
no account**, and signing in is what saves your history, puts you on the boards and
gives you a profile — and the last step says the tour reopens from "How this works",
so closing it costs nothing.

Each step after the welcome **spotlights the control it is describing**: the rest of
the page darkens, the target is outlined, and the panel sits beside it with a caret
pointing at it. A step whose target is missing, hidden or off-screen falls back to a
plain centered panel rather than ringing empty space — the nav is built from the
session, so that case is real rather than theoretical. The welcome step names no
target at all and uses that same centered layout deliberately.

It is shown once and closes five ways (Esc, ×, Skip, the backdrop, or finishing), every one
of which counts as seen, and it is offered again from "How this works" in the footer.
"Seen it" is a `localStorage` key holding the tour's version, so bumping that version
shows a materially changed tour again; the cost is that it reappears on a second
device, which is the right trade when most first-time visitors have no account to
hang it on. `docs/walkthrough-design.md` is the contract, and the step list is one
array at the top of `js/tour.js`.

**A privacy policy and terms of service** at `/privacy.html` and `/terms.html`,
linked from the footer of every page that has one. They are written against what this
site actually does rather than from a template: the exact columns stored, the
`localStorage` keys and what each is for, the three third parties that see a request
(Supabase, the host, and jsDelivr — which sees an IP on every page load), the fact
that there is no analytics of any kind, and a deletion section that agrees line for
line with `docs/account-deletion.md`. Both carry a `[contact email]` placeholder that
has to be filled in before they are true.

Two themes: the original Zetamac light palette, reproduced value for value, and a
Monkeytype-flavored dark one.

## Running it locally

```bash
git clone <this repo> && cd zetamac-trainer
cp js/config.example.js js/config.js     # then fill in your Supabase URL and anon key
python3 -m http.server 8099 --bind 127.0.0.1
```

Open <http://127.0.0.1:8099>.

⚠️ **Do not serve with `npx serve`.** Clean URLs are on by default and it silently
strips the query string on its `/page.html` → `/page` redirect, so shared links and
tests resolve against the wrong page state.

There is nothing to build and nothing to install to run the site. `npm` is only for
the test tooling.

## Database setup

Apply these **by hand** in the Supabase SQL editor, in this order:

| File | What it adds |
|---|---|
| `supabase/schema.sql` | base tables — configs, sessions, profiles |
| `supabase/hardening.sql` | RLS lockdown; owner-only reads |
| `supabase/social.sql` | public profiles, percentiles |
| `supabase/daily.sql` | Zetamac Daily, server-authoritative scoring |
| `supabase/duels.sql` | duels — **depends on `daily.sql`** for the question generator |
| `supabase/steal.sql` | steal mode — must go **immediately after `duels.sql`** |
| `supabase/leagues.sql` | private leagues |
| `supabase/settings.sql` | `set_username`, rename cooldown, column-level grants |
| `supabase/account.sql` | `delete_account` — the ordered cascade for deleting an account |

Four ordering constraints, all real:

- `duels.sql` calls functions defined in `daily.sql`, so daily comes first.
- **`steal.sql` goes immediately after `duels.sql`, and `duels.sql` is never applied
  after it on its own.** `steal.sql` replaces `create_duel` with a version taking a
  mode argument and drops the one-argument original; re-applying `duels.sql`
  afterwards puts that original back, and `create_duel(120)` then matches two
  functions and fails as ambiguous. Re-apply `steal.sql` straight after any
  re-application of `duels.sql`.
- **`settings.sql` goes after every file that touches `profiles`.** It revokes the
  client's column grants on `profiles` and replaces `username_available`. Re-running
  `hardening.sql` after it would hand those grants back and undo half of it. If you
  ever re-apply an earlier file, re-apply `settings.sql` afterwards.
- **`account.sql` is last.** `delete_account` reads tables from every file above it,
  and plpgsql resolves those names when the function is *called*, not when it is
  created — so pasting this one early appears to work and then fails on the first
  real deletion, part-way through an account. It only adds a function, so it takes
  nothing back from `settings.sql` and does not need re-applying after it.

**Every file is idempotent, and re-running one is the supported way to deploy a
change.** The test suite applies each migration twice on every run to guarantee that,
because these get pasted by hand and someone eventually pastes twice.

Supabase's SQL editor will warn *"this query includes destructive operations"* on
most of these. It is a static scan: the files contain `REVOKE` (removing default
grants from tables the same file just created), `ALTER TABLE … ENABLE ROW LEVEL
SECURITY`, and `DELETE` statements that sit **inside function bodies** and only run
when a user leaves a league or deletes their own account. There is no `DROP TABLE`
or `TRUNCATE` anywhere.

## Testing

```bash
npm test                       # node unit tests
npm run test:sql               # SQL contract suites — needs a local PostgreSQL 14+
npm run test:browser           # every browser suite, one after another
```

The browser suites need a server on port 8099 (`npm run dev`) and Playwright's
Chromium (`npm install && npx playwright install chromium`). Run one on its own with
`node test/browser/duel.mjs`; set `ZT_CHROMIUM=<path>` to point at a different
Chromium build, and `ZT_BASE=<url>` to serve from a different port.

`test/browser/mobile-nav.mjs` is the widest of them: six viewport widths by two
themes by signed-in and signed-out, across every page that has a header. It exists
because the header used to overflow *leftward* on a phone, so every check of the
right edge passed while the link back to the game sat outside the viewport. It ends
with a negative control that neutralizes the media query and requires the overflow to
come back.

`test/browser/dashboard.mjs` and `test/browser/profile.mjs` are a pair: they render the
same stubbed payload through both pages and assert the same numbers out of each, so a
change that moves one and not the other fails. `profile.mjs` also asserts, positively,
that the public page never reads `game_sessions` and has no per-game table in it.

All three run on every push, as three jobs in `.github/workflows/ci.yml`. The SQL job
brings up its own `postgres:16` service, so nothing there touches a real project.

`npm test` includes a check that the client-side username rule in `js/util.js`
matches the `CHECK` constraint in `supabase/settings.sql` exactly — the same rule
stated in two languages is a rule that drifts, and a mismatch means registration
accepts a name the database then refuses.

`supabase/test/` rebuilds a throwaway database from the migration files and asserts
the contracts in `docs/` against it. `00-shim.sql` stands in for the parts of Supabase
the migrations depend on — `auth.users`, an `auth.uid()` driven by a GUC so tests can
impersonate any user, and the `anon`/`authenticated` roles. Nothing touches your real
project.

`supabase/test/race-*.sh` drive real concurrent sessions at the three places where a
check-then-act bug would hide: claiming the single opponent slot in a duel, the last
seat in a full league, and two steal-mode players answering the same question at
once. Each ends with a **negative control** — the same race with the guard removed —
because a race test that has never failed proves nothing.

Steal mode's live behavior over Supabase Realtime is **not** covered by any of this:
the browser suite stubs the channel, and two real clients over a real socket is a
manual check against the deployed project.

Browser tests stub the CDN and the Supabase client, so the real page scripts run
against a fake network.

## Architecture

**There is no build step.** Classic `<script>` tags, one shared global scope, no
modules, no bundler, no runtime dependencies. Supabase and Chart.js come from a CDN.

Script order in the HTML is load-bearing: `theme.js` in `<head>` (it must run before
first paint), then supabase → chart.js → `util.js` → `config.js` → `db.js` →
`auth.js` → the page script last. `dashboard.html` and `profile.html` load one more,
`js/stats.js`, between `auth.js` and their page script: the stat strip and the
operation bars are the same markup on both, and one copy is what stops the two
pages disagreeing about the same account.

### Security

**The anon key ships in `js/config.js` and is public by design**, so RLS is the only
access control this project has and a permissive policy *is* a public API.

Every cross-user read goes through a `SECURITY DEFINER` function returning a fixed,
minimal projection — never a widened policy. The newer tables (`daily_*`, `duel_*`,
`league_*`) have RLS enabled with **no policies at all** and their grants revoked;
they are reachable only through those functions.

**Scores are never taken from the client.** The server recomputes them from the
stored questions, and anything else the client attaches is discarded.

### Docs

`docs/` holds the contracts the client and database were both built against —
`social-api.md`, `daily-design.md`, `duels-design.md`, `steal-mode-design.md`,
`leagues-design.md`, `account-deletion.md`, `walkthrough-design.md`. Settle the shape there first, then build both sides against it.

`account-deletion.md` is the one to read before touching a foreign key: it states the
fate of every row that mentions an account, and `supabase/account.sql` is that list in
order. Deleting an account is not a cascade — two of the foreign keys cascade
destructively, and the function exists to get in front of them.

`docs/demo-video-guide.md` is unrelated to the app: a general reference for producing
demo videos.

## Planned

`docs/TODO.md` is the full work list. No feature is outstanding. What is left there
is deployment — the newer migrations still have to be applied by hand against the
real project, in the order of the table above — plus the demo video below and the
known gaps that file lists (`config_key` is still a 32-bit content hash, and
background-tab timer drift has never been reproduced in headless Chromium).

## License

MIT. See `LICENSE`.

## Not built

**A demo video.** `docs/demo-video-guide.md` has the structure and the capture
pipeline worked out; nothing has been shot.
