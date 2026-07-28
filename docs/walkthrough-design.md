# The first-run walkthrough

The contract for `js/tour.js`. Written before the code, like the other design docs
here, so the client and its test are built against the same thing.

## The problem it solves

Someone arriving for the first time sees a configuration screen and a Start button.
Nothing on that screen says the run will be analysed afterwards, that there is a
daily puzzle everyone plays, that duels and leagues exist, or that any of it is
free. The features that make this different from Zetamac are all *behind* a run
they have not done yet.

## Why it is built last

A walkthrough is a description of the product. Every feature added before it is
written is a feature the tour has to be rewritten for, so it is the last thing built
and the first thing to go stale. Two consequences baked into the design:

- The step list lives in **one array** at the top of `js/tour.js`. Adding a feature
  means adding one object there, not editing markup.
- A test asserts the tour's step count matches that array, so a feature added
  without a step is a decision someone made, not a thing that quietly happened.

## Decisions

**A modal, not a strip.** It interrupts, and that is the point: the alternative is a
banner that a first-time visitor's eye slides past on the way to the Start button,
which is the same as not building it. It is small, escapable five ways — Esc, the
close button, Skip, clicking the backdrop, and finishing it — and shown once.

**`localStorage`, not a profile column.** Most first-time visitors have no account —
that is what "first-time" means — so a profile column would miss exactly the people
the tour is for. The cost is that it reappears on a second device, which is a mild
annoyance rather than a defect. Key: `zt_tour_seen`, value the version string it was
dismissed at.

**Versioned, by exact match.** The value stored is `TOUR_VERSION`, not `true`, and
the check is equality — anything that is not the current version means show, which
covers a bump, a downgrade and a junk value alike without needing a version ordering
that nothing here defines. Bump it when the tour changes materially, never for a typo
fix: a tour that reappears for no reason trains people to dismiss it unread.

**Home page only, and not even all of it.** `index.html` — but not
`index.html?key=…`, which is a shared configuration link. Someone landing on
`/duel.html?d=…` came for a specific duel and someone following a config link came to
play that config; a product tour in front of either is an obstacle. The tour is
offered again from a quiet "How this works" link in the footer, so dismissing it is
never permanent.

**It never blocks a returning player.** If `localStorage` says seen, nothing renders
at all — no flash, no layout shift. The check runs before the first paint of the
tour element, not after.

**It points at things.** A description of a feature that never shows you where the
feature is leaves the reader to go hunting afterwards, which most of them will not
do. Each step therefore spotlights the control it is describing. See *The spotlight*
below for the rules, which are mostly rules about giving up gracefully.

## The steps

Ordered by what is most different from the thing they already know, not by what is
biggest. Six, because a seventh is where people start clicking Skip.

1. **You get told why.** Every question is timed, so a finished run gives a graph of
   your pace, a per-question breakdown, and the specific technique that would have
   saved the time — `84 ÷ 7` → `70 ÷ 7 = 10`, `14 ÷ 7 = 2`, `= 12`.
2. **Practice what you are bad at.** Practice mode weights your weakest question
   types higher, so drilling goes where the time is actually lost.
3. **Zetamac Daily.** One puzzle a day, the same questions for everyone, one
   attempt. Nobody can claim they got easier problems.
4. **Duels.** Send a link. You both answer the same sequence, neither sees a score
   until both are done, and it ends on a graph of both paces. No account needed to
   accept one.
5. **Private leagues.** An invite code and a board over the day's puzzle. Being 3rd
   of 6 behind people you know beats being 4,000th behind strangers.
6. **A profile worth sharing.** `/@you`, a per-operation breakdown, a percentile, and
   a share card rendered in whichever theme you use. Private until you say otherwise.

The last step's primary action is **Start playing**, which dismisses. Not "Sign up" —
the tour's job is to get somebody to their first run.

Each step names the element it is about, as a CSS selector on its entry in
`TOUR_STEPS`:

