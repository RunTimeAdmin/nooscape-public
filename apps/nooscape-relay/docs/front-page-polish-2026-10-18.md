# Front page polish (2026-10-18)

From an outside visual audit (`Nooscape-Visual-Audit.md` and a CSS pack, received 2026-10-18). The audit's measurements were checked against `main` and matched (446 hex colours in 27 TSX files, 104 uses of `#BFFF76`, 14 headings with `text-xl`, the sub-12px counts by size). Its CSS pack was read in full and not pasted: each change below is written into the existing rules, tested, and looked at in a browser at eight widths with the live site's data.

## What changed

| Change | Where | Why |
|---|---|---|
| The headline has one accent, radar mint toward white | `.holographic-text` | It was lime into lilac into cyan. Lime is Robinhood's colour and violet is Solana's, so a visitor learning the key would read the headline as being about a chain. The chain colours are now the only ones on the page that mean a chain. |
| The three figures are larger | `.hero-figure dd` (up to 60px, from 52px), `.hero-figures` (54rem), the column gap | The figures are the pitch: many indexed, few reviewed, one wallet behind a large fleet. |
| The reviewed figure takes the steady light's colour | `.hero-figure:nth-child(2) dd` | The key already says a steady light is evidence on record, and 76 is that. The fleet's figure stays plain ink: a warm colour on it would read as a verdict, and a fleet is worth a look, not a verdict. |
| A hairline under the sweep stamp | `.hero-figures > .ns-label::after` | Ties the timestamp to the radar motif. Static. |
| Panels take a mint edge under a pointer | `.ns-glass:hover`, only where `(hover: hover)` | Quiet feedback, nothing on touch screens. |
| On a phone the two hero buttons share a line, and the figures are a little smaller | `@media (max-width: 639px)` | The figures and the new-entries line are on the first screen at 390px (the stats end at y 793 of 900). The buttons wrap again at 360px rather than overflow. |
| The fleets' bars are dotted | `.fleet-track`, `.fleet-fill`, `FleetCards.tsx` | The same dotted language as the Clear the Fog bars, so one idea is not drawn two ways. |
| "New to the Owl" moves below the map | `Home.tsx` | The map is the best thing on the page and was the fourth thing a visitor scrolled past (the audit's largest composition finding). My new section had pushed it further down. The hero's own line says what is new and links to it. |

`heroScene.test.ts` pinned the old figure size and is updated on purpose; it now also pins the mint figure, the plain fleet figure, the hairline and the phone rules. `frontPage.test.ts` holds the headline's single accent, the dotted bars, the hover edge and the section order.

## What was not taken, and why

- **Scroll reveal** (sections fade up as they enter, in CSS). Untested against the owl's perch positions, which read each section's box, and a section that starts transparent is a risk for a page whose job is to be read and quoted. Revisit with a browser test of the owl.
- **A global `:focus-visible` ring.** The stylesheet has unlayered rules that beat Tailwind's utilities, so a global outline would override every component's own focus style. The shadcn `--ring` already maps to the radar colour.
- **Replacing the hex colours with tokens** (about 440 in the components). A visible hue shift in the dim text and a large diff; it needs its own decision. `#BFFF76` needs a token first.
- **Count-up on the hero figures.** `CountUp` renders the number twice (one for the eye, one for a screen reader), and the hero tests pin the markup. Small, separate.
- **The bigger owl, the live map in the hero sky, trimming sections for a front-door page.** Decisions, not patches.
