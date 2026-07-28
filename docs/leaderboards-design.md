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

## The integrity rule the global boards turn on

**Only server-scored runs are eligible for a global board.**

`game_sessions` — ordinary solo runs, including practice — is written directly by the
client:

```sql
CREATE POLICY "sessions_insert" ON public.game_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
```

The anon key ships in `js/config.js` and is public by design, so anybody can insert a
session with any score they like for themselves. That has never mattered, because
those rows only fed the owner's own dashboard. **The moment they feed a public
ranking, the top of that ranking is whoever first thought to type a large number.**

So the global boards are built from the two sources the server scores itself:

- `daily_attempts` — scored by `submit_daily` from the stored questions.
- `duel_runs` — scored by `submit_duel_run` the same way.

In both, the client sends answers and the server counts them. A forged score is not
possible without forging the answers to questions the server generated.

### Two consequences, both stated rather than hidden

- **Practice and solo runs do not appear on any global board.** They still drive your
  own dashboard, your own analysis and your own bests. They are a personal record,
  not a competitive claim.
- **`get_score_percentile` still reads `game_sessions`**, and it is public-facing.
  That predates this document and is the same weakness at lower stakes — a percentile
  is a soft comparison, not a ranking with a name at the top. It is listed in
  `docs/TODO.md` rather than quietly left.

Making solo runs eligible means the server generating and storing the questions for
every run, the way the daily does. That is a real feature, not a patch, and it is not
in this change.

### Comparability

A leaderboard is only defensible if everyone answered comparable questions. Daily
puzzles and duels are both generated from `daily_default_config()`, so the operations
and ranges already match. Duration does not: duels run 15–600 seconds.

**The global boards are fixed at the standard 120 seconds**, and say so in the
heading. A 300-second run is not a better result, it is a longer one — the same trap
as the Best tile on the dashboard.

---

## The three global boards

One page, three tabs. Every row is `rank · username · score`, and nothing else — no
user ids, no session keys, no dates that could identify a run.

### 1. Today's Daily

Rank on today's puzzle. This is the most defensible board on the site: one puzzle,
the same questions for everyone, one attempt.

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

The best server-scored 120-second run today, one row per player, across daily
attempts and duel runs. Distinct from board 1 because a duel you won at 91 belongs on
a "today" board even though it was not the daily.

Ties break on the earlier `submitted_at`: first to get there holds the higher rank.

### 3. All-Time Best

The same, without the date filter. One row per player — a player's own second-best
run never displaces somebody else.

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
  the *profile page* is readable, and the row's name links there only when it is.
  This is a deliberate distinction and the test suite pins it.

### What the suite must prove

Contract tests, written before reading the implementation, as everything else here
was:

1. **A forged `game_sessions` row with a score of 9999 does not appear on any board.**
   This is the assertion the whole design exists for; write it first.
2. One row per player on `today` and `all_time`, even with several qualifying runs.
3. The 120-second restriction: a 300-second duel run scoring higher does not rank.
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
same row shape, same type, same ranking rules. If a clan board still shows a metric
the global boards do not, that is a difference worth having a reason for.
