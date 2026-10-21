# Decision record: The MCP server (stage D-MCP)

**Decided:** 2026-10-19, by the operator, in chat: a written brief (`CLAUDE_BRIEF_MCP.md`), then "do the pr and merge if anything needs to be and help me publish the mcp", "create it" (the public repository) and "RunTimeAdmin copyright".
**Changes:** a new standalone package, `nooscape-mcp`, that serves four read-only tools over the live public API (`search_agents`, `get_agent`, `get_agent_history`, `check`), by stdio and by a local stateless HTTP mode. A public repository for it, `RunTimeAdmin/nooscape-mcp`. A `server.json` for the official MCP registry and an MCPB manifest and bundle for Smithery. No change to the site, the API, the database, CI or the deploy.
**Does not change:** a record, a score, a tier, an evidence level, any answer the API gives, or what a caller pays. The server holds no wallet and signs nothing, and nothing is published by merging it.

## What the operator is asked to approve

1. **The shape of `check`.** It takes exactly one of `agent`, `wallet` or `url`, not one string (a Solana address could be a wallet or an agent id). A bare host is accepted. `get_agent` and `get_agent_history` take an optional `registry` for Solana.
2. **No payment from the server in v1.** Without a Pro key, `check` explains the 402 and charges nothing. A non-custodial payer is a later option.
3. **The rules in `docs/mcp-server-2026-10-19.md`:** no verdict words in a summary, an owner's words labelled as the owner's and cut, the key never shown, no retry, no redirect.
4. **The public repository and the license.** The public repository is the home, MIT, with RunTimeAdmin as the copyright holder. The copy in `packages/nooscape-mcp` is behind it and should be removed (open).
5. **The HTTP mode is local only.** Hosting it needs per-caller keys and a deployment, and is not built.
6. **No `/developers` section yet.** It waits until the package is published, so the site does not promise a command that does not work.

## What the operator did not decide and I chose, so he can say no

See "Choices left open" in the record: the tools left out of the MCPB manifest, the build forced to LF line endings, MIT, and the registry name `io.github.RunTimeAdmin/nooscape-mcp`.

## What this leaves

Listing on Smithery (blocked by a 403 from Smithery when it creates the server, and needs their support), an MCP section on `/developers`, a CI job for the public repository, a payer for `check`, a hosted mode, and an independent security review.

## Outcome

- [x] Built, tested (89 tests, mutation checked) and run through `npx` against the live API for all four tools (2026-10-19).
- [x] PR 166 merged (2026-10-19, main 68f2784).
- [x] Public repository created, the package pushed, the copyright set to RunTimeAdmin, the manifest fixed for Smithery (2026-10-19).
- [x] MCPB bundle built and checked (2026-10-19).
- [ ] `get_agent_history` and `check` tried live with a key and a Pro key (`scripts/live-check.mjs`).
- [x] Published to npm (`nooscape-mcp@0.1.0`, 2026-10-19), and run from the registry against the live API (`scripts/live-check.mjs --npx nooscape-mcp@0.1.0`, all seven checks).
- [x] Published to the official MCP registry (2026-10-19; the registry's search returns it as active, latest 0.1.0).
- [ ] Listed on Smithery (blocked: 403 at server creation, with support).
- [ ] The copy in `packages/nooscape-mcp` removed or brought into step.
- [ ] MCP section added to `/developers`, after publishing.
- [ ] An independent security review.
