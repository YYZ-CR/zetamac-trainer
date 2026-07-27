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

## Open questions

- **Puzzle #1 date** — fixes `puzzle_number` forever; pick it deliberately.
- **Leaderboard depth** — top 100 plus the caller's own row is the usual shape.
  Showing rank 4,000 to rank 4,000 is worse than showing them a percentile.
- **Config** — the canonical Zetamac default (2–100 add, 2–12 × 2–100, 120s). Every
  other config stays unranked, which is also what keeps the main leaderboard honest.
