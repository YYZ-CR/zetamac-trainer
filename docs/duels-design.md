# Duels — design

Send someone a link. You both get the same questions. Compare.

This document covers the **classic duel** only. Steal mode — first correct answer
takes the point and both players jump to the next question — is a real-time
distributed system and is deliberately not in scope here. See the last section.

## What this reuses

A duel is "two players, one sequence", which is the machinery `daily.sql` already
builds: server-generated questions, revealed only on start, a server-stamped clock,
and scoring recomputed from submitted answers. Duels reuse the question generator
and the same submission discipline rather than growing a second copy.

The one structural difference: a duel's sequence is generated **per duel** rather
than per day, and both players draw from the same stored list.

## Asynchronous on purpose

Players do not need to be online at the same time. Create → send → they play whenever
→ both see the result. That matters more than it sounds:

- Real-time requires two people free simultaneously. At current traffic that is a
  feature nobody can use.
- Async duels work across timezones and group chats, which is where the audience is.

## Guests must be able to accept

If accepting a duel requires signing up, the loop dies exactly when it was working —
at the moment someone was interested enough to click.

An anonymous opponent gets a guest token stored in `localStorage` and passed to the
RPCs. The duel is playable, the result is real, and the existing `claim_session`
pattern lets them attach it to an account afterwards.

The creator must be signed in. Somebody has to own the duel, and an unowned duel has
nobody to notify and nobody to rematch.

## Nobody sees a score until both are done

The second player must not know the target. Knowing you need 84 changes how you play
— it turns a run into a chase, and it makes the comparison meaningless.

`get_duel_by_key` therefore returns the opponent's score only once both runs are
complete (or the duel has expired). Before that it returns only whether they have
played.

The same gate covers `points`, the per-side pace timeline the graph is drawn from
(below). Withholding a live opponent's pace is the same rule as withholding their
score: watching someone bank their 40th point at 55 seconds is a chase target too.

## Schema

```sql
duels (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  duel_key            TEXT UNIQUE NOT NULL,      -- the shareable link
  creator_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  opponent_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  opponent_guest_token TEXT,                     -- set when the opponent is a guest
  config              JSONB NOT NULL,
  duration_seconds    INTEGER NOT NULL,
  questions           JSONB NOT NULL,            -- generated once, shared by both
  status              TEXT NOT NULL,             -- open | complete | expired
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,      -- created_at + 48h
  CHECK (opponent_id IS NULL OR opponent_guest_token IS NULL)
)

duel_runs (
  duel_id      UUID NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
  side         TEXT NOT NULL,        -- 'creator' | 'opponent'
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  guest_token  TEXT,
  started_at   TIMESTAMPTZ NOT NULL, -- server clock
  submitted_at TIMESTAMPTZ,
  score        INTEGER,              -- recomputed server-side, never trusted
  answers      JSONB,                -- [{i, value, elapsed_ms}]
  status       TEXT NOT NULL,        -- in_progress | complete | expired
  PRIMARY KEY (duel_id, side)
)
```

`PRIMARY KEY (duel_id, side)` is the one-run-per-side rule. Enforcing it anywhere
else is enforcing it nowhere — the same reasoning as the daily's unique constraint.

## RPCs

All `SECURITY DEFINER`, `SET search_path = public`, matching `social.sql`.

- **`create_duel(p_duration INTEGER) → JSONB`** — generates the sequence, returns
  `{duel_key, expires_at}`. Signed-in callers only.
- **`get_duel_by_key(p_key TEXT, p_guest_token TEXT) → JSONB`** — the duel's public
  face: who is playing, what each side's status is, and the scores **only** once both
  are done. Never the questions. Each side block also carries `points` once scores
  are revealed: the ascending list of seconds at which that side banked a correct
  answer. Times only — never a question index, never a value.
- **`start_duel_run(p_key TEXT, p_guest_token TEXT) → JSONB`** — claims a side,
  stamps `started_at`, returns the questions and `seconds_remaining`. Idempotent:
  calling it again resumes rather than restarting.
- **`submit_duel_run(p_key TEXT, p_guest_token TEXT, p_answers JSONB) → JSONB`** —
  recomputes the score. Same window, grace and malformed-input discipline as
  `submit_daily`.

## Side assignment, which is where the bugs will be

`start_duel_run` decides which side the caller is:

- The creator always takes `creator`.
- Anyone else takes `opponent` if it is unclaimed.
- If `opponent` is already claimed by someone else, refuse — a duel is between two
  people, and a third arrival is a spectator, not a player.
- **The creator opening their own link must not be able to play both sides.** This
  is the obvious exploit and it needs an explicit test, not an assumption.
- A guest returning with the same token resumes their own run rather than being
  treated as a third party. That token is the only identity they have.

## A side with a run has a player

`duels.opponent_id` says who claimed the opponent side. It is not, on its own, the
answer to "is that side taken", because the column is `ON DELETE SET NULL`: when an
opponent deletes their account the id is cleared while the run stays — deliberately,
so the creator keeps their result.

For a while that made a finished duel look unclaimed. A stranger opening the
creator's link was handed the side *and* the deleted player's completed run, and the
creator's result page silently changed who they had played.

So occupancy is asked of `duel_runs`, where the fact lives: `duel_side_played()`. A
side with a run row has a player, past tense or present. The claim in
`start_duel_run` carries that as a predicate on the UPDATE itself rather than as a
check above it, and `get_duel_by_key` reports such a side as taken so the page never
offers a button that would error.

## Expiry

48 hours from creation. An unplayed duel expires and the creator is told plainly;
a duel where only one side played resolves as a walkover, shown as such rather than
as a win.

