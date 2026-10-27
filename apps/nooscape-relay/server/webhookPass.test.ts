import { afterEach, describe, expect, it, vi } from "vitest";
import { plan, runWebhookPass, type PassDeps, type SendResult } from "./webhookPass";
import { LIVE_WATCH_LIMIT, type DeliveryRow } from "./webhookStore";
import { ARC_ENTRY, ROBINHOOD_ENTRY, SOLANA_ENTRY, memoryEventSource, memoryWebhookStore, type MemoryLedgers } from "./webhookTesting";
import { DISABLE_AFTER_FAILURES, RETRY_AFTER_SECONDS, signature, signingSecret } from "./webhooks";

/**
 * The webhook pass (docs/data-access-2026-10-19.md, stage D5), with the store, the ledgers, the clock and the network replaced: what it
 * writes, who hears of it, how a failure is retried, and what it never does.
 */
const SIGNING_KEY = "s".repeat(40);
const T0 = new Date("2026-10-19T12:00:00.000Z");
const MINUTE = 60_000;

type Sent = { url: string; body: string; headers: Record<string, string> };

function rig(keys: Record<string, { tier: "free" | "builder" | "pro"; revoked?: boolean }> = { "key-b": { tier: "builder" }, "key-p": { tier: "pro" }, "key-f": { tier: "free" } }) {
  let now = new Date(T0);
  const clock = () => now;
  const mem = memoryWebhookStore(keys, clock);
  const ledgers: MemoryLedgers = { entries: [{ ...ROBINHOOD_ENTRY }, { ...SOLANA_ENTRY }], claims: [], transfers: [], ratings: [] };
  const sent: Sent[] = [];
  let answer: (url: string) => SendResult = () => ({ ok: true, status: 200 });
  let counter = 0;
  const deps: Partial<PassDeps> = {
    store: mem.store,
    source: memoryEventSource(ledgers),
    signingKey: SIGNING_KEY,
    send: async (url, input) => {
      sent.push({ url, ...input });
      return answer(url);
    },
    now: clock,
    newId: () => `id-${(counter += 1)}`,
    budgetMs: 5_000,
    parallel: 2,
  };
  return {
    mem,
    ledgers,
    sent,
    deps,
    run: (extra: Partial<PassDeps> = {}) => runWebhookPass({ ...deps, ...extra }),
    advance: (ms: number) => void (now = new Date(now.getTime() + ms)),
    answer: (next: (url: string) => SendResult) => void (answer = next),
    /** A key that watches the Robinhood entry, with a webhook. */
    watch: async (keyId: string, entryIds: string[] = [ROBINHOOD_ENTRY.id], url = `https://hooks.example.com/${keyId}`) => {
      await mem.store.addWatches(keyId, entryIds);
      await mem.store.setWebhook(keyId, url);
    },
  };
}

const claimEdit = (seq: number, at: Date, entryId = ROBINHOOD_ENTRY.id, kind = "edit") => ({ seq, entryId, kind, field: kind === "edit" ? "website" : null, wallet: "0xabc", reason: kind === "freeze" ? "operator" : null, occurredAt: at });

const SAVED_FEATURES = process.env.VITE_FEATURES;
afterEach(() => {
  delete process.env.WEBHOOK_SIGNING_KEY;
  if (SAVED_FEATURES === undefined) delete process.env.VITE_FEATURES;
  else process.env.VITE_FEATURES = SAVED_FEATURES;
});

describe("when the pass does nothing", () => {
  it("is off without a signing key, with one that is too short, and while the tables do not exist", async () => {
    const r = rig();
    expect(await r.run({ signingKey: null })).toMatchObject({ status: "off", reason: "WEBHOOK_SIGNING_KEY is not set", created: 0, sent: 0 });
    process.env.WEBHOOK_SIGNING_KEY = "short";
    const { signingKey: _unused, ...withoutKey } = r.deps;
    expect(await runWebhookPass(withoutKey)).toMatchObject({ status: "off", reason: "WEBHOOK_SIGNING_KEY must be at least 32 characters" });
    r.mem.setReady(false);
    expect(await r.run()).toMatchObject({ status: "off", reason: expect.stringContaining("migration 0045") });
    expect(r.sent).toHaveLength(0);
  });

  it("does not run twice at once", async () => {
    const r = rig();
    await r.watch("key-b");
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() + MINUTE)));
    r.advance(2 * MINUTE);
    let release: () => void = () => undefined;
    const held = new Promise<void>(done => (release = done));
    const first = r.run({
      send: async () => {
        await held;
        return { ok: true, status: 200 };
      },
    });
    await new Promise(done => setTimeout(done, 20));
    expect(await r.run()).toMatchObject({ status: "busy" });
    release();
    expect(await first).toMatchObject({ status: "ran", sent: 1 });
    expect(await r.run()).toMatchObject({ status: "ran" });
  });
});

