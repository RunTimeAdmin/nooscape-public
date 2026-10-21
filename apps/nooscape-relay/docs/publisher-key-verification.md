# Publisher-key validation and rotation policy

> **Status — 2026-10-08:** The Tier 4 policy and production schema are implemented. No consented publisher-key proposal has been staged or approved, so the public allowlisted count is zero.

## Scope

Publisher-key validation is an optional **Tier 4 evidence upgrade** for an agent that has already completed Nooscape domain-control verification. It is separate from discovery and does not imply safety, legal identity, service quality, or transactional authorization.

Nooscape never collects or stores a publisher private key.

## Required evidence

A publisher submits only public material:

1. An **Ed25519 SPKI public key**.
2. A deterministic self-attestation signed by that key. The signed payload contains the issuer name, public-key fingerprint, permitted HTTPS domains, permitted protocols, policy version, and optional expiry.
3. A binding to an existing **domain-verified** Nooscape agent identity. The verified identity domain must be included in the key policy’s permitted domains.
4. A separate operator’s approval with an explicit rationale.

The exact self-attestation and signature are retained in the private Object-Lock evidence bucket with normal governance retention. A pending proposal is not an allowlist entry and does not change the public map.

## Lifecycle

| State | Meaning | Public map effect |
|---|---|---|
| `pending` | Signature is valid, but second-operator approval is outstanding. | Remains `unverified`; no tier change. |
| `allowlisted` | Proposal passed independent approval and scope checks. | Publisher state becomes `allowlisted`; evidence tier becomes `tier_4`. |
| `expired` | Configured expiry passed. | Publisher state becomes `expired`; the agent is conservatively returned to Tier 3 domain-control evidence. |
| `revoked` | An operator revoked the policy or an approved rotation superseded it. | Publisher state becomes `revoked`; the agent is conservatively returned to Tier 3 domain-control evidence. |

## Rotation

A replacement key must create a normal, valid self-attestation with equal-or-narrower permitted domains and protocols. The currently allowlisted key must also sign this canonical rotation payload:

```json
{
  "format": "Nooscape Publisher Key Rotation v1",
  "previousKeyId": "<current Nooscape key UUID>",
  "newKeyFingerprint": "ed25519:sha256:<fingerprint>",
  "newProofHash": "<SHA-256 of the replacement attestation payload>"
}
```

The replacement follows the same pending and second-operator review process. Only after approval does Nooscape revoke the prior key as **superseded** and activate the replacement. A rotation cannot expand the issuer’s domain or protocol scope.

## Operational safeguards

- Only an authenticated operator can stage, approve, or revoke a publisher-key policy.
- The original proposal creator cannot approve their own proposal.
- A key must be Ed25519; unsupported key formats and malformed signatures fail closed.
- Pending keys never satisfy the trusted-only map filter.
- Policy transitions create an append-only history entry and a signed evidence event for the affected agent.
- Public endpoints expose lifecycle state and fingerprint only through signed evidence envelopes; raw retained proof objects remain private.
