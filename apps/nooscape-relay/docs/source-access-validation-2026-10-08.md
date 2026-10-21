# Source access validation — SATI, DAS providers, Robinhood/QuickNode/Arc, x402 endpoints

**Validated:** 2026-10-08 (method: desk research + bounded read-only HTTP probes)
**Current decision:** **No source was activated, no payment was made, and no public state changed.** This record closes the *access-questions* half of `todo.md` #19. Each source's access model is now documented with live probe evidence; payment-gated surfaces remain blocked; the deferred Metaplex DAS cross-check has a concrete provider candidate.

**Addendum (same day):** §7 records a later bounded probe of AgentRank (Crest Deployment Systems LLC), a settlement-grounded x402 reputation service surfaced after the original sweep — **rejected: retired, no callable surface.**

Access validation is **not** source approval. Activating any source still requires an [external source approval record](./external-source-approval-template.md), a bounded review run, and explicit operator decisions about public projection.

## Method and boundaries

- Desk research: official docs, npm registry, OpenAPI specs, product pages (list in Sources).
- Probes: HTTP `GET` only, `User-Agent: nooscape-validation/1.0`, 20–25 s timeouts. No payment signature, no write, no tool invocation, no wallet access, no transaction.
- The one 402 challenge read (Arc Agents) executed only step 1 of the provider's own documented unauthenticated flow: `GET` without `PAYMENT-SIGNATURE` → 402. Nothing was paid or signed.
- Raw probe outputs were retained privately during validation and removed from the working tree; this memo keeps only status codes and short factual summaries.

## Source-by-source result

### 1. SATI — Solana Agent Trust Infrastructure

| Item | Validated state |
|---|---|
| Docs surface | `docs.sati.cascade.fyi` served `llms.txt` (HTTP 200); read-only guide and REST reference retrieved |
| SDK (npm) | `@cascade-fyi/sati-sdk` latest `0.15.1` (registry modified 2026-03-05) |
| Read-only mode | Documented: `new Sati({ network: "mainnet" })` — "No signer, no keys. All read operations work immediately." |
| Public REST API | `https://sati.cascade.fyi` — keyless; `network=mainnet\|devnet`; endpoints for agents, reputation, scores, feedback, badge, stats |
| Live probe — stats | `GET /api/stats?network=mainnet` → **200**, `{"totalAgents":153, "isImmutable":false, ...}` |
| Live probe — list | `GET /api/agents?network=mainnet&limit=1` → **500** twice; error body decodes to Solana RPC **"Too Many Requests"** (upstream rate limit surfaces as 500) |

**Decision:** read-only access is validated and usable for a future bounded review (prefer `/api/stats` and per-agent reads). The agents list endpoint is unreliable right now due to their upstream RPC throttling — do not build on it until fixed. Note a census discrepancy worth reconciling in any review: the third-party Agent Economy census counts ~1,542 SATI agents, while SATI's own `/api/stats` reports 153 — reconcile methodology before using either number publicly.

### 2. DAS providers (for the deferred Metaplex cross-check)

| Provider | Access model (validated) |
|---|---|
| QuickNode DAS | Free tier **10,000 requests/month at 2 RPS**; paid from $10/mo (Essential 50K) and $49/mo (Premium); key issued per QuickNode endpoint |
| Helius / Alchemy | Keyed DAS providers with free or trial tiers |

Metaplex documentation URLs returned HTTP 403 to automated fetchers at validation time; the DAS spec should be reviewed manually in a browser when the cross-check is designed.

**Decision:** the cross-check stays deferred (roadmap item). When approved, the lowest-friction candidate is a keyed provider's free tier owned by the operator. A cross-check validates response semantics against the existing 7 Metaplex Tier 2 records; it must **not** upgrade or schedule them.

### 3. Robinhood Chain RPC + QuickNode ERC-8004 coverage

