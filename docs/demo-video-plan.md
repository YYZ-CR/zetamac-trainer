# The launch video — outline, script, storyboard, sound

`docs/demo-video-guide.md` is the *technical* reference: Remotion, the capture
harness, ffmpeg recipes, licensing, the anti-slop checklist. **This file is the plan
for one specific video** — what it says, in what order, on what frame, what it sounds
like, and how each shot gets captured.

Read the guide's §13 (capturing real app footage), §14 (ffmpeg) and §19 (sound) before
shooting. This file does not repeat them; where it overlaps, it is because the
decision is specific to this video.

**This is a redraft.** The first version was written before the site was finished, and
several of its shots described a product that has since changed. Everything that
changed is listed in "What the first draft got wrong", below — read that section even
if you read the first draft, because two of its frames cannot be shot as written.

---

## Evidence quality — read this before treating any number below as fact

Research was **WebSearch-only**. Direct fetching of any external host is denied by this
environment's egress policy at the CONNECT stage — verified directly, not assumed:

```
gateway answered 403 to CONNECT (policy denial or upstream failure)
  www.remotion.dev:443 · en.wikipedia.org:443 · pixabay.com:443
```

Four research agents each independently tested it, including against Wikipedia as a
control, and all four were blocked. So **no platform help page, study PDF, licence
page or video was actually opened and read.** Search snippets are all there is, and a
snippet is a summary of a page written by a search engine, not the page.

One exception, and it is the useful one: **`registry.npmjs.org` is reachable.** The
Remotion API details in this file were read out of the published package's own
TypeScript definitions (`remotion@4.0.501`, `@remotion/media-utils@4.0.501`), not out
of search results. That section is first-hand and current; treat it accordingly.

Labels used throughout:

- **[evidenced]** — a real study or first-party number, reached secondhand but
  consistently attributed across independent sources.
- **[first-hand]** — read directly, in this session. Only the Remotion API section and
  the facts about our own codebase.
- **[convention]** — practitioner sources converging. Useful, unmeasured.
- **[inference]** — mine, from the product. Flagged so you can disagree.

### The strongest finding, and its caveat

**69% of social video is watched with sound off in public places, and viewers are 80%
more likely to finish a video with captions.** Verizon Media / Publicis Media, April
2019, n=5,616 US adults 18–54. [evidenced — the attribution, sample size and month are
consistent across many independent citing sources, including a contemporaneous Forbes
piece.]

Two caveats the first draft flattened:

- **The 69% is specifically public-place viewing. In private it is 25%.** The first
  draft quoted a bare "69% muted", which overstates it. The design conclusion does not
  change — plan for muted — but the number should be quoted correctly.
- **It is seven years old and nothing has replaced it.** No comparable large-sample
  study from the Reels/Shorts era surfaced. Everyone is still citing 2019.

---

## What the first draft got wrong

Five corrections. Two of them would have put something false on screen.

**1. Frame 3c showed a tip the site cannot produce.** The storyboard had:

```
84 ÷ 7  →  70 ÷ 7 = 10,  14 ÷ 7 = 2,  = 12
```

`getTip()` in `js/tips.js` does not decompose that way. The real output, verified by
running it:

```
84 ÷ 7  →  Recall ×7 = ×10−×3: 12×10 − 12×3 = 120 − 36 = 84
```

That is 46 characters and reads badly at 9:16. A real tip that fits the ≤40-character
rule and lands instantly:

```
96 ÷ 8  →  Halve three times: 96 → 48 → 24 → 12
```

This matters more than a typo would: shot 3c is the single frame the whole
differentiator beat rests on, and the first draft's own rule was "nothing that is not
true". **Use `getTip()` output verbatim. Never hand-write a tip.**

**2. Beat 4 asked for something that is already on screen.** The draft said to seed the
RNG until the adaptive weighting "looks" visible. Unnecessary — `js/practice.js:380`
renders each category's relative draw weight as **1–4 dots**. The weighting is a UI
element, not something to infer from a sample of draws. Shoot the dots.

**3. Beat 7 was written for a product that no longer exists in that form.** "Private
leagues" is now **Leaderboards**, holding three global boards *and* clans. More
importantly, **ordinary solo runs now rank** on Today's Best and All-Time Best. The
first draft's leagues beat argued "being 3rd of 6 beats being 4,000th"; the product now
offers both, and the global board is the stronger shot because it does not require the
viewer to already have friends.

**4. The 60-second length was justified by a constraint that has expired.** The draft
set 60s so the vertical cut would land as a Short, citing an unverified 60s ceiling.
**YouTube Shorts has allowed 3 minutes since October 2024** [evidenced — reported
consistently as a discrete policy change, not merely repeated in spec sheets]. X's free
tier at **140s** is confirmed. So 60s is no longer forced. It is kept anyway, as a
judgement about attention rather than a platform limit — but the reasoning in the file
should not claim otherwise.

