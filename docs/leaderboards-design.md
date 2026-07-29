# Leaderboards and clans

The contract for the rename and for the global boards. Client and database are both
built against this file. It supersedes the naming in `docs/leagues-design.md`; the
mechanics there — invite codes, the member cap, ownership transfer — are unchanged
and still authoritative.

---

## The rename

| Was | Is | Where |
|---|---|---|
| Leagues | **Leaderboards** | the nav item, the page title, `leagues.html` |
| a league | **a clan** | every user-facing string |
| invite code | invite code | unchanged |

**Leaderboards** is now the section, and it holds two things: the **global boards**,
which everyone is on, and **your clans**, which are private groups you are invited
into. A clan board and a global board are the same idea at two scales, which is why
they live on one page.

### What is *not* renamed, and why

The database keeps `leagues`, `league_members`, `create_league`, `join_league` and
the rest. Renaming them buys nothing a user can see and costs a migration that drops
and recreates nine functions, against live data, with eight test suites to re-point.

That is a real cost and a real inconsistency, and it is written down here rather than
left to be discovered: **`league` in the schema means `clan` in the product.** If the
internals are ever renamed it should be its own change, with its own tests, on a day
when nothing else is moving.

---

## What is eligible, and what that costs

**`today` and `all_time` rank ordinary solo runs. `daily` does not.**

The three sources:

| Table | Scored by | Scopes | Forgeable |
|---|---|---|---|
| `daily_attempts` | `submit_daily`, from the stored questions | all three | no |
| `duel_runs` | `submit_duel_run`, the same way | `today`, `all_time` | no |
| `game_sessions` | **the browser** | `today`, `all_time` | **yes** |

### The cost, stated rather than hidden

`game_sessions` — every ordinary timed game — is written directly by the client:

```sql
CREATE POLICY "sessions_insert" ON public.game_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
```

The anon key ships in `js/config.js` and is public by design. **Anybody who reads that
file can insert a session with any score they like for themselves, and it will rank.**
`js/game.js` generates the questions in the browser and posts the finished number, so
the server has nothing to recount the answers against. No threshold, outlier rule or
plausibility filter fixes this — each one only tells a forger which number to pick.

An earlier revision of this document excluded `game_sessions` for exactly that reason.
It is included now because a leaderboard that none of your normal games appear on is
not the leaderboard that was asked for. **The forgeability is a known and accepted
cost**, carried until solo runs are server-scored.

The real fix is the server generating and storing the questions for every run, the way
the daily already does — a `start_run` / `submit_run` pair mirroring `start_daily` /
`submit_daily`. That is a feature, not a patch. It is in `docs/TODO.md`.

`get_score_percentile` reads `game_sessions` too, and always has. It is now the lesser
of the two exposures rather than the only one.

**`daily` is untouched by all of this** and remains the one board on the site that
cannot be forged: one puzzle, questions the server generated, one attempt. That is
worth keeping distinct, and it is why the `daily` scope reads `daily_attempts` alone
even though the other two scopes do not.

### Comparability — *not* relaxed

A leaderboard is only defensible if everyone answered comparable questions. Forgery is
one way that breaks; a different game is another, and that one happens without anybody
acting in bad faith.

- **Duration.** Duels run 15–600 seconds; a solo game runs whatever the form was set
  to. **Every board is fixed at the standard 120 seconds**, and says so in the heading.
  A 300-second run is not a better result, it is a longer one — the same trap as the
  Best tile on the dashboard.
- **Settings.** Daily puzzles and duels are both generated from
  `daily_default_config()`, so their operations and ranges already match. A solo game
  does not have to: `index.html` will happily produce 120 seconds of single-digit
  addition, which scores several times the default. So **a `game_sessions` row
  qualifies only when its stored `game_configs.config` equals `daily_default_config()`
  exactly.** `readFormConfig()` in `js/index.js` emits precisely that key set, so a
  default-settings game matches on the nose and a custom game ranks nowhere.

Without the second rule the board would be meaningless even with nobody cheating,
which is a worse failure than the one being accepted.

---

## The three global boards

One page, three tabs. Every row is `rank · username · score`, and nothing else — no
user ids, no session keys, no dates that could identify a run.

**They are offered in the order All-Time Best · Today's Best · Today's Daily, and
All-Time Best is the landing board.** That is the board a stranger arriving here is
asking about — who is best at this — and it is the only one of the three that is
never empty once anybody has ever played. The tabs then narrow from left to right:
ever, today, today's puzzle.

Today's Daily led in an earlier revision, on the argument that it is the most
defensible ranking on the site. That is still true, and it is still what its own
footer says — but it is an argument about trustworthiness rather than about what
somebody opened the page to see, and it put the narrowest board in front of the
broadest.

The order lives in `GLOBAL_BOARDS` in `js/leagues.js`, one array, and the default
scope is read from its first entry rather than written out separately, so a reorder
cannot leave the page rendering three tabs with none of them active.
`GLOBAL_BOARD_SCOPES` in `js/db.js` is a validation **set** and carries no order.

The boards are numbered below in the order they were designed, which is no longer the
order they are shown in; the numbers are references, not positions.

### 1. Today's Daily

*Third tab.* Rank on today's puzzle. This is the most defensible board on the site:
one puzzle, the same questions for everyone, one attempt.

