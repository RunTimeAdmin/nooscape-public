# Nooscape live-data implementation plan

> **Status — 2026-10-12:** The reviewed spine is unchanged — **82 public source-scoped records** (81 Tier 2 / unverified + 1 Tier 3; 100% persisted-evidence coverage; 0 publisher-verified) — and the chain-fact era has shipped around it: the acknowledged directory layer (226,256 entries across four protocols), the Robinhood identity/registrant/activity/reputation walks (all genesis-complete or forward-cursor-live; the reputation ledger reconciled at 642 ratings + 137 revocations with its public per-rating read surface shipped 2026-10-12), the Metaplex and 8004-solana state-diff passes, the USDG settlement rail (7,417 measured), and cross-chain twin links (migration 0028). Current runbook: [AI_HANDOFF_2026-10-12](./AI_HANDOFF_2026-10-12.md).
>
> **Historical snapshot — 2026-10-08:** Core live-data implementation completed under bounded, review-gated controls: **82 public records — 81 Tier 2 / unverified plus 1 Tier 3** (the self-owned Nooscape Observatory pilot) with 100% persisted-evidence coverage; the manual-only Robinhood ERC-8004 identity pilot had just completed its first bounded run and projection (24 records), and the served tier scale was published as **[evidence-tier-v1](./evidence-tier-scale-v1-2026-10-08.md)** — evidence levels, not scores, with the Tier 3 upgrade time-boxed (90-day validity, card pin, operator recheck).

## Current public population

| Protocol / source class | Public records | Evidence and trust state |
|---|---:|---|
| Agenstry public federation catalog | 48 | Source-scoped catalog metadata; Tier 2 / unverified |
| Metaplex Solana registry | 7 | Manual-only bounded registry metadata; Tier 2 / unverified |
| Robinhood Chain ERC-8004 identity registry | 24 | Manual-only bounded on-chain registration events (event-only evidence); Tier 2 / unverified |
| Approved A2A AgentCards | 3 | Direct bounded AgentCard observations; 2 Tier 2 / unverified + 1 Tier 3 domain-control verified (self-owned Nooscape Observatory pilot) |
| Agent Economy census | 0 agent profiles | Aggregate `/context` only; retained attributed context |
| **Total** | **82** | **82/82 provenance-ready signed evidence envelopes** |

The Atlas hero reports the live per-protocol population (A2A 3, Catalog 48, Solana Registry 7, ERC-8004 24). Its main filter intentionally separates all records, publisher-verified live records, and unverified Tier 2 live records (currently 81, after the completed self-owned domain-control pilot). The publisher-verified count is zero and must remain truthful until a consented publisher-key process succeeds.

## Completed operating milestones

### Source review, immutable evidence, and public projection

1. Production MySQL persistence, private RustFS Object Lock storage, source review, operator authentication, and evidence sealing are enabled.
2. Every public source projection requires: explicit source approval, a bounded run, retained raw evidence, hash/governance-retention review, and an explicit source projection decision.
3. The public evidence verifier accepts only the active pinned Nooscape relay key and key ID. Illustrative seed data is intentionally rejected as Nooscape verification.
4. The latest-run evidence-review route validates the complete latest completed run, with a 48-observation maximum, instead of silently using an arbitrary mixed historical sample. The control plane surfaces the same review as a per-source **Verify evidence** action on `/admin/sources` (this commit): it re-reads the run's stored objects server-side and shows per-object SHA-256 match state, Object Lock mode and `retainUntil`, and problem-entry flags inline.
5. The **reviewed-run publication gate** is live: a `public` projection decision names its approved completed run (`approvedRunId`), and public snapshots are linked to that run's observations via `source_observation_runs`. Unreviewed runs stay withheld, records not re-observed in the approved run retire, and the last approved version stays visible until a later run is explicitly approved. Activation on 2026-10-08 preserved all 58 records exactly (identical handles; 58/58 coverage); the migration was applied through the one-time bridge, which was then removed (`674a4c8`). See [reviewed-run publication gate](./reviewed-run-publication-gate-2026-10-08.md).

### Identity and projection remediation

1. Production migrations `0006_next_proudstar.sql`, `0007_slim_hex.sql`, and `0008_nostalgic_karen_page.sql` (reviewed-run gate) are applied.
2. Strong immutable identities prevent display-name collisions: A2A AgentCard URL, catalog `sourceId:recordId`, and Solana mint are separate identity anchors.
3. Public views are source-scoped snapshots tied to approved source projection decisions, not mutable global agent fields.
4. The one-time migration bridge was removed after completion; its route now returns `NOT_FOUND`.

### Bounded source intake