**5. Steal mode was speculative and is now real.** It ships with a two-sided ready
gate, a shared 3-2-1 countdown anchored to a common deadline, and a scoreline carrying
both usernames. It is the most videogenic thing in the product and the draft gave it
two seconds. It now gets four, and its own deliverable.

---

## What this video has to do

**One job: get somebody to open the site and play one run.** Not sign up, not
subscribe — there is nothing to sell. Every second not moving somebody toward "I'll try
that" is a second to cut.

**Who it is for.** Quant-interview candidates are the loud part of the audience, but
Zetamac's referral traffic reportedly has ChatGPT in its top five referrers alongside a
secondary school's domain [evidenced, secondhand]: a real slice is students sent a link
by a teacher, and another arrives by asking an LLM for a trainer. Both groups already
know what the drill is. Neither needs the concept explained. They need one sentence
about what is different.

**The pitch, in one line:** *the arithmetic drill you already use, except it tells you
why your score is what it is, and gives you people to play against.*

### The spine — three questions, in order

The first draft ran eight parallel beats and worried, correctly, that seven features at
eight seconds each is a tour. The product has since grown a natural spine, and the
redraft uses it:

| Act | The question | Beats |
|---|---|---|
| **Why** | Why is my score what it is? | the run, the number, the analysis |
| **Fix** | What do I do about it? | practice mode |
| **Compete** | Who else got a number today? | daily, duel, steal, the boards |

Three acts, not eight beats. It matters because it gives beats 5–8 a **shared payoff**
— the boards — instead of three consecutive "and there is more" segments. The old
montage of leagues + profile + share card is **cut entirely**: the global board does
that job now, and a profile page is a reason to come back, not a reason to arrive.

### An uncomfortable finding, restated because a second pass confirmed it

**No product in this genre appears to have a brand-made launch video.** A second,
independent search pass specifically tried to falsify this against Monkeytype,
TypeRacer, Kahoot, chess.com and Skribbl, and found the same null result every time.
It is a search-based null result rather than proof of absence — but with the added
observation that TypeRacer (2008) and Monkeytype (grassroots) predate or sit outside
the "launch trailer" genre entirely, so for them a trailer would have been a
non-sequitur rather than something tried and rejected.

Meanwhile the distribution data is reasonably solid and unflattering to trailers: a
front-page Show HN drives ~5,000–30,000 uniques and needs ~30–50 upvotes in the first
hour; Product Hunt is top-3-or-bust; r/SideProject and r/InternetIsBeautiful are the
two subreddits that tolerate this at all. **No credible independent data isolates a
launch video's marginal contribution to any of them** — every ROI figure found traced
back to a company selling demo-video tooling.

So: **build the video as the asset that makes those posts convert once somebody clicks,
not as the growth mechanism.** Which changes what the most valuable deliverable is —
see below.

### What not to do

- **No logo card, no title card, no "introducing".** Open on the product being used.
  [convention — near-unanimous in the advice literature, though a second pass could not
  find empirical confirmation that it is actually dominant in the wild, only that it is
  universally advised. No counterexample surfaced either.]
- **No feature list read aloud.**
- **No fake cursor, no even typing cadence, no auto-zoom.** These are not guesses about
  what looks fake — they are the exact three features that AI demo-video generators
  (FocuSee, CursorKit, Demosmith) advertise as selling points: bezier cursor smoothing,
  "natural" typing cadence with pauses removed, automatic zoom onto UI elements.
  Anything a generator sells as a benefit is a tell. Record real input with real
  hesitation.
- **No swoosh on every cut.** One whoosh, used once. See the sound plan.
- **Nothing that is not true.** No staged leaderboard, no hand-written tip, no
  percentile the site cannot compute.

---

## Deliverables

| Cut | Length | Ratio | For |
|---|---|---|---|
| **The steal loop** | 3s, silent, looping | 1:1 and 9:16 | The thing that actually travels |
| **Master** | 60s | 16:9 1920×1080 | YouTube, the site, the source of truth |
| **Vertical** | 60s | 9:16 1080×1920 | Shorts, Reels |
| **Short cut** | 28s | 16:9 + 9:16 | X, Reddit |

**The steal loop is listed first deliberately.** If the video is not the growth
mechanism and being picked up by somebody with an audience is, then the highest-value
artefact is the one a stranger can post without explaining: **three seconds of two
screens jumping to the next question off one person's keystroke.** It needs no
captions, no sound, no context, and it is the only thing in the product that is
legible as a loop. Make it first, and make it well — if the 60s master never gets
finished, this one still has value.

**Captions are burned in, not uploaded.** Burn-in is the clear recommendation for
short-form specifically, because those apps render their own UI and platform caption
tracks are opt-in — a muted-by-default viewer may never enable them. [convention,
consistent] It also survives being downloaded and re-shared, which is how a video like
this actually travels.

**Voiceover: skip it.** [inference] Most viewing is muted; the comparative data on
VO-vs-text does not exist in any reachable source, and every pro-VO claim traced back
to a company selling voiceover tools. A tight cut with keystroke sound and burned text
is also the version one person can actually finish.

---

## The grid — why every timing in this file is a multiple of 15