| Item | Validated state |
|---|---|
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` → `eth_chainId` **0x1237 (4663 ✓)** |
| RPC terms | Public endpoint is rate-limited and not for production; keyed providers (Alchemy, QuickNode, Chainstack, dRPC, Blockdaemon, etc.) required for production/archive reads per Robinhood docs |
| QuickNode ERC-8004 service | `healthz` → **200** `{"status":"ok"}` |
| QuickNode access model | REST paywalled per call via **x402 USDC micropayments on Base**; JSON-RPC via QuickNode marketplace add-on on an existing endpoint. **No free REST tier.** |
| Robinhood coverage | **Confirmed.** `/networks/robinhood-mainnet` exists; the contracts page lists Identity, Reputation, and Validation registries on Robinhood Chain Mainnet **and** Testnet |

Robinhood Chain mainnet registry addresses (published by QuickNode): Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, Validation `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`. Testnet equivalents are also published. Registries are **CREATE2-deterministic** (byte-identical across mainnets); exact per-registry deploy blocks and ABIs come from the linked `config/chains.yml`. QuickNode notes the Validation registry on Robinhood deployed much later than Identity/Reputation.

**Decision:** the paid QuickNode REST surface stays behind its x402 gate — **blocked without explicit user authorization**. If Robinhood ERC-8004 ingestion is ever approved, the free path that avoids the payment gate entirely is direct registry event reads over an owned (keyed) Robinhood RPC endpoint, per the "direct RPC indexing (ground truth)" policy. The QuickNode explorer then serves as a cross-check reference only.

### 4. Arc RPC + Arc ERC-8004 Explorer (arcagents.app)

| Item | Validated state |
|---|---|
| Public RPC | `https://rpc.mainnet.arc.io` → `eth_chainId` **0x13b2 (5042 ✓)**; WebSocket and provider endpoints documented |
| Site | `arcagents.app` → **308** → `www.arcagents.app`; explorer UI is public read-only |
| API contract | `GET /openapi.json` → **200**; OpenAPI 3.1, version 1.4.0: *"Read-only public API… **Paid x402 endpoint only.** No write operations."* |
| Paid endpoint | `GET /api/agent/paid?network=mainnet&agentId=…` — **0.01 USDC per successful request**, x402 Version 2, Circle Gateway Nanopayments |
| Live 402 probe | Without a payment signature: **HTTP 402** with a `PAYMENT-REQUIRED` header; `accepts[]` offers payment on Arc 5042, Base 8453, or Arbitrum One 42161 (USDC; amount `10000` = 0.01 USDC, `GatewayWalletBatched`, verifying contract `0x7777…1000eE`); ERC-8004 data always resolves from Arc Mainnet |
| Semantics | `network=testnet` → 400; unknown agentId → 404; no free JSON API for any other path (SPA HTML fallback) |

**Decision:** confirmed that the Arc explorer's only machine surface is the x402-paid resolver — its `$0.01/call via Circle Gateway` claim is now verified against the live endpoint. It stays behind its documented payment gate; no payment made. If Arc agent data is ever needed, the free alternative is direct Arc registry reads over the public/keyed Arc RPC (correction, 2026-10-08: all three registries are deployed on Arc Mainnet — the registries are CREATE2-deterministic and the Validation registry address `0x8004Cc84…` returns bytecode identical to the Identity registry, verified via `eth_getCode`).

### 5. x402stats.io — ecosystem stats

`GET /api/stats` → **200**, JSON ~60 KB, `updatedAt 2026-10-08T20:03Z` at probe time. Free survey endpoint verified live (paid x402 variants exist per earlier research). **Decision:** usable as a free census cross-check reference when a review calls for one; not activated.

### 6. x402scan — read-only telemetry

`GET /v1/stats/ecosystem` → **200**, JSON (24 h window; e.g., Base ≈104,943 txs at probe). Agent-card declares `"scheme":"none"` — *"Public read-only telemetry; no authentication required."* **Decision:** usable as a free ecosystem-telemetry reference; not activated.

### 7. AgentRank — settlement-grounded x402 reputation (Crest Deployment Systems LLC)

| Item | Validated state |
|---|---|
| What it was | 0–1000 reputation for x402/A2A counterparties: score recomputed from real on-chain USDC settlement weighted by payer standing (not self-reported feedback). Shipped Ed25519-signed verification receipts verifiable offline, a `verify-before-pay` npm guard (payer side) + `require-rank` (provider side), and a platform-verifier `POST /verify/batch` mode (≤100 subjects; permissive/cautious/strict policies). Includes a preregistered "counterfeit verifiability" study (~2,600 payment decisions). |
| Repo | `github.com/andysalvo/agentrank` — **archived**; description: *"Retired. … The hosted service no longer runs."* The founding paper, methodology, and index remain in-repo. The GitHub org `crestds` exists with 0 public repos. |
| Live probe | `https://agentrank.info` → request timeout; `https://api.agentrank.info` → connection timeout (dial timeout to `167.71.254.98:443`) |
| npm footprint | `verify-before-pay` `0.1.2` (2026-06-30, MIT) remains published, pointed at the dead default `apiBase` `https://api.agentrank.info` |
| Listing signal | The A2A Registry listing still shows scheduled health checks **"passed"** every ~30 min up to probe time while both hosts are unreachable — a stale listing on a dead service |