describe("what a key hears, and only what it watches", () => {
  it("writes one delivery for a claim edit and sends it, signed with the key's own secret", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(7, new Date(T0.getTime() + 30_000)));
    const report = await r.run();
    expect(report).toMatchObject({ status: "ran", created: 1, sent: 1, retrying: 0, gaveUp: 0 });
    expect(r.sent).toHaveLength(1);
    const [call] = r.sent;
    expect(call!.url).toBe("https://hooks.example.com/key-b");
    const body = JSON.parse(call!.body);
    expect(body).toMatchObject({
      api_version: "v1",
      type: "claim.changed",
      agent: { chain: "robinhood", agent_id: "42", registry: "erc8004", nooscape_id: "entry-rh-1", page_url: "https://nooscape.si/agents/entry-rh-1" },
      data: { seq: 7, kind: "edit", field: "website", wallet: "0xabc", reason: null },
    });
    // The owner's words are not in the event: it says that a field changed, and the record says what it changed to.
    expect(call!.body).not.toContain("oldValue");
    expect(call!.body).not.toContain("old_value");
    expect(call!.body).not.toContain("new_value");
    const timestamp = Number(call!.headers["x-nooscape-timestamp"]);
    expect(timestamp).toBe(Math.floor((T0.getTime() + MINUTE) / 1000));
    expect(call!.headers["x-nooscape-signature"]).toBe(`t=${timestamp},v1=${signature(signingSecret(SIGNING_KEY, "key-b", 1), timestamp, call!.body)}`);
    expect(call!.headers["x-nooscape-signature"]).not.toContain(signature(signingSecret(SIGNING_KEY, "key-p", 1), timestamp, call!.body));
    expect(call!.headers).toMatchObject({ "x-nooscape-event": "claim.changed", "x-nooscape-delivery": body.id, "content-type": "application/json" });
    expect(r.mem.all()[0]).toMatchObject({ status: "sent", attempts: 1, lastStatus: 200, kind: "claim.changed" });
  });

  it("does not send a claim edit again once its delivery has been tidied away, however many claim edits came after it", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(7, new Date(T0.getTime() + 30_000)));
    expect((await r.run()).sent).toBe(1);
    // 31 days on, the delivery is purged. The claim is still among the newest 100 on the whole site, so a read by sequence would find it.
    r.advance(31 * 24 * 3_600_000);
    const report = await r.run();
    expect(report.purged).toBe(1);
    expect(report).toMatchObject({ created: 0, sent: 0 });
    r.advance(31 * 24 * 3_600_000);
    expect(await r.run()).toMatchObject({ created: 0, sent: 0 });
    expect(r.sent).toHaveLength(1);
  });

  it("sends nothing of what happened before the key began to watch, and does not send an event twice", async () => {
    const r = rig();
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() - 3_600_000)));
    r.advance(MINUTE);
    await r.watch("key-b");
    r.ledgers.claims.push(claimEdit(2, new Date(T0.getTime() + 2 * MINUTE)));
    r.advance(5 * MINUTE);
    expect(await r.run()).toMatchObject({ created: 1, sent: 1 });
    expect(JSON.parse(r.sent[0]!.body).data.seq).toBe(2);
    expect(await r.run()).toMatchObject({ created: 0, sent: 0 });
    r.advance(10 * MINUTE);
    expect(await r.run()).toMatchObject({ created: 0, sent: 0 });
    expect(r.mem.all()).toHaveLength(1);
  });

  it("tells the keys that watch the listing, and no key that does not, is free, ended, has no webhook or has had its webhook turned off", async () => {
    const r = rig({ "key-b": { tier: "builder" }, "key-p": { tier: "pro" }, "key-f": { tier: "free" }, "key-r": { tier: "builder", revoked: true }, "key-d": { tier: "builder" }, "key-n": { tier: "builder" }, "key-o": { tier: "builder" } });
    for (const keyId of ["key-b", "key-p", "key-f", "key-r", "key-d"]) await r.watch(keyId);
    await r.mem.store.addWatches("key-n", [ROBINHOOD_ENTRY.id]);
    await r.watch("key-o", [SOLANA_ENTRY.id]);
    r.mem.webhooks.set("key-d", { ...r.mem.webhooks.get("key-d")!, disabledAt: T0 });
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() + 30_000)));
    const report = await r.run();
    expect(report).toMatchObject({ created: 2, sent: 2 });
    expect(r.sent.map(call => call.url).sort()).toEqual(["https://hooks.example.com/key-b", "https://hooks.example.com/key-p"]);
  });

  it("names an ownership change on an EVM registry with its hand-out flag, and on Solana with its signature", async () => {
    const r = rig();
    await r.watch("key-b", [ROBINHOOD_ENTRY.id, SOLANA_ENTRY.id]);
    r.advance(MINUTE);
    const at = new Date(T0.getTime() + 30_000);
    r.ledgers.transfers.push(
      { ref: "own:a", entryId: ROBINHOOD_ENTRY.id, from: "0xaaa", to: "0xbbb", blockNumber: 900, transactionRef: "0xdeadbeef", isHandout: true, createdAt: at },
      { ref: "own:b", entryId: SOLANA_ENTRY.id, from: "OwnerOne", to: "OwnerTwo", blockNumber: null, transactionRef: "5igSolana", isHandout: false, createdAt: at }
    );
    expect(await r.run()).toMatchObject({ created: 2, sent: 2 });
    const bodies = r.sent.map(call => JSON.parse(call.body));
    expect(bodies.find(body => body.agent.chain === "robinhood")).toMatchObject({ type: "ownership.changed", data: { from: "0xaaa", to: "0xbbb", block_number: 900, transaction_hash: "0xdeadbeef", is_handout: true } });
    const solana = bodies.find(body => body.agent.chain === "solana");
    expect(solana).toMatchObject({ type: "ownership.changed", agent: { agent_id: SOLANA_ENTRY.externalKey, registry: "solana_8004" }, data: { from: "OwnerOne", to: "OwnerTwo", transaction_signature: "5igSolana" } });
    expect(solana.data).not.toHaveProperty("transaction_hash");
  });

  it("tells of an Arc listing as it does of the others, in Arc's name, while Arc's switch is on", async () => {
    process.env.VITE_FEATURES = "chain_arc";
    const r = rig();
    r.ledgers.entries.push({ ...ARC_ENTRY });
    await r.watch("key-b", [ARC_ENTRY.id]);
    r.advance(MINUTE);
    const at = new Date(T0.getTime() + 30_000);
    r.ledgers.transfers.push({ ref: "own:arc", entryId: ARC_ENTRY.id, from: "0xaaa", to: "0xbbb", blockNumber: 25_000_000, transactionRef: "0xarc", isHandout: false, createdAt: at });
    r.ledgers.claims.push(claimEdit(1, at, ARC_ENTRY.id, "claim"));
    expect(await r.run()).toMatchObject({ created: 2, sent: 2 });
    const bodies = r.sent.map(call => JSON.parse(call.body));
    expect(bodies.map(body => body.type).sort()).toEqual(["claim.changed", "ownership.changed"]);
    for (const body of bodies) {
      expect(body.agent).toMatchObject({ chain: "arc", agent_id: "13", registry: "erc8004_arc", nooscape_id: ARC_ENTRY.id, links: { agent: "https://nooscape.si/api/v1/agents/arc/13" } });
    }
    expect(bodies.find(body => body.type === "ownership.changed").data).toEqual({ from: "0xaaa", to: "0xbbb", block_number: 25_000_000, transaction_hash: "0xarc", is_handout: false });
  });

  it("says nothing of an Arc listing while Arc's switch is off, and does not record a change of view it did not report", async () => {
    const r = rig();
    r.ledgers.entries.push({ ...ARC_ENTRY });
    await r.watch("key-b", [ARC_ENTRY.id]);
    r.advance(MINUTE);
    const at = new Date(T0.getTime() + 30_000);
    r.ledgers.transfers.push({ ref: "own:arc", entryId: ARC_ENTRY.id, from: "0xaaa", to: "0xbbb", blockNumber: 1, transactionRef: "0xarc", isHandout: false, createdAt: at });
    r.ledgers.claims.push(claimEdit(1, at, ARC_ENTRY.id, "claim"));
    // The switch is off, so the listing is out of the public view as well: nothing is said, not even that it left.
    r.ledgers.entries.find(entry => entry.id === ARC_ENTRY.id)!.visible = false;
    expect(await r.run()).toMatchObject({ created: 0, sent: 0 });
    expect((await r.mem.store.listWatches("key-b"))[0]).toMatchObject({ entryId: ARC_ENTRY.id, visible: true });
    // Switched on again with the listing back in view: the watch was never marked as gone, so no event says it returned. (What the ledgers
    // held is cleared here, since a fact the pass re-reads for its overlap is reported once the chain is served, as for any late row.)
    r.ledgers.transfers.length = 0;
    r.ledgers.claims.length = 0;
    process.env.VITE_FEATURES = "chain_arc";
    r.ledgers.entries.find(entry => entry.id === ARC_ENTRY.id)!.visible = true;
    r.advance(MINUTE);
    expect(await r.run()).toMatchObject({ created: 0, sent: 0 });
  });

  it("tells that an Arc listing left the public view and that it returned, while Arc's switch is on", async () => {
    process.env.VITE_FEATURES = "chain_arc";
    const r = rig();
    r.ledgers.entries.push({ ...ARC_ENTRY });
    await r.watch("key-b", [ARC_ENTRY.id]);
    r.advance(MINUTE);
    r.ledgers.entries.find(entry => entry.id === ARC_ENTRY.id)!.visible = false;
    expect(await r.run()).toMatchObject({ created: 1, sent: 1 });
    r.advance(MINUTE);
    r.ledgers.entries.find(entry => entry.id === ARC_ENTRY.id)!.visible = true;
    expect(await r.run()).toMatchObject({ created: 1, sent: 1 });
    expect(r.sent.map(call => JSON.parse(call.body)).map(body => [body.type, body.agent.chain])).toEqual([["listing.removed", "arc"], ["listing.restored", "arc"]]);
  });

  it("says that a rating was added or taken back and nothing else: not its block, its transaction, who rated or how", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    const at = new Date(T0.getTime() + 30_000);
    r.ledgers.ratings.push({ ref: "fb:1", entryId: ROBINHOOD_ENTRY.id, kind: "added", createdAt: at }, { ref: "fb:2", entryId: ROBINHOOD_ENTRY.id, kind: "revoked", createdAt: at });
    expect(await r.run()).toMatchObject({ created: 2, sent: 2 });
    const bodies = r.sent.map(call => JSON.parse(call.body));
    expect(bodies.map(body => body.type).sort()).toEqual(["feedback.added", "feedback.revoked"]);
    expect(bodies.find(body => body.type === "feedback.added").data).toEqual({});
    expect(bodies.find(body => body.type === "feedback.revoked").data).toEqual({});
  });

  it("gives a claim's wallet only where the public history does: for a claim and an edit, and not for a freeze", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    const at = new Date(T0.getTime() + 30_000);
    r.ledgers.claims.push(claimEdit(1, at, ROBINHOOD_ENTRY.id, "claim"), claimEdit(2, at, ROBINHOOD_ENTRY.id, "edit"), claimEdit(3, at, ROBINHOOD_ENTRY.id, "freeze"), claimEdit(4, at, ROBINHOOD_ENTRY.id, "revoke"), claimEdit(5, at, ROBINHOOD_ENTRY.id, "redact"));
    await r.run();
    const byKind = Object.fromEntries(r.sent.map(call => JSON.parse(call.body).data).map(data => [data.kind, data]));
    expect(byKind.claim.wallet).toBe("0xabc");
    expect(byKind.edit.wallet).toBe("0xabc");
    for (const kind of ["freeze", "revoke", "redact"]) expect(byKind[kind].wallet, kind).toBeNull();
    expect(byKind.freeze.reason).toBe("operator");
  });

  it("says nothing about a listing that has left the public view except that it left: no claim, transfer or rating after that", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    r.ledgers.entries[0]!.visible = false;
    const at = new Date(T0.getTime() + 30_000);
    r.ledgers.claims.push(claimEdit(1, at, ROBINHOOD_ENTRY.id, "freeze"));
    r.ledgers.transfers.push({ ref: "own:1", entryId: ROBINHOOD_ENTRY.id, from: "0xa", to: "0xb", blockNumber: 1, transactionRef: "0x1", isHandout: false, createdAt: at });
    r.ledgers.ratings.push({ ref: "fb:1", entryId: ROBINHOOD_ENTRY.id, kind: "added", createdAt: at });
    const report = await r.run();
    expect(report).toMatchObject({ created: 1, sent: 1 });
    expect(r.sent.map(call => JSON.parse(call.body).type)).toEqual(["listing.removed"]);
    // And what the source holds for a hidden listing is not even read.
    const asked: string[][] = [];
    const base = memoryEventSource(r.ledgers);
    await r.run({ source: { ...base, claimEdits: async (after, ids, since) => (asked.push(ids), base.claimEdits(after, ids, since)) } });
    expect(asked.flat()).not.toContain(ROBINHOOD_ENTRY.id);
  });

  it("says when a watched listing leaves the public view and when it comes back, each time it does", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    expect(await r.run()).toMatchObject({ created: 0 });
    r.ledgers.entries[0]!.visible = false;
    r.advance(MINUTE);
    expect(await r.run()).toMatchObject({ created: 1, sent: 1 });
    expect(JSON.parse(r.sent[0]!.body)).toMatchObject({ type: "listing.removed", agent: { nooscape_id: "entry-rh-1" }, data: {} });
    expect((await r.mem.store.listWatches("key-b"))[0]!.visible).toBe(false);
    r.advance(MINUTE);
    expect(await r.run()).toMatchObject({ created: 0, sent: 0 });
    r.ledgers.entries[0]!.visible = true;
    r.advance(MINUTE);
    expect(await r.run()).toMatchObject({ created: 1, sent: 1 });
    expect(JSON.parse(r.sent[1]!.body).type).toBe("listing.restored");
    r.ledgers.entries[0]!.visible = false;
    r.advance(MINUTE);
    expect(await r.run()).toMatchObject({ created: 1, sent: 1 });
    expect(r.sent.map(call => JSON.parse(call.body).type)).toEqual(["listing.removed", "listing.restored", "listing.removed"]);
  });

  it("skips an entry on a registry the API does not serve, and does not fail for it", async () => {
    const r = rig();
    r.ledgers.entries.push({ id: "entry-other", protocol: "a2a", sourceId: "s", externalKey: "https://example.com/a", visible: true });
    await r.watch("key-b", ["entry-other"]);
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() + 30_000), "entry-other"));
    expect(await r.run()).toMatchObject({ status: "ran", created: 0, sent: 0 });
  });
});

