import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two reads of a stored evidence object. An object is counted as it arrives: one that is longer than it said, or that said nothing,
 * stops at the cap and is not held, and one that declares a length over the cap is not read at all. A verification hashes the object
 * as it streams, so memory does not grow with it.
 */
const mocked = vi.hoisted(() => ({ send: null as null | ((command: { kind: string; input: unknown }) => Promise<unknown>) }));

vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    kind = "get";
    constructor(public input: unknown) {}
  }
  class GetObjectRetentionCommand {
    kind = "retention";
    constructor(public input: unknown) {}
  }
  class PutObjectCommand {
    kind = "put";
    constructor(public input: unknown) {}
  }
  class S3Client {
    send(command: { kind: string; input: unknown }) {
      return mocked.send!(command);
    }
  }
  return { GetObjectCommand, GetObjectRetentionCommand, PutObjectCommand, S3Client };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn(async () => "https://objects.example/signed") }));

const original = Object.fromEntries(["NOOSCAPE_S3_ENDPOINT", "NOOSCAPE_S3_BUCKET", "NOOSCAPE_S3_ACCESS_KEY", "NOOSCAPE_S3_SECRET_KEY"].map(name => [name, process.env[name]]));

function configure() {
  for (const name of Object.keys(original)) delete process.env[name];
  process.env.NOOSCAPE_S3_ENDPOINT = "https://objects.example";
  process.env.NOOSCAPE_S3_BUCKET = "evidence";
  process.env.NOOSCAPE_S3_ACCESS_KEY = "key";
  process.env.NOOSCAPE_S3_SECRET_KEY = "secret";
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  mocked.send = null;
});

/** A body that hands out `chunks` one at a time and counts how many were pulled. */
function body(chunks: Buffer[]) {
  const state = { pulled: 0, destroyed: false };
  const stream = new Readable({
    read() {
      const next = chunks[state.pulled];
      state.pulled += 1;
      this.push(next ?? null);
    },
    destroy(error, callback) {
      state.destroyed = true;
      callback(error);
    },
  });
  return { stream, state };
}

const KIB = 1024;

describe("storageReadText, in production", () => {
  it("reads a small object as text", async () => {
    configure();
    mocked.send = async () => ({ Body: body([Buffer.from("hello "), Buffer.from("world")]).stream, ContentLength: 11 });
    const { storageReadText } = await import("./storage");
    expect(await storageReadText("a/b.json")).toBe("hello world");
  });

  it("does not read an object whose declared length is over the cap, and ends its stream", async () => {
    configure();
    const { stream, state } = body([Buffer.alloc(KIB)]);
    mocked.send = async () => ({ Body: stream, ContentLength: 10 * 1024 * KIB });
    const { storageReadText } = await import("./storage");
    await expect(storageReadText("a/b.json")).rejects.toThrow("Stored evidence object exceeds the summary read limit.");
    expect(state.pulled).toBe(0);
    expect(state.destroyed).toBe(true);
  });

  it("stops an object that said nothing, or said less than it sent, at the cap, without reading the rest", async () => {
    configure();
    const chunks = Array.from({ length: 50 }, () => Buffer.alloc(100 * KIB, 97));
    for (const declared of [undefined, 10]) {
      const { stream, state } = body(chunks);
      mocked.send = async () => ({ Body: stream, ...(declared === undefined ? {} : { ContentLength: declared }) });
      const { storageReadText } = await import("./storage");
      await expect(storageReadText("a/b.json")).rejects.toThrow("Stored evidence object exceeds the summary read limit.");
      // 256 KiB is the cap: the third 100 KiB chunk passes it, and nothing after that is asked for.
      expect(state.pulled).toBeLessThanOrEqual(4);
      expect(state.destroyed).toBe(true);
      vi.resetModules();
    }
  });

  it("takes the cap as an argument, and an object exactly at it is read", async () => {
    configure();
    mocked.send = async () => ({ Body: body([Buffer.from("12345")]).stream, ContentLength: 5 });
    const { storageReadText } = await import("./storage");
    expect(await storageReadText("a/b.json", 5)).toBe("12345");
    mocked.send = async () => ({ Body: body([Buffer.from("123456")]).stream, ContentLength: 6 });
    await expect(storageReadText("a/b.json", 5)).rejects.toThrow("summary read limit");
  });

  it("says an object with no body has none", async () => {
    configure();
    mocked.send = async () => ({ ContentLength: 0 });
    const { storageReadText } = await import("./storage");
    await expect(storageReadText("a/b.json")).rejects.toThrow("Stored evidence object had no body.");
  });
});

