# Remotion: A Practical Reference

A working guide to building programmatic video with [Remotion](https://www.remotion.dev), plus
the surrounding pipeline — capturing real app footage, encoding for the web, and the craft rules
for demo videos.

Written against **Remotion 4.0.500** and **Playwright 1.62.0** (July 2026). Not specific to any
one project.

**Confidence markers used throughout:**
- ✅ **Verified** — read from source (Remotion docs repo, x264/FFmpeg/OBS/Chromium source, npm registry) or tested locally
- 📄 **Documented** — from official docs, not independently re-verified
- ⚠️ **Reported** — community claim, single source, or vendor marketing

---

## Table of contents

1. [Decide first: should you use Remotion at all?](#1-decide-first)
2. [Licensing — read before you commit](#2-licensing)
3. [Mental model](#3-mental-model)
4. [Setup](#4-setup)
5. [Core API](#5-core-api)
6. [Animation primitives](#6-animation-primitives)
7. [Assets](#7-assets)
8. [Rendering](#8-rendering)
9. [Rendering at scale](#9-rendering-at-scale)
10. [Performance](#10-performance)
11. [The rules LLMs break](#11-the-rules-llms-break)
12. [Version notes and v5](#12-version-notes-and-v5)
13. [Capturing real app footage](#13-capturing-real-app-footage)
14. [FFmpeg recipes](#14-ffmpeg-recipes)
15. [Demo video craft](#15-demo-video-craft)
16. [AI asset pipeline](#16-ai-asset-pipeline)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. Decide first

Remotion is not always the right tool, and adopting it for the wrong job means paying its whole
learning curve and render-infrastructure tax for output a screen recorder produces in an afternoon.

### Use Remotion when

- The video is a **system, not an artifact** — regenerated per release, per locale, per customer
- **Data-driven** content: dashboards, stats, reports, year-in-review
- **Personalised at scale**: thousands of near-identical short compositions
- There is **no real UI to film yet** and you need convincing mockups
- You need **determinism**: same input → same MP4, versioned in git

### Do NOT use Remotion when

- You're not comfortable in JavaScript/React. Hard stop.
- It's a **one-off creative/artistic** video — After Effects or a freelancer will be faster and better
- You're doing **casual editing** (a reel, a wedding video)
- You're **compositing long source video** — this is the documented slow path
- You expect to **throw hardware at throughput** — vertical scaling does not work (see §10)

### For a product demo specifically

**If you have a working UI, record it.** The strongest argument is credibility: a motion-graphics
demo built from mockups shows viewers *a drawing of your product*; a screen recording is evidence
it works.

Telling detail: the leading community Remotion demo-video skill lists *"schematic UI mockups when
the product has no real UI to film"* as its use case. That's the honest positioning.

**The hybrid is usually right:** record the real app, use Remotion for intro/outro, captions,
callouts, data overlays, and per-variant text. Keep the embedded clips short — long source video
through the media components is the slow path.

### Alternatives worth knowing

| Tool | When it wins |
|---|---|
| **Screen recorder** (Screen Studio, Cap, OBS) | Demoing a real UI. Minutes, not hours. |
| **After Effects** | Human-designed motion. Remotion treats AE as an *input* via Bodymovin → Lottie → `@remotion/lottie`, not a competitor. |
| **Motion Canvas** | Hand-authored explainer animation. Imperative generator API (each `yield` = a frame), canvas-only, faster but no HTML/CSS. |
| **Revideo** ([midrender/revideo](https://github.com/midrender/revideo)) | Open-source, Motion Canvas lineage, positioned against Remotion's licensing. |
| **Rive** | Interactive runtime animation that lives *in* your product. Also used *inside* Remotion via `@remotion/rive`. |
| **Arcade / Supademo / Storylane** | Interactive DOM-capture walkthroughs — often better than video for product demos. |

---

## 2. Licensing

✅ **Verified** by reading [`LICENSE.md`](https://raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md),
`packages/docs/docs/license/*.mdx`, and the npm registry directly.

**Remotion is proprietary, source-available software — explicitly not open source.** The npm
`license` field is `"SEE LICENSE IN LICENSE.md"`. The docs FAQ says so verbatim:

> "No. Remotion is source-available software, but it is not open-source software according to the
> Open Source Initiative's Open Source Definition."

**Historical note:** this was contested within days of launch in Feb 2021 ([#17](https://github.com/remotion-dev/remotion/issues/17),
[#27](https://github.com/remotion-dev/remotion/issues/27), [#47](https://github.com/remotion-dev/remotion/issues/47)),
and commit `1afc11a` (2021-02-11) is literally titled **"Remove term 'open source'"**. Remotion has
described itself as source-available ever since.

### Free License eligibility

> - an individual
> - a for-profit organization with **up to 3 employees**
> - a non-profit or not-for-profit organization
> - evaluating whether Remotion is a good fit, and are not yet using it in a commercial way

And critically:

> Permission is hereby granted... to use the software **non-commercially or commercially** for the
> purpose of creating videos and images

**The trigger is WHO YOU ARE, not what you do.** A 50-person company using Remotion purely for an
internal dashboard video that never ships to customers **still needs a license**. A solo developer
selling videos commercially is **still free**. Revenue is irrelevant; headcount is everything.

**Zero feature difference between free and paid.** From the FAQ: *"There is no difference between
the free and paid version. We discriminate the price of the same software for various users."*

### Pricing (verified July 2026)

From the v5 terms + `FreePricing.tsx` (`SEAT_PRICE = 25`, `RENDER_UNIT_PRICE = 10` per 1,000):

| Tier | Price | Minimum |
|---|---|---|
| **Creators** (per-seat) | **$25 / seat / month** | none when purchased alone |
| **Automators** (per-render) | **$0.01 / render** (billed per 1,000 = $10) | **$100 / month** |
| Both combined | — | $100/mo combined |
| **Enterprise** | Custom | **$500 / month** |

- A **Seat** = one person who writes Remotion code *or uses agentic coding tools* — the terms name Claude Code, Codex, and OpenCode explicitly
- A **Render** = one successful video/audio/GIF/PDF/still. Studio and Player *previews* don't count. Failed and development renders don't count.
- ⚠️ **Embedding `<Player>` on a website counts as automation** and requires Automators at minimum spend, even though displaying it isn't a render
- ⚠️ **Lambda/AWS costs are entirely separate and on top** — Remotion provides no rendering service
- Per-render pricing **doubled** from $0.005 to $0.01 between Jan 2025 and now; seat price unchanged

### Gotchas that catch people out

- **Headcount aggregates across collaborating parties.** Agency + client combined ≥4 → license required. The license must be held by whoever **owns the codebase/IP** — typically the client, not the agency.
- **Contractors and part-timers count** (new in v5 — previously a company could staff entirely with contractors and owe nothing)
- **There is NO open-source exemption.** An OSS project is free only because its maintainers happen to be ≤3 people. A 200-person company releasing an OSS tool built on Remotion still needs a license. The "no derivative reselling/relicensing" clause is also genuinely incompatible with copyleft distribution — at least one project documented this conflict and chose Revideo instead.
- **"Non-profit" is narrow.** Governmental entities, public-sector bodies, **educational institutions**, commercial subsidiaries, and trade associations **do not qualify** without written permission.
- **"Evaluation" is narrow.** *"The decision to use the Remotion Software in one's technology setup marks the end of the evaluation phase"* — regardless of whether anything shipped.
- **Piracy clause:** unlicensed users owe back fees plus, for significant infringement, **10% interest per month**. Swiss law, exclusive jurisdiction Canton of Zurich.
- **Per-use-case licensing:** a license for one product does not automatically cover other business units, subsidiaries, or materially distinct use cases in the same corporate group.

### Also disallowed for everyone, free and paid

- Reselling / relicensing a derivative of Remotion
- Reverse-engineering
- Offering a service where **end users upload their own Remotion code** for rendering

### Direction of travel — plan for this

- [Issue #9653](https://github.com/remotion-dev/remotion/issues/9653) "Licensing masterplan": *"Use tools to enforce licensing — terms, telemetry, and license itself"*
- v5 adds `REMOTION_PUBLIC_LICENSE_KEY`; license keys becoming **mandatory** for Automators
- Telemetry sends IP, domain, prod-vs-dev, video-vs-still. If firewalls block it you must submit verifiable monthly render reports instead.
- ⚠️ `@remotion/web-renderer` ships `"license": "UNLICENSED"`, which **automated compliance scanners flag** as a private module ([#8734](https://github.com/remotion-dev/remotion/issues/8734)) — a real enterprise-deployment blocker

**Free-tier tip:** if using `@remotion/web-renderer` (which always sends telemetry), pass
`licenseKey: "free-license"` to declare eligibility and silence the console warning.

### ⚠️ Which terms are actually in force

As of 2026-07-27 the latest npm release is **4.0.500 — Remotion 5.0 has not shipped.** The v5 terms
in the docs carry an explicit banner: *"These Terms and Conditions will take effect upon the release
of Remotion 5.0."* So the detailed v5 definitions (non-profit criteria, commercial-use definition,
corporate-group rules, contractor headcount) are **upcoming, not currently binding**. The two-tier
structure and the 3-person threshold are unchanged and safe to rely on either way.

⚠️ One genuine ambiguity: **v5 narrows "an individual" to "an individual using the Software for
personal use."** Whether a revenue-generating solo side project counts as "personal use" is unclear
under that phrasing. In practice it likely doesn't matter — the *second* bullet ("up to 3 people")
covers a one-person business regardless, and v5 drops "for-profit" from it. But if your reading
hinges specifically on the "individual" bullet, get written confirmation.

### Bottom line

**Solo developer, own project, even if it makes money: free.** You qualify twice over — as an
individual and as an org of ≤3. You could run a profitable one-person SaaS rendering thousands of
videos and owe nothing.

Settle licensing **before** taking the dependency, not after. One team's architecture doc put it
well: keep Remotion behind an interface so it can be swapped for Motion Canvas, an SVG/Lottie
pipeline, or plain FFmpeg-generated cards if the licence stops fitting. For anything with real money
attached, [remotion.dev/contact](https://www.remotion.dev/contact) — the FAQ invites exactly this.

### MIT-licensed alternatives (licenses verified)

[Revideo](https://github.com/midrender/revideo) (MIT, created explicitly as the open alternative),
[Motion Canvas](https://github.com/motion-canvas/motion-canvas) (MIT),
[editly](https://github.com/mifi/editly) (MIT),
[Diffusion Studio core](https://github.com/diffusionstudio/core) (MPL-2.0, watermark gate).

---

## 3. Mental model

> A video is a function of images over time.

Remotion gives you a frame number and a blank canvas. You return JSX. That's it.

A video has exactly four properties: `width`, `height`, `durationInFrames`, `fps`.
**Frame 0 is the first frame; `durationInFrames - 1` is the last.**

```tsx
import {AbsoluteFill, useCurrentFrame} from 'remotion';

export const MyComposition = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', fontSize: 100}}>
      The current frame is {frame}.
    </AbsoluteFill>
  );
};
```

### How a React component becomes an MP4

✅ Verified against `packages/renderer/src/seek-to-frame.ts` and `packages/core/src/delay-render.ts`.

1. **Bundle** — Webpack compiles your project to a static folder ("the bundle"). Hosted at a URL it becomes a *Serve URL*.
2. **Launch headless Chromium** — Remotion ships its own build, with proprietary codecs so MP4 decode works.
3. **Open N tabs** — N = `--concurrency`, default **half your CPU threads**.
4. **Per frame: seek → wait → screenshot.** `seekToFrame()` sets the frame; `waitForReady()` blocks until every outstanding `delayRender()` handle is resolved. Then the tab is screenshotted (JPEG by default, PNG for alpha).
5. **Encode** — frames pipe into bundled FFmpeg. Since 4.0.52 a *pre-stitcher* encodes concurrently with rendering.
6. **Audio** is collected per frame, mixed, and muxed separately.

### The consequence that governs everything

**Tabs do not share state, and frames do not render in order.**

This is why the golden rule exists:

> A component must always display the same visual when called multiple times; must not rely on
> frame order; must not animate when paused; must not rely on randomness.

`--concurrency=1` "fixes" nondeterminism by accident, but it's slow, still not timing-accurate
across machines, and **blocks Lambda rendering entirely**. Determinism is what makes distributed
rendering possible — don't fight it.

---

## 4. Setup

```bash
# Scaffold
npx create-video                          # interactive
npx create-video --yes --blank my-video   # non-interactive (best for agents)
npx create-video --yes --blank --no-tailwind my-video

# Install the official agent skills FIRST if using Claude Code / Cursor / Codex
npx skills add remotion-dev/skills
# or
npx remotion skills

npm start          # opens Remotion Studio on :3000
```

`--yes` installs Tailwind if supported, skips skill install, doesn't open the editor, and **fails
if you're already inside a git repo**.

### Templates

`blank`, `hello-world`, `next`, `vercel`, `next-no-tailwind`, `next-pages-dir`, `recorder`,
`prompt-to-motion-graphics`, `javascript`, `render-server`, `electron`, `react-router`, `three`,
`still`, `audiogram`, `music-visualization`, `prompt-to-video`, `skia`, `overlay`, `code-hike`,
`stargazer`, `tiktok`, `editor-starter`

### Agent skills — the load-bearing step

Without skills, an LLM guesses API shapes and produces code needing manual correction. With them,
reported build times are **60–120 minutes for a 20–45s demo**.

The package is a router skill (`remotion-best-practices`) that lazily loads sub-skills:
`remotion-create`, `remotion-markup`, `remotion-render`, `remotion-captions`, `remotion-multimedia`,
`remotion-interactivity`, `remotion-saas`, `remotion-docs`, `remotion-upgrade`, `remotion-maps`.
`remotion-markup` alone links ~30 further rule files.

### Reading Remotion docs programmatically

Useful when a site is blocked or you want machine-readable docs:

- **Append `.md` to any docs URL**: `remotion.dev/docs/sequence.md`
- **Docs source on GitHub**: `raw.githubusercontent.com/remotion-dev/remotion/main/packages/docs/docs/*.mdx`
- **Algolia index**: `POST https://plsduol1ca-dsn.algolia.net/1/indexes/*/queries`, `indexName: "remotion"`
- `@remotion/mcp` — ⚠️ note this registers **exactly one tool** (`remotion-documentation`, a docs search proxy). Blog posts claiming it provides "programmatic interfaces" are wrong.

The official skill says it plainly: *"Implement using the current documentation rather than
memorized API knowledge."* Remotion ships near-daily; your training data is stale.

---

## 5. Core API

### `<Composition>`

Registered in `src/Root.tsx`, which is registered via `registerRoot()` in `src/index.ts`.

```tsx
import {Composition} from 'remotion';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="MyComposition"          // letters, numbers, '-' only — this is the render target
      component={MyComposition}   // or lazyComponent={() => import('./X')}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{}}
      calculateMetadata={fn}      // async: compute duration/size/props before render
      schema={zodSchema}          // unlocks visual prop editing in Studio
    />
  </>
);
```

**Constraints:**
- `defaultProps` **must be JSON-serialisable**. Functions and classes are lost. `Date`, `Map`, `Set`, `staticFile()` are specially handled.
- Type props with `React.FC<{...}>` and a `type`, **not an `interface`** — an interface breaks `defaultProps` typesafety.
- `<Folder name="...">` organises compositions in the sidebar.

### `useCurrentFrame()` / `useVideoConfig()`

`useCurrentFrame()` returns the frame **relative to the enclosing `<Sequence>`**, not absolute.

```tsx
const Subtitle = ({absoluteFrame}: {absoluteFrame: number}) => {
  console.log(useCurrentFrame()); // 15  — relative to the Sequence
  console.log(absoluteFrame);     // 25  — passed down from the top
  return null;
};

const MyVideo = () => {
  const frame = useCurrentFrame(); // 25
  return <Sequence from={10}><Subtitle absoluteFrame={frame} /></Sequence>;
};
```

`useVideoConfig()` returns `{width, height, fps, durationInFrames, id, defaultProps, props,
defaultCodec, defaultSampleRate}` — note `width`/`height`/`durationInFrames` are also shadowed by
an enclosing Sequence.

### `<Sequence>`

Time-shifts children. `<Sequence from={30}>` makes children see frame 0 when global frame is 30.
Sequences **cascade**.

```tsx
<Sequence durationInFrames={30}><Intro /></Sequence>          {/* frames 0–29  */}
<Sequence from={30} durationInFrames={30}><Clip /></Sequence>  {/* frames 30–59 */}
<Sequence from={60}><Outro /></Sequence>                       {/* 60 → end     */}
```

| Prop | Since | Meaning |
|---|---|---|
| `from`, `durationInFrames` | — | shift / unmount window (`durationInFrames` defaults to `Infinity`) |
| `layout="none"` | — | opt out of the default `AbsoluteFill` wrapper (required inside `<ThreeCanvas>`) |
| `trimBefore` | 4.0.482 | children advance by N frames, Sequence still starts at `from` |
| `freeze={n}` | 4.0.476 | pin children at frame n without remounting |
| `cropLeft/Right/Top/Bottom` | 4.0.500 | animatable 0–1 edge crop |
| `premountFor` / `postmountFor` | 4.0.140 / .340 | mount early/late (hidden) so heavy content buffers |
| `hidden` | 4.0.462 | Studio eye-icon toggle, persisted to source |
| `width` / `height` | 4.0.80 | override `useVideoConfig()` for children |

**Trim-and-delay idiom** — nest two Sequences:

```tsx
<Sequence from={30}>        {/* delay by 30 */}
  <Sequence from={-15}>     {/* skip the content's first 15 frames */}
    <Content />
  </Sequence>
</Sequence>
```

### `<Series>` and `<TransitionSeries>`

`<Series>` chains scenes without manual frame arithmetic.

```tsx
import {Series} from 'remotion';

<Series>
  <Series.Sequence durationInFrames={40}><SceneA /></Series.Sequence>
  <Series.Sequence durationInFrames={20} offset={-10}><SceneB /></Series.Sequence>
  <Series.Sequence durationInFrames={70}><SceneC /></Series.Sequence>
</Series>
```

Only the **last** may have `Infinity` duration. `offset` is positive to gap, negative to overlap.

`<TransitionSeries>` adds real transitions and **shortens** total duration by the overlap:

```tsx
import {linearTiming, springTiming, TransitionSeries} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {wipe} from '@remotion/transitions/wipe';

<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={60}><A /></TransitionSeries.Sequence>
  <TransitionSeries.Transition timing={springTiming({config: {damping: 200}})} presentation={fade()} />
  <TransitionSeries.Sequence durationInFrames={60}><B /></TransitionSeries.Sequence>
  <TransitionSeries.Transition timing={linearTiming({durationInFrames: 30})} presentation={wipe()} />
  <TransitionSeries.Sequence durationInFrames={60}><C /></TransitionSeries.Sequence>
</TransitionSeries>
```

`<TransitionSeries.Overlay>` (4.0.415+) puts children over a cut point *without* changing timing —
for flashes and light leaks.

### `<AbsoluteFill>`

Literally:

```ts
{position:'absolute', top:0, left:0, right:0, bottom:0, width:'100%', height:'100%',
 display:'flex', flexDirection:'column'}
```

Layers stack in DOM order (last = on top). Since 4.0.249 it detects conflicting Tailwind classes
and disables the corresponding inline styles.

---

## 6. Animation primitives

### `interpolate()`

```ts
interpolate(input, inputRange, outputRange, options?)
```

```ts
// Fade in
const opacity = interpolate(frame, [0, 20], [0, 1]);

// Fade in AND out
const {durationInFrames} = useVideoConfig();
const opacity = interpolate(
  frame,
  [0, 20, durationInFrames - 20, durationInFrames],
  [0,  1,  1,                    0],
);

// ALWAYS clamp unless you want extrapolation
const scale = interpolate(frame, [0, 20], [0, 1], {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});
```

⚠️ **Defaults are NOT clamped.** `extrapolateLeft`/`extrapolateRight` default to `'extend'`:

```ts
interpolate(1.5, [0, 1], [0, 2], {extrapolateRight: 'extend'});   // 3
interpolate(1.5, [0, 1], [0, 2], {extrapolateRight: 'clamp'});    // 2
interpolate(1.5, [0, 1], [0, 2], {extrapolateRight: 'identity'}); // 1.5
interpolate(1.5, [0, 1], [0, 2], {extrapolateRight: 'wrap'});     // 1
```

**Newer options worth knowing** (under-documented elsewhere):

```ts
// Per-segment easing arrays (4.0.462) — length must be inputRange.length - 1
interpolate(frame, [0, 100, 200], [0, 1, 2], {
  easing: [Easing.out(Easing.cubic), Easing.in(Easing.cubic)],
});

// posterize (4.0.470) — quantise input; frames 0,1,2 all use frame 0's value
interpolate(frame, [0, 60], [0, 1], {posterize: 3});

// CSS transform strings as outputRange (4.0.472; transform-origin 4.0.475)
<div style={{
  scale:           interpolate(frame, [0, 30], ['1', '2 3']),
  translate:       interpolate(frame, [0, 30], ['0px 0px', '100px 50px']),
  rotate:          interpolate(frame, [0, 30], ['0deg', '90deg']),
  transformOrigin: interpolate(frame, [0, 30], ['left top', 'right bottom']),
}} />

// Numeric tuples (4.0.473)
const pt = interpolate(frame, [0, 60], [[0, 0.5], [1, 0.5]]);

// perceptual-scale (4.0.490) — linear VISIBLE AREA change, not linear CSS number
const scale = interpolate(frame, [0, 60], [0, 1], {
  extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  output: 'perceptual-scale',   // halfway returns √0.5, not 0.5
});
```

`easing` shapes *time*; `output` shapes *value distribution after easing*.

### `spring()`

Physics simulation ported from React Native Reanimated 2. Defaults animate 0 → 1 with slight overshoot.

```ts
const value = spring({
  frame,
  fps,
  config: {mass: 1, damping: 10, stiffness: 100, overshootClamping: false},
  from: 0,
  to: 1,
  durationInFrames: 40,         // stretch the curve to exactly N frames
  durationRestThreshold: 0.001,
  delay: 25,
  reverse: false,
});
```

**Tuning:** lower `mass` = faster. Higher `damping` = less bounce (`damping: 200` ≈ no bounce).
`stiffness` controls bounciness.

Order of operations: stretch to `durationInFrames` → apply `reverse` → apply `delay`.

Drive arbitrary ranges by composing:

```ts
const driver = spring({frame, fps});
const marginLeft = interpolate(driver, [0, 1], [0, 200]);
```

📄 The official skill says: *"Prefer `interpolate()` over `spring()` unless the user explicitly
asks for physics-based motion."*

### `Easing`

Predefined: `back`, `bounce`, `ease`, `elastic(bounciness)`, `spring(config)`.
Standard: `linear`, `quad`, `cubic`, `poly(n)`.
Extra: `bezier(x1,y1,x2,y2)`, `circle`, `sin`, `exp`, `step0`, `step1`.
Modifiers: `Easing.in()`, `Easing.out()`, `Easing.inOut()`.

```tsx
const v = interpolate(frame, [0, 100], [0, 1], {
  easing: Easing.bezier(0.8, 0.22, 0.96, 0.65),
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});
```

**`Easing.spring()` (4.0.476+)** is distinct from `spring()` — a *normalised easing curve* for
`interpolate()` taking no `frame`/`fps`. Config: `damping`, `mass`, `stiffness`,
`overshootClamping`, `durationRestThreshold`, `allowTail`.

⚠️ **For Studio keyframe-editability**, prefer explicit `Easing.bezier(...)` with numeric args over
composed presets like `Easing.inOut(Easing.cubic)`. Editable: `bezier`, `spring()` with inline
static config, `linear`, `ease`, `quad`, `cubic`, `back()`, `poly(1|2|3)`. Read-only: `sin`,
`circle`, `exp`, `bounce`, `elastic`, `poly(4)`.

### Standard idioms

```tsx
// FADE
const opacity = interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'});

// SLIDE UP + FADE — the workhorse
const progress = spring({frame, fps, config: {damping: 200}});
const translateY = interpolate(progress, [0, 1], [40, 0]);
<div style={{opacity: progress, transform: `translateY(${translateY}px)`}} />

// POP-IN (bouncy)
const scale = spring({frame, fps});
<div style={{transform: `scale(${scale})`}} />

// STAGGERED LIST
{items.map((item, i) => {
  const s = spring({frame, fps, delay: i * 4, config: {damping: 200}});
  return <div key={i} style={{opacity: s, transform: `translateY(${(1 - s) * 20}px)`}}>{item}</div>;
})}
```

Interactive playground: [remotion.dev/timing-editor](https://www.remotion.dev/timing-editor)

---

## 7. Assets

### `staticFile()`

Put files in `public/` **next to the `package.json` that has the `remotion` dependency**.

```tsx
import {Img, staticFile} from 'remotion';
<Img src={staticFile('/my-image.png')} />
```

Why not a plain string: survives deployment into a subdirectory, avoids collisions with composition
names in Studio, framework-agnostic. Since v4 it applies `encodeURIComponent` internally —
**do not pre-encode** or you'll double-encode.

Also: `getStaticFiles()`, `watchStaticFile()`, `prefetch()`.

### Video — three components, pick correctly

This changed substantially in 2026 and is the single biggest practical thing to internalise.

| | `<Video>`/`<Audio>` (`@remotion/media`) | `<OffthreadVideo>` (`remotion`) | `<Html5Video>` (`remotion`) |
|---|---|---|---|
| Based on | **Mediabunny + WebCodecs** | Rust + FFmpeg | HTML5 `<video>` |
| Frame-perfect | ✅ | ✅ | ❌ |
| Partial download | ✅ | ❌ | only if `muted` |
| Render speed | **Fastest** | Fast | Medium |
| HLS | ✅ | Chrome 142+, preview only | preview only |
| Loopable | ✅ | ❌ | ✅ |
| CORS required | **Yes** | No | No |
| Client-side rendering | ✅ | ❌ | ❌ |

**`<Video>` from `@remotion/media` is the recommendation for all new code.** Stable since 4.0.491.
The old `<Video>` from `remotion` was renamed `<Html5Video>`; `<OffthreadVideo>` is now legacy.

```tsx
import {Video} from '@remotion/media';
import {staticFile, interpolate} from 'remotion';

<Video
  src={staticFile('recording.mp4')}
  trimBefore={60}          // skip first 2s at 30fps
  trimAfter={120}
  from={30}                // built-in Sequence semantics (4.0.445+)
  durationInFrames={90}
  playbackRate={1.5}
  objectFit="cover"        // CSS object-fit does NOT work — use this prop
  volume={(f) => interpolate(f, [0, 30], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}
  premountFor={30}
  loop
  muted
/>
```

Other props: `effects`, `onVideoFrame`, `headless` (no canvas, for Three.js textures),
`audioStreamIndex`, `requestInit` (e.g. `{cache: 'no-store'}`), `toneFrequency`, `debugOverlay`,
`onError`.

**Automatic fallback:** unsupported codec, missing CORS, or un-compositable alpha → silently falls
back to `<OffthreadVideo>`. Configure with `fallbackOffthreadVideoProps`, disable with
`disallowFallbackToOffthreadVideo`. ⚠️ **Fallback is impossible under client-side rendering** — the
render just fails.

⚠️ **Matroska caveat:** `.mkv`/`.webm` store only millisecond-precision timestamps, so extracting
audio at minute 3 requires decoding minutes 0–3. **Prefer `.mp4`/`.mov`/`.m4a` for Lambda.**

### Sizing a composition to a video file

The idiomatic pattern — don't hardcode duration:

```tsx
import {Input, ALL_FORMATS, UrlSource} from 'mediabunny';
import {CalculateMetadataFunction, staticFile} from 'remotion';

const src = staticFile('recording.mp4');

const getMediaMetadata = async (s: string) => {
  const input = new Input({formats: ALL_FORMATS, source: new UrlSource(s, {getRetryDelay: () => null})});
  const durationInSeconds = await input.computeDuration();
  const videoTrack = await input.getPrimaryVideoTrack();
  const packetStats = await videoTrack?.computePacketStats();
  return {
    durationInSeconds,
    fps: packetStats?.averagePacketRate ?? null,
    dimensions: videoTrack ? {width: videoTrack.displayWidth, height: videoTrack.displayHeight} : null,
  };
};

export const calculateMetadataFn: CalculateMetadataFunction<Record<string, unknown>> = async () => {
  const {durationInSeconds, dimensions, fps} = await getMediaMetadata(src);
  return {
    durationInFrames: Math.round(durationInSeconds * fps!),
    fps: fps!,
    width: dimensions!.width,
    height: dimensions!.height,
  };
};
```

### Images

```tsx
import {Img, staticFile} from 'remotion';
<Img src={staticFile('hi.png')} />
```

`<Img>` blocks the frame until loaded — that's the entire point vs native `<img>`.

⚠️ Since 4.0.469 a non-empty `effects` array switches it to `<CanvasImage>`, which **drops** `ref`,
`srcSet`, `sizes`, `loading`, `decoding`, `fetchPriority`, `crossOrigin`, `onLoad`, `onError`, `alt`.

⚠️ **Never use CSS `background-image` or `mask-image`** — they don't participate in load-blocking
and cause flicker.

### Fonts

```tsx
// 1. Google Fonts — type-safe, no CSS file
import {loadFont} from '@remotion/google-fonts/TitanOne';
const {fontFamily} = loadFont('normal', {weights: ['400'], subsets: ['latin']});

// 2. Local files from public/
import {loadFont} from '@remotion/fonts';
loadFont({family: 'Inter', url: staticFile('Inter-Regular.woff2'), weight: '500'});

// 3. Manual
const handle = delayRender();
const font = new FontFace('Bangers', `url('${staticFile('bangers.woff2')}') format('woff2')`);
font.load().then(() => { document.fonts.add(font); continueRender(handle); });
```

Load fonts in one shared module. Only call `measureText()`/`fitText()`/`fillTextBox()` **after**
fonts resolve. In v5, `@remotion/google-fonts` will **require** explicit `weights` and `subsets`.

Lambda ships Noto Sans (+ Arabic, Devanagari, Hebrew, Tamil, Thai) and Noto Color Emoji.
**CJK/Korean fonts are arm64-only.** For anything else, use webfonts.

---

## 8. Rendering

```bash
npx remotion render                                  # picker
npx remotion render MyComp out/video.mp4
npx remotion render MyComp out/video.mp4 --props="./input-props.json"

npx remotion still         # single image
npx remotion compositions  # list IDs
npx remotion bundle
npx remotion benchmark     # tune concurrency
```

| Flag | Notes |
|---|---|
| `--codec` | `h264` (default), `h265`, `av1`, `vp8`, `vp9`, `prores`, `png`, `mp3`, `aac`, `wav`, `h264-mkv`. AV1 unavailable on Linux ARM64 GNU |
| `--crf` / `--video-bitrate` | mutually exclusive; CRF unavailable with hardware acceleration |
| `--jpeg-quality` | 0–100 (renamed from `--quality` in v4) |
| `--image-format` | `jpeg` (fast) vs `png` (needed for alpha) |
| `--scale` | 0 < s ≤ 16; renders vectors/text at higher detail |
| `--concurrency` | number or `"50%"` |
| `--frames`, `--every-nth-frame`, `--sequence` | frame ranges, GIF fps reduction, image-sequence output |
| `--chrome-mode` | `chrome-headless-shell` (faster CPU-bound) vs `chrome-for-testing` (faster GPU-bound) |
| `--timeout` | per-frame `delayRender()` budget, default 30000 ms |
| `--disallow-parallel-encoding` | lower memory, possibly slower |
| `--repro` | produces a reproduction bundle for bug reports |
| `--log=verbose` | **prints slowest frames — the primary profiling tool** |

### Node API

```js
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';

const serveUrl = await bundle({entryPoint: './src/index.ts'});
const inputProps = {titleText: 'Hello World'};
const composition = await selectComposition({serveUrl, id: 'my-video', inputProps});

await renderMedia({composition, serveUrl, codec: 'h264', outputLocation: 'out/video.mp4', inputProps});
```

⚠️ **Pass the same `inputProps` to both `selectComposition()` and `renderMedia()`.** Forgetting is
a classic footgun — v5 makes it required. `outputLocation: null` returns an in-memory buffer.

### `<Player>` — embedding in a normal React app

```tsx
import {Player} from '@remotion/player';

<Player
  component={MyVideo}
  durationInFrames={120}
  compositionWidth={1920}
  compositionHeight={1080}
  fps={30}
  inputProps={{title: 'Hello'}}
  controls loop autoPlay
  style={{width: 640}}     // display size ≠ composition size
/>
```

**The Player does not use `<Composition>`** — pass the component directly. Unlike compositions,
`inputProps` here **may contain functions**. `numberOfSharedAudioTags` (default 5) pre-mounts silent
audio tags to defeat iOS Safari autoplay policy.

---

## 9. Rendering at scale

### Remotion Lambda

```bash
npm i @remotion/lambda
npx remotion lambda policies role       # → IAM policy named exactly `remotion-lambda-policy`
npx remotion lambda policies user
npx remotion lambda policies validate
npx remotion lambda functions deploy
npx remotion lambda sites create src/index.ts --site-name=my-video
npx remotion lambda quotas              # CHECK THIS EARLY
npx remotion lambda render <serve-url> <composition-id>
```

**Architectural detail that trips people up:** the *function* and the *site* are separate. The
function contains binaries + render code and is **pinned to a Remotion version** — upgrading
Remotion requires redeploying the function.

```ts
import {getFunctions, renderMediaOnLambda, getRenderProgress} from '@remotion/lambda/client';
```

⚠️ Import from **`@remotion/lambda/client`**, not `@remotion/lambda`, inside serverless functions.

**Concurrency:** `concurrency = frameCount / framesPerLambda`. Min `framesPerLambda` = 5, **max
concurrency = 200**. Exceeding throws "Too many functions". The fix is almost always
`framesPerLambda: null` (let Remotion decide).

**vCPU scales with memory:**

| Memory | vCPUs |
|---|---|
| 128–3008 MB | 2 |
| 3009–5307 MB | 3 |
| 5308–7076 MB | 4 |
| 7077–8845 MB | 5 |
| 8846+ MB | 6 |

**📄 Published cost/time** (2048 MB, us-east-1, vendor benchmark):

| Workload | Warm | Cold |
|---|---|---|
| Hello World | $0.001 / 7.56s | $0.001 / 11.02s |
| 1-min video from S3 | $0.017 / 18.91s | $0.021 / 15.52s |
| 10-min remote HD video | $0.103 / 56.09s | $0.108 / 60.98s |
| 10-sec remote 4K | $0.013 / 45.28s | $0.014 / 53.09s |

Two things jump out: **embedding video multiplies cost ~17×**, and **4K for 10 seconds costs about
as much as HD for 10 minutes** — resolution dominates. Excludes S3 egress, storage, CloudWatch, and licensing.

⚠️ **Quota trap:** default is 1000 concurrent executions/region/account, but **new accounts can be
as low as 10** — and one render can use 200. Increase via `npx remotion lambda quotas increase`
(**AWS root accounts only**, not org sub-accounts).

**Scaling past the ceiling** — from the GitHub Unwrapped architecture, the best-documented
production example:
- Renders sharded **across multiple AWS regions and sub-accounts** with rotating credentials
- A **MongoDB lock taken before every render** so duplicate requests can't both render
- Aggressive caching of rendered videos and API responses

### Other targets

- **Vercel Sandbox** — easiest, especially for Vercel customers
- **Docker** — `/docs/docker`
- **Google Cloud Run** — ⚠️ explicitly **Alpha, not actively developed**. Don't build on it today.
- **Client-side rendering** (`@remotion/web-renderer`, stable 4.0.491) — entirely in-browser via
  WebCodecs, no server. Chrome 94+/Firefox 130+/Safari 26+. Limited CSS subset.

```tsx
import {renderMediaOnWeb} from '@remotion/web-renderer';
const {getBlob} = await renderMediaOnWeb({composition: {...}, inputProps: {}});
```

### CI

```yaml
- run: npm i
- run: echo $WORKFLOW_INPUT > input-props.json
  env: {WORKFLOW_INPUT: '${{ toJson(github.event.inputs) }}'}
- run: npx remotion render MyComp out/video.mp4 --props="./input-props.json"
- uses: actions/upload-artifact@v4
  with: {name: out.mp4, path: out/video.mp4}
```

---

## 10. Performance

### Set expectations honestly

⚠️ Real numbers from open GitHub issues, not marketing:

- **~2–4× realtime** for video with animated JS over the whole duration ([#4783](https://github.com/remotion-dev/remotion/issues/4783))
- **Vertical scaling barely works**: 16 vCPUs → 224 vCPUs (14× compute) bought ~**40% speedup** ([#4949](https://github.com/remotion-dev/remotion/issues/4949))
- **Linux/Docker core-utilisation pathology**: on a 48-core VPS *"most of the cores are sitting idle"* while the same code saturated 8 cores on a MacBook Air ([#4300](https://github.com/remotion-dev/remotion/issues/4300))
- **Chrome mode swing**: chrome-headless-shell 7.1 min vs Chrome for Testing 21.5 min for the same job ([#4955](https://github.com/remotion-dev/remotion/issues/4955))
- **Long source video degrades nonlinearly** — *"after about 20%-30%... it grinds to a crawl"* (cache pruning) ([#3070](https://github.com/orgs/remotion-dev/discussions/3070))
- **Memory leaks** in long-running render workers are a documented failure mode

**Short motion-graphics clips (10–60s, no heavy video) are fine.** Long-video compositing is the
weak spot. You must fan out horizontally, not scale up.

### Pitfalls ranked by real impact

1. **Wrong video tag.** `<Html5Video>` and `<OffthreadVideo>` are "not optimized". Migrating to `@remotion/media` is the biggest single win.
2. **GPU-dependent effects on GPU-less cloud instances.** `box-shadow`, `text-shadow`, CSS gradients, `filter: blur()`, `filter: drop-shadow()`, WebGL, 2D canvas — all hit the GPU. **Lambda has none.** Precompute as images. *This is the most common silent killer.*
3. **Wrong concurrency.** Both too high and too low hurt. Use `npx remotion benchmark`.
4. **Resolution** — superlinear cost. Consider rendering smaller and `--scale`-ing.
5. **Codec** — VP8/VP9 encode very slowly. PNG frames slower than JPEG.
6. **Slow JS in components** — profile with `--log=verbose`, memoize. First frames per thread are legitimately slow (init).
7. **Data fetching per frame** — every tab refetches. Cache, or move into `calculateMetadata()`.
8. **Huge `defaultProps`** — explicitly called out as slow.
9. **Black frames when a heavy Sequence appears** — fix with `premountFor` (automatic in v5).
10. **Transparent WebM on Lambda** — chunk boundaries visible in alpha. Increase `framesPerLambda`.

---

## 11. The rules LLMs break

✅ Verified from the official skill files. This table is the highest-value part of this document if
you're generating Remotion code with an LLM.

| Mistake | Rule |
|---|---|
| CSS transitions/animations, `@keyframes` | **FORBIDDEN** — will not render correctly |
| Tailwind animation classes (`animate-pulse`) | **FORBIDDEN** |
| `Date.now()`, `setTimeout`, `requestAnimationFrame`, `Math.random()` | Every visual value must be a pure function of `useCurrentFrame()`. Frames render independently and out of order. Use Remotion's seeded `random()`. |
| `useState` for animation | Re-renders every frame → loops/nondeterminism |
| Unclamped `interpolate` | Defaults are **not** clamped — set `extrapolateLeft/Right: 'clamp'` |
| `transform: \`scale(${s})\`` template strings | Prefer individual CSS props `scale`/`translate`/`rotate`; keep the `interpolate()` call **inline in `style`** so Studio can keyframe-edit it. Use `transform` strings only for `skew()`, `perspective()`, order-sensitive chains |
| Composed easing (`Easing.inOut(Easing.cubic)`) | Use explicit `Easing.bezier(x1,y1,x2,y2)` — stays Studio-editable |
| Reaching for `spring()` by default | Prefer `interpolate()` unless physics is explicitly wanted |
| `<Sequence>` timing | `from` is **absolute** frames; default is absolute-fill — need `layout="none"` for inline content |
| Scale animations | Use `output: 'perceptual-scale'` |
| Ad-hoc `npm install` | `npx remotion add <pkg>` keeps all `remotion`/`@remotion/*` versions aligned |
| Assets | `public/` + `staticFile()`; media via `@remotion/media` |
| CSS `background-image` | Doesn't block loading → flicker. Use `<Img>`. |

⚠️ Community-reported, lower confidence: default font sizes too small for vertical/mobile (~28–32px
→ use ~38–40px); missing `from` offsets causing every animation to fire at frame 0 simultaneously.

**Also note:** newer APIs like `Interactive.Div` (Studio write-back editing) postdate most models'
training data. An unskilled model won't produce them.

---

## 12. Version notes and v5

**Current: 4.0.500** (2026-07-27). On the `4.0.x` line since 2023-07-03, ~101 patch releases in 2026
alone. 1236 published versions total.

### The 2026 themes

**A. The Mediabunny pivot.** Remotion adopted [Mediabunny](https://mediabunny.dev) as its media
backbone (sponsored at $1000/month). `@remotion/media` is now the default; `@remotion/media-parser`
and `@remotion/webcodecs` are **being phased out — no 5.x versions will be published**.

**B. Client-side rendering** stable in 4.0.491.

**C. Studio Interactivity** (4.0.475+) — visual edits that **write back into your source code**,
undoable with ⌘Z. Drag outlines to update `style.translate`; timeline keyframes for CSS props;
selectable easing segments.

**D. `@remotion/effects`** (4.0.464+) — ~70 canvas/WebGL effects via an `effects` prop array:
`blur`, `colorKey`, `pixelate`, `zoomBlur`, `halftone`, `lightLeak`, `starburst`, `venetianBlinds`,
`liquidContours`, and more. `createEffect()` for custom ones.

### v5 breaking changes (documented, not yet released)

- **Four packages stop being published:** `@remotion/light-leaks` → `lightLeak()`; `@remotion/starburst` → `starburst()`; `@remotion/media-parser` and `@remotion/webcodecs` → Mediabunny
- `inputProps` **required** in `selectComposition()` / `getCompositions()`
- **Sequences auto-premount for 1 second** — kills the black-frame-on-scene-entry bug. Opt out with `premountFor={0}`
- Media/images **pause playback while loading** by default
- `colorSpace` default `"default"` (≈bt601) → **`"bt709"`**
- Lambda `diskSizeInMb` 2048 → **10240**; `overwrite` defaults `true`; APIs move to `@remotion/lambda/client`. ⚠️ **If your function name is hardcoded with `disk2048mb`, use `speculateFunctionName()`**
- `@remotion/google-fonts` requires explicit `weights` and `subsets`
- `TransitionSeries` drops `layout="none"`
- Cloud Run `maxInstances` 100 → 5
- **Updated licence** — contractors count toward team size

---

## 13. Capturing real app footage

For the hybrid approach (record the real app, wrap it in Remotion), Playwright is the best
scripted-capture tool as of 2026.

### ⭐ `page.screencast` — Playwright ≥ 1.59

✅ **Verified present in Playwright 1.62.0** by local test.

This is a **purpose-built demo-video API** with animated cursor, chapter cards, and HTML overlays.
It did not exist a year ago and it changes the calculus considerably.

```js
await page.screencast.start({path: 'demo.webm', size: {width: 1280, height: 720}});
await page.screencast.showActions({position: 'top-right', cursor: 'pointer', duration: 700});

await page.screencast.showChapter('Adding items', {
  description: 'Type and press enter for each',
  duration: 1500,
});

await page.locator('#field').fill('SAVE20');
await page.locator('#apply').click();

await page.screencast.stop();
```

- `showActions({cursor: 'pointer'})` renders a pointer that **animates between action points** — this obsoletes ghost-cursor for most demo purposes
- `showChapter(title, {description, duration})` — centred overlay with blurred backdrop
- `showOverlay(html, {duration})` — arbitrary HTML overlay

Or declaratively:

```ts
export default defineConfig({
  use: {
    video: {
      mode: 'on',
      size: {width: 1280, height: 720},
      show: {
        actions: {duration: 500, position: 'top-right', fontSize: 14, cursor: 'pointer'},
        test:    {level: 'step', position: 'top-left', fontSize: 12},
      },
    },
  },
});
```

### `recordVideo` — the format facts

✅ Verified from `videoRecorder.ts`:

| Property | Value |
|---|---|
| Container / codec | **WebM / VP8** (`.webm` enforced by a hard throw) |
| Frame rate | **25 fps constant** — hard-coded, not configurable |
| Quality | `-b:v 1M -crf 8 -qmin 0 -qmax 50 -deadline realtime -speed 8` |
| Audio | **None, ever** (`-an`) |
| Source frames | JPEG quality 90 — lossy *before* VP8 |
| ffmpeg | Bundled; no system install needed |

⚠️ **Video is only finalized on `context.close()`.** This is mandatory.
`page.video().path()` throws when connected remotely — use `video.saveAs()` there.

### ⚠️ The `deviceScaleFactor` trap — and the fix

✅ **Tested locally.** This is the single most valuable finding in this section.

**`deviceScaleFactor` does NOT increase Playwright video resolution.** Playwright computes screencast
size from `viewport` (CSS px) only; it passes that to CDP as `maxWidth`/`maxHeight`, and Chromium's
`DetermineSnapshotSize()` starts `scale = 1` and only ever **shrinks**. Meanwhile the compositor
surface uses the *screen's* DSF, not the emulated one.

**Declaring `recordVideo.size` larger than your real surface produces gray padding**, because the
ffmpeg filter is `pad=W:H:0:0:gray` — never `scale`. I reproduced this exactly: a 1280×720 viewport
declared as 2560×1440 gave the real image in the top-left with **gray filling the right and bottom**.

**The fix — `--force-device-scale-factor=2`.** ✅ Verified working: content fills the full
2560×1440 frame with crisp 2× text, no padding.

```js
const browser = await chromium.launch({
  channel: 'chromium',                       // new headless = real Chrome renderer
  args: ['--force-device-scale-factor=2'],   // REAL 2x pixels
  slowMo: 150,
});
const context = await browser.newContext({
  viewport: {width: 1280, height: 720},              // UI renders at normal size
  recordVideo: {dir: 'videos/', size: {width: 2560, height: 1440}},  // must be viewport × 2
});
```

**Alternative if the flag is unavailable:** big CSS viewport + zoom.

```js
viewport: {width: 3840, height: 2160},
recordVideo: {size: {width: 3840, height: 2160}},
// then: await page.addStyleTag({content: ':root { zoom: 2; }'});
```
Downside: media queries see 3840px, so responsive layouts break.

### Screenshot-per-frame — guaranteed retina, fully deterministic

`page.screenshot()` uses a *different* capture path and **defaults to `scale: 'device'`**, so
`deviceScaleFactor: 2` genuinely yields 2× PNGs here.

```js
const context = await browser.newContext({
  viewport: {width: 1280, height: 720},
  deviceScaleFactor: 2,
});
for (let i = 0; i < frames; i++) {
  await page.screenshot({
    path: `frames/f${String(i).padStart(5,'0')}.png`,
    animations: 'disabled',
    scale: 'device',
  });
  await advanceOneFrame();
}
```
```bash
ffmpeg -framerate 60 -i frames/f%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow demo.mp4
```

Useful `screenshot()` options: `animations: 'disabled'` (fast-forwards finite, cancels infinite),
`caret: 'hide'` (default), `style` (stylesheet applied only for the shot — pierces Shadow DOM),
`mask` (black out unstable regions).

### Headless vs headed

Video recording works identically headless — it's CDP, no display needed. What matters is *which
binary*:

- **Default `headless: true`** → the stripped-down **headless shell**
- **`channel: 'chromium'`** → **new headless mode**, the real Chrome browser. *"more authentic, reliable, and offers more features"* — **prefer this for demos** (font rendering/rasterisation can differ in the shell)
- **`channel: 'chrome'`** → branded system Chrome

Headed adds nothing for quality — the screencast captures the **page surface only**, never OS window
chrome, tabs, or the URL bar. **If you want browser chrome in your demo, composite it in post.**

### Determinism

```js
// Fixed clock — use setFixedTime, NOT install
await page.clock.setFixedTime(new Date('2026-01-15T09:00:00'));
```

⚠️ **`clock.install()` overrides `requestAnimationFrame`.** If you pause the clock, rAF-driven
animations freeze and your video stalls. For demos use `setFixedTime` — *"the time flows naturally,
but `Date.now` always returns a fixed value."*

```js
// Network — record once, replay forever
await page.routeFromHAR('./demo.har', {url: '*/**/api/**', update: true});   // record
await page.routeFromHAR('./demo.har', {url: '*/**/api/**', update: false});  // replay

// Seeded randomness
await page.addInitScript(() => {
  let s = 42;
  Math.random = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
});
```

Also pin: `viewport` (**never `null`** — makes execution nondeterministic), `locale`, `timezoneId`,
`colorScheme`.

For a *demo* you usually want animations to keep running — just deterministically. Prefer HAR replay
+ `setFixedTime` + fixed viewport over killing CSS animations.

### Alternatives

| Tool | When |
|---|---|
| **Puppeteer `page.screencast()`** | Sharper defaults — sends **no `maxWidth`/`maxHeight`**, so it captures at full native resolution in lossless PNG, vs Playwright's capped JPEG q90. VP9, 30fps default. Needs system ffmpeg. No annotation features. |
| **`puppeteer-capture`** | Frame-perfect determinism via `HeadlessExperimental.beginFrame` — renders one frame on demand. Linux + Windows only, experimental CDP domain. |
| **`puppeteer-screen-recorder`** | When you specifically need MP4/H.264 from Puppeteer |
| **`playwright-video`** | ❌ **Dead** (last publish 2022). Superseded by built-in `recordVideo`. |
| **Playwright `codegen`** | `npx playwright codegen <url>` — record clicks into a script, then hand-tune. The natural authoring front-end. |

⚠️ **Tracing is not a video source.** `context.tracing` screencast is throttled to **~5 fps**
(`throttledRate = 200`), inherits the ≤800px cap, stores individual JPEGs in a zip, and has **no
video export path**. It's a debugging tool.

### Cursor rendering — a subtle but important choice

There's a real argument for capturing **without** a cursor and drawing it in post:

> "The synthetic cursor rendered during capture is fine for *preview*, but the *final video* needs
> its cursor rendered [in the compositor] so it can be composited after the virtual camera applies
> its zoom. Otherwise: as the camera zooms in, an in-capture cursor grows proportionally and becomes
> huge and pixelated."

If you're scripting the run you already know exact click coordinates and timings — so you can render
a crisp, correctly-sized cursor as a Remotion layer that stays sharp through zooms.

### Human-like cursor movement (if not using `showActions`)

Playwright's `mouse.move(x, y, {steps})` interpolates **linearly** — constant velocity, reads
robotic. Use ~25–60 steps and add easing, or borrow ghost-cursor's framework-agnostic `path()`:

```js
import {path} from 'ghost-cursor';   // Puppeteer-only API, but path() is standalone

const route = path({x: 100, y: 100}, {x: 600, y: 700}, {useTimestamps: true});
let prev = route[0].timestamp;
for (const p of route) {
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(Math.max(0, p.timestamp - prev));
  prev = p.timestamp;
}
```

**Anti-robotic checklist:** vary delays ±30%; pause 400–800ms *after* a result appears; scroll in
eased increments; use `pressSequentially(text, {delay: 90})` not `fill()` for text you want read;
`slowMo: 100–300` is a blunt but effective global pacing control (raise your timeouts to match).

---

## 14. FFmpeg recipes

### Web delivery — the main command

```bash
ffmpeg -i master.mkv \
  -c:v libx264 -preset slow -tune stillimage -crf 18 \
  -profile:v high -level:v 4.2 \
  -pix_fmt yuv420p \
  -x264-params "bf=3:ref=4:aq-mode=1:keyint=120:min-keyint=60" \
  -c:a aac -b:a 160k -ac 2 \
  -movflags +faststart \
  demo.mp4
```

**Why each flag:**
- `-crf 18` visually lossless; **16** for UI text if size allows; 20–23 for long screencasts
- `-tune stillimage` — ✅ verified from x264 source: `deblock -3:-3`, `psy-rd 2.0`, `psy-trellis 0.7`, `aq-strength 1.2`. Weakest deblocking of any tune = preserves hard glyph edges.
- `-pix_fmt yuv420p` — **mandatory** for browser/QuickTime. yuv444p won't play in Safari.
- `-movflags +faststart` — moves the moov atom to the front so playback starts before full download. **Never ship a web MP4 without this.**
- `keyint=120:min-keyint=60` — 2-second GOP at 60fps, responsive scrubbing

### ⚠️ Three counterintuitive facts, all source-verified

1. **`-tune animation` is WRONG for screen text**, despite blog posts recommending it. It sets
   `deblock +1:+1` — *stronger* smoothing — plus `psy-rd 0.4`. It makes text softer than no tune.

2. **`tune=stillimage` is silently half-ignored at fast presets.** psy-rd needs `subme >= 6`,
   psy-trellis needs `trellis >= 1`. `veryfast` is `subme=2, trellis=0`. **Use `medium` or slower**
   or the psy half is discarded.

3. **Apple VideoToolbox `-q:v` is INVERTED** — a 0–100 scale where **higher = better**, opposite of
   `-crf`. Same in OBS's "CRF" slider for Apple VT (a live OBS bug, [#11830](https://github.com/obsproject/obs-studio/issues/11830)).
   Constant-quality also **requires Apple Silicon** — Intel Macs error out.

### Remux without re-encoding

```bash
ffmpeg -i recording.mkv -c copy -movflags +faststart recording.mp4
```

Instant, bit-exact. ⚠️ Fails on 4:4:4 masters (Safari/QuickTime won't play High 4:4:4 Predictive).
⚠️ VFR→MP4 can produce odd timing; add `-vsync cfr -r 60`.

### Downscale properly

```bash
# Lanczos — the standard
-vf "scale=1920:1080:flags=lanczos"

# Preserve aspect, force even dimensions (H.264 requires even)
-vf "scale=1920:-2:flags=lanczos"

# Sharper — accurate rounding + full chroma interpolation
-vf "scale=1920:1080:flags=lanczos+accurate_rnd+full_chroma_int"

# Gamma-correct (helps white-on-dark UI text)
-vf "scale=1920:1080:flags=lanczos:gamma=1"
```

**Best of all: don't scale.** Integer ratios (3840→1920) resample cleanly; 3024→1920 does not.
Consider targeting exact-half (3024→1512) instead of 1080p.

### Trim

```bash
# No re-encode — snaps to nearest keyframe
ffmpeg -ss 00:00:12 -to 00:00:47 -i demo.mp4 -c copy -movflags +faststart clip.mp4

# Frame-accurate
ffmpeg -ss 00:00:12 -i demo.mp4 -t 35 -c:v libx264 -preset slow -tune stillimage \
  -crf 18 -pix_fmt yuv420p -movflags +faststart clip.mp4
```

Put `-ss` **before** `-i` for fast, unambiguous source-timeline seeking. Prefer `-t DURATION` over
output-side `-to`.

### Speed, crop, fades, concat

```bash
# 2x speed (video only)
-filter:v "setpts=0.5*PTS" -an

# 2x with audio in sync (atempo limited to 0.5–2.0, chain for more)
-filter_complex "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]" -map "[v]" -map "[a]"

# Crop w:h:x:y (origin top-left)
-vf "crop=1600:1000:160:90"
-vf "crop=iw:ih-100:0:100"       # chop 100px off the top (menu bar)

# Fade in/out
-vf "fade=t=in:st=0:d=0.5,fade=t=out:st=29.5:d=0.5"

# Concat, no re-encode (identical codec/resolution/pix_fmt required)
ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart combined.mp4

# Crossfade
-filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=9.5[v]"
```

### PNG sequence → video

```bash
ffmpeg -framerate 60 -i frames/frame_%05d.png \
  -c:v libx264 -preset slow -tune stillimage -crf 16 \
  -profile:v high -pix_fmt yuv420p -movflags +faststart out.mp4
```

⚠️ `-framerate` goes **before** `-i` (input option). `-r` after `-i` resamples instead.
⚠️ Odd dimensions break yuv420p — pad rather than scale: `-vf "pad=ceil(iw/2)*2:ceil(ih/2)*2"`

### Capped CRF — best default for web deliverables

Quality-targeted with a bounded worst case:

```bash
-crf 20 -maxrate 4M -bufsize 8M
```

### Don't ship a GIF

A 256-colour palette destroys anti-aliased text, and a GIF is typically 5–10× the size of the
equivalent MP4. Use a muted autoplay loop:

```html
<video src="demo.mp4" autoplay loop muted playsinline poster="poster.png"></video>
```

### Verify what you produced

```bash
ffprobe -v error -show_entries stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,color_range,color_space \
  -of default=noprint_wrappers=1 demo.mp4
```

### OBS settings for razor-sharp UI capture

```
Output → Recording:  Hybrid MP4, x264, CRF 16, preset medium, tune stillimage
                     Profile: (None)   ← REQUIRED when using I444
Video:               Base = Output = native resolution (never downscale in OBS), 60 fps
Advanced → Video:    Color Format I444, Color Space Rec.709, Color Range Full (master)
```

⚠️ **Setting Profile = `high` while Color Format = I444 forces 4:2:0** — OBS has no `high444`
option in the dropdown. Leave Profile blank.

⚠️ **macOS Window Capture captures at 1×, not 2×** — it uses `window.frame.size` (points), while
Display/Application capture uses `CGDisplayModeGetPixelWidth()` (real pixels). Use Display or
Application capture and crop.

**"Blurry text" checklist, in order of likelihood:** Base ≠ Output → CBR instead of CRF → bitrate
too low → 4:2:0 chroma → source scaled in canvas → Windows display scaling at 125/150% → macOS
Window Capture → the player, not the file.

---

## 15. Demo video craft

### Structure (60–90s)

| Beat | Duration | Content |
|---|---|---|
| Hook | 0:00–0:05 | The outcome or the pain. **Never your logo.** |
| Problem | 0:05–0:20 | Agitate: wasted time, revenue leak, friction |
| Solution | 0:20–0:45 | The value prop before any feature |
| Walkthrough | 0:45–1:10 | 1–2 features that kill the problem from the hook |
| Proof | 1:10–1:20 | A metric, logo wall, or one-line testimonial |
| CTA | 1:20–1:30 | One link, one action |

60s version: Hook 3–5s → Context 5–10s → Demo 40s → CTA 5–10s.

### Numbers worth memorising

- Videos **under 1 minute average 50% engagement**; 3–5 min drops to 45%; the average viewer watches **47%** of any video — assume half never see the second half
- Deliver the "aha" within **30 seconds**, ideally 10. Show the product working in the **first 3 seconds** for autoplay contexts
- Something must change on screen every **3 seconds**; cut every **3–5s**
- **150 words per 60 seconds** of script (140–150 is the high-converting band; 180 is the ceiling)
- **Slow your demonstration ~30%** below natural speed
- **85% of Facebook video is watched without sound**; ~75% of people keep phones muted → the landing-page hero must work muted
- Captions: **max 42 chars/line, 2 lines, 17 chars/sec**; break at grammatical points
- Body text **40–60px minimum** on a 1920×1080 canvas; title-safe margin **5% every side**

### Aspect ratios

| Ratio | Pixels | Use |
|---|---|---|
| **16:9** | 1920×1080 | **Primary** — landing page, YouTube, embeds |
| **9:16** | 1080×1920 | TikTok, Reels, Shorts, Stories |
| **1:1** | 1080×1080 | Safest multi-platform; best for Product Hunt feed |
| **4:5** | 1080×1350 | Best-performing feed ratio on LinkedIn/FB/IG |

Don't letterbox 16:9 into 9:16 — **re-frame it**, recomputing zoom targets.

### Resolution and frame rate

- Record and master at **1920×1080 minimum**; 4K if you'll crop or punch in
- **60fps for screen recording** — UI scrolling and CSS animation judder visibly at 30. ⚠️ But a stable 30 beats a dropping 60.
- Talking-head or heavy motion-graphics segments are fine at 30

### Landing-page hero video

```html
<video autoplay muted loop playsinline poster="poster.png">
  <source src="demo.webm" type="video/webm">
  <source src="demo.mp4"  type="video/mp4">
</video>
```

- **All four attributes required.** Without `muted`, autoplay is blocked; without `playsinline`, iOS goes fullscreen
- **720p is enough.** Never 4K for autoplay.
- **Size budget: ≤4MB desktop, ≤2MB mobile.** A 10s 720p clip ≈ 3–4MB; the same at 4K exceeds 20MB
- **1,000–2,500 kbps**, 24–30fps for a background loop (the one case where 60fps isn't worth it)
- Ship **WebM first, MP4 fallback**; always set `poster`; `preload="none"` below the fold
- Aim for a seamless **6–12s loop**, not 60s

⚠️ **Accessibility:** WCAG **2.2.2 "Pause, Stop, Hide"** applies to anything moving >5 seconds — a
looping hero needs a **visible pause control**. And `prefers-reduced-motion` is **not** honored
automatically by video autoplay in any browser — you must implement it yourself.

### Motion design that reads as premium

**Durations:** desktop UI motion **150–200ms**; larger/mobile 300–400ms; **beyond 600ms stops
feeling responsive**. Video motion (zooms, scene moves) can run 400–800ms since the viewer is passive.

**Curves — the amateur tell is default `ease` and `linear`:**
- **Ease-out for anything arriving** — `cubic-bezier(0, 0.4, 0, 1)`
- **Ease-in for anything leaving**
- **Ease-in-out for moving within frame** — `cubic-bezier(0.4, 0, 0, 1)`
- **Overshoot sparingly** — `cubic-bezier(0.68, -0.55, 0.27, 1.55)`. One moment per video, max.

**The three techniques that do most of the work:**
1. **Cursor smoothing** — converts shaky motion to a glide. Highest-impact single effect.
2. **Cursor scaling 1.5–2×** — a 1× cursor is nearly invisible at 1080p
3. **Eased zooms, 1.25–2×, held 1.5–2.5s** — never linear; hold long enough to read

**Click emphasis:** a ripple expanding outward, or a ring that appears and fades.

**Transitions:** **hard cut ~99% of the time.** In a feature film with 10,000 transitions, ~9,990
are straight cuts. Cross dissolve 24–48 frames only for a genuine time/context jump. **Match cuts**
are the premium move between screens. **Banned:** star wipes, page curls, flares, preset packs.

**Device frames:** a minimal browser bar with a clean URL usually beats a full laptop render (which
wastes 30–40% of the frame). Add padding (8–12% of frame width), a subtle shadow, and a background.

### Capture prep checklist

- Fresh browser profile — no extensions, bookmarks bar, autofill, saved passwords
- **Seed realistic demo data.** Never "Test User 1", never lorem ipsum. Fake-but-plausible is a major perceived-quality signal.
- **Do Not Disturb on.** A Slack toast destroys a take.
- Hide the Dock, desktop icons, scrollbars; neutral clock
- Bump browser zoom to **110–133%** — real UIs are designed for a 27" monitor; video is watched on a laptop or phone
- Record the same flow **3–5 times** and cut the best take

### Amateur tells

1. Clicking at builder speed
2. The nervous cursor wandering the screen
3. No zoom — 13px UI text is unreadable on mobile
4. Holding a shot after the point has landed
5. Opening with your logo
6. Feature tour instead of one flow
7. Laptop-mic voiceover
8. Music not ducking under narration (duck **8–12 dB**)
9. Cheesy transitions
10. Visible notifications, personal data, 20 browser tabs

### Audio

- **-14 LUFS integrated**, true peak **-1 dBTP** — the standard for YouTube and most web/social
- VO around **-12 to -16 dBFS** peak; music bed under VO **-22 to -28 dBFS**
- Fade music in ~0.5–1s, out 1–2s. Hard music cuts at the end are a classic tell.
- **Generate/record VO first and cut picture to it** — never the reverse

⚠️ **Music licensing traps to check:** does it cover **paid ads** (not just organic)? **Web
embedding** (not just YouTube)? Is **attribution required** (Kevin MacLeod's catalogue is largely
CC-BY — needs a visible credit)? Does the right **survive cancellation**? Will it trigger
**Content ID** on your own uploads?

---

## 16. AI asset pipeline

### Which model does what

⚠️ **Important correction to a common assumption:** Claude models — including **Fable 5**
(`claude-fable-5`) — are **text + vision reasoning models. They do not generate video, images, or
audio.** Fable 5 is the tier above Opus 5 for long-horizon agentic work ($10/$50 vs $5/$25 per MTok).
The name signals strength at creative *writing*, not creative *media*.

**So the workflow is: a Claude model writes Remotion React code; Remotion renders it.** Opus 5 is
the right default — it's a coding task.

⚠️ Fable 5 API quirks if you wire it into a pipeline: thinking is always on (sending
`thinking: {type:"disabled"}` returns 400), `temperature`/`top_p`/`top_k` are removed (400),
assistant prefill unsupported, requires 30-day data retention, and safety classifiers can return
`stop_reason: "refusal"` — handle it before reading `content`.

### Captions

Canonical type: `Caption` from `@remotion/captions` — `{text, startMs, endMs, timestampMs, confidence}`.

```ts
// Local Whisper
import {installWhisperCpp, downloadWhisperModel, transcribe, toCaptions} from '@remotion/install-whisper-cpp';
// Audio must be 16 kHz WAV: ffmpeg -ar 16000
// transcribe({..., tokenLevelTimestamps: true})
// Write JSON to public/. Transcribe each clip separately.
```

Hosted alternatives: `@remotion/openai-whisper` → `openAiWhisperApiToCaptions()`,
`@remotion/elevenlabs` → `elevenLabsTranscriptToCaptions()`.

### Voiceover — and the key integration trick

ElevenLabs is the recommended default. Generate per-scene MP3s into
`public/voiceover/{compositionId}/`, then use **`calculateMetadata`** to measure each file's real
duration and set `durationInFrames` dynamically:

```tsx
export const calculateMetadataFn = async ({props}) => {
  const durations = await Promise.all(props.scenes.map(s => measureAudio(s.audioSrc)));
  const totalFrames = durations.reduce((a, d) => a + Math.round(d * fps), 0);
  return {durationInFrames: totalFrames, props: {...props, sceneDurations: durations}};
};
```

⚠️ If using `<TransitionSeries>`, subtract the overlap from the total.

### Notable templates and repos

- **`remotion-dev/template-prompt-to-video`** — official; CLI generates script + images + voiceover (OpenAI + ElevenLabs), emits `timeline.json`, Remotion renders
- **`DojoCodingLabs/remotion-superpowers`** — most complete Claude Code plugin. 5 MCP servers, 13 commands. Wires Suno (music), ElevenLabs (TTS/SFX), TwelveLabs (video analysis — including an AI review loop where the agent watches its own render), Pexels, Replicate/KIE (FLUX, Imagen, Veo, Kling), Whisper
- **`memex-lab/product-launch-video-skill`** — product brief + screenshots → storyboarded launch video
- **`Vincentwei1021/video-shotcraft`** — 106 shot recipe cards, 161 motion previews, 2.5D camera moves
- **`itsjwill/vanta`** — open-source AI video engine on Remotion
- **`stephengpope/remotion-media-mcp`** — MCP server generating images/video/music/SFX for Remotion

---

## 17. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **Flickering** | CSS animations, `Date.now()`, `Math.random()`, unloaded assets. Every value must derive from `useCurrentFrame()`. Use `<Img>`/`@remotion/media` (they call `delayRender()` internally), never CSS `background-image`. |
| **Black frames when a scene starts** | Heavy content mounting. Use `premountFor`. Automatic in v5. |
| **Render hangs / times out** | An unresolved `delayRender()` handle. Raise `--timeout`, check every `delayRender()` has a matching `continueRender()` including in `.catch()`. |
| **Works locally, slow in cloud** | GPU-dependent CSS (shadows, gradients, blur) on a GPU-less instance. Precompute as images. |
| **Cores idle on a big Linux box** | Known scaling pathology (#4300). Benchmark; don't assume more vCPUs help. |
| **Grinds to a crawl partway through** | Cache pruning with long source video (#3070). Shorten clips. |
| **Playwright video is blurry** | Default caps screencast to ≤800px. Set `recordVideo.size` **and** `--force-device-scale-factor`. |
| **Playwright video has gray bars** | `recordVideo.size` larger than the real surface. The filter is `pad`, never `scale`. ✅ Reproduced and confirmed. |
| **Playwright video is empty/missing** | You didn't `await context.close()`. Video is only finalized on close. |
| **No audio in Playwright capture** | Playwright **can never record audio** (`-an`, hard-coded). |
| **Lambda "Too many functions"** | Concurrency > 200. Set `framesPerLambda: null`. |
| **Lambda fails on a new AWS account** | Default quota can be as low as 10. Request an increase (root account only). |
| **Function name not found after upgrade** | Function is version-pinned; redeploy. Use `speculateFunctionName()` rather than hardcoding `disk2048mb`. |
| **Chromium download takes ~6 minutes on install** | Normal. One repo logged `Got Headless Shell ━━━ 358999ms`. Not hung. |
| **Safari won't play the file** | 4:4:4 or missing `-tag:v hvc1` for HEVC. Use `-pix_fmt yuv420p` for universal H.264. |
| **Video doesn't start until fully downloaded** | Missing `-movflags +faststart`. |

---

## Quick reference card

```bash
# Setup
npx skills add remotion-dev/skills
npx create-video --yes --blank my-video
npm start

# Render
npx remotion render MyComp out/video.mp4 --log=verbose
npx remotion benchmark

# Capture a web app at real 2x
node capture.js   # chromium --force-device-scale-factor=2
                  # viewport 1280x720, recordVideo.size 2560x1440
                  # channel: 'chromium', await context.close()

# Encode for the web
ffmpeg -i master.webm -c:v libx264 -preset slow -tune stillimage -crf 18 \
  -profile:v high -level:v 4.2 -pix_fmt yuv420p \
  -c:a aac -b:a 160k -movflags +faststart demo.mp4
```

**The five things that matter most:**
1. Install the agent skills before generating any Remotion code
2. Everything derives from `useCurrentFrame()` — no CSS animation, no wall-clock, no randomness
3. Always clamp `interpolate()`
4. Free licence stops at 3 employees; trigger is headcount, not revenue; contractors count in v5
5. Record real UIs; use Remotion for the wrapper

---

*Sources: Remotion docs source (`remotion-dev/remotion@main`), `LICENSE.md`, official agent skills,
Playwright 1.62.0 types and `videoRecorder.ts`, Chromium `page_handler.cc`/`render_widget_host_view_base.cc`,
x264 `common/base.c`, OBS `SimpleOutput.cpp`/`obs-x264.c`/`mac-videotoolbox/encoder.c`, FFmpeg
`filters.texi`/`videotoolboxenc.c`, npm registry, and Remotion GitHub issues #3070, #4300, #4783,
#4949, #4955, #9653. Playwright DSF behaviour and the gray-padding failure mode were verified by
local test.*