describe("what is planned", () => {
  it("plans nothing for a listing that is out of the public view, whatever facts it is given about it", () => {
    const hidden = { ...ROBINHOOD_ENTRY, visible: false };
    const planned = plan({
      watches: [{ keyId: "key-b", entryId: hidden.id, visible: false, createdAt: T0 }],
      entries: new Map([[hidden.id, hidden]]),
      now: new Date(T0.getTime() + MINUTE),
      newId: () => "id",
      claims: [claimEdit(1, new Date(T0.getTime() + 1_000), hidden.id, "freeze")],
      transfers: [{ ref: "own:1", entryId: hidden.id, from: "0xa", to: "0xb", blockNumber: 1, transactionRef: "0x1", isHandout: false, createdAt: new Date(T0.getTime() + 1_000) }],
      ratings: [{ ref: "fb:1", entryId: hidden.id, kind: "added", createdAt: new Date(T0.getTime() + 1_000) }],
    });
    expect(planned).toEqual({ deliveries: [], visibility: [] });
  });
});

describe("when a delivery fails", () => {
  async function failing() {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() + 30_000)));
    r.answer(() => ({ ok: false, status: 500, error: "http_500" }));
    return r;
  }

  it("is tried again after the waits it was promised, with the same body each time, and given up after the sixth try", async () => {
    const r = await failing();
    const first = await r.run();
    expect(first).toMatchObject({ created: 1, sent: 0, retrying: 1, gaveUp: 0 });
    let row = r.mem.all()[0]!;
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastStatus: 500, lastError: "http_500" });
    expect(row.nextAttemptAt.getTime() - T0.getTime() - MINUTE).toBe(RETRY_AFTER_SECONDS[0]! * 1000);

    // Not before its time.
    r.advance(30_000);
    await r.run();
    expect(r.sent).toHaveLength(1);

    for (let attempt = 1; attempt < RETRY_AFTER_SECONDS.length; attempt += 1) {
      r.advance(RETRY_AFTER_SECONDS[attempt - 1]! * 1000);
      expect(await r.run(), `try ${attempt + 1}`).toMatchObject({ retrying: 1, gaveUp: 0 });
    }
    row = r.mem.all()[0]!;
    expect(row).toMatchObject({ status: "pending", attempts: 5 });
    r.advance(RETRY_AFTER_SECONDS[4]! * 1000);
    expect(await r.run()).toMatchObject({ retrying: 0, gaveUp: 1 });
    row = r.mem.all()[0]!;
    expect(row).toMatchObject({ status: "dead", attempts: 6, lastError: "http_500" });

    // Given up is given up.
    r.advance(100 * 3_600_000);
    await r.run();
    expect(r.sent).toHaveLength(6);
    expect(new Set(r.sent.map(call => call.body)).size).toBe(1);
    expect(new Set(r.sent.map(call => call.headers["x-nooscape-signature"])).size).toBe(6);
  });

  it("is delivered by a later try if the endpoint comes back, and the webhook's failures start again from none", async () => {
    const r = await failing();
    await r.run();
    expect(r.mem.webhooks.get("key-b")!.failures).toBe(1);
    r.answer(() => ({ ok: true, status: 204 }));
    r.advance(61_000);
    expect(await r.run()).toMatchObject({ sent: 1, retrying: 0 });
    expect(r.mem.all()[0]).toMatchObject({ status: "sent", attempts: 2, lastStatus: 204 });
    expect(r.mem.webhooks.get("key-b")!.failures).toBe(0);
  });

  it("counts a refused address or a timeout as a failure with its reason", async () => {
    const r = await failing();
    r.answer(() => ({ ok: false, status: null, error: "forbidden_address" }));
    await r.run();
    expect(r.mem.all()[0]).toMatchObject({ status: "pending", attempts: 1, lastStatus: null, lastError: "forbidden_address" });
  });

  it("turns the webhook off after twenty failures in a row, and stops sending to it", async () => {
    const r = await failing();
    r.mem.webhooks.set("key-b", { ...r.mem.webhooks.get("key-b")!, failures: DISABLE_AFTER_FAILURES - 1 });
    expect(await r.run()).toMatchObject({ disabled: 1 });
    expect(r.mem.webhooks.get("key-b")!.disabledAt).not.toBeNull();
    r.advance(10 * 3_600_000);
    await r.run();
    expect(r.sent).toHaveLength(1);
    // Setting it again turns it back on and clears the count, and what waited is sent.
    r.answer(() => ({ ok: true, status: 200 }));
    await r.mem.store.setWebhook("key-b", "https://hooks.example.com/again");
    expect(await r.run()).toMatchObject({ sent: 1 });
    expect(r.sent[1]!.url).toBe("https://hooks.example.com/again");
  });

  it("ends a key's tries for this run at its first failure, so a down endpoint is not hit by every event in its queue", async () => {
    const r = rig();
    await r.watch("key-b");
    await r.watch("key-p");
    r.advance(MINUTE);
    for (const seq of [1, 2, 3]) r.ledgers.claims.push(claimEdit(seq, new Date(T0.getTime() + 30_000 + seq)));
    r.answer(url => (url.endsWith("key-b") ? { ok: false, status: 503, error: "http_503" } : { ok: true, status: 200 }));
    const report = await r.run();
    expect(r.sent.filter(call => call.url.endsWith("key-b"))).toHaveLength(1);
    expect(r.sent.filter(call => call.url.endsWith("key-p"))).toHaveLength(3);
    expect(report).toMatchObject({ created: 6, sent: 3, retrying: 1 });
    expect(r.mem.all().filter(row => row.keyId === "key-b" && row.attempts === 0)).toHaveLength(2);
  });
});

  it("does not let one key's long queue and failing receiver keep another key's events from being sent", async () => {
    const r = rig();
    await r.watch("key-b");
    await r.watch("key-p");
    r.advance(MINUTE);
    // A long backlog for one key, all older than the other key's event.
    await r.mem.store.insertDeliveries(Array.from({ length: 250 }, (_, index) => ({ id: `backlog-${index}`, keyId: "key-b", eventRef: `old:${index}`, kind: "claim.changed", entryId: ROBINHOOD_ENTRY.id, body: "{}" })));
    await r.mem.store.insertDeliveries([{ id: "other-1", keyId: "key-p", eventRef: "claim:1", kind: "claim.changed", entryId: ROBINHOOD_ENTRY.id, body: "{}" }]);
    r.answer(url => (url.endsWith("key-b") ? { ok: false, status: 500, error: "http_500" } : { ok: true, status: 200 }));
    const report = await r.run();
    expect(report.sent).toBe(1);
    expect(r.mem.all().find(row => row.id === "other-1")).toMatchObject({ status: "sent" });
    expect(r.sent.filter(call => call.url.endsWith("key-b"))).toHaveLength(1);
  });

  it("goes on to the other webhooks and to the tidy step when a database error stops one webhook's deliveries, and counts it", async () => {
    const r = rig();
    await r.watch("key-b");
    await r.watch("key-p");
    r.advance(MINUTE);
    await r.mem.store.insertDeliveries([
      { id: "d-b", keyId: "key-b", eventRef: "claim:1", kind: "claim.changed", entryId: ROBINHOOD_ENTRY.id, body: "{}" },
      { id: "d-p", keyId: "key-p", eventRef: "claim:1", kind: "claim.changed", entryId: ROBINHOOD_ENTRY.id, body: "{}" },
    ]);
    const longAgo = new Date(T0.getTime() - 40 * 24 * 3_600_000);
    r.mem.deliveries.set("old-1", { id: "old-1", seq: 900, keyId: "key-b", eventRef: "old:1", kind: "claim.changed", entryId: ROBINHOOD_ENTRY.id, body: "{}", status: "sent", attempts: 1, nextAttemptAt: longAgo, lastStatus: 200, lastError: null, createdAt: longAgo, sentAt: longAgo });
    const store = {
      ...r.mem.store,
      getWebhook: async (keyId: string) => {
        if (keyId === "key-b") throw new Error("Failed query: select * from api_webhooks where keyId = ?" + String.fromCharCode(10) + "params: key-b,https://hooks.example.com/private");
        return r.mem.store.getWebhook(keyId);
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = await r.run({ store });
    const logged = warn.mock.calls.map(call => call.join(" ")).join(" ");
    warn.mockRestore();
    expect(report).toMatchObject({ status: "ran", failed: 1, sent: 1, purged: 1 });
    expect(r.mem.all().find(row => row.id === "d-p")).toMatchObject({ status: "sent" });
    expect(r.mem.all().find(row => row.id === "d-b")).toMatchObject({ status: "pending" });
    expect(r.mem.deliveries.has("old-1")).toBe(false);
    expect(logged).toContain("[Webhooks] deliveries for one webhook failed:");
    expect(logged).not.toContain("hooks.example.com/private");
  });

  it("takes only a few of one key's deliveries in a run, oldest first, and the rest in later runs", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    await r.mem.store.insertDeliveries(Array.from({ length: 60 }, (_, index) => ({ id: `d-${index}`, keyId: "key-b", eventRef: `e:${index}`, kind: "claim.changed", entryId: ROBINHOOD_ENTRY.id, body: `{"n":${index}}` })));
    expect((await r.run()).sent).toBe(25);
    expect(r.sent.map(call => JSON.parse(call.body).n)).toEqual([...Array(25).keys()]);
    expect((await r.run()).sent).toBe(25);
    expect((await r.run()).sent).toBe(10);
    expect(r.sent.map(call => JSON.parse(call.body).n)).toEqual([...Array(60).keys()]);
  });

describe("one try at a time", () => {
  it("does not send a delivery another run has taken", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() + 30_000)));
    const report = await r.run({ store: { ...r.mem.store, lease: async () => false } });
    expect(report).toMatchObject({ created: 1, sent: 0 });
    expect(r.sent).toHaveLength(0);
    expect(r.mem.all()[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("holds a delivery for two minutes while it is being tried, and sends it again if the run died", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() + 30_000)));
    await r.run({
      send: async () => {
        throw new Error("the process went away");
      },
    }).catch(() => undefined);
    const row = r.mem.all()[0]!;
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
    expect(row.nextAttemptAt.getTime()).toBe(T0.getTime() + MINUTE + 120_000);
    await r.run();
    expect(r.sent).toHaveLength(0);
    r.advance(121_000);
    expect(await r.run()).toMatchObject({ sent: 1 });
  });
});

