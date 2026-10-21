import { describe, expect, it, vi } from "vitest";
import { NooscapeClient, NooscapeError, usdOf, type ClientOptions } from "../src/client.js";
import { AGENT, CHECK, PAYMENT_REQUIRED, error } from "./fixtures.js";

const KEY = "nsk_" + "k".repeat(40);

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function rig(answer: () => Response | Promise<Response>, options: Partial<ClientOptions> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as unknown as typeof fetch;
  const client = new NooscapeClient({ userAgent: "nooscape-mcp/9.9.9", fetch: fetchImpl, ...options });
  return { client, calls, fetchImpl };
}

const failure = async (run: () => Promise<unknown>): Promise<NooscapeError> => {
  try {
    await run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(NooscapeError);
    return caught as NooscapeError;
  }
  throw new Error("expected a NooscapeError");
};

describe("what is sent", () => {
  it("names itself, asks for JSON and sends no authorization without a key", async () => {
    const { client, calls } = rig(() => reply(200, AGENT));
    await client.agent("robinhood", "8865");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://nooscape.si/api/v1/agents/robinhood/8865");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe("nooscape-mcp/9.9.9");
    expect(headers.accept).toBe("application/json");
    expect(headers.authorization).toBeUndefined();
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("sends the key as a bearer token, and only then", async () => {
    const { client, calls } = rig(() => reply(200, AGENT), { apiKey: `  ${KEY}  ` });
    expect(client.hasKey).toBe(true);
    await client.agent("robinhood", "8865");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(new NooscapeClient({ userAgent: "x", apiKey: "   " }).hasKey).toBe(false);
    expect(new NooscapeClient({ userAgent: "x", apiKey: "" }).hasKey).toBe(false);
  });

  it("follows no redirect, so the key goes only to the address that was configured", async () => {
    const { client, calls } = rig(() => reply(200, AGENT), { apiKey: KEY });
    await client.search("alice");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("encodes what it is given: a search, an id and the registry choice", async () => {
    const { client, calls } = rig(() => reply(200, AGENT));
    await client.search("a b&c=d", "solana");
    await client.agent("solana", "ab/cd?x", "solana_said");
    await client.history("robinhood", "8865", undefined);
    expect(calls[0]!.url).toBe("https://nooscape.si/api/v1/agents/search?q=a+b%26c%3Dd&chain=solana");
    expect(calls[1]!.url).toBe("https://nooscape.si/api/v1/agents/solana/ab%2Fcd%3Fx?registry=solana_said");
    expect(calls[2]!.url).toBe("https://nooscape.si/api/v1/agents/robinhood/8865/history");
  });

  it("posts a check as JSON with the subject, and the chain that narrows a wallet", async () => {
    const { client, calls } = rig(() => reply(200, CHECK));
    await client.check({ wallet: "0xa59322c6c2f29f19442c64fcba773d5804b90e9c" }, "robinhood");
    await client.check({ agent: { chain: "solana", id: "So1", registry: "solana_8004" } });
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ wallet: "0xa59322c6c2f29f19442c64fcba773d5804b90e9c", chain: "robinhood" });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ agent: { chain: "solana", id: "So1", registry: "solana_8004" } });
    expect(calls[0]!.url).toBe("https://nooscape.si/api/v1/check");
  });

  it("uses the base address it is given, without a trailing slash doubling", async () => {
    const { client, calls } = rig(() => reply(200, AGENT), { baseUrl: "https://example.test/api/v1///" });
    await client.agent("bnb", "9");
    expect(calls[0]!.url).toBe("https://example.test/api/v1/agents/bnb/9");
  });
});