The video is **30fps, 60 seconds, 1800 frames, cut to a 120 BPM track.**

At 30fps, `frames per beat = (30 / BPM) × 60`. Cuts land cleanly on a beat only when
that is a whole number, and drift accumulates when it is not — a worked example in the
research: 128 BPM at 24fps is 11.25 frames/beat, drifting ~16 frames over 64 beats.
[convention, and the arithmetic is checkable]

At 30fps:

| BPM | Frames/beat | Clean? |
|---|---|---|
| 100 | 18 | yes |
| **120** | **15** | **yes** |
| 125 | 14.4 | no |
| 128 | 14.06 | no |
| 150 | 12 | yes |

**120 BPM is chosen**: 15 frames per beat, **60 frames — exactly 2 seconds — per bar**,
and 60 seconds is exactly 30 bars. Every act boundary in this file falls on a bar line,
every cut on a frame divisible by 15. That is not neatness for its own sake; it is what
lets the edit be described in frames in a document and reproduced exactly in Remotion.

Most "energetic tech" stock tempos (125, 128, 130) do **not** divide evenly at 30fps.
If the track you like is one of those, either time-stretch it to 120 or abandon the
beat grid and cut by ear — do not do both.

---

## The beat sheet

30 bars. `f` = frame at 30fps.

| Act | Bars | Frames | Time | Beat |
|---|---|---|---|---|
| **Why** | 1–2 | 0–119 | 0:00–0:04 | The drill, in progress |
| | 3–4 | 120–239 | 0:04–0:08 | The bare number, and the objection |
| | 5–6 | 240–359 | 0:08–0:12 | The pace graph |
| | 7–8 | 360–479 | 0:12–0:16 | The breakdown |
| | 9–10 | 480–599 | 0:16–0:20 | The tip |
| **Fix** | 11–13 | 600–779 | 0:20–0:26 | Practice mode |
| **Compete** | 14–17 | 780–1019 | 0:26–0:34 | Zetamac Daily |
| | 18–21 | 1020–1259 | 0:34–0:42 | The duel |
| | 22–23 | 1260–1379 | 0:42–0:46 | The reveal — two curves |
| | 24–25 | 1380–1499 | 0:46–0:50 | **Steal mode** |
| | 26–27 | 1500–1619 | 0:50–0:54 | The board |
| **CTA** | 28–30 | 1620–1799 | 0:54–1:00 | The URL |

**The analysis gets 12 seconds and the CTA gets 6.** That ratio is the whole editorial
decision, unchanged from the first draft and still right: analysis is the only beat
that answers "why this instead of the thing I already use". If the cut runs long, take
it out of Compete — never out of Why.

---

## The script, with sound

Format per shot: visual · on-screen text · sound · capture. On-screen text is written
exactly as it should appear, every line ≤40 characters so it survives the 9:16 reframe.

---

### Bars 1–2 · f0–119 · 0:00–0:04 — cold open

**Visual.** Full-bleed game screen, dark theme, no browser chrome. A question sits
mid-screen; the answer field fills, the question flips, three times. Timer visible,
running at real speed. No pointer on screen at all — this is typing.

**Text.** *None.* The first four seconds are the product working.

**Sound.** Real recorded keystrokes and nothing else. **No music yet.** The rhythm is
the point: fast, uneven, one hesitation.

**Capture.** Live, headed browser, real typing. Do not script it — scripted input has
an even cadence, which is one of the three named tells. Shoot ten takes, keep the one
with the natural stumble.

---

### Bars 3–4 · f120–239 · 0:04–0:08 — the number

**Visual.** The run ends. The score lands large. Hold completely still. Nothing
animates.

```
f135   Zetamac gives you this number.
f180   It doesn't tell you why.
```

Second line replaces the first — never both on screen at once.

**Sound — the most deliberate 4 seconds in the video.**

| Frame | Time | Event |
|---|---|---|
| f120 | 0:04.0 | Typing stops dead. **Total silence.** |
| f135 | 0:04.5 | Score lands. One soft low impact, and nothing else. |
| f180 | 0:06.0 | **Music enters here**, on the bar-4 downbeat, under the objection line. |

Half a second of true silence before the score is the single cheapest effect in the
edit. Silence works because the absence is noticed more than the presence [convention,
consistently described] — and it is free.

**Music entering on the objection, not on the score, is the point.** The music arriving
*is* the pivot from "here is the thing you know" to "here is the thing you don't".

**Capture.** Same take as bars 1–2, continuous. The hold is an edit decision, not a
pause in the recording.

> The pivot works because it is *fair to Zetamac*. Not "Zetamac is bad" — "here is the
> next question". That tone is what survives being posted where Zetamac's own users
> read.

---

### Bars 5–10 · f240–599 · 0:08–0:20 — the analysis

The longest passage. Three moves, one idea each, one bar-pair apiece.

**5–6 · f240–359 — the pace graph.** Cut to the results page. The projected-score curve
draws left to right with a visible sag in the middle.

```
Every question is timed.
```

