import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiChain } from "./apiChains";
import { indexAnswer } from "./apiV1";
import { SUPPORT_EMAIL } from "../client/src/lib/contacts";
import { apiV1SpecFor } from "./apiV1Spec";
import { defaultDiscoveryDeps, llmsText, registerDiscovery, skillText, x402OpenApi, x402WellKnown, type DiscoveryDeps } from "./discovery";
import { ARC_USDC, BASE_MAINNET, ARC_MAINNET, DESCRIPTIONS, SERVICE_NAME, SERVICE_TAGS, railsOf, requirements, termsReply } from "./x402";
import { bazaarFor, CHECK_BODY_EXAMPLE } from "./x402Bazaar";
import { createPaymentService } from "./x402Service";
import { memoryLedger, newCdpKeys, TEST_CIRCLE_KEY, TEST_PAY_TO, testConfig } from "./x402Testing";

/**
 * /llms.txt, /skill.md, /.well-known/x402 and /openapi.json (docs/x402-discovery-2026-10-21.md). They are built from what the API's own index and
 * spec serve and from the live payment settings, so the tests hold them to that: nothing typed twice, nothing claimed about a payment that
 * is not taken, nothing secret, and a 404 (not the client's page) when there is nothing to list.
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

  it("says the check can be paid for with no key only while pay per call is on, at the price as set, in the index and in the page", () => {
    const summaryOf = (answer: ReturnType<typeof index>) => answer.endpoints.find(endpoint => endpoint.path === "/api/v1/check")!.summary;
    const base = "Pre-flight facts for an agent, a wallet or an endpoint URL, with their dates. Needs a Pro key";
    const priced = index(testConfig({ X402_PRICE_CHECK: "20000" }));
    expect(summaryOf(priced)).toBe(`${base}, or $0.02 a call with no key.`);
    expect(summaryOf(index(null))).toBe(`${base}.`);
    // The page prints the index's own words, so it follows: with payments on it says so, and with them off it claims no payment.
    expect(llmsText(priced)).toContain(`\`POST /api/v1/check\`: ${base}, or $0.02 a call with no key.`);
    expect(llmsText(index(null))).toContain(`\`POST /api/v1/check\`: ${base}.`);
    expect(llmsText(index(null))).not.toContain("a call with no key");
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

describe("the skill file", () => {
  /** The header an agent loads a skill by: checks its four lines and returns the description, which is a JSON string and so a valid YAML one. */
  const descriptionOf = (text: string) => {
    const lines = text.split("\n");
    expect(lines.slice(0, 2)).toEqual(["---", "name: nooscape"]);
    expect(lines[2]!.startsWith("description: ")).toBe(true);
    expect(lines[3]).toBe("---");
    return JSON.parse(lines[2]!.slice("description: ".length)) as string;
  };
  const baseSmart = (env: Record<string, string> = {}) => testConfig({ ...newCdpKeys().env, BASE_RPC_URL: "https://base-node.example.org/rpc", X402_BASE_SMART_WALLETS: "1", ...env });

  it("opens with the header an agent loads a skill by, a name and a description of at most 1024 characters, then says what Nooscape is and is not", () => {
    for (const pay of [testConfig(), null]) {
      const text = skillText(index(pay));
      const description = descriptionOf(text);
      expect(description.length).toBeLessThanOrEqual(1024);
      expect(description).toContain("no score, rating or verdict");
      expect(description).toContain("not whether something is safe");
      const lines = text.split("\n");
      expect(lines[5]).toBe("# Nooscape");
      expect(lines[7]).toMatch(/^> Nooscape lists the AI agents that public registries record and reports dated facts about them\. It gives no score, rating or verdict/);
      expect(text.endsWith("\n")).toBe(true);
    }
  });

  it("has its sections in the order an agent needs them, and the payment section only while pay per call is on", () => {
    const sections = (text: string) => text.split("\n").filter(line => line.startsWith("## "));
    const common = ["## When to use it", "## Calls", "## Chains", "## The pre-flight check"];
    const closing = ["## Reading the answer", "## Rules", "## Documents"];
    expect(sections(skillText(index()))).toEqual([...common, "## Paying for the check (x402)", ...closing]);
    expect(sections(skillText(index(null)))).toEqual([...common, ...closing]);
  });

  it("teaches the calls in the API's own words, and the parameter names it gives are the OpenAPI document's", () => {
    const served = index();
    const text = skillText(served);
    for (const [method, path] of [
      ["GET", "/api/v1/agents/{chain}/{id}"],
      ["GET", "/api/v1/agents/search"],
      ["GET", "/api/v1/stats"],
      ["POST", "/api/v1/check"],
    ] as const) {
      const endpoint = served.endpoints.find(item => item.method === method && item.path === path);
      expect(endpoint, `${method} ${path}`).toBeDefined();
      expect(text).toContain(`- \`${method} ${path}\`: ${endpoint!.summary}`);
    }
    expect(text).toContain("With no key, 30 requests a minute are allowed from one IP address. Over the limit, wait the seconds in the Retry-After header.");
    const spec = apiV1SpecFor(CHAINS) as unknown as { paths: Record<string, Record<string, { parameters?: { name: string; schema?: { enum?: string[] } }[] }>> };
    const search = spec.paths["/api/v1/agents/search"]!.get!.parameters!.map(parameter => parameter.name);
    for (const name of ["q", "owner", "host"]) expect(search).toContain(name);
    expect(text).toContain("Give exactly one of `q`, `owner` or `host`.");
    const registry = spec.paths["/api/v1/agents/{chain}/{id}"]!.get!.parameters!.find(parameter => parameter.name === "registry");
    expect(registry?.schema?.enum?.length).toBeGreaterThan(0);
    expect(text).toContain("ask again with `registry` set to one of them");
    for (const option of registry!.schema!.enum!) expect(text, option).toContain(option);
  });

  it("names the check's four flags in the order the OpenAPI document lists them, and says what a present first_seen means and how many listings a wallet or a url gets", () => {
    expect(JSON.stringify(apiV1SpecFor(CHAINS))).toContain('"required":["first_seen","ownership_changes","revoked_feedback","fleet"]');
    const text = skillText(index());
    const flags = text
      .split("\n")
      .filter(line => /^- `(first_seen|ownership_changes|revoked_feedback|fleet)`: /.test(line))
      .map(line => line.slice(3, line.indexOf("`", 3)));
    expect(flags).toEqual(["first_seen", "ownership_changes", "revoked_feedback", "fleet"]);
    expect(text).toContain("it is present when that was within 30 days");
    expect(text).toContain("A wallet or a url is answered for the listings that match it exactly, newest first, up to 10.");
    expect(text).toContain(`\`${JSON.stringify(CHECK_BODY_EXAMPLE)}\``);
    expect(text).toContain("plus `registry` on Solana");
  });

  it("follows the chains that are served: a chain that is off is not listed, in the description or the list, and the list is llms.txt's", () => {
    const fewer = skillText(indexAnswer(NOW, null, undefined, ["robinhood", "bnb", "solana"]));
    expect(descriptionOf(fewer)).toContain("Nooscape reads the registries on Robinhood Chain, BNB Chain and Solana.");
    expect(fewer).toContain("on Robinhood Chain, BNB Chain and Solana and keeps");
    expect(fewer).not.toMatch(/- arc:|- base:/);
    const served = index();
    const text = skillText(served);
    for (const chain of served.chains) expect(text).toContain(`- ${chain.chain}: ${chain.label} (registries: ${chain.registries.join(", ")})`);
  });

  it("gives the payment terms from the settings while pay per call is on: the price as set, the networks as llms.txt states them, and the user asked first", () => {
    const served = index(testConfig({ ...newCdpKeys().env, X402_PRICE_LOOKUP: "2500", X402_PRICE_CHECK: "20000" }));
    const text = skillText(served);
    expect(text).toContain("- Price: $0.02 per call.");
    expect(text).toContain(`- Network: Arc mainnet (eip155:5042). Asset: USDC at ${ARC_USDC}. Pay to: ${TEST_PAY_TO}.`);
    const networks = llmsText(served).split("\n").filter(line => line.startsWith("- Network: "));
    expect(networks).toHaveLength(2);
    for (const line of networks) expect(text).toContain(line);
    expect(text).toContain("https://nooscape.si/.well-known/x402");
    expect(text).toContain("Past the free limit, a lookup with no key is answered 402 with a price ($0.0025) instead of 429. Waiting a minute is free, so do not pay it unless your user asks you to.");
    expect(text).toContain("Before you pay, tell your user the price, the network and the payee, and get a yes.");
    expect(text).toContain("Check the network, the payee and the asset in the 402 against the lines above.");
    expect(text).toContain("If you cannot tell whether a payment went through, do not pay again: report it.");
    expect(descriptionOf(text)).toContain("paid for per call in USDC");
  });

  it("mentions Coinbase's Wallet MCP only while Base takes the smart-contract wallet it signs with, and quotes the price as set", () => {
    expect(skillText(index(baseSmart()))).toContain(
      "Coinbase's Wallet MCP pays in two calls: `initiate_x402_request` with the url, the method, the JSON body and `maxPayment` set to \"0.01\", then `complete_x402_request` with the request id it returns."
    );
    expect(skillText(index(baseSmart({ X402_PRICE_CHECK: "20000" })))).toContain("`maxPayment` set to \"0.02\"");
    const without = [
      ["Base on, regular wallets only", testConfig(newCdpKeys().env)],
      ["Arc only", testConfig()],
      ["Arc with its node, which takes smart-contract wallets there", testConfig({ X402_RPC: "https://rpc.example.org/arc" })],
      ["pay per call off", null],
    ] as const;
    for (const [name, pay] of without) expect(skillText(index(pay)), name).not.toMatch(/Wallet MCP|maxPayment|initiate_x402_request/);
  });

  it("says nothing about payment while pay per call is not on", () => {
    const text = skillText(index(null));
    expect(text).not.toMatch(/x402|PAYMENT-|per call|Pay to|USDC|Wallet MCP|maxPayment|\b402\b/i);
    expect(text).not.toContain(TEST_PAY_TO);
    expect(descriptionOf(text)).not.toMatch(/USDC|per call/);
    expect(text).toContain("## Rules");
  });

  it("says what llms.txt says about what Nooscape is and what it reads, the API's own rule and the licence, because both pages are written from the same words", () => {
    const served = index();
    const lines = llmsText(served).split("\n");
    const text = skillText(served);
    expect(lines[2]).toMatch(/^> Nooscape lists/);
    expect(lines[4]).toMatch(/^Nooscape reads the public agent registries/);
    expect(text).toContain(lines[2]!);
    expect(text).toContain(lines[4]!);
    expect(text).toContain(served.statement);
    expect(text).toContain(served.license.attribution);
    expect(text).toContain(served.license.notes);
    expect(text).toContain(served.openapi);
    expect(text).toContain(served.documentation);
  });

  it("is linked from llms.txt, whether or not payments are on", () => {
    for (const pay of [testConfig(), null]) {
      expect(llmsText(index(pay))).toContain("- [Skill file](https://nooscape.si/skill.md): how to call the API and read its answers, as a skill for an AI agent.");
    }
  });

  it("never carries a secret, and keeps to the house style: no long dash, and every link is a full https address on this site", () => {
    const keys = newCdpKeys();
    const cfg = baseSmart();
    for (const text of [skillText(index(cfg)), skillText(index(null))]) {
      expect(text).not.toContain(cfg.apiKey);
      expect(text).not.toContain(TEST_CIRCLE_KEY);
      expect(text).not.toContain(cfg.facilitator);
      expect(text).not.toContain(keys.env.CDP_API_KEY_ID);
      expect(text).not.toContain(keys.env.CDP_API_KEY_SECRET);
      expect(text).not.toContain("base-node.example.org");
      expect(text).not.toMatch(/LIVE_API_KEY|TEST_API_KEY|X402_|BASE_RPC_URL/);
      expect(text).not.toMatch(LONG_DASH);
      const links = [...text.matchAll(/\]\(([^)]*)\)/g)].map(match => match[1]!);
      expect(links.length).toBeGreaterThan(4);
      for (const link of links) expect(link, link).toMatch(/^https:\/\/nooscape\.si\//);
    }
  });
});

