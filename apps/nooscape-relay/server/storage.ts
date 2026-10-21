// Storage adapter for Nooscape raw observations.
//
// Local WebDev previews use the existing Forge S3 helper. Production uses the
// private RustFS endpoint when all NOOSCAPE_S3_* variables are configured.
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

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

function getForgeConfig() {
  const forgeUrl = ENV.forgeApiUrl;
  const forgeKey = ENV.forgeApiKey;

  if (!forgeUrl || !forgeKey) {
    throw new Error("Storage config missing: configure RustFS production storage or WebDev Forge storage.");
  }

  return { forgeUrl: forgeUrl.replace(/\/+$/, ""), forgeKey };
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

function productionRetentionUntil(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const production = getProductionStorageConfig();
  if (production) {
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

  const { forgeUrl, forgeKey } = getForgeConfig();
  const key = appendHashSuffix(normalizeKey(relKey));
  const presignUrl = new URL("v1/storage/presign/put", `${forgeUrl}/`);
  presignUrl.searchParams.set("path", key);

  const presignResp = await fetch(presignUrl, {
    headers: { Authorization: `Bearer ${forgeKey}` },
  });
  if (!presignResp.ok) {
    const message = await presignResp.text().catch(() => presignResp.statusText);
    throw new Error(`Storage presign failed (${presignResp.status}): ${message}`);
  }

  const { url: s3Url } = (await presignResp.json()) as { url: string };
  if (!s3Url) throw new Error("Forge returned an empty presigned upload URL.");

  const blob = new Blob([data as any], { type: contentType });
  const uploadResp = await fetch(s3Url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!uploadResp.ok) throw new Error(`Storage upload to S3 failed (${uploadResp.status}).`);

  return { key, url: `/manus-storage/${key}` };
}

/**
 * The most a verification read will stream. Memory does not grow with it (the object is hashed as it arrives), so it bounds the
 * time a read can take. It matches the largest decompressed body an ingestion pass accepts.
 */
export const MAX_VERIFIED_OBJECT_BYTES = 512 * 1024 * 1024;

const declaredLength = (value: string | null): number | null => {
  const length = value === null ? NaN : Number(value);
  return Number.isFinite(length) && length >= 0 ? length : null;
};

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
  const production = getProductionStorageConfig();
  const tooLarge = "Stored evidence object exceeds the summary read limit.";
  let body: unknown;

  if (production) {
    const object = await getProductionClient(production).send(new GetObjectCommand({ Bucket: production.bucket, Key: key }));
    if (!object.Body) throw new Error("Stored evidence object had no body.");
    if (typeof object.ContentLength === "number" && object.ContentLength > maxBytes) {
      (object.Body as { destroy?: () => void }).destroy?.();
      throw new Error(tooLarge);
    }
    body = object.Body;
  } else {
    const response = await fetch(await storageGetSignedUrl(key));
    if (!response.ok) throw new Error(`Stored evidence read failed (${response.status}).`);
    const declared = declaredLength(response.headers.get("content-length"));
    if (declared !== null && declared > maxBytes) {
      await response.body?.cancel();
      throw new Error(tooLarge);
    }
    body = response.body;
  }

  // The bytes are counted as they arrive, so an object longer than it said (or that said nothing) stops at the cap and is not held.
  const chunks: Uint8Array[] = [];
  if (body) await streamBody(body, maxBytes, tooLarge, chunk => chunks.push(chunk));
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const key = normalizeKey(relKey);
  const production = getProductionStorageConfig();
  if (production) {
    return getSignedUrl(
      getProductionClient(production),
      new GetObjectCommand({ Bucket: production.bucket, Key: key }),
      { expiresIn: 5 * 60 }
    );
  }

  const { forgeUrl, forgeKey } = getForgeConfig();
  const getUrl = new URL("v1/storage/presign/get", `${forgeUrl}/`);
  getUrl.searchParams.set("path", key);
  const response = await fetch(getUrl, { headers: { Authorization: `Bearer ${forgeKey}` } });
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(`Storage signed URL failed (${response.status}): ${message}`);
  }
  const { url } = (await response.json()) as { url: string };
  return url;
}

/**
 * Reads an object only on the server and returns verification metadata, never
 * object bytes or a signed URL. This is used by the operator evidence-review
 * workflow before an observation can enter the public projection.
 */
export async function verifyStoredObject(relKey: string, expectedSha256: string, maxBytes = MAX_VERIFIED_OBJECT_BYTES) {
  const key = normalizeKey(relKey);
  const production = getProductionStorageConfig();
  const tooLarge = "Stored evidence object exceeds the verification limit.";
  // The object is hashed as it arrives and never held, so a large one costs time and not memory.
  const hash = createHash("sha256");
  let byteLength = 0;
  let retainUntil: Date | null = null;
  let retentionMode: string | null = null;

  if (production) {
    const client = getProductionClient(production);
    const object = await client.send(new GetObjectCommand({ Bucket: production.bucket, Key: key }));
    if (!object.Body) throw new Error("Stored evidence object had no body.");
    if (typeof object.ContentLength === "number" && object.ContentLength > maxBytes) {
      (object.Body as { destroy?: () => void }).destroy?.();
      throw new Error(tooLarge);
    }
    byteLength = await streamBody(object.Body, maxBytes, tooLarge, chunk => hash.update(chunk));
    const retention = await client.send(new GetObjectRetentionCommand({ Bucket: production.bucket, Key: key }));
    retainUntil = retention.Retention?.RetainUntilDate ?? null;
    retentionMode = retention.Retention?.Mode ?? null;
  } else {
    const response = await fetch(await storageGetSignedUrl(key));
    if (!response.ok) throw new Error(`Stored evidence read failed (${response.status}).`);
    const declared = declaredLength(response.headers.get("content-length"));
    if (declared !== null && declared > maxBytes) {
      await response.body?.cancel();
      throw new Error(tooLarge);
    }
    if (response.body) byteLength = await streamBody(response.body, maxBytes, tooLarge, chunk => hash.update(chunk));
  }

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
