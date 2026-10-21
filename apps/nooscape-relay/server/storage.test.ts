import { afterEach, describe, expect, it, vi } from "vitest";

const original = {
  endpoint: process.env.NOOSCAPE_S3_ENDPOINT,
  bucket: process.env.NOOSCAPE_S3_BUCKET,
  accessKey: process.env.NOOSCAPE_S3_ACCESS_KEY,
  secretKey: process.env.NOOSCAPE_S3_SECRET_KEY,
  days: process.env.NOOSCAPE_EVIDENCE_RETENTION_DAYS,
};

function restoreEnvironment() {
  for (const [key, value] of Object.entries({
    NOOSCAPE_S3_ENDPOINT: original.endpoint,
    NOOSCAPE_S3_BUCKET: original.bucket,
    NOOSCAPE_S3_ACCESS_KEY: original.accessKey,
    NOOSCAPE_S3_SECRET_KEY: original.secretKey,
    NOOSCAPE_EVIDENCE_RETENTION_DAYS: original.days,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnvironment();
  vi.resetModules();
});

describe("production RustFS configuration", () => {
  it("falls back when no production storage variables are configured", async () => {
    delete process.env.NOOSCAPE_S3_ENDPOINT;
    delete process.env.NOOSCAPE_S3_BUCKET;
    delete process.env.NOOSCAPE_S3_ACCESS_KEY;
    delete process.env.NOOSCAPE_S3_SECRET_KEY;
    const { getProductionStorageConfig } = await import("./storage");
    expect(getProductionStorageConfig()).toBeNull();
  });

  it("fails closed for incomplete production storage configuration", async () => {
    process.env.NOOSCAPE_S3_ENDPOINT = "https://objects.nooscape.si";
    process.env.NOOSCAPE_S3_BUCKET = "nooscape-evidence";
    delete process.env.NOOSCAPE_S3_ACCESS_KEY;
    delete process.env.NOOSCAPE_S3_SECRET_KEY;
    const { getProductionStorageConfig } = await import("./storage");
    expect(() => getProductionStorageConfig()).toThrow("incomplete");
  });
});
