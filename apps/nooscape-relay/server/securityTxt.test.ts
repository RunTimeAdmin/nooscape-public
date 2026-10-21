import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSecurityTxt, SECURITY_CONTACT, SECURITY_TXT_VALID_DAYS, securityTxt } from "./securityTxt";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the text of security.txt", () => {
  const fields = (text: string) => Object.fromEntries(text.split("\n").filter(Boolean).map(line => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));

  it("names the contact, a date, a language and its own address, and nothing else", () => {
    const text = securityTxt(new Date("2026-10-17T12:34:56Z"));
    expect(Object.keys(fields(text))).toEqual(["Contact", "Expires", "Preferred-Languages", "Canonical"]);
    expect(fields(text).Contact).toBe("mailto:security@nooscape.si");
    expect(fields(text).Canonical).toBe("https://nooscape.si/.well-known/security.txt");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("expires 180 days out at midnight UTC, in the format the RFC asks for", () => {
    const expires = fields(securityTxt(new Date("2026-10-17T12:34:56Z"))).Expires!;
    expect(expires).toBe("2027-04-15T00:00:00.000Z");
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("is always in the future and under a year ahead, whatever the day", () => {
    for (const day of ["2026-01-01T00:00:00Z", "2026-02-28T23:59:59Z", "2027-12-31T23:59:59Z", "2028-02-29T10:00:00Z"]) {
      const now = new Date(day);
      const expires = new Date(fields(securityTxt(now)).Expires!).getTime();
      expect(expires, day).toBeGreaterThan(now.getTime());
      expect(expires - now.getTime(), day).toBeLessThan(365 * DAY_MS);
      expect(expires - now.getTime(), day).toBeGreaterThanOrEqual((SECURITY_TXT_VALID_DAYS - 1) * DAY_MS);
    }
  });
});

describe("serving it", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    const app = express();
    registerSecurityTxt(app);
    app.use((_req, res) => res.status(200).send("the client's catch-all"));
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("answers as plain text at the well-known path, before the catch-all", async () => {
    const response = await fetch(`${base}/.well-known/security.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body.startsWith("Contact: mailto:security@nooscape.si\n")).toBe(true);
    expect(body).not.toContain("catch-all");
  });

  it("answers a HEAD request the same way, without a body", async () => {
    const response = await fetch(`${base}/.well-known/security.txt`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("");
  });
});

describe("where it is wired and what it agrees with", () => {
  it("is mounted before the static files and the client's catch-all", () => {
    const source = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    expect(source).toContain("registerSecurityTxt(app);");
    expect(source.indexOf("registerSecurityTxt(app);")).toBeLessThan(source.indexOf("serveStatic(app);"));
  });

  it("names the same address as SECURITY.md", () => {
    const policy = readFileSync(new URL("../../../SECURITY.md", import.meta.url), "utf8");
    expect(policy).toContain(SECURITY_CONTACT.replace("mailto:", ""));
  });
});