**It is not a projection of `get_daily_leaderboard`.** An earlier draft said it was,
and that turned out to make the three tabs of one page behave differently:
`get_daily_leaderboard` uses `RANK()` and shares a rank between tied players, while
the other two boards number with `ROW_NUMBER()` and break ties on the earlier
submission. Two players on 8100 came back as `rank 1, rank 1` on one tab and
`rank 1, rank 2` on the next.

So this board computes its own ranking, by the same three rules as the others: the
unnamed dropped first, `ROW_NUMBER()`, ties to the earlier `submitted_at`.
`get_daily_leaderboard` keeps its own behaviour for its own caller — the daily page —
and its suite still pins the shared ranks there. One page, one ranking rule.

### 2. Today's Best

*Second tab.* The best 120-second default-settings run today, one row per player,
across daily attempts, duel runs and solo games. Distinct from board 1 because a duel
you won at 91, or a practice-day best, belongs on a "today" board even though it was
not the daily.

Ties break on the earlier `submitted_at`: first to get there holds the higher rank.

### 3. All-Time Best

*First tab, and the one the page lands on.* The same, without the date filter. One row
per player — a player's own second-best run never displaces somebody else.

---

## `get_global_board(p_scope TEXT, p_limit INTEGER) → JSONB`

`SECURITY DEFINER`, `SET search_path = public`, `EXECUTE` to `anon` and
`authenticated` — a leaderboard nobody can read while signed out is not a
leaderboard, and it is the one page worth landing a stranger on.

- `p_scope` is `'daily' | 'today' | 'all_time'`. Anything else is an error payload,
  not an exception, and never a silent fallback to a different board.
- `p_limit` is clamped to a sane maximum server-side. A client asking for 100,000
  rows gets the maximum, not a timeout.
- Returns `{scope, duration_seconds, generated_at, rows: [{rank, username, score}]}`.
- `p_limit` maxes at **100**, the same ceiling `get_daily_leaderboard` uses. A client
  can plan for that number.
- **Never returns `user_id`, an email, a session key, a `questions` payload, or a
  row for a player with no username.** A player without a username has no name to
  show and is skipped rather than rendered as "—", which would otherwise be a row of
  anonymous placeholders at the top of a public page.
- **The unnamed are dropped before ranking and before the limit, on every scope.**
  Dropping them afterwards leaves a public board that opens at rank 2 with a hole in
  it and returns fewer rows than were asked for while named players are still
  waiting — which reads as broken software rather than as a thin board. An account
  can reach the daily with no username: `start_daily` needs only `auth.uid()`, and
  nothing creates a `profiles` row automatically.
- **Every scope filters on `duration_seconds = 120`, including `daily`.** The payload
  states 120; a board that says so without checking would mislabel a day published at
  another duration, and `daily_puzzles.duration_seconds` is a real column.
- A player whose profile is **private is still on the board.** The board shows a
  username and a score, which is what a leaderboard is; `is_public` governs whether
  the *profile page* is readable, not whether the score counts. The test suite pins
  this.
- **The board links no username at all**, and that follows from the row shape rather
  than contradicting it. The payload carries no `is_public` — by design it carries no
  field beyond `rank`, `username`, `score` — so the page cannot tell a published
  profile from a private one, and public is opt-in and off by default. Linking every
  row would send most clicks to "this profile is private", and a link that usually
  fails teaches people not to press the ones that work. So one rule holds site-wide:
  **a linked username always means a published profile.** A clan board has the flag
  and does link; a global board does not and does not.
- An unknown scope returns `{ok: false, error: 'invalid_scope', scope: <echoed>}` and
  no `rows` key. A client should treat **any payload without a `rows` array** as a
  failure rather than as an empty board — the two must never look alike.

### What the suite must prove

Contract tests, written before reading the implementation, as everything else here
was:

1. **A `game_sessions` row ranks on `today` and `all_time`, and on `daily` it does
   not.** This is the assertion the whole design now turns on, in both directions —
   write it first. The suite states in the same place that such a row is unverified,
   so nobody later reads a passing test as evidence the score was checked.
2. One row per player on `today` and `all_time`, even with several qualifying runs.
3. The 120-second restriction: a 300-second run scoring higher does not rank, from any
   of the three sources.
3b. The settings restriction: a 120-second solo run on a **custom** config does not
   rank, however high it scored, and a run whose `config_key` is NULL does not rank.
4. `daily` matches `get_daily_leaderboard` for the same day.
5. An unknown scope returns an error payload and no rows.
6. The limit is clamped.
7. No `user_id` or other identifier appears anywhere in the payload.
8. A player with no username is absent, not blank.
9. A private-profile player is present.
10. `anon` can call it; the underlying tables remain unreadable directly.

---

## Clans

Mechanically unchanged from `docs/leagues-design.md`: an invite code, a named group,
a member cap, ownership transferring to the longest-standing member when the owner
leaves, and the code is not a directory — a non-member sees the name, the owner and a
count, never the roster.

What changes is the words. "League" becomes "clan" in every string a user reads,
including the empty states, the error messages surfaced from the RPC error codes, and
the invite copy. The RPC error codes themselves (`league_not_found`,
`league_full`, `league_not_member`) are wire identifiers and stay as they are; the
client maps them to sentences that say "clan".

A clan board and a global board should look like the same object at two scales —
same row shape, same type, same numbering. They are not identical and should not be:
a clan board ranks a fixed roster over the day's puzzle and offers a seven-day mean,
which no global board does, and it can show an owner tag, a highlighted own-row and
members who have not played, because it has a roster and an `is_you` to work from.
Every one of those has a reason a global board cannot have. **A difference without
one is a drift.**