describe("the x402 discovery document", () => {
  it("is the x402scan form: a version and the routes that answer 402 to a caller with no key, as full addresses", () => {
    const document = x402WellKnown(testConfig());
    expect(document.version).toBe(1);
    expect(document.resources).toEqual(["https://nooscape.si/api/v1/check"]);
    expect(Object.keys(document).sort()).toEqual(["instructions", "items", "pagination", "resources", "version", "x402Version"]);
  });

  it("is also the standard discovery document: one item for the check, with how to call it without paying, the terms it asks and the listing's name", () => {
    const cfg = testConfig(newCdpKeys().env);
    const at = new Date("2026-10-22T03:00:00Z");
    const document = x402WellKnown(cfg, at);
    expect(document.x402Version).toBe(2);
    expect(document.pagination).toEqual({ limit: 1, offset: 0, total: 1 });
    expect(document.items).toHaveLength(1);
    const item = document.items[0]!;
    expect(item).toMatchObject({
      resource: "https://nooscape.si/api/v1/check",
      type: "http",
      x402Version: 2,
      lastUpdated: "2026-10-22T03:00:00.000Z",
      description: DESCRIPTIONS.check,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: SERVICE_TAGS,
    });
    // How a reader tests the service with an unpaid call: the method and the body, from the Bazaar block (a GET to this POST route is a 405).
    expect(item.extensions.bazaar).toEqual(bazaarFor("check", item.resource));
    expect(item.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "POST", bodyType: "json", body: CHECK_BODY_EXAMPLE });
  });

  it("asks in it the terms the 402 asks, for each network that takes payment, Arc first", () => {
    const cfg = testConfig(newCdpKeys().env);
    const item = x402WellKnown(cfg).items[0]!;
    expect(item.accepts.map(terms => terms.network)).toEqual([ARC_MAINNET, BASE_MAINNET]);
    const asked = (termsReply(cfg, "check", item.resource, "x").body as { accepts: Array<{ network: string }> }).accepts;
    const byNetwork = (list: Array<{ network: string }>) => [...list].sort((a, b) => a.network.localeCompare(b.network));
    expect(byNetwork(item.accepts)).toEqual(byNetwork(asked));
    expect(item.accepts).toEqual([...railsOf(cfg)].reverse().map(rail => requirements(cfg, "check", rail)));
    // With Base off there is Arc alone.
    expect(x402WellKnown(testConfig()).items[0]!.accepts.map(terms => terms.network)).toEqual([ARC_MAINNET]);
  });

  it("names the resource under the origin the 402 names, and the price as set", () => {
    const document = x402WellKnown(testConfig({ X402_RESOURCE_BASE: "https://example.org/", X402_PRICE_CHECK: "20000" }));
    expect(document.resources).toEqual(["https://example.org/api/v1/check"]);
    expect(document.instructions).toContain("$0.02 in USDC per call");
    expect(document.instructions).toContain("https://nooscape.si/api/v1/openapi.json");
  });

  it("holds no secret and no long dash, and the receiving address only as the payee of the terms, which every 402 names too", () => {
    const cfg = testConfig(newCdpKeys().env);
    const document = x402WellKnown(cfg);
    const text = JSON.stringify(document);
    expect(text).not.toContain(cfg.apiKey);
    expect(text).not.toContain(cfg.facilitator);
    expect(text).not.toMatch(LONG_DASH);
    expect(document.items[0]!.accepts.map(terms => terms.payTo.toLowerCase())).toEqual([cfg.payTo, cfg.payTo]);
    // Outside the terms the address is nowhere: not in the instructions, the description or the block that describes the call.
    const { accepts: _terms, ...rest } = document.items[0]!;
    expect(JSON.stringify({ ...document, items: [rest] }).toLowerCase()).not.toContain(cfg.payTo);
  });
});

