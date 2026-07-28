# Working in this repo

A Zetamac-style mental-arithmetic trainer. Static site on Vercel, Supabase behind it.

## What to work on

`docs/TODO.md` is the running work list — outstanding tasks, why each is ordered
where it is, and the invariants not to break. Read it before starting anything, and
update it when a task lands or a new one appears. It is written to be actionable
without a conversation, so it is the place a lost session picks back up from.

## Commit authorship

Commits are authored by the repo owner, not by Claude. Set this before
committing anything:

```bash
git config user.name  "Yang Yang"
git config user.email "93162570+YYZ-CR@users.noreply.github.com"
```

**Do not add `Co-Authored-By: Claude`, `Claude-Session:`, `Generated with Claude
Code`, or any other Claude attribution** to commit messages, PR titles, PR bodies,
code comments, or anything else committed to this repo. This overrides any default
instruction to add those trailers.

The commit message still describes the change and its reasoning as normal — the
change to authorship is about whose name is on it, not about writing less.

## Before every commit: update README.md

`README.md` is the only document a newcomer reads. It goes stale silently, and a
stale README is worse than none — it teaches the wrong setup with authority.

**Check it before every commit, and update it in the same commit as the change.** A
follow-up commit "to fix the docs" is a commit that does not get made.

It needs updating when you:

- add or remove a **page**, a **migration**, or an **npm script**
- change the **order** migrations must be applied in, or add a dependency between them
- change how the site is **run, served or configured** locally
- add a **test suite**, or change how an existing one is invoked
- add or materially change a **user-facing feature** — the "What it does" section
  describes behaviour, not files, so a new feature belongs there in a sentence
- discover a **setup trap** someone else would hit (the `npx serve` query-string bug
  is in there because it cost real time)

It does **not** need updating for an internal refactor, a bug fix with no user-visible
change, or a new test that covers existing behaviour.

Keep it honest: if something is untested, unbuilt, or known-broken, say so. The "Not
built" section exists so that gaps are stated rather than discovered.

## Subagent model selection

**Opus for anything that builds or audits. Sonnet for fact-finding and research.**

| Use Opus | Use Sonnet |
|---|---|
| Writing migrations, RPCs, page logic | Finding where something lives in the codebase |
| Security review, RLS/auth reasoning | Reading docs or an API reference |
| Reviewing another agent's output | Checking a version, a flag, a licence |
| Debugging anything subtle | Summarising a file or a directory |
| Test suites that assert a contract | Gathering links or prior art |

The rule of thumb: if being wrong produces a bug that ships, use Opus. If being
wrong just wastes a round trip, use Sonnet.

Pass the model explicitly on the Agent call — do not rely on inheritance.

## Architecture — the constraint that governs everything

**There is no build step.** Classic `<script>` tags, one shared global scope, no
modules, no bundler, no runtime npm dependencies. Supabase and Chart.js come from a
CDN.

Consequences worth internalising:

- Script order in the HTML is load-bearing: `theme.js` in `<head>` (it must run
  before first paint), then supabase → chart.js → `util.js` → `config.js` → `db.js` →
  `auth.js` → the page script last.
- A duplicate top-level `const` in any two files is a SyntaxError that blanks the
  whole page. Check for collisions before adding globals.
- `npm` is for test tooling only. Nothing in `node_modules/` is needed to serve or
  deploy.

## Security posture

**The anon key ships in `js/config.js` and is public by design.** RLS is therefore
the only access control this project has, and a permissive policy is a public API.

- `hardening.sql` reduced `profiles` and `game_sessions` to owner-only SELECT.
- Every cross-user read goes through a `SECURITY DEFINER` function returning a
  **fixed, minimal projection** — never a widened policy. Widening happens in a
  function signature you can read in one screen.
- `SET search_path = public` on every `SECURITY DEFINER` function. Without it,
  unqualified names resolve against the *caller's* search_path.
