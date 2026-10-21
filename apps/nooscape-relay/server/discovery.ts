import type { Express } from "express";
import { API_TIERS } from "@shared/apiKey";
import { servedChains, type ApiChain } from "./apiChains";
import { indexAnswer, PAGE_ORIGIN } from "./apiV1";
import { ARC_MAINNET, DESCRIPTIONS, usdOf, type X402Config } from "./x402";
import { sharedPaymentService, type PaymentService } from "./x402Service";

/**
 * What a model or an indexer reads before it has a reason to read our documentation (docs/x402-discovery-2026-10-21.md): /llms.txt, a
 * plain-text page for a model, and /.well-known/x402, the list of payable routes that x402 indexers read (the x402scan format: a version
 * and a list of addresses). Both are built at request time from what the API's own index serves (`indexAnswer`) and from the live
 * payment settings, so neither can say what the API does not: a price, the receiving address or a served chain that changes in the
 * settings changes here with it, and no number is typed twice.
 *
 * A file never claims a payment that is not taken. While pay per call is off, paused or not known to be on, the page leaves its payment
 * section out and the well-known file is a 404, because an indexer that lists a route it cannot pay for lists a failure.
 *
 * Nothing here is a secret or a verdict: the receiving address and the prices are in every 402 already, and the page repeats the
 * API's own statement that it gives facts with their dates and no verdict.
 */

type Index = ReturnType<typeof indexAnswer>;

const NETWORK_NAME: Record<string, string> = { [ARC_MAINNET]: "Arc mainnet" };

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
      `- Network: ${NETWORK_NAME[pay.network] ?? "Arc testnet"} (${pay.network}). Asset: USDC at ${pay.asset}. Pay to: ${pay.pay_to}.`,
      `- Wallets: ${pay.wallets.includes("smart_contract") ? "regular wallets and smart-contract wallets" : "regular wallets"}.`,
      `- [x402 discovery document](${PAGE_ORIGIN}/.well-known/x402)`
    );
  }
  lines.push("", "## Rules", "", index.statement, "", `Attribution: ${index.license.attribution}`, "");
  return lines.join("\n");
}

/** The x402scan discovery document: the payable routes that answer 402 to a caller with no key, as addresses. */
export function x402WellKnown(cfg: X402Config) {
  return {
    version: 1,
    resources: [`${cfg.resourceBase}/api/v1/check`],
    instructions: `${DESCRIPTIONS.check}, ${usdOf(cfg.prices.check)} in USDC per call. The request body is JSON with exactly one of agent, wallet or url. Documentation: ${PAGE_ORIGIN}/developers. OpenAPI: ${PAGE_ORIGIN}/api/v1/openapi.json`,
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

  app.get("/.well-known/x402", async (_req, res) => {
    let pay: X402Config | null;
    try {
      pay = await liveSettings(deps);
    } catch (error) {
      console.error("[Discovery] the payment state could not be read, so /.well-known/x402 is unavailable:", error instanceof Error ? error.message : error);
      res.status(503).set("Cache-Control", "no-store").json({ error: { code: "unavailable", message: "The payment state cannot be read right now." } });
      return;
    }
    if (!pay) {
      // Answered here and not passed on: the client's catch-all would send the page with a 200, and an indexer would read that as a document.
      res.status(404).set({ ...PUBLIC, "Cache-Control": "public, max-age=60" }).json({ error: { code: "not_found", message: "Pay per call is not taking payments." } });
      return;
    }
    res.type("application/json; charset=utf-8").set(PUBLIC).send(`${JSON.stringify(x402WellKnown(pay), null, 2)}\n`);
  });
}