| Step | Target | Selector |
|---|---|---|
| 1 It tells you why | the Start button | `#start-btn` |
| 2 Practise what you are worst at | the Practice button | `a[href="practice.html"]` |
| 3 Zetamac Daily | the Daily button | `a[href="daily.html"]` |
| 4 Duels | the Duel nav link | `#top-bar a[href="duel.html"]` |
| 5 Private leagues | the Leagues nav link | `#top-bar a[href="leagues.html"]` |
| 6 A profile worth sharing | the Dashboard nav link | `#top-bar a[href="dashboard.html"]` |

Existing markup, deliberately: no ids were added to `index.html` for this. Steps 4-6
are qualified with `#top-bar` because the same hrefs also appear elsewhere on the
page. `target` is optional — see below.

## The spotlight

Everything except the step's target is darkened, the target is outlined, and the
panel moves next to it with a caret pointing at it.

**The darkness is a shadow, not a background.** `#tour-hole` is one absolutely
positioned element sized to the target's bounding rect plus `TOUR_HOLE_PAD` on every
side, carrying `box-shadow: 0 0 0 9999px var(--c-scrim-dark)`. The hole is therefore
genuinely transparent rather than a lighter patch of scrim, and the overlay drops its
own flat background (`.tour-overlay--spot`) while a hole is lit so the two cannot
stack. The outline is `--c-accent`, which is what makes the eye land on the hole
rather than merely on the bright rectangle.

**The hole is not clickable.** `pointer-events: none`, so a click over the lit
element passes through to the overlay and dismisses the tour exactly as a backdrop
click always has. The tour is a description, not an interactive product tour, and a
highlighted button that half-works is worse than no highlight.

**Placement: below, then above, then right, then left.** Below first because a panel
under the thing it describes reads in the same direction as the caret. Each candidate
must leave `TOUR_EDGE` between the panel and the viewport edge; the chosen one is
then clamped into the viewport, so the panel is never clipped.

**The caret is dropped rather than made to lie.** It is only drawn if, after
clamping, the panel edge it sits on actually spans the target's centre. If no
placement fits at all, the panel returns to the centred layout and the hole stays
lit — on a short viewport that is the honest answer, and it is still better than the
old flat scrim because the thing being described is the only lit part of the page.

**Falling back is a first-class outcome.** A step renders exactly as it did before
spotlighting existed — centred panel, flat scrim, no hole, no caret — when:

- it has no `target` at all (the data model allows this),
- the selector does not resolve within `TOUR_RESOLVE_MS`,
- the element is `display:none`, `visibility:hidden` or zero-sized, or
- the element's **centre** is outside the viewport. This is not hypothetical: the
  header is a single non-wrapping row, so on a narrow viewport in the wider theme its
  left-most link is pushed off the left edge with no scroll container to bring it
  back.

Never a hole around nothing, and never a caret pointing at nothing.

**Measurement is the part that breaks.** Three rules, each of which has a matching
assertion in the test:

- The target is scrolled into view *before* it is measured, or the hole is sized from
  where the element was rather than where it will be.
- Measurement happens after two `requestAnimationFrame`s, so the scroll and any
  reflow it caused have settled.
- The nav is built by `js/auth.js` after a session lookup, so on a cold load steps 4-6
  have no target at the instant the tour opens. `tourResolve()` retries for
  `TOUR_RESOLVE_MS` and then gives up. A resolve that lands after the reader has
  already pressed Next is discarded by a token, or the hole would jump onto the
  previous step's target.

`resize` and `scroll` (captured, so a scrolling container counts) recompute
everything, throttled to one re-layout per frame. There is no incremental state: the
layout is derived from the live rect every time, which is what makes the two event
handlers a single re-call.

## Behaviour

- Opens on first load of `index.html`, after the page's own scripts have run.
- Next / Back, a step counter, and Skip. Left and Right arrows move between steps.
- Esc, the close button, Skip, the backdrop, and finishing all mark it seen. There is
  no way to close it that does not.
- Dismissing while on step 3 still marks it seen. A tour you half-read is a tour you
  chose to stop reading.

## Constraints it must respect

- **No build step.** A classic `<script>` tag, one global scope. Every top-level name
  prefixed `tour`/`TOUR`; a duplicate top-level `const` anywhere is a SyntaxError
  that blanks the page.
