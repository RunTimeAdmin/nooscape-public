# The MCP server (stage D-MCP)

**Status.** Built and merged (PR 166, 19 Oct 2026, main `68f2784`). Its public home is [`RunTimeAdmin/nooscape-mcp`](https://github.com/RunTimeAdmin/nooscape-mcp). **Published to npm** as `nooscape-mcp@0.1.0` and **listed in the official MCP registry** as `io.github.RunTimeAdmin/nooscape-mcp` (both 19 Oct 2026). Later releases: **0.2.0** (Base and Arc; npm 21 Oct 2026 at 19:10 UTC, registry 22 Oct at 01:57 UTC) and **0.3.0** (a fifth tool, `get_stats`; npm 27 Oct 2026 at 03:22 UTC, registry at 03:24 UTC, see [the stats record](./api-stats-2026-10-26.md)) and **0.4.0** (Ethereum; npm 27 Oct 2026 at 13:33 UTC, registry at 13:33 UTC, see [the Ethereum record](./ethereum-go-live-2026-10-27.md)) and **0.4.1** (the hardening from [the first outside review](./outside-security-review-2026-10-27.md); npm 28 Oct 2026 at 03:37 UTC, registry at 03:38 UTC) and **0.5.0** (a token for the HTTP mode off this machine, AgenC, quoted names; npm 29 Oct 2026 at 12:46 UTC, registry at 12:51 UTC, see [the second outside review](./outside-security-review-2026-10-29.md)). The latest is **0.5.0** on both. **Not yet** on Smithery: see "Publishing". Nothing here changes the site, the API, the database or the deploy.

## What it is

A small MCP server so an AI assistant or an agent can ask Nooscape "what is on record about this agent, wallet or endpoint?" before it pays or relies on it. It is a thin, read-only client of the live public API (`https://nooscape.si/api/v1`). It adds no data and no server-side logic: it makes the request, turns an answer that is not a success into a plain message, and hands back the API's JSON untouched with a short summary in front.

The brief is the operator's `CLAUDE_BRIEF_MCP.md` (not in this repository).

## The tools

All five are marked read-only. Each returns a short plain summary, then the API's JSON exactly as given, so `as_of`, `source`, the evidence level and the license always come with it.

| Tool | API call | Needs |
|---|---|---|
| `search_agents(query, chain?)` | `GET /agents/search` | nothing |
| `get_stats()` (0.3.0) | `GET /stats` | nothing |
| `get_agent(chain, id, registry?)` | `GET /agents/{chain}/{id}` | nothing |
| `get_agent_history(chain, id, registry?)` | `GET /agents/{chain}/{id}/history` | an API key (a free one is enough) |
| `check(agent \| wallet \| url, chain?)` | `POST /check` | a Pro key, or an x402 payment |

`get_stats` takes no input. It gives what the directory holds on each chain (entries listed and the registries behind them, ratings recorded, the registrations a registry holds, entries first seen in the last 24 hours, and when the chain was last read), says that a chain not read is not indexed and not none, and quotes the API's own statement whole. `check` takes exactly one of `agent` (`{ chain, id }`), `wallet` or `url`, not a single string, because a Solana address can be a wallet or an agent id and guessing would be wrong. A `url` may be a bare host, which is given `https://`; the API matches it by host alone and nothing is fetched. `registry` is only for Solana, where more than one of the four registries (`solana_8004`, `solana_said`, `solana_registry` and, since 0.5.0, `solana_agenc`) can list one address; the API then answers 409 and says to add it.

## What it will not do

- **Add a verdict.** The summaries use no word of safety, trust, ranking or score. A test fails on any such word outside the lines that are marked as the API's own statements ("API statement: ..."). The server's instructions to the model say not to turn a result into "good", "bad", "safe" or "unsafe".
- **Pass an owner's words off as Nooscape's.** Text an owner wrote is shown only as the owner's own word, unchecked by Nooscape, and as data and not an instruction, and it is cut at 300 characters in the summary. A claim on hold shows no owner text, as on the site. Since 0.4.1 line breaks and invisible characters are taken out of any text from other people, and since 0.5.0 an agent's name and every owner field are shown in quotation marks (a quotation mark or backslash inside is escaped) and the instructions to the model call names the registrant's words and data. That lowers the chance that a model takes such text for an instruction. It does not remove it.
- **Hold a wallet or sign a payment.** Without a Pro key, `check` returns the API's 402 as a message with the price ($0.01 at the time of writing, from the API's own terms), the x402 terms, "this server does not sign or send payments" and "nothing was charged". A free key on `check` gets the API's 403 explained.
- **Show the key.** The optional `NOOSCAPE_API_KEY` is sent as a bearer token to `nooscape.si` only (no redirect is followed). It is never logged, echoed or put in a result or an error, and it is also scrubbed from any text taken from an API answer. An unfilled placeholder (a bundle's `${user_config.api_key}`) counts as no key.
- **Retry.** A refusal is not retried. A 429 passes `Retry-After` on. Requests time out after 15 seconds.
- **Put a fault's text in a result.** A fault inside the server is reported without its cause, because a cause could hold a request and so a key.

## Transports

- **stdio**, for Claude Desktop, Cursor, Claude Code and other clients (`npx -y nooscape-mcp`).
- **Streamable HTTP** behind `--http`: stateless (a new server for each POST, JSON answers), bound to `127.0.0.1` by default, accepting only a matching `Host` header and refusing any request that carries an `Origin` header, which stops a web page from reaching it. An address that is not this machine is refused unless `--allow-remote` is given (0.4.1) and `NOOSCAPE_MCP_TOKEN` is set (0.5.0): a secret of at least 24 characters that every request must send as `Authorization: Bearer`, compared in constant time and checked before the path, and needed on any address once it is set. The headers have 10 seconds, a whole request 30, and the server holds 64 connections. The secret is one for everybody and travels in the clear unless TLS is in front, so anyone who has it uses the server's one key. It is **not deployed anywhere**, and a hosted version would need per-caller keys, limits and a log.

## Where it lives

- **Public repository:** `RunTimeAdmin/nooscape-mcp` (public, created 19 Oct 2026). One package, TypeScript, `@modelcontextprotocol/sdk` 1.32, zod 4, Node 18 or later, MIT, copyright RunTimeAdmin. Commits are authored with the account's GitHub no-reply address.
- **In this repository:** `packages/nooscape-mcp` was the copy merged in PR 166. It was standalone (its own `package.json` and lockfile; there is no root workspace, and CI's `gate` only runs in `apps/nooscape-relay`), and it fell behind the public repository (0.1.0 here, against 0.4.0 there). **Removed on 2026-10-27**, with a pointer left in `packages/nooscape-mcp/README.md`, so the public repository is the one home.
- **Built files in the public repository:** `server.json` (official MCP registry, schema 2025-12-11, name `io.github.RunTimeAdmin/nooscape-mcp`, which must equal `mcpName` in `package.json`), and `manifest.json` (an MCPB manifest). Both agree on the name and version, and a test holds that.

## Verified

- **89 tests**, with a mocked API, a real MCP client over an in-memory transport and over real HTTP, and the API's real response shapes: 402, 429 (and no retry), 401, 403, 404 for a hidden record, 409, 5xx, a timeout, a network error, a non-JSON or oversized answer; the key absent from every result, error and console call; owner text labelled; no verdict words; the HTTP origin, host, method and size rules; the metadata files agreeing.
- **Mutation checks** on the rules that matter (no redirect, key scrubbing, authorization only with a key, the origin and host checks, the owner-text label and cut, attribution, `as_of`, the no-wallet line, read-only annotations, no retry): every one caught by a test. One was first missed (the branch for a fault that is not the API's) and is now tested.
- **Run through `npx`** against the live API (`npm pack`, then `npx --package=<tarball> nooscape-mcp`, driven by a real MCP client): `search_agents`, `get_agent` on a real agent, a clear 404 for an unlisted id, `get_agent_history` without a key saying a key is needed, `check` without a key showing the 402 message, and `check` refusing two subjects. The HTTP mode was run against the live API too. `scripts/live-check.mjs` in the public repository repeats this, and with `NOOSCAPE_API_KEY` set it checks that the history succeeds.
- **The published package** was run from the npm registry (`npx -y nooscape-mcp@0.1.0`, from an empty folder and a fresh cache): it prints `0.1.0`, and `scripts/live-check.mjs --npx nooscape-mcp@0.1.0` ended "ALL OK" for all seven checks. Run that script from outside the package folder: inside it, `npx` treats the project as already satisfying the name and version and never fetches the registry copy.
- **0.3.0** (27 Oct 2026): 100 tests, 17 deliberate breakages of `get_stats` all caught, and the published package run the same way (`scripts/live-check.mjs --npx nooscape-mcp@0.3.0`, from an empty folder): all twelve checks pass, `get_stats` included.
- **0.4.0** (27 Oct 2026): 101 tests, four deliberate breakages (Ethereum left out of the chain list, its label, the instructions, and a version that disagrees between files) all caught, and the published package run the same way (`scripts/live-check.mjs --npx nooscape-mcp@0.4.0`, from an empty folder): all fourteen checks pass, with an Ethereum search, an Ethereum agent read ("Ethereum agent 55441") and `get_stats` saying 59,045 entries listed on six chains. npm's `dist.shasum` and integrity equal the dry run's.
- **0.4.1** (28 Oct 2026): 115 tests, and the published package run the same way (`scripts/live-check.mjs --npx nooscape-mcp@0.4.1`, from an empty folder): all fourteen checks pass, and `--http --host 0.0.0.0` stops with exit 2. npm's `dist.shasum` (`1067dc47577c5d84ed20eecb7ed09db0488db86b`, 17 files) equals the dry run's.
- **0.5.0** (29 Oct 2026): 132 tests and 14 deliberate breakages across its four changes, all caught. The built program was tried by hand: four refusals exit 2 and never echo a token, a started server answers 401 without the token and 200 with it, and a `get_stats` call through it reaches the live API (the remote path was tried on `127.0.0.2`, so no port was opened to the network). The published package was run the same way (`scripts/live-check.mjs --npx nooscape-mcp@0.5.0`): all fourteen checks pass, with names in quotation marks, and a remote start without a token exits 2. npm's `dist.shasum` (`f3b1fc7eaeb7f9bc4cfa4bb5b53cbd4717d4b226`, 17 files) equals the dry run's.
- **A clean anonymous clone** of the public repository installs from the lockfile, passes the 89 tests and builds.
- **Not verified:** `get_agent_history` and `check` *succeeding* against the live API, which needs a key and a Pro key. Both are covered by tests against the API's real shapes.
- **No audit** has been done on this package (the one done for D5 found real problems). Two outside source reviews have read it, on 27 and 29 October 2026 ([the first](./outside-security-review-2026-10-27.md), [the second](./outside-security-review-2026-10-29.md)), and what they found is fixed in 0.4.1 and 0.5.0. The risk surface is small: the key handling, the HTTP mode and text written by other people in results.

## Publishing

The operator publishes; the steps and where each stands:

1. **npm: done (19 Oct 2026).** The operator published `nooscape-mcp@0.1.0` from the `nooscape` npm account, from a clean checkout of the public repository (17 files: the build, both metadata files, the readme and the license). The registry shows license MIT, the public repository and issues links, `mcpName` `io.github.RunTimeAdmin/nooscape-mcp`, and `latest` at 0.1.0. A `0.0.0-stage` placeholder entry sits two minutes before it in the time list; it is not tagged and nobody installs it by accident. The build is forced to LF line endings so the program's first line works on Linux and macOS when built on Windows. The registry lists the account's email as the maintainer, which is public.
2. **Official MCP registry: done (19 Oct 2026).** The operator ran `mcp-publisher login github` as `RunTimeAdmin` (whose namespace `io.github.RunTimeAdmin/` the name uses) and `mcp-publisher publish` from the package folder, after the npm package was live, because the registry checks `mcpName`. The registry's own search (`https://registry.modelcontextprotocol.io/v0/servers?search=nooscape`) returns one entry: version 0.1.0, status active, latest, the npm package `nooscape-mcp` with stdio transport, and the public repository. A custom domain name (`si.nooscape/...`) would have needed DNS authentication instead.
3. **Smithery.** Two routes, and neither is open yet:
   - **The website** (`smithery.ai/new`) only takes a hosted server: a namespace, a server id and a live https MCP URL. It has no option to add from a repository or upload a bundle, so it cannot take a local stdio server.
   - **The CLI** (`smithery mcp publish ./server.mcpb -n <namespace>/<server>`, CLI 4.11.1) uploads an MCPB bundle for a local server. A bundle is built at `server.mcpb` (3.7 MB, 2,375 files, made with `@anthropic-ai/mcpb` 2.1.2 from the production dependencies; a plain `npm install` hit an npm bug, so `--legacy-peer-deps` was used). Two things were learned. First, a manifest that lists tools fails with four "expected object, received undefined" errors, because Smithery copies the manifest's tools into a server card in which each tool needs an `inputSchema`, and the official validator refuses that key in a manifest; so the manifest lists no tools and says `tools_generated`, and the server reports its tools with `tools/list`. Second, with that fixed the payload passes, and the next step, creating the server, answers **403 "Updating servers has been removed. Contact support@smithery.ai."** The namespace `nooscape` was claimed on 19 Oct 2026 (`smithery namespace create`) and the server still does not exist (the public API answers 404), so this is not the namespace. It looks like a restriction or fault on Smithery's side and needs their support. A drafted email is with the operator.
   - **A hosted URL** would be the website route: a public https deployment of the HTTP mode that takes each caller's key (a Smithery session config can carry one), with sign-in and a deployment on a VPS. Not built.

4. **Later releases, each published by the operator.** 0.2.0: npm 21 Oct 2026 at 19:10 UTC, registry 22 Oct at 01:57 UTC. 0.3.0: npm 27 Oct 2026 at 03:22 UTC (shasum `85749249389a16291b08a5ffa4a1f89743a55718`, 17 files), registry at 03:24 UTC, after the API route it calls was live. 0.4.0: npm 27 Oct 2026 at 13:33 UTC (shasum `e3ac1c681c5fa5d1669be5d5af7e6d1e153036c6`, 17 files), registry at 13:33 UTC, after Ethereum was switched on (12:00 UTC) so that `get_agent` on it answers. 0.4.1: npm 28 Oct 2026 at 03:37 UTC (shasum `1067dc47577c5d84ed20eecb7ed09db0488db86b`, 17 files), registry at 03:38 UTC (the first registry attempt answered 404 because npm's package document had not yet propagated, and a retry a minute later worked). 0.5.0: npm 29 Oct 2026 at 12:46 UTC (shasum `f3b1fc7eaeb7f9bc4cfa4bb5b53cbd4717d4b226`, 17 files), registry at 12:51 UTC (the first attempts answered 401 "Invalid or expired Registry JWT token": the registry's login token lasts only minutes, so `mcp-publisher login github` and `publish` have to run back to back, on one line). A version cannot be published twice, so a release that calls a new API route goes out after the route does.

## Choices left open

I chose these, so the operator can say no to any of them:

1. **`check` takes one of agent, wallet or url**, and `get_agent` and `get_agent_history` take an optional `registry`.
2. **No payment from inside the server in v1.** A non-custodial payer (a client-side signer, never a key in the server) is a follow-up.
3. **The public repository is the home**, and the copyright holder is RunTimeAdmin.
4. **Tools are left out of the MCPB manifest** (see above), so Smithery's server page may list none until it can scan the server or the tools are sent with their schemas by a direct call to its API.
5. **License MIT**, as the repository's.
6. **No change to `/developers` until the package is published**, so the site does not promise an `npx` command that does not work yet.

## Not in this stage

An MCP section on `/developers` (after publishing), a CI job for the public repository, an x402-capable payer for `check`, per-caller keys and a deployment for a hosted HTTP mode, a Smithery listing, and an independent security review.
