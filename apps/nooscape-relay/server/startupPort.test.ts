import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the port the relay listens on", () => {
  const source = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");

  it("is the one it was given in production, never a neighbour of it", () => {
    expect(source).toMatch(/process\.env\.NODE_ENV === "production" \? preferredPort : await findAvailablePort\(preferredPort\)/);
  });
});