describe("what it reads and how far", () => {
  it("moves its cursors when nobody watches, so what happens before a watch is not owed to it", async () => {
    const r = rig();
    r.ledgers.claims.push(claimEdit(5, T0), claimEdit(9, T0));
    expect(await r.run()).toMatchObject({ status: "ran", created: 0 });
    expect(r.mem.cursors.get("claims")).toBe("9");
    expect(r.mem.cursors.get("ledgers")).toBe(T0.toISOString());
  });

  it("does not move a cursor past a read that came back full, and says which", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() + 30_000)));
    r.ledgers.full = { transfers: true };
    const report = await r.run();
    expect(report.fullReads).toEqual(["transfers"]);
    expect(r.mem.cursors.get("claims")).toBe("1");
    expect(r.mem.cursors.get("ledgers")).toBeUndefined();
    r.ledgers.full = {};
    r.advance(MINUTE);
    await r.run();
    expect(r.mem.cursors.get("ledgers")).toBe(new Date(T0.getTime() + 2 * MINUTE).toISOString());
  });

  it("does not move the claims cursor past a full claims read either", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() + 30_000)));
    r.ledgers.full = { claims: true };
    expect((await r.run()).fullReads).toEqual(["claims"]);
    expect(r.mem.cursors.get("claims")).toBeUndefined();
    r.ledgers.full = {};
    r.advance(MINUTE);
    await r.run();
    expect(r.mem.cursors.get("claims")).toBe("1");
  });

  it("does not move a cursor when the list of watches was cut short, and says so", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    r.ledgers.claims.push(claimEdit(1, new Date(T0.getTime() + 30_000)));
    const real = await r.mem.store.liveWatches();
    const padded = Array.from({ length: LIVE_WATCH_LIMIT }, (_, index) => ({ ...real[0]!, entryId: index === 0 ? real[0]!.entryId : `filler-${index}` }));
    const report = await r.run({ store: { ...r.mem.store, liveWatches: async () => padded } });
    expect(report.fullReads).toContain("watches");
    expect(r.mem.cursors.get("claims")).toBeUndefined();
    expect(r.mem.cursors.get("ledgers")).toBeUndefined();
    // The first run still delivered what it could read, and the next one, with the whole list, moves on.
    expect(report.created).toBe(1);
    expect((await r.run()).fullReads).toEqual([]);
    expect(r.mem.cursors.get("claims")).toBe("1");
  });

  it("still finds a row that was written a few minutes late", async () => {
    const r = rig();
    await r.watch("key-b");
    r.advance(MINUTE);
    await r.run();
    r.advance(10 * MINUTE);
    r.ledgers.transfers.push({ ref: "own:late", entryId: ROBINHOOD_ENTRY.id, from: "0xa", to: "0xb", blockNumber: 1, transactionRef: "0x1", isHandout: false, createdAt: new Date(T0.getTime() + 5 * MINUTE) });
    expect(await r.run()).toMatchObject({ created: 1, sent: 1 });
  });
});

