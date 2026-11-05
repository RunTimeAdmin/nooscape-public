import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readKeyManifest, readPacket, verifyEvidencePacket, type EvidencePacket } from "../verifier/src/verify";
import type { TrpcContext } from "./_core/context";
import { listRelayKeys, sealEvidencePayload } from "./evidence";
import { evidencePacketSchema } from "./evidencePacketSchema";
import { registerRelayKeyList } from "./keyList";
import { appRouter } from "./routers";

/**
 * The relay checks a packet through its schema (the tRPC procedure and the free verify endpoint), and the nooscape-verify package through
 * `readPacket`. Both rebuild the packet before the signed payload is rebuilt from it, so the two must read the same input the same way
 * (docs/verifier-2026-11-05.md): the same inputs accepted, the same refused, the same packet out, the same answer.
 */
const AGENT = "agent-under-test";
const AT = "2026-11-01T12:00:00.000Z";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A packet signed by the relay's own key, with every optional part present, in the order the relay writes it. */
function relayPacket(full = true): EvidencePacket {
  const entries = full
    ? [{ id: "obs-1", observedAt: AT, event: "AGENT_OBSERVED", detail: "Observed.", source: "census", proofReference: "proof-1", provenance: { observationId: "obs-1", contentHash: "a".repeat(64), canonicalLocator: "https://example.test/a", validationStatus: "valid" as const } }]
    : [];
  const publisherValidation = full ? { status: "allowlisted" as const, publisherName: "Example Publisher", publicKeyFingerprint: "ed25519:example-0000", verifiedAt: AT, statusChangedAt: AT } : undefined;
  const provenance = full
    ? { evidenceClass: "persisted-observation" as const, sourceLabel: "census", sourceRoot: "https://example.test", canonicalLocator: "https://example.test/a", contentHash: "b".repeat(64), rawPayloadAccess: "private-object-store" as const, retentionPolicy: "90 days", validationStatus: "valid" as const }
    : undefined;
  const sealed = sealEvidencePayload({ envelopeVersion: "Nooscape Persisted Evidence v1", agentId: AGENT, observedAt: AT, publisherValidation, provenance, entries });
  return {
    format: "Nooscape Signed Evidence Envelope v1",
    exportedAt: AT,
    verification: { signatureAlgorithm: "Ed25519", signedField: "envelope.canonicalPayload", publicKeyPem: sealed.relayPublicKeyPem, instructions: "Verify the signature, then the digest." },
    envelope: {
      agentId: AGENT,
      observedAt: AT,
      sequence: 4,
      algorithm: sealed.algorithm,
      integrityHash: sealed.integrityHash,
      signatureAlgorithm: sealed.signatureAlgorithm,
      signature: sealed.signature,
      relayPublicKeyPem: sealed.relayPublicKeyPem,
      relayKeyId: sealed.relayKeyId,
      canonicalPayload: sealed.canonicalPayload,
      relayMode: "production persisted-observation relay",
      ...(publisherValidation ? { publisherValidation } : {}),
      entries,
      ...(provenance ? { provenance } : {}),
    },
  };
}

