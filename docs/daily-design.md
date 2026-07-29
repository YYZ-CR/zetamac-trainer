# Zetamac Daily — design

One puzzle a day. Everyone gets the same questions. One ranked attempt.

This is the piece the leaderboard actually rests on, and it is also the spine that
duels reuse — a duel is "two players, one sequence", which is this machinery with a
different sharing model. Building duels before this means building the spine twice.

## Why a shared daily sequence

The permanent objection to any Zetamac leaderboard is *"you got easier problems."*
It is a fair objection: the score depends on the draw. A shared sequence deletes it.

It also produces a share string with no design work — `Zetamac Daily #142 — 87` —
and a text string travels further than a screenshot because it survives every
platform. And it fixes the cold-start problem: a daily board with nine players is
still interesting ("4th of 9 today"), where an all-time board with nine players is
embarrassing.

One attempt is the load-bearing constraint, not a limitation. Unlimited retries turn
a leaderboard into a patience contest.

## The tension that shapes everything

A shared daily sequence *helps fairness and hurts anti-cheat*. If the sequence is
knowable before you play, someone solves it offline and types the answers back.

The resolution: **the sequence does not exist for you until you start, and starting
starts a server-side clock.** Pre-solving requires knowing the questions, knowing the
questions requires starting, and starting spends the one attempt you get. There is
nothing to gain.

## Where the questions come from

The server generates them and hands them to the client. Not a seed the client
expands.

This matters more than it looks. If the client expanded a seed, the server would
need an identical PRNG in PL/pgSQL to re-derive the questions for scoring — two
implementations of the same generator, in two languages, that must agree exactly
forever. That is a bug factory.

Instead, one day's questions are generated **once**, stored on the puzzle row, and
served to every player. Roughly 400 questions covers the fastest plausible run at
120 seconds; as JSONB that is a small payload, sent once.

Generation is lazy — the first `start_daily` of a new UTC day creates that day's
puzzle inside the transaction, with `ON CONFLICT DO NOTHING` to settle the race
between simultaneous first players. No scheduler, no cron, nothing to forget to
deploy.

## Schema

```sql
daily_puzzles (
  puzzle_date       DATE PRIMARY KEY,
  puzzle_number     INTEGER NOT NULL,      -- days since launch, for the share string
  config            JSONB   NOT NULL,      -- the canonical Zetamac default
  duration_seconds  INTEGER NOT NULL DEFAULT 120,
  questions         JSONB   NOT NULL,      -- [{display, operation, answer}, ...]
  created_at        TIMESTAMPTZ DEFAULT NOW()
)

daily_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  puzzle_date   DATE NOT NULL REFERENCES daily_puzzles(puzzle_date),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL,      -- server clock, never the client's
  submitted_at  TIMESTAMPTZ,
  score         INTEGER,                   -- recomputed server-side, never trusted
  answers       JSONB,                     -- [{i, value, elapsed_ms}]
  status        TEXT NOT NULL,             -- in_progress | complete | expired
  flagged       BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (puzzle_date, user_id)            -- the one-attempt rule, enforced by the DB
)
```

The `UNIQUE (puzzle_date, user_id)` constraint *is* the one-attempt rule. Enforcing
it anywhere else is enforcing it nowhere.

Ranked attempts require an account: an anonymous attempt cannot be limited to one,
so it cannot be ranked. Anonymous players can still play the daily unranked, and
`claim_session`-style claiming can attach it afterwards.

## RPCs

All `SECURITY DEFINER`, all `SET search_path = public`, following `social.sql`.

**`start_daily() → JSONB`** — creates today's puzzle if absent, creates the caller's
attempt, returns `{puzzle_number, duration_seconds, questions, started_at,
seconds_remaining}`. Called a second time it returns the *existing* attempt with the
remaining time, so a refresh or a dropped connection resumes rather than restarts.
Once the window has passed it returns the finished attempt and no questions.

**`submit_daily(p_answers JSONB) → JSONB`** — the only place a score is decided.

**`get_daily_leaderboard(p_date DATE, p_limit INTEGER) → JSONB`** — username, score,
accuracy, rank. Complete attempts only.

