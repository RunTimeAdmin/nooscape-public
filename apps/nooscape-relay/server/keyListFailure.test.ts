import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

// With no signing key in production the key list cannot be built. The route must answer plainly, not with a stack trace.
vi.mock("./evidence", () => ({
  listRelayKeys: () => {
    throw new Error("NOOSCAPE_EVIDENCE_SIGNING_PRIVATE_KEY is required in production.");
  },
}));

import { registerRelayKeyList } from "./keyList";

describe("/.well-known/nooscape-keys.json without a signing key", () => {
  it("answers 503 with a short JSON error, uncached, and logs the reason", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = express();
    registerRelayKeyList(app);
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/nooscape-keys.json`);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "The key list is unavailable." });
      expect(text).not.toMatch(/SIGNING_PRIVATE_KEY|at .*\.ts/);
      expect(error).toHaveBeenCalled();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