**Decision: rejected — do not ingest.** There is no callable surface, and the npm tooling defaults to a dead API base. Do not re-chase unless the project un-retires and the hosts respond. Two takeaways retained: (1) patterns worth studying for our own trust surface — signed per-record receipts, batch allow/caution/deny policies for directory-scale screening, "no score without a receipt"; (2) a cautionary lesson — its receipt-verification key was served only from the live host, so third-party verification died with the service (durable key publication matters). Sibling hosted services under the same account (`supership-scan`, `agentic-platform`) are archived with the same retirement wording.

**Why it retired (added after a follow-up pass):** no public explanation exists — repo files, all 14 commits, the open issues, gists, the publisher profile, and web search contain no statement; the retirement is only the archived-description edit applied to a batch on 2026-08-29 (three services, identical wording). The internal record points one way: `docs/DEMAND_INITIATIVE.md` (last planning doc, 2026-06-29) pre-committed the kill condition — a one-week distribution test gated at ≥3 ref-attributed real external calls, else *"it is the market, freeze building and pivot."* Measured demand then was ~4.5 real calls/day from four sources; their own diagnosis: *"verification is a derived need."* Last commit 2026-06-30, retirement batch 2026-08-29 — consistent with a market-not-here wind-down rather than a failure shutdown. A local mirror of the archived repo (commit `7b19fa9`) is retained for reference.

## Gates that remain in force

1. **No payments without explicit authorization.** QuickNode ERC-8004 REST (x402 per call) and the Arc Agents resolver (0.01 USDC/call) are the two payment-gated surfaces encountered; both stay blocked.
2. **No source activation.** No adapters, no scheduling, no evidence envelopes, no public projection changes were made. Public state remains 58 records (48 catalog + 7 Solana registry + 3 A2A).
3. **Metaplex records untouched.** The 7 Tier 2 records remain `manual_only`; the DAS cross-check remains a separate future workstream.
4. **Rate limits are real.** The SATI list-endpoint 500 demonstrates upstream throttling; any future adapter must respect provider quotas and treat 5xx-rate-limit ambiguity as failure, not retry-until-success.

## Recommended next steps (in order)

1. **Metaplex DAS cross-check (roadmap item 4):** choose a keyed DAS provider (QuickNode DAS free tier candidate), validate semantics against the 7 records in a bounded review — no upgrades, no scheduling.
2. **SATI (roadmap item 5):** a bounded review can rely on `/api/stats` + per-agent reads; avoid the list endpoint until its RPC throttling is resolved; reconcile the census discrepancy.
3. **Robinhood ERC-8004:** prefer the free direct-RPC path (published registry addresses) over the paid QuickNode REST when ingestion is eventually considered.
4. **Arc:** remains gated and out of scope; revisit only with a specific product need and an approved payment or direct-RPC design.
5. **x402stats / x402scan:** available as free cross-check references for future reviews.

## Sources consulted

- SATI: [docs llms.txt](https://docs.sati.cascade.fyi/llms.txt), [Query Reputation guide](https://docs.sati.cascade.fyi/guides/query-reputation.md), [REST API reference](https://docs.sati.cascade.fyi/reference/rest-api.md), [npm @cascade-fyi/sati-sdk](https://www.npmjs.com/package/@cascade-fyi/sati-sdk), live `sati.cascade.fyi` probes
- QuickNode: [ERC-8004 llms.txt](https://erc-8004.quicknode.com/llms.txt), [/networks](https://erc-8004.quicknode.com/networks), [/docs/contracts](https://erc-8004.quicknode.com/docs/contracts), [/healthz](https://erc-8004.quicknode.com/healthz), [marketplace add-on](https://marketplace.quicknode.com/add-on/erc-8004-api-agent-discovery-and-reputation)
- Robinhood: [Chain connection docs](https://docs.robinhood.com/chain/connecting); live `rpc.mainnet.chain.robinhood.com` probe
- Arc: [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc); live `rpc.mainnet.arc.io` probe; `www.arcagents.app/openapi.json`; live 402 challenge probe
- x402: [x402stats.io](https://x402stats.io/api/stats); `x402scan.achivx.com` (`/v1/stats/ecosystem`, `.well-known/agent-card.json`)
- AgentRank: [andysalvo/agentrank](https://github.com/andysalvo/agentrank) (archived 2026-08; retirement notice), [npm verify-before-pay](https://registry.npmjs.org/verify-before-pay), [a2aregistry.org listing](https://a2aregistry.org/agents/2cecf0e3-2da4-48c2-9f99-e8214e8c78dd/), GitHub API (`crestds` org, `andysalvo` repos); live `agentrank.info` / `api.agentrank.info` probes
- Internal: `INGEST_POINTS.md` (§1.5, §1.6), `ARC_INGEST_RESEARCH.md`, `ARCHIPELAGO_X402.md`, [Metaplex registry validation](./metaplex-solana-registry-validation-2026-10-08.md)
