import type { Express } from "express";
import { API_TIERS } from "@shared/apiKey";
import { servedChains, type ApiChain } from "./apiChains";
import { indexAnswer, PAGE_ORIGIN } from "./apiV1";
import { apiV1SpecFor } from "./apiV1Spec";
import { ARC_MAINNET, BASE_MAINNET, DESCRIPTIONS, SERVICE_NAME, SERVICE_TAGS, railsOf, requirements, usdOf, type X402Config } from "./x402";
import { bazaarFor } from "./x402Bazaar";
import { sharedPaymentService, type PaymentService } from "./x402Service";

/**
 * What a model or an indexer reads before it has a reason to read our documentation (docs/x402-discovery-2026-10-21.md): /llms.txt, a
 * plain-text page for a model, and /.well-known/x402, the list of payable routes that x402 indexers read (in two forms: x402scan's, a version
 * and a list of addresses, and the standard one, an item with its terms). Both are built at request time from what the API's own index
 * serves (`indexAnswer`) and from the live payment settings, so neither can say what the API does not: a price, the receiving address or
 * a served chain that changes in the settings changes here with it, and no number is typed twice.
 *
 * A file never claims a payment that is not taken. While pay per call is off, paused or not known to be on, the page leaves its payment
 * section out and the well-known file is a 404, because an indexer that lists a route it cannot pay for lists a failure.
 *
 * Nothing here is a secret or a verdict: the receiving address and the prices are in every 402 already, and the page repeats the
 * API's own statement that it gives facts with their dates and no verdict.
 */

type Index = ReturnType<typeof indexAnswer>;

const NETWORK_NAME: Record<string, string> = { [ARC_MAINNET]: "Arc mainnet", [BASE_MAINNET]: "Base" };

/** "A", "A and B", "A, B and C". */
function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const count = (n: number) => n.toLocaleString("en-US");

/** The page for a model: what Nooscape is, what it will not say, and how to call it, as the same index the API serves. */
export function llmsText(index: Index): string {
  const lines: string[] = [
    "# Nooscape",
    "",
    "> Nooscape lists the AI agents that public registries record and reports dated facts about them. It gives no score, rating or verdict, and it does not say that an agent is safe, unsafe, reviewed or endorsed.",
    "",
    `Nooscape reads the public agent registries on ${listOf(index.chains.map(chain => chain.label))} and keeps what it read together with the date or block it was read at. Every API answer names its source and says when it was read. A flag that is present is a fact to weigh, not a finding.`,
    "",
    "## Documents",
    "",
    `- [REST API index](${PAGE_ORIGIN}/api/v1): the endpoints, the limits and the chains served, as JSON.`,
    `- [OpenAPI 3.1 document](${index.openapi}): every endpoint with its request and response.`,
    `- [Developer guide](${index.documentation}): the API explained for developers.`,
    `- [Keys](${index.keys.get_a_key}): a free key raises the limit, and Builder and Pro keys raise it further.`,
    `- [Terms and data license](${index.license.url}): ${index.license.notes}`,
    "",
    "## Endpoints",
    "",
    `Every path is under ${PAGE_ORIGIN}. With no key, ${index.rate_limit.requests} requests a ${index.rate_limit.per} are allowed from one IP address.`,
    "",
    ...index.endpoints.map(endpoint => `- \`${endpoint.method} ${endpoint.path}\`: ${endpoint.summary}`),
    "",
    "## Chains",
    "",
    "Use the name on the left in a path or a request body.",
    "",
    ...index.chains.map(chain => `- ${chain.chain}: ${chain.label} (registries: ${chain.registries.join(", ")})`),
    "",
    "## Keys",
    "",
    `Send a key as \`${index.keys.header}\`. A key raises the limit and unlocks more endpoints.`,
    "",
    ...index.keys.tiers.map(tier => `- ${API_TIERS[tier.tier].label}: ${count(tier.per_minute)} requests a minute and ${count(tier.per_day)} a day.`),
  ];
  const pay = index.pay_per_call;
  if (pay) {
    lines.push(
      "",
      "## Pay per call (x402)",
      "",
      "Two calls can be paid for as they are made, with no account and no key. Ask with no payment and the answer is HTTP 402 with the price and the terms. Sign a USDC transfer authorization for that amount, send it base64 encoded in a PAYMENT-SIGNATURE header, and send the request again. The answer carries a PAYMENT-RESPONSE header that names the settlement. A payment is charged only for an answer that was built and delivered.",
      "",
      `- \`POST /api/v1/check\`: ${pay.prices.check.usd} per call. Pre-flight facts for an agent, a wallet or an endpoint URL.`,
      `- \`GET /api/v1/agents/{chain}/{id}\`: ${pay.prices.lookup.usd} per call, asked only after the free limit of ${index.rate_limit.requests} requests a ${index.rate_limit.per} is used.`,
      ...pay.networks.map(
        item => `- Network: ${NETWORK_NAME[item.network] ?? "Arc testnet"} (${item.network}). Asset: USDC at ${item.asset}. Pay to: ${item.pay_to}. Wallets: ${item.wallets.includes("smart_contract") ? "regular wallets and smart-contract wallets" : "regular wallets"}.`
      ),
      `- [x402 discovery document](${PAGE_ORIGIN}/.well-known/x402)`
    );
  }
  lines.push("", "## Rules", "", index.statement, "", `Attribution: ${index.license.attribution}`, "");
  return lines.join("\n");
}

