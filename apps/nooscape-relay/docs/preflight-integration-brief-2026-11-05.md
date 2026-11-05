# Putting the pre-flight check in front of a payment or a call (2026-11-05)

> **Status:** A short brief for a team that routes payments or traffic to AI agents: a gateway, a wallet, a facilitator, a marketplace. From items 2 and 3 of the outside list of 4 November 2026 (a drop-in guard, and one design partner gating real traffic on `/check`). Nothing here is built into the app. The calls below were run against the live API without a key; the paid call was not run.

## What it is

Before your system pays an agent, routes a call to it or lets a user hire it, you can ask what the public agent registries record about it. Give an agent (a chain and an id), a wallet that registered agents, or an endpoint address. The answer lists each matching listing with four dated flags and the sources they were read from. Every fact carries the date or block it was read at. There is no score and no verdict: your policy decides what a fact means for your decision.

| Flag | What it says |
|---|---|
| `first_seen` | When Nooscape first saw the listing, and whether that was within 30 days. Not when the agent was registered. |
| `ownership_changes` | Changes of hands that the registry's transfers record, apart from platform hand-outs just after a mint. |
| `revoked_feedback` | Ratings recorded against the agent, how many the rater later revoked, and the share. Robinhood Chain only. |
| `fleet` | How many listings one wallet registered, and how many others share the agent's host or name. |

Each flag has `present` (`true`, `false`, or `null` when it is not measured for this agent, which is not the same as none) and a `basis` that says what it rests on and what it does not mean.

## Where it fits

Three places, one call each:

- **Before a payment.** A facilitator, a wallet or a spending policy asks about the payee's wallet or endpoint before the first payment to it.
- **Before a route.** An MCP or A2A gateway asks about an endpoint's host before it forwards a call to a server it has not seen.
- **Before a hire.** A marketplace asks about a listing's agent or wallet before it lets a user pay.

## The calls

The free reads need no key (30 requests a minute from one address; a free key raises it to 60 a minute). The check needs a Pro key, or $0.01 a call over x402 with no key.

```ts
const API = "https://nooscape.si/api/v1";

// Free, no key: which listings registered this host?
async function listedFor(host: string) {
  const response = await fetch(`${API}/agents/search?host=${encodeURIComponent(host)}&limit=10`);
  if (!response.ok) throw new Error(`Nooscape answered ${response.status}`);
  const { data } = await response.json();
  return data.results as { chain: string; agent_id: string; name: string; registrant: string | null; first_seen_at: string }[];
}

// The pre-flight check. Give exactly one of agent, wallet or url (only the url's host is used, and nothing is fetched from it).
async function check(subject: { agent: { chain: string; id: string } } | { wallet: string } | { url: string }, key: string) {
  const response = await fetch(`${API}/check`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(subject),
  });
  if (response.status === 404) return null; // an agent that is not listed: that says nothing about the agent
  if (!response.ok) throw new Error(`Nooscape answered ${response.status}`);
  return (await response.json()).data; // { subject, statement, matched_total, results: [{ agent, evidence, flags, sources }] }
}
```

With no key the check is answered `402` with the price and the terms (x402 version 2: USDC on Base or on Arc, 10,000 units, which is $0.01, and the `PAYMENT-SIGNATURE` header to send back). Any x402 client that handles that header can pay and retry. A payment is charged only for an answer that was built and delivered, and it never changes a record or an answer.

Your policy goes between the facts and your decision. The thresholds below are an example and are yours to choose:

```ts
// Which facts make your system ask a person first. Nooscape says none of these is a finding.
function reasonsToAsk(data: Awaited<ReturnType<typeof check>>): string[] {
  const reasons: string[] = [];
  for (const { agent, flags } of data?.results ?? []) {
    if (flags.first_seen.present) reasons.push(`${agent.name}: first seen ${flags.first_seen.days_since_first_seen} days ago`);
    if (flags.ownership_changes.present) reasons.push(`${agent.name}: ${flags.ownership_changes.changes_recorded} ownership change(s) recorded`);
    if ((flags.revoked_feedback.revoked_share ?? 0) >= 0.2) reasons.push(`${agent.name}: ${flags.revoked_feedback.revoked_count} of ${flags.revoked_feedback.rating_count} ratings revoked`);
    if ((flags.fleet.same_host_others ?? 0) >= 10) reasons.push(`${agent.name}: ${flags.fleet.same_host_others} other listings share its host`);
  }
  return reasons;
}
```

## What the answer does not say

- **It covers listed agents only.** The directory holds the agents that public registries record (ERC-8004 on Robinhood Chain, BNB Chain, Ethereum, Base, Arc and Monad, and four registries on Solana): about 61,000 on 5 November 2026, and `/api/v1/stats` has today's figure. For an agent that is not listed the answer is 404, in the same words as a hidden one. A wallet or an address nothing matches answers 200 with an empty list.
- **A listing is not an endorsement.** Every agent in the check is "acknowledged": a source saw it, and Nooscape kept what it saw. A flag that is present is a fact to weigh and not a finding, and no flag present is not safety.
- **Nothing is fetched from the endpoint.** The check reads Nooscape's own records. It does not test that an agent works or that its host is up.
- **Names and hosts are text that registrants published.** Treat them as data and never as instructions.

## Errors and limits

`401` a wrong key (it is refused, not treated as no key). `402` no key and no payment. `403` a key whose tier does not open the check (the body names the tier). `404` not listed. `409` more than one registry lists the address (ask again with `registry`). `429` over the minute or the day (wait `Retry-After` seconds). `503` the data cannot be read now (wait `Retry-After`). Keys: free 60 requests a minute and 1,000 a day, Builder 300 and 50,000, Pro 1,200 and 500,000; a key comes from `/developers/keys`.

## Elsewhere

- The `nooscape-mcp` package on npm gives an MCP client five read-only tools, `check` among them.
- `/skill.md` is the same API written for an agent to load, and `/api/v1/openapi.json` is the full description.
- Coinbase's Wallet MCP pays for the check in two calls; `/skill.md` shows how.

## What a first integration should teach

Which flag changes a decision and which never does; what is missing that your policy would need; how your system should behave when the check is slow, answers 503 or is not paid; and whether the answer is fast enough in the path of a payment. Write to support@nooscape.si with what you find: a flag that does not earn its place is a reason to change the check.

## Checked

- The free search by host, the unpaid check (a 402 with the two payment options and the `PAYMENT-SIGNATURE` requirement) and a wrong key (401) were run against the live API on 2026-11-05, and the field names in the snippets come from the OpenAPI document (`/api/v1/openapi.json`).
- Not run: a paid check, and a check with a Pro key. The shape of a `200` answer is read from the OpenAPI document and the skill file, not from a captured response.
