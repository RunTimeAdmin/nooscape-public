import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The app trusts one proxy hop, and that is right only while Caddy is the only proxy and drops the X-Forwarded-* headers clients send
 * (it does when no trusted_proxies is set). If either side changes alone, req.ip becomes a proxy's address or a client's own claim,
 * and the per-address limits stop working. This pins the two together.
 */
const app = fileURLToPath(new URL("..", import.meta.url));
const caddyfile = join(app, "deploy", "vps", "Caddyfile");

describe("the proxy hop count", () => {
  it("is one in the app", () => {
    const index = readFileSync(join(app, "server", "_core", "index.ts"), "utf8");
    expect(index).toMatch(/app\.set\("trust proxy", 1\);/);
  });

  // Read only where the tree has the deploy kit.
  it.skipIf(!existsSync(caddyfile))("matches a Caddy that is the only hop and trusts no proxy before it", () => {
    const config = readFileSync(caddyfile, "utf8")
      .split("\n")
      .filter(line => !line.trim().startsWith("#"))
      .join("\n");
    expect(config).not.toMatch(/trusted_proxies/);
    expect(config.match(/reverse_proxy /g)).toHaveLength(1);
  });
});
