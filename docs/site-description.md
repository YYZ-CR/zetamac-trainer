# Arithmetic Trainer — full site description

Source material for writing or updating a website description. Everything below is
built and working unless the **Not built** section at the end says otherwise.

---

## What it is, in one paragraph

A mental-arithmetic trainer in the style of [Zetamac](https://arithmetic.zetamac.com):
a timed drill of addition, subtraction, multiplication and division, answered as fast
as you can type. The original's look and feel is reproduced deliberately. What is
added is everything that happens *after* the timer runs out — an explanation of why
your score was what it was, a way to drill the specific thing costing you time, and
people to measure yourself against on questions that were provably the same for
everyone.

## The positioning, if you need an angle

Zetamac gives you a number. This gives you the number and then answers the two
questions that follow it: **why that number, and compared to whom.**

Every question is timed to the millisecond, so a finished run can say where in the
run you sagged, which operation is slow, and which specific questions cost you — with
a worked technique for each. And because a ranking is only meaningful if everyone
answered the same thing, the competitive modes all run on a shared question sequence
rather than on whatever each player happened to be served.

**You do not need an account to play.** An account is what saves your history, puts
you on the boards and gives you a profile.

---

## The game

The core drill, at `/` (the home page is the game).

- Four operations, each independently toggleable: **addition, subtraction,
  multiplication, division**.
- **Configurable number ranges per operation** — both operands, min and max. Defaults
  match Zetamac's (addition 2–100 by 2–100, multiplication 2–12 by 2–100).
- **Four durations**: 60, 120, 180 and 300 seconds. 120 is the default and is the
  length every leaderboard uses.
- The timer anchors to a wall-clock deadline rather than counting ticks, so a
  backgrounded tab does not silently hand you extra time.

## The results page — the analysis

Where the product actually differs. Shown at the end of every run.

- **Four summary cards**: score, accuracy, average time per question, and mistakes.
- **A percentile line** — where that score sits against everyone else at that
  duration. Suppressed entirely when the population is too thin to mean anything,
  rather than reported from a dozen people.
- **A run graph** — projected score over the course of the run. This is the one that
  shows you sagging at the ninety-second mark, or starting slow and never recovering.
- **A per-question breakdown** — a table of every question in the run, in order, with
  the time it took and whether you fumbled it.
- **Worked technique tips**, on their own tab, for the questions that cost you the
  most time and for the operations you are slowest at. Not generic advice —
  each tip substitutes your actual numbers and shows the working:
  `84 ÷ 7` → `70 ÷ 7 = 10`, `14 ÷ 7 = 2`, `= 12`. There are distinct tip strategies
  for each of the four operations, and where there is nothing useful to say, nothing
  is said rather than filler.
- **A share card** rendered client-side to a canvas, in whichever theme you are
  using, plus a copyable link to the run.

## Practice mode

At `/practice.html`.

Weights your **weakest question types highest**, drawn from your own history, so
drilling goes where the time is actually being lost rather than where it is
comfortable. You pick which categories to work on, and the session runs untimed with
a live answered count, streak and running average, ending in a summary. The same tip
engine the results page uses runs here too.

## Zetamac Daily

At `/daily.html`.

**One puzzle a day, the same questions for everyone, one attempt.** The shared
sequence is the whole point: the standing objection to any arithmetic ranking is
"you got easier problems", and this removes it. Scoring is server-authoritative — the
server recomputes the score from the stored questions, so the client's opinion of how
it did is never what counts.

Comes with today's leaderboard and a countdown to the next puzzle.

## Duels

At `/duel.html`, reached by link.

Send someone a link and you both answer **the same question sequence**. Neither
player sees a score until both are done, so nobody is chasing a number. It ends on a
**pace graph of both runs on one chart**, with the area between the two lines tinted
toward whoever was ahead at that instant — so a lead change is a colour change rather
than something to work out. Only the timings are ever shared, never the answers.

- **Guests can play without an account.**
- A duel expires 48 hours after it is created. One where only one side played resolves
  as a walkover and is shown as one, not as a win.

## Steal mode

The same duel link, played **live, both players connected at once**.

The first correct answer takes the point and **both players jump to the next
question**, so every question is a race and a question can vanish out from under you
mid-keystroke — the interface explains it in the same instant.

Arbitration deliberately does not run on whose packet arrived first, which would make
the game a contest of who has the better connection. It runs on time-since-the-
question-appeared, clamped against what the server itself observed.

It ends on a pace graph drawn from the instant each point was actually won — but one
that plots the **actual running score**, where a classic duel's plots the projected
one. Steal points are a shared pool, so projecting one player's rate would assume the
other stops competing, and two such projections can sum to more points than the
sequence contains. The steps on that chart are the lead changes, and they are real.

## Leaderboards

At `/leagues.html`. **No account needed — the boards render signed out.**

Three global boards behind a tab control:

- **Today's Daily** — rank on today's shared puzzle.
- **Today's Best** — the best run per player today.
- **All-Time Best** — the best run per player, ever.

All three are fixed at **120-second runs**, and only runs the **server** scored are
eligible: daily attempts and duel runs. Ordinary solo and practice runs are written
by the client, so the moment they fed a public ranking the top of it would be whoever
first typed a large number. Those runs still drive your own dashboard.

Nobody having played yet reads as an invitation rather than a failure, and no
placeholder row is ever drawn.

## Clans

On the same page, below the global boards.

An invite code, a named group, and **a board over the day's puzzle**. Being 3rd of 6
behind people you know is a better reason to practice than being 4,000th behind
strangers. A clan of six where two have not played yet looks like a clan of six —
the missing players are listed, sharing last place, rather than omitted.

Clans need an account, because one attempt each cannot be enforced against somebody
who can come back as somebody else. Membership is the privacy boundary: an invite
code lets you join, it does not show you who is already in.

## Your dashboard

At `/dashboard.html`.

- **Five tiles**: total games, questions answered, best score, days practiced, current
  day streak.
- The **Best tile is per-duration** and says which (`BEST · 120S`). Scores at
  different run lengths are different measurements, and one figure pooled across them
  would just report your longest run every time.
- A line under the tiles carries the **average of your last 10 games**.
- **Score Over Time** chart with Last 20 / Last 100 / All Time range buttons.
- **Per-operation breakdown** — average time per question, per operation
  (`+ 1.42s · − 1.66s · × 1.98s · ÷ 2.31s`).
- **Recent Games** — a paged table of date, score, duration, accuracy, and a link to
  review any individual run.

## Public profiles

At `/@username`. **Private by default.**

A public profile is now **the dashboard for somebody else to read**: the same five
tiles, the same Score Over Time chart with the same range buttons, the same
per-operation breakdown and the same Recent Games table — plus a percentile.

The one thing a visitor does not get is the **Review** link on individual games, which
would open that run's full question list. The column is removed for visitors rather
than shown as a row of dashes.

A **copy-link icon** sits beside the username on both the dashboard and a profile and
puts the `/@username` link on the clipboard. Copying a link to a profile that is still
private says so in the same breath, rather than quietly handing somebody a link that
tells them the profile does not exist.

## Settings and account

At `/settings.html` — username, profile visibility, theme and account in one place.

**Usernames** are the identity every leaderboard, clan board and duel names you by, so
they are held to it: 3–20 characters of `A-Za-z0-9_-`, no name colliding with an
existing one by case alone, and **one change every 30 days** (the first one you set is
free). The rules live in the database, not the page.

**Deleting an account** sits in a collapsed Danger zone that lists what goes before it
shows you the field. You confirm by typing your own username. Deletion is an ordered
cascade with a stated fate for every row rather than a blunt delete: clans you own are
handed to their longest-standing remaining member, duels you created go with you,
duels you only played in stay and show you as a deleted account, and your username is
released.

## First-run walkthrough

A first visit opens a **seven-step tour**: welcome, then the analysis, practice mode,
the daily, duels, the leaderboards and the profile — because all of that sits *behind*
a run the visitor has not done yet. The welcome step answers the two questions that
come before any feature: playing needs no account, and signing in is what saves your
history.

Each step after the welcome **spotlights the control it describes** — the rest of the
page darkens, the target is outlined, and the panel points at it. It is shown once,
closes five ways, and can be reopened any time from "How this works" in the footer.

## Presentation

- **Two themes**: the original Zetamac light palette, reproduced value for value, and
  a Monkeytype-flavoured dark one. The theme is applied before first paint, so there
  is no flash of the wrong one.
- **Responsive down to phone widths**, including the navigation header.
- **No analytics of any kind.**

## Legal

A **privacy policy** and **terms of service**, written against what the site actually
does rather than from a template: the exact columns stored, every `localStorage` key
and what it is for, the third parties that see a request, the absence of analytics,
and a deletion section that matches the implemented behaviour line for line.

> Both currently carry a `[contact email]` placeholder that must be filled in before
> they are accurate.

---

## Not built

- **A demo video.** The structure and capture pipeline are worked out; nothing has
  been shot.

## Things to be careful not to claim

- There is **no mobile app** — it is a responsive website.
- There is **no paid tier**, no subscription and no payment of any kind.
- Solo and practice runs are **not** eligible for the global leaderboards, by design.
  Only server-scored runs (daily attempts and duels) are.
- Percentiles are **suppressed** on thin populations rather than estimated.