describe("tidying", () => {
  const DAY = 24 * 3_600_000;
  const old = (id: string, createdAt: Date): DeliveryRow => ({ id, seq: 900, keyId: "key-b", eventRef: `old:${id}`, kind: "claim.changed", entryId: ROBINHOOD_ENTRY.id, body: "{}", status: "sent", attempts: 1, nextAttemptAt: createdAt, lastStatus: 200, lastError: null, createdAt, sentAt: createdAt });

  it("deletes a delivery that is older than 30 days and keeps one that is not", async () => {
    const r = rig();
    await r.watch("key-b");
    r.mem.deliveries.set("old-1", old("old-1", new Date(T0.getTime() - 31 * DAY)));
    r.mem.deliveries.set("new-1", old("new-1", new Date(T0.getTime() - 29 * DAY)));
    expect(await r.run()).toMatchObject({ purged: 1 });
    expect(Array.from(r.mem.deliveries.keys())).toEqual(["new-1"]);
  });

  it("does it at most every six hours", async () => {
    const r = rig();
    await r.watch("key-b");
    r.mem.deliveries.set("old-1", old("old-1", new Date(T0.getTime() - 40 * DAY)));
    expect(await r.run()).toMatchObject({ purged: 1 });
    r.mem.deliveries.set("old-2", old("old-2", new Date(T0.getTime() - 40 * DAY)));
    r.advance(3_600_000);
    expect(await r.run()).toMatchObject({ purged: 0 });
    expect(r.mem.deliveries.has("old-2")).toBe(true);
    r.advance(6 * 3_600_000);
    expect(await r.run()).toMatchObject({ purged: 1 });
  });
});