**7–8 · f360–479 — the breakdown.** Scroll to the per-question list. The slowest row
highlights. Cursor moves — real, slightly imprecise.

```
So it can show you where you lost it.
```

**9–10 · f480–599 — the tip.** Zoom to one question and its technique line, held long
enough to actually read:

```
96 ÷ 8                            2.9s
Halve three times: 96 → 48 → 24 → 12
```

```
And how to get it back.
```

**Sound.** Music bed only, held steady and low so the captions and the small UI text
are not competing for attention. Two or three soft ascending ticks as the graph draws
(f240–280), then nothing. **No sound on the zoom.**

**Capture.** Harness, seeded RNG, against a run engineered to contain a specific sag
and a specific slow division. You will re-shoot this more than anything else, so
determinism matters most here. **Take the tip text from `getTip()`, not from this
document** — if the seeded run produces a different question, use its real tip and
change the storyboard, not the other way round.

---

### Bars 11–13 · f600–779 · 0:20–0:26 — practice

**Visual.** Practice page, with the **weight dots visible in frame** — the 1–4 dot
indicator per category. Then three or four questions, fast, division recurring.

```
f610   Practice weights your worst types heavier.
f700   So you drill where the time goes.
```

**Sound.** Keystroke bed returns, quieter than the cold open, sitting under the music
rather than over it.

**Capture.** Harness. The dots make this shot honest without seeding for appearance:
the weighting is stated by the UI, and the draws then demonstrate it. Frame so both are
visible at once.

---

### Bars 14–17 · f780–1019 · 0:26–0:34 — Zetamac Daily

**Visual.** The daily page. One puzzle, one attempt, then the board.

```
f790   One puzzle a day.
f870   The same questions for everyone.
f950   So nobody got easier problems.
```

**Sound.** Music lifts here — this is the start of the Compete act, and the only place
in the video where the energy steps up. A small filter opening or a layer entering, on
the f780 bar line.

**Capture.** Live, against the real project, on a real day. **Do not stage a
leaderboard.** A thin honest board is fine; an empty one is not; a fabricated one is
the single thing that would make this video dishonest, and it is the first thing a
viewer will check.

---

### Bars 18–21 · f1020–1259 · 0:34–0:42 — the duel

**18–19 · f1020–1139 — the link.** Split screen, and this is one of only two places it
is used. Left: create a duel, copy the link. Right: the link opens, a name appears.

```
Send a link.
```

**20–21 · f1140–1259 — playing.** Drop the split. **One pane, full width**, the
viewer's own run, speed-ramped ~8× **with the timer cropped out of frame.** A visibly
sped-up countdown is the most obvious way to make a demo look fake. [inference, flagged
— no source addresses it, and it is the most likely thing to give this specific video
away.] The other player is established by the caption; the proof they were real arrives
two seconds later in the graph.

```
Same questions. Neither of you sees a
score until you're both done.
```

**Sound.** Under the speed ramp, do **not** speed up the keystroke audio — a pitched-up
typing bed sounds exactly like what it is. Drop the keystrokes and let the music carry
it. (In Remotion, `playbackRate` on `<OffthreadVideo>` affects the clip's own audio;
mute the clip and lay a separate real-time keystroke bed under it.)

---

### Bars 22–23 · f1260–1379 · 0:42–0:46 — the reveal

**Visual.** Both scores appear at once. Then the pace graph draws with **two real curves
that cross.**

```
Then the graph shows who was ahead,
and when.
```

This is the shared-lane shot — one frame, both players, no split, legible at any size.
It is this product's version of the pattern that works for competitive web products,
and the alternative (a 50/50 split) halves text that is already small at 9:16.

The evidence for shared-lane-over-split is weaker than the first draft implied: a
targeted second pass could not find documented trailer treatments for TypeRacer,
Kahoot, chess.com or Skribbl, and the closest real practitioner discussion was
speedrunning stream layouts, where the convention is a dominant primary feed at ~70–80%
of frame rather than a true 50/50. [search-level, adjacent] The conclusion survives —
it is also just what our own product looks like — but it rests on the product, not on
the research.

**Sound.** Music at its fullest. One soft impact as the two scores land together.

---

### Bars 24–25 · f1380–1499 · 0:46–0:50 — steal mode

Four seconds, and the best four seconds in the video.

**Visual.** Split screen — the second and last time. Same question on both sides. One
side types; **both screens advance to the next question at once.** Then it happens
again, the other way.

```
Or play it live: first answer takes
the point.
```

**Sound — the second silence.**

| Frame | Time | Event |
|---|---|---|
| f1380 | 0:46.0 | **Music cuts to silence.** Hard, on the bar line. |
| f1395 | 0:46.5 | One keystroke. |
| f1397 | 0:46.6 | Both screens advance. **A single distinct tick** — different timbre from the player's own answer tick, so the asymmetry is audible. |
| f1440 | 0:48.0 | Music returns, and the second steal plays over it. |

The steal is the one moment in the product where something happens *to* you because of
somebody else. Giving it its own timbre means a muted viewer sees it and an unmuted
viewer feels it, and neither needs the caption.

