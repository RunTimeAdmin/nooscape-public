# External A2A source approval — agents.txt reference deployment

**Record ID:** `a2a-ext-agents-txt-2026-10-08`
**Decision:** **Active — one bounded observation completed and publicly projected as unverified**
**Decision timestamp:** 2026-10-08 UTC
**Nooscape review owner:** Nooscape production operator
**Second reviewer:** Nooscape independent public-metadata reviewer

**Reviewer identity note (recorded 2026-10-08):** Reviewers are recorded by role only: review owner = Nooscape production operator; second reviewer = Nooscape independent public-metadata reviewer. "Independent" here means independent of the publisher/source owner — it does not assert a second distinct human reviewer. Nooscape currently operates under a single production operator identity, and no second named person is on record for any source review. The `| Second reviewer | Pending |` row under Required checks is retained as registry checklist state for that reason, not as evidence of a completed second review.

## Registry linkage

| Record | Identifier |
|---|---|
| Production source | `f5cf31f2-9ed3-4853-bb6f-58f8197a109f` |
| Production review item | `1dc7ccef-7200-40ec-a6ed-814c99abc366` |
| Current registry state | `review` |

The source was registered in production as a review-only boundary, then activated after independent confirmation. Automatic scheduling remains disabled.

## Independent second-review confirmation

**Decision:** Approve **one manual, bounded metadata-only fetch**.

The independent reviewer rechecked the exact canonical AgentCard, public DNS reachability, direct non-redirecting response, static publication declarations, and the public reference-deployment documentation. It confirmed that the only permitted request is one HTTPS `GET` to the exact AgentCard path. The advertised A2A service URL, MCP endpoints, payment extensions, tools, prompts, and transaction paths remain strictly out of scope.

The card's provider field is self-asserted. The review establishes neither a publisher-key binding nor an organizational identity proof; the source and any observation must remain **unverified**. The first observation must remain private to evidence review after immutable retention, hash, and signature checks pass. It must not be projected to the public Atlas until a separate projection decision is recorded.

## Source boundary

| Field | Record |
|---|---|
| Source owner / accountable maintainer | `agents.txt contributors`; specification author identified as [`hsologarcia`](https://github.com/hsologarcia) |
| Contact / escalation | `contact@agents-txt.com` |
| Protocol | A2A AgentCard discovery |
| Approved HTTPS root | `https://agents-txt.com` |
| Canonical hostname | `agents-txt.com` |
| Permitted metadata document | `https://agents-txt.com/.well-known/agent-card.json` only |
| Declared agent | `agents.txt Reference Agent` |
| Declared provider | `agents.txt contributors` |
| Expected identity signal | `unverified`; no publisher-key claim is made or inferred |
| Data classification | Public AgentCard metadata only; no endpoint invocation, prompts, transactions, credentials, or payment flows |
| Planned cadence | One manual run only; automatic polling disabled |
| Revocation route | `contact@agents-txt.com`; pause the source immediately on request |

## Permission and publication evidence

The `agents.txt` reference deployment describes `/.well-known/agent-card.json` as a static public agent-facing route, with `Access-Control-Allow-Origin: *` and public caching. Its A2A section states that AgentCard URLs are HTTPS machine-readable metadata documents. The public card identifies the site as a reference A2A agent and exposes only discovery metadata.

The source also publishes the specification under **CC0** and its reference implementation under **Apache-2.0**. This record treats those statements as evidence for a **single manual, metadata-only interoperability observation**, not as permission to invoke the agent service, conduct transactions, or enable scheduled crawling.

## Required checks

| Check | Result |
|---|---|
| HTTPS only | Pass |
| Canonical well-known path | Pass — `/.well-known/agent-card.json` |
| Redirects | Pass — direct `200` response observed during approval review |
| Content type | Pass — `application/json` |
| Bounded response | Pass — 3,890 bytes, below Nooscape's 256 KiB limit |
| Public address space | Required again immediately before any run; Nooscape's adapter enforces this check |
| Metadata-only handling | Pass — discovery adapter records fields but never calls the advertised service URL |
| Raw-object retention | Required on run — private RustFS storage with 90-day governance retention |
| Second reviewer | Pending |

## Activation decision

**Completed.** The source was activated for exactly one manual AgentCard metadata fetch after the independent review. The adapter fetched only the approved canonical path and did not invoke the advertised A2A service, MCP tools, payment extensions, prompts, or transactions.

## Evidence review and projection decision

| Check | Result |
|---|---|
| Manual run | Completed; 1 request, 1 discovered record, 1 accepted record, 0 rejected records |
| Observation | `ffd6e480-0425-4eee-b3cb-4a369eb14670` at 2026-10-08T05:53:47Z |
| HTTP and parse validation | `200`, `application/json`, `valid` |
| Raw object integrity | SHA-256 recomputation matched `7816ef69312c6dcb9a8a1db49423f6d0f082e4ba2a6bc528b346a33fa7242e0c` |
| Raw object retention | Private RustFS object; `GOVERNANCE` lock through 2027-01-06T05:53:47Z |
| Nooscape evidence envelope | Canonical-payload SHA-256 and Ed25519 signature verified; one evidence entry |
| Publisher identity | **Unverified**; no publisher-key, organization, endpoint behavior, or capability verification was inferred |
| Public projection | Approved after evidence review as **metadata-only, unverified, tier 2** |

The public Atlas projection is therefore a transparency record—not an endorsement, publisher validation, safety assessment, or permission to call the source's advertised service. The source may be paused or revoked immediately if its owner withdraws publication or the evidence ceases to validate.

## Sources consulted

- https://agents-txt.com/.well-known/agent-card.json
- https://agents-txt.com/demo/a2a
- https://agents-txt.com
- https://agent2agent.info/docs/concepts/agentcard/
