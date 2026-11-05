import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT, RETIRED_AT, STANDING, clone, listed, newSigner, packetOf, pemOf, type Signer } from "../test/fixture";
import {
  KEY_MANIFEST_FORMAT,
  PACKET_FORMAT,
  canonicalPem,
  findKey,
  readKeyManifest,
  readPacket,
  signedAfterRetirement,
  verifyEvidencePacket,
  type EvidencePacket,
} from "./verify";

describe("verifyEvidencePacket", () => {
  const signer = newSigner();
  const keys = [listed(signer, "key-1", "active")];

  it("accepts a packet signed by an active key in the list, and says nothing is wrong with it", () => {
    const result = verifyEvidencePacket(packetOf({ signer }), keys);
    expect(result).toMatchObject({
      valid: true,
      verifiedByNooscape: true,
      hashValid: true,
      signatureValid: true,
      keyMatchesEnvelope: true,
      payloadMatchesEnvelopeFields: true,
      issuedByCurrentRelay: true,
      keyStatus: "active",
      agentId: AGENT,
      sequence: 4,
      entryCount: 1,
      signatureAlgorithm: "Ed25519",
      publisherKeyAllowlisted: true,
      publisherName: "Example Publisher",
      issues: [],
    });
  });

  it("checks the digest and the signature but trusts no key when it is given no list", () => {
    const result = verifyEvidencePacket(packetOf({ signer }), []);
    expect(result).toMatchObject({ hashValid: true, signatureValid: true, valid: false, verifiedByNooscape: false, keyStatus: "unknown", publisherKeyAllowlisted: false, publisherName: null });
    expect(result.issues).toEqual(["The envelope key is not pinned as an active Nooscape relay key."]);
  });

  it("does not trust a key id that matches when the key itself is someone else's", () => {
    const forger = newSigner();
    const result = verifyEvidencePacket(packetOf({ signer: forger, keyId: "key-1" }), keys);
    expect(result).toMatchObject({ signatureValid: true, valid: false, verifiedByNooscape: false, keyStatus: "unknown" });
  });

  it("does not trust a real key under an id the list does not give it, or a packet that names no key", () => {
    expect(verifyEvidencePacket(packetOf({ signer, keyId: "key-2" }), keys)).toMatchObject({ valid: false, keyStatus: "unknown" });
    expect(verifyEvidencePacket(packetOf({ signer, keyId: null }), keys)).toMatchObject({ valid: false, keyStatus: "unknown" });
  });

  it("accepts a retired key's packet dated up to the day it was retired, and refuses one dated after, or with a date that cannot be read", () => {
    const retired = [listed(signer, "key-1", "retired", RETIRED_AT)];
    const before = verifyEvidencePacket(packetOf({ signer, observedAt: "2026-09-01T00:00:00.000Z" }), retired);
    expect(before).toMatchObject({ valid: true, verifiedByNooscape: true, keyStatus: "retired", issuedByCurrentRelay: false, issues: [] });
    expect(verifyEvidencePacket(packetOf({ signer, observedAt: RETIRED_AT }), retired)).toMatchObject({ valid: true });
    const after = verifyEvidencePacket(packetOf({ signer, observedAt: "2026-10-17T00:00:00.000Z" }), retired);
    expect(after).toMatchObject({ signatureValid: true, valid: false, verifiedByNooscape: false, keyStatus: "retired" });
    expect(after.issues.join(" ")).toMatch(/dated after the key that signed it was retired/);
    expect(verifyEvidencePacket(packetOf({ signer, observedAt: "sometime" }), retired)).toMatchObject({ valid: false, keyStatus: "retired" });
  });

  it("does not let a retired key vouch for a publisher's standing, which is a present-tense claim", () => {
    const retired = [listed(signer, "key-1", "retired", "2026-12-01T00:00:00.000Z")];
    const result = verifyEvidencePacket(packetOf({ signer }), retired);
    expect(result).toMatchObject({ valid: true, publisherKeyAllowlisted: false, publisherName: null });
  });

  it("refuses a revoked key with a plain reason, and a revoked line wins over an active one for the same key", () => {
    const revoked = verifyEvidencePacket(packetOf({ signer }), [listed(signer, "key-1", "revoked")]);
    expect(revoked).toMatchObject({ valid: false, verifiedByNooscape: false, keyStatus: "revoked" });
    expect(revoked.issues.join(" ")).toMatch(/revoked/);
    const both = verifyEvidencePacket(packetOf({ signer }), [listed(signer, "key-1", "active"), listed(signer, "key-1", "revoked")]);
    expect(both.keyStatus).toBe("revoked");
  });

  it("catches a displayed field changed under an untouched signature", () => {
    const packet = packetOf({ signer });
    packet.envelope.entries[0]!.detail = "Something else, written after the signing.";
    const result = verifyEvidencePacket(packet, keys);
    expect(result).toMatchObject({ hashValid: true, signatureValid: true, payloadMatchesEnvelopeFields: false, valid: false, verifiedByNooscape: false });
    expect(result.issues).toContain("The signed canonical payload does not match the envelope's displayed fields.");
    const renamed = packetOf({ signer });
    renamed.envelope.agentId = "another-agent";
    expect(verifyEvidencePacket(renamed, keys)).toMatchObject({ payloadMatchesEnvelopeFields: false, valid: false });
    const standing = packetOf({ signer });
    standing.envelope.publisherValidation = { ...STANDING, publisherName: "Someone Else" };
    expect(verifyEvidencePacket(standing, keys)).toMatchObject({ payloadMatchesEnvelopeFields: false, publisherKeyAllowlisted: false, publisherName: null });
  });

  it("catches a changed signed payload: the digest and the signature both fail", () => {
    const packet = packetOf({ signer });
    packet.envelope.canonicalPayload = packet.envelope.canonicalPayload.replace(AGENT, "forged-agent");
    const result = verifyEvidencePacket(packet, keys);
    expect(result).toMatchObject({ hashValid: false, signatureValid: false, valid: false, verifiedByNooscape: false });
    expect(result.issues).toEqual(expect.arrayContaining(["The SHA-256 digest does not match the canonical payload.", "The Ed25519 signature is invalid for this canonical payload."]));
  });

  it("catches a digest changed alone: the signature still holds, the digest does not", () => {
    const packet = packetOf({ signer });
    packet.envelope.integrityHash = "0".repeat(64);
    const result = verifyEvidencePacket(packet, keys);
    expect(result).toMatchObject({ hashValid: false, signatureValid: true, payloadMatchesEnvelopeFields: true, valid: false, verifiedByNooscape: false });
    expect(result.issues).toContain("The SHA-256 digest does not match the canonical payload.");
  });

  it("catches a signature made by another key, even with the digest rebuilt to match", () => {
    const other = newSigner();
    const packet = packetOf({ signer });
    packet.envelope.signature = sign(null, Buffer.from(packet.envelope.canonicalPayload), other.privateKey).toString("base64");
    expect(verifyEvidencePacket(packet, keys)).toMatchObject({ hashValid: true, signatureValid: false, valid: false, verifiedByNooscape: false });
  });

  it("reports a key or signature that cannot be read instead of throwing", () => {
    const garbled = packetOf({ signer });
    garbled.verification.publicKeyPem = "not a key";
    garbled.envelope.relayPublicKeyPem = "not a key";
    const result = verifyEvidencePacket(garbled, keys);
    expect(result).toMatchObject({ signatureValid: false, valid: false, keyStatus: "unknown" });
    expect(result.issues).toContain("The embedded public key or signature could not be parsed.");
  });

  it("reports a key in the export wrapper that is not the key in the envelope", () => {
    const packet = packetOf({ signer });
    packet.verification.publicKeyPem = pemOf(newSigner());
    const result = verifyEvidencePacket(packet, keys);
    expect(result).toMatchObject({ keyMatchesEnvelope: false, valid: false, verifiedByNooscape: false });
    expect(result.issues).toContain("The verification key does not match the key embedded in the evidence envelope.");
  });

  it("does not trust a packet signed with the attacker's own key that borrows the relay's key and key id in the envelope", () => {
    // The signature holds under the key in the export wrapper, which is the attacker's. The envelope names the relay's real, active key and
    // its id, so a lookup by the envelope alone would find an active key. The two keys differ, and that must be enough to refuse it.
    const attacker = newSigner();
    const forged = packetOf({ signer: attacker, keyId: "key-1" });
    forged.envelope.relayPublicKeyPem = pemOf(signer);
    // The same forgery against a key the relay has retired, with the packet dated before the retirement.
    const retired = [listed(signer, "key-1", "retired", "2026-12-01T00:00:00.000Z")];
    for (const list of [keys, retired]) {
      const result = verifyEvidencePacket(forged, list);
      expect(result).toMatchObject({ signatureValid: true, keyMatchesEnvelope: false, issuedByCurrentRelay: false, valid: false, verifiedByNooscape: false, publisherKeyAllowlisted: false });
      expect(result.keyStatus).toBe(list[0]!.status);
      expect(result.issues).toContain("The verification key does not match the key embedded in the evidence envelope.");
    }
  });

  it("reports an algorithm other than Ed25519 and a signed field other than the payload", () => {
    const packet = packetOf({ signer });
    packet.verification.signatureAlgorithm = "RSA";
    packet.verification.signedField = "envelope.entries";
    const result = verifyEvidencePacket(packet, keys);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining(["Unsupported signature algorithm; expected Ed25519.", "The exported packet does not declare the expected signed payload."]));
    // The authorship flag rests on the digest, the signature, the key and the displayed fields; these two labels are not among them.
    expect(result.verifiedByNooscape).toBe(true);
  });

  it("works for a packet with no entries, no standing and no provenance", () => {
    const result = verifyEvidencePacket(packetOf({ signer, full: false }), keys);
    expect(result).toMatchObject({ valid: true, entryCount: 0, publisherKeyAllowlisted: false, publisherName: null, issues: [] });
  });
});