**Capture.** Two browser contexts captured in one frame — not two recordings
composited, which will drift and look it. Steal mode needs a real Realtime connection,
so this must be shot against the deployed project. Shoot the ready gate and the shared
3-2-1 countdown too, even if they do not make the cut: they are what makes the loop
readable as a live game rather than an edit.

> **This is the deliverable, not just a shot.** Cut these four seconds down to three,
> strip the caption and the sound, loop it, export at 1:1 and 9:16. That is the file
> you attach to a post.

---

### Bars 26–27 · f1500–1619 · 0:50–0:54 — the board

**Visual.** The Leaderboards page, landing on **All-Time Best** — which is now the
first tab and the default. A real board, real names, real scores.

```
Every run you play ranks here.
```

**Sound.** Music resolving. One soft ping as the board renders.

**Capture.** Live. Same rule as the daily: real board or no board.

> **Watch the claim.** Ordinary solo runs *do* rank on All-Time Best and Today's Best —
> but only for an account with a username, and only at 120 seconds on the default
> settings. "Every run you play ranks here" is therefore **not quite true** and needs
> either an account visible in frame or a narrower line: `Your 120-second runs rank
> here.` Pick one before shooting; do not let the edit decide.

---

### Bars 28–30 · f1620–1799 · 0:54–1:00 — the URL

**Visual.** Back to the config screen — the frame the video opened on, closing the
loop. Cursor rests on Start. The URL card holds, centred, still.

```
f1630   [your-domain]
f1690   Free. No sign-up to play.
```

**Sound.** Music thins to a single sustained element for the last two bars, then stops
on f1799. One keystroke at f1620 and nothing after it.

**Hold the URL a minimum of 3 seconds** — people type it while it is on screen.
[convention]

**On the second line.** "Free. No account needed to start" is true: `sessions_insert`
permits `user_id IS NULL`, so an anonymous run plays and saves. But an anonymous run
does **not** rank — the boards join `profiles` and require a username. Both facts are
true of different runs, and the CTA must not blur them. `Free. No sign-up to play.` is
the honest short form. If you want the board in the CTA, it needs two lines and a bar
more time.

---

## Storyboard

Nine frames. 16:9 shown; the 9:16 note says what changes.

```
┌─ f0 ─ 0:00 ─────────────────────────┐   ┌─ f135 ─ 0:04.5 ─────────────────────┐
│                                     │   │                                     │
│              47 × 6                 │   │               47                    │
│            ┌─────────┐              │   │                                     │
│            │  28▌    │              │   │   Zetamac gives you this number.    │
│            └─────────┘              │   │                                     │
│              0:47                   │   │   ♪ silence — music enters f180     │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
  9:16: identical, already centred          9:16: identical

┌─ f240 ─ 0:08 ───────────────────────┐   ┌─ f480 ─ 0:16 ───────────────────────┐
│  RUN GRAPH                          │   │                                     │
│  60┤      ╭──╮      ╭────           │   │   96 ÷ 8          2.9s  ← slowest   │
│  50┤   ╭──╯  ╰──╮ ╭─╯               │   │   ───────────────────────────────   │
│  40┤ ╭─╯        ╰─╯                 │   │   Halve three times:                │
│    └─────────────────────           │   │   96 → 48 → 24 → 12                 │
│    Every question is timed.         │   │   And how to get it back.           │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
  9:16: crop to the curve, drop the axis    9:16: this frame is why text is ≤40ch
                                            TIP MUST COME FROM getTip()

┌─ f600 ─ 0:20 ───────────────────────┐   ┌─ f780 ─ 0:26 ───────────────────────┐
│  WEAKEST TYPES                      │   │  ZETAMAC DAILY · #4                 │
│  division · 2-digit    ●●●●         │   │  ─────────────────────────          │
│  multiplication · ×7   ●●●○         │   │  1  yangyang        52              │
│  subtraction · borrow  ●●○○         │   │  2  ...             49              │
│  addition · bridge     ●○○○         │   │  3  ...             44              │
│  Practice weights your worst higher.│   │  The same questions for everyone.   │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
  The dots ARE the feature. Frame them.     Real board on a real day, or no board.
  9:16: four rows fit; keep all four        9:16: top 3 rows only, larger

┌─ f1260 ─ 0:42 ──────────────────────┐   ┌─ f1380 ─ 0:46 ──────────────────────┐
│      50        ·        29          │   │  ┌────────────┬────────────┐        │
│  ╭────────────────────────╮         │   │  │  63 − 28   │  63 − 28   │        │
│  │      ╱‾‾╲    ╱─────    │ you     │   │  │    35▌     │            │ ← types│
│  │  ╱──╯    ╲──╯          │ them    │   │  │            │            │        │
│  ╰────────────────────────╯         │   │  │  ↓ BOTH ADVANCE ↓       │        │
│  Who was ahead, and when.           │   │  ♪ SILENCE f1380 · tick f1397       │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
  The shared lane. One frame, both          The loop deliverable lives here.
  players, no split.                        Split screen earns its place: both
  9:16: crop to the crossing point          screens moving off one keystroke IS
                                            the idea. 9:16: stacked, arrow between

┌─ f1620 ─ 0:54 ──────────────────────┐
│                                     │
│         [your-domain]               │
│                                     │
│      Free. No sign-up to play.      │
│                                     │
└─────────────────────────────────────┘
  9:16: identical, centred, hold 3s+
```

