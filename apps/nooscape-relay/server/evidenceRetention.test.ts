import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV } from "./_core/env";
import { createPersistedEvidenceEnvelope } from "./evidence";
import { getProductionStorageConfig } from "./storage";

vi.mock("./db", () => ({
  getDb: async () => ({}),
  listPersistedEvidenceEntries: async () => [
    {
      id: "event-1",
      observedAt: new Date("2026-11-01T00:00:00.000Z"),
      event: "observed",
      detail: "A card was observed.",
      proofReference: null,
      payloadHash: "b".repeat(64),
      observationId: "observation-1",
      contentHash: "a".repeat(64),
      canonicalLocator: "https://source.example.org/card",
      protocol: "a2a",
      validationStatus: "valid",
      sourceLabel: "Example source",
      sourceRoot: "https://source.example.org",
    },
  ],
}));

/**
 * The retention line of a signed envelope used to say "90 days" whatever NOOSCAPE_EVIDENCE_RETENTION_DAYS was (outside review of 2 November
 * 2026). It is now read from the same place storage reads the setting, so the statement the relay signs is the retention it asks for.
 */
const unverified = { status: "unverified" as const, publisherName: null, publicKeyFingerprint: null, verifiedAt: null, statusChangedAt: null };
const original = { days: ENV.nooscapeEvidenceRetentionDays, endpoint: ENV.nooscapeS3Endpoint, bucket: ENV.nooscapeS3Bucket, access: ENV.nooscapeS3AccessKey, secret: ENV.nooscapeS3SecretKey };

afterEach(() => {
  ENV.nooscapeEvidenceRetentionDays = original.days;
  ENV.nooscapeS3Endpoint = original.endpoint;
  ENV.nooscapeS3Bucket = original.bucket;
  ENV.nooscapeS3AccessKey = original.access;
  ENV.nooscapeS3SecretKey = original.secret;
});

const retentionOf = async () => {
  const envelope = await createPersistedEvidenceEnvelope("agent-1", unverified);
  return { statement: envelope?.provenance.retentionPolicy, signed: JSON.parse(envelope!.canonicalPayload).provenance.retentionPolicy as string };
};

describe("the retention line of a signed envelope", () => {
  it("says 90 days when the setting is not set, as before", async () => {
    ENV.nooscapeEvidenceRetentionDays = "";
    expect(await retentionOf()).toEqual({ statement: "GOVERNANCE / 90 days per observation", signed: "GOVERNANCE / 90 days per observation" });
  });

  it("follows the setting, in the signed payload too", async () => {
    ENV.nooscapeEvidenceRetentionDays = "30";
    expect(await retentionOf()).toEqual({ statement: "GOVERNANCE / 30 days per observation", signed: "GOVERNANCE / 30 days per observation" });
    ENV.nooscapeEvidenceRetentionDays = "365";
    expect((await retentionOf()).signed).toBe("GOVERNANCE / 365 days per observation");
  });

  it("is the number storage asks the object store for", async () => {
    ENV.nooscapeS3Endpoint = "https://objects.example.org";
    ENV.nooscapeS3Bucket = "evidence";
    ENV.nooscapeS3AccessKey = "access";
    ENV.nooscapeS3SecretKey = "secret";
    ENV.nooscapeEvidenceRetentionDays = "45";
    expect(getProductionStorageConfig()?.retentionDays).toBe(45);
    expect((await retentionOf()).signed).toBe("GOVERNANCE / 45 days per observation");
  });

  it("states no number that storage would refuse", async () => {
    for (const bad of ["0", "366", "1.5", "ninety"]) {
      ENV.nooscapeEvidenceRetentionDays = bad;
      await expect(createPersistedEvidenceEnvelope("agent-1", unverified)).rejects.toThrow("between 1 and 365");
    }
  });
});
