# Automation: CI and live health (2026-10-13)

Status: **LIVE** (merged 2026-10-13 in #6; the `main` ruleset below is active). Before this, the repo had no CI and no post-deploy check, and pushing
`main` deploys to production. Every safety property depended on someone running the gate locally and
looking at the site afterward.

> **Update 2026-10-17:** the gate has grown since this was written (a secret scan, a type check of the tests, a check that no Manus tooling is in the build, Actions pinned to commit SHAs), Dependabot runs monthly (weekly until 2026-10-20), the live check runs every six hours (every three until then), `verify-live` has 38 checks, and the agent merges directly or queues a rebase merge. The sections below say what is true now.

## What exists

| Piece | Where | What it does |
| --- | --- | --- |
| CI | `.github/workflows/ci.yml` | On every pull request and on `main`, in the one job `gate`: a secret scan (`scripts/scan-secrets.mjs`, which names the rule, file and line and never the value), `pnpm check` (the type check of the app and of the tests), `pnpm test` against a throwaway MySQL 8 (so the database-backed gate tests run instead of skipping), `pnpm build`, a check that no Manus tooling is in the build output, and `pnpm audit --prod` as an advisory step that never blocks. Every GitHub Action is pinned to a commit SHA. |
| Live health | `.github/workflows/health.yml` | Every six hours (every three until 2026-10-20) and on demand: runs `scripts/verify-live.mjs` against https://nooscape.si. A failure opens, or comments on, one issue titled "Live health check is failing". |
| The check | `apps/nooscape-relay/scripts/verify-live.mjs` | Read-only, public endpoints only, no credential. Run by hand with `node scripts/verify-live.mjs`. |

`verify-live.mjs` fails when: the home page is not the small production shell or carries the dev runtime;
HSTS, CSP, nosniff, or frame protection is missing; `/admin`, `/manus-storage/*`, or the OAuth callback stops
answering 404; an operator procedure stops refusing an unauthenticated caller; storage is not configured;
the reviewed census or directory is not served, or a reviewed record lacks retained evidence; or a
**scheduled** source is not active, has a recorded failure, or has not succeeded recently. A manual-only
source with a recorded failure is a warning, not a failure, because those are operator-paced.

## The one maintenance point

`FRESHNESS_HOURS` in `verify-live.mjs` maps each scheduled protocol to how stale its last success may be
(3 hours for the chain passes, 36 for the daily metadata sources). When a source's cadence changes, or a new
protocol is flipped to scheduled (for example SAID), add or adjust its entry. A scheduled protocol with no
entry is not freshness-checked.

## Documentation-only changes

A change that touches only Markdown files runs the secret scan and nothing else of the gate: the install, type check, tests, build and audit are skipped, which is about six minutes of Actions time. The job still runs and reports `gate`, so the `main` ruleset is satisfied. A workflow-level `paths-ignore` would not do that: it leaves `gate` unreported, and a pull request or a push to `main` with no `gate` result cannot merge.

`scripts/ci-scope.mjs` decides, in the job's Scope step, from the files a pull request adds to its base or the files a push changed. A file that is not Markdown runs the full gate, and so does anything the script cannot tell (a push with no commit before it, a manual run). A rename counts as a deletion and an addition, so a code file renamed to `.md` still runs it. A Markdown file that a test reads is not documentation: `READ_BY_TESTS` in the script lists them (`SECURITY.md` and the seven reports that the report pages are held to), and `server/ciScope.test.ts` fails when a test names another one, so a docs-only change cannot break a test that the run skipped. The same test holds the workflow: every step after the scope step carries the condition, the secret scan has none, and the workflow is not filtered by path.

## Pushes to main

A push to `main` runs the secret scan, the install, the type check and the build, and skips the tests. The tests are about five of the roughly seven minutes of a full run, and they ran on the pull request. What a push run adds is the one thing the pull request cannot see, because the `main` ruleset does not require branches to be up to date: two pull requests that were each green and do not fit together. The type check and the build catch a pull request that calls what another one removed or renamed. A behaviour that only a test would catch shows up on the next pull request or in the live health check, and the full gate on `main` is one click away (Actions, CI, Run workflow). The job summary of a push run says that the tests were not run, and the CI row above describes the full gate.

In the week to 20 October the push run failed 4 times in 155 runs, every time in the `Test` step. Two were on commits that changed no code (a `todo.md` edit and a `dependabot.yml` edit), one was a test that depended on a timestamp's rounding and was fixed the same day, and one was a timing test in the connection-breaker suite. None was a break between two pull requests that I could find.

## Deploy-window note

For roughly 15 to 20 minutes after a Hostinger deploy lands, `/api/trpc` can intermittently answer 404 (see
the 2026-10-12 handoff). The health workflow therefore runs on a schedule and not on every push; the next
scheduled run verifies a deploy. To check immediately, run the script by hand after the window or use the
workflow's manual trigger.

## Changed-file discipline

Source changes belong inside `apps/nooscape-relay`. GitHub only reads workflows from the repository root,
so `.github/workflows` is the one deliberate exception. It does not affect the Hostinger build, whose root
directory is `apps/nooscape-relay`.

## Dependabot

`.github/dependabot.yml` runs monthly (weekly until 2026-10-20, to save Actions minutes) for the GitHub Actions, which arrive as one grouped pull request, and for the app's npm packages, with minor and patch updates grouped into one pull request. The majors that need a decision are listed under `ignore` with the reason for each (TypeScript, Express and its types, `lucide-react`, `cookie`, `@types/node`, `vitest`, `vite` and `@vitejs/plugin-react`); their minor and patch updates still arrive. Each pull request is checked beyond the gate on a copy of `main` with the same bump (type check, the full suite, a real build and the asset sizes), because the gate runs no browser and cannot see a runtime break behind a hand-written type shim. A closed major is added to the ignore list so it does not come back. `@dependabot recreate` regenerates a pull request whose branch was cut before another one merged. The rounds are recorded in [consulting-review-2026-10-16.md](./consulting-review-2026-10-16.md).

## Stacked pull requests

Merge them in order. When the base branch is deleted GitHub retargets the next pull request to `main`, and its branch still holds the commit that was rebased, so it shows conflicts. Rebase it first with `git rebase --onto origin/main <old tip>`, push with `--force-with-lease`, then queue it.

## Timing-sensitive tests

A few tests wait on timers and sockets. When one fails the gate of a change that cannot have touched it, re-run only the failed job (`gh run rerun <id> --failed`). The stalled-body test in `server/ingestion/deadlineFetch.test.ts` timed out on the first CI run both times vitest 5 was tried, which is why `vitest` stays on 4.1.11.

## Removing the remaining button presses

These are repository settings and permission rules, so they are the owner's to switch on:

1. **Auto-merge.** Enabled on the repository and now gated. A repository ruleset named `main` is active: it
   requires the status check **`gate`** (the job inside the `CI` workflow), blocks force-push and deletion,
   has no bypass actors, and requires no reviews (`strict` is off). `gh pr merge --auto --rebase <n>` queues a
   merge that GitHub performs only when `gate` is green, with no one clicking. Observed 2026-10-13: the merge
   usually follows a green gate within seconds, but #13 waited about 3.5 minutes and #14 sat clean and mergeable
   for 16 minutes until the same command was run again. If a green PR does not merge, re-run the command or merge in
   the GitHub UI, and check `git log origin/main` before assuming a deploy happened.
2. **Agent merges.** Since 2026-10-16 the coding agent queues auto-merge with the rebase method (the merge tool's `merge_method` field; read the method back, because a misnamed field silently queues a squash), or, when a pull request is already clean with `gate` passed, merges it directly with `gh pr merge <n> --rebase`. Never queue auto-merge on a pull request whose base is another branch.
3. **New chain sources.** Staging, approving, and seeding a source are operator actions on /admin/sources.
   Once a seed has run clean, a reviewed migration can flip the source to scheduled (the 0021 and 0027
   pattern), after which no one has to refresh it by hand.
