<p align="center">
  <a href="https://nooscape.si">
    <img src="brand/nooscape/nooscape-og-card-1200x630.png" alt="Nooscape: an evidence-first agent atlas" width="100%">
  </a>
</p>

<p align="center">
  <b>Explore the public agent internet through retained evidence, visible source boundaries and verifiable provenance.</b>
</p>

<p align="center">
  <a href="https://nooscape.si">Live site</a> &nbsp;·&nbsp;
  <a href="https://nooscape.si/developers">API</a> &nbsp;·&nbsp;
  <a href="https://nooscape.si/api/v1/openapi.json">OpenAPI</a> &nbsp;·&nbsp;
  <a href="https://nooscape.si/llms.txt">llms.txt</a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/nooscape-mcp">MCP server</a> &nbsp;·&nbsp;
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <a href="https://github.com/RunTimeAdmin/nooscape-public/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/RunTimeAdmin/nooscape-public/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://www.npmjs.com/package/nooscape-mcp"><img alt="nooscape-mcp on npm" src="https://img.shields.io/npm/v/nooscape-mcp?label=nooscape-mcp"></a>
</p>

---

## What Nooscape is

Nooscape is a public atlas of AI agents. It reads the public agent registries on **Robinhood Chain, BNB Chain, Solana, Ethereum, Base and Arc**, keeps what it read together with the date or block it was read at, and shows it as facts. Anyone can look an agent up, see where each fact came from, and decide for themselves.

It states facts and never a verdict.

- **Acknowledged is not reviewed.** Most records are listed only: a source saw the agent. A few are reviewed, with signed evidence kept.
- **A light on the map is evidence, not a score.** There are no scores for sale and no rankings for hire.
- **Payment changes nothing.** A key, a payment or a claim never changes a record, a tier or an evidence level.
- **Every answer says when it was read and where from.**

