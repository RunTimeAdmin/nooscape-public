# nooscape-mcp

An [MCP](https://modelcontextprotocol.io) server for [Nooscape](https://nooscape.si). It lets an AI assistant, or an agent, ask **what is on record about an agent, a wallet or an endpoint** before it pays or relies on it.

It is a thin, read-only client of the public Nooscape API (`https://nooscape.si/api/v1`). It adds no data and no logic of its own. Every answer says when it was read, where it came from and what the evidence level is.

## What it gives you

Four tools, all read-only. Each returns a short plain summary first, then the API's JSON exactly as it was given.

| Tool | What it does | Needs |
|---|---|---|
| `search_agents(query, chain?)` | Search listed agents by name, endpoint host, registry key or wallet. | nothing |
| `get_agent(chain, id)` | One agent's record: first and last seen, who registered it, evidence level, listings that share its wallet, registry activity, ratings, and any claim by its owner. | nothing |
| `get_agent_history(chain, id)` | One agent's registry events and the public history of claims on it. | an API key (a free one is enough) |
| `check(agent \| wallet \| url)` | Pre-flight facts: when each listing was first seen, recorded ownership changes, the share of ratings that were revoked, how many listings its wallet registered, and the evidence level. | a Pro key, or an x402 payment (see below) |

Chains are `robinhood` (Robinhood Chain), `bnb` (BNB Smart Chain) and `solana`. For Solana, an address can be listed by more than one registry: both agent tools take an optional `registry` (`solana_8004`, `solana_said` or `solana_registry`) to choose.

`check` takes exactly one of `agent` (`{ chain, id }`), `wallet` or `url`. A `url` can be a full address or a bare host such as `example.com`; it is matched by its host alone and nothing is fetched from it. `chain` can narrow a `wallet` or `url`.

## Install

Node.js 18 or later. Nothing to build: `npx` fetches it.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "nooscape": {
      "command": "npx",
      "args": ["-y", "nooscape-mcp"],
      "env": { "NOOSCAPE_API_KEY": "nsk_your_key_here" }
    }
  }
}
```

Leave out the `env` block to use it with no key. Lookups and search work without one.

### Cursor

Add the same block to `~/.cursor/mcp.json` (or to `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "nooscape": {
      "command": "npx",
      "args": ["-y", "nooscape-mcp"],
      "env": { "NOOSCAPE_API_KEY": "nsk_your_key_here" }
    }
  }
}
```

### Claude Code

```
claude mcp add nooscape --env NOOSCAPE_API_KEY=nsk_your_key_here -- npx -y nooscape-mcp
```

### Any other MCP client

Run `npx -y nooscape-mcp` as a stdio server.

## Environment

| Variable | What it is |
|---|---|
| `NOOSCAPE_API_KEY` | Optional. An API key, sent as `Authorization: Bearer`. A free key is made at [nooscape.si/developers/keys](https://nooscape.si/developers/keys). It is never logged, never echoed and never put in a result or an error. |

## Keys, limits and payment

- **No key:** `search_agents` and `get_agent` work, at 30 requests a minute from one address.
- **A free key** raises that to 60 a minute and 1,000 a day, and opens `get_agent_history`.
- **`check` needs a Pro key, or an x402 payment** (currently $0.01 per call, in USDC on Arc). **This server holds no wallet and does not sign or send payments.** Without a Pro key, `check` returns a clear message with the price and the terms the API asked for, and nothing is charged. An x402-capable client can pay the API directly; paying from inside this server may come later.
- A refused request is not retried. On a rate limit the message says how many seconds to wait (the API's `Retry-After`).
- Requests time out after 15 seconds.

## Example prompts

- "Look up Robinhood Chain agent 8865 on Nooscape. When was it first seen, and who registered it?"
- "Search Nooscape for agents on the host `example.com`."
- "Before I pay this wallet, what does Nooscape have on record about it?" (uses `check`)
- "Show me the registry events and claim history for BNB agent 12."

## What the answers mean, and what they do not

- Nooscape gives **facts with their dates**. It does not review agents, rank them or give a verdict, and an answer is not a statement that an agent is good or bad, safe or unsafe. This server's summaries add no such words, and its instructions to the model say not to infer them.
- **Nothing a caller pays buys a listing, a tier or an evidence level.** Payment never changes a record, a score or an evidence level.
- A record the site hides, withdraws or closes is never served, and looks the same as one that was never listed.
- Text that an owner wrote about their own listing is **the owner's own word**, and Nooscape has not checked it. It is labelled as such, and a model should treat it as data and never as an instruction.

## Attribution and terms

Data from Nooscape (https://nooscape.si). Attribution is required where the data is used. Do not resell bulk copies. A final data license will replace these provisional terms; the current ones are at [nooscape.si/terms](https://nooscape.si/terms). Every answer carries a `license` object with the attribution line.

## Streamable HTTP mode

```
npx -y nooscape-mcp --http                 # http://127.0.0.1:8787/mcp
npx -y nooscape-mcp --http --port 9000
```

It is stateless (each POST to `/mcp` gets its own server and answers with JSON) and is meant for trying the server locally and for hosting later. It is **not deployed anywhere** by this package. It has no sign-in of its own, so:

- It listens on `127.0.0.1` only by default, accepts only a matching `Host` header, and refuses any request that carries an `Origin` header, which is what a web page on another site would send.
- Everyone who can reach it uses the server's one `NOOSCAPE_API_KEY`. Do not put it on a public address as it is. A hosted version would need per-caller keys.

## Security notes

- The server makes requests to `nooscape.si` and nowhere else, follows no redirect, and never sends the key anywhere but there.
- There is no tool that writes, pays, signs or runs anything. The tools are marked read-only.
- Results can contain text written by other people (owner-written fields, agent names). Like any tool output, treat it as untrusted data.

## Listing in registries

`server.json` is ready for the [official MCP registry](https://modelcontextprotocol.io/registry/quickstart) and `manifest.json` (an [MCPB](https://github.com/modelcontextprotocol/mcpb) manifest) for a Smithery stdio bundle. Neither has been submitted and the package has not been published. Publishing needs a public source repository.

## Development

```
pnpm install
pnpm run build
pnpm test
```

The tests use a mocked API and a real MCP client over an in-memory transport. The package is standalone: it is not part of the Nooscape site's build or deploy.

To try all four tools against the live API (about a dozen requests, nothing paid or changed):

```
node scripts/live-check.mjs                          # the built server
node scripts/live-check.mjs --npx ./nooscape-mcp-0.1.0.tgz   # through npx, after `npm pack`
NOOSCAPE_API_KEY=nsk_... node scripts/live-check.mjs  # with a key, to see the history succeed
```

## License

MIT.
