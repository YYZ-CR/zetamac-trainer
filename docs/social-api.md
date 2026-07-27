# Social API contract

The database contract behind public profiles, percentiles, the daily run and leagues.
Client code in `js/db.js` calls these and nothing else — no table reads cross user
boundaries.

Applied by hand in the Supabase SQL Editor, in order:

1. `supabase/schema.sql` — base tables
2. `supabase/hardening.sql` — RLS lockdown (applied)
3. `supabase/social.sql` — everything below

## Why RPCs and not policies

`hardening.sql` reduced `profiles` to `profiles_select_own` and `game_sessions` to
`sessions_select_own`, because the anon key ships in `js/config.js` and a permissive
policy is therefore a public API. Public profiles need to cross that boundary, so
they go through `SECURITY DEFINER` functions that return a **fixed, minimal
projection**. Nothing here returns `auth.users` columns, `user_id`, or the
`questions` payload — only aggregates computed from it.

That is the whole design rule: widening happens in a function signature that can be
read in one screen, never in a policy.

---

## `get_public_profile(p_username TEXT) → JSONB`

Returns `NULL` when the username does not exist, or when the profile is not public
and the caller is not its owner. Owners always see their own profile so they can
preview it before publishing.

```json
{
  "username": "hexadecimal",
  "member_since": "2026-01-05T09:12:44Z",
  "is_public": true,
  "is_owner": false,
  "total_games": 142,
  "total_questions": 8123,
  "accuracy": 0.962,
  "bests": { "60": 41, "120": 84, "180": 121, "300": 198 },
  "ops": {
    "addition":       { "avg_ms": 1420, "count": 2100, "accuracy": 0.981 },
    "subtraction":    { "avg_ms": 1655, "count": 2043, "accuracy": 0.964 },
    "multiplication": { "avg_ms": 1980, "count": 1990, "accuracy": 0.951 },
    "division":       { "avg_ms": 2310, "count": 1990, "accuracy": 0.933 }
  },
  "history": [ { "d": "2026-07-21", "score": 78, "duration": 120 } ],
  "days_practiced": 44,
  "streak": 6
}
```

- `bests` — keys are only present for durations actually played.
- `ops` — keys only present for operations actually attempted. `avg_ms` is the mean
  `timeMs` over questions of that operation; `accuracy` is
  `1 - (questions with hadMistake / count)`.
  **Computed over the most recent 200 sessions only**, because it unnests the whole
  `questions` payload. `total_games`, `bests` and `accuracy` are all-time.
- `history` — up to the most recent 60 sessions, oldest first, for the sparkline.
- `streak` — consecutive UTC days with at least one session, ending today or
  yesterday. Zero if the last session is older than that.

## `get_score_percentile(p_score INTEGER, p_duration INTEGER) → JSONB`

```json
{ "score": 82, "duration": 120, "percentile": 0.78, "players": 412 }
```

The population is **one entry per player** — each player's best score at that
duration — not one per session, so grinding does not inflate the denominator.
`percentile` is the fraction of players whose best is strictly below `p_score`.

`percentile` is `null` when fewer than 5 players qualify.
**The client hides the figure entirely below `players >= 20`** and says so rather
than showing a percentile drawn from a handful of people. That threshold lives in
the client, in one place, so it can be tuned without a migration.

Only sessions from signed-in users count. Anonymous sessions have no `user_id` and
so cannot be attributed to a player.

## Visibility

`profiles.is_public BOOLEAN NOT NULL DEFAULT FALSE`.

Default private. The existing `profiles_update` policy already scopes updates to
`auth.uid() = id`, so the client toggles this with a plain `UPDATE` — no RPC needed.

## Indexes

- `idx_sessions_duration_score (duration_seconds, score DESC)` — percentile scan
- `idx_profiles_username_public (username) WHERE is_public` — profile lookup

## Testing

`supabase/test/` builds a throwaway local database from the migration files and
asserts this contract against it. It needs a local PostgreSQL 14+ server and never
touches your Supabase project.

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres supabase/test/run.sh
```

`00-shim.sql` stands in for the parts of Supabase the migrations depend on —
`auth.users`, an `auth.uid()` driven by a GUC so tests can impersonate any user, and
the `anon`/`authenticated` roles. `01-seed.sql` seeds the awkward cases on purpose: a
player with no games, a private profile, a broken streak, a player who only played
one duration, and an anonymous session with an impossible score that must never
reach a percentile population.

The suite applies `social.sql` **twice** on every run, because these files are pasted
by hand into the SQL editor and will eventually be pasted twice for real.

## Cost note

`get_score_percentile` aggregates every ranked session on each call. That is correct
and cheap at current volume and will need a materialised view of per-player bests
before it isn't. The function signature does not change when that happens.