describe("the OpenAPI document for x402scan and AgentCash", () => {
  const document = x402OpenApi(testConfig(), CHAINS);
  const operation = document.paths["/api/v1/check"].post;

  it("describes the one route that answers 402 to a caller with no key, with the fields their discovery reads: a title, a version, guidance, a price and the 402", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(["/api/v1/check"]);
    expect(Object.keys(document.paths["/api/v1/check"])).toEqual(["post"]);
    expect(document.info.title).toBe("Nooscape pre-flight check");
    expect(document.info.version).toBe(apiV1SpecFor(CHAINS).info.version);
    expect(document.info["x-guidance"]).toContain("POST /api/v1/check");
    expect(document.servers).toEqual([{ url: "https://nooscape.si" }]);
    expect(operation["x-payment-info"]).toEqual({ price: { mode: "fixed", currency: "USD", amount: "0.010000" }, protocols: [{ x402: {} }] });
    expect(operation.responses["402"]).toBeDefined();
    expect(operation.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/CheckRequest" });
    expect(operation.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/CheckResponse" });
    expect(operation.tags).toEqual(["Pre-flight check"]);
    // No API authentication is declared, so discovery reads the route as paid and not as "key and paid": payment alone opens it.
    expect(operation.security).toEqual([]);
    expect(document["x-agentcash-guidance"]).toEqual({ llmsTxtUrl: "https://nooscape.si/llms.txt" });
  });

  it("gives the contact the contact page gives for the API, with the email registries use to verify who runs the origin", () => {
    expect(document.info.contact).toEqual({ ...apiV1SpecFor(CHAINS).info.contact, email: SUPPORT_EMAIL });
    expect(document.info.contact.email).toBe("support@nooscape.si");
  });

  it("takes its price from the settings, the same price the 402 asks", () => {
    const cfg = testConfig({ X402_PRICE_CHECK: "20000" });
    const amount = x402OpenApi(cfg, CHAINS).paths["/api/v1/check"].post["x-payment-info"].price.amount;
    expect(amount).toBe("0.020000");
    expect(Math.round(Number(amount) * 1_000_000)).toBe(Number(requirements(cfg, "check").amount));
  });

  it("carries the API's own words for the route and only the schemas that route reaches, and every reference resolves", () => {
    const full = apiV1SpecFor(CHAINS);
    const { security: _keyed, ...fullOperation } = full.paths["/api/v1/check"].post;
    const { "x-payment-info": _price, tags: _tags, security: _none, ...own } = operation;
    expect(own).toEqual(fullOperation);
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node !== null && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref") refs.push(String(value));
          else walk(value);
        }
      }
    };
    walk(document);
    expect(refs.length).toBeGreaterThan(0);
    const components = document.components as Record<string, Record<string, unknown>>;
    for (const ref of refs) {
      const [section, name] = ref.slice("#/components/".length).split("/");
      expect(components[section]?.[name], ref).toBeDefined();
    }
    expect(Object.keys(components.schemas)).not.toContain("BatchRequest");
    expect(Object.keys(components.schemas).length).toBeLessThan(Object.keys(full.components.schemas).length);
    // The route declares no authentication, so there is no scheme to carry.
    expect(Object.keys(components)).toEqual(["schemas"]);
  });

  it("keeps the API's rule in the words an agent reads first: facts with dates, no score, rating or verdict", () => {
    expect(document.info["x-guidance"]).toContain("It gives no score, rating or verdict.");
    expect(document.info["x-guidance"]).toContain("A payment is charged only for an answer that was built and delivered.");
  });

  it("holds no secret, no receiving address and no long dash", () => {
    const cfg = testConfig();
    const text = JSON.stringify(x402OpenApi(cfg, CHAINS));
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

  it("serves the skill file as markdown that other sites may read, cached for five minutes, with the payment section while payments are on", async () => {
    const base = await serve({ payments: service() });
    const response = await fetch(`${base}/skill.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const text = await response.text();
    expect(text.startsWith("---\nname: nooscape\n")).toBe(true);
    expect(text).toContain("## Paying for the check (x402)");
    expect(text).toContain(TEST_PAY_TO);
    expect((await fetch(`${base}/skill.md`, { method: "HEAD" })).status).toBe(200);
  });

  it("serves the skill file at the address the Developers page links it on", async () => {
    const page = readFileSync(new URL("../client/src/pages/DeveloperApi.tsx", import.meta.url), "utf8");
    const links = Array.from(page.matchAll(/href="(\/skill\.md)"/g), match => match[1]);
    expect(links).toEqual(["/skill.md"]);
    const response = await fetch(`${await serve({ payments: null })}${links[0]}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });

  it("serves the discovery document as JSON with the same headers while payments are on", async () => {
    const base = await serve({ payments: service() });
    const response = await fetch(`${base}/.well-known/x402`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(x402WellKnown(testConfig(), NOW))));
    expect((await fetch(`${base}/.well-known/x402`, { method: "HEAD" })).status).toBe(200);
  });

  it("serves the OpenAPI document at the root as JSON with the same headers while payments are on", async () => {
    const base = await serve({ payments: service() });
    const response = await fetch(`${base}/openapi.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(x402OpenApi(testConfig(), CHAINS))));
    expect((await fetch(`${base}/openapi.json`, { method: "HEAD" })).status).toBe(200);
  });

  it("serves the proof of the domain that Tolly Labs asks for as JSON with no redirect, the same whether payments are on or not", async () => {
    for (const payments of [service(), service({ env: { X402_PAUSE_NEW: "1" } }), null]) {
      const base = await serve({ payments });
      const response = await fetch(`${base}/.well-known/tolly-agent.json`, { redirect: "manual" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      // The two fields their form showed for the agent registered as nooscape: its id, and the wallet that signed in, in lower case.
      expect(await response.json()).toEqual({ agent: "nooscape", operator: "0xe090fee7a47bcb744feac24ae92d134c04b3f8ab" });
      expect((await fetch(`${base}/.well-known/tolly-agent.json`, { method: "HEAD" })).status).toBe(200);
    }
  });

  it.each([
    ["paused", () => service({ env: { X402_PAUSE_NEW: "1" } })],
    ["not recording payments", () => service({ ready: false })],
    ["not configured", () => null],
  ])("while pay per call is %s: the page leaves the payment section out, and the discovery documents are a JSON 404 and not the client's page", async (_name, make) => {
    const base = await serve({ payments: make() });
    const page = await fetch(`${base}/llms.txt`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).not.toMatch(/x402|PAYMENT-|per call|Pay to/i);
    expect(text).toContain("## Endpoints");
    for (const path of ["/.well-known/x402", "/openapi.json"]) {
      const missing = await fetch(`${base}${path}`);
      expect(missing.status, path).toBe(404);
      expect(missing.headers.get("content-type"), path).toMatch(/^application\/json/);
      expect(missing.headers.get("cache-control"), path).toBe("public, max-age=60");
      expect(await missing.json(), path).toEqual({ error: { code: "not_found", message: "Pay per call is not taking payments." } });
    }
  });

  it("when the payment state cannot be read: the page is still served without the payment section, and the discovery documents are 503 and not cached", async () => {
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
    for (const path of ["/.well-known/x402", "/openapi.json"]) {
      const unavailable = await fetch(`${base}${path}`);
      expect(unavailable.status, path).toBe(503);
      expect(unavailable.headers.get("cache-control"), path).toBe("no-store");
      expect((await unavailable.json()).error.code, path).toBe("unavailable");
    }
    expect(error).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(error.mock.calls)).not.toContain(TEST_CIRCLE_KEY);
  });

  it.each([
    ["paused", () => service({ env: { X402_PAUSE_NEW: "1" } })],
    ["not recording payments", () => service({ ready: false })],
    ["not configured", () => null],
  ])("while pay per call is %s: the skill file leaves its payment sections out", async (_name, make) => {
    const base = await serve({ payments: make() });
    const page = await fetch(`${base}/skill.md`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).not.toMatch(/x402|PAYMENT-|per call|Pay to|USDC/i);
    expect(text).toContain("## Calls");
  });

  it("when the payment state cannot be read: the skill file is still served without its payment sections, and the failure is logged once without a secret", async () => {
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
    const page = await fetch(`${base}/skill.md`);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toMatch(/x402|PAYMENT-|per call|Pay to|USDC/i);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("skill.md");
    expect(JSON.stringify(error.mock.calls)).not.toContain(TEST_CIRCLE_KEY);
  });

  it("answers these paths only: the rest still reaches whatever is mounted after", async () => {
    const base = await serve({ payments: service() });
    for (const path of ["/llms", "/llms.txt.bak", "/.well-known/x402.json", "/.well-known/", "/openapi", "/openapi.json.bak", "/.well-known/tolly-agent", "/.well-known/tolly-agent.json.bak", "/skill", "/skill.md.bak", "/.well-known/skill.md"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.headers.get("content-type"), path).toMatch(/text\/html/);
    }
  });

  it("is wired with the shared payment service and the served chains", () => {
    expect(Object.keys(defaultDiscoveryDeps).sort()).toEqual(["chains", "now", "payments"]);
    expect(defaultDiscoveryDeps.chains()).toEqual(expect.arrayContaining(["robinhood", "bnb", "solana"]));
  });
});
