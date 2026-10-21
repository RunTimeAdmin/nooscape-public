import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { sealEvidencePayload } from "./evidence";

function createPublicCaller() {
  const ctx = {
    user: null,
    req: { protocol: "https", headers: {} },
    res: {},
  } as TrpcContext;
  return appRouter.createCaller(ctx);
}

describe("Nooscape public atlas", () => {
  it("exposes the live-data boundary without enabling scheduled ingestion", async () => {
    const liveData = await createPublicCaller().liveData.availability();

    // The availability endpoint responds gracefully with or without a database.
    // When DATABASE_URL is not set, persistentStorageConfigured is false.
    expect(liveData).toMatchObject({
      scheduledIngestionEnabled: false,
      supportedProtocols: ["a2a", "catalog", "census", "solana_registry", "solana_8004", "erc8004"],
    });
    expect(typeof liveData.persistentStorageConfigured).toBe("boolean");
  });

  it("exposes a non-sensitive public source status surface", async () => {
    const result = await createPublicCaller().liveData.sourceStatuses();

    expect(Array.isArray(result.sources)).toBe(true);
    for (const source of result.sources) {
      expect(source).toMatchObject({
        sourceKey: expect.any(String),
        label: expect.any(String),
        hostname: expect.any(String),
      });
      expect(source).not.toHaveProperty("rootUrl");
      expect(source).not.toHaveProperty("lastError");
    }
  });

  it("exposes public provenance coverage without raw evidence details", async () => {
    const coverage = await createPublicCaller().liveData.publicCoverage();

    expect(coverage).toMatchObject({
      publicRecordCount: expect.any(Number),
      provenanceReadyCount: expect.any(Number),
      coveragePercent: expect.any(Number),
    });
    expect(coverage.provenanceReadyCount).toBeLessThanOrEqual(coverage.publicRecordCount);
    expect(coverage.coveragePercent).toBeGreaterThanOrEqual(0);
    expect(coverage.coveragePercent).toBeLessThanOrEqual(100);
    expect(coverage).not.toHaveProperty("rawObjectKey");
  });

  it("fails closed on an unknown agent profile without exposing internals", async () => {
    const profile = await createPublicCaller().liveData.agentProfile({ id: "00000000-0000-0000-0000-000000000000" });

    expect(profile).toMatchObject({ kind: "none", record: null, timeline: [], entry: null, checks: [] });
  });

  it("fails closed on the wallet census without exposing internals", async () => {
    const census = await createPublicCaller().liveData.directoryWalletCensus();

    expect(census).toEqual({ wallets: [] });
  });

  it("fails closed on the honesty funnel without exposing internals", async () => {
    const funnel = await createPublicCaller().liveData.directoryFunnel();

    expect(funnel).toEqual({ steps: [], activityTotals: null });
  });

  it("fails closed on the What-changed feed without exposing internals", async () => {
    const feed = await createPublicCaller().liveData.directoryActivityFeed();

    expect(feed).toEqual({ totals: null, feed: [], series: [] });
  });

  it("requires a pinned relay key and detects tampering", async () => {
    const caller = createPublicCaller();
    // A packet signed by a key that is not the relay's: everything adds up except who signed it.
    const stranger = generateKeyPairSync("ed25519");
    const strangerPem = stranger.publicKey.export({ type: "spki", format: "pem" }).toString();
    const strangerAt = new Date().toISOString();
    const strangerValidation = { status: "unverified" as const, publisherName: null, publicKeyFingerprint: null, verifiedAt: null, statusChangedAt: null };
    const strangerPayload = JSON.stringify({ envelopeVersion: "Nooscape Persisted Evidence v1", agentId: "persisted-agent", observedAt: strangerAt, publisherValidation: strangerValidation, entries: [] });
    const evidence = {
      agentId: "persisted-agent",
      observedAt: strangerAt,
      sequence: 0,
      algorithm: "SHA-256" as const,
      integrityHash: createHash("sha256").update(strangerPayload).digest("hex"),
      signatureAlgorithm: "Ed25519" as const,
      signature: sign(null, Buffer.from(strangerPayload), stranger.privateKey).toString("base64"),
      relayPublicKeyPem: strangerPem,
      canonicalPayload: strangerPayload,
      relayMode: "signed by a key that is not the relay's",
      publisherValidation: strangerValidation,
      entries: [] as Array<{ id: string; observedAt: string; event: string; detail: string; source: string; proofReference: string }>,
    };
    const packet = {
      format: "Nooscape Signed Evidence Envelope v1" as const,
      exportedAt: strangerAt,
      verification: {
        signatureAlgorithm: evidence.signatureAlgorithm,
        signedField: "envelope.canonicalPayload",
        publicKeyPem: evidence.relayPublicKeyPem,
        instructions: "Verify the base64 signature against the UTF-8 canonicalPayload using the included Ed25519 public key; then verify the SHA-256 integrityHash.",
      },
      envelope: evidence,
    };

    const unpinned = await caller.atlas.verifyEvidence({ packet });
    expect(unpinned).toMatchObject({ valid: false, hashValid: true, signatureValid: true, keyMatchesEnvelope: true, verifiedByNooscape: false });
    expect(unpinned.issues).toContain("The envelope key is not pinned as an active Nooscape relay key.");

    const tampered = structuredClone(packet);
    (tampered.envelope as { canonicalPayload: string }).canonicalPayload = "tampered payload";
    const invalid = await caller.atlas.verifyEvidence({ packet: tampered });
    expect(invalid).toMatchObject({ valid: false, hashValid: false, signatureValid: false });
    expect(invalid.issues).not.toHaveLength(0);

    const observedAt = new Date().toISOString();
    // The sealed payload must mirror the persisted issuance shape exactly
    // (evidence.ts createPersistedEvidenceEnvelope) — the verifier rebuilds
    // this object from the displayed envelope fields and requires byte
    // equality with the signed canonicalPayload.
    const publisherValidation = {
      status: "unverified" as const,
      publisherName: null,
      publicKeyFingerprint: null,
      verifiedAt: null,
      statusChangedAt: null,
    };
    const provenance = {
      evidenceClass: "persisted-observation" as const,
      sourceLabel: "Approved source",
      sourceRoot: "https://source.example.org",
      canonicalLocator: "https://source.example.org/persisted-agent",
      contentHash: "a".repeat(64),
      rawPayloadAccess: "private-object-store" as const,
      retentionPolicy: "GOVERNANCE / 90 days per observation",
      validationStatus: "valid" as const,
    };
    const sealed = sealEvidencePayload({
      envelopeVersion: "Nooscape Persisted Evidence v1",
      agentId: "persisted-agent",
      observedAt,
      publisherValidation,
      provenance,
      entries: [],
    });
    const pinnedPacket = {
      format: "Nooscape Signed Evidence Envelope v1" as const,
      exportedAt: observedAt,
      verification: {
        signatureAlgorithm: sealed.signatureAlgorithm,
        signedField: "envelope.canonicalPayload",
        publicKeyPem: sealed.relayPublicKeyPem,
        instructions: "Pinned relay-key verification test.",
      },
      envelope: {
        agentId: "persisted-agent",
        observedAt,
        sequence: 0,
        ...sealed,
        relayMode: "production persisted-observation relay",
        publisherValidation,
        provenance,
        entries: [] as Array<{ id: string; observedAt: string; event: string; detail: string; source: string; proofReference: string }>,
      },
    };
    const pinned = await caller.atlas.verifyEvidence({ packet: pinnedPacket });
    expect(pinned).toMatchObject({ valid: true, hashValid: true, signatureValid: true, keyMatchesEnvelope: true, payloadMatchesEnvelopeFields: true, verifiedByNooscape: true });
  });

  it("counts a publisher as allowlisted only when the relay signed that statement", async () => {
    const caller = createPublicCaller();
    const observedAt = new Date().toISOString();
    const publisherValidation = {
      status: "allowlisted" as const,
      publisherName: "Example Publisher",
      publicKeyFingerprint: "ed25519:example-0000",
      verifiedAt: observedAt,
      statusChangedAt: observedAt,
    };
    const packetFor = (sealed: { signatureAlgorithm: "Ed25519"; relayPublicKeyPem: string }, envelope: Record<string, unknown>) => ({
      format: "Nooscape Signed Evidence Envelope v1" as const,
      exportedAt: observedAt,
      verification: { signatureAlgorithm: sealed.signatureAlgorithm, signedField: "envelope.canonicalPayload", publicKeyPem: sealed.relayPublicKeyPem, instructions: "Publisher standing test." },
      envelope: envelope as never,
    });
    const payload = { envelopeVersion: "Nooscape Persisted Evidence v1", agentId: "persisted-agent", observedAt, publisherValidation, entries: [] };

    // Signed by the relay: the standing it states counts.
    const sealed = sealEvidencePayload(payload);
    const relaySigned = await caller.atlas.verifyEvidence({
      packet: packetFor(sealed, { agentId: "persisted-agent", observedAt, sequence: 0, ...sealed, relayMode: "production persisted-observation relay", publisherValidation, entries: [] }),
    });
    expect(relaySigned).toMatchObject({ verifiedByNooscape: true, publisherKeyAllowlisted: true, publisherName: "Example Publisher" });

    // Signed by anyone else, naming the same publisher: it does not.
    const stranger = generateKeyPairSync("ed25519");
    const strangerPayload = JSON.stringify(payload);
    const forged = {
      algorithm: "SHA-256" as const,
      integrityHash: createHash("sha256").update(strangerPayload).digest("hex"),
      signatureAlgorithm: "Ed25519" as const,
      signature: sign(null, Buffer.from(strangerPayload), stranger.privateKey).toString("base64"),
      relayPublicKeyPem: stranger.publicKey.export({ type: "spki", format: "pem" }).toString(),
      canonicalPayload: strangerPayload,
    };
    const forgedResult = await caller.atlas.verifyEvidence({
      packet: packetFor(forged, { agentId: "persisted-agent", observedAt, sequence: 0, ...forged, relayMode: "forged", publisherValidation, entries: [] }),
    });
    expect(forgedResult).toMatchObject({ verifiedByNooscape: false, publisherKeyAllowlisted: false, publisherName: null });
  });

  it("binds the displayed envelope fields to the signature, not just the payload string", async () => {
    const caller = createPublicCaller();
    const observedAt = new Date().toISOString();
    const publisherValidation = {
      status: "unverified" as const,
      publisherName: null,
      publicKeyFingerprint: null,
      verifiedAt: null,
      statusChangedAt: null,
    };
    const provenance = {
      evidenceClass: "persisted-observation" as const,
      sourceLabel: "Approved source",
      sourceRoot: "https://source.example.org",
      canonicalLocator: "https://source.example.org/persisted-agent",
      contentHash: "a".repeat(64),
      rawPayloadAccess: "private-object-store" as const,
      retentionPolicy: "GOVERNANCE / 90 days per observation",
      validationStatus: "valid" as const,
    };
    const entries = [
      { id: "entry-1", observedAt, event: "REVIEWED OBSERVATION", detail: "honest entry", source: "Approved source · ERC8004", proofReference: "obs-1" },
    ];
    const sealed = sealEvidencePayload({
      envelopeVersion: "Nooscape Persisted Evidence v1",
      agentId: "persisted-agent",
      observedAt,
      publisherValidation,
      provenance,
      entries,
    });
    const packet = {
      format: "Nooscape Signed Evidence Envelope v1" as const,
      exportedAt: observedAt,
      verification: {
        signatureAlgorithm: sealed.signatureAlgorithm,
        signedField: "envelope.canonicalPayload",
        publicKeyPem: sealed.relayPublicKeyPem,
        instructions: "Field-binding tamper tests.",
      },
      envelope: {
        agentId: "persisted-agent",
        observedAt,
        sequence: entries.length,
        ...sealed,
        relayMode: "production persisted-observation relay",
        publisherValidation,
        provenance,
        entries,
      },
    };

    // Swap the entries list while keeping payload, hash and signature intact:
    // hashValid and signatureValid stay true — exactly the gap the field
    // binding exists to close — but the packet must not verify.
    const swapped = structuredClone(packet);
    swapped.envelope.entries = [
      { id: "forged-1", observedAt, event: "FORGED EVENT", detail: "forged detail", source: "Forged source · ERC8004", proofReference: "forged" },
    ];
    const forgedEntries = await caller.atlas.verifyEvidence({ packet: swapped });
    expect(forgedEntries).toMatchObject({
      valid: false,
      hashValid: true,
      signatureValid: true,
      payloadMatchesEnvelopeFields: false,
      verifiedByNooscape: false,
    });
    expect(forgedEntries.issues).toContain("The signed canonical payload does not match the envelope's displayed fields.");

    // Same verdict for a forged outer agentId.
    const reagentId = structuredClone(packet);
    reagentId.envelope.agentId = "someone-else";
    const forgedAgent = await caller.atlas.verifyEvidence({ packet: reagentId });
    expect(forgedAgent).toMatchObject({ valid: false, payloadMatchesEnvelopeFields: false, verifiedByNooscape: false });
    expect(forgedAgent.agentId).toBe("someone-else");

    // The relay-attribution forgery: the public key is public, so a forger
    // copies the pinned key, mirrors every displayed field (the payload
    // binding passes), and attaches their own signature. Key pinning and
    // field binding alone prove nothing — only signatureValid can separate
    // this packet from a real relay issuance, and verifiedByNooscape must
    // follow it. 64 bytes of well-formed base64 so the failure is a wrong
    // signature, not an unparseable one.
    const reforged = structuredClone(packet);
    reforged.envelope.signature = "Zm9yZ2Vk".repeat(8);
    const forgedSignature = await caller.atlas.verifyEvidence({ packet: reforged });
    expect(forgedSignature).toMatchObject({
      valid: false,
      hashValid: true,
      signatureValid: false,
      keyMatchesEnvelope: true,
      payloadMatchesEnvelopeFields: true,
      issuedByCurrentRelay: true,
      verifiedByNooscape: false,
    });
    expect(forgedSignature.issues).toContain("The Ed25519 signature is invalid for this canonical payload.");
  });
});
