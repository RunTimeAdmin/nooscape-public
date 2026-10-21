import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_TIMEOUT_MS,
  DISABLE_AFTER_FAILURES,
  EVENT_TYPES,
  MAX_ATTEMPTS,
  MAX_URL_LENGTH,
  RETRY_AFTER_SECONDS,
  deliveryHeaders,
  eventBody,
  loadSigningKey,
  retryAfterSeconds,
  signature,
  signingSecret,
  webhookUrlProblem,
} from "./webhooks";

/** The parts of webhooks (docs/data-access-2026-10-19.md, stage D5) that need no database and no network. */
const KEY = "k".repeat(40);

describe("the signing key", () => {
  it("is off when it is not set, and refuses one that is too short to be a secret", () => {
    expect(loadSigningKey({})).toBeNull();
    expect(loadSigningKey({ WEBHOOK_SIGNING_KEY: "   " })).toBeNull();
    expect(() => loadSigningKey({ WEBHOOK_SIGNING_KEY: "short" })).toThrow("WEBHOOK_SIGNING_KEY must be at least 32 characters");
    expect(loadSigningKey({ WEBHOOK_SIGNING_KEY: `  ${KEY}  ` })).toBe(KEY);
  });
});

describe("a key's signing secret", () => {
  it("is derived: the same key, id and version give the same secret, and each of the three changes it", () => {
    const secret = signingSecret(KEY, "key-1", 1);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(signingSecret(KEY, "key-1", 1)).toBe(secret);
    expect(signingSecret(KEY, "key-1", 2)).not.toBe(secret);
    expect(signingSecret(KEY, "key-2", 1)).not.toBe(secret);
    expect(signingSecret(`${KEY}x`, "key-1", 1)).not.toBe(secret);
  });

  it("is an HMAC of a fixed phrase, so a receiver and a test can recompute it", () => {
    const expected = createHmac("sha256", KEY).update("nooscape-webhook:key-1:3").digest("base64url");
    expect(signingSecret(KEY, "key-1", 3)).toBe(`whsec_${expected}`);
  });

  it("does not put the server's key, or the key's id, in the secret", () => {
    const secret = signingSecret(KEY, "key-1", 1);
    expect(secret).not.toContain(KEY);
    expect(secret).not.toContain("key-1");
  });
});

