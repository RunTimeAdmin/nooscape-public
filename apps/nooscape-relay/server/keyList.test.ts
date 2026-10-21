import { generateKeyPairSync } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { ENV } from "./_core/env";
import { sealEvidencePayload } from "./evidence";
import { registerRelayKeyList } from "./keyList";

const original = ENV.nooscapeEvidenceRetiredKeys;
afterEach(() => {
  ENV.nooscapeEvidenceRetiredKeys = original;
  vi.restoreAllMocks();
});

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

const fetchKeys = () => fetch(`${base}/.well-known/nooscape-keys.json`);

describe("/.well-known/nooscape-keys.json", () => {
  it("is public JSON that other sites may read, cached for five minutes", async () => {
    const response = await fetchKeys();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("keeps the shape of the hand-kept file it replaced", async () => {
    const body = await (await fetchKeys()).json();
    expect(body).toMatchObject({ format: "Nooscape Relay Key Manifest v1", algorithm: "Ed25519" });
    expect(body.keys[0]).toMatchObject({ status: "active", purpose: "Evidence-envelope verification" });
    expect(typeof body.keys[0].keyId).toBe("string");
  });

  it("publishes the active key as the packets carry it, so an exact string match works", async () => {
    const sealed = sealEvidencePayload({ envelopeVersion: "Nooscape Persisted Evidence v1", agentId: "x", entries: [] });
    const body = await (await fetchKeys()).json();
    expect(body.keys[0]).toMatchObject({ keyId: sealed.relayKeyId, publicKeyPem: sealed.relayPublicKeyPem });
  });

  it("lists retired and revoked keys with their dates and notes, and never a private key", async () => {
    const retired = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const revoked = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    ENV.nooscapeEvidenceRetiredKeys = JSON.stringify([
      { keyId: "old-1", publicKeyPem: retired, status: "retired", retiredAt: "2026-10-01T00:00:00.000Z", note: "rotated" },
      { keyId: "old-2", publicKeyPem: revoked, status: "revoked", note: "leaked" },
    ]);
    const text = await (await fetchKeys()).text();
    const body = JSON.parse(text);
    expect(body.keys.map((key: { keyId: string; status: string }) => `${key.keyId}:${key.status}`).slice(1)).toEqual(["old-1:retired", "old-2:revoked"]);
    expect(body.keys[1]).toMatchObject({ retiredAt: "2026-10-01T00:00:00.000Z", note: "rotated" });
    expect(text).not.toMatch(/PRIVATE KEY/);
  });
});