---

## The music plan

**Spec.** Instrumental, no vocals, **120 BPM**, minimal/synth-led, mid-energy, and —
this is the one non-negotiable — **it must have an audible dynamic change**, not be a
flat loop. The edit needs something to lift into at f780 and something to drop out of
at f1380. A loop with no shape gives you nothing to cut against.

**Structure, on the grid:**

| Frames | Bars | What the music does |
|---|---|---|
| 0–179 | 1–3 | **Nothing.** Keystrokes only. |
| 180–779 | 4–13 | Enters sparse on the bar-4 downbeat. Held low and steady under the analysis, so it never competes with small UI text. |
| 780–1379 | 14–23 | Lifts at the Compete boundary. One step up, not a ramp. |
| **1380–1439** | **24** | **Hard cut to silence.** The steal. |
| 1440–1619 | 25–27 | Returns, resolving. |
| 1620–1799 | 28–30 | Thins to one sustained element so the URL reads. Stops on f1799. |

Two energy changes and one silence in sixty seconds. That is fewer than a stock edit
would use, and deliberately so: the recurring "amateur" tell in the research is not a
bad track, it is a track with **no dynamics at all** — the same energy start to finish,
so the piece feels sonically flat even while busy. [convention]

**Do not cut on every beat.** Reserve hard cuts for bar lines (every 60 frames) and
major mode changes; let the fast on-screen number changes ride under a held phrase.
Cutting on all 120 beats reads as frantic. [convention]

**Licensing.** For a free product with no budget:

| Source | Attribution | Commercial | The catch |
|---|---|---|---|
| **Pixabay** | none | yes | Some contributors register tracks with Content ID anyway. Pixabay publishes a dispute process with a downloadable licence certificate — the existence of that process implies it happens often enough to need one. |
| **YouTube Audio Library** | mostly none; a CC-BY subset needs credit | yes if monetization-eligible | Google's own claim that these will not be Content-ID claimed, about its own library. Fine for YouTube; less clear cross-platform. |
| **Uppbeat** free | **yes — a per-download code, per video** | yes | Reusing a track on a second video needs a second download and a second code. Free tier safelists one channel. |
| **Epidemic / Artlist** | none | yes | ~$10–15/mo personal. Artlist's coverage is plan-tiered, not universal. |
| **Free Music Archive** | varies | **often no** | Many tracks are **CC BY-NC**, which forbids monetized channels, sponsored content and promotional use. Promoting a free product still counts. **Check the specific track's licence, every time.** |

**Recommendation:** Pixabay first, YouTube Audio Library as backup, and budget half an
hour for a possible Content-ID dispute. If you would rather have zero claim risk, one
month of Uppbeat paid (~$8) buys it outright. **Avoid FMA** unless you personally read
the individual track's licence — "free on FMA" is not a safe blanket signal.

All figures above are [search-snippet]. Verify the licence text on the page before
committing, since none of those pages could be opened here.

---

## The sound-effect plan

Sound is the highest-ROI part of this pipeline and the part most likely to be skipped:
it is commonly cited as ~50% of a film's effect while receiving ~10% of budget
(guide §19). For a screen-recorded demo it is also the only thing that can make a
silent UI feel physical.

### The palette — six sounds, and no more

The tell of an amateur mix is *sameness*: every click identical, every transition the
same whoosh, a sound on every event, no dynamic range. [convention] The defence is a
small vocabulary reused consistently.

| # | Sound | Where | Doing what |
|---|---|---|---|
| 1 | **Keystroke bed** — real, recorded, mechanical | f0–119 (hero), f600–779 (under music) | Establishes that this is typed speed. The only sound in the cold open. |
| 2 | **Low impact**, soft, sub-heavy | f135 (score lands), f1260 (both scores) | Weight on the two moments a number arrives. |
| 3 | **Ascending tick**, <200ms | f240–280 (graph draws) | Sonifies data appearing. Two or three, then stop. |
| 4 | **Your tick** — small, neutral | steal, your answers | The player's own point. |
| 5 | **Their tick** — harder edge, different timbre | f1397 and the second steal | Somebody else took the point. **Must be aurally distinguishable from #4** — that asymmetry is the whole mechanic. |
| 6 | **One whoosh**, <0.5s | f240 only, into the results page | The single genuine context change in the video. Used once. |

Plus one soft ping at f1500 (the board renders) and one keystroke at f1620 (the CTA).
**That is the entire sound design.** No sound on the zoom, no sound on the scroll, no
transition sound on any other cut.

### Recording the keystrokes