describe("a delivery's signature", () => {
  const secret = "whsec_test";
  const body = '{"a":1}';

  it("is the HMAC-SHA256 of the timestamp, a dot and the body, in hex", () => {
    const expected = createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex");
    expect(signature(secret, 1_700_000_000, body)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the secret, the time and every byte of the body", () => {
    const base = signature(secret, 1_700_000_000, body);
    expect(signature("whsec_other", 1_700_000_000, body)).not.toBe(base);
    expect(signature(secret, 1_700_000_001, body)).not.toBe(base);
    expect(signature(secret, 1_700_000_000, '{"a":2}')).not.toBe(base);
    expect(signature(secret, 1_700_000_000, `${body} `)).not.toBe(base);
  });

  it("goes in the headers with the event, the delivery and the time of this try", () => {
    const headers = deliveryHeaders({ secret, deliveryId: "d-1", type: "feedback.added", timestamp: 1_700_000_000, body });
    expect(headers).toEqual({
      "content-type": "application/json",
      "x-nooscape-event": "feedback.added",
      "x-nooscape-delivery": "d-1",
      "x-nooscape-timestamp": "1700000000",
      "x-nooscape-signature": `t=1700000000,v1=${signature(secret, 1_700_000_000, body)}`,
    });
  });
});

describe("a webhook address", () => {
  it("is accepted when it is an https address on a public name", () => {
    expect(webhookUrlProblem("https://hooks.example.com/nooscape")).toBeNull();
    expect(webhookUrlProblem("https://hooks.example.com/a/b?c=d")).toBeNull();
  });

  it("is refused, in words for its owner, when it is not", () => {
    const cases: Array<[unknown, string]> = [
      [undefined, "url must be an https address"],
      [42, "url must be an https address"],
      ["", "url must be an https address"],
      ["not a url", "url is not an address"],
      ["http://hooks.example.com/x", "url must be https"],
      ["https://user:pw@hooks.example.com/x", "url must not carry a user name or password"],
      ["https://hooks.example.com:8443/x", "url must not name a port: the standard https port is the only one used"],
      ["https://127.0.0.1/x", "url must name a public host, not an address or an internal name"],
      ["https://localhost/x", "url must name a public host, not an address or an internal name"],
      ["https://internal/x", "url must name a public host, not an address or an internal name"],
      [`https://hooks.example.com/${"a".repeat(MAX_URL_LENGTH)}`, `url must be at most ${MAX_URL_LENGTH} characters`],
    ];
    for (const [raw, message] of cases) expect(webhookUrlProblem(raw), String(raw)).toBe(message);
  });
});

describe("the retry schedule", () => {
  it("waits longer after each failure and gives the delivery up after the last wait", () => {
    expect(RETRY_AFTER_SECONDS).toEqual([60, 300, 1_800, 7_200, 43_200]);
    expect(MAX_ATTEMPTS).toBe(6);
    expect([1, 2, 3, 4, 5].map(retryAfterSeconds)).toEqual([60, 300, 1_800, 7_200, 43_200]);
    expect(retryAfterSeconds(6)).toBeNull();
    expect(retryAfterSeconds(7)).toBeNull();
    expect(retryAfterSeconds(0)).toBeNull();
    expect(retryAfterSeconds(-1)).toBeNull();
  });

  it("keeps its limits where the dispatcher and the wording expect them", () => {
    expect(DISABLE_AFTER_FAILURES).toBe(20);
    expect(DELIVERY_TIMEOUT_MS).toBe(5_000);
    expect(EVENT_TYPES).toEqual(["ownership.changed", "feedback.added", "feedback.revoked", "claim.changed", "listing.removed", "listing.restored"]);
  });
});

describe("an event's body", () => {
  const agent = { chain: "base", agentId: "42", registry: "0xabc", entryId: "entry-1" };
  const body = eventBody({ id: "ev-1", type: "ownership.changed", createdAt: new Date("2026-10-19T12:00:00.000Z"), agent, data: { from: "0x1", to: "0x2" } });
  const parsed = JSON.parse(body);

  it("names the agent the way the public API does, with links to its page and its record", () => {
    expect(parsed).toMatchObject({
      api_version: "v1",
      id: "ev-1",
      type: "ownership.changed",
      created_at: "2026-10-19T12:00:00.000Z",
      agent: {
        chain: "base",
        agent_id: "42",
        registry: "0xabc",
        nooscape_id: "entry-1",
        page_url: "https://nooscape.si/agents/entry-1",
        links: { agent: "https://nooscape.si/api/v1/agents/base/42" },
      },
      data: { from: "0x1", to: "0x2" },
    });
  });

  it("carries the record statement and the license, and nothing that judges an agent", () => {
    expect(parsed.statement).toContain("a record, not a review");
    expect(parsed.license).toBeTruthy();
    expect(body).not.toMatch(/\b(safe|unsafe|trusted|trustworthy|certified|endorsed|secure)\b/i);
    expect(body).not.toMatch(/[–—]/);
  });

  it("has a null agent for a ping, and the same body every time it is built from the same facts", () => {
    const ping = JSON.parse(eventBody({ id: "p", type: "ping", createdAt: new Date(0), agent: null, data: {} }));
    expect(ping).toMatchObject({ type: "ping", agent: null, data: {} });
    expect(eventBody({ id: "ev-1", type: "ownership.changed", createdAt: new Date("2026-10-19T12:00:00.000Z"), agent, data: { from: "0x1", to: "0x2" } })).toBe(body);
  });
});
