import dns from "node:dns";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { preferIPv4 } from "./_core/ipv4First";

/**
 * Hostinger's database host has an A and an AAAA record and the app's container
 * has an IPv6 address of its own, so a hostname in DATABASE_URL made the app
 * connect over IPv6, MySQL did not accept that client address, and every boot
 * died at the migration step (2026-10-14). The app now looks names up IPv4 first.
 */
const original = dns.getDefaultResultOrder();
afterEach(() => dns.setDefaultResultOrder(original));

describe("hostname lookups", () => {
  it("return IPv4 addresses first once the app has asked for it", async () => {
    dns.setDefaultResultOrder("verbatim");
    preferIPv4();
    expect(dns.getDefaultResultOrder()).toBe("ipv4first");
    // localhost has an IPv4 address everywhere and often an IPv6 one too; whichever the system lists first, IPv4 leads.
    const addresses = await dns.promises.lookup("localhost", { all: true });
    expect(addresses[0]!.family).toBe(4);
  });

  it("are not reordered until it does", () => {
    dns.setDefaultResultOrder("verbatim");
    expect(dns.getDefaultResultOrder()).toBe("verbatim");
  });
});

describe("the server's startup", () => {
  it("asks for IPv4 first before it opens the database", () => {
    const source = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import \{ preferIPv4 \} from "\.\/ipv4First";/);
    expect(source).toMatch(/^preferIPv4\(\);$/m);
    // The call is at module level, so it runs before startServer() makes its first connection.
    expect(source.indexOf("preferIPv4();")).toBeLessThan(source.indexOf("async function startServer"));
  });
});
