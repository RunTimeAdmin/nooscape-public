# Nooscape evidence storage activation — 2026-10-08

> **Status update:** Production evidence storage is active. The `nooscape-evidence` bucket is private, Object Lock enabled, and production ingestion assigns **90-day per-object governance retention**. The original activation checks below are preserved as historical evidence.

## Current production state

| Control | Current state |
|---|---|
| Public endpoint | `https://objects.nooscape.si` |
| TLS | Valid certificate and HTTPS route |
| RustFS API binding | Internal/loopback service; no direct public API port |
| Bucket | Private `nooscape-evidence` |
| Object Lock | Enabled |
| Retention policy | Per-object `GOVERNANCE`, 90 days for retained evidence writes |
| Evidence access | Server-side only; raw object bytes and keys are not returned to browsers |
| Production adapter | Enabled through server-only Hostinger environment variables |
| Verification | Signed write/read, hash checking, and governance-retention inspection passed |

The production application fails closed when required S3/RustFS configuration is absent. It does not fall back to an insecure public storage path in production.

## Historical activation verification

A private bucket named `nooscape-evidence` was created through signed S3 requests. The original activation marker was retained for storage-path validation only and contained no agent data, credentials, or user data.

| Property | Historical result |
|---|---|
| Bucket exists | Yes |
| Object Lock enabled | Yes |
| Signed object write/read-back | Passed |
| Digest verification | Passed |
| Verification object | `verification/initial-signed-write.json` |

## Operational safeguards

- Keep the bucket private; do not enable anonymous access or presigned URLs for public Atlas requests.
- Keep RustFS administrative console and S3 API ports unexposed to the public internet.
- Store only source evidence through the server-side adapter and apply retention during the write.
- Do not document, return, commit, or log access keys, secret keys, object keys, or credentials.
- A governance-bypass operation is not part of routine Nooscape work and must never be automated.

## Evidence semantics

A retained object and matching SHA-256 digest prove that Nooscape retained the approved source payload under its evidence policy. They do not prove the source’s claims are correct. Public envelopes expose only safe provenance metadata, canonical source locator, digest, retention label, and pinned relay-key verification material.
