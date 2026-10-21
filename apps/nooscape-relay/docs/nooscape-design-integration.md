# Nooscape cross-protocol design integration

> **Status — 2026-10-08:** This is a forward-looking architecture addendum. Current production has implemented source-scoped identities, collision reviews, evidence envelopes, approved A2A/catalog/census sources, and a manual-only Metaplex snapshot. Robinhood/ERC-8004, SATI, Arc, payment evidence, AGNTCY, and cross-chain canonical-linking remain separately gated future work; none is authorized by this document alone. See [AI handoff](./AI_HANDOFF_2026-10-08.md) for operational status.

This design addendum moves Nooscape from a protocol-neutral Atlas toward a **cross-chain evidence graph**. The important change is not adding more feeds. It is treating every discovery record, payment, liveness result, validator output, and publisher policy decision as a separate, attributable evidence object. A map node becomes a useful public record only when Nooscape can explain why it exists, which identities it represents, how fresh the observations are, and what it does not prove.

The current Nooscape ingestion architecture remains the base. This addendum changes the live-source priority, adds a conservative cross-chain deduplication layer, and introduces evidence tiers for the public map and future agent-facing API.

## Decisions to adopt now

Use **Solana, Robinhood Chain, and Arc** as the intended v1 coverage boundary. Arc means Circle’s chain 5042: it contributes first-party Archipelago service and settlement evidence, while external Arc directories require a machine-readable, permitted source contract. Base, BNB, and Ethereum mainnet should remain out of the initial hot path. Their data can be reconciled later once Nooscape has demonstrated that its canonical identity graph and review process work.

Model a canonical agent as a graph node with multiple identity records, not as a record copied from one registry. Cross-chain registrations, wallet addresses, domain proofs, A2A cards, MCP endpoints, and marketplace listings are evidence edges attached to that node. Exact cross-chain identifiers and verified endpoint or wallet overlap may merge records automatically. Name or description similarity can only create a **review candidate**. It must never merge two profiles on its own. This is the most important design rule in the repository and should be enforced in code. [5]

Adopt a public tier system, but make it explainable and multidimensional. Registration alone earns a discoverable identity record, not a trust claim. Economic activity, endpoint liveness, independent validation, third-party feedback, and persistence over time should be displayed as separate evidence dimensions. The tier is a conservative product filter over those dimensions, not a universal safety score.

Use Nooscape’s existing publisher-key lifecycle separately from trust tiers. An agent can have a valid on-chain identity, an active endpoint, and real settlement activity while remaining publisher-unverified. Conversely, a publisher-key allowlist is a policy decision and must not substitute for independent evidence. This preserves the meaning of the current allowlisted, expired, revoked, and unverified map states.

Keep Sigvara, Countersig, MCPShield, and agentclear behind explicit optional adapters. They are useful differentiated signals once live and independently auditable. They should not block the first external ingestion milestone, and a record originating from the same organization as Nooscape must not receive automatic Tier 0 status.

## Revised source order

The first operational source should be a small set of **approved A2A and ANP domains**, as described in the existing architecture. This proves the source registry, safe fetcher, raw observation store, endpoint health model, and operator review queue with low throughput and clear consent. A2A AgentCards commonly expose identity, skills, endpoints, and authentication metadata at a well-known URL; ANP supports domain-level JSON-LD catalogs with bounded pagination. [1] [2]

The first chain adapter should be **Robinhood Chain ERC-8004**. Index Identity Registry registration and URI-update events directly with a persisted block cursor. That yields a ground-truth identity stream and an agent registration file that may advertise A2A, MCP, DID, web, and other endpoints. The adapter should later add reputation and validation events, but no reputation score should be treated as a Nooscape score without preserving the event source and methodology. [3]

The first Solana milestone should ingest **Metaplex Agent Identity, SATI, and Solana Agent Registry** records only after their exact production program IDs, account schemas, and rate limits are confirmed from current sources. The useful design contribution is the expected cross-chain linking field: where a Solana record advertises a CAIP-2 or comparable identifier, Nooscape should use it as a high-confidence merge edge. Do not make a Solana program account count a trust signal by itself.

Add **x402 settlement evidence** after identity ingestion is working. A payment may support an economic-activity observation only when Nooscape can associate the recipient or payer with an already evidenced agent identity, endpoint, or published payment address. A transfer alone is not proof that an agent completed useful work, and a first-party payment source is not independent corroboration. Store raw transaction, chain, facilitator, asset, amount, timestamp, mapping method, and confidence. Keep payment volume separate from quality and safety assessments.