## The pace graph

The part people will actually screenshot, and nearly free: `js/results.js` already
computes projected score over a run (`banked × duration / elapsed`). The duel version
is that same curve for both players on one chart.

Worth doing beyond two lines: **fill the area between them**, tinted toward whoever
is ahead. Lead changes become visible at a glance, and "I was ahead until 40 seconds
in" is a more interesting thing to post than a final number.

Both runs are on the same question sequence, so the x-axis is directly comparable in
a way two ordinary runs never are.

### Where the opponent's line comes from

A stored per-answer timeline is a partial answer key: an entry saying "correct at
7.4s on question 12" states the answer to question 12. So the server never returns
one, and for a while the opponent's line was their final score held flat.

What it returns instead is `duel_pace_points()`: the **times only**, one per correct
answer, with the question index and the value dropped. That is enough to draw the
curve and reveals nothing about the questions. It is gated on the same reveal flag as
the score, and by the time the flag flips, the duel can no longer be replayed —
`submit_duel_run` rejects a second run per side, and `duel_runs` is keyed
`(duel_id, side)` — so a timeline is no longer a hint to anybody.

De-duplicated per question index, so a question fumbled and then answered correctly
contributes one point at the time it was finally banked, matching the score.

### Steal mode plots a different quantity, from a different table

In a steal duel `duel_runs.answers` is not the record of what happened. Both players
answer the same question and only one of them banks it, so the answers array — the
client's account of what it typed — is not what scored, and a steal client has no
reason to send one at all. `duel_pace_points()` fed from it returns `[]`, and for a
while that is exactly what a finished steal duel returned: two flat "final scores
only" lines, honestly labelled and wrong, because the timeline did exist.

It lives in `duel_points`, one row per question, holding which side won it and the
server-clock instant the first claim for it landed. So steal mode has its own
derivation, `duel_steal_pace_points(duel_id, side)`, returning **exactly** the shape
`duel_pace_points()` does — a JSONB array of seconds to one decimal, ascending, times
only. `js/duel.js` reads both through one code path and cannot tell them apart.

The x-axis is `awarded_at − duel_runs.started_at` for that side, and the choice
matters:

- `duel_points.elapsed_ms` is **per question** — time since that question was
  rendered, not since the run began — so it is not a cumulative axis. Summing it
  would drop the gap between one question being decided and the next appearing, and
  the curve would run steadily ahead of the wall clock.
- `awarded_at` is the server's own observation, not a number the client supplied and
  the server clamped. The axis a score is plotted against deserves the same rule the
  score has.
- It ascends by construction: a claim for question *i+1* is only accepted once *i*
  has a row, so `awarded_at` increases with `question_index` whoever won what.
- It is one instant per question, shared by both sides, so the two lines sit on one
  time base — which is what makes the tinted lead-change fill mean anything.

Each side is measured from its own `started_at`, because each line describes that
player's own run. Both sides of a steal duel start off one shared countdown, so the
two origins are normally the same instant.

#### The y-axis is the actual score, not the projected one

This is the one place the two modes genuinely diverge, and it is a product decision
rather than a consequence of the data.

A classic duel plots **projected** score — `banked × duration ÷ elapsed`. Both players
work through the sequence alone and uncontested, so "at this rate you finish on 84" is
a real prediction, and it is the only thing that makes two runs comparable while they
are still in flight.

A steal duel plots the **actual** score, stepping up at each point won. A projection
here would be arithmetic dressed up as a claim:

- The points are a **shared pool**. Extrapolating one player's rate assumes the other
  stops competing for the rest of the run, which is precisely the thing that cannot
  happen in this mode.
- Two projections can **sum to more points than the sequence contains**, so the chart
  would assert a total that could not exist.
- The running score is the number both players were watching while they played. It
  needs no defending.

Three consequences in `js/duel.js`:

- **The warm-up gates do not apply.** They exist because `banked ÷ elapsed` is wild in
  the first seconds; an actual score is exact from the first point. Withholding the
  early points would draw a line that starts partway up and implies the player was
  there all along.
- **The line starts at `(0, 0)` and is stepped, not smoothed.** A score holds and then
  jumps. Smoothing would draw a player creeping toward a point they took at once.
- **A final score of zero with an empty timeline is measured, not missing.** It is the
  only case where those two can be told apart, so that line is drawn solid rather than
  as the dashed fallback.

The reveal gate is untouched and is the same one the score passes: no times leave the
server until both runs are in. A steal duel reveals its timeline under exactly the
rule a classic one does.

The client still falls back to the flat line when a duel predates this, and says so
in the caption and by drawing that line dashed. A fabricated curve would be a lie in
the one chart people screenshot.

## Deferred: steal mode

Steal mode needs both players connected at once, shared question state, and
arbitration of a contested race across a network. Two things make it a separate
project rather than an extension:

**Fairness is not first-message-wins.** If A answers at 1000 ms and B at 1005 ms but
A's packet takes 80 ms and B's takes 20 ms, the server sees B first. Arbitration has
to run on client-reported time-since-question-rendered, clamped against the server's
own send and receive times — otherwise the game rewards ping rather than speed.

**Advance must be optimistic.** Waiting for arbitration before moving to the next
question puts a visible stall on every question, which in a speed game is fatal. The
answer is to advance locally at once and settle the point a beat later — which means
the score is briefly provisional, and the UI has to be honest about that without
being noisy.

And the steal itself has to be legible. A question changing underneath you mid-
keystroke is disorienting unless the interface explains it in the same instant.
