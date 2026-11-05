# Growing Tier 3 with outside operators: options (2026-11-05)

> **Status:** Options for the operator's decision. Option A is built (the page `/domain-control`, 2026-11-05) and option D is sized (the section after the options); nothing else is built. From item 5 of the outside list of 4 November 2026 ("grow Tier 3 with outside operators, a domain-control self-serve flow: the evidence model needs real participants"). Written first, as the triage of the list said it should be, because a self-serve flow touches a published promise (every tier change is operator-gated) and should be chosen before it is coded.

## Where Tier 3 stands

- **One record is Tier 3 of 76:** the Nooscape Observatory, verified by the operator on 8 October 2026 against the operator's own domain. The other 75 reviewed records are Tier 2 (48 catalog, 18 ERC-8004 on Robinhood Chain, 7 Solana registry, 2 A2A). The listed entries (61,292 on the API's count of 5 November) have no tier.
- **Its window is 90 days** (see [domain-control verification](./domain-control-verification.md)): it runs to about 6 January 2027 unless a recheck has renewed it since. The operator ledger shows the date. Left alone, the one Tier 3 record falls back to Tier 2.
- **The flow today needs the operator at three steps.** The operator picks a reviewed record whose domain is already asserted and creates a 48-hour challenge. The outside operator publishes the one-time token at `https://<domain>/.well-known/nooscape-domain-verification/<challenge-id>.txt`. The operator triggers the single fetch (no redirects, 4 KiB cap, the shared safe fetch), and later rechecks to renew. Only reviewed (Tier 2) records can be upgraded.
- **The promise.** The tier scale says every tier change is operator-gated and leaves an immutable evidence event, and `/developers` says so in its own words.

## What actually limits growth

1. **The pool is small and has no channel.** Seventy-five reviewed records, most from catalogs, and no page or address where one of their operators could ask for Tier 3. The flow exists; nobody outside knows to use it.
2. **Each upgrade costs the operator three actions,** and renewal costs one more every 90 days.
3. **The token is Nooscape's own.** An owner has to do something only for Nooscape. For ERC-8004 agents the standard already defines a proof the owner may have published for everyone (below).

## What the standard already offers

ERC-8004 has an optional endpoint-domain verification: an agent may publish `https://{endpoint-domain}/.well-known/agent-registration.json` with a `registrations` list, and a user may treat the domain as verified when an entry names the on-chain agent (`agentRegistry` and `agentId`). Where the endpoint domain is the one that serves the agent's own registration file, no extra check is needed.

**A first look.** A sample of 34 endpoint hosts of listed agents found six that publish a file naming the listed agent, about one in six. The sizing after the options replaces it with a larger sample.

## Options