Treat an external **Arc directory or marketplace** as a P1 candidate, not an automatic live source. Do not ingest it until Nooscape has a machine-readable, permitted catalog contract and knows whether listings contain endpoint, network, facilitator, and payment-address information. Archipelago’s own Arc data is first-party and must remain visibly attributed. [6]

Add **AGNTCY ADS** after the first A2A/ANP and chain adapters. Its content-addressed directory records are valuable because Nooscape can retain a source CID and normalize from a stable payload, but it should remain a separate evidence class from an on-chain identity or an observed live endpoint. [4]

Third-party explorers and directories are valuable as census and reconciliation inputs. They should not be the only source of a user-facing identity. Assign them the source role `cross_check`, compare their counts and records to direct reads, and expose their freshness. This includes any explorer, analytics API, or marketplace that the design repository lists until its live terms and schema have been validated.

## Canonical record and deduplication rules

Each source observation creates one or more candidate identities. A candidate is normalized into a record containing protocol, source locator, external ID, registration coordinates, provider and operator metadata, endpoints, payment addresses, capabilities, raw-object digest, observed time, and parsing result. It is not yet a canonical Nooscape agent.

Nooscape should score **identity edges**, not people or names. A `registered_with` edge from an ERC-8004 or SATI registration document is high confidence. A shared verified domain or explicit payment address is high confidence when ownership proof exists. A shared wallet requires chain-aware semantics and should be marked medium confidence until it is bound by a registration document or endpoint-domain proof. An exact endpoint match is medium confidence because services can be shared. Fuzzy name or description similarity is low confidence and must enter `identity_merge_reviews` instead of mutating a canonical record.

The merge workflow should create a reversible canonical group. A reviewer can accept, reject, or split a group. Every decision needs a reason, evidence references, reviewer identity, and timestamp. The public profile can show a small “linked identities” count with the option to inspect its source records. It must not expose personal or operator data that is not public in the source record.

## Evidence tiers for the map

Keep the repository’s Tier 0–3 idea but make the criteria versioned and inspectable.

**Tier 0 — Corroborated** requires a strong registered identity or domain proof, a fresh endpoint or on-chain activity observation, and at least two independent evidence classes. Examples are on-chain identity plus verified domain plus settlement attribution, or A2A card plus domain proof plus independent validation. A first-party data source can satisfy at most one class.

**Tier 1 — Active** requires a valid identity or public discovery document plus a fresh liveness or activity signal. It is searchable and visible in focused maps, but it is not featured by default.

**Tier 2 — Registered** represents a parseable identity or discovery document with little or no corroboration. It remains searchable with a clear evidence gap label. It must not be hidden merely for being new.

**Tier 3 — Flagged or conflict** represents an explicit validation failure, revoked identity key, confirmed sybil cluster, or unresolved contradiction. Its profile stays auditable, but the default map should exclude it. A liveness timeout alone should lower freshness; it should not create a spam allegation.

Map state and tier must remain separate. The existing **publisher status** controls who is currently approved by a publisher-key policy. The **tier** controls how much independent evidence Nooscape has collected. The **source health** controls whether an adapter is operating. These three values answer different questions and must never be collapsed into one icon.

## Data model additions

The existing proposed tables need four additions from this design addendum.

`canonical_agents` becomes the stable public profile. `agent_identities` holds one row per external registration, address, DID, or verified domain. `identity_edges` records an asserted or inferred link between two identities, confidence, method, source observation, and status. `identity_merge_reviews` captures human decisions and guarantees that a mistaken merge is reversible.

`economic_activity_observations` stores actual settlement evidence. It references a raw chain event or source payload, an asset and amount, payer and recipient identifiers as publicly available, a facilitator if known, and a link-confidence field. It does not claim that a transaction represents completed work unless the protocol proves that separately.

`trust_policy_versions` stores the precise tier criteria active at a given time. `agent_tier_evaluations` records each assignment, its inputs, threshold outcome, and evaluation time. This gives the public methodology page and evidence exports a reproducible basis.

`source_claims` links first-party sources to their operator relationship. This prevents Archipelago or any future Nooscape-affiliated service from being treated as an independent corroborator. The relationship is public metadata, not a negative score.

## Connector and worker plan