/** The discovery document: the payable routes that answer 402 to a caller with no key, as addresses (x402scan's form) and as an item with its terms (the standard form). */
export function x402WellKnown(cfg: X402Config, now: Date = new Date()) {
  const resource = `${cfg.resourceBase}/api/v1/check`;
  return {
    // x402scan's form, for the readers that take it.
    version: 1,
    resources: [resource],
    instructions: `${DESCRIPTIONS.check} Price: ${usdOf(cfg.prices.check)} in USDC per call. The request body is JSON with exactly one of agent, wallet or url. Documentation: ${PAGE_ORIGIN}/developers. OpenAPI: ${PAGE_ORIGIN}/api/v1/openapi.json`,
    // The standard discovery document, as Coinbase's Bazaar lists a service and as Tolly Labs publishes its own: each item names a resource, how to
    // call it without paying (the method and a body, in the Bazaar block) and the terms it asks, so a reader that tests a service with an unpaid call
    // does not have to guess the method of a POST route. The terms are the 402's own, Arc first for the readers that look for Arc.
    x402Version: 2,
    items: [
      {
        resource,
        type: "http",
        x402Version: 2,
        accepts: railsOf(cfg).map(rail => requirements(cfg, "check", rail)).reverse(),
        lastUpdated: now.toISOString(),
        description: DESCRIPTIONS.check,
        mimeType: "application/json",
        serviceName: SERVICE_NAME,
        tags: SERVICE_TAGS,
        extensions: { bazaar: bazaarFor("check", resource) },
      },
    ],
    pagination: { limit: 1, offset: 0, total: 1 },
  };
}

/** A price in USDC base units as dollars with six places, the form `x-payment-info` takes in OpenAPI ("10000" is "0.010000"). */
const decimalUsd = (amount: string) => (Number(amount) / 1_000_000).toFixed(6);

/** Where to write about the API (the contact page names it for the API, the verifier and the checker); client/src/lib/contacts.ts holds the same address and a test holds the two together. */
const API_CONTACT_EMAIL = "support@nooscape.si";

/** What an agent reads first about the check (`info.x-guidance`): a description of the route, and nothing that tells an agent what to conclude. */
const OPENAPI_GUIDANCE = `Nooscape lists the AI agents that public registries record and reports dated facts about them. POST /api/v1/check takes a JSON body with exactly one of agent (a chain and an id), wallet or url, and answers for each listing it matches with an evidence level, four dated flags and the sources they were read from. It gives no score, rating or verdict. With no API key the call is paid per request in USDC: the first request is answered 402 with the price and the terms for each network that takes payment, and the same request sent again with a PAYMENT-SIGNATURE header is answered with the facts. A payment is charged only for an answer that was built and delivered. The whole API is described at ${PAGE_ORIGIN}/api/v1/openapi.json.`;

/** The `components` that `roots` reach through `$ref`, so a document carries the schemas of the routes it describes and not the whole API's. */
function reachableComponents(components: Record<string, Record<string, unknown>>, roots: unknown[]) {
  const kept: Record<string, Record<string, unknown>> = {};
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/components/")) {
        const [section, name] = value.slice("#/components/".length).split("/");
        const target = components[section]?.[name];
        if (target !== undefined && kept[section]?.[name] === undefined) {
          (kept[section] ??= {})[name] = target;
          walk(target);
        }
      } else {
        walk(value);
      }
    }
  };
  roots.forEach(walk);
  return kept;
}

/**
 * The OpenAPI document x402scan and AgentCash read at /openapi.json (https://agentcash.dev/discovery, read 21 Oct 2026): the one route a
 * caller with no key can pay for in full, with `x-payment-info` and the 402 it answers. It is the API's own description of that route
 * (`apiV1SpecFor`), so its request, its answer and its words are not written a second time, and the price is the live setting. The
 * lookup is left out: within the free limit it answers 200, so a probe of it would record a failure, as it would in the well-known file.
 * The whole API stays at /api/v1/openapi.json.
 */