describe("verifyStoredObject, in production", () => {
  const retention = { Retention: { Mode: "GOVERNANCE", RetainUntilDate: new Date("2027-01-01T00:00:00Z") } };
  const route = (object: unknown) => async (command: { kind: string }) => (command.kind === "retention" ? retention : object);

  it("hashes the object as it streams, counts its bytes, and reports its retention", async () => {
    configure();
    const parts = [Buffer.from("alpha "), Buffer.from("beta "), Buffer.from("gamma")];
    const expected = createHash("sha256").update(Buffer.concat(parts)).digest("hex");
    mocked.send = route({ Body: body(parts).stream, ContentLength: 16 });
    const { verifyStoredObject } = await import("./storage");
    const result = await verifyStoredObject("a/b.json", expected);
    expect(result).toMatchObject({ key: "a/b.json", byteLength: 16, expectedSha256: expected, actualSha256: expected, hashMatches: true, retentionMode: "GOVERNANCE" });
    expect(result.retainUntil).toEqual(new Date("2027-01-01T00:00:00Z"));
  });

  it("says the hash does not match, rather than throwing, when the bytes are not the ones expected", async () => {
    configure();
    mocked.send = route({ Body: body([Buffer.from("changed")]).stream });
    const { verifyStoredObject } = await import("./storage");
    const result = await verifyStoredObject("a/b.json", "0".repeat(64));
    expect(result.hashMatches).toBe(false);
    expect(result.actualSha256).toBe(createHash("sha256").update("changed").digest("hex"));
  });

  it("does not read an object that declares more than the ceiling, and stops one that streams past it", async () => {
    configure();
    const declared = body([Buffer.alloc(KIB)]);
    mocked.send = route({ Body: declared.stream, ContentLength: 3 * KIB });
    const { verifyStoredObject, MAX_VERIFIED_OBJECT_BYTES } = await import("./storage");
    await expect(verifyStoredObject("a/b.json", "0".repeat(64), 2 * KIB)).rejects.toThrow("Stored evidence object exceeds the verification limit.");
    expect(declared.state.pulled).toBe(0);

    const silent = body(Array.from({ length: 40 }, () => Buffer.alloc(KIB)));
    mocked.send = route({ Body: silent.stream });
    await expect(verifyStoredObject("a/b.json", "0".repeat(64), 5 * KIB)).rejects.toThrow("verification limit");
    expect(silent.state.pulled).toBeLessThanOrEqual(7);
    expect(silent.state.destroyed).toBe(true);
    expect(MAX_VERIFIED_OBJECT_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe("storage that is not configured", () => {
  // There is no other place evidence can go: without the NOOSCAPE_S3_* variables a write and both reads fail, in any environment.
  it("fails a write and both reads, and does not reach for a network", async () => {
    for (const name of Object.keys(original)) delete process.env[name];
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const { storagePut, storageReadText, storageGetSignedUrl, verifyStoredObject } = await import("./storage");
    await expect(storagePut("a/b.json", "text")).rejects.toThrow("Evidence storage is not configured");
    await expect(storageReadText("a/b.json")).rejects.toThrow("Evidence storage is not configured");
    await expect(storageGetSignedUrl("a/b.json")).rejects.toThrow("Evidence storage is not configured");
    await expect(verifyStoredObject("a/b.json", "0".repeat(64))).rejects.toThrow("Evidence storage is not configured");
    expect(fetched).not.toHaveBeenCalled();
  });
});