describe("what comes back", () => {
  it("hands back the API's JSON untouched", async () => {
    const { client } = rig(() => reply(200, AGENT));
    expect(await client.agent("robinhood", "8865")).toEqual(AGENT);
  });

  it("turns a 402 into the price and the terms, and does not pay", async () => {
    const { client, calls } = rig(() => reply(402, PAYMENT_REQUIRED, { "payment-required": "eyJ4In0=" }));
    const caught = await failure(() => client.check({ agent: { chain: "robinhood", id: "8865" } }));
    expect(caught.kind).toBe("payment_required");
    expect(caught.status).toBe(402);
    expect(caught.payment).toEqual([{ scheme: "exact", network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", payTo: "0xe090fee7a47bcb744feac24ae92d134c04b3f8ab", amount: "10000", usd: "$0.01" }]);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.headers as Record<string, string>)["payment-signature"]).toBeUndefined();
  });

  it("reads a 402 with terms it does not understand as no terms, not as a crash", async () => {
    for (const body of ["not json", { accepts: "no" }, { accepts: [null, 5, { amount: 7 }] }, null]) {
      const { client } = rig(() => reply(402, body as never));
      const caught = await failure(() => client.check({ wallet: "x".repeat(40) }));
      expect(caught.kind).toBe("payment_required");
      expect(caught.payment).toEqual([]);
    }
  });

  it("says what to do for a missing key, a refused key and a tier that is too low", async () => {
    const missing = await failure(() => rig(() => reply(401, error("key_required", "needs a key"))).client.history("robinhood", "1"));
    expect(missing.kind).toBe("key_required");
    expect(missing.message).toContain("NOOSCAPE_API_KEY");
    expect(missing.message).toContain("https://nooscape.si/developers/keys");

    const refused = await failure(() => rig(() => reply(401, error("invalid_key", "bad")), { apiKey: KEY }).client.history("robinhood", "1"));
    expect(refused.kind).toBe("invalid_key");
    expect(refused.message).not.toContain(KEY);

    const tier = await failure(() => rig(() => reply(403, error("tier_required", "x", { required_tier: "pro" }), { "x-api-tier": "free" }), { apiKey: KEY }).client.check({ wallet: "w".repeat(40) }));
    expect(tier.kind).toBe("tier_required");
    expect(tier.requiredTier).toBe("pro");
    expect(tier.message).toContain("pro key");
    expect(tier.message).toContain("free key");
  });

  it("says a record that is hidden looks the same as one that was never listed", async () => {
    const caught = await failure(() => rig(() => reply(404, error("not_found", "No listed agent has that id on that chain."))).client.agent("robinhood", "99999999"));
    expect(caught.kind).toBe("not_found");
    expect(caught.message).toContain("hides, withdraws or closes");
    expect(caught.message).toContain("never listed");
  });

  it("names the registries when an address is listed by more than one, and says to choose", async () => {
    const caught = await failure(() => rig(() => reply(409, error("ambiguous", "x", { registries: ["solana_8004", "solana_said"] }))).client.agent("solana", "So1"));
    expect(caught.kind).toBe("ambiguous");
    expect(caught.registries).toEqual(["solana_8004", "solana_said"]);
    expect(caught.message).toContain("solana_8004, solana_said");
    expect(caught.message).toContain("registry argument");
  });

  it("passes on Retry-After for a 429, once, with no retry loop", async () => {
    const { client, fetchImpl } = rig(() => reply(429, error("rate_limited", "x"), { "retry-after": "30" }));
    const caught = await failure(() => client.search("alice"));
    expect(caught.kind).toBe("rate_limited");
    expect(caught.retryAfterSeconds).toBe(30);
    expect(caught.message).toContain("30 seconds");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("says when a day's quota is used, and when it restarts", async () => {
    const caught = await failure(() => rig(() => reply(429, error("quota_exceeded", "x"), { "retry-after": "3600" }), { apiKey: KEY }).client.search("alice"));
    expect(caught.kind).toBe("quota_exceeded");
    expect(caught.message).toContain("00:00 UTC");
    expect(caught.retryAfterSeconds).toBe(3600);
  });

  it("does not trust a Retry-After that is not a plain number", async () => {
    const caught = await failure(() => rig(() => reply(429, error("rate_limited", "x"), { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).client.search("alice"));
    expect(caught.retryAfterSeconds).toBeNull();
    expect(caught.message).toContain("shortly");
  });

  it("calls a server error what it is, with the wait if it gave one, and shows no body", async () => {
    const a = await failure(() => rig(() => reply(503, error("unavailable", "db password is hunter2"), { "retry-after": "60" })).client.agent("bnb", "1"));
    expect(a.kind).toBe("unavailable");
    expect(a.message).toContain("HTTP 503");
    expect(a.message).toContain("60 seconds");
    expect(a.message).not.toContain("hunter2");
    const b = await failure(() => rig(() => reply(500, "<html>boom</html>")).client.agent("bnb", "1"));
    expect(b.kind).toBe("unavailable");
    expect(b.message).not.toContain("boom");
  });

  it("gives the API's own reason for a 400, and a plain note for another status", async () => {
    const a = await failure(() => rig(() => reply(400, error("bad_request", "id must be a registry token id (digits only)"))).client.agent("robinhood", "x"));
    expect(a.kind).toBe("bad_request");
    expect(a.message).toContain("id must be a registry token id");
    const b = await failure(() => rig(() => reply(418, error("teapot", "short and stout"))).client.agent("robinhood", "1"));
    expect(b.kind).toBe("unexpected");
    expect(b.message).toContain("HTTP 418");
  });
});

describe("when the network does not help", () => {
  it("gives up after the timeout, and says so", async () => {
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const client = new NooscapeClient({ userAgent: "x", fetch: hang as unknown as typeof fetch, timeoutMs: 30 });
    const caught = await failure(() => client.search("alice"));
    expect(caught.kind).toBe("timeout");
    expect(caught.message).toContain("did not answer");
  });

  it("says it could not reach the API, without the cause", async () => {
    const client = new NooscapeClient({ userAgent: "x", apiKey: KEY, fetch: (async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED while sending Authorization: Bearer ${KEY}`);
    }) as unknown as typeof fetch });
    const caught = await failure(() => client.search("alice"));
    expect(caught.kind).toBe("network");
    expect(caught.message).not.toContain(KEY);
    expect(caught.message).not.toContain("ECONNREFUSED");
  });

  it("does not take a 200 that is not JSON, or one that is too large", async () => {
    const a = await failure(() => rig(() => reply(200, "<html>a page</html>")).client.search("alice"));
    expect(a.kind).toBe("unexpected");
    const b = await failure(() => rig(() => reply(200, "x".repeat(1_000_001))).client.search("alice"));
    expect(b.kind).toBe("unexpected");
    expect(b.message).toContain("larger than expected");
  });

  it("never puts the key in any error it raises", async () => {
    const answers: Array<() => Response> = [
      () => reply(401, error("invalid_key", `key ${KEY} refused`)),
      () => reply(403, error("tier_required", `key ${KEY}`, { required_tier: "pro" })),
      () => reply(404, error("not_found", KEY)),
      () => reply(429, error("rate_limited", KEY), { "retry-after": "5" }),
      () => reply(500, KEY),
      () => reply(400, error("bad_request", `using ${KEY}`)),
      () => reply(402, { ...PAYMENT_REQUIRED, error: KEY }),
    ];
    for (const answer of answers) {
      const caught = await failure(() => rig(answer, { apiKey: KEY }).client.check({ wallet: "w".repeat(40) }));
      expect(JSON.stringify([caught.message, caught.kind, caught.payment, caught.requiredTier])).not.toContain(KEY);
    }
  });
});

describe("a price in dollars", () => {
  it("reads six-decimal USDC amounts, and refuses what is not a plain integer", () => {
    expect(usdOf("10000")).toBe("$0.01");
    expect(usdOf("5000")).toBe("$0.005");
    expect(usdOf("1000000")).toBe("$1.00");
    expect(usdOf("1234567")).toBe("$1.234567");
    expect(usdOf("0")).toBe("$0.00");
    expect(usdOf("-5")).toBeNull();
    expect(usdOf("1e6")).toBeNull();
    expect(usdOf("")).toBeNull();
    expect(usdOf("1".repeat(30))).toBeNull();
  });
});