**`get_daily_status() → JSONB`** — has the caller played today, and what happened.
Drives the landing page without exposing anything.

## What `submit_daily` actually checks

The client sends answers. It does not send a score — it is not consulted about the
score at all.

- `submitted_at - started_at <= duration + 3s grace`, on the **server clock**. A
  client cannot pause, slow, or rewind this.
- Every answer is checked against the stored `questions`. The score is the count of
  correct ones.
- `elapsed_ms` must be non-decreasing and must not exceed the duration.
- Answers past the last one reachable within the duration are ignored.
- Submitting twice is refused; `status` is already `complete`.

Anything left after that is a bot, not a cheat — and bots get **flagged, not
blocked**. `flagged` records suspicion (implausibly low timing variance, a median
answer time below human floor) without pretending to a certainty the data does not
support. False positives on a leaderboard are worse than the occasional bot: banning
a fast honest player is unrecoverable, tolerating a bot for a day is not.

## Expiry

An attempt is live for `duration + grace` from `started_at`. Return inside that
window and it resumes with the real remaining time. Miss it and it closes at whatever
was submitted, which may be nothing.

Harsh, and correct: the alternative is starting a run, reading the questions, and
coming back tomorrow.

## Timezone

Resets at **midnight UTC**, and the UI says so with a live countdown. Any local-time
scheme means two players "on the same day" get different puzzles, which breaks the
one thing the daily exists to provide.

## Decisions

- **Puzzle #1 is 2026-07-27.** `puzzle_number = (puzzle_date - '2026-07-27') + 1`.
  This is a one-way door: it is baked into every share string ever posted, so it
  cannot be changed later without renumbering other people's screenshots.
- **Leaderboard is top 100 plus the caller's own row**, always, even when they are
  rank 4,000. Showing someone rank 4,000 out of a list that stops at 100 tells them
  nothing; showing their row in context tells them what to beat.
- **Config is the canonical Zetamac default** — addition 2–100 + 2–100,
  multiplication 2–12 × 2–100, subtraction and division as their reverses, 120
  seconds. Every other config stays unranked, which is what keeps the board honest.
- **A division divides by the first multiplication range.** `(a×b) ÷ a`, answer
  `b` — never `(a×b) ÷ b`. Under the default that is `876 ÷ 12`, not `876 ÷ 73`;
  Zetamac only asks the former, and dividing by an arbitrary two-digit number is a
  different skill. Subtraction may still take either operand, because its two
  ranges are identical and the choice is not observable.

## Exact payload shapes

```jsonc
// start_daily()
{
  "puzzle_number": 1,
  "puzzle_date": "2026-07-27",
  "duration_seconds": 120,
  "started_at": "2026-07-27T20:41:00Z",   // server clock
  "seconds_remaining": 120,               // 0 once the window has closed
  "status": "in_progress",                // in_progress | complete | expired
  "questions": [ { "display": "84 ÷ 7", "operation": "division", "answer": 12 } ],
  "result": null                          // the submitted result, once complete
}

// submit_daily([{ "i": 0, "value": 12, "elapsed_ms": 1430 }])
{ "score": 87, "total_answered": 91, "accuracy": 0.956,
  "puzzle_number": 1, "rank": 4, "players": 212, "flagged": false }

// get_daily_status()
{ "puzzle_number": 1, "puzzle_date": "2026-07-27", "duration_seconds": 120,
  "played": true, "status": "complete", "seconds_until_reset": 11940,
  "result": { "score": 87, "accuracy": 0.956, "rank": 4, "players": 212 } }

// get_daily_leaderboard("2026-07-27", 100)
{ "puzzle_number": 1, "players": 212,
  "rows": [ { "rank": 1, "username": "hexadecimal", "score": 104, "accuracy": 0.98 } ],
  "you":  { "rank": 4, "username": "…", "score": 87, "accuracy": 0.956 } }  // null if not played
```

`questions` is present **only** while an attempt is live. Once the window closes,
`start_daily` and `get_daily_status` return the result and no questions — otherwise
the day's puzzle leaks to anyone willing to burn an attempt early and read it later.
