# Steal mode

The contract for the real-time duel variant. `docs/duels-design.md` sketched why it
was deferred; this is the version that gets built.

**First correct answer takes the point, and both players jump to the next question.**
There is no answering at your own pace: the sequence advances when *somebody* gets it.

## What makes it a different system, not a flag

Classic duels are two independent single-player runs that happen to share a question
list. Nothing is shared while they are being played, which is why nothing about them
is real-time and why they can be played hours apart.

Steal mode shares state *during* the run. That brings in three problems classic
duels do not have, and each one is a section below: arbitration under latency,
advancing without a stall, and what happens when somebody's connection dies.

## Mode flag

`duels.mode TEXT NOT NULL DEFAULT 'classic'`, `CHECK (mode IN ('classic','steal'))`.
Added `IF NOT EXISTS`, defaulted, so every existing row is a classic duel and every
existing function keeps behaving identically. `create_duel` gains a mode argument
with a default, so the old two-argument call still compiles.

**Classic behaviour must not change.** That is the single most important constraint
here: the duel suite that exists today is the regression test for it and must pass
untouched.

## Arbitration is not first-message-wins

If A answers at 1000 ms and B at 1005 ms, but A's packet takes 80 ms and B's takes
20 ms, the server sees B first. Awarding the point to whoever arrives first makes the
game a ping contest.

So the claim carries the client's **time since the question was rendered**, and the
server decides on that — but a number the client supplies is a number the client can
lie about, so it is clamped:

```
elapsed_clamped = LEAST(
  GREATEST(p_elapsed_ms, 0),                       -- no negative times
  server_ms_since(question_became_current)          -- no answering before it appeared
)
```

`question_became_current` is server-known without trusting anybody: it is the
`awarded_at` of the previous question's point, or `duel_runs.started_at` for the
first question. A client claiming 5 ms on a question the server only released 3 ms
ago is clamped to 3 ms, and a client claiming it answered question 12 in 40 ms when
question 11 was decided 20 ms ago cannot fabricate a lead it did not have.

That clamp is the whole security model: a cheat can only ever claim to be as fast as
the physics the server already observed.

### The grace window

The first claim to arrive is written immediately, so the common case has no delay.
For **400 ms** after that write, a claim with a strictly smaller clamped elapsed time
replaces it. After 400 ms the point is settled and late claims are rejected with
`point_taken`.

400 ms is chosen to cover a realistic worst-case round trip while staying under the
threshold where a settled score visibly flickers. It is a named constant in the SQL,
not a literal buried in a condition.

Ties — identical clamped milliseconds — go to `creator`. Arbitrary, but deterministic
and written down, which is what a tie-break has to be.

### `claim_duel_point(p_key, p_guest_token, p_index, p_elapsed_ms) → JSONB`

`SECURITY DEFINER`, `SET search_path = public`, granted to `anon` and
`authenticated` (guests play duels).

- The caller must be a participant of that duel with a run in progress, and the duel
  must be `mode = 'steal'`. Otherwise `not_a_participant` / `wrong_mode`.
- The answer is checked **on the server** against the stored question. A wrong answer
  never awards a point and never advances anybody — it returns `{ok:false,
  error:'wrong'}` and costs the claimer only their own time.
- `p_index` must be the duel's current index (`the highest awarded index + 1`).
  A claim for any other index is `stale_index`, which is also what a client racing
  ahead on an optimistic advance will get.
- Returns `{ok, index, winner, elapsed_ms, provisional}`. `provisional` is true while
  inside the grace window, so the UI can be honest that the point may still move.

Storage:

```sql
CREATE TABLE public.duel_points (
  duel_id        UUID    NOT NULL REFERENCES public.duels(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL,
  winner_side    TEXT    NOT NULL CHECK (winner_side IN ('creator','opponent')),
  elapsed_ms     INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  awarded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at     TIMESTAMPTZ,
  PRIMARY KEY (duel_id, question_index)
);
```

The primary key is the arbitration: an award is one insert that either conflicts or
does not. RLS enabled, **no policies**, grants revoked — reachable only through the
functions, like every other table added since `hardening.sql`.

**The score is never sent by the client.** A side's steal score is
`COUNT(*) FROM duel_points WHERE duel_id = … AND winner_side = …`, computed on the
server at the end, exactly as classic scores are recomputed from stored answers.

## Advancing must be optimistic

Waiting for arbitration before showing the next question puts a visible stall on
every question, which in a speed game is fatal. So:

1. On a correct answer, the client advances **immediately** and fires the claim.
2. It broadcasts `advance` to the other client, which also advances immediately.
3. The award settles a beat later. If arbitration went the other way, the score
   corrects — the *question* never rewinds. Rewinding a question would be far more
   disorienting than a score moving by one.

The UI has to be honest about this without being noisy: a point that is still
provisional is shown in a muted state and firms up, rather than appearing and being
snatched away with an explanation.

### The steal has to be legible

A question changing underneath you mid-keystroke is disorienting unless the interface
says why in the same instant. On a steal against you: the question area flashes the
loser state, the answer field clears, and a line reads *"Stolen — they had it in
1.4s"*. On a steal by you it says *"Stolen"* in the winning colour. It is one line,
in place, not a toast that covers the next question.

## Disconnects

Presence on the channel, with a **10-second grace**. If a player is gone longer, the
duel ends early on the score so far and is marked `ended_early`, with the reason
shown to both sides.

The alternative — awarding the remaining questions to whoever stayed — invites
pulling your ethernet cable when behind, which is the one outcome a competitive mode
must not reward. Ending early is not a win for anybody; it is recorded as what it
was.

## Transport

Supabase Realtime Broadcast on channel `duel:<duel_key>`, with Presence for liveness.
Messages, all tiny:

| Event | Payload | Sent when |
|---|---|---|
| `ready` | `{side}` | a player is in the room and ready |
| `start` | `{at}` | the creator starts the countdown |
| `advance` | `{index, by, ms}` | somebody banked a point |
| `settled` | `{index, winner}` | arbitration finished and disagreed with the optimistic view |
| `bye` | `{side}` | a clean leave, so the other side is not left waiting out the grace |

Broadcast is a hint, never authority: everything a message asserts is re-derived from
`claim_duel_point`'s return value. A forged broadcast can make somebody's screen
advance early; it cannot award a point.

**Check Realtime's free-tier concurrent-connection and message caps before this goes
live.** Two players × a few messages per question is small, but the cap is per
project, not per duel.

## The room

Steal mode needs both players present at once, so there is a room before the game:

- The creator makes a steal duel and gets the same kind of link.
- The link opens a room showing who is present. Both press **Ready**.
- The creator starts; a 3-2-1 countdown runs on both screens off a shared deadline
  timestamp, not off each client's own counter.
- If the opponent never arrives, the room says so plainly and offers to convert the
  duel to classic — the questions are already generated, and a classic duel is a
  perfectly good fallback that does not need anybody to be awake.

That last offer is the answer to "at current traffic, two people online at once may
be a feature nobody can use": the failure mode degrades to the thing that already
works instead of to a dead end.

## What cannot be verified in this repo's sandbox

Local tests can prove arbitration, clamping, the grace window, the tie-break, scoring
and every failure path — all of it is SQL. What they cannot prove is two live clients
over real Supabase Realtime, because outbound access to `supabase.co` is blocked
here. Browser tests therefore stub the channel, and **live two-client verification is
a manual step against the real project.** Say so plainly rather than implying the
suite covers it.
