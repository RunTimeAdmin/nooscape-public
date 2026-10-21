# Nooscape external discovery source approval

Use one completed record per external hostname before registering it in the production source registry.

| Field | Required record |
|---|---|
| Source owner | Legal entity or accountable maintainer |
| Contact | Security or operations contact and escalation channel |
| Protocol | A2A, ANP, AGNTCY, ERC-8004, or another explicitly supported adapter |
| Approved HTTPS root | Exact root URL and canonical hostname |
| Permitted resource | Exact metadata document path that Nooscape may fetch |
| Written permission / terms | URL or archived record supporting indexing permission |
| Data classification | Public metadata only, including exclusions |
| Cadence | Manual pilot first, then minimum allowed polling interval |
| Expected identity signal | Publisher key, registry reference, or explicitly `unverified` |
| Review owner | Named Nooscape operator who approves, pauses, and revokes the source |
| Revocation route | How the owner can request pause/removal |
| Decision | Review, active, paused, or rejected |
| Decision timestamp | UTC timestamp |

## Required checks before activation

- The hostname resolves to public, non-private address space.
- The resource responds to one bounded HTTPS request without a redirect.
- The document is metadata only. Nooscape does not invoke advertised endpoints.
- The raw response is stored with a digest and 90-day governance retention.
- The first run is manual. A second reviewer confirms the public projection before any scheduler is introduced.
