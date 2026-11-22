import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWwwRedirect } from "./wwwRedirect";

/**
 * www.nooscape.si answered with the same pages as the apex, so Search Console saw every page twice. The redirect sends
 * the www host to the one address, keeps the path and query, and leaves every other host alone.
 */
describe("www redirect", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    const app = express();
    app.set("trust proxy", 1);
    registerWwwRedirect(app);
    app.all("*", (_req, res) => { res.status(200).send("PAGE"); });
    server = app.listen(0);
    await new Promise(resolve => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  const hit = (pathname: string, host: string, method = "GET") =>
    fetch(`${base}${pathname}`, { method, redirect: "manual", headers: { "X-Forwarded-Host": host } });

  it("sends a GET on www to the same path and query on the apex, permanently", async () => {
    const response = await hit("/agents/abc?tab=checks", "www.nooscape.si");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://nooscape.si/agents/abc?tab=checks");
  });

  it("treats the host without regard to case or a trailing dot", async () => {
    const response = await hit("/", "WWW.Nooscape.si.");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://nooscape.si/");
  });

  it("uses 308 for other methods, so a POST keeps its method and body", async () => {
    const response = await hit("/api/trpc/x", "www.nooscape.si", "POST");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://nooscape.si/api/trpc/x");
  });

  it("leaves the apex and every other host alone", async () => {
    for (const host of ["nooscape.si", "localhost", "www.nooscape.si.example.com"]) {
      const response = await hit("/agents/abc", host);
      expect(response.status, host).toBe(200);
      expect(await response.text()).toBe("PAGE");
    }
  });
});
