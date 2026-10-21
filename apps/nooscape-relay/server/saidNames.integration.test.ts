import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import type { RegistrationNameResult } from "./ingestion/registrationFetch";
import { placeholderSaidName, SAID_CHAIN_SOURCE_KEY } from "./ingestion/saidChain";
import { NAME_RETRY_AFTER_MS, uriHashOf } from "./robinhoodNamesCore";
import { applySaidNames } from "./saidNamesCore";

/**
 * The SAID name step against a real database (docs/approvals/2026-10-18-said-names.md): the links the pass queues, newest identity
 * first, the cards the step reads and only those, what is recorded for each try, the names written onto the entries that still have
 * the placeholder, the tries and the pace, the names the pass lays back over its drafts so that its hourly rewrite does not undo
 * them, and a step that never throws. The fetch is a function that answers per link; the real reader is in
 * ingestion/registrationFetch.test.ts. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_said_names_test";
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

const ownerOf = (n: number) => `${String(n).padStart(2, "1")}${"Q".repeat(42)}`.slice(0, 44);
const cardOf = (owner: string) => `https://api.saidprotocol.com/api/cards/${owner}.json`;
const CID = "QmcsZip4oMCkS8UhrXDmG2Bo1WMaJzbQa35RX2h5QRn1xx";

describe.skipIf(!dbReachable)("the SAID name step against a real database", { timeout: 60_000 }, () => {
  let db: typeof import("./db");
  let names: typeof import("./saidNames");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let source: schema.IngestionSource;
  const sourceId = "src-said";

  /** What the fake fetch answers for a link, and every link it was asked, in order. */
  const answers = new Map<string, RegistrationNameResult>();
  const asked: Array<[string, string]> = [];
  const resolve = async (uri: string, kind: string): Promise<RegistrationNameResult> => {
    asked.push([uri, kind]);
    return answers.get(uri) ?? { status: "failed", reason: "no answer was set" };
  };
  const run = (over: Partial<import("./saidNames").SaidNamesDeps> & { tickStartedAt?: number } = {}) => names.runSaidNames({ resolve, intervalMs: 0, ...over });
  const resolutions = async () => (await writer.select().from(schema.agentRegistrationResolutions)).sort((a, b) => a.lastAttemptAt.getTime() - b.lastAttemptAt.getTime() || a.uri.localeCompare(b.uri));
  const entryOf = async (owner: string) => (await writer.select().from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.externalKey, owner)))[0]!;

  let serial = 0;
  async function seedEntry(owner: string, uri: string, displayName = placeholderSaidName(owner)) {
    serial += 1;
    await writer.insert(schema.agentDirectoryEntries).values({
      id: `said-entry-${serial}`,
      sourceId,
      externalKey: owner,
      displayName,
      protocol: "solana_said",
      locatorHost: uri.startsWith("https://") ? new URL(uri).hostname : null,
      registrant: owner,
      profileUriHash: uriHashOf(uri),
      sourceSignalNote: "SAID registry account (layout v3, registered 2026-03-03) · badge: no · chain facts as recorded, not scored",
    });
  }

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baselineReplay.query(statement);
    }
    await baselineReplay.end();
    await applyPendingMigrations(process.env.DATABASE_URL);

    db = await import("./db");
    names = await import("./saidNames");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "said-names-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "said-names-operator"));
    await writer.insert(schema.ingestionSources).values({
      id: sourceId,
      sourceKey: SAID_CHAIN_SOURCE_KEY,
      label: "SAID test",
      protocol: "solana_said",
      rootUrl: "https://api.mainnet-beta.solana.com",
      allowedHostname: "api.mainnet-beta.solana.com",
      state: "active",
      createdByUserId: operator!.id,
    });
    source = (await db.getIngestionSource(sourceId))!;
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  // Five identities, registered one after the other: owner 1 is the oldest. Owner 5 has an ipfs link, owner 6 an http one (not readable).
  const owners = [1, 2, 3, 4, 5].map(ownerOf);
  const T0 = 1_780_000_000;

  it("queues the readable links, newest identity first, and skips what it cannot ask or has queued before", async () => {
    for (const owner of owners.slice(0, 4)) await seedEntry(owner, cardOf(owner));
    await seedEntry(owners[4]!, `ipfs://${CID}`);
    await seedEntry(ownerOf(6), "http://insecure.example/card.json");
    const links = [
      ...owners.slice(0, 4).map((owner, index) => ({ externalKey: owner, uri: cardOf(owner), createdAtSeconds: T0 + index * 100 })),
      { externalKey: owners[4]!, uri: `ipfs://${CID}`, createdAtSeconds: T0 + 400 },
      { externalKey: ownerOf(6), uri: "http://insecure.example/card.json", createdAtSeconds: T0 + 500 },
    ];
    expect(await names.queueSaidNameLinks(source, links)).toBe(5);
    const rows = await resolutions();
    expect(rows).toHaveLength(5);
    // Newest first: the ipfs one (owner 5), then owner 4, 3, 2, 1, dated in that order and never tried.
    expect(rows.map(row => row.externalKey)).toEqual([owners[4], owners[3], owners[2], owners[1], owners[0]]);
    expect(rows.map(row => row.uriKind)).toEqual(["ipfs", "web", "web", "web", "web"]);
    expect(rows.every(row => row.status === "failed" && row.failReason === "not read yet" && row.attempts === 0 && row.resolvedName === null && row.fetchedAt === null)).toBe(true);
    expect(rows.every(row => row.sourceId === sourceId && row.uriHash === uriHashOf(row.uri))).toBe(true);
    // A second pass queues nothing it queued before.
    expect(await names.queueSaidNameLinks(source, links)).toBe(0);
    expect(await resolutions()).toHaveLength(5);
  });

  it("reads the newest identities first, up to the run's cap, and records each try", async () => {
    answers.set(`ipfs://${CID}`, { status: "resolved", name: "Passkeys" });
    answers.set(cardOf(owners[3]!), { status: "resolved", name: "Kirby" });
    answers.set(cardOf(owners[2]!), { status: "failed", reason: "HTTP 503" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const outcome = await run({ maxNames: 3, maxPerHost: 3 });
      expect(outcome).toMatchObject({ state: "completed", considered: 5, read: 3, resolved: 2, noName: 0, failed: 1, entriesNamed: 2, stoppedBy: null });
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ event: "nooscape_said_names", read: 3, entriesNamed: 2 });
    } finally {
      log.mockRestore();
    }
    // Owner 5 (newest), 4 and 3; owners 2 and 1 wait for the next run.
    expect(asked.map(([uri]) => uri)).toEqual([`ipfs://${CID}`, cardOf(owners[3]!), cardOf(owners[2]!)]);
    expect(asked.map(([, kind]) => kind)).toEqual(["ipfs", "web", "web"]);
    const byOwner = new Map((await resolutions()).map(row => [row.externalKey, row]));
    expect(byOwner.get(owners[4]!)).toMatchObject({ status: "resolved", attempts: 1, resolvedName: "Passkeys", failReason: null });
    expect(byOwner.get(owners[4]!)!.fetchedAt).not.toBeNull();
    expect(byOwner.get(owners[3]!)).toMatchObject({ status: "resolved", attempts: 1, resolvedName: "Kirby" });
    expect(byOwner.get(owners[2]!)).toMatchObject({ status: "failed", attempts: 1, resolvedName: null, failReason: "HTTP 503" });
    expect(byOwner.get(owners[2]!)!.fetchedAt).toBeNull();
    // Not read yet: still never tried.
    expect(byOwner.get(owners[1]!)).toMatchObject({ status: "failed", attempts: 0, failReason: "not read yet" });
  });

  it("writes a name onto the entry that carries the link, and a sentence in its note, and changes nothing else", async () => {
    const named = await entryOf(owners[3]!);
    expect(named.displayName).toBe("Kirby");
    expect(named.sourceSignalNote).toMatch(/^SAID registry account \(layout v3, registered 2026-03-03\) · badge: no · chain facts as recorded, not scored Its name was read from its registration link on \d{4}-\d\d-\d\d; it is the registrant's own claim\.$/);
    expect(named).toMatchObject({ registrant: owners[3], protocol: "solana_said", profileUriHash: uriHashOf(cardOf(owners[3]!)), hidden: false });
    expect((await entryOf(owners[4]!)).displayName).toBe("Passkeys");
    // The one that failed, and the ones not read yet, are still called by the placeholder, with their notes as they were.
    for (const owner of [owners[2]!, owners[1]!, owners[0]!]) {
      const entry = await entryOf(owner);
      expect(entry.displayName).toBe(placeholderSaidName(owner));
      expect(entry.sourceSignalNote).not.toContain("registration link");
    }
  });

  it("does not try a failed link again for six hours, and reads the links never tried first", async () => {
    asked.length = 0;
    answers.set(cardOf(owners[1]!), { status: "no_name" });
    answers.set(cardOf(owners[0]!), { status: "resolved", name: "Elder" });
    const outcome = await run();
    // Owner 2 and owner 1 were never tried; owner 3 failed a moment ago and is not due.
    expect(asked.map(([uri]) => uri)).toEqual([cardOf(owners[1]!), cardOf(owners[0]!)]);
    expect(outcome).toMatchObject({ state: "completed", considered: 2, read: 2, resolved: 1, noName: 1, entriesNamed: 1 });
    const byOwner = new Map((await resolutions()).map(row => [row.externalKey, row]));
    expect(byOwner.get(owners[1]!)).toMatchObject({ status: "no_name", attempts: 1 });
    expect(byOwner.get(owners[2]!)).toMatchObject({ status: "failed", attempts: 1 });
    expect((await entryOf(owners[0]!)).displayName).toBe("Elder");

    // Six hours on, the failed link is due again, and the one with no name in its file gets its second and last try.
    asked.length = 0;
    answers.set(cardOf(owners[2]!), { status: "resolved", name: "Third" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + NAME_RETRY_AFTER_MS + 60_000);
      await run();
    } finally {
      vi.useRealTimers();
    }
    expect(asked.map(([uri]) => uri).sort()).toEqual([cardOf(owners[1]!), cardOf(owners[2]!)].sort());
    expect((await entryOf(owners[2]!)).displayName).toBe("Third");
    const after = new Map((await resolutions()).map(row => [row.externalKey, row]));
    expect(after.get(owners[1]!)).toMatchObject({ status: "no_name", attempts: 2 });
  });

  it("reads nothing more once every link has a name, or its tries are used up", async () => {
    asked.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * NAME_RETRY_AFTER_MS);
      expect(await run()).toMatchObject({ state: "completed", considered: 0, read: 0 });
    } finally {
      vi.useRealTimers();
    }
    expect(asked).toEqual([]);
  });

  it("does not read the card of an identity that has moved its link, or one that has been named another way", async () => {
    const moved = ownerOf(7);
    const named = ownerOf(8);
    await seedEntry(moved, cardOf(moved));
    await seedEntry(named, cardOf(named));
    await names.queueSaidNameLinks(source, [
      { externalKey: moved, uri: cardOf(moved), createdAtSeconds: T0 + 900 },
      { externalKey: named, uri: cardOf(named), createdAtSeconds: T0 + 800 },
    ]);
    // The identity moved to another link after it was queued, and the other entry was given a name by something else.
    await writer.update(schema.agentDirectoryEntries).set({ profileUriHash: uriHashOf("https://elsewhere.example/card.json") }).where(eq(schema.agentDirectoryEntries.externalKey, moved));
    await writer.update(schema.agentDirectoryEntries).set({ displayName: "Already named" }).where(eq(schema.agentDirectoryEntries.externalKey, named));
    asked.length = 0;
    expect(await run()).toMatchObject({ state: "completed", considered: 0, read: 0 });
    expect(asked).toEqual([]);
  });

  it("holds each host to its share of a run, so one host cannot fill it", async () => {
    const owner = (n: number) => ownerOf(20 + n);
    for (let n = 0; n < 6; n += 1) await seedEntry(owner(n), n < 4 ? `https://one.example/card/${n}.json` : `https://other.example/card/${n}.json`);
    await names.queueSaidNameLinks(
      source,
      Array.from({ length: 6 }, (_, n) => ({ externalKey: owner(n), uri: n < 4 ? `https://one.example/card/${n}.json` : `https://other.example/card/${n}.json`, createdAtSeconds: T0 + 2_000 - n }))
    );
    asked.length = 0;
    await run({ maxNames: 4, maxPerHost: 2 });
    const hosts = asked.map(([uri]) => new URL(uri).hostname);
    expect(hosts.filter(host => host === "one.example")).toHaveLength(2);
    expect(hosts.filter(host => host === "other.example")).toHaveLength(2);
  });

  it("stops starting reads when its time is up, and keeps what it read", async () => {
    // Four fresh links, and a clock that jumps a minute a read, which leaves time for one or two of them.
    const fresh = [30, 31, 32, 33].map(ownerOf);
    for (const owner of fresh) await seedEntry(owner, `https://slow.example/card/${owner}.json`);
    await names.queueSaidNameLinks(source, fresh.map((owner, index) => ({ externalKey: owner, uri: `https://slow.example/card/${owner}.json`, createdAtSeconds: T0 + 5_000 - index })));
    let clock = Date.now();
    const slow = async (uri: string, kind: string) => {
      clock += 60_000;
      return resolve(uri, kind);
    };
    asked.length = 0;
    const outcome = await names.runSaidNames({ resolve: slow, intervalMs: 0, now: () => clock, budgetMs: 90_000, maxNames: 4, maxPerHost: 4 });
    expect(outcome).toMatchObject({ state: "completed", stoppedBy: "time" });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBeLessThan(4);
  });

  it("keeps the names the step read when the pass rewrites the entries, because the pass lays them back over its drafts", async () => {
    const readNames = await names.readSaidResolvedNames(sourceId);
    expect(readNames.get(uriHashOf(cardOf(owners[3]!)))).toMatchObject({ name: "Kirby", readOn: expect.stringMatching(/^\d{4}-\d\d-\d\d$/) });
    // A resolved name only: the failed and the not-yet-read links have none.
    expect(readNames.has(uriHashOf(cardOf(owners[1]!)))).toBe(false);

    const draftFor = (owner: string, uri: string) => ({
      externalKey: owner,
      displayName: placeholderSaidName(owner),
      locatorHost: "api.saidprotocol.com",
      registrant: owner,
      accountPubkey: "P".repeat(44),
      profileUriHash: uriHashOf(uri),
      sourceSignalNote: "SAID registry account (layout v3, registered 2026-03-03) · badge: no · chain facts as recorded, not scored",
    });
    const drafts = [draftFor(owners[3]!, cardOf(owners[3]!)), draftFor(owners[4]!, `ipfs://${CID}`)];

    // Without the overlay, the hourly upsert puts the placeholder back: this is what the pass would have done.
    await db.upsertAgentDirectoryEntries({ source, runId: "pass-1", entries: drafts });
    expect((await entryOf(owners[3]!)).displayName).toBe(placeholderSaidName(owners[3]!));

    // With it, the name stays, with the sentence that says where it came from.
    await db.upsertAgentDirectoryEntries({ source, runId: "pass-2", entries: applySaidNames(drafts, readNames) });
    const kept = await entryOf(owners[3]!);
    expect(kept.displayName).toBe("Kirby");
    expect(kept.sourceSignalNote).toMatch(/chain facts as recorded, not scored Its name was read from its registration link on \d{4}-\d\d-\d\d; it is the registrant's own claim\.$/);
    expect((await entryOf(owners[4]!)).displayName).toBe("Passkeys");
  });

  it("does nothing while the source is not active, never throws, and says why", async () => {
    await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, sourceId));
    expect(await run()).toEqual({ state: "no_source" });
    await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, sourceId));
  });

  it("waits out its interval, and does not start on a tick that has already run long", async () => {
    names.resetSaidNamesClock();
    expect((await names.runSaidNames({ resolve, intervalMs: 30 * 60_000 })).state).toBe("completed");
    expect(await names.runSaidNames({ resolve, intervalMs: 30 * 60_000 })).toEqual({ state: "idle" });
    names.resetSaidNamesClock();
    expect(await names.runSaidNames({ resolve, intervalMs: 0, tickStartedAt: Date.now() - names.SAID_NAMES_TICK_LIMIT_MS - 1_000 })).toEqual({ state: "too_late" });
  });

  it("is held to the limits the page and the record state", () => {
    expect(names.SAID_NAMES_MAX_PER_RUN).toBe(20);
    expect(names.SAID_NAMES_MAX_PER_HOST).toBe(20);
    expect(names.SAID_NAMES_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(names.SAID_NAMES_BUDGET_MS).toBe(25_000);
  });
});
