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
which is the same as not building it. It is small, escapable four ways (Esc, the
close button, Skip, clicking the backdrop), and shown once.

**`localStorage`, not a profile column.** Most first-time visitors have no account —
that is what "first-time" means — so a profile column would miss exactly the people
the tour is for. The cost is that it reappears on a second device, which is a mild
annoyance rather than a defect. Key: `zt_tour_seen`, value the version string it was
dismissed at.

**Versioned.** The value stored is `TOUR_VERSION`, not `true`. When the tour changes
materially, bumping the constant shows it again to people who have seen the old one.
Not bumped for typo fixes — a tour that reappears for no reason trains people to
dismiss it unread.

**Home page only.** `index.html`. Someone landing on `/duel.html?d=…` came for a
specific duel; a product tour in front of it is an obstacle. The tour is offered
again from a quiet "How this works" link in the footer, so dismissing it is not
permanent.

**It never blocks a returning player.** If `localStorage` says seen, nothing renders
at all — no flash, no layout shift. The check runs before the first paint of the
tour element, not after.

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

## The test

`test/browser/tour.mjs`:

1. Appears on a first visit to `index.html`, with step 1 showing.
2. **Does not appear on the second visit** — the assertion the whole feature turns
   on, driven by a persisted `localStorage`, not by a page variable.
3. Each of the four dismissal routes marks it seen and, on reload, stays gone.
4. Next / Back walk the steps, the counter matches, and the step count equals the
   length of the step array.
5. It does not appear on `dashboard.html`, `daily.html`, `duel.html`, `leagues.html`
   or `practice.html`.
6. The footer link re-opens it after it has been dismissed.
7. Bumping `TOUR_VERSION` past a stored older value shows it again.
8. No uncaught page errors, in both themes.
