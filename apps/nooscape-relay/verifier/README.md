# nooscape-verify

Checks a Nooscape signed evidence packet on your own machine: that it is unchanged since it was signed, and which key signed it. No account, no API key, and no network unless you ask for the key list.

A packet is the file the "Export signed JSON" button saves in a reviewed record's panel on the site (`nooscape-<id>-evidence-seq-<n>.json`). It carries the records Nooscape kept about an agent, a SHA-256 digest of them, and an Ed25519 signature over that digest. This tool checks all three, and then checks the signing key against the list of keys Nooscape publishes.

## Use it

```
npx nooscape-verify nooscape-0e2b-evidence-seq-4.json --fetch-keys
```

or, with a copy of the key list you saved yourself:

```
curl -s https://nooscape.si/.well-known/nooscape-keys.json -o nooscape-keys.json
npx nooscape-verify nooscape-0e2b-evidence-seq-4.json --keys nooscape-keys.json
```

```
Packet for agent 0e2b...
  observed 2026-11-01T12:00:00.000Z, sequence 4, 3 entries

  digest (SHA-256)      ok
  signature (Ed25519)   ok
  signed fields         match the displayed fields
  key                   active (nooscape-evidence-2026-10-08-b0e2fe2d)

VERIFIED: the packet is unchanged since a key in the key list signed it.
```

Options: `--keys <file>` (a saved key list), `--fetch-keys [url]` (fetch it now; the only thing this tool ever sends over the network, and only over https), `--json` (print the result as JSON), and `-` in place of the file name to read the packet from standard input.

Exit status: `0` verified, `1` not verified (the output says why), `2` the input could not be read. Without a key list the digest and the signature are still checked, but nothing says whose key signed the packet, so it is reported as not verified.

## As a library

```js
import { readFile } from "node:fs/promises";
import { readKeyManifest, readPacket, verifyEvidencePacket } from "nooscape-verify";

const packet = readPacket(JSON.parse(await readFile("packet.json", "utf8")));
if (!packet.ok) throw new Error(packet.error);
const { keys } = readKeyManifest(JSON.parse(await readFile("nooscape-keys.json", "utf8")));

const result = verifyEvidencePacket(packet.packet, keys);
console.log(result.valid, result.keyStatus, result.issues);
```

`readPacket` checks the shape and rebuilds the packet the way it was signed, so a copy with its keys in another order, or with fields added, still verifies. `readKeyManifest` leaves out any line of the key list that does not parse and says which, so a bad line never trusts a key. Both are pure functions. The only dependency is Node's own `crypto`.

## What the result means

| Field | Meaning |
|---|---|
| `hashValid` | The SHA-256 digest matches the signed payload. |
| `signatureValid` | The Ed25519 signature holds for that payload, under the key in the packet. |
| `payloadMatchesEnvelopeFields` | The signed payload is exactly the one rebuilt from the fields the packet displays, so a displayed field cannot be changed under an untouched signature. |
| `keyStatus` | Where the packet's key stands in the key list you gave: `active`, `retired`, `revoked`, or `unknown` (the list does not have it, or the packet names no key). |
| `verifiedByNooscape` | All four of the above hold: the packet is unchanged since a key in your list signed it. |
| `valid` | `verifiedByNooscape`, and nothing is reported in `issues` (for example a wrong label in the export wrapper). |

A packet signed by a retired key is accepted if it is dated up to the day the key was retired, and refused after. That guards against mistakes and does not stop someone who holds a leaked key, because the date is inside the packet. A leaked key is stopped by being marked revoked, which this tool refuses.

**What it does not tell you.** Nothing about the agent: not that it works, not that it is safe, and not that what the registry recorded is true. It tells you what Nooscape recorded and that the record is unchanged.

## Where the trust comes from

The key list is the root of the whole check, and this tool is only as trustworthy as the list you give it. `--fetch-keys` trusts the https connection to `nooscape.si`. If that is not enough for you, save a copy of the list, keep it somewhere you control, and use `--keys`; compare it with a fresh one now and then, and watch for a key turning `revoked`.

## The same check elsewhere

The site's `/verify` page, the free `POST /api/v1/verify` endpoint (no key needed, 30 requests a minute from one address) and this package all run one file, `src/verify.ts`, so they cannot disagree about the same packet.

## Build from source

```
cd apps/nooscape-relay/verifier
npm install
npm run build
node dist/bin.js packet.json --keys nooscape-keys.json
```

Needs Node 18 or later. MIT licence.
