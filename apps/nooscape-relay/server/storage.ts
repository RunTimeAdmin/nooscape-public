// Storage adapter for Nooscape raw observations.
//
// Evidence goes to the private RustFS endpoint when all NOOSCAPE_S3_* variables are configured, and nowhere else: a read or a write
// without that configuration fails, so nothing is stored in an unconfigured place.
// No S3 credential or object URL is sent to a client.

import { GetObjectCommand, GetObjectRetentionCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { ENV } from "./_core/env";

type ProductionStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  retentionDays: number;
};

let productionClient: S3Client | null = null;
let productionClientFingerprint: string | null = null;

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

/**
 * Returns production storage settings only when the configuration is complete.
 * A partial configuration fails closed instead of silently writing evidence to a
 * different backend.
 */
export function getProductionStorageConfig(): ProductionStorageConfig | null {
  const fields = [
    ENV.nooscapeS3Endpoint,
    ENV.nooscapeS3Bucket,
    ENV.nooscapeS3AccessKey,
    ENV.nooscapeS3SecretKey,
  ];
  const configuredFieldCount = fields.filter(Boolean).length;

  if (configuredFieldCount === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Nooscape production S3 configuration is required for immutable evidence storage.");
    }
    return null;
  }
  if (configuredFieldCount !== fields.length) {
    throw new Error("Nooscape production S3 configuration is incomplete.");
  }

  const retentionDays = Number(ENV.nooscapeEvidenceRetentionDays || "90");
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("NOOSCAPE_EVIDENCE_RETENTION_DAYS must be an integer between 1 and 365.");
  }

  return {
    endpoint: ENV.nooscapeS3Endpoint.replace(/\/+$/, ""),
    region: ENV.nooscapeS3Region || "us-east-1",
    bucket: ENV.nooscapeS3Bucket,
    accessKeyId: ENV.nooscapeS3AccessKey,
    secretAccessKey: ENV.nooscapeS3SecretKey,
    retentionDays,
  };
}

function getProductionClient(config: ProductionStorageConfig) {
  const fingerprint = `${config.endpoint}|${config.region}|${config.bucket}|${config.accessKeyId}`;
  if (productionClient && productionClientFingerprint === fingerprint) return productionClient;

  productionClient = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  productionClientFingerprint = fingerprint;
  return productionClient;
}

/** The production storage settings, or an error: there is no other place evidence can go. */
function requireProductionStorage(): ProductionStorageConfig {
  const production = getProductionStorageConfig();
  if (!production) throw new Error("Evidence storage is not configured: set the NOOSCAPE_S3_* variables.");
  return production;
}

function productionRetentionUntil(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const production = requireProductionStorage();
  // The caller supplies a content-addressed key. Do not add a random suffix in
  // production because the database needs a stable immutable object reference.
  const key = normalizeKey(relKey);
  const client = getProductionClient(production);
  const retainUntil = productionRetentionUntil(production.retentionDays);

  await client.send(
    new PutObjectCommand({
      Bucket: production.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
      ObjectLockMode: "GOVERNANCE",
      ObjectLockRetainUntilDate: retainUntil,
    })
  );

  return { key, url: `s3://${production.bucket}/${key}` };
}

/**
 * The most a verification read will stream. Memory does not grow with it (the object is hashed as it arrives), so it bounds the
 * time a read can take. It matches the largest decompressed body an ingestion pass accepts.
 */
export const MAX_VERIFIED_OBJECT_BYTES = 512 * 1024 * 1024;

/**
 * Hands each chunk of an object body to `onChunk` and counts the bytes, stopping with `tooLarge` as soon as the count passes
 * `ceiling`. Leaving the loop early ends the stream, so the rest of the object is not read.
 */
async function streamBody(body: unknown, ceiling: number, tooLarge: string, onChunk: (chunk: Uint8Array) => void): Promise<number> {
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > ceiling) throw new Error(tooLarge);
    onChunk(chunk);
  }
  return total;
}

/**
 * Reads a bounded private evidence object only on the server. This is for
 * deriving small public summaries, never for proxying raw evidence to clients.
 */
export async function storageReadText(relKey: string, maxBytes = 256 * 1024): Promise<string> {
  const key = normalizeKey(relKey);
  const production = requireProductionStorage();
  const tooLarge = "Stored evidence object exceeds the summary read limit.";

  const object = await getProductionClient(production).send(new GetObjectCommand({ Bucket: production.bucket, Key: key }));
  if (!object.Body) throw new Error("Stored evidence object had no body.");
  if (typeof object.ContentLength === "number" && object.ContentLength > maxBytes) {
    (object.Body as { destroy?: () => void }).destroy?.();
    throw new Error(tooLarge);
  }

  // The bytes are counted as they arrive, so an object longer than it said (or that said nothing) stops at the cap and is not held.
  const chunks: Uint8Array[] = [];
  await streamBody(object.Body, maxBytes, tooLarge, chunk => chunks.push(chunk));
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const key = normalizeKey(relKey);
  const production = requireProductionStorage();
  return getSignedUrl(
    getProductionClient(production),
    new GetObjectCommand({ Bucket: production.bucket, Key: key }),
    { expiresIn: 5 * 60 }
  );
}

/**
 * Reads an object only on the server and returns verification metadata, never
 * object bytes or a signed URL. This is used by the operator evidence-review
 * workflow before an observation can enter the public projection.
 */
export async function verifyStoredObject(relKey: string, expectedSha256: string, maxBytes = MAX_VERIFIED_OBJECT_BYTES) {
  const key = normalizeKey(relKey);
  const production = requireProductionStorage();
  const tooLarge = "Stored evidence object exceeds the verification limit.";
  // The object is hashed as it arrives and never held, so a large one costs time and not memory.
  const hash = createHash("sha256");

  const client = getProductionClient(production);
  const object = await client.send(new GetObjectCommand({ Bucket: production.bucket, Key: key }));
  if (!object.Body) throw new Error("Stored evidence object had no body.");
  if (typeof object.ContentLength === "number" && object.ContentLength > maxBytes) {
    (object.Body as { destroy?: () => void }).destroy?.();
    throw new Error(tooLarge);
  }
  const byteLength = await streamBody(object.Body, maxBytes, tooLarge, chunk => hash.update(chunk));
  const retention = await client.send(new GetObjectRetentionCommand({ Bucket: production.bucket, Key: key }));
  const retainUntil: Date | null = retention.Retention?.RetainUntilDate ?? null;
  const retentionMode: string | null = retention.Retention?.Mode ?? null;

  const actualSha256 = hash.digest("hex");
  return {
    key,
    byteLength,
    expectedSha256,
    actualSha256,
    hashMatches: actualSha256 === expectedSha256,
    retentionMode,
    retainUntil,
  };
}