- Every colour from a `--c-*` token, added to **both** theme blocks.
- `escapeHtml()` on anything user-controlled. The tour's copy is static, so the real
  rule here is: it stays static. No interpolating a username into it later without
  escaping.
- Focus moves into the dialog on open and returns to whatever had it on close.
  `role="dialog"`, `aria-modal="true"`, labelled by its heading.
- It must not appear on any page other than `index.html`, and must not delay first
  paint of the game itself.

## The DOM contract

Pinned here so the implementation and its test can be built against the same thing,
the way every other design doc in this folder pins a shape.

| id | what it is |
|---|---|
| `tour-overlay` | the backdrop; its presence in the DOM *is* "the tour is showing". Carries `.tour-overlay--spot` while a hole is lit |
| `.tour-modal` | the panel. `role="dialog"`, `aria-modal="true"`, `aria-labelledby="tour-heading"`. Carries `.tour-modal--anchored` when placed next to a target rather than centred. A class, not an id — the only part of this table that is |
| `tour-heading` | the current step's title |
| `tour-body` | the current step's copy |
| `tour-dots` | one element per step, the current one marked |
| `tour-counter` | the counter, rendered `n / total` |
| `tour-back` / `tour-next` | step controls; `tour-next` reads "Start playing" on the last step |
| `tour-skip` / `tour-close` | the two explicit dismissals |
| `tour-link` | the footer "How this works" link, present on every load |
| `tour-hole` | the spotlight. **Present only for a step with a live, on-screen target**, and absent from the DOM otherwise — its presence is the assertion that a hole was drawn |
| `tour-caret` | the panel's pointer, a child of the panel. **Present only when it points at a hole**, with `.tour-caret--up` / `--down` / `--left` / `--right` for which way |

`localStorage['zt_tour_seen']` holds the exact `TOUR_VERSION` string and nothing else.

The tuning constants are top-level in `js/tour.js` and the test reads them from the
page rather than copying them: `TOUR_HOLE_PAD` (breathing room around the target),
`TOUR_GAP` (hole to panel), `TOUR_EDGE` (panel to viewport edge), `TOUR_RESOLVE_MS`.

The tour's `z-index` sits above the log-in modal's, which is on the same page.

## The test

`test/browser/tour.mjs`:

1. Appears on a first visit to `index.html`, with step 1 showing.
2. **Does not appear on the second visit** — the assertion the whole feature turns
   on, driven by a persisted `localStorage`, not by a page variable.
3. Each of the five dismissal routes marks it seen and, on reload, stays gone.
4. Next / Back walk the steps, the counter matches, and the step count equals the
   length of the step array.
5. It does not appear on `dashboard.html`, `daily.html`, `duel.html`, `leagues.html`
   or `practice.html`, nor on `index.html?key=…`.
6. The footer link re-opens it after it has been dismissed.
7. A stored value that is not the current `TOUR_VERSION` shows it again.
8. No uncaught page errors, in both themes.
9. For every step with a target, `#tour-hole`'s rect equals that target's rect —
   both read out of the live DOM and compared to each other, never to a number
   copied from the CSS. Pressing Next moves the hole onto the *next* target, which
   is a separate assertion because a hole that never updated would satisfy the first
   one on step 1 and fail silently from then on. The hole is `pointer-events: none`
   and a click on the lit element still dismisses.
10. A step with no `target` renders centred with **no hole element at all**.
11. A target that cannot be resolved — forced by deleting the element before
    opening — falls back to centred, with no hole and **no caret**, and does not
    break the spotlight on the next step.
12. The panel is fully inside the viewport on every step, at 1100×900 and at
    390×844. No step ever has a caret without a hole.
13. After a resize the hole still matches its target *and has moved*, and after a
    genuine page scroll it still matches. The scroll test asserts `scrollY > 0`
    first: at a viewport tall enough to fit this page, `scrollBy()` is a no-op and
    the assertion would prove nothing.

Run it with `python3 -m http.server`, never `npx serve` — serve's clean-URLs default
strips the query string that section 5 depends on.
