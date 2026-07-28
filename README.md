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
until both are done. Ends on a pace graph. Guests can play without an account.

**Private leagues** — an invite code, a named group, and a board over the day's
puzzle. Being 3rd of 6 behind people you know is a better reason to practise than
being 4,000th behind strangers.

**Public profiles** at `/@username`, with a per-operation breakdown (`+ 1.42s ·
− 1.66s · × 1.98s · ÷ 2.31s`) and a percentile. Private by default.

**A share card** rendered client-side to a canvas, in whichever theme you are using.

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

Two themes: the original Zetamac light palette, reproduced value for value, and a
Monkeytype-flavoured dark one.

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
| `supabase/leagues.sql` | private leagues |
| `supabase/settings.sql` | `set_username`, rename cooldown, column-level grants |

Two ordering constraints, both real:

- `duels.sql` calls functions defined in `daily.sql`, so daily comes first.
- **`settings.sql` must be last.** It revokes the client's column grants on
  `profiles` and replaces `username_available`. Re-running `hardening.sql` after it
  would hand those grants back and undo half of it. If you ever re-apply an earlier
  file, re-apply `settings.sql` afterwards.

**Every file is idempotent, and re-running one is the supported way to deploy a
change.** The test suite applies each migration twice on every run to guarantee that,
because these get pasted by hand and someone eventually pastes twice.

Supabase's SQL editor will warn *"this query includes destructive operations"* on
most of these. It is a static scan: the files contain `REVOKE` (removing default
grants from tables the same file just created), `ALTER TABLE … ENABLE ROW LEVEL
SECURITY`, and `DELETE` statements that sit **inside function bodies** and only run
when a user leaves a league. There is no `DROP TABLE` or `TRUNCATE` anywhere.

## Testing

```bash
npm test                       # node unit tests
npm run test:sql               # SQL contract suite — needs a local PostgreSQL 14+
ZT_CHROMIUM=<path> node test/browser/daily.mjs     # browser tests
ZT_CHROMIUM=<path> node test/browser/duel.mjs
ZT_CHROMIUM=<path> node test/browser/leagues.mjs
ZT_CHROMIUM=<path> node test/browser/dashboard.mjs
ZT_CHROMIUM=<path> node test/browser/nav.mjs
ZT_CHROMIUM=<path> node test/browser/settings.mjs
```

`npm test` includes a check that the client-side username rule in `js/util.js`
matches the `CHECK` constraint in `supabase/settings.sql` exactly — the same rule
stated in two languages is a rule that drifts, and a mismatch means registration
accepts a name the database then refuses.

`supabase/test/` rebuilds a throwaway database from the migration files and asserts
the contracts in `docs/` against it. `00-shim.sql` stands in for the parts of Supabase
the migrations depend on — `auth.users`, an `auth.uid()` driven by a GUC so tests can
impersonate any user, and the `anon`/`authenticated` roles. Nothing touches your real
project.

`supabase/test/race-*.sh` drive real concurrent sessions at the two places where a
check-then-act bug would hide: claiming the single opponent slot in a duel, and the
last seat in a full league.

Browser tests stub the CDN and the Supabase client, so the real page scripts run
against a fake network.

## Architecture

**There is no build step.** Classic `<script>` tags, one shared global scope, no
modules, no bundler, no runtime dependencies. Supabase and Chart.js come from a CDN.

Script order in the HTML is load-bearing: `theme.js` in `<head>` (it must run before
first paint), then supabase → chart.js → `util.js` → `config.js` → `db.js` →
`auth.js` → the page script last.

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
`social-api.md`, `daily-design.md`, `duels-design.md`, `leagues-design.md`. Settle
the shape there first, then build both sides against it.

`docs/demo-video-guide.md` is unrelated to the app: a general reference for producing
demo videos.

## Planned

`docs/TODO.md` is the full work list. In short:

**A first-run walkthrough.** Someone arriving for the first time sees a config
screen and a Start button, and nothing tells them the daily, duels, leagues,
practice mode or the per-operation analysis exist. A one-time popup should walk
through each feature, be dismissible, and never appear twice.

Worth building **last**, deliberately: a walkthrough is a description of the
product, so every feature added before it is written is a feature the tour has to
be rewritten for. It also needs a decision on where "seen it" is stored —
localStorage means it reappears on a second device, a profile column means it
follows the account but does nothing for signed-out visitors.

## Not built

**Steal mode** for duels — first correct answer takes the point and both players jump
to the next question. It needs both players online simultaneously, latency-compensated
arbitration, and optimistic advance; the design is written up in
`docs/duels-design.md`.
