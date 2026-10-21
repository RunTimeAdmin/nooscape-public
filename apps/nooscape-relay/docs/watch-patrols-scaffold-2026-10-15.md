# Your Watch and Patrols: scaffolds behind switches (2026-10-15)

Status: built as scaffolds and off. Nothing on either page works yet, and no visitor can reach them.

## What exists

- Two pages, `/watch` (Your Watch) and `/patrols` (Patrols). Each says what it is for in the brief's words and that it is not open yet. There is no form, no wallet, no read of the server, and nothing that saves or sends.
- A switch for each, in `shared/features.ts`. `VITE_FEATURES` is a comma list of the features that are on, for example `watch,patrols`. Unset means both are off.
- The client reads the variable when it is built. The server reads it when it runs: `server/clientRoutes.ts` answers 404 for a flagged address until its feature is on and 200 after, so the page and the status agree. A test keeps the flagged routes in `client/src/App.tsx` and that table the same.
- Nothing links to the pages and the sitemap does not list them. The glossary has an entry for each name.

## Turning one on

Set `VITE_FEATURES` in the host's environment (for example `watch`), then build and restart. The client needs the build and the server needs the restart, and both read the same variable, so a build without it hides the page and a run without it answers 404.

Turning a page on only makes the scaffold visible. Linking to it, listing it in the sitemap, and building what it describes are separate decisions.

## Rules the brief sets

- No reward, payout, token, points or price in any words on these pages. A test keeps them out.
- The token never changes an agent's glow, position, flag, profile or standing. Watchlists, alerts and similar tools are the only things a future perk may unlock.
- Non-custodial: no deposits, no holding funds, and wallet use is signature only.
- When Patrols opens, each report is reviewed before anything is published, and confirmed reports go into Field Reports.

## Not built, and needs a decision first

- **Your Watch:** how a visitor proves a wallet is theirs (a signed message), where the list is kept, and how a change in a record is detected and delivered.
- **Patrols:** the form, who may file, how reports are stored and reviewed, and the limits that stop abuse.
- Neither has a server endpoint, on purpose. Each needs rate limits, storage and review designed first.
