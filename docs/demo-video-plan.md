# The demo video — outline, script, storyboard

`docs/demo-video-guide.md` is the *technical* reference: Remotion, the capture
harness, ffmpeg recipes, licensing. **This file is the plan for one specific
video** — what it says, in what order, on what frames, and how each shot gets
captured.

Read the guide's §13 (capturing real app footage) and §14 (ffmpeg) before shooting.
Nothing here repeats them.

---

## Evidence quality — read this before treating any number below as fact

Research for this plan was done with web search only. **`WebFetch` is blocked by
this environment's egress policy** — every attempt to open a primary source, down to
a Wikipedia article, returned HTTP 403. So no platform help page, no study PDF and no
video teardown was actually opened and read.

That splits the material below three ways, and it is labelled throughout:

- **[evidenced]** — a real study or first-party number, though reached secondhand.
  The strongest: Verizon Media / Publicis Media, April 2019, n=5,616 — **69% of
  social video is watched muted**, and viewers are **80% more likely to finish** a
  video when captions are available. That one finding drives more of this plan than
  anything else.
- **[convention]** — independent practitioner sources converging on the same advice.
  Useful, unmeasured.
- **[inference]** — mine, from the product. Flagged so you can disagree with it.

Two specific things to re-check before you shoot, because an edit plan breaks if they
are wrong: **X's free-tier length limit** (reported as 140s, unverified) and
**YouTube Shorts' 60s ceiling** (reported, and the reason the master below is 60s and
not 90s).

---

## What this video has to do

**One job: get somebody to open the site and play one run.** Not sign up, not
subscribe — there is nothing to sell. Every second that is not moving somebody toward
"I'll try that" is a second to cut.

**Who it is for.** Broader than it looks. Quant-interview candidates are the loud
part of the audience — QuantNet alone is 20,000+ members, and the vocabulary there is
specific ("80 in 8", Optiver, Jane Street, score bands around 40/55/70). But
Zetamac's own referral traffic reportedly has **ChatGPT in its top five referrers,
alongside a secondary school's domain** [evidenced, secondhand via Similarweb
summaries]: a real slice of this audience is students sent the link by a teacher, and
another slice arrives by asking an LLM for a trainer.

Both groups already know what the drill is. Neither needs the concept explained. They
need one sentence about what is different.

**The pitch, in one line:** *the arithmetic drill you already use, except it tells
you why your score is what it is, and gives you people to play against.*

**The one thing to lead with** is the analysis. The daily, duels and leagues are all
reasons to come back; the analysis is the reason to try it at all, and it is the only
one that is legible in three seconds of silent video.

### An uncomfortable finding, stated before the plan rather than buried under it

**No product in this genre appears to have a brand-made launch video at all.**
Searching for one for Monkeytype or TypeRacer returns only third-party tutorials and
streamer footage. Monkeytype's origin is a single rough Reddit post in
`r/MechanicalKeyboards`, and the spark six days later was a streamer picking it up on
their own. [evidenced for the post; the streamer account is a founder's recollection,
secondhand]

So the honest read is that **the video is not the growth mechanism in this genre —
being picked up by somebody with an audience is**, and the artefact that gets picked
up is usually a credible post and a link, not a trailer. Make the video: it is the
thing you hand a creator, it is what fills the empty space on a landing page, and it
costs a weekend. But do not expect it to do the work of distribution, and do not
spend three weeks on it.

### What not to do

- **No logo card, no title card, no "introducing".** Open on the product being used.
  [convention, near-unanimous]
- **No feature list read aloud.** Seven features at eight seconds each is a tour,
  and nobody watches a tour of a free website.
- **No fake cursor.** Frictionless, perfectly-eased cursor movement is one of the
  named tells of a machine-made demo. Record real input with real hesitation.
  [convention]