On 27 October 2026 the atlas listed 59,053 agents from the chain registries (Robinhood Chain 19,888, Solana 17,605, Base 9,093, BNB Chain 6,930, Ethereum 5,185, Arc 352), out of many more registrations recorded, and 76 records were reviewed with signed evidence kept. The live figures are on the [home page](https://nooscape.si) and in the [API](https://nooscape.si/api/v1).

## See it

<table>
  <tr>
    <td width="33%"><a href="https://nooscape.si"><img src="brand/screenshots/home.jpg" alt="The Nooscape home page: a map of agents, lit by how much evidence is on record"></a></td>
    <td width="33%"><a href="https://nooscape.si/chains/base"><img src="brand/screenshots/base.jpg" alt="The Base chain world: groups of registrations that share a host, a link or a wallet"></a></td>
    <td width="33%"><a href="https://nooscape.si/developers"><img src="brand/screenshots/developers.jpg" alt="The developer page: the public API"></a></td>
  </tr>
  <tr>
    <td align="center"><sub>The map</sub></td>
    <td align="center"><sub>A chain world (Base)</sub></td>
    <td align="center"><sub>The developer page</sub></td>
  </tr>
</table>

<sub>Screenshots of the live site, 21 October 2026.</sub>

## What you can do with it

| | |
|---|---|
| **Browse the atlas** | The map, one page for each chain, and a dossier for every agent that shows what is on record and what is not. |
| **Look an agent up** | `GET /api/v1/agents/{chain}/{id}` and a search, with no key. 30 requests a minute from one address. |
| **Check before you pay** | `POST /api/v1/check` gives dated facts about an agent, a wallet or an endpoint host. It takes a Pro key, or $0.01 a call in USDC over [x402](https://x402.org), with no account. |
| **Use it from an AI assistant** | The [`nooscape-mcp`](https://github.com/RunTimeAdmin/nooscape-mcp) server gives MCP clients search, lookup, history and the check as tools. |
| **Claim your agent** | The owner of an ERC-8004 agent signs one message with the wallet that owns the agent in the registry. The claim is shown beside what Nooscape observed, never in its place. |
| **Watch agents** | Builder keys get a watchlist and signed webhooks. |
| **Verify evidence** | Evidence packets are signed with Ed25519. The signing keys, active and retired, are published at [`/.well-known/nooscape-keys.json`](https://nooscape.si/.well-known/nooscape-keys.json), and the [verifier](https://nooscape.si/verify) checks a packet against them. |

## Try the API

```bash
# One agent, by chain and registry id (no key needed)
curl https://nooscape.si/api/v1/agents/arc/1

# Search
curl "https://nooscape.si/api/v1/agents/search?q=agent&chain=arc&limit=5"

# The pre-flight check. With no key you get a 402 that says how to pay.
curl -i -X POST https://nooscape.si/api/v1/check \
  -H "content-type: application/json" \
  -d '{"agent":{"chain":"arc","id":"1"}}'
```

Chains are `robinhood`, `bnb`, `solana`, `ethereum`, `base` and `arc`. Every answer carries `as_of`, `source` and `license`. Free, Builder and Pro keys raise the limits ([get a key](https://nooscape.si/developers/keys)). The full description is the [OpenAPI document](https://nooscape.si/api/v1/openapi.json), and [`/llms.txt`](https://nooscape.si/llms.txt) is the same API written for a model.

## How it works

```mermaid
flowchart LR
  subgraph Sources["Public sources"]
    A["ERC-8004 registries<br/>Robinhood, BNB, Ethereum, Base, Arc"]
    B["Solana agent registries"]
    C["A2A cards and catalogs"]
  end
  W["Ingestion worker<br/>scheduled, bounded passes"]
  D[("MySQL or MariaDB<br/>records and ledgers")]
  S[("Evidence store<br/>S3-compatible")]
  X["Express server<br/>tRPC, REST v1, x402"]
  U["Atlas<br/>React and Vite"]
  O["MCP server, llms.txt,<br/>signed evidence"]
  A --> W
  B --> W
  C --> W
  W --> D
  W --> S
  D --> X
  S --> X
  X --> U
  X --> O
```

A worker reads each approved source on a schedule, through fetch rules that bound what it will contact. What it reads goes into the database as a record with its source and date, and the observation behind it goes into the evidence store. The server answers from those records and does not score them.

## Repository

```text
apps/nooscape-relay/     The application
  client/                  React 19, Vite, Tailwind, wouter
  server/                  Express, tRPC, the REST API, x402 and the worker
  shared/                  Types and rules used by both sides
  drizzle/                 SQL migrations
  docs/                    Decision records, runbooks and the documentation index
  scripts/                 Build, CI and live-check scripts
packages/nooscape-mcp/   The MCP server (public home: nooscape-mcp)
brand/                   Logos, cards and the screenshots above
```

### Run it locally

You need Node 22 and [pnpm](https://pnpm.io) 10.

```bash
git clone https://github.com/RunTimeAdmin/nooscape-public.git
cd nooscape-public/apps/nooscape-relay
pnpm install
pnpm dev            # http://localhost:3000
```

With no `DATABASE_URL` the server starts in a local tooling mode: the pages load and the data is empty. For a database, run MySQL 8 and set `DATABASE_URL`. Most migrations are applied when the server starts. A few, listed in `server/dbMigrations.ts`, are left for an operator to apply by hand.

```bash
pnpm check          # typecheck of the source and of the tests
pnpm test           # more than 4,500 tests
```

The tests that need a database use `mysql://root:nooscape@127.0.0.1:3307` and skip when none is reachable. CI runs the same checks against a throwaway MySQL 8 and builds the app.

Built with TypeScript, React 19, Vite 7, Tailwind 4, Express 4, tRPC 11, Drizzle and Vitest.

## Documentation

The index is [`apps/nooscape-relay/docs/README.md`](apps/nooscape-relay/docs/README.md). A few places to start:

| Read | For |
|---|---|
| [Data access](apps/nooscape-relay/docs/data-access-2026-10-19.md) | The REST API, keys and tiers, and pay per call |
| [Discovery files](apps/nooscape-relay/docs/x402-discovery-2026-10-21.md) | `/llms.txt`, `/.well-known/x402` and the Bazaar block in a 402 |
| [Multichain ERC-8004](apps/nooscape-relay/docs/multichain-erc8004-2026-10-20.md) | How one importer reads the ERC-8004 registries on every EVM chain |
| [Evidence key rotation](apps/nooscape-relay/docs/evidence-key-rotation.md) | How evidence is signed and how the key is changed |
| [Worker operations](apps/nooscape-relay/docs/worker-operations.md) | How the scheduled ingestion worker runs |
| [Security](SECURITY.md) | How to report a vulnerability |

The root of the repository also holds dated design and research notes. They record decisions as they were made, so some are older than the code.

| Note | What it covers |
|---|---|
| [`AGENT_TRUST_TIER_DESIGN.md`](AGENT_TRUST_TIER_DESIGN.md) | The thesis, the dedup pipeline, trust tiers 0 to 3 and the phased build plan |
| [`INGEST_POINTS.md`](INGEST_POINTS.md) | Named ingest sources, their limits and the signals each gives |
| [`SCOPE.md`](SCOPE.md) | The v1 chain scope decided on 7 October 2026. BNB Chain, Base and Ethereum were added after it. |
| [`ARC_INGEST_RESEARCH.md`](ARC_INGEST_RESEARCH.md) | Arc: first-party evidence, source requirements and priorities |

### Independence

Nooscape is independent from [Noos Network](https://noosnet.ai/). It is an evidence-first discovery atlas, and Noos describes an economic and settlement layer for agent skills.

Some projects by the same operator (Archipelago, Sigvara, Countersig, MCPShield and agentclear) are first-party. They are treated as first-party: no adapter is active for them without its own reviewed source boundary. See [`ARCHIPELAGO_X402.md`](ARCHIPELAGO_X402.md) and [`ARCHIPELAGO_INGEST.md`](ARCHIPELAGO_INGEST.md).

## Security and contact

A security problem goes to **security@nooscape.si** (see [`SECURITY.md`](SECURITY.md)), not to a public issue. Disputes, corrections and privacy questions go to **trust@nooscape.si**, with a reply promised within one business day.

## Contributing

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first.

## License

The code is released under the [MIT License](LICENSE). The data Nooscape serves is under provisional terms: attribution is required, and bulk copies may not be resold (see the [terms](https://nooscape.si/terms)). The Nooscape name and logo are not part of the code license.

## About this repository

This is the public home of Nooscape's source, started from a snapshot taken on 21 October 2026 and refreshed from the private repository's main on 27 October 2026. Earlier history lives in a private archive, so the pull request and commit numbers that the docs and code comments mention (for example "PR 174") refer to that archive, and a few records are withheld from this tree and replaced with a short note.
