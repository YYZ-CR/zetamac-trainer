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

**Current version: `'2'`.** `'1'` was the original six steps. `'2'` added the welcome
step at the front and the closing line on the last step — both of them things a `'1'`
dismisser has not read, which is exactly what the constant is for.

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
biggest. **Seven**: a welcome, then the six features. Seven is the ceiling — an
eighth is where people start clicking Skip.

1. **Welcome.** What this is, in one sentence, and then the two facts that come
   before any feature matters: **playing needs no account** (press Start and go;
   practice mode and accepting a duel work signed out too), and signing in is what
   saves your run history, puts you on the daily and league boards and gives you a
   profile page. Ends by pointing at Next.
2. **You get told why.** Every question is timed, so a finished run gives a graph of
   your pace, a per-question breakdown, and the specific technique that would have
   saved the time — `84 ÷ 7` → `70 ÷ 7 = 10`, `14 ÷ 7 = 2`, `= 12`.
3. **Practice what you are bad at.** Practice mode weights your weakest question
   types higher, so drilling goes where the time is actually lost.
4. **Zetamac Daily.** One puzzle a day, the same questions for everyone, one
   attempt. Nobody can claim they got easier problems.
5. **Duels.** Send a link. You both answer the same sequence, neither sees a score
   until both are done, and it ends on a graph of both paces. No account needed to
   accept one.
6. **Private leagues.** An invite code and a board over the day's puzzle. Being 3rd
   of 6 behind people you know beats being 4,000th behind strangers.
7. **A profile worth sharing.** `/@you`, a per-operation breakdown, a percentile, and
   a share card rendered in whichever theme you use. Private until you say otherwise.
   Closes with a quieter line saying the tour reopens from **How this works** at the
   bottom of the home page, so closing it costs nothing.

**Why those two facts sit where they do.** The sign-in point is on the welcome step
because "do I have to sign up" is the question somebody asks before they read
anything else, and answering it costs two lines rather than a step of its own. The
"How this works" point is on the **last** step instead, because that is the moment
the tour is about to disappear behind *Start playing* — and a welcome whose third
paragraph explains how to get rid of the tour is a paragraph about the tour rather
than about the product. Neither got a step of its own: seven is already the ceiling.

The last step's primary action is **Start playing**, which dismisses. Not "Sign up" —
the tour's job is to get somebody to their first run.

Each step names the element it is about, as a CSS selector on its entry in
`TOUR_STEPS`:

| Step | Target | Selector |
|---|---|---|
| 1 Welcome | *none* — it is about the site, not a control | — |
| 2 It tells you why | the Start button | `#start-btn` |
| 3 Practice what you are worst at | the Practice button | `a[href="practice.html"]` |
| 4 Zetamac Daily | the Daily button | `a[href="daily.html"]` |
| 5 Duels | the Duel nav link | `#top-bar a[href="duel.html"]` |
| 6 Private leagues | the Leagues nav link | `#top-bar a[href="leagues.html"]` |
| 7 A profile worth sharing | the Dashboard nav link | `#top-bar a[href="dashboard.html"]` |

Existing markup, deliberately: no ids were added to `index.html` for this. Steps 5-7
are qualified with `#top-bar` because the same hrefs also appear elsewhere on the
page. `target` is optional, and step 1 is the case that exercises it: it renders
through the centred fallback below, which is the same path a step whose selector
never resolves takes.

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
- The nav is built by `js/auth.js` after a session lookup, so on a cold load steps 5-7
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
| `tour-link` | the footer "How this works" link, present on every load. It lives on `index.html` only, because `js/tour.js` does; the other pages carry the same footer minus that link, plus the two policy links |
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
   length of the step array **and that length is seven**. Both, deliberately: the
   first alone would pass for any number of steps.
5. It does not appear on `dashboard.html`, `daily.html`, `duel.html`, `leagues.html`,
   `practice.html`, `privacy.html` or `terms.html`, nor on `index.html?key=…`.
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
14. The **welcome step**: first, targetless, no hole, no caret, genuinely centred,
    and its copy says playing needs no account and what signing in is for — asserted
    on meaning, not on length. The "How this works" line is on the **last** step and
    not on this one, and both halves of that are asserted so the two cannot silently
    swap places. Screenshotted in both themes.
15. **The step → target mapping**, written out literally for all seven pairs. Both
    sides are named in the test rather than read out of `TOUR_STEPS`, because
    inserting a step at the front shifts every pair by one and a test that derives
    both sides from the same array cannot see that happen.
16. **The bump to `'2'`** brings the tour back for somebody storing `'1'`, lands them
    on the welcome step, overwrites `'1'` on dismissal, and does not return again.
17. **The footer's policy pages.** `index.html`'s footer links to `privacy.html` and
    `terms.html` with "How this works" still beside them; both pages are navigated to
    for real in both themes and must render their heading, the shared top bar, the
    theme's own `--c-page-bg` (not the browser default), real copy, and no uncaught
    page errors. Their own footers link home and across but never to themselves.
    A final block asserts the claims that have to be true of *this* site — no
    analytics, jsDelivr seeing an IP, millisecond timings, the `localStorage` keys by
    name, opt-in profiles, and a deletion section agreeing with
    `docs/account-deletion.md` on league succession and on which duels go — so a
    later rewrite towards boilerplate fails rather than passes.

Run it with `python3 -m http.server`, never `npx serve` — serve's clean-URLs default
strips the query string that section 5 depends on.