Use one source registry and one adapter interface for all feeds. The first release needs adapters for `a2a`, `anp`, `erc8004`, `solana_registry`, `x402_settlement`, `marketplace_catalog`, and `agntcy`. Each adapter writes raw observations and normalized candidates; a separate identity resolver performs matching; tier evaluation runs only after the resolver completes. No adapter may write directly into the public Atlas read model.

Use short, idempotent jobs with a database cursor. An ERC-8004 adapter cursor is `(chain, registry, block_number, log_index)`. A Solana adapter cursor is `(program, slot, signature)` or the source’s own continuation token. A document adapter uses canonical URL, ETag, `Last-Modified`, and content hash. A marketplace adapter uses a provider-issued cursor or stable page checkpoint. Every job must be resumable without duplicating evidence.

The public Nooscape web project should invoke jobs through a scheduler and database coordination, not a long-lived loop in the application process. The current hosted runtime is suitable for bounded polling and cursor-based processing. If direct Solana settlement streaming or high-volume multi-chain log processing exceeds those limits, split only the worker into a queue-backed service. The API, database schema, evidence export format, and user-facing map remain unchanged.

No public endpoint should cause the server to fetch an arbitrary URL. Approved sources, permitted hosts, redirect rules, page caps, response-size limits, DNS and private-address blocking, and rate limits belong in the source registry and fetch layer. Agent endpoints should be read for metadata or health-checks only; Nooscape must not execute discovered tools, prompts, transactions, or payment requests during ingestion.

## First implementation slice

Build the persistence layer first. Add source registry, ingestion run, raw observation, canonical identity, identity edge, review queue, endpoint, publisher binding, settlement evidence, tier evaluation, and Atlas read-model tables. Replace the static seed records only after this layer has test fixtures and an admin-only source-registration flow.

Then build one approved-domain A2A/ANP adapter and the Robinhood ERC-8004 direct-log adapter. The acceptance test is not raw agent count. It is that a single known agent can show every source observation, source hash or transaction reference, normalized identity, merge rationale, publisher state, tier evaluation, and last-observed timestamp in the existing map drawer.

Next, add a Solana adapter after confirming the exact program contracts and account schemas. Add settlement attribution only after verified recipient or endpoint mapping exists. Finally, add Arc directory ingestion only after the catalog is machine-readable and formally allowed. Archipelago can be the first first-party source, with its operator relationship visibly labeled and its settlement records counted as one evidence class only.

## Items that must be verified before they become implementation commitments

This design material contains useful named sources, contracts, counts, rate limits, and market-size claims. Treat them as a technical shortlist, not source configuration. Before a connector is enabled, verify its current API specification, access terms, rate limits, chain deployment, event schema, data ownership, and whether the source permits indexing or redistribution.

In particular, confirm the exact Robinhood Chain ERC-8004 registry deployments and RPC access, current QuickNode API contract, live Solana registry program IDs and account layouts, x402 facilitator settlement semantics, Arc directory endpoint and crawl policy, and whether any listed third-party service provides a contractual programmatic feed. The existing official A2A, ANP, AGNTCY, and ERC-8004 specifications are solid protocol anchors; the concrete ecosystem integrations require a connector-by-connector verification pass. [1] [2] [3] [4]

## Recommended next decision

Approve a **two-source pilot**: one owned or partner A2A/ANP domain and one Robinhood ERC-8004 registry deployment. In parallel, document Archipelago’s Arc discovery and payment-attribution contract and confirm the exact Solana source contracts. That sequence delivers real, auditable records quickly while preventing the project from becoming dependent on unverified third-party indexers or raw payment heuristics.

## References

[1]: https://agent2agent.info/docs/topics/agent-discovery/ "A2A Agent Discovery"
[2]: https://agent-network-protocol.com/specs/1.1/agent-discovery "ANP Agent Discovery Protocol Specification"
[3]: https://eips.ethereum.org/EIPS/eip-8004 "ERC-8004 Trustless Agents"
[4]: https://docs.agntcy.org/dir/directory-gui/ "AGNTCY Agent Directory Service Architecture"
[5]: https://github.com/RunTimeAdmin/nooscape/blob/main/AGENT_TRUST_TIER_DESIGN.md "Agent Directory Trust-Tiered Design"
[6]: https://github.com/RunTimeAdmin/nooscape/blob/main/ARC_MARKETPLACE_LISTING.md "Arc Marketplace Listing"
