import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findRelayKey, listRelayKeys, listRetiredRelayKeys, relayKeyStatus, sealEvidencePayload, signedAfterRetirement } from "./evidence";

type KeyPair = ReturnType<typeof generateKeyPairSync>;
const pemOf = (publicKey: KeyPair["publicKey"]) => publicKey.export({ type: "spki", format: "pem" }).toString();
const old = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const OLD_ID = "nooscape-production-ed25519-v0";
const RETIRED_AT = "2026-10-01T00:00:00.000Z";
const entry = (status: "retired" | "revoked", extra: Record<string, unknown> = {}) => ({
  keyId: OLD_ID,
  publicKeyPem: pemOf(old.publicKey),
  status,
  ...(status === "retired" ? { retiredAt: RETIRED_AT } : {}),
  ...extra,
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("relay key list", () => {
  const sealed = sealEvidencePayload({ envelopeVersion: "Nooscape Persisted Evidence v1", agentId: "x", entries: [] });

  it("lists the active key first and finds it by id and bytes", () => {
    const keys = listRelayKeys("");
    expect(keys[0]).toMatchObject({ keyId: sealed.relayKeyId, status: "active" });
    expect(relayKeyStatus(sealed.relayKeyId, sealed.relayPublicKeyPem, "")).toBe("active");
  });

  it("publishes the active key in exactly the form the packets carry, so a verifier can match them as strings", () => {
    expect(listRelayKeys("")[0]?.publicKeyPem).toBe(sealed.relayPublicKeyPem);
  });

  it("keeps trusting a retired key, so packets signed before a rotation still verify", () => {
    const raw = JSON.stringify([entry("retired")]);
    expect(relayKeyStatus(OLD_ID, pemOf(old.publicKey), raw)).toBe("retired");
  });

  it("refuses a revoked key, and revocation wins over a retired entry for the same key", () => {
    const raw = JSON.stringify([entry("retired"), entry("revoked")]);
    expect(relayKeyStatus(OLD_ID, pemOf(old.publicKey), raw)).toBe("revoked");
  });

  it("does not trust a copied key id with a different key, or a real key under another id", () => {
    const raw = JSON.stringify([entry("retired")]);
    expect(relayKeyStatus(OLD_ID, pemOf(stranger.publicKey), raw)).toBe("unknown");
    expect(relayKeyStatus("some-other-id", pemOf(old.publicKey), raw)).toBe("unknown");
    expect(relayKeyStatus(undefined, pemOf(old.publicKey), raw)).toBe("unknown");
    expect(relayKeyStatus(OLD_ID, "not a key", raw)).toBe("unknown");
  });

  it("matches one key written two ways, because the comparison is on the key and not on the spelling", () => {
    const spelled = pemOf(old.publicKey).replace(/\n/g, "\r\n").trimEnd();
    const raw = JSON.stringify([entry("retired", { publicKeyPem: spelled })]);
    expect(relayKeyStatus(OLD_ID, pemOf(old.publicKey), raw)).toBe("retired");
    expect(relayKeyStatus(OLD_ID, spelled, raw)).toBe("retired");
    expect(listRetiredRelayKeys(raw)[0]?.publicKeyPem).toBe(pemOf(old.publicKey));
  });

  it("ignores a list that does not parse, and entries that are malformed, instead of trusting them", () => {
    expect(listRetiredRelayKeys("not json")).toEqual([]);
    expect(listRetiredRelayKeys("{}")).toEqual([]);
    expect(listRetiredRelayKeys(JSON.stringify([{ keyId: "a", publicKeyPem: "garbage", status: "retired", retiredAt: RETIRED_AT }]))).toEqual([]);
    expect(listRetiredRelayKeys(JSON.stringify([{ ...entry("retired"), status: "active" }]))).toEqual([]);
    expect(listRetiredRelayKeys(JSON.stringify([null, 5, "x"]))).toEqual([]);
  });

  it("needs a retiredAt date on a retired key, because the date is what bounds it", () => {
    expect(listRetiredRelayKeys(JSON.stringify([entry("retired", { retiredAt: undefined })]))).toEqual([]);
    expect(listRetiredRelayKeys(JSON.stringify([entry("retired", { retiredAt: "last Tuesday" })]))).toEqual([]);
    expect(listRetiredRelayKeys(JSON.stringify([entry("retired", { retiredAt: 5 })]))).toEqual([]);
    expect(listRetiredRelayKeys(JSON.stringify([entry("revoked")]))).toHaveLength(1);
  });

  it("accepts only Ed25519 keys, since that is the only kind the verifier supports", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(listRetiredRelayKeys(JSON.stringify([entry("revoked", { publicKeyPem: pemOf(rsa.publicKey) })]))).toEqual([]);
    expect(listRetiredRelayKeys(JSON.stringify([entry("retired", { publicKeyPem: pemOf(rsa.publicKey) })]))).toEqual([]);
  });

  it("says what it ignored, once, without printing a key", () => {
    listRetiredRelayKeys(JSON.stringify([{}, {}, {}, {}, {}, {}, 5]));
    const warnings = vi.mocked(console.warn).mock.calls.map(call => String(call[0]));
    expect(warnings.some(line => line.includes("NOOSCAPE_EVIDENCE_RETIRED_KEYS") && line.includes("entry 6"))).toBe(true);
    expect(warnings.join(" ")).not.toMatch(/BEGIN/);
    listRetiredRelayKeys(JSON.stringify([{}, {}, {}, {}, {}, {}, 5]));
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(warnings.length);
  });

  it("lists the active key once when it is also written down as revoked, and shows it as revoked", () => {
    const keys = listRelayKeys(JSON.stringify([{ keyId: sealed.relayKeyId, publicKeyPem: sealed.relayPublicKeyPem, status: "revoked" }]));
    expect(keys.filter(key => key.keyId === sealed.relayKeyId)).toHaveLength(1);
    expect(keys[0]).toMatchObject({ keyId: sealed.relayKeyId, status: "revoked" });
    expect(relayKeyStatus(sealed.relayKeyId, sealed.relayPublicKeyPem, JSON.stringify([{ keyId: sealed.relayKeyId, publicKeyPem: sealed.relayPublicKeyPem, status: "revoked" }]))).toBe("revoked");
  });

  it("does not let a retired entry demote the key that is still signing", () => {
    const raw = JSON.stringify([{ keyId: sealed.relayKeyId, publicKeyPem: sealed.relayPublicKeyPem, status: "retired", retiredAt: RETIRED_AT }]);
    expect(listRelayKeys(raw)).toHaveLength(1);
    expect(relayKeyStatus(sealed.relayKeyId, sealed.relayPublicKeyPem, raw)).toBe("active");
  });
});

describe("a packet dated after its key was retired", () => {
  const retired = findRelayKey(OLD_ID, pemOf(old.publicKey), JSON.stringify([entry("retired")]));

  it("is caught when it is dated after the retirement, or its date cannot be read", () => {
    expect(signedAfterRetirement(retired, "2026-10-01T00:00:00.001Z")).toBe(true);
    expect(signedAfterRetirement(retired, "2027-01-01T00:00:00.000Z")).toBe(true);
    expect(signedAfterRetirement(retired, "not a date")).toBe(true);
    expect(signedAfterRetirement(retired, "")).toBe(true);
  });

  it("is not caught when it is dated at or before the retirement", () => {
    expect(signedAfterRetirement(retired, RETIRED_AT)).toBe(false);
    expect(signedAfterRetirement(retired, "2026-09-30T23:59:59.999Z")).toBe(false);
  });

  it("only concerns retired keys", () => {
    const active = findRelayKey(sealEvidencePayload({}).relayKeyId, sealEvidencePayload({}).relayPublicKeyPem, "");
    expect(signedAfterRetirement(active, "2099-01-01T00:00:00.000Z")).toBe(false);
    expect(signedAfterRetirement(undefined, "2099-01-01T00:00:00.000Z")).toBe(false);
  });
});
