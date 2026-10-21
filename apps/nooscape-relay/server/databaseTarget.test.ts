import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { describeDatabaseTarget, parseDatabaseTarget } from "./databaseTarget";

/**
 * On 2026-10-14 every boot died with "Access denied for user ...@'<address>'",
 * which does not say which server the app tried, which database, or whether a
 * password was sent. The failure log now says, and must never carry the password.
 */
const PASSWORD = "S3cr3t%21pw-9Zq"; // percent-encoded in the URL, as the host's environment holds it
const lookup = (address: string) => vi.fn(async () => ({ address, family: address.includes(":") ? 6 : 4 })) as never;

describe("the database target", () => {
  it("is read from the URL: host, port, database, user", () => {
    expect(parseDatabaseTarget(`mysql://app_user:${PASSWORD}@srv0000.example.test:3307/app_db`)).toEqual({
      host: "srv0000.example.test",
      port: 3307,
      database: "app_db",
      user: "app_user",
      hasPassword: true,
    });
  });

  it("defaults the port, and reports a missing password and a missing database", () => {
    expect(parseDatabaseTarget("mysql://app_user@203.0.113.26")).toEqual({ host: "203.0.113.26", port: 3306, database: "", user: "app_user", hasPassword: false });
  });

  it("decodes a percent-encoded user and database name", () => {
    expect(parseDatabaseTarget("mysql://a%40b:pw@host/some%20db")).toMatchObject({ user: "a@b", database: "some db" });
  });

  it("reads an IPv6 host without its brackets", () => {
    expect(parseDatabaseTarget("mysql://u:pw@[2a02:4780:b:1234::187]:3306/db")).toMatchObject({ host: "2a02:4780:b:1234::187", port: 3306 });
  });

  it("is null for text that is not a URL", () => {
    expect(parseDatabaseTarget("not a url")).toBeNull();
    expect(parseDatabaseTarget("")).toBeNull();
  });
});

describe("the line the failure log carries", () => {
  it("names the host, the address it resolves to, the port, the database and the user", async () => {
    const line = await describeDatabaseTarget(`mysql://app_user:${PASSWORD}@srv0000.example.test:3306/app_db`, { lookup: lookup("203.0.113.26") });
    expect(line).toBe("connecting to host=srv0000.example.test (203.0.113.26) port=3306 database=app_db user=app_user password=set");
  });

  it("never carries the password, in any form, or the query string", async () => {
    for (const url of [
      `mysql://app_user:${PASSWORD}@srv0000.example.test/app_db`,
      `mysql://app_user:${PASSWORD}@srv0000.example.test/app_db?ssl=%7B%22ca%22%3A%22-----BEGIN%22%7D`,
      `mysql://app_user:${PASSWORD}@[2a02::1]:3306/app_db`,
    ]) {
      const line = await describeDatabaseTarget(url, { lookup: lookup("1.2.3.4") });
      expect(line, url).not.toContain("S3cr3t");
      expect(line, url).not.toContain("pw-9Zq");
      expect(line, url).not.toContain("decodeURI");
      expect(line, url).not.toContain("BEGIN");
      expect(line, url).not.toContain("ssl");
    }
  });

  it("does not echo a URL that does not parse, which may hold the password", async () => {
    const line = await describeDatabaseTarget("mysql://user:pa/ss#word@host/db??", { lookup: lookup("1.2.3.4") });
    expect(line).toContain("does not parse");
    expect(line).not.toContain("pa/ss");
    expect(line).not.toContain("word");
  });

  it("says when the variable is not set, or the password is empty", async () => {
    expect(await describeDatabaseTarget(undefined)).toBe("DATABASE_URL is not set");
    expect(await describeDatabaseTarget("mysql://u@host/db", { lookup: lookup("1.2.3.4") })).toContain("password=empty");
  });

  it("says why a name did not resolve instead of failing", async () => {
    const failing = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    }) as never;
    expect(await describeDatabaseTarget("mysql://u:pw@nowhere.invalid/db", { lookup: failing })).toContain("(lookup failed (ENOTFOUND))");
  });

  it("gives up on a lookup that never answers", async () => {
    const hanging = vi.fn(() => new Promise(() => {})) as never;
    const started = Date.now();
    const line = await describeDatabaseTarget("mysql://u:pw@slow.example/db", { lookup: hanging, timeoutMs: 50 });
    expect(line).toContain("(lookup failed (TIMEOUT))");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("is written by the server when migrations fail, before it exits", () => {
    const source = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import \{ describeDatabaseTarget \} from "\.\.\/databaseTarget";/);
    const failure = source.slice(source.indexOf("Failed to apply pending migrations"), source.indexOf("process.exit(1)"));
    expect(failure).toContain("await describeDatabaseTarget(process.env.DATABASE_URL)");
  });
});