/** The same object with its keys in the opposite order at every level, and a field the packet does not define. */
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = { zzExtra: "ignored" };
    for (const key of Object.keys(value).reverse()) out[key] = reordered((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

type Damage = [string, (packet: any) => void];
const DAMAGE: Damage[] = [
  ["another format", p => (p.format = "Something Else v2")],
  ["no export time", p => delete p.exportedAt],
  ["no verification block", p => delete p.verification],
  ["a verification key that is not text", p => (p.verification.publicKeyPem = 7)],
  ["no envelope", p => delete p.envelope],
  ["a sequence that is text", p => (p.envelope.sequence = "4")],
  ["a signature that is null", p => (p.envelope.signature = null)],
  ["a key id that is a number", p => (p.envelope.relayKeyId = 7)],
  ["entries that are an object", p => (p.envelope.entries = {})],
  ["an entry that is a number", p => (p.envelope.entries = [1])],
  ["an entry with no detail", p => delete p.envelope.entries[0].detail],
  ["an entry provenance with a status that does not exist", p => (p.envelope.entries[0].provenance.validationStatus = "fine")],
  ["a null standing", p => (p.envelope.publisherValidation = null)],
  ["a standing status that does not exist", p => (p.envelope.publisherValidation.status = "trusted")],
  ["a publisher name that is a number", p => (p.envelope.publisherValidation.publisherName = 7)],
  ["a standing date that is missing", p => delete p.envelope.publisherValidation.verifiedAt],
  ["a provenance of another class", p => (p.envelope.provenance.evidenceClass = "guess")],
  ["a provenance that gives raw access", p => (p.envelope.provenance.rawPayloadAccess = "public")],
  ["a provenance with no retention policy", p => delete p.envelope.provenance.retentionPolicy],
  ["an envelope that is a list", p => (p.envelope = [])],
];

describe("the relay's schema and the package's reader", () => {
  it("accept the same packets and hand back the same packet, byte for byte", () => {
    const inputs: Array<[string, unknown]> = [
      ["a full packet", relayPacket(true)],
      ["a packet with no optional part", relayPacket(false)],
      ["a packet with its keys in another order and a field nobody defined", reordered(relayPacket(true))],
    ];
    for (const [label, input] of inputs) {
      const zod = evidencePacketSchema.safeParse(clone(input));
      const read = readPacket(clone(input));
      expect(zod.success, label).toBe(true);
      expect(read.ok, label).toBe(true);
      if (zod.success && read.ok) expect(JSON.stringify(read.packet), label).toBe(JSON.stringify(zod.data));
    }
  });

  it("refuse the same damaged packets", () => {
    for (const [label, damage] of DAMAGE) {
      const input = clone(relayPacket(true));
      damage(input);
      expect(evidencePacketSchema.safeParse(input).success, `the schema, with ${label}`).toBe(false);
      expect(readPacket(input).ok, `the reader, with ${label}`).toBe(false);
    }
    for (const input of [null, undefined, 7, "x", true, [], {}]) {
      expect(evidencePacketSchema.safeParse(input).success).toBe(false);
      expect(readPacket(input).ok).toBe(false);
    }
  });

  it("give the same answer about a packet through the schema, the reader and the tRPC procedure", async () => {
    const keys = listRelayKeys();
    const tampered = clone(relayPacket(true));
    tampered.envelope.entries[0]!.detail = "Changed after signing.";
    for (const packet of [relayPacket(true), relayPacket(false), tampered]) {
      const zod = evidencePacketSchema.parse(clone(packet));
      const read = readPacket(clone(packet));
      expect(read.ok).toBe(true);
      const fromSchema = verifyEvidencePacket(zod, keys);
      const fromReader = verifyEvidencePacket((read as { ok: true; packet: EvidencePacket }).packet, keys);
      const caller = appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as TrpcContext);
      const fromRelay = await caller.atlas.verifyEvidence({ packet: clone(packet) });
      expect(fromReader).toEqual(fromSchema);
      expect(fromRelay).toEqual(fromSchema);
    }
    expect(verifyEvidencePacket(relayPacket(true), keys).valid).toBe(true);
    expect(verifyEvidencePacket(tampered, keys).valid).toBe(false);
  });
});

describe("the key list the relay publishes and the package's reader", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const app = express();
    registerRelayKeyList(app);
    await new Promise<void>(resolve => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it("is read without a line left out, to the same keys the relay holds, and a relay packet verifies against it", async () => {
    const document = await (await fetch(`${base}/.well-known/nooscape-keys.json`)).json();
    const read = readKeyManifest(document);
    expect(read.ignored).toEqual([]);
    expect(read.keys.map(({ keyId, publicKeyPem, status, retiredAt }) => ({ keyId, publicKeyPem, status, ...(retiredAt ? { retiredAt } : {}) }))).toEqual(
      listRelayKeys().map(({ keyId, publicKeyPem, status, retiredAt }) => ({ keyId, publicKeyPem, status, ...(retiredAt ? { retiredAt } : {}) }))
    );
    expect(verifyEvidencePacket(relayPacket(true), read.keys)).toMatchObject({ valid: true, keyStatus: "active", verifiedByNooscape: true });
  });
});