- **A2A:** Three reviewed AgentCard sources were replayed through source-scoped persistence and explicitly reprojected after hash/retention checks.
- **Agenstry:** The original 12-record pilot was followed by an expanded, one-shot manual snapshot. The latest run scanned 3,478 feed entries, accepted 48 provider-diverse records, and rejected 3,410. All 48 retained objects passed SHA-256 and Object Lock governance-retention review before public projection.
- **Metaplex:** One dedicated manual fixed-page review fetched 24 index entries, accepted 7 structurally eligible records, and projected all seven only after retained-evidence review. The source remains `manual_only`.
- **Agent Economy:** Aggregate census evidence is retained and rendered only as bounded ecosystem context. It never creates an agent identity, trust score, or profile.

### Consent-gated evidence-tier upgrades

1. The domain-control Tier 3 pathway is implemented: per-challenge one-time tokens, a public `.well-known` proof file, private retained proof bytes, and a signed `DOMAIN_CONTROL_VERIFIED` evidence entry.
2. The first consented pilot (self-owned Nooscape Observatory, `nooscape.si`) completed on 2026-10-08 and is the first public Tier 3 record; publisher state remains `unverified`.
3. Public record projections overlay the live per-agent evidence governance (tier and publisher state) maintained by operator-gated flows, so an approved upgrade is never hidden behind projection-time snapshot defaults.
4. The tier scale is published and versioned as **evidence-tier-v1**: `tier_2` approved-source record (baseline) → `tier_3` domain-control verified → `tier_4` publisher-key allowlisted; `tier_0`/`tier_1` are reserved. The `/developers` reference documents this scale and the real record shape; all un-implemented 0–100 score artifacts were removed.
5. Domain-control verification is **not permanent**: a granted upgrade is valid for **90 days**, is **pinned to the verified public card** (SHA-256 fingerprint), and is renewed only by an operator **recheck** that re-fetches the live proof. A failed recheck — or an elapsed window / changed card at read time — returns the record to Tier 2 fail-closed (`DOMAIN_CONTROL_REVOKED`). Migration 0009 (five columns + backfill) was applied through the one-time operator bridge, which was then removed (`9d186fa`; the route returns HTTP 404).

### Public surface bounds

1. The public surface is per-client rate-limited (`server/rateLimit.ts`; fixed 5-minute windows): 600 requests on `/api/trpc` and 120 on `/manus-storage`; excess requests get HTTP 429 with `Retry-After`.
2. Request bodies are capped at **1 MB** (JSON) and **100 KB** (urlencoded), down from 50 MB. The largest legitimate body is a 256 KB evidence packet and the storage proxy is GET-only (presigned redirects), so no flow is affected.
3. Production responses carry HSTS (`max-age=31536000`; **`includeSubDomains` added 2026-10-12 in `698fc13`** — safe because www is the only published subdomain and serves HTTPS-only), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/microphone/geolocation off), and a strict CSP whose inline-script hashes are derived from the served HTML at startup; `X-Powered-By` is disabled. Unknown paths now return honest 404s (the SPA fallback matches only the real client routes, `server/clientRoutes.ts`, reading the path from `req.originalUrl` because express 4 wildcard mounts rewrite `req.path`), and unknown tRPC procedures answer a generic `Not found.` without naming the route.
4. The seed-only `/atlas.summarizeComparison` AI brief stays public but hard-bounded: at most 15 cached seed pairs (cached answers never call the model), 10 requests / 15 min per client, and an IP-independent budget of 100 real LLM calls per UTC day. It currently answers with a graceful `OPENAI_API_KEY is not configured` error in production; enabling the key is an operator cost decision. Shipped in `7962b85` — see [public-surface hardening](./public-surface-hardening-2026-10-08.md). **Removed 2026-10-17:** the procedure and the demo atlas it served are deleted (consulting review stage 3).

## Scheduled worker boundary

The host invokes the protected worker tick every 15 minutes. The database enforces a 15-minute global claim interval and a maximum of two due sources per tick (raised from one by migration 0027, 2026-10-12). The scheduled worker may run only approved scheduled-policy sources: `a2a`, `catalog`, `census`, the `erc8004` identity/activity forward walk (scheduled since 0017, 2026-10-11), the Metaplex `solana_registry` chain pass (scheduled since 0021), and the `solana_8004` chain pass (scheduled since 0027, 30-minute cadence). Manual-only protocols (`erc8004_reputation`, `usdg_settlement`) are rejected by the worker by design until each earns its own reviewed policy flip.

Each source controls its own daily cadence and can be paused/rejected independently. The worker is a bounded metadata collector, never an arbitrary fetcher or agent execution path.

Every boundary fetch — the ingestion adapters and domain-control verification — re-resolves DNS at fetch time and rejects private, loopback, link-local, multicast, reserved, and metadata answers through one shared guard (`server/netGuard.ts`) that parses every textual IPv6 form and fails closed on unparseable input. Shipped in `d85a131` — see [fetch-boundary hardening](./fetch-boundary-hardening-2026-10-08.md).

## Remaining governance and source milestones

