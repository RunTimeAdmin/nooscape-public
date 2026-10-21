# External A2A source approval — AgentCard.net Toolkit

**Record ID:** `a2a-ext-agentcard-net-2026-10-08`
**Decision:** **Approved for one manual, bounded metadata-only fetch**
**Decision timestamp:** 2026-10-08 UTC
**Nooscape review owner:** Nooscape production operator
**Second reviewer:** Nooscape independent public-metadata reviewer

## Registry linkage

| Record | Identifier |
|---|---|
| Production source | `e3327a48-637e-407e-9ccd-5af02bb6e199` |
| Production review item | `2d3f6396-c4ca-4c7d-b938-51466a722ffa` |
| Initial registry state | `review` |

## Source boundary

| Field | Record |
|---|---|
| Source root | `https://www.agentcard.net` |
| Canonical hostname | `www.agentcard.net` |
| Permitted resource | `https://www.agentcard.net/.well-known/agent-card.json` only |
| Protocol | A2A AgentCard discovery |
| Observed card | AgentCard.net Toolkit |
| Self-declared provider | AgentCard.net |
| Declared service URL | `https://www.agentcard.net/api/agent-card` — **not approved for contact** |
| Data classification | Public AgentCard metadata only |
| First-run cadence | One manual run only; automatic polling disabled |
| Identity / publisher state | **Unverified** |

## Independent review result

The independent review observed a direct HTTPS `200` response at the exact card URL with no redirect, `application/a2a+json`, valid JSON, and a 2,201-byte body—within Nooscape's 256 KiB bound. The public API documentation explicitly links the same AgentCard path, and the site describes AgentCard.net as a public A2A agent-card development resource.

The bare hostname redirected to the canonical `www` hostname and the TLS certificate covered both names. This supports ordinary HTTPS hostname authentication for retrieval only. It does **not** establish a named legal owner, organizational authority, publisher-key binding, signed card, domain-control token, safe capability behavior, payment readiness, or service operation.

## Strict constraints

- Fetch exactly one URL: `https://www.agentcard.net/.well-known/agent-card.json`.
- Use one bounded HTTPS `GET`, no redirect following, no request body, cookies, credentials, authorization, prompts, or payment data.
- Do **not** call `/api/agent-card`, invoke the generator/validator/discovery-checker, submit JSON, or contact any advertised tool, payment, authorization, OpenAPI, callback, or related API endpoint.
- Retain the complete raw response in the private evidence store under 90-day governance retention and record its content hash.
- Keep the observation unverified unless separate publisher-key or domain-control evidence is independently validated.
- Pause the source immediately if the response redirects, changes host/scheme, is non-JSON or oversized, or requires interaction.

## Publication evidence

- https://www.agentcard.net/.well-known/agent-card.json
- https://www.agentcard.net/agent-card-api
- https://www.agentcard.net/
- https://www.agentcard.net/about
- https://www.agentcard.net/terms