describe("findKey", () => {
  const signer = newSigner();
  const entry = listed(signer, "key-1", "active");

  it("needs the id and the key bytes to match, in any spelling of the key", () => {
    expect(findKey([entry], "key-1", pemOf(signer))).toEqual(entry);
    const crlf = pemOf(signer).trim().replace(/\n/g, "\r\n");
    expect(findKey([entry], "key-1", crlf)).toEqual(entry);
    expect(findKey([entry], "key-2", pemOf(signer))).toBeUndefined();
    expect(findKey([entry], "key-1", pemOf(newSigner()))).toBeUndefined();
  });

  it("finds nothing for no id, a key that does not parse, or an empty list", () => {
    expect(findKey([entry], undefined, pemOf(signer))).toBeUndefined();
    expect(findKey([entry], "", pemOf(signer))).toBeUndefined();
    expect(findKey([entry], "key-1", "not a key")).toBeUndefined();
    expect(findKey([], "key-1", pemOf(signer))).toBeUndefined();
  });

  it("prefers revoked over active over retired", () => {
    const retired = listed(signer, "key-1", "retired", RETIRED_AT);
    const revoked = listed(signer, "key-1", "revoked");
    expect(findKey([retired, entry], "key-1", pemOf(signer))?.status).toBe("active");
    expect(findKey([retired, entry, revoked], "key-1", pemOf(signer))?.status).toBe("revoked");
  });

  it("writes a key one way", () => {
    const pem = pemOf(signer);
    expect(canonicalPem(pem.trim())).toBe(pem);
  });
});