Real recorded typing beats sampled, and it is worth the twenty minutes. [convention]
Cardioid mic 6–12 inches from the keyboard, **not resting on the same desk** — the
surface transmits every strike; use a boom or an isolated stand. Quiet room, pop filter,
clean keyboard. In post, sample a silent noise profile and apply reduction *lightly* —
the goal is real typing, not a sweetened version.

Mechanical clicky switches read as "fast, decisive, satisfying", which fits a speed
trainer; membrane is softer and will disappear under music. If the keyboard used on
camera is not the one recorded, nobody will know, but the cadence must match the
footage frame for frame.

### Is adding sound to a silent UI dishonest?

The app does not make these noises. Adding them is standard and is not the tell — SFX
packs are explicitly sold for app demos. The line worth holding [inference, from thin
evidence]: **sonify real events, never invent capability.** A tick when the score
actually increments is representing something true. A notification chime for an alert
the product never sends is a lie. Everything in the table above corresponds to a real
state change visible in the same frame.

### Mix

| Target | Value |
|---|---|
| Integrated loudness | **≈ −14 LUFS** (YouTube/Instagram normalisation point) |
| True peak | **−1 dBTP** minimum headroom, to survive platform re-encode |
| Keystroke bed under music | ≈ −20 to −25 dB relative |
| The two impacts | may peak ≈ −8 dB, briefly |
| Ducking | Music ducks ~3–4 dB under the impacts and the steal tick |

With no voiceover, the usual voice/music/SFX hierarchy collapses to **music vs SFX**,
and the rule becomes: the six sounds are the foreground, the music is the room.

Reported figures vary by platform (TikTok in-feed is reported as *not* loudness-
normalised, so a hotter export genuinely plays louder there). All [search-snippet] —
verify against the platform's own spec page before mastering a second version.

---

## Remotion implementation

**[first-hand]** — read from `remotion@4.0.501` and `@remotion/media-utils@4.0.501`
type definitions, pulled from the npm registry in this session. Not from search
results, which for this API are actively misleading (see the deprecation below).

### Where it lives

Remotion is a **dev-only toolchain and must not touch the site's root `package.json`.**
`CLAUDE.md` is explicit that there is no build step and that npm exists for test
tooling only; adding a React video framework to the root would blur the one invariant
the architecture rests on. Put it in **`video/`** with its own `package.json`,
`node_modules` and lockfile. Nothing in it is deployed.

### The deprecation search results will get wrong

```tsx
// WRONG — deprecated in the installed version
<Audio src={staticFile('music.mp3')} startFrom={90} endAt={1800} />

// RIGHT — 4.0.501
<Audio src={staticFile('music.mp3')} trimBefore={90} trimAfter={1800} />
```

From `audio/props.d.ts`: *"`startFrom` was renamed to `trimBefore`"*, *"`endAt` was
renamed to `trimAfter`"*. The same rename applies to `<Video>` and `<OffthreadVideo>`
(`video/props.d.ts`). The old names still work but are deprecated, and most tutorial
content predates the change.

### Volume is a function of frame — no helper needed

```ts
export type VolumeProp = number | ((frame: number) => number);
```

That single line is the whole ducking story. Music fades and ducks are `interpolate`
calls inside the `volume` prop:

```tsx
const MUSIC_IN = 180;      // bar 4  — music enters
const LIFT     = 780;      // bar 14 — Compete
const CUT      = 1380;     // bar 24 — the steal silence
const BACK     = 1440;     // bar 25
const TAIL     = 1680;     // bar 29 — thin out

<Audio
  src={staticFile('bed-120bpm.mp3')}
  volume={(f) =>
    f < MUSIC_IN ? 0                                   // cold open: nothing
    : f < LIFT   ? interpolate(f, [MUSIC_IN, MUSIC_IN + 30], [0, 0.45],
                     { extrapolateRight: 'clamp' })    // 1-second fade in
    : f < CUT    ? 0.62                                // the lift
    : f < BACK   ? 0                                   // hard silence for the steal
    : f < TAIL   ? 0.62
    : interpolate(f, [TAIL, 1799], [0.62, 0], { extrapolateRight: 'clamp' })
  }
/>
```

Frame-accurate SFX are a table and a `<Sequence>` each — the timeline in this document
becomes a literal constant:

```tsx
const SFX = [
  { at: 135,  src: 'impact-soft.wav',  gain: 0.9 },   // the score lands
  { at: 240,  src: 'whoosh.wav',       gain: 0.5 },   // into the results page
  { at: 1260, src: 'impact-soft.wav',  gain: 0.9 },   // both scores
  { at: 1397, src: 'tick-them.wav',    gain: 1.0 },   // THE STEAL
  { at: 1500, src: 'ping-soft.wav',    gain: 0.5 },   // the board
] as const;

{SFX.map(({ at, src, gain }) => (
  <Sequence key={`${src}-${at}`} from={at} premountFor={30}>
    <Audio src={staticFile(`sfx/${src}`)} volume={gain} />
  </Sequence>
))}
```

