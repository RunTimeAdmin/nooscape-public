import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import express from "express";
import { createConnection, createPool } from "mysql2/promise";
import { eq, sql } from "drizzle-orm";
import { apiPayments } from "../drizzle/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { API_CHAINS, API_V1_RATE_LIMIT } from "./apiV1";
import { ARC_TESTNET } from "./x402";
import { createPaymentService } from "./x402Service";
import { facilitatorAnswers, headerOf, newBuyer, newFacilitator, testConfig, TEST_CIRCLE_KEY } from "./x402Testing";

/**
 * Pay per call against a real database (docs/data-access-2026-10-19.md, stage D4): the payments table is a manual migration, so the
 * API first runs without it exactly as it did before, and then with the file pasted as the owner would paste it, twice. The ledger's
 * guards are the database's: one authorization is one row however many requests arrive at once, a result is never undone, and a
 * paid answer is served again only a few times. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_apipayments_test";
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${BASE_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbReachable)("pay per call against a real database", { timeout: 120_000 }, () => {
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let server: Server;
  let base = "";
  let ledgerModule: typeof import("./apiPayments");
  let rateLimit: typeof import("./rateLimit");
  let splitMigrationStatements: typeof import("./dbMigrations").splitMigrationStatements;
  const cfg = testConfig({ X402_NETWORK: ARC_TESTNET, X402_API_KEY: TEST_CIRCLE_KEY.replace("LIVE", "TEST") });
  const facilitator = newFacilitator(cfg);
  const buyer = newBuyer();
  const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
  const KEY_8 = `eip155:4663:${API_CHAINS.robinhood.registry}:7`;

  const rowsOf = async () => (await writer.execute(sql.raw("SELECT * FROM `api_payments` ORDER BY `seq`")))[0] as unknown as Array<Record<string, unknown>>;
  const lookup = (headers: Record<string, string> = {}) => fetch(`${base}/api/v1/agents/robinhood/7`, { headers });
  const pasteMigration = async () => {
    const paste = await createConnection(process.env.DATABASE_URL!);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0044_api_payments.sql", "utf8"))) await paste.query(statement);
    await paste.end();
    ledgerModule.forgetPaymentsReady();
  };

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const migrations = await import("./dbMigrations");
    splitMigrationStatements = migrations.splitMigrationStatements;
    const baseline = await createConnection(process.env.DATABASE_URL);
    for (const file of (await migrations.collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baseline.query(statement);
    }
    await baseline.end();
    await migrations.applyPendingMigrations(process.env.DATABASE_URL);
    ledgerModule = await import("./apiPayments");
    rateLimit = await import("./rateLimit");
    const { registerApiV1, defaultApiV1Deps } = await import("./apiV1");
    writer = drizzle(createPool(process.env.DATABASE_URL));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    const payments = createPaymentService({ config: cfg, ledger: ledgerModule.dbPaymentLedger, fetchImpl: facilitator.fetchImpl });
    const entry = { id: ENTRY_ID, displayName: "Alice Agent", locatorHost: "alice.example", protocol: "erc8004", sourceSignalNote: "x", registrant: null, feedbackCount: 0, firstSeenAt: new Date("2026-10-01T00:00:00Z"), lastSeenAt: new Date("2026-10-18T12:00:00Z"), related: null, activity: null, twin: null, ratings: null } as never;
    const app = express();
    registerApiV1(app, {
      ...defaultApiV1Deps,
      findEntries: async (_protocols, key) => (key === KEY_8 ? [{ id: ENTRY_ID, protocol: "erc8004", externalKey: key }] : []),
      getEntry: async () => entry,
      claimOf: async () => ({ available: true, claimable: true, claim: null }),
      payments,
    });
    await new Promise<void>(done => {
      server = app.listen(0, "127.0.0.1", () => done());
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  beforeEach(() => {
    rateLimit.resetRateLimits();
    ledgerModule.forgetPaymentsReady();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>(done => (server ? server.close(() => done()) : done()));
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  // ---------------------------------------------------------------- before the migration

  it("runs without the table as it did before: no offer, a limit past 30 lookups, a check needs a key, and a boot made no table", async () => {
    const [found] = (await writer.execute(sql`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ${TEST_DB} AND table_name = 'api_payments'`)) as unknown as [Array<{ n: number }>];
    expect(Number(found[0]!.n)).toBe(0);
    expect(await ledgerModule.dbPaymentLedger.ready()).toBe(false);
    const needsKey = await fetch(`${base}/api/v1/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: { chain: "robinhood", id: "7" } }) });
    expect(needsKey.status).toBe(401);
    for (let index = 1; index < API_V1_RATE_LIMIT.requests; index += 1) expect((await lookup()).status).toBe(200);
    const limited = await lookup({ "payment-signature": headerOf(buyer.pay(cfg, "agent")) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("payment-required")).toBeNull();
    expect(facilitator.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------- the migration file

  it("applies as the owner would paste it, and again without harm, and keeps no signature and no network address", async () => {
    await pasteMigration();
    await pasteMigration();
    const [columns] = (await writer.execute(sql`SELECT column_name AS c, column_type AS t FROM information_schema.columns WHERE table_schema = ${TEST_DB} AND table_name = 'api_payments' ORDER BY ordinal_position`)) as unknown as [Array<{ c: string; t: string }>];
    expect(columns.map(column => column.c)).toEqual(["id", "seq", "paymentId", "network", "endpoint", "payer", "nonce", "amount", "validBefore", "subjectHash", "status", "transaction", "reason", "sends", "serves", "createdAt", "updatedAt"]);
    expect(columns.map(column => column.c.toLowerCase()).filter(name => /ip|addr|sig|host|user|agent/.test(name))).toEqual([]);
    expect(columns.some(column => /text|blob/i.test(column.t))).toBe(false);
    expect(await ledgerModule.dbPaymentLedger.ready()).toBe(true);
  });

  // ---------------------------------------------------------------- the ledger's guards

  const payment = (over: Partial<import("./apiPayments").NewPayment> = {}) => ({
    paymentId: `nsc_${"1".repeat(32)}`,
    network: ARC_TESTNET,
    endpoint: "check",
    payer: `0x${"a1".repeat(20)}`,
    nonce: `0x${"b2".repeat(32)}`,
    amount: 10000,
    validBefore: 1_792_390_000,
    subjectHash: "c".repeat(64),
    ...over,
  });

  it("holds an authorization once however many requests try to record it at the same moment", async () => {
    const same = payment({ nonce: `0x${"01".repeat(32)}` });
    const results = await Promise.all(Array.from({ length: 20 }, () => ledgerModule.dbPaymentLedger.begin(same)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await rowsOf()).filter(row => row.nonce === same.nonce)).toHaveLength(1);
    const found = await ledgerModule.dbPaymentLedger.find(ARC_TESTNET, same.payer, same.nonce);
    expect(found).toMatchObject({ status: "settling", sends: 1, serves: 0, amount: 10000, validBefore: 1_792_390_000, transaction: null, reason: null });
  });

  it("never undoes a result: a paid payment cannot become refused or open, and a refused one cannot be paid", async () => {
    const ledger = ledgerModule.dbPaymentLedger;
    const paid = (await ledger.begin(payment({ nonce: `0x${"02".repeat(32)}` })))!;
    expect(await ledger.countSend(paid.id)).toBe(true);
    expect(await ledger.resolve(paid.id, { status: "open", reason: "pending" })).toBe(true);
    expect(await ledger.resolve(paid.id, { status: "paid", transaction: `0x${"7".repeat(64)}` })).toBe(true);
    expect(await ledger.resolve(paid.id, { status: "refused", reason: "late" })).toBe(false);
    expect(await ledger.resolve(paid.id, { status: "open", reason: "late" })).toBe(false);
    expect(await ledger.countSend(paid.id)).toBe(false);
    expect(await ledger.find(ARC_TESTNET, paid.payer, paid.nonce)).toMatchObject({ status: "paid", transaction: `0x${"7".repeat(64)}`, reason: null, sends: 2, serves: 1 });

    const refused = (await ledger.begin(payment({ nonce: `0x${"03".repeat(32)}` })))!;
    expect(await ledger.resolve(refused.id, { status: "refused", reason: "insufficient_funds" })).toBe(true);
    expect(await ledger.resolve(refused.id, { status: "paid", transaction: `0x${"8".repeat(64)}` })).toBe(false);
    expect(await ledger.find(ARC_TESTNET, refused.payer, refused.nonce)).toMatchObject({ status: "refused", reason: "insufficient_funds", transaction: null, serves: 0 });
  });

  it("serves a paid answer a limited number of times, and never serves one that is not paid", async () => {
    const ledger = ledgerModule.dbPaymentLedger;
    const row = (await ledger.begin(payment({ nonce: `0x${"04".repeat(32)}` })))!;
    expect(await ledger.countServe(row.id, 3)).toBe(false);
    await ledger.resolve(row.id, { status: "paid", transaction: `0x${"6".repeat(64)}` });
    const serves = await Promise.all(Array.from({ length: 6 }, () => ledger.countServe(row.id, 3)));
    expect(serves.filter(Boolean)).toHaveLength(2);
    expect((await ledger.find(ARC_TESTNET, row.payer, row.nonce))!.serves).toBe(3);
  });

  it("lists the newest first, summarizes by status, and cuts a long reason short", async () => {
    const ledger = ledgerModule.dbPaymentLedger;
    const row = (await ledger.begin(payment({ nonce: `0x${"05".repeat(32)}` })))!;
    await ledger.resolve(row.id, { status: "open", reason: "x".repeat(500) });
    const recent = await ledger.recent(ARC_TESTNET, 3);
    expect(recent[0]!.nonce).toBe(`0x${"05".repeat(32)}`);
    expect(recent[0]!.reason).toHaveLength(200);
    expect(recent[0]!.seq).toBeGreaterThan(recent[1]!.seq);
    const summary = await ledger.summary(ARC_TESTNET, new Date(Date.now() - 24 * 3600 * 1000));
    expect(Object.fromEntries(summary.map(item => [item.status, item.count]))).toMatchObject({ paid: 2, refused: 1, open: 1, settling: 1 });
    expect(summary.find(item => item.status === "paid")!.amount).toBe(20000);
  });

  it("never forgets a transaction the facilitator named: a later send that names none keeps it", async () => {
    const ledger = ledgerModule.dbPaymentLedger;
    const row = (await ledger.begin(payment({ nonce: `0x${"06".repeat(32)}` })))!;
    const named = `0x${"ab".repeat(32)}`;
    expect(await ledger.resolve(row.id, { status: "open", reason: "first", transaction: named })).toBe(true);
    expect(await ledger.resolve(row.id, { status: "open", reason: "second, none named" })).toBe(true);
    expect(await ledger.resolve(row.id, { status: "open", reason: "third", transaction: null })).toBe(true);
    expect(await ledger.find(ARC_TESTNET, row.payer, row.nonce)).toMatchObject({ status: "open", transaction: named, reason: "third" });
  });

  it("keeps the first transaction a payment named when a later send names another, and records the one that settled", async () => {
    const ledger = ledgerModule.dbPaymentLedger;
    const row = (await ledger.begin(payment({ nonce: `0x${"0a".repeat(32)}` })))!;
    const first = `0x${"ab".repeat(32)}`;
    const later = `0x${"cd".repeat(32)}`;
    expect(await ledger.resolve(row.id, { status: "open", reason: "first", transaction: first })).toBe(true);
    expect(await ledger.resolve(row.id, { status: "open", reason: "a later send named another", transaction: later })).toBe(true);
    expect(await ledger.find(ARC_TESTNET, row.payer, row.nonce)).toMatchObject({ status: "open", transaction: first, reason: "a later send named another" });
    // A settlement records its own transaction.
    expect(await ledger.resolve(row.id, { status: "paid", transaction: later })).toBe(true);
    expect(await ledger.find(ARC_TESTNET, row.payer, row.nonce)).toMatchObject({ status: "paid", transaction: later });
  });

  it("counts the payments nobody will resolve by retrying, and lets the operator set one aside once: never a paid one, and never again", async () => {
    const ledger = ledgerModule.dbPaymentLedger;
    const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);
    const before = await ledger.stale(ARC_TESTNET, hourAgo());
    const old = (await ledger.begin(payment({ nonce: `0x${"08".repeat(32)}` })))!;
    const fresh = (await ledger.begin(payment({ nonce: `0x${"09".repeat(32)}` })))!;
    await writer.update(apiPayments).set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where(eq(apiPayments.id, old.id));
    expect(await ledger.stale(ARC_TESTNET, hourAgo())).toBe(before + 1);
    expect(await ledger.stale("eip155:5042", hourAgo())).toBe(0);
    expect(await ledger.close(old.id, "looked at the transaction: nothing moved")).toBe(true);
    expect(await ledger.close(old.id, "again")).toBe(false);
    expect(await ledger.stale(ARC_TESTNET, hourAgo())).toBe(before);
    expect(await ledger.find(ARC_TESTNET, old.payer, old.nonce)).toMatchObject({ status: "closed", reason: "looked at the transaction: nothing moved" });
    // Set aside is final: it is not sent, resolved or served afterwards.
    expect(await ledger.countSend(old.id)).toBe(false);
    expect(await ledger.resolve(old.id, { status: "paid", transaction: `0x${"1".repeat(64)}` })).toBe(false);
    expect(await ledger.countServe(old.id, 3)).toBe(false);
    // A payment that settled cannot be set aside.
    await ledger.resolve(fresh.id, { status: "paid", transaction: `0x${"2".repeat(64)}` });
    expect(await ledger.close(fresh.id, "no")).toBe(false);
    expect((await ledger.find(ARC_TESTNET, fresh.payer, fresh.nonce))!.status).toBe("paid");
    // Only an unresolved payment counts however old it is: a paid one and a set-aside one do not.
    await writer.update(apiPayments).set({ updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) }).where(eq(apiPayments.id, fresh.id));
    await writer.update(apiPayments).set({ updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) }).where(eq(apiPayments.id, old.id));
    expect(await ledger.stale(ARC_TESTNET, hourAgo())).toBe(before);
  });

  it("counts a wallet's unresolved payments and its settlements that failed after broadcast, keeps that mark when the operator sets one aside, and forgets it after a day", async () => {
    const ledger = ledgerModule.dbPaymentLedger;
    const wallet = `0x${"d4".repeat(20)}`;
    const day = () => new Date(Date.now() - 24 * 60 * 60 * 1000);
    const failed = (await ledger.begin(payment({ payer: wallet, nonce: `0x${"a1".repeat(32)}` })))!;
    expect(await ledger.openFor(ARC_TESTNET, wallet)).toBe(1);
    expect(await ledger.openFor("eip155:5042", wallet)).toBe(0);
    expect(await ledger.failedFor(ARC_TESTNET, wallet, day())).toBe(0);
    await ledger.resolve(failed.id, { status: "open", reason: "failed after broadcast: transaction_failed", transaction: `0x${"f".repeat(64)}` });
    expect(await ledger.failedFor(ARC_TESTNET, wallet, day())).toBe(1);
    expect(await ledger.failedFor("eip155:5042", wallet, day())).toBe(0);
    expect(await ledger.failedFor(ARC_TESTNET, `0x${"d5".repeat(20)}`, day())).toBe(0);
    expect(await ledger.close(failed.id, "looked at it: reverted")).toBe(true);
    expect(await ledger.find(ARC_TESTNET, wallet, failed.nonce)).toMatchObject({ status: "closed", reason: "failed after broadcast; looked at it: reverted" });
    expect(await ledger.openFor(ARC_TESTNET, wallet)).toBe(0);
    expect(await ledger.failedFor(ARC_TESTNET, wallet, day())).toBe(1);
    // An ordinary payment set aside keeps no such mark, and a mark older than the window is forgotten.
    const plain = (await ledger.begin(payment({ payer: wallet, nonce: `0x${"a2".repeat(32)}` })))!;
    await ledger.resolve(plain.id, { status: "open", reason: "settlement_pending" });
    expect(await ledger.close(plain.id, "fine")).toBe(true);
    expect(await ledger.find(ARC_TESTNET, wallet, plain.nonce)).toMatchObject({ status: "closed", reason: "fine" });
    expect(await ledger.failedFor(ARC_TESTNET, wallet, day())).toBe(1);
    await writer.update(apiPayments).set({ updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }).where(eq(apiPayments.id, failed.id));
    expect(await ledger.failedFor(ARC_TESTNET, wallet, day())).toBe(0);
  });

  it("keeps the two networks apart: the same payer and nonce on mainnet is another payment, and the operator's reads show one network", async () => {
    const ledger = ledgerModule.dbPaymentLedger;
    const nonce = `0x${"07".repeat(32)}`;
    const testnet = (await ledger.begin(payment({ nonce })))!;
    const mainnet = (await ledger.begin(payment({ nonce, network: "eip155:5042" })))!;
    expect(mainnet).not.toBeNull();
    expect(mainnet.id).not.toBe(testnet.id);
    expect(await ledger.begin(payment({ nonce, network: "eip155:5042" }))).toBeNull();
    expect((await ledger.find("eip155:5042", testnet.payer, nonce))!.id).toBe(mainnet.id);
    expect((await ledger.find(ARC_TESTNET, testnet.payer, nonce))!.id).toBe(testnet.id);
    expect((await ledger.recent("eip155:5042", 10)).map(row => row.id)).toEqual([mainnet.id]);
    expect((await ledger.unresolved("eip155:5042", 10)).total).toBe(1);
    expect((await ledger.summary("eip155:5042", new Date(Date.now() - 24 * 3600 * 1000))).map(item => item.status)).toEqual(["settling"]);
    expect((await ledger.recent(ARC_TESTNET, 100)).some(row => row.id === mainnet.id)).toBe(false);
  });

  // ---------------------------------------------------------------- a payment from request to row

  it("takes a payment on the real table: offers a price past the free limit, settles once, delivers the same answer, and serves a retry without a second settlement", async () => {
    const before = (await rowsOf()).length;
    const callsBefore = facilitator.calls.length;
    rateLimit.resetRateLimits();
    for (let index = 0; index < API_V1_RATE_LIMIT.requests; index += 1) expect((await lookup()).status).toBe(200);
    const offer = await lookup();
    expect(offer.status).toBe(402);
    const terms = JSON.parse(Buffer.from(offer.headers.get("payment-required")!, "base64").toString("utf8"));
    expect(terms.accepts[0]).toMatchObject({ network: ARC_TESTNET, amount: "5000" });

    const header = headerOf(buyer.pay(cfg, "agent"));
    const [one, two] = await Promise.all([lookup({ "payment-signature": header }), lookup({ "payment-signature": header })]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(facilitator.calls.length - callsBefore).toBe(1);
    const rows = (await rowsOf()).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "paid", endpoint: "agent", amount: 5000, sends: 1, serves: 2 });
    expect(String(rows[0]!.transaction)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(header);
    const receipt = JSON.parse(Buffer.from(one.headers.get("payment-response")!, "base64").toString("utf8"));
    expect(receipt.transaction).toBe(rows[0]!.transaction);
    expect(await one.json()).toEqual(await two.json());
  });

  it("keeps a payment open on the real table when the facilitator does not decide, and settles it on the retry with the same key", async () => {
    const pendingWorld = newFacilitator(cfg, [facilitatorAnswers.pending()]);
    const service = createPaymentService({ config: cfg, ledger: ledgerModule.dbPaymentLedger, fetchImpl: pendingWorld.fetchImpl });
    const ctx = service.accept("check", headerOf(buyer.pay(cfg, "check")), "https://nooscape.si/api/v1/check");
    if (!ctx.ok) throw new Error("not accepted");
    const first = await service.charge(ctx.context, "subject");
    expect(first.deliver).toBe(false);
    const open = await ledgerModule.dbPaymentLedger.find(ARC_TESTNET, ctx.context.payment.payload.authorization.from.toLowerCase(), ctx.context.payment.payload.authorization.nonce.toLowerCase());
    expect(open).toMatchObject({ status: "open", sends: 1, serves: 0 });
    const second = await service.charge(ctx.context, "subject");
    expect(second.deliver).toBe(true);
    const done = await ledgerModule.dbPaymentLedger.find(ARC_TESTNET, open!.payer, open!.nonce);
    expect(done).toMatchObject({ status: "paid", sends: 2, serves: 1 });
    expect(new Set(pendingWorld.calls.map(call => call.body.paymentPayload.extensions["payment-identifier"].info.id)).size).toBe(1);
  });
});
