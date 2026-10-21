# Incident record: the home page blank for 13 minutes (2026-10-15)

The home page rendered nothing for about 13 minutes, from the deploy of the Owl's Catch (PR 55) at 14:55Z until its fix (PR 56) went live at 15:08Z. The hero read the server's answer for `liveData.noosphereSample` as if it were the sample itself, so `fleets` was undefined and React threw while rendering, which removed the whole page. The API kept answering (`verify-live` passed at 14:55 and again at 15:09), and the migration, the worker and the Owl's Catch itself were not involved.

## Timeline (UTC)

| Time | What |
| --- | --- |
| before 14:54 | The operator runs migration 0036 (the `owls_catch` table) in the host's SQL console, as the Owl's Catch doc says to do before the deploy. |
| 14:54:24 | PR 55 (the Owl's Catch and the server read behind the hero's sample) is merged after a green gate. |
| 14:55:19 | The new build is live. The boot log reads "Schema is current; nothing to apply." |
| 14:55:48 | `verify-live`: 36 passed. It checks the API and the sources, not rendered pages, so it cannot see the crash. |
| about 15:00 | A load of the live page in headless Chrome shows `TypeError: Cannot read properties of undefined (reading 'length')` at 1440 and 375 wide and no heading. The operator pastes the same console error. |
| 15:00 | The worker tick chooses the first catch (a fleet). The Catch is unaffected. |
| 15:03 | PR 56 is opened with the fix. |
| 15:05 to 15:07 | The fix is checked in headless Chrome against the built server and the production-scale test database: the home page and five Catch pages at both widths. |
| 15:07:16 | The gate passes. PR 56 is merged at 15:07:29. |
| 15:08:24 | The fixed build is live. A load of the live page at both widths shows the hero and the Catch card with no console errors, and `verify-live` reports 36 passed at 15:09. |

## Cause

`liveData.noosphereSample` answers `{ sample }`, and `{ sample: null }` when the read fails on the server. The hero read the answer with `(query.data ?? null) as NoosphereSample | null`, so it took the wrapper for the sample. The first thing it did with it was read the length of `fleets`.

## Why nothing caught it

- **The cast compiled.** TypeScript accepts `X | null` asserted to `Y | null` because the two types share `null`, so the type check never compared the shapes.
- **The by-hand browser check used a stand-in.** The preview server used for the pull request's browser run answered with the bare sample, which is the shape the hero expected, not the one the router sends.
- **The tests read source text.** The hero's test checked strings in `HeroScene.tsx`, and the router's test checked the router. Nothing tied the two together.
- **`verify-live` and the gate do not render a page.** The gate (type check, tests, build) passed, and `verify-live` reads the API.

## What was changed

PR 56:

- The hero reads `sampleQuery.data?.sample` with no cast, so the compiler checks the shape.
- A `{ sample: null }` answer now shows as unavailable instead of loading forever.
- A test pins both ends: the hero's read, and the router's two answers.

## What to check next time a page reads a new endpoint

1. Before merging, build, start the server against a database with real data, and load the page in a headless browser at 1440 and 375 wide. Read the console. Use the real server, never a stand-in that answers what the client expects.
2. After the deploy, do the same on the live page. `verify-live` passing does not mean the page renders.
3. Read tRPC answers with typed access (`query.data?.field`), not a cast of the whole answer.
4. If the live page is blank, read the console error first. The gate takes 4 to 6 minutes and the deploy about 1, so budget about 7 minutes for a fix or a revert.

## Open

- Other places in the client cast a whole tRPC answer (`as X | undefined`). They have not been audited for the same kind of mismatch.
- A step in `verify-live` that loads the home page in a headless browser and fails on a console error would have caught this. The repo has no browser test runner, so it needs a decision.
- The first load in each fresh headless Chrome session (five of five) got a 403 from the CDN for the page, though the page still rendered. Later loads in the same session and `curl` always got 200. The app has no 403 path for that route, so this looks like CDN behavior toward that client. It is unexplained.