`premountFor` is on `SequencePropsWithoutDuration` and mounts the child early so the
asset is loaded before its first frame — worth setting on any sound that has to land on
an exact frame.

### Screen recordings

Use **`<OffthreadVideo>`** for captured footage. For the f1140–1259 speed ramp,
`playbackRate` drives the clip *and its audio* — so mute it and lay the real-time
keystroke bed underneath, or the typing pitches up and gives the ramp away:

```tsx
<OffthreadVideo
  src={staticFile('capture/duel-run.mp4')}
  trimBefore={0}
  playbackRate={8}
  muted            // the clip's own audio would pitch up with the ramp
/>
```

### Beat-syncing from the track itself

`@remotion/media-utils` exports `useAudioData`, `useWindowedAudioData`, `visualizeAudio`
and `visualizeAudioWaveform`. Signatures, verbatim:

```ts
useAudioData(src: string, options?: {sampleRate?: number; requestInit?: RequestInit})
  => MediaUtilsAudioData | null

visualizeAudio({audioData, frame, fps, numberOfSamples,
                optimizeFor?, dataOffsetInSeconds?, smoothing?}) => number[]
```

Useful if you want something on screen to move with the music. **Probably don't.** An
amplitude-driven overlay on a UI demo is decoration with no informational content, and
this video's whole argument is that its screen time is evidence. The grid above already
gives you beat sync without touching the audio data.

### Render

Chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` in this
environment; Remotion accepts a browser executable path rather than downloading its
own. Encode H.264/AAC, ~3,500–5,000 kbps. Every platform re-encodes — the goal is to
hand it something clean, not maximal.

**Look at the rendered frames.** Extract stills and open them. A stubbed dependency
rendering a blank panel while reporting success has happened twice in this project.

---

## Capture plan

Expanded in `docs/demo-video-guide.md` §13. Decisions specific to this video:

| Shot | How | Why |
|---|---|---|
| f0–239 | **Live, headed, real typing** | Scripted input has an even cadence — a named tell |
| f240–779 | **Harness, seeded RNG** | You need a specific curve, a specific slow question, specific weight dots |
| f780–1019 | **Live, real day, real board** | A staged leaderboard is the one lie a viewer will catch |
| f1020–1139, f1380–1499 | **Two real browser contexts in one frame** | Compositing drifts; steal mode needs a real Realtime connection |
| f1140–1379 | **One pane, full width** | Split screen only where two windows are the point |
| f1500–1619 | **Live** | Same rule as the daily |

**Resolution.** `deviceScaleFactor: 2` **and** `--force-device-scale-factor=2` — both,
or you get grey padding. That trap has already cost this project time.

**Legibility.** Enlarge browser UI *before* recording rather than zooming in post. Zoom
only to direct attention to a specific element, never to "feel dynamic".

**The timer problem.** Never speed-ramp a shot with the countdown in frame.

**Determinism.** Seed the RNG and fix the date for every harness shot, so a re-shoot of
the tip frame produces the same question.

---

## Distribution

- **The steal loop** — the artefact you attach to anything. No captions, no sound.
- **X** — the 28s cut. Free tier allows 140s, so length is not the constraint;
  attention is.
- **Reddit** — r/SideProject (weekly share threads) and r/InternetIsBeautiful (genuine
  novelty bar). Most other subs ban self-promotion outright. The 9:1 norm — nine
  non-promotional contributions per promotional post — is a practitioner rule of thumb,
  not policy, and is enforced socially.
- **Hacker News** — the video is not the post. A Show HN is text and a link. Front page
  is worth ~5,000–30,000 uniques but needs ~30–50 upvotes in the first hour; median
  post scores 2 points. Do not ask your network to upvote — that risks a shadowban.
- **Product Hunt** — top-3-or-bust: top 3 is ~5,000–15,000 visitors, outside top 10 is
  under 500.
- **YouTube** — vertical 60s as a Short (3-minute ceiling, so no reframing pressure),
  16:9 master as the canonical embed.

Post copy says what the video says: *the arithmetic drill you already use, except it
tells you why.* Do not open with "I built".

---

## What is not settled

- **The board claim in the CTA.** "Every run you play ranks here" is not true for an
  anonymous run or a custom config. Decide the exact line before shooting bar 26.
- **Whether to show a board at all** while player counts are low. An honest thin board
  is fine; an empty one is not. Check on the day.
- **60 vs 45 seconds.** The 60s figure is now a judgement, not a platform constraint.
  Best-performing short-form length is reported as 30–60s, which argues for trimming
  rather than extending — the Compete act is where the slack is.
- **Voiceover.** Recommended against, on the basis that most viewing is muted and a
  silent cut is the one a solo person finishes. A judgement, not a finding.
- **Every music and SFX number in this file.** All from search snippets. No licence
  page, loudness spec or study was opened. The Remotion section is the only externally-
  sourced part that is first-hand.
- **Whether any of this beats just posting the steal loop.** The research says the
  video is not the growth mechanism in this genre. The loop is three seconds of work
  compared to a weekend. Consider shipping it alone and seeing what happens before
  committing to the master.