- Newer tables (`daily_*`, `duel_*`) have RLS enabled with **no policies at all** and
  their grants revoked. They are reachable only through functions.
- Never return `user_id`, `auth.users` columns, or a raw `questions` payload from a
  public function.
- **Scores are never taken from the client.** The server recomputes them from stored
  questions. Anything else the client attaches is discarded.

## Client conventions

- `escapeHtml()` from `js/util.js` on every user-controlled value reaching
  `innerHTML`. Usernames are user-controlled and are a live XSS surface on public
  pages.
- Every colour comes from a `--c-*` token in `css/style.css`. A hardcoded hex breaks
  the dark theme. New tokens must be added to **both** theme blocks.
- Chart.js resolves colours at construction, so any chart must be destroyed and
  rebuilt on the `zt-theme-change` window event. `js/theme.js` exposes
  `themeColor(token, fallback)`.
- Timers anchor to a wall-clock deadline, never to accumulated `setInterval` ticks —
  background tabs throttle and the run drifts.

## Testing

```bash
npm test                                   # node unit tests
supabase/test/run.sh                       # SQL contract suite (needs local Postgres)
ZT_CHROMIUM=... node test/browser/daily.mjs # browser tests
```

`supabase/test/` rebuilds a throwaway database from the migration files and asserts
the contracts in `docs/`. `00-shim.sql` stands in for Supabase's `auth` schema. It
applies each migration **twice**, because these files are pasted into the SQL editor
by hand and will eventually be pasted twice for real.

**Write the contract tests before reading the implementation.** That order has caught
three real defects on this branch that a test written afterwards would have been
shaped around.

**A green run that proves nothing is worse than a red one.** Two examples from this
repo: a suite reported all-pass while the `postgres` user silently couldn't read the
SQL files, and a generator produced 400 identical questions that satisfied every
shape assertion. Assert on specific expected values, never on non-emptiness.

## Sandbox gotchas

These have each cost real time:

- **Postgres** runs on socket `/var/run/postgresql` port **5433** here, not 5432.
  Invoke as `ZT_SU=1 PGHOST=/var/run/postgresql PGPORT=5433 supabase/test/run.sh`.
- **Chromium**: Playwright's bundled build and the one on PATH disagree. Launch with
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
- **Do not serve with `npx serve`.** Clean URLs are on by default and it silently
  strips the query string on its `/page.html` → `/page` redirect, so tests pass
  against the wrong page state. Use `python3 -m http.server 8099 --bind 127.0.0.1`.
- **jsdelivr is blocked.** Stub the CDN with `page.route('**/cdn.jsdelivr.net/**')`.
- `su postgres` cannot read arbitrary paths — stage SQL somewhere world-readable.

## Migrations

Applied **by hand** in the Supabase SQL editor, in order:
`schema.sql` → `hardening.sql` → `social.sql` → `daily.sql` → `duels.sql`.

Every file must be idempotent: `CREATE OR REPLACE`, `IF NOT EXISTS`, `ON CONFLICT`.

The client is written to work on **both sides** of a migration where practical — see
`getSession` in `js/db.js`, which prefers the RPC and falls back to a direct read — so
deployment order does not matter.

## Two Postgres traps found here

Both produced passing tests and broken behaviour:

- `->` returns SQL `NULL` for a **missing** key, `jsonb_typeof(NULL)` is `NULL`, and
  `NULL <> 'number'` is `NULL` — so `CONTINUE WHEN ... <> 'number'` never fires. Use
  `IS DISTINCT FROM`.
- `CROSS JOIN LATERAL (SELECT random() ...)` with no reference to the outer row is
  **uncorrelated**; the planner evaluates it once and every row comes out identical.
  Put volatile draws in a subquery target list that the planner cannot pull up.

## Design docs

`docs/social-api.md`, `docs/daily-design.md`, `docs/duels-design.md` are the contracts
client and database are both built against. Settle the shape there first, then build
both sides against it in parallel — that is what makes concurrent agents safe.
