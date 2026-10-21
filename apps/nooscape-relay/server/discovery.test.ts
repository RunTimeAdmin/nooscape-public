import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiChain } from "./apiChains";
import { indexAnswer } from "./apiV1";
import { defaultDiscoveryDeps, llmsText, registerDiscovery, x402WellKnown, type DiscoveryDeps } from "./discovery";
import { ARC_USDC } from "./x402";
import { createPaymentService } from "./x402Service";
import { memoryLedger, TEST_CIRCLE_KEY, TEST_PAY_TO, testConfig } from "./x402Testing";

/**
 * /llms.txt and /.well-known/x402 (docs/x402-discovery-2026-10-21.md). Both are built from what the API's own index serves and from the
 * live payment settings, so the tests hold them to that: nothing typed twice, nothing claimed about a payment that is not taken, nothing
 * secret, and a 404 (not the client's page) when there is nothing to list.
 */

const CHAINS: ApiChain[] = ["robinhood", "bnb", "solana", "base", "arc"];
const NOW = new Date("2026-10-21T12:00:00Z");
const index = (pay = testConfig() as ReturnType<typeof testConfig> | null) => indexAnswer(NOW, pay, undefined, CHAINS);
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe("the page for a model", () => {
  it("says what Nooscape is and is not first, in the form llms.txt readers expect: a title, a summary line and sections of links and lists", () => {
    const text = llmsText(index());
    const lines = text.split("\n");
    expect(lines[0]).toBe("# Nooscape");
    expect(lines[2]).toMatch(/^> Nooscape lists the AI agents that public registries record and reports dated facts about them\. It gives no score, rating or verdict/);
    expect(lines.filter(line => line.startsWith("## "))).toEqual(["## Documents", "## Endpoints", "## Chains", "## Keys", "## Pay per call (x402)", "## Rules"]);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("lists the endpoints, the chains and the key tiers as the API's own index serves them", () => {
    const served = index();
    const text = llmsText(served);
    for (const endpoint of served.endpoints) expect(text).toContain(`- \`${endpoint.method} ${endpoint.path}\`: ${endpoint.summary}`);
    for (const chain of served.chains) expect(text).toContain(`- ${chain.chain}: ${chain.label} (registries: ${chain.registries.join(", ")})`);
    expect(text).toContain("Robinhood Chain, BNB Chain, Solana, Base and Arc and keeps what it read");
    expect(text).toContain("- Free: 60 requests a minute and 1,000 a day.");
    expect(text).toContain("- Builder: 300 requests a minute and 50,000 a day.");
    expect(text).toContain("- Pro: 1,200 requests a minute and 500,000 a day.");
    expect(text).toContain("With no key, 30 requests a minute are allowed from one IP address.");
    expect(text).toContain(served.statement);
    expect(text).toContain(`Attribution: ${served.license.attribution}`);
  });

  it("follows the chains that are served: a chain that is off is not listed", () => {
    const text = llmsText(indexAnswer(NOW, null, undefined, ["robinhood", "bnb", "solana"]));
    expect(text).toContain("on Robinhood Chain, BNB Chain and Solana and keeps");
    expect(text).not.toMatch(/- arc:|- base:/);
  });

  it("gives the payment terms from the settings while pay per call is on, and the prices as set", () => {
    const text = llmsText(index(testConfig({ X402_PRICE_LOOKUP: "2500", X402_PRICE_CHECK: "20000" })));
    expect(text).toContain("`POST /api/v1/check`: $0.02 per call.");
    expect(text).toContain("`GET /api/v1/agents/{chain}/{id}`: $0.0025 per call, asked only after the free limit of 30 requests a minute is used.");
    expect(text).toContain(`Network: Arc mainnet (eip155:5042). Asset: USDC at ${ARC_USDC}. Pay to: ${TEST_PAY_TO}.`);
    expect(text).toContain("Wallets: regular wallets.");
    expect(text).toContain("https://nooscape.si/.well-known/x402");
    expect(llmsText(index(testConfig({ X402_RPC: "https://rpc.example.org/arc" })))).toContain("Wallets: regular wallets and smart-contract wallets.");
  });

  it("says nothing about payment while pay per call is not on", () => {
    const text = llmsText(index(null));
    expect(text).not.toMatch(/x402|PAYMENT-|per call|Pay to|USDC/i);
    expect(text).not.toContain(TEST_PAY_TO);
    expect(text).toContain("## Rules");
  });

  it("never carries a secret, and keeps to the house style: no long dash, and every link is a full https address", () => {
    const cfg = testConfig();
    for (const text of [llmsText(index(cfg)), llmsText(index(null))]) {
      expect(text).not.toContain(cfg.apiKey);
      expect(text).not.toContain(TEST_CIRCLE_KEY);
      expect(text).not.toContain(cfg.facilitator);
      expect(text).not.toMatch(/LIVE_API_KEY|TEST_API_KEY|X402_/);
      expect(text).not.toMatch(LONG_DASH);
      const links = [...text.matchAll(/\]\(([^)]*)\)/g)].map(match => match[1]!);
      expect(links.length).toBeGreaterThan(4);
      for (const link of links) expect(link, link).toMatch(/^https:\/\/nooscape\.si\//);
    }
  });
});

describe("the x402 discovery document", () => {
  it("is the x402scan format: a version and the routes that answer 402 to a caller with no key, as full addresses", () => {
    const document = x402WellKnown(testConfig());
    expect(document.version).toBe(1);
    expect(document.resources).toEqual(["https://nooscape.si/api/v1/check"]);
    expect(Object.keys(document).sort()).toEqual(["instructions", "resources", "version"]);
  });

  it("names the resource under the origin the 402 names, and the price as set", () => {
    const document = x402WellKnown(testConfig({ X402_RESOURCE_BASE: "https://example.org/", X402_PRICE_CHECK: "20000" }));
    expect(document.resources).toEqual(["https://example.org/api/v1/check"]);
    expect(document.instructions).toContain("$0.02 in USDC per call");
    expect(document.instructions).toContain("https://nooscape.si/api/v1/openapi.json");
  });

  it("holds no secret, no receiving address and no long dash", () => {
    const cfg = testConfig();
    const text = JSON.stringify(x402WellKnown(cfg));
    expect(text).not.toContain(cfg.apiKey);
    expect(text).not.toContain(cfg.facilitator);
    expect(text).not.toContain(cfg.payTo);
    expect(text).not.toMatch(LONG_DASH);
  });
});

describe("serving them", () => {
  const open: Server[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(open.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  async function serve(over: Partial<DiscoveryDeps>) {
    const app = express();
    registerDiscovery(app, { payments: null, chains: () => CHAINS, now: () => NOW, ...over });
    // What the client's catch-all would answer for any other path, to tell it from a real answer.
    app.use((_req, res) => void res.status(200).type("text/html").send("<html>the page</html>"));
    const server = await new Promise<Server>(resolve => {
      const created = app.listen(0, "127.0.0.1", () => resolve(created));
    });
    open.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const service = (options: { ready?: boolean; env?: Record<string, string> } = {}) => createPaymentService({ config: testConfig(options.env), ledger: memoryLedger({ ready: options.ready }).ledger });

  it("serves the page as plain text that other sites may read, cached for five minutes, with the payment section while payments are on", async () => {
    const base = await serve({ payments: service() });
    const response = await fetch(`${base}/llms.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const text = await response.text();
    expect(text.startsWith("# Nooscape\n")).toBe(true);
    expect(text).toContain("## Pay per call (x402)");
    expect(text).toContain(TEST_PAY_TO);
  });

  it("serves the discovery document as JSON with the same headers while payments are on", async () => {
    const base = await serve({ payments: service() });
    const response = await fetch(`${base}/.well-known/x402`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual(x402WellKnown(testConfig()));
    expect((await fetch(`${base}/.well-known/x402`, { method: "HEAD" })).status).toBe(200);
  });

  it.each([
    ["paused", () => service({ env: { X402_PAUSE_NEW: "1" } })],
    ["not recording payments", () => service({ ready: false })],
    ["not configured", () => null],
  ])("while pay per call is %s: the page leaves the payment section out, and the discovery document is a JSON 404 and not the client's page", async (_name, make) => {
    const base = await serve({ payments: make() });
    const page = await fetch(`${base}/llms.txt`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).not.toMatch(/x402|PAYMENT-|per call|Pay to/i);
    expect(text).toContain("## Endpoints");
    const missing = await fetch(`${base}/.well-known/x402`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toMatch(/^application\/json/);
    expect(missing.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "Pay per call is not taking payments." } });
  });

  it("when the payment state cannot be read: the page is still served without the payment section, and the discovery document is 503 and not cached", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = createPaymentService({
      config: testConfig(),
      ledger: {
        ...memoryLedger().ledger,
        ready: async () => {
          throw new Error("database down");
        },
      },
    });
    const base = await serve({ payments: broken });
    const page = await fetch(`${base}/llms.txt`);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toMatch(/x402|PAYMENT-|per call|Pay to/i);
    const unavailable = await fetch(`${base}/.well-known/x402`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect((await unavailable.json()).error.code).toBe("unavailable");
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain(TEST_CIRCLE_KEY);
  });

  it("answers these two paths only: the rest still reaches whatever is mounted after", async () => {
    const base = await serve({ payments: service() });
    for (const path of ["/llms", "/llms.txt.bak", "/.well-known/x402.json", "/.well-known/"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.headers.get("content-type"), path).toMatch(/text\/html/);
    }
  });

  it("is wired with the shared payment service and the served chains", () => {
    expect(Object.keys(defaultDiscoveryDeps).sort()).toEqual(["chains", "now", "payments"]);
    expect(defaultDiscoveryDeps.chains()).toEqual(expect.arrayContaining(["robinhood", "bnb", "solana"]));
  });
});