describe("signedAfterRetirement", () => {
  const signer = newSigner();
  const retired = listed(signer, "key-1", "retired", RETIRED_AT);

  it("is false up to the day of retirement and true after it, or when the date cannot be read", () => {
    expect(signedAfterRetirement(retired, RETIRED_AT)).toBe(false);
    expect(signedAfterRetirement(retired, "2026-09-30T23:59:59.999Z")).toBe(false);
    expect(signedAfterRetirement(retired, "2026-10-01T00:00:00.001Z")).toBe(true);
    expect(signedAfterRetirement(retired, "not a date")).toBe(true);
    expect(signedAfterRetirement(retired, "")).toBe(true);
  });

  it("is false for a key that is not retired, and for no key", () => {
    expect(signedAfterRetirement(listed(signer, "key-1", "active"), "2099-01-01T00:00:00.000Z")).toBe(false);
    expect(signedAfterRetirement(listed(signer, "key-1", "revoked"), "2099-01-01T00:00:00.000Z")).toBe(false);
    expect(signedAfterRetirement(undefined, "2099-01-01T00:00:00.000Z")).toBe(false);
  });
});

describe("readPacket", () => {
  const signer = newSigner();
  const full = () => clone(packetOf({ signer }));

  it("accepts a packet as the relay exports it and hands back the same packet", () => {
    const packet = full();
    const read = readPacket(clone(packet));
    expect(read).toEqual({ ok: true, packet });
    expect(JSON.stringify((read as { packet: EvidencePacket }).packet)).toBe(JSON.stringify(packet));
  });

  it("accepts a packet without the optional parts", () => {
    const packet = clone(packetOf({ signer, full: false, keyId: null }));
    const read = readPacket(clone(packet));
    expect(read).toEqual({ ok: true, packet });
    expect(JSON.stringify(read)).not.toContain("relayKeyId");
  });

  it("drops fields it does not know and writes the rest in the order the relay signed them", () => {
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = { zzExtra: "ignored" };
        for (const key of Object.keys(value).reverse()) out[key] = reorder((value as Record<string, unknown>)[key]);
        return out;
      }
      return value;
    };
    const packet = full();
    const read = readPacket(reorder(packet));
    expect(read.ok).toBe(true);
    expect(JSON.stringify((read as { packet: EvidencePacket }).packet)).toBe(JSON.stringify(packet));
    // So a reordered or padded copy of a genuine packet still verifies: the signed bytes are rebuilt from the fields, not copied.
    expect(verifyEvidencePacket((read as { packet: EvidencePacket }).packet, [listed(signer, "key-1", "active")]).valid).toBe(true);
  });

  it("refuses what is not an object, naming it", () => {
    for (const input of [null, undefined, 7, "x", true, []]) expect(readPacket(input)).toEqual({ ok: false, error: "the packet must be an object" });
  });

  const refused: Array<[string, (packet: any) => void, string]> = [
    ["another format", p => (p.format = "Something Else v2"), 'format must be "Nooscape Signed Evidence Envelope v1"'],
    ["no export time", p => delete p.exportedAt, "exportedAt must be a string"],
    ["no verification block", p => delete p.verification, "verification must be an object"],
    ["a verification key that is not text", p => (p.verification.publicKeyPem = 7), "verification.publicKeyPem must be a string"],
    ["no envelope", p => delete p.envelope, "envelope must be an object"],
    ["a sequence that is text", p => (p.envelope.sequence = "4"), "envelope.sequence must be a number"],
    ["a signature that is not text", p => (p.envelope.signature = null), "envelope.signature must be a string"],
    ["a key id that is not text", p => (p.envelope.relayKeyId = 7), "envelope.relayKeyId must be a string"],
    ["entries that are not a list", p => (p.envelope.entries = {}), "envelope.entries must be a list"],
    ["an entry that is not an object", p => (p.envelope.entries = [1]), "envelope.entries[0] must be an object"],
    ["an entry with no detail", p => delete p.envelope.entries[0].detail, "envelope.entries[0].detail must be a string"],
    ["an entry provenance with a status that does not exist", p => (p.envelope.entries[0].provenance.validationStatus = "fine"), "envelope.entries[0].provenance.validationStatus must be one of valid, invalid, partial"],
    ["a null standing", p => (p.envelope.publisherValidation = null), "envelope.publisherValidation must be an object"],
    ["a standing with a status that does not exist", p => (p.envelope.publisherValidation.status = "trusted"), "envelope.publisherValidation.status must be one of allowlisted, expired, revoked, unverified"],
    ["a publisher name that is a number", p => (p.envelope.publisherValidation.publisherName = 7), "envelope.publisherValidation.publisherName must be a string"],
    ["a provenance of another class", p => (p.envelope.provenance.evidenceClass = "guess"), 'envelope.provenance.evidenceClass must be "persisted-observation"'],
  ];
  for (const [label, damage, message] of refused) {
    it(`refuses a packet with ${label}`, () => {
      const packet = full();
      damage(packet);
      expect(readPacket(packet)).toEqual({ ok: false, error: message });
    });
  }

  it("takes null where the relay writes null: a standing with no publisher, key or dates", () => {
    const packet = full();
    packet.envelope.publisherValidation = { status: "unverified", publisherName: null, publicKeyFingerprint: null, verifiedAt: null, statusChangedAt: null };
    expect(readPacket(packet).ok).toBe(true);
  });
});