1. **Worker observation:** monitor scheduled source status and pause immediately on unexpected fetches, rejected payloads, retention failures, or access-control errors. After each scheduled run, the operator reviews the latest run and explicitly re-publishes (or leaves records withheld); visibility never advances automatically.
2. **Domain control:** the first consented pilot (self-owned Nooscape Observatory) completed on 2026-10-08 and projects as Tier 3 with publisher state unverified. Any further Tier 3 challenge still requires the participating domain operator’s permission; domain control does not prove legal ownership or service safety. Existing verifications must be **rechecked before their 90-day window lapses** (pilot expiry ≈ 2027-01-06), and a changed public card requires a successful recheck to re-pin evidence.
3. **Publisher key:** stage a Tier 4 proposal only with publisher consent, a valid Ed25519 attestation, retained proof, and a second Nooscape operator approval.
4. **Metaplex cross-check:** validate a DAS/on-chain provider and separately review a cross-check design before using it. Do not schedule Metaplex or upgrade existing records on the index alone.
5. **Additional sources:** SATI, Robinhood/ERC-8004, Arc, QuickNode, and x402scan each need independent source, access, rate-limit, terms, and payment review. Access validation completed 2026-10-08 ([source access validation](./source-access-validation-2026-10-08.md)): SATI read-only access works (list endpoint currently throttled upstream); Robinhood ERC-8004 coverage confirmed with a free direct-RPC path; the Arc resolver is paid-only; x402stats/x402scan are free read-only references. Payment-gated sources remain blocked without explicit user authorization. The bounded Robinhood Chain ERC-8004 identity pilot completed its full lifecycle (24 reviewed records); **superseded 2026-10-12:** the deferred workstreams named here — backfill-cursor checkpointing, Transfer/URI tracking, and the Reputation Registry — have all shipped: `bf:`/`rb:` walks reached genesis, the `ac:` activity ledger and anchored `fw:` forward cursor are live (identity walk scheduled since 0017), and the reputation ledger is genesis-complete, reconciled (642/137), and publicly surfaced per-rating (`5fc6be8`; see [reputation-ingest](./reputation-ingest-2026-10-11.md)). The Metaplex and 8004-solana state-diff passes followed the same pattern ([solana-metaplex-chain](./solana-metaplex-chain-2026-10-11.md), [8004-solana-chain](./8004-solana-chain-2026-10-12.md)).
6. **Scale:** preserve deterministic topology clustering, render caps, and search across the full public index as new reviewed records are added.
7. **Evidence durability:** the audit tooling and public baseline shipped (`2865958`; 58/58 envelopes verified, tamper control rejected), and the hosting panel's daily + manual MySQL backups were confirmed (2026-10-08). Durability is unproven until the offsite object copy and the first restore drill are executed (audit against a restored copy), logging results per [evidence durability](./evidence-durability-2026-10-08.md).
8. **Census integrity:** the read-only census audit shipped (`pnpm census:audit` in `7028cd2`) — it mirrors the reviewed-run read gate with an exact served-set guard, checks provenance fail-closed, profiles composition and single-source concentration, and flags exact-signal review candidates (duplicate endpoints, name-only collisions, catalog self-listings, placeholder text) without merging or writing. The live profile, the flagged review candidates, and the SATI/Robinhood count reconciliations are recorded in [census integrity](./census-integrity-2026-10-08.md); candidate retirement now has a per-record path — the operator-gated withdrawal capability shipped 2026-10-08 (`0278a94`) and migration `0010` was applied in production the same day through the one-time bridge, which was removed immediately after (see [record withdrawal](./record-withdrawal-2026-10-08.md)) — while the self-listing still retires automatically on the next approved catalog run — and a first independent Tier 3 record remains open.

## Non-negotiable semantics

- **Tier 2 / unverified** means approved-source metadata with retained immutable evidence. It does not establish publisher identity, safety, liveness, owner control, or quality.
- **Tier 3** is consented Nooscape domain-control evidence only; it is valid for a 90-day window, pinned to the verified card, and enforced fail-closed at read time.
- **Tier 4 / allowlisted** requires consented publisher-key validation and independent operator approval; publisher keys only ever raise a record.
- Tiers are evidence levels, not scores — there is no blended trust score in the served contract (evidence-tier-v1).
- Source-reported claims—including `signed`, `verifiedAt`, owner, authority, or endpoint declarations—remain assertions unless Nooscape performs the relevant policy check.
- Retained evidence is content-addressed and hash-audited (`pnpm durability:audit`); "durable" requires an executed restore drill recorded in the durability record, not an assumption.
- Census claims are audited, not asserted: composition, concentration, and provenance readiness are recomputed by `pnpm census:audit` against the same reviewed-run read gate — fail-closed on any divergence, review candidates flagged and never merged — and no census number is published without a reconciliation record (source + timestamp + method) in [census integrity](./census-integrity-2026-10-08.md).

See [AI handoff](./AI_HANDOFF_2026-10-12.md) for the current operating runbook, and [worker operations](./worker-operations.md) for worker controls.