- **No stock swoosh transitions, no music competing with the point.** Same list.
- **Nothing that is not true.** Do not stage a leaderboard with fake names, do not
  show a percentile the site cannot compute yet. The site is new and the boards are
  thin; shoot around that rather than faking depth. [inference — but see "Cold
  start" in `docs/TODO.md`, this is a real constraint]

---

## Deliverables

| Cut | Length | Ratio | For |
|---|---|---|---|
| **Master** | 60s | 16:9 1920×1080 | YouTube, embedding, the source of truth |
| **Vertical** | 60s | 9:16 1080×1920 | Shorts, Reels, phone timelines |
| **Short cut** | 28s | 16:9 + 9:16 | X, Reddit — the two places length hurts most |

One 16:9 master with a separate 9:16 re-frame is standard; square is not.
[convention] A 16:9 clip dropped into a vertical timeline gets pillarboxed and reads
as not-made-for-here.

**Captions are burned in, not uploaded.** 69% muted [evidenced] means the on-screen
text *is* the script — the voiceover, if there is one at all, is decoration. Burned-in
also survives being downloaded and re-shared, which is how a video like this
actually travels.

**Voiceover: optional, and my recommendation is to skip it.** [inference] The
comparative data on VO-vs-text does not exist in any source I could reach — every
pro-voiceover claim traced back to a company selling voiceover tools. What is not in
doubt is that most people will hear nothing. A tight silent cut with keystroke sound
and burned text is also the version one person can actually finish.

---

## The outline — beat sheet

Eight beats, 60 seconds. The first third is the argument; the rest is evidence.

| # | Time | Beat | Why it is here |
|---|---|---|---|
| 1 | 0:00–0:03 | **The drill, in progress** | Recognition. Anyone who knows Zetamac knows this screen in half a second. |
| 2 | 0:03–0:07 | **The bare score, and the objection** | The whole premise in two lines: here is your number, here is what it does not tell you. |
| 3 | 0:07–0:19 | **The analysis** | The differentiator. Longest beat in the video, deliberately. |
| 4 | 0:19–0:25 | **Practice mode** | The "so what do I do about it" that the analysis raises. |
| 5 | 0:25–0:34 | **Zetamac Daily** | Turns a solo drill into something with a shared answer. |
| 6 | 0:34–0:47 | **Duels, then steal mode** | The most shareable thing in the product, and the only one that needs two people. |
| 7 | 0:47–0:54 | **Leagues and a profile** | Fast montage. Reasons to come back, not reasons to arrive. |
| 8 | 0:54–1:00 | **The URL** | One CTA, held long enough to read and type. |

**Beat 3 gets 12 seconds and beat 7 gets 7.** That ratio is the whole editorial
decision. If the cut runs long, take it out of 5, 6 and 7 — never out of 3.

---

## The script

Format: `time · visual · ON-SCREEN TEXT · sound · capture notes`.

On-screen text is written exactly as it should appear. Keep every line under ~40
characters so it survives the 9:16 re-frame at readable size. [convention]

---

### 1 · 0:00–0:03 — cold open

**Visual.** Full-bleed game screen, dark theme, no browser chrome. A question sits
mid-screen; the answer field fills, the question flips, three times. The timer is
visible and running at real speed. No pointer on screen at all — this is typing.

**ON-SCREEN TEXT.** *None.* The first three seconds are the product working. A caption
here would be a caption about a thing the viewer can already see.

**Sound.** Real keystrokes, recorded, not sampled. The rhythm is the point: fast,
uneven, one hesitation.

**Capture.** Live, headed browser, real typing. Do not script this one — scripted
input has an even cadence and it reads as fake. Shoot it ten times and keep the take
with the natural stumble.

---

### 2 · 0:03–0:07 — the bare number

**Visual.** The run ends. The score lands large: **47**. Hold, completely still, for
a full second. Nothing animates.

**ON-SCREEN TEXT**, cut in on the beat:

```
0:04   Zetamac gives you this number.
0:055  It doesn't tell you why.
```

Second line replaces the first — never both on screen at once.

**Sound.** The keystrokes stop dead. Silence under the hold.

**Capture.** Same take as shot 1, continuous. The hold is an edit decision, not a
pause in the recording.

> The pivot of the whole video is that second line, and it works because it is *fair
> to Zetamac*. It is not "Zetamac is bad" — it is "here is the next question", which
> is the tone that survives being posted somewhere Zetamac's own users read.

---

### 3 · 0:07–0:19 — the analysis

The longest beat. Three moves, each landing one idea.

**3a (0:07–0:11) — the pace graph.** Cut to the results page. The projected-score
curve draws left to right, and there is a visible sag in the middle.

```
Every question is timed.
```

**3b (0:11–0:15) — the breakdown.** Scroll to the per-question list. The slowest row
highlights. Cursor moves — real, slightly imprecise.

```
So it can show you where you lost it.
```

**3c (0:15–0:19) — the tip.** Zoom to one question and its technique line, held long
enough to actually read and understand:

```
84 ÷ 7  →  70 ÷ 7 = 10,  14 ÷ 7 = 2,  = 12
```

```
And how to get it back.
```

**Sound.** Nothing, or one soft mark under the zoom.

**Capture.** Scripted via the harness against a **seeded run** — you want a specific
sag in the curve and a specific slow division. Determinism matters here more than
anywhere: you will re-shoot this shot most.

> 12 seconds on one screen is a long time in a 60-second video. It is the right call:
> this is the only beat that answers "why would I use this instead of the thing I
> already have", and every other beat is a variation on "and there is more".

---

### 4 · 0:19–0:25 — practice mode

**Visual.** Practice page. Weak types visibly weighted — division questions keep
coming up. Three or four questions, fast.

```
0:20   Practice mode weights your worst types higher.
0:23   So you drill where the time actually goes.
```

**Capture.** Harness, seeded so the weighting is visible rather than asserted. If the
draws happen to look random, the shot has failed even though nothing is wrong.

---

### 5 · 0:25–0:34 — Zetamac Daily

**Visual.** The daily page. One puzzle, one attempt, then the board — a small honest
board, the number of people who are actually on it.

```
0:26   One puzzle a day.
0:29   The same questions for everyone.
0:32   So nobody got easier problems.
```

**Capture.** Live against the real project, on a real day. **Do not stage a
leaderboard.** [inference — but a fabricated board is the one thing that would make
this video dishonest, and it is exactly what a viewer will check first.]

---

### 6 · 0:34–0:47 — duels, then steal mode

The two-player problem. My first instinct was split screen throughout, and the
research argues against it: the two patterns that actually work in this genre are
**TypeRacer's shared lane** — one frame, both racers, reads instantly — and the
Jackbox/Kahoot shared-screen model. Neither uses split screen, and at phone size a
split screen halves text that is already small. [convention]

So split screen is used for **four seconds total**, only where two windows *are* the
point: the link handing over, and the steal. The head-to-head itself is carried by
**the pace graph — two curves in one frame**, which is this product's version of
TypeRacer's shared lane and reads at any size.

**6a (0:34–0:37) — the link.** Left pane: create a duel, copy the link. Right pane:
the link opens; a name appears in the other window.

```
Send a link.
```

**6b (0:37–0:43) — one screen, playing.** Drop the split. **One pane, full width**,
the viewer's own run, speed-ramped ~8× **with the timer out of frame** — crop or
scroll it off before the ramp. A visibly sped-up countdown is the most obvious way to
make a demo look fake, and I could find no source addressing it, so: cut away from
the clock, always. [inference, flagged]

The other player is established by the caption, not by a second pane. The proof they
were really there arrives two seconds later, in the graph.

```
Same questions. Neither of you sees a score
until you're both done.
```

**6c (0:43–0:45) — the reveal.** Both scores appear at once. Then the pace graph
draws with **two real curves that cross**. This is the shot the whole beat exists
for: one frame, both players, no split, legible at any size.

```
Then the graph shows who was ahead, and when.
```

**6d (0:45–0:47) — steal mode.** Two seconds, hard cut. Same question on both
screens; one side answers; **both jump to the next question at once**.

```
Or play it live: first answer takes the point.
```

**Capture.** Two browser contexts, captured in one frame — not two recordings
composited, which will drift out of sync and look it. Steal mode needs both windows
genuinely connected, so this is the one shot that must be shot against the deployed
project rather than locally.

> 6d is the hardest two seconds in the video and the most worth having. The whole
> idea of steal mode is legible in one gesture — *both screens move when one person
> answers* — and no caption explains it as well as seeing it once.

---

### 7 · 0:47–0:54 — leagues and a profile

Montage. Four cuts, ~1.7s each, no lingering.

**Visual.** Invite code typed → a small league board, the viewer 3rd of 6 → a profile
page with the per-operation breakdown (`+ 1.42s · − 1.66s · × 1.98s · ÷ 2.31s`) →
the share card rendering to canvas in the dark theme.

```
0:48   Private leagues, on the day's puzzle.
0:51   Being 3rd of 6 beats being 4,000th.
```

**Capture.** Harness. Real numbers from a real account.

---

### 8 · 0:54–1:00 — the URL

**Visual.** Back to the config screen — the same frame the video opened on, which
closes the loop. Cursor rests on Start. The URL card holds, centred, still.

```
0:55   [your-domain]
0:57   Free. No account needed to start.
```

**Sound.** One keystroke, then nothing.

**Hold the URL for a minimum of 3 seconds.** People type it while it is on screen; a
CTA that flicks past is a CTA nobody used. [convention]

---

## Storyboard

Nine frames. 16:9 shown; the 9:16 note under each says what changes.

```
┌─ 1 ─ 0:00 ──────────────────────────┐   ┌─ 2 ─ 0:03 ──────────────────────────┐
│                                     │   │                                     │
│              47 × 6                 │   │                                     │
│            ┌─────────┐              │   │               47                    │
│            │  28▌    │              │   │                                     │
│            └─────────┘              │   │   Zetamac gives you this number.    │
│              0:47                   │   │                                     │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
  9:16: identical, it is already centred    9:16: identical

┌─ 3a ─ 0:07 ─────────────────────────┐   ┌─ 3c ─ 0:15 ─────────────────────────┐
│  PROJECTED SCORE                    │   │                                     │
│  60┤      ╭──╮      ╭────           │   │   84 ÷ 7          3.9s   ← slowest  │
│  50┤   ╭──╯  ╰──╮ ╭─╯               │   │   ───────────────────────────────   │
│  40┤ ╭─╯        ╰─╯                 │   │   70 ÷ 7 = 10                       │
│    └─────────────────────           │   │   14 ÷ 7 = 2                        │
│    Every question is timed.         │   │   = 12                              │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
  9:16: crop to the curve, drop the axis    9:16: this frame is why text is ≤40ch

┌─ 5 ─ 0:29 ──────────────────────────┐   ┌─ 6a ─ 0:34 ─────────────────────────┐
│  ZETAMAC DAILY · 28 JUL             │   │  ┌────────────┬────────────┐        │
│  ─────────────────────────          │   │  │ create     │ opened     │        │
│  1  yangyang        52              │   │  │ ┌────────┐ │            │        │
│  2  ...             49              │   │  │ │link ⧉  │ │ yangyang   │        │
│  3  ...             44              │   │  │ └────────┘ │ wants to   │        │
│  The same questions for everyone.   │   │  └────────────┴────────────┘        │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
  9:16: top 3 rows only, larger             Split screen, 3 seconds, only because
                                            the handover IS two windows.
                                            9:16: stack the panes vertically

┌─ 6c ─ 0:43 ─────────────────────────┐   ┌─ 6d ─ 0:45 ─────────────────────────┐
│      50        ·        29          │   │  ┌────────────┬────────────┐        │
│  ╭────────────────────────╮         │   │  │  63 − 28   │  63 − 28   │        │
│  │      ╱‾‾╲    ╱─────     │ you     │   │  │    35▌     │            │ ← one  │
│  │  ╱──╯    ╲──╯           │ them    │   │  │            │            │   types│
│  ╰────────────────────────╯         │   │  │  ↓ BOTH ADVANCE ↓       │        │
│  Who was ahead, and when.           │   │  └────────────┴────────────┘        │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
  The shared lane. One frame, both          The other place split screen earns
  players, no split — this is the           its place: both screens moving off
  frame beat 6 exists for.                  one person's keystroke is the whole
  9:16: crop to the crossing point          idea. 9:16: stacked, arrow between

┌─ 8 ─ 0:55 ──────────────────────────┐
│                                     │
│         [your-domain]               │
│                                     │
│   Free. No account needed to start. │
│                                     │
└─────────────────────────────────────┘
  9:16: identical, centred, hold 3s+
```

---

## Capture plan

Everything here is expanded in `docs/demo-video-guide.md` §13. The decisions specific
to this video:

**Scripted vs live, per shot.**

| Shot | How | Why |
|---|---|---|
| 1, 2 | **Live, headed, real typing** | Scripted input has an even cadence and reads as fake |
| 3, 4, 7 | **Harness, seeded RNG** | You need a specific curve, a specific slow question, a specific weighting |
| 5 | **Live, real day, real board** | A staged leaderboard is the one lie a viewer will catch |
| 6a, 6d | **Two real browser contexts in one frame** | Compositing two recordings drifts; steal mode needs a real connection |
| 6b, 6c | **One pane, full width** | The split is only worth its cost where two windows are the point |

**Resolution.** Capture at `deviceScaleFactor: 2` **and** `--force-device-scale-factor=2`
— both, or you get grey padding. That trap is documented in the guide and has already
cost this project time. Capturing supersampled and downscaling after the platform
re-encode is what keeps small text crisp.

**Legibility.** Enlarge the browser UI *before* recording rather than zooming in post
wherever possible. Zoom only to direct attention to a specific element, never to
"feel dynamic" — auto-zoom landing on nothing is a named tell. [convention]

**The timer problem.** Never speed-ramp a shot with the countdown in frame. Crop it,
scroll it off, or cut away. Real speed at the start and end of a round, compression
in the middle where the clock is not visible. [inference — no source addresses it,
and it is the most likely thing to make this specific video look staged]

**Determinism.** Seed the RNG and fix the date for every harness shot, so a re-shoot
of shot 3c produces the same 84 ÷ 7. Screenshot-per-frame if you need frame accuracy.

**Look at the frames.** Extract stills and open them. A stubbed dependency rendering a
blank panel while reporting success has happened twice in this project — once in a
HyperFrames render, once in a Chart.js-stubbed pace graph, both of which "succeeded".

---

## Edit and export

Full recipes in the guide §14. The shape of it:

1. Cut the master at 16:9 1920×1080, 30fps.
2. Burn captions. Sans-serif, heavy weight, a contrast stroke or plate, 1–2 lines of
   ≤40 characters, clear of the bottom 15–25% where platform UI sits. [convention]
3. Export the master, then derive: 9:16 re-frame (a re-frame, not a centre crop —
   shots 3a, 5, 6c need attention), and the 28s cut.
4. Target ~3,500–5,000 kbps H.264 / AAC in MP4. Every platform re-encodes; the goal
   is to hand it something already clean rather than something maximal.

**Music.** YouTube Audio Library (Content-ID safe) or Pixabay. If using Free Music
Archive, check the per-track CC variant — CC-BY-NC blocks commercial use and "my
free website" is a fight you do not need. Or ship it with keystrokes and silence,
which suits the product and is one fewer thing to get wrong.

---

## Distribution

- **X** — the 28s cut. Under any plausible length limit, and this is where length
  hurts most.
- **Reddit** — the 60s master. Read each subreddit's self-promotion rules first;
  several relevant ones ban link posts from new accounts outright, and a video that
  gets a post removed has done worse than nothing.
- **Hacker News** — the video is not the post. A Show HN is text and a link; the
  video belongs in the comments if at all.
- **YouTube** — the vertical 60s as a Short, and the 16:9 master as the canonical
  embed.

The post copy should say the same thing the video says, in one line: *the arithmetic
drill you already use, except it tells you why.* Do not open with "I built".

---

## What is not settled

- **Voiceover.** Recommended against above, on the basis that most viewing is muted
  and a silent cut is the one a solo person finishes. That is a judgement, not a
  finding; the comparative data does not appear to exist.
- **60 vs 90 seconds.** 60 is chosen so the vertical cut lands as a Short rather than
  a regular vertical video. If that limit has moved, 75 seconds would let beats 5–7
  breathe.
- **Whether to show the daily board at all** while player counts are low. Shooting an
  honest thin board is fine; shooting an *empty* one is not. Check on the day.
- **The share card may be the wrong shape to spread.** Wordle's grid worked because
  it was spoiler-free and *comparable at a glance*; Nerdle, which shares a score,
  still reaches for a glyph sequence rather than a bare number. Our card leads with a
  score. A card that led with the **pace curve** — a shape you can compare to
  somebody else's without knowing the questions — is closer to the mechanic that
  demonstrably travels. That is a product change, not a video change, and it belongs
  in `docs/TODO.md` rather than in this edit.
- **X's length limit and the Shorts ceiling**, both unverified — see the top of this
  file.
