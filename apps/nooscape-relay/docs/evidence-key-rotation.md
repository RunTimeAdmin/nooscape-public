# Evidence signing key: rotation and revocation

Nooscape signs every evidence packet with one Ed25519 key. This note covers changing that key and what to do if it leaks. Added 2026-10-17 (consulting review M6).

## How it fits together

- **The signing key** is set by two environment variables: `NOOSCAPE_EVIDENCE_SIGNING_PRIVATE_KEY` (the private key as PEM, then base64) and `NOOSCAPE_EVIDENCE_SIGNING_KEY_ID` (a name for it). Every packet states `relayKeyId` and `relayPublicKeyPem`, and both are covered by the packet's own checks.
- **Old keys** are listed in `NOOSCAPE_EVIDENCE_RETIRED_KEYS`, a JSON array. The key that signs today is never listed there.
- **The key list** at `/.well-known/nooscape-keys.json` is built from those variables when asked. It cannot drift from the key that is really signing. It shows the active key, then every retired and revoked key, with `status`, `retiredAt` and `note`. It carries only public keys.
- **The verifier** (`atlas.verifyEvidence` and the `/verify` page) finds the packet's key in that list by id and key bytes together. It answers with `keyStatus`: `active`, `retired`, `revoked` or `unknown`.

| keyStatus | `valid` and `verifiedByNooscape` | Meaning |
|---|---|---|
| `active` | true if the rest checks out | The key that signs today. |
| `retired` | true if the packet is dated on or before `retiredAt` | Signed before a rotation. Still good. |
| `retired`, packet dated later | false, with a stated reason | A retired key signed something new. See the limit below. |
| `revoked` | false, with a stated reason | Do not rely on it. Wins over every other status. |
| `unknown` | false | Not a Nooscape key, or a copied key id with another key. |

`issuedByCurrentRelay` means "signed by the key that signs today". A packet from a retired key is `verifiedByNooscape: true` and `issuedByCurrentRelay: false`. A publisher's standing (`publisherKeyAllowlisted`) counts only on packets from the active key, because a standing is a present-tense claim and an old packet cannot vouch for it.

## Rotating the key

Packets are signed when they are requested, not stored, so after the change every new export is signed by the new key. Packets people exported earlier keep verifying as `retired`.

1. Make a new key and its base64 form:

   ```bash
   openssl genpkey -algorithm ed25519 -out new-key.pem
   base64 -w0 new-key.pem
   ```

   Keep `new-key.pem` somewhere private and never commit it. Choose a key id that has not been used. The current one is the date plus eight hex characters (`nooscape-evidence-2026-10-08-b0e2fe2d`); it only has to be unique.
2. Copy the old key's entry from the live list: its `keyId` and `publicKeyPem` from `/.well-known/nooscape-keys.json`. Put it in `NOOSCAPE_EVIDENCE_RETIRED_KEYS` with `retiredAt` set to the moment of the change:

   ```json
   [{"keyId":"nooscape-evidence-2026-10-08-b0e2fe2d","publicKeyPem":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n","status":"retired","retiredAt":"2026-11-01T12:00:00.000Z","note":"rotated"}]
   ```

   `retiredAt` is required for `retired`, and an entry without a valid one is ignored. Only Ed25519 keys are accepted.
3. In the same deploy, set `NOOSCAPE_EVIDENCE_SIGNING_PRIVATE_KEY` and `NOOSCAPE_EVIDENCE_SIGNING_KEY_ID` to the new key. The variables are read at start, so the app must restart.
4. Check: the key list shows the new key as `active` and the old one as `retired`; a packet exported before the change verifies with `keyStatus: "retired"`; one exported now verifies as `active`. The server log says `[EvidenceKeys] ignoring part of ...` once if any entry was malformed, and the entry is then missing from the list.

Do not set `retiredAt` earlier than the real change. Packets the old key signed after that time would be refused.

## If a key leaks

Mark it `revoked` in `NOOSCAPE_EVIDENCE_RETIRED_KEYS` (change its `status`, keep the entry) and restart. Every packet that key signed then fails with a plain reason. If it was the active key, rotate as above at the same time, with the old key as `revoked` instead of `retired`.

A `retired` key is not safe once it leaks, and this is the limit of `retiredAt`. The date is inside the packet, so whoever holds the key chooses it. The date check catches an old instance that is still signing by mistake. It does not stop an attacker. Revocation does. Revoking costs every packet that key signed; the site's own records are unaffected, because they are signed again with the new key on the next request.

The list is cached for five minutes (`Cache-Control`), so a revocation reaches browsers and other sites within that time. The relay's own verifier reads the variables directly and is current after the restart.

## Not covered here

The signed bytes are still `JSON.stringify` over a fixed field order, not RFC 8785 canonical JSON. Changing that changes what is signed, so it needs a version marker on the envelope and a verifier that accepts both forms. It is a separate piece of work.