export function x402OpenApi(cfg: X402Config, chains: readonly ApiChain[]) {
  const spec = apiV1SpecFor(chains);
  const operation = {
    ...spec.paths["/api/v1/check"].post,
    // No API authentication: payment alone opens it. Discovery reads an empty list as "paid" and a key as "key and paid" (the specification, 6).
    security: [],
    tags: ["Pre-flight check"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: decimalUsd(cfg.prices.check) }, protocols: [{ x402: {} }] },
  };
  const components = spec.components as unknown as Record<string, Record<string, unknown>>;
  return {
    openapi: spec.openapi,
    info: {
      title: "Nooscape pre-flight check",
      version: spec.info.version,
      summary: "Dated facts about an agent, a wallet or an endpoint host, paid for per call in USDC.",
      description: `This document describes only the route a caller with no key can pay for in full. The whole API, including the lookup that is paid for past the free limit, is described at ${PAGE_ORIGIN}/api/v1/openapi.json.`,
      "x-guidance": OPENAPI_GUIDANCE,
      license: spec.info.license,
      // The email is the one the contact page gives for the API; registries use it to verify who runs the origin.
      contact: { ...spec.info.contact, email: API_CONTACT_EMAIL },
    },
    "x-agentcash-guidance": { llmsTxtUrl: `${PAGE_ORIGIN}/llms.txt` },
    servers: spec.servers,
    paths: { "/api/v1/check": { post: operation } },
    components: reachableComponents(components, [operation]),
    externalDocs: { description: "The whole API", url: `${PAGE_ORIGIN}/api/v1/openapi.json` },
  };
}

export type DiscoveryDeps = {
  payments: PaymentService | null;
  chains: () => readonly ApiChain[];
  now: () => Date;
};

export const defaultDiscoveryDeps: DiscoveryDeps = { payments: sharedPaymentService(), chains: () => servedChains(), now: () => new Date() };

/** The settings while pay per call takes new payments, else null. Throws when the state cannot be read. */
async function liveSettings(deps: DiscoveryDeps): Promise<X402Config | null> {
  if (!deps.payments) return null;
  return (await deps.payments.state()) === "on" ? deps.payments.config : null;
}

/**
 * Public data meant to be read by other sites and by agents, cached for five minutes (a pause reaches readers within that), with the
 * same-site resource policy lifted for these routes as it is for the key list.
 */
const PUBLIC = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" };

/**
 * What Tolly Labs' Agent Exchange asks a seller to publish at /.well-known/tolly-agent.json to prove it runs the domain it lists (the form on
 * agent.tollylabs.com showed these two fields on 22 Oct 2026): the agent id Nooscape took there and the wallet that signed in to register it.
 * That wallet is the one every 402 names as the payee, so the file holds nothing that is not public, and no secret. It changes only with a new
 * registration there.
 */
export const TOLLY_AGENT_PROOF = { agent: "nooscape", operator: "0xe090fee7a47bcb744feac24ae92d134c04b3f8ab" } as const;

/** Mount before the static files and the client's catch-all, which would answer these paths with the page. */
export function registerDiscovery(app: Express, deps: DiscoveryDeps = defaultDiscoveryDeps) {
  app.get("/llms.txt", async (_req, res) => {
    let pay: X402Config | null = null;
    try {
      pay = await liveSettings(deps);
    } catch (error) {
      // The page is still true without its payment section, and says nothing about a payment that may not be taken.
      console.error("[Discovery] the payment state could not be read, so llms.txt leaves out pay per call:", error instanceof Error ? error.message : error);
    }
    res.type("text/plain; charset=utf-8").set(PUBLIC).send(llmsText(indexAnswer(deps.now(), pay, undefined, deps.chains())));
  });

  servePayable(app, "/.well-known/x402", deps, pay => x402WellKnown(pay, deps.now()));
  servePayable(app, "/openapi.json", deps, pay => x402OpenApi(pay, deps.chains()));

  // A proof for a directory and not a document about the payment, so it does not wait on the payment state: it reads the same either way.
  app.get("/.well-known/tolly-agent.json", (_req, res) => {
    res.type("application/json; charset=utf-8").set(PUBLIC).send(`${JSON.stringify(TOLLY_AGENT_PROOF, null, 2)}\n`);
  });
}

/** A public JSON document that exists only while pay per call takes payments: a 404 of its own while it does not, a 503 that is not cached if that cannot be read. */
function servePayable(app: Express, path: string, deps: DiscoveryDeps, build: (pay: X402Config) => unknown) {
  app.get(path, async (_req, res) => {
    let pay: X402Config | null;
    try {
      pay = await liveSettings(deps);
    } catch (error) {
      console.error(`[Discovery] the payment state could not be read, so ${path} is unavailable:`, error instanceof Error ? error.message : error);
      res.status(503).set("Cache-Control", "no-store").json({ error: { code: "unavailable", message: "The payment state cannot be read right now." } });
      return;
    }
    if (!pay) {
      // Answered here and not passed on: the client's catch-all would send the page with a 200, and an indexer would read that as a document.
      res.status(404).set({ ...PUBLIC, "Cache-Control": "public, max-age=60" }).json({ error: { code: "not_found", message: "Pay per call is not taking payments." } });
      return;
    }
    res.type("application/json; charset=utf-8").set(PUBLIC).send(`${JSON.stringify(build(pay), null, 2)}\n`);
  });
}
