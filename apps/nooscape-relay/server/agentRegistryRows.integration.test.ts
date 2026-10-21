import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { eventually } from "./eventually";
import type { DirectoryEntryDraft } from "./ingestion/types";
import { invalidateDirectoryReads, setDirectorySoftQuietMsForTests } from "./readCache";

/**
 * The listing rules against a real database. The registry rows table holds every
 * registration of a mass registry; the classification step gives each row a
 * listing state from recorded facts and published thresholds, and the publish
 * step makes the directory agree with the listed rows. Thresholds are injected
 * small here so a handful of rows exercises every rule; the production numbers
 * are pinned in the last describe. Runs against a throwaway MySQL schema built
 * by the project's boot-time migration runner, and skips when no database is
 * reachable.
 */
const TEST_DB = "nooscape_registry_rows_test";
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

const REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
// Three different thresholds, so a rule wired to the wrong number fails a test.
const RULES = { sharedProfileLinkFrom: 2, sharedHostFrom: 4, sharedWalletFrom: 3 };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const EMPTY_HASH = sha("");

const LISTED = 1;
const GROUPED = 2;
const PENDING = 3;
const NUMERIC = 4;
const NO_LINK = 0;

describe.skipIf(!dbReachable)("the registry rows listing against a real database", { timeout: 60_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let registry: typeof import("./agentRegistryRows");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorId: number;
  let sourceCounter = 0;

  /** A fresh BNB Chain-protocol source per test, so tests never see each other's rows. */
  const newSource = async (state: "active" | "paused" = "active", protocol: "erc8004_bsc" | "erc8004" = "erc8004_bsc") => {
    sourceCounter += 1;
    const id = `src-registry-${sourceCounter}`;
    await writer.insert(schema.ingestionSources).values({
      id,
      sourceKey: `registry-test-${sourceCounter}`,
      label: `registry test ${sourceCounter}`,
      protocol,
      rootUrl: `https://registry-test-${sourceCounter}.example.com`,
      allowedHostname: `registry-test-${sourceCounter}.example.com`,
      state,
      createdByUserId: operatorId,
    });
    return (await db.getIngestionSource(id))!;
  };

  const draft = (n: number, overrides: Partial<DirectoryEntryDraft> = {}): DirectoryEntryDraft => ({
    externalKey: `eip155:56:${REGISTRY}:${n}`,
    displayName: `Agent #${n}`,
    locatorHost: null,
    registrant: `0x${n.toString(16).padStart(40, "0")}`,
    profileUriHash: sha(`uri-${n}`),
    sourceSignalNote: "BNB Smart Chain ERC-8004 registration. current ownership is not verified.",
    ...overrides,
  });
  const keyOf = (n: number) => `eip155:56:${REGISTRY}:${n}`;
  const seed = async (source: schema.IngestionSource, drafts: DirectoryEntryDraft[]) => registry.insertAgentRegistryRows({ source, runId: "run-test", drafts });
  const rowOf = async (source: schema.IngestionSource, n: number) => {
    const [row] = await writer
      .select()
      .from(schema.agentDirectoryRegistryRows)
      .where(and(eq(schema.agentDirectoryRegistryRows.sourceId, source.id), eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(n))));
    return row!;
  };
  const listingOf = async (source: schema.IngestionSource, ...ids: number[]) => Promise.all(ids.map(async n => (await rowOf(source, n)).listing));
  const entryOf = async (source: schema.IngestionSource, n: number) => {
    const [row] = await writer
      .select()
      .from(schema.agentDirectoryEntries)
      .where(and(eq(schema.agentDirectoryEntries.sourceId, source.id), eq(schema.agentDirectoryEntries.externalKey, keyOf(n))));
    return row;
  };
  const classify = (source: schema.IngestionSource) => registry.classifyAgentRegistryListing(source.id, RULES);

  beforeAll(async () => {
    // The reload starts at the first read after a write, instead of after the production quiet period.
    setDirectorySoftQuietMsForTests(0);
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
    registry = await import("./agentRegistryRows");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "registry-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "registry-operator"));
    operatorId = operator.id;
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  describe("classification", () => {
    it("writes registrations pending, or excluded when the draft says there is no usable link, and never overwrites a row", async () => {
      const source = await newSource();
      await seed(source, [draft(1), draft(2, { listing: 0 })]);
      expect(await listingOf(source, 1, 2)).toEqual([PENDING, NO_LINK]);
      // A re-scan of the same registration (same key) is INSERT-IGNORE: the stored row stays exactly as it was.
      await classify(source);
      await seed(source, [draft(1, { displayName: "rewritten", listing: 0 })]);
      const row = await rowOf(source, 1);
      expect([row.displayName, row.listing]).toEqual(["Agent #1", LISTED]);
    });

    it("lists a registration with a link of its own, a host and a wallet nothing else shares", async () => {
      const source = await newSource();
      await seed(source, [draft(1, { locatorHost: "solo.example.com" })]);
      await classify(source);
      expect(await listingOf(source, 1)).toEqual([LISTED]);
    });

    it("groups every registration that shares one exact profile link, and only those", async () => {
      const source = await newSource();
      const shared = sha("template");
      await seed(source, [draft(1, { profileUriHash: shared }), draft(2, { profileUriHash: shared }), draft(3)]);
      await classify(source);
      expect(await listingOf(source, 1, 2, 3)).toEqual([GROUPED, GROUPED, LISTED]);
    });

    it("groups a host at its threshold and not below it", async () => {
      const source = await newSource();
      await seed(source, [
        draft(1, { locatorHost: "platform.example.com" }),
        draft(2, { locatorHost: "platform.example.com" }),
        draft(3, { locatorHost: "platform.example.com" }),
        draft(4, { locatorHost: "platform.example.com" }),
        draft(5, { locatorHost: "trio.example.com" }),
        draft(6, { locatorHost: "trio.example.com" }),
        draft(7, { locatorHost: "trio.example.com" }),
      ]);
      await classify(source);
      // Four registrations reach the host threshold of four; three do not (three is the wallet threshold, not this one).
      expect(await listingOf(source, 1, 2, 3, 4, 5, 6, 7)).toEqual([GROUPED, GROUPED, GROUPED, GROUPED, LISTED, LISTED, LISTED]);
    });

    it("groups a wallet at its threshold and not below it", async () => {
      const source = await newSource();
      const mass = "0x" + "a".repeat(40);
      const pair = "0x" + "b".repeat(40);
      await seed(source, [draft(1, { registrant: mass }), draft(2, { registrant: mass }), draft(3, { registrant: mass }), draft(4, { registrant: pair }), draft(5, { registrant: pair })]);
      await classify(source);
      expect(await listingOf(source, 1, 2, 3, 4, 5)).toEqual([GROUPED, GROUPED, GROUPED, LISTED, LISTED]);
    });

    it("counts a held-out registration toward its wallet, because the wallet registered it", async () => {
      const source = await newSource();
      const wallet = "0x" + "c".repeat(40);
      await seed(source, [draft(1, { registrant: wallet }), draft(2, { registrant: wallet }), draft(3, { registrant: wallet, listing: 0 })]);
      await classify(source);
      expect(await listingOf(source, 1, 2, 3)).toEqual([GROUPED, GROUPED, NO_LINK]);
    });

    it("excludes a name that is only a number before any group rule, and still counts it in its groups", async () => {
      const source = await newSource();
      const wallet = "0x" + "d".repeat(40);
      await seed(source, [
        draft(1, { displayName: "12345" }),
        draft(2, { displayName: "007" }),
        draft(3, { displayName: "00x7" }),
        draft(4, { displayName: "A1" }),
        draft(5, { displayName: "98765", registrant: wallet }),
        draft(6, { registrant: wallet }),
        draft(7, { registrant: wallet }),
      ]);
      await classify(source);
      expect(await listingOf(source, 1, 2, 3, 4)).toEqual([NUMERIC, NUMERIC, LISTED, LISTED]);
      // Row 5 is numeric (it never becomes grouped), yet it is the third registration of its wallet.
      expect(await listingOf(source, 5, 6, 7)).toEqual([NUMERIC, GROUPED, GROUPED]);
    });

    it("is stable: classifying again changes nothing", async () => {
      const source = await newSource();
      const shared = sha("template-2");
      await seed(source, [draft(1, { profileUriHash: shared }), draft(2, { profileUriHash: shared }), draft(3), draft(4, { displayName: "42" }), draft(5, { listing: 0 })]);
      await classify(source);
      const first = await listingOf(source, 1, 2, 3, 4, 5);
      await classify(source);
      await classify(source);
      expect(await listingOf(source, 1, 2, 3, 4, 5)).toEqual(first);
      expect(first).toEqual([GROUPED, GROUPED, LISTED, NUMERIC, NO_LINK]);
    });

    it("groups a listed registration when its group grows later, and leaves other sources alone", async () => {
      const source = await newSource();
      const other = await newSource();
      const wallet = "0x" + "e".repeat(40);
      await seed(source, [draft(1, { registrant: wallet }), draft(2, { registrant: wallet })]);
      await seed(other, [draft(1, { registrant: wallet }), draft(2, { registrant: wallet }), draft(3, { registrant: wallet })]);
      await classify(source);
      await classify(other);
      expect(await listingOf(source, 1, 2)).toEqual([LISTED, LISTED]);
      expect(await listingOf(other, 1, 2, 3)).toEqual([GROUPED, GROUPED, GROUPED]);
      await seed(source, [draft(3, { registrant: wallet })]);
      await classify(source);
      expect(await listingOf(source, 1, 2, 3)).toEqual([GROUPED, GROUPED, GROUPED]);
    });
  });

  describe("publishing", () => {
    it("inserts listed rows into the directory, refreshes ones whose facts changed, and removes ones no longer listed", async () => {
      const source = await newSource();
      const wallet = "0x" + "1".repeat(40);
      await seed(source, [draft(1, { locatorHost: "one.example.com" }), draft(2), draft(3, { registrant: wallet }), draft(4, { registrant: wallet })]);
      await classify(source);

      let result = await registry.publishAgentRegistryListing(source.id);
      expect(result).toEqual({ inserted: 4, refreshed: 0, removed: 0 });
      const first = (await entryOf(source, 1))!;
      expect([first.displayName, first.locatorHost, first.protocol, first.registrant, first.hidden]).toEqual(["Agent #1", "one.example.com", "erc8004_bsc", (await rowOf(source, 1)).registrant, false]);
      expect(first.profileUriHash).toBe(sha("uri-1"));

      // Nothing changed: publishing again is a no-op.
      result = await registry.publishAgentRegistryListing(source.id);
      expect(result).toEqual({ inserted: 0, refreshed: 0, removed: 0 });

      // A rollup lands on the registry row (the activity ledger writes it there); the entry follows.
      await writer.update(schema.agentDirectoryRegistryRows).set({ mintBlock: 79_500_000, uriUpdateCount: 2 }).where(eq(schema.agentDirectoryRegistryRows.id, (await rowOf(source, 1)).id));
      result = await registry.publishAgentRegistryListing(source.id);
      expect(result).toEqual({ inserted: 0, refreshed: 1, removed: 0 });
      const refreshed = (await entryOf(source, 1))!;
      expect([refreshed.mintBlock, refreshed.uriUpdateCount, refreshed.id]).toEqual([79_500_000, 2, first.id]);

      // A third registration from the wallet groups rows 3 and 4 and adds itself held out: both entries go.
      await seed(source, [draft(5, { registrant: wallet })]);
      await classify(source);
      result = await registry.publishAgentRegistryListing(source.id);
      expect(result).toEqual({ inserted: 0, refreshed: 0, removed: 2 });
      expect(await entryOf(source, 3)).toBeUndefined();
      expect(await entryOf(source, 4)).toBeUndefined();
      expect(await entryOf(source, 5)).toBeUndefined();
      expect(await entryOf(source, 2)).toBeDefined();
    });

    it("inserts in chunks, so a large first publish is several short writes and still publishes every listed row once", async () => {
      const source = await newSource();
      await seed(source, Array.from({ length: 7 }, (_, index) => draft(index + 1)));
      await classify(source);
      expect(await registry.publishAgentRegistryListing(source.id, { insertChunk: 3 })).toEqual({ inserted: 7, refreshed: 0, removed: 0 });
      for (let n = 1; n <= 7; n += 1) expect(await entryOf(source, n), `agent ${n}`).toBeDefined();
      // A chunk that exactly divides the work ends on an empty pass and does not loop forever or double-insert.
      const exact = await newSource();
      await seed(exact, Array.from({ length: 6 }, (_, index) => draft(index + 1)));
      await classify(exact);
      expect(await registry.publishAgentRegistryListing(exact.id, { insertChunk: 3 })).toEqual({ inserted: 6, refreshed: 0, removed: 0 });
    });

    it("never touches an entry an operator hid, and never publishes a held-out row", async () => {
      const source = await newSource();
      await seed(source, [draft(1), draft(2, { listing: 0 }), draft(3, { displayName: "5150" })]);
      await classify(source);
      await registry.publishAgentRegistryListing(source.id);
      expect(await entryOf(source, 2)).toBeUndefined();
      expect(await entryOf(source, 3)).toBeUndefined();
      const entry = (await entryOf(source, 1))!;
      await writer.update(schema.agentDirectoryEntries).set({ hidden: true }).where(eq(schema.agentDirectoryEntries.id, entry.id));
      await writer.update(schema.agentDirectoryRegistryRows).set({ mintBlock: 1 }).where(eq(schema.agentDirectoryRegistryRows.id, (await rowOf(source, 1)).id));
      await registry.publishAgentRegistryListing(source.id);
      const after = (await entryOf(source, 1))!;
      expect([after.hidden, after.mintBlock, after.id]).toEqual([true, 1, entry.id]);
    });

    it("carries a suppressed host's hidden flag, so a suppressed domain never surfaces", async () => {
      const source = await newSource();
      await seed(source, [
        draft(1, { locatorHost: "api.agentrank.info", displayName: "Suppressedhost Probe" }),
        draft(2, { displayName: "Visiblehost Probe" }),
      ]);
      expect((await rowOf(source, 1)).hidden).toBe(true);
      await classify(source);
      await registry.publishAgentRegistryListing(source.id);
      expect((await entryOf(source, 1))!.hidden).toBe(true);
      const visible = await db.searchAgentDirectory({ query: "Probe", limit: 25 });
      const names = visible.entries.map(entry => entry.displayName);
      expect(names).toContain("Visiblehost Probe");
      expect(names).not.toContain("Suppressedhost Probe");
    });

    it("refreshes a source in one call: classify when told or when anything is pending, and always before a publish", async () => {
      const source = await newSource();
      await seed(source, [draft(1), draft(2)]);
      // Nothing told it to classify, but rows are pending: it classifies anyway. It was not asked to publish.
      let result = await registry.refreshAgentRegistryListing(source, { classify: false, publish: false, rules: RULES });
      expect(result).toEqual({ classified: true, published: null });
      expect(await entryOf(source, 1)).toBeUndefined();
      // Nothing is pending and it was told nothing changed, yet a publish never runs on a stale classification.
      result = await registry.refreshAgentRegistryListing(source, { classify: false, publish: true, rules: RULES });
      expect(result).toEqual({ classified: true, published: { inserted: 2, refreshed: 0, removed: 0 } });
      expect(await entryOf(source, 1)).toBeDefined();
      // With nothing pending and nothing to publish it does neither.
      result = await registry.refreshAgentRegistryListing(source, { classify: false, publish: false, rules: RULES });
      expect(result).toEqual({ classified: false, published: null });
    });

    it("heals a classification that never ran: registrations with no usable link add to a wallet without leaving a pending row", async () => {
      const source = await newSource();
      const wallet = "0x" + "8".repeat(40);
      await seed(source, [draft(1, { registrant: wallet }), draft(2, { registrant: wallet })]);
      await registry.refreshAgentRegistryListing(source, { classify: true, publish: true, rules: RULES });
      expect(await listingOf(source, 1, 2)).toEqual([LISTED, LISTED]);
      // A window of registrations with no usable link arrives and its classification fails (never runs): the third
      // registration of the wallet is born excluded, so no pending row remembers that anything changed.
      await seed(source, [draft(3, { registrant: wallet, listing: 0 })]);
      expect(await listingOf(source, 1, 2, 3)).toEqual([LISTED, LISTED, NO_LINK]);
      const result = await registry.refreshAgentRegistryListing(source, { classify: false, publish: true, rules: RULES });
      expect(result.classified).toBe(true);
      expect(result.published).toEqual({ inserted: 0, refreshed: 0, removed: 2 });
      expect(await listingOf(source, 1, 2)).toEqual([GROUPED, GROUPED]);
    });

    it("keeps an operator's hide when a registration leaves the listing and comes back", async () => {
      const source = await newSource();
      await seed(source, [draft(1), draft(2)]);
      await classify(source);
      await registry.publishAgentRegistryListing(source.id);
      const hidden = (await entryOf(source, 1))!;
      await writer.update(schema.agentDirectoryEntries).set({ hidden: true }).where(eq(schema.agentDirectoryEntries.id, hidden.id));
      // A clone of registration 1's link appears: both are grouped and entry 1 is removed.
      const link = (await rowOf(source, 1)).profileUriHash!;
      await registry.applyAgentRegistryUriUpdates({
        source,
        runId: "run-flap",
        updates: [{ externalKey: keyOf(2), locatorHost: null, profileUriHash: link, hasProfileLink: true }],
        rules: RULES,
      });
      await classify(source);
      expect(await listingOf(source, 1, 2)).toEqual([GROUPED, GROUPED]);
      expect((await registry.publishAgentRegistryListing(source.id)).removed).toBe(2);
      expect(await entryOf(source, 1)).toBeUndefined();
      // The clone moves to a link of its own: registration 1 is listed again, and it comes back still hidden.
      await registry.applyAgentRegistryUriUpdates({
        source,
        runId: "run-flap-2",
        updates: [{ externalKey: keyOf(2), locatorHost: null, profileUriHash: sha("a-link-of-its-own"), hasProfileLink: true }],
        rules: RULES,
      });
      await classify(source);
      await registry.publishAgentRegistryListing(source.id);
      expect((await entryOf(source, 1))!.hidden).toBe(true);
      expect((await entryOf(source, 2))!.hidden).toBe(false);
    });

    it("keeps the entry of a row that is pending again until classification decides, so overlapping runs cannot delete it", async () => {
      const source = await newSource();
      await seed(source, [draft(1)]);
      await classify(source);
      await registry.publishAgentRegistryListing(source.id);
      await registry.applyAgentRegistryUriUpdates({
        source,
        runId: "run-overlap",
        updates: [{ externalKey: keyOf(1), locatorHost: null, profileUriHash: sha("moved-link"), hasProfileLink: true }],
        rules: RULES,
      });
      expect(await listingOf(source, 1)).toEqual([PENDING]);
      // Another run's publish arrives before this run's classification: it must not remove a row nobody has held out.
      expect(await registry.publishAgentRegistryListing(source.id)).toEqual({ inserted: 0, refreshed: 0, removed: 0 });
      expect(await entryOf(source, 1)).toBeDefined();
      // Classification then decides: still listed on its new link, so the entry follows it.
      await classify(source);
      expect(await registry.publishAgentRegistryListing(source.id)).toEqual({ inserted: 0, refreshed: 1, removed: 0 });
      expect((await entryOf(source, 1))!.profileUriHash).toBe(sha("moved-link"));
    });
  });

  describe("URI updates", () => {
    const update = (n: number, overrides: Partial<{ locatorHost: string | null; profileUriHash: string; hasProfileLink: boolean }> = {}) => ({
      externalKey: keyOf(n),
      locatorHost: null,
      profileUriHash: sha(`updated-${n}`),
      hasProfileLink: true,
      ...overrides,
    });
    const apply = (source: schema.IngestionSource, updates: ReturnType<typeof update>[]) =>
      registry.applyAgentRegistryUriUpdates({ source, runId: "run-update", updates, rules: RULES });

    it("sends an updated row back to pending on its new link, and ignores a row the source never registered", async () => {
      const source = await newSource();
      await seed(source, [draft(1, { locatorHost: "old.example.com" })]);
      await classify(source);
      expect(await apply(source, [update(1, { locatorHost: "new.example.com" }), update(99)])).toBe(1);
      const row = await rowOf(source, 1);
      expect([row.listing, row.locatorHost, row.profileUriHash, row.lastRunId]).toEqual([PENDING, "new.example.com", sha("updated-1"), "run-update"]);
      expect(row.displayName).toBe("Agent #1");
    });

    it("applies a batch all or nothing: a failure midway leaves no update and no re-pending behind, and the retry does the whole job", async () => {
      const source = await newSource();
      const shared = sha("atomic-pair");
      await seed(source, [draft(1, { profileUriHash: shared }), draft(2, { profileUriHash: shared }), draft(3)]);
      await classify(source);
      // The second update's link is longer than the column, so its statement fails after the first one succeeded.
      await expect(apply(source, [update(2), update(3, { profileUriHash: "x".repeat(80) })])).rejects.toThrow();
      expect(await listingOf(source, 1, 2, 3)).toEqual([GROUPED, GROUPED, LISTED]);
      expect((await rowOf(source, 2)).profileUriHash).toBe(shared);
      // Without the transaction the retry would see the new link as the old one and strand row 1 as grouped.
      expect(await apply(source, [update(2)])).toBe(1);
      expect(await listingOf(source, 1, 2)).toEqual([PENDING, PENDING]);
    });

    it("lists a registration on its current link: no URI at registration, an IPFS link later", async () => {
      const source = await newSource();
      await seed(source, [draft(1, { listing: 0, profileUriHash: EMPTY_HASH })]);
      await classify(source);
      expect(await listingOf(source, 1)).toEqual([NO_LINK]);
      await apply(source, [update(1)]);
      expect(await listingOf(source, 1)).toEqual([PENDING]);
      await classify(source);
      expect(await listingOf(source, 1)).toEqual([LISTED]);
    });

    it("holds a listed registration out when its link becomes unusable, and removes its entry at the next publish", async () => {
      const source = await newSource();
      await seed(source, [draft(1)]);
      await classify(source);
      await registry.publishAgentRegistryListing(source.id);
      expect(await entryOf(source, 1)).toBeDefined();
      await apply(source, [update(1, { hasProfileLink: false, profileUriHash: EMPTY_HASH })]);
      expect(await listingOf(source, 1)).toEqual([NO_LINK]);
      expect(await registry.publishAgentRegistryListing(source.id)).toEqual({ inserted: 0, refreshed: 0, removed: 1 });
    });

    it("keeps a numeric-name row excluded for its name, whatever its link does", async () => {
      const source = await newSource();
      await seed(source, [draft(1, { displayName: "424242" })]);
      await classify(source);
      await apply(source, [update(1)]);
      expect(await listingOf(source, 1)).toEqual([NUMERIC]);
    });

    it("sends the rows left behind in a profile link group that shrank below its threshold back to pending, and lists them", async () => {
      const source = await newSource();
      const shared = sha("pair-link");
      await seed(source, [draft(1, { profileUriHash: shared }), draft(2, { profileUriHash: shared })]);
      await classify(source);
      expect(await listingOf(source, 1, 2)).toEqual([GROUPED, GROUPED]);
      await apply(source, [update(2)]);
      // Row 2 moved to a link of its own; row 1 is now alone on the old one and must be re-evaluated.
      expect(await listingOf(source, 1, 2)).toEqual([PENDING, PENDING]);
      await classify(source);
      expect(await listingOf(source, 1, 2)).toEqual([LISTED, LISTED]);
    });

    it("leaves a group grouped while it still reaches its threshold", async () => {
      const source = await newSource();
      const shared = sha("trio-link");
      await seed(source, [draft(1, { profileUriHash: shared }), draft(2, { profileUriHash: shared }), draft(3, { profileUriHash: shared })]);
      await classify(source);
      await apply(source, [update(3)]);
      expect(await listingOf(source, 1, 2, 3)).toEqual([GROUPED, GROUPED, PENDING]);
    });

    it("applies the same shrink rule to a host", async () => {
      const source = await newSource();
      await seed(source, [
        draft(1, { locatorHost: "crowd.example.com" }),
        draft(2, { locatorHost: "crowd.example.com" }),
        draft(3, { locatorHost: "crowd.example.com" }),
        draft(4, { locatorHost: "crowd.example.com" }),
        draft(5, { locatorHost: "other.example.com" }),
      ]);
      await classify(source);
      expect(await listingOf(source, 1, 2, 3, 4, 5)).toEqual([GROUPED, GROUPED, GROUPED, GROUPED, LISTED]);
      await apply(source, [update(4, { locatorHost: "elsewhere.example.com" })]);
      // The host fell to three registrations, below its threshold of four.
      expect(await listingOf(source, 1, 2, 3, 4)).toEqual([PENDING, PENDING, PENDING, PENDING]);
      await classify(source);
      expect(await listingOf(source, 1, 2, 3, 4)).toEqual([LISTED, LISTED, LISTED, LISTED]);
    });

    it("leaves a host grouped while it still reaches its threshold", async () => {
      const source = await newSource();
      await seed(source, Array.from({ length: 5 }, (_, index) => draft(index + 1, { locatorHost: "busy.example.com" })));
      await classify(source);
      await apply(source, [update(5, { locatorHost: "elsewhere.example.com" })]);
      expect(await listingOf(source, 1, 2, 3, 4, 5)).toEqual([GROUPED, GROUPED, GROUPED, GROUPED, PENDING]);
    });
  });

  describe("what the public sees", () => {
    it("describes the registry: what is stored, what is listed, why the rest is held out, and the biggest shared links and hosts", async () => {
      const source = await newSource();
      const template = sha("big-template");
      await seed(source, [
        draft(1, { profileUriHash: template, locatorHost: "templates.example.com", displayName: "Template Agent" }),
        draft(2, { profileUriHash: template, locatorHost: "templates.example.com", displayName: "Template Agent" }),
        draft(3, { profileUriHash: template, locatorHost: "templates.example.com", displayName: "Template Agent" }),
        draft(4, { locatorHost: "templates.example.com" }),
        draft(5, { displayName: "2024" }),
        draft(6),
        draft(7, { listing: 0, profileUriHash: EMPTY_HASH }),
        draft(8, { listing: 0, profileUriHash: EMPTY_HASH }),
        draft(9, { listing: 0, profileUriHash: EMPTY_HASH }),
      ]);
      await classify(source);
      const profile = await registry.readAgentRegistryProfile(source.id, RULES);
      // One registration passes the rules, and none is in the directory until a walk that has caught up publishes.
      expect(profile).toMatchObject({ recorded: 9, listed: 1, published: 0, grouped: 4, numericName: 1, withoutProfileLink: 3, pending: 0, rules: RULES });
      await registry.publishAgentRegistryListing(source.id);
      expect(await registry.readAgentRegistryProfile(source.id, RULES)).toMatchObject({ listed: 1, published: 1 });
      // The three registrations that share one exact link are the shared group; the three that share the empty URI are not a link.
      expect(profile.sharedProfileGroups).toEqual([{ label: "templates.example.com", registrations: 3 }]);
      // A link with no host is labeled by the name its members record, unless that is only a per-member placeholder.
      const named = sha("named-template");
      const bare = sha("bare-link");
      await seed(source, [
        draft(20, { profileUriHash: named, displayName: "Shared Inline Agent" }),
        draft(21, { profileUriHash: named, displayName: "Shared Inline Agent" }),
        draft(22, { profileUriHash: bare }),
        draft(23, { profileUriHash: bare }),
        draft(24, { profileUriHash: bare }),
        draft(25, { profileUriHash: bare }),
      ]);
      const labeled = (await registry.readAgentRegistryProfile(source.id, RULES)).sharedProfileGroups;
      expect(labeled).toEqual([
        { label: "a link without a host", registrations: 4 },
        { label: "templates.example.com", registrations: 3 },
        { label: "Shared Inline Agent", registrations: 2 },
      ]);
      expect(profile.topHosts).toEqual([{ host: "templates.example.com", registrations: 4 }]);
    });

    it("serves the profile only for an active BNB Chain source, and replaces the cached copy after a refresh changes it", async () => {
      // Park every earlier test source so this one is the only BNB Chain source.
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.protocol, "erc8004_bsc"));
      expect(await registry.readBscRegistryProfile()).toBeNull();
      const source = await newSource();
      await seed(source, [draft(1), draft(2)]);
      // Active and partly read: the stored count is a partial read of the chain, so nothing is public yet.
      await registry.refreshAgentRegistryListing(source, { classify: true, publish: false });
      // What the module says now, not the cached copy a refresh has only marked stale.
      invalidateDirectoryReads();
      expect(await registry.readBscRegistryProfile()).toBeNull();
      // A walk that reached the head publishes, and the profile appears once the cached copy reloads.
      await registry.refreshAgentRegistryListing(source, { classify: true, publish: true });
      const first = await eventually(() => registry.readBscRegistryProfile(), profile => profile !== null);
      expect(first).toMatchObject({ recorded: 2, listed: 2 });
      await seed(source, [draft(3, { listing: 0 })]);
      // Cached: the new row is not visible until a refresh has marked the cache stale and it has reloaded.
      expect(await registry.readBscRegistryProfile()).toMatchObject({ recorded: 2 });
      await registry.refreshAgentRegistryListing(source, { classify: true, publish: true });
      expect(await registry.readBscRegistryProfile()).toMatchObject({ recorded: 2 });
      expect(await eventually(() => registry.readBscRegistryProfile(), profile => profile?.recorded === 3)).toMatchObject({ recorded: 3, listed: 2, withoutProfileLink: 1 });
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, source.id));
      await registry.refreshAgentRegistryListing(source, { classify: false, publish: false });
      expect(await eventually(() => registry.readBscRegistryProfile(), profile => profile === null)).toBeNull();
    });

    it("lists a shared link in the profile only when it reaches the published bar", async () => {
      const source = await newSource();
      const pair = sha("pair-for-the-profile");
      await seed(source, [draft(1, { profileUriHash: pair, locatorHost: "pair-profile.example.net" }), draft(2, { profileUriHash: pair, locatorHost: "pair-profile.example.net" })]);
      await classify(source);
      expect((await registry.readAgentRegistryProfile(source.id, RULES)).sharedProfileGroups).toEqual([{ label: "pair-profile.example.net", registrations: 2 }]);
      expect((await registry.readAgentRegistryProfile(source.id, { ...RULES, sharedProfileLinkFrom: 3 })).sharedProfileGroups).toEqual([]);
    });

    it("cleans a self-asserted name before it labels a shared link on a public surface", async () => {
      const source = await newSource();
      const link = sha("spoof-link");
      const spoofed = `Official\u202E Agent\u200B ${"x".repeat(200)}`;
      await seed(source, [draft(1, { profileUriHash: link, displayName: spoofed }), draft(2, { profileUriHash: link, displayName: spoofed })]);
      await classify(source);
      const [group] = (await registry.readAgentRegistryProfile(source.id, RULES)).sharedProfileGroups;
      expect(group!.label).not.toMatch(/[\u202A-\u202E\u200B-\u200D\u2060\uFEFF]/);
      expect(group!.label.startsWith("Official Agent ")).toBe(true);
      expect(group!.label.length).toBeLessThanOrEqual(80);
    });

    it("counts a mixed result list correctly: registry-wide for the BNB Chain entry, live for the entry of another protocol", async () => {
      const bnb = await newSource();
      const other = await newSource("active", "erc8004");
      const wallet = "0x" + "7".repeat(40);
      await seed(bnb, [
        draft(1, { registrant: wallet, displayName: "Mixedbatch Subject" }),
        draft(2, { registrant: wallet, listing: 0 }),
        draft(3, { registrant: wallet, listing: 0 }),
      ]);
      await registry.refreshAgentRegistryListing(bnb, { classify: true, publish: true });
      await writer.insert(schema.agentDirectoryEntries).values({
        id: "mixed-batch-other",
        sourceId: other.id,
        externalKey: "mixed:1",
        displayName: "Mixedbatch Other",
        protocol: "erc8004",
        registrant: wallet,
      });
      const hits = (await db.searchAgentDirectory({ query: "Mixedbatch", limit: 25 })).entries;
      const bnbHit = hits.find(hit => hit.displayName === "Mixedbatch Subject")!;
      const otherHit = hits.find(hit => hit.displayName === "Mixedbatch Other")!;
      // The BNB Chain entry's wallet has two more registrations, both held out: they count. The other protocol's entry
      // counts directory entries only, and the one it shares the wallet with is the listed BNB Chain entry.
      expect(bnbHit.related).toEqual({ sameWallet: 2, sameName: 0, sameHost: 0 });
      expect(otherHit.related).toEqual({ sameWallet: 1, sameName: 0, sameHost: 0 });
    });

    it("counts an entry's wallet and host look-alikes over the whole registry, held-out registrations included", async () => {
      const source = await newSource();
      const wallet = "0x" + "9".repeat(40);
      await seed(source, [
        draft(1, { registrant: wallet, locatorHost: "shared.example.net", displayName: "Lookalike Subject" }),
        draft(2, { registrant: wallet, locatorHost: "shared.example.net", listing: 0 }),
        draft(3, { locatorHost: "shared.example.net" }),
      ]);
      await registry.refreshAgentRegistryListing(source, { classify: true, publish: true });
      const entry = (await entryOf(source, 1))!;
      const detail = (await db.getAgentDirectoryEntry(entry.id))!;
      // One other registration from this wallet (held out, so not in the directory) and two others on this host.
      expect(detail.related).toEqual({ sameWallet: 1, sameName: 0, sameHost: 2 });
      const searched = (await db.searchAgentDirectory({ query: "Lookalike", limit: 25 })).entries.find(item => item.id === entry.id)!;
      expect(searched.related).toEqual({ sameWallet: 1, sameName: 0, sameHost: 2 });
      expect("sourceId" in searched).toBe(false);
    });
  });

  describe("the public procedures", { timeout: 60_000 }, () => {
    it("serves the BNB Chain profile only once a walk has published, and counts a BNB Chain mint in the funnel", async () => {
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.protocol, "erc8004_bsc"));
      const { appRouter } = await import("./routers");
      const caller = appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
      const funnelMint = async () => (await caller.liveData.directoryFunnel()).steps.find(step => step.key === "withMintMeasured")?.value;

      const source = await newSource();
      await seed(source, [draft(1), draft(2)]);
      await writer
        .update(schema.agentDirectoryRegistryRows)
        .set({ mintBlock: 79_700_000 })
        .where(and(eq(schema.agentDirectoryRegistryRows.sourceId, source.id), eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(1))));
      // Read but not published: the profile is withheld and the funnel counts nothing from this source.
      await registry.refreshAgentRegistryListing(source, { classify: true, publish: false });
      // What the procedures say now, not the cached copies a refresh has only marked stale.
      invalidateDirectoryReads();
      expect(await caller.liveData.directoryBscRegistry()).toEqual({ profile: null });
      expect(await funnelMint()).toBe(0);
      // Published: the profile is served once the cached copy reloads, and the entry with a measured mint is one step of the funnel.
      await registry.refreshAgentRegistryListing(source, { classify: true, publish: true });
      const served = await eventually(() => caller.liveData.directoryBscRegistry(), result => result.profile !== null);
      expect(served.profile).toMatchObject({ recorded: 2, listed: 2, published: 2 });
      expect(await eventually(funnelMint, mint => mint === 1)).toBe(1);
    });
  });

  describe("the published rules", () => {
    it("are the numbers measured against the real registry on 2026-10-13", () => {
      expect(registry.BSC_LISTING_RULES).toEqual({ sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 });
    });

    it("keep a wallet below the threshold and a host below the threshold listed, and group each at its threshold", async () => {
      const source = await newSource();
      const wallet = "0x" + "f".repeat(40);
      const rows = Array.from({ length: 9 }, (_, index) => draft(index + 1, { registrant: wallet }));
      await seed(source, rows);
      await registry.classifyAgentRegistryListing(source.id);
      expect(await listingOf(source, 1, 5, 9)).toEqual([LISTED, LISTED, LISTED]);
      await seed(source, [draft(10, { registrant: wallet })]);
      await registry.classifyAgentRegistryListing(source.id);
      expect(await listingOf(source, 1, 5, 9, 10)).toEqual([GROUPED, GROUPED, GROUPED, GROUPED]);
    });

    it("group a host at 50 registrations and not at 49", async () => {
      const source = await newSource();
      await seed(source, Array.from({ length: 49 }, (_, index) => draft(index + 1, { locatorHost: "tenants.example.com" })));
      await registry.classifyAgentRegistryListing(source.id);
      expect(await listingOf(source, 1, 49)).toEqual([LISTED, LISTED]);
      await seed(source, [draft(50, { locatorHost: "tenants.example.com" })]);
      await registry.classifyAgentRegistryListing(source.id);
      expect(await listingOf(source, 1, 49, 50)).toEqual([GROUPED, GROUPED, GROUPED]);
    });
  });
});