| | What it is | Gating | Cost | Risk |
|---|---|---|---|---|
| **A. Stay operator-run, and invite** | Keep the flow. Add a short "verify your domain" page that says what an owner does and where to ask, and link it from a reviewed record. The operator invites the few operators worth asking. | Unchanged | Small: one page and a link | None to the promise. Growth depends on outreach, which is the operator's. |
| **B. Owner starts, operator approves** | An owner asks for a challenge for their reviewed record; the operator approves it in the ledger; the owner publishes the token and triggers the check themselves, within limits. | Operator-gated at the approval | Medium: a request state, one public call with limits, an approval list in `/admin/sources` | A new public call that makes Nooscape fetch a third-party domain. Bounded by "already asserted by a reviewed record" and one open challenge per record. |
| **C. Fully self-serve, by rule** | The owner runs it end to end. A passing proof upgrades the record at once, a scheduled recheck renews or revokes, and every change leaves the same signed evidence event. | **Changes** from "operator-gated" to "rule-gated and logged" | Medium to large: public calls, rate limits, a scheduled job, the page, a tier scale v2, the `/developers` wording, tests | Gives up a published promise. Needs per-record and per-domain cooldowns and a daily cap so it cannot be used to aim fetches at someone. |
| **D. Read the standard's proof** | For ERC-8004 entries, fetch the standard's file on a schedule and record a dated observation: "the endpoint domain's file names this agent, read on DATE". No Nooscape token and no outreach. It is a fact with a date, like the other facts, and not a tier change. Accepting it as the Tier 3 proof for a reviewed record would be a later, separate step and a change to the tier scale. | Unchanged (it is an observation) | Medium: a bounded reader, one table, a field on the agent record and the check, tests | Many outbound requests to hosts Nooscape does not know. Needs a per-run cap, a cooldown per host, no retries, no redirects, a clear user agent, and the shared safe fetch. Platform domains (an app host's subdomain) prove control of that app and nothing wider; the wording has to say so. |
| **E. Wait for demand** | Do nothing until two outside operators ask. | Unchanged | None | The evidence model keeps one self-owned Tier 3 record and the claim that "outside participants" matter stays unproved. |

None of these adds a score, a ranking or a verdict. A verified domain says that the domain's operator published the proof, and what the Tier 3 record says today: not a legal entity, not a publisher key, not that the endpoint is safe.

## Option D, sized (2026-11-05)

**Method.** A throwaway script: nothing is stored in the repository and nothing in the app changes. It collected listed entries from the public search (44 generic terms on each of six EVM chains, 25 results each: 1,475 distinct entries), then read each distinct public host's `/.well-known/agent-registration.json` once, over HTTPS, with no redirect, a 16 KiB cap and a 6 second timeout. It counted the file as a proof only when a `registrations` entry named the chain and the agent id that Nooscape lists for that host. One request per host, from a user agent that names its sender and points at the contact page. Solana entries cannot use this proof and were left out.

**What it found.**

| | Count | Share |
|---|---|---|
| Entries with a locator host at all | 569 of 1,475 | 39% |
| Distinct hosts probed | 213 | |
| Hosts whose file names a listed agent of that host | 61 | 29% (95% interval 23 to 35) |
| Hosts with a file that names none of their listed agents | 3 | 1% |
| Hosts that answered 404 | 79 | 37% |
| Hosts that returned a page that is not JSON, or JSON without a `registrations` list | 21 | 10% |
| Hosts skipped because the name is not public | 18 | 8% |
| All other answers (refusals, errors, redirects, no answer) | 31 | 15% |
| Entries named by their own host's file | 79 of 1,475 | 5.4% of all, 13.9% of those with a host |

By chain (a host listed on two chains is counted on both):

| Chain | Entries in the sample | With a locator host | Named by their host's file | Hosts | Hosts whose file names a listed agent |
|---|---|---|---|---|---|
| Robinhood Chain | 245 | 214 | 13 (5.3%) | 22 | 4 |
| BNB Chain | 251 | 50 | 6 (2.4%) | 26 | 7 |
| Ethereum | 269 | 90 | 4 (1.5%) | 36 | 4 |
| Base | 568 | 157 | 47 (8.3%) | 115 | 45 |
| Arc | 100 | 29 | 5 (5.0%) | 19 | 5 |
| Monad | 42 | 29 | 4 (9.5%) | 11 | 2 |

**Who publishes.** The hosts that publish the file are small: the 61 of them account for 79 entries, about 1.3 each. The four hosts with the most entries in the sample (30 to 45 each) publish nothing: they answered 404 or returned a page that is not JSON. The publishers are individual operators acting on their own, which is the kind of outside participant the evidence model wants, and no outreach was needed. Base has the highest share (45 of 115 hosts). Whether tooling or a template writes the file there was not checked.

**What it means.**

- **Coverage.** Weighted by each chain's listed entries (43,364 on 5 November), about 2,200 listed EVM entries, roughly 5% (from about 1,400 to 3,500), sit on a host that already names them. The sample is a harvest by search term and not a random draw (Robinhood Chain is 245 of its 21,403 entries, on 22 hosts), so read the figure as an order of magnitude.
- **Reach.** The proof can only speak for an entry that has a locator host: 39% of the sample. For the rest, whose locator is an IPFS or `data:` address or has no HTTPS endpoint, it says nothing.
- **Load.** The sample had 0.37 distinct hosts for each entry with a host. At that rate a full pass is about 6,000 hosts and one request each, which is about 30 hours at 200 hosts an hour.

**Read.** D is worth building as a dated fact for the entries it covers, with the limits in the table above (a cap on each run, a cooldown for each host, no retries, no redirects, the shared safe fetch). It is no substitute for A: it covers about 5% of the listed EVM entries. Accepting the standard's file as the Tier 3 proof for a reviewed record is a separate, later step and a change to the tier scale.

**Not done.** An exact count needs the listed entries with their hosts straight from the database (one read-only query, run by the operator); the harvest could only reach what the public search returns.

## Recommendation

1. **Do A now (built on 2026-11-05).** It is the cheapest way to find out whether any outside operator wants Tier 3, it needs no change to the promise, and it gives the invitation somewhere to point.
2. **Size D before building it (done on 2026-11-05).** The sizing above found that 29% of the sampled hosts publish the file and that about 5% of the listed EVM entries sit on a host that names them. That is enough to build D as a dated fact when the operator chooses; an exact count is optional.
3. **Hold B until a real operator asks for Tier 3,** and hold C. C is the only option that gives up the operator gate, and the evidence for it would be an operator who was turned away by the gate.
4. **Renew the one Tier 3 record before 6 January 2027** (a recheck in the ledger), whatever is chosen.

## Decision wanted

Which of B to E. A is built and D is sized; D itself needs a go before it is built. B and C are the operator's call because they change who can start a fetch or what the gate means.

## Not checked

- The count of reviewed records with an asserted HTTPS domain (the eligible pool). The ledger shows it and the public records do not.
- The Tier 3 record's current window; the 6 January figure is the backfill's date and a recheck may have moved it.
- The exact share. The sizing is a sample of 213 hosts and 1,475 entries from the public search, not the full list, which only the database holds. Why Base hosts publish the file so often (a tool or a template may write it for them) was not looked at.
- The wording of the standard beyond the endpoint-domain section quoted above (read on 2026-11-05 from the EIP text).
