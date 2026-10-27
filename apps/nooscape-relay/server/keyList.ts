import type { Express } from "express";
import { listRelayKeys } from "./evidence";

/**
 * /.well-known/nooscape-keys.json: every key that has signed Nooscape evidence, and where each one stands. A verifier
 * reads the packet's relayKeyId, finds it here and decides. Retired keys stay listed so old packets keep verifying.
 * A revoked key stays listed so a verifier can refuse it. Public keys only, never a private key.
 *
 * It replaces a hand-kept file of the same name and keeps its shape (format, keys[].keyId, publicKeyPem, status,
 * purpose), so a reader of the old file still works. It is built from the signing key at request time, so it cannot
 * drift from the key that is actually signing, which is what a file edited by hand can do at the next rotation.
 */
function relayKeyDocument() {
  return {
    format: "Nooscape Relay Key Manifest v1",
    algorithm: "Ed25519",
    keys: listRelayKeys().map(({ keyId, publicKeyPem, status, retiredAt, note }) => ({
      keyId,
      publicKeyPem,
      status,
      purpose: "Evidence-envelope verification",
      ...(retiredAt ? { retiredAt } : {}),
      ...(note ? { note } : {}),
    })),
  };
}

export function registerRelayKeyList(app: Express) {
  app.get("/.well-known/nooscape-keys.json", (_req, res) => {
    let body: string;
    try {
      body = `${JSON.stringify(relayKeyDocument(), null, 2)}\n`;
    } catch (error) {
      // No signing key (production refuses to start signing without one). Say so plainly instead of a stack trace.
      console.error("[EvidenceKeys] the key list could not be built:", error instanceof Error ? error.message : error);
      res.status(503).set("Cache-Control", "no-store").json({ error: "The key list is unavailable." });
      return;
    }
    // Public data meant to be read from other sites, so a browser-based verifier can fetch it: the site-wide
    // same-site resource policy is lifted for this one route. A revocation reaches readers within the cache time.
    res
      .type("application/json; charset=utf-8")
      .set("Cache-Control", "public, max-age=300")
      .set("Access-Control-Allow-Origin", "*")
      .set("Cross-Origin-Resource-Policy", "cross-origin")
      .send(body);
  });
}