describe("readKeyManifest", () => {
  const active = newSigner();
  const old = newSigner();
  const manifest = (keys: unknown[], format: string | undefined = KEY_MANIFEST_FORMAT) => ({ ...(format ? { format } : {}), algorithm: "Ed25519", keys });
  const line = (signer: Signer, keyId: string, status: string, extra: Record<string, unknown> = {}) => ({ keyId, publicKeyPem: pemOf(signer), status, purpose: "Evidence-envelope verification", ...extra });

  it("reads the document the relay publishes, active, retired and revoked lines alike", () => {
    const read = readKeyManifest(manifest([line(active, "key-2", "active"), line(old, "key-1", "retired", { retiredAt: RETIRED_AT, note: "rotated" })]));
    expect(read.ignored).toEqual([]);
    expect(read.keys).toEqual([
      { keyId: "key-2", publicKeyPem: pemOf(active), status: "active" },
      { keyId: "key-1", publicKeyPem: pemOf(old), status: "retired", retiredAt: RETIRED_AT, note: "rotated" },
    ]);
  });

  it("reads a bare list of keys, and writes each key one way", () => {
    const spelled = pemOf(active).trim().replace(/\n/g, "\r\n");
    const read = readKeyManifest([{ keyId: "key-2", publicKeyPem: spelled, status: "active" }]);
    expect(read.keys).toEqual([{ keyId: "key-2", publicKeyPem: pemOf(active), status: "active" }]);
    expect(findKey(read.keys, "key-2", pemOf(active))?.status).toBe("active");
  });

  it("leaves out any line that does not parse and names it, so a bad line never trusts a key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const read = readKeyManifest(
      manifest([
        "not an object",
        { publicKeyPem: pemOf(active), status: "active" },
        { keyId: "", publicKeyPem: pemOf(active), status: "active" },
        line(active, "key-2", "trusted"),
        line(old, "key-1", "retired"),
        line(old, "key-1", "retired", { retiredAt: "never" }),
        { keyId: "rsa", publicKeyPem: rsa.publicKey.export({ type: "spki", format: "pem" }).toString(), status: "active" },
        { keyId: "junk", publicKeyPem: "not a key", status: "active" },
        line(active, "key-ok", "active"),
      ])
    );
    expect(read.keys.map(key => key.keyId)).toEqual(["key-ok"]);
    expect(read.ignored).toEqual([
      "entry 0 is not an object",
      "entry 1 needs a keyId and a publicKeyPem",
      "entry 2 needs a keyId and a publicKeyPem",
      'entry 3 has a status other than "active", "retired" or "revoked"',
      "entry 4 is retired but has no valid retiredAt date",
      "entry 5 is retired but has no valid retiredAt date",
      "entry 6 is not an Ed25519 key",
      "entry 7 has a publicKeyPem that does not parse",
    ]);
  });

  it("trusts nothing from a document of another format or with no list", () => {
    expect(readKeyManifest(manifest([line(active, "key-2", "active")], "Some Other Manifest v9")).keys).toEqual([]);
    expect(readKeyManifest({ format: KEY_MANIFEST_FORMAT }).keys).toEqual([]);
    expect(readKeyManifest(null).keys).toEqual([]);
    expect(readKeyManifest("keys").ignored).toEqual(["the document has no list of keys"]);
  });

  it("accepts the old hand-kept file, which had no format line", () => {
    expect(readKeyManifest(manifest([line(active, "key-2", "active")], undefined)).keys).toHaveLength(1);
  });

  it("a packet read and checked from files verifies end to end", () => {
    const packet = clone(packetOf({ signer: active, keyId: "key-2" }));
    const read = readPacket(packet);
    const keys = readKeyManifest(clone(manifest([line(active, "key-2", "active")]))).keys;
    expect(read.ok && verifyEvidencePacket(read.packet, keys).valid).toBe(true);
  });
});
