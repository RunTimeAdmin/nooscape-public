import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import { ChainUnavailableError, type EvmCall } from "./claimsChain";
import { personalMessageHash } from "./claimsCrypto";
import { testWallet } from "./claimsTestKit";
import type { TrpcContext } from "./_core/context";

/** Who the router takes to be the operator: nobody, until a test says so. */
const operatorSession = vi.hoisted(() => ({ current: null as { id: number } | null }));
vi.mock("./operatorAuth", async importOriginal => ({ ...(await importOriginal<typeof import("./operatorAuth")>()), getAuthenticatedOperator: async () => operatorSession.current }));

/**
 * "Claim this agent" against a real database, with real wallet signatures and a fake chain (docs/claims-2026-10-18.md): the message a
 * wallet is asked to sign, every way a claim or an edit can be refused, the owner being asked at the claim and on every edit, a
 * contract wallet, a change of owner, the fleet rule, the limits, the operator's hold, the daily check, a nonce used twice at once,
 * and the tables missing. Skips when no database is reachable. The signature maths is in claimsCrypto.test.ts.
 */
const TEST_DB = "nooscape_claims_test";
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

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ALICE = testWallet("0x0123456789012345678901234567890123456789012345678901234567890123");
const BOB = testWallet("0x1111111111111111111111111111111111111111111111111111111111111111");
const CAROL = testWallet("0x2222222222222222222222222222222222222222222222222222222222222222");
const FLEETER = testWallet("0x3333333333333333333333333333333333333333333333333333333333333333");
const SIGNER = testWallet("0x4444444444444444444444444444444444444444444444444444444444444444");
/** A contract wallet (a Safe, say): an address with code, whose own signer is SIGNER. */
const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe";
const MAGIC = `0x1626ba7e${"0".repeat(56)}`;

describe.skipIf(!dbReachable)("claim this agent against a real database", { timeout: 120_000 }, () => {
  let claims: typeof import("./claims");
  let rateLimit: typeof import("./rateLimit");
  let appRouter: typeof import("./routers").appRouter;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  let pasteMigration: () => Promise<void>;
  let n = 0;

  // The fake chain: who owns each token, which addresses hold code, and which contract wallets accept which signatures.
  const owners = new Map<string, string>();
  const code = new Set<string>();
  const accepts = new Map<string, (hash: string, signature: string) => boolean>();
  let chainDown = false;
  /** Chains whose node is down while the others answer: a read on one of them cannot be answered. */
  const downChains = new Set<number>();
  /** One wrong answer to the next ownerOf, as a lagging node or a provider's blip gives; then the chain tells the truth again. */
  let wrongOnce: { token: string; owner: string } | null = null;
  /** Every ownerOf answers "0x", as a node with no code at the registry does. */
  let emptyAnswers = false;
  /** Something that happens the moment the next ownerOf is asked: an operator's hold landing mid-request. */
  let during: (() => Promise<void>) | null = null;
  let calls: Array<{ chainId: number; method: string }> = [];
  const call: EvmCall = async (chainId, method, params) => {
    if (chainDown || downChains.has(chainId)) throw new ChainUnavailableError();
    calls.push({ chainId, method });
    if (method === "eth_getCode") return { revert: false, result: code.has(`${chainId}:${String(params[0]).toLowerCase()}`) ? "0x6080" : "0x" };
    const { to, data } = params[0] as { to: string; data: string };
    if (data.startsWith("0x6352211e")) {
      if (during) {
        const run = during;
        during = null;
        await run();
      }
      if (emptyAnswers) return { revert: false, result: "0x" };
      const token = `${chainId}:${BigInt(`0x${data.slice(10)}`).toString()}`;
      if (wrongOnce && wrongOnce.token === token) {
        const wrong = wrongOnce.owner;
        wrongOnce = null;
        return { revert: false, result: `0x${"0".repeat(24)}${wrong.slice(2)}` };
      }
      const owner = owners.get(token);
      return owner ? { revert: false, result: `0x${"0".repeat(24)}${owner.slice(2)}` } : { revert: true };
    }
    if (data.startsWith("0x1626ba7e")) {
      const hash = `0x${data.slice(10, 74)}`;
      const length = parseInt(data.slice(138, 202), 16);
      const signature = `0x${data.slice(202, 202 + length * 2)}`;
      const accepted = accepts.get(`${chainId}:${to.toLowerCase()}`)?.(hash, signature) ?? false;
      return { revert: false, result: accepted ? MAGIC : `0x${"0".repeat(64)}` };
    }
    return { revert: true };
  };
  let clock = new Date("2026-10-18T20:00:00Z");
  let nonces = 0;
  const deps = () => ({ call, now: () => clock, newNonce: () => `a1b2c3d4e5f6${String(++nonces).padStart(8, "0")}` });
  const later = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };

  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused" = "active") {
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `claims-${id}`, label: id, protocol, rootUrl: "https://claims.example/feed", allowedHostname: "claims.example", state, createdByUserId: operatorUserId });
  }
  /** An entry on a registry with an owner on the fake chain, and the wallet the directory recorded for it. */
  async function entry(sourceId: string, protocol: "erc8004" | "erc8004_bsc" | "erc8004_arc" | "solana_8004", chainId: number, token: number, owner: string | null, registrant: string | null = owner, extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) {
    n += 1;
    const id = `claim-entry-${n}`;
    const externalKey = protocol === "solana_8004" ? `solana-asset-${n}` : `eip155:${chainId}:${REGISTRY}:${token}`;
    await writer.insert(schema.agentDirectoryEntries).values({ id, sourceId, externalKey, displayName: `Entry ${n}`, protocol, registrant, ...extra });
    if (owner) owners.set(`${chainId}:${token}`, owner);
    return id;
  }

  const request = (entryId: string, wallet: string, action: "claim" | "edit" = "claim", edit?: Record<string, unknown>, clientKey?: string) => claims.issueClaimRequest({ entryId, wallet, action, edit, clientKey }, deps());
  const code_ = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      if (error instanceof claims.ClaimError) return error.code;
      throw error;
    }
    return "ok";
  };
  /** Asks for the message, has the wallet sign it, and makes the claim. */
  async function claimAs(wallet: typeof ALICE, entryId: string) {
    const issued = await request(entryId, wallet.address);
    return claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature: wallet.sign(issued.message) }, deps());
  }
  /** The same for one edit. */
  async function editAs(wallet: typeof ALICE, entryId: string, edit: Record<string, unknown>) {
    const issued = await request(entryId, wallet.address, "edit", edit);
    later(11);
    return claims.verifyAndEdit({ nonce: issued.nonce, message: issued.message, signature: wallet.sign(issued.message), edit }, { ...deps(), now: () => new Date(clock.getTime() - 10 * 60_000) });
  }
  const history = (entryId: string) => writer.select().from(schema.agentClaimEdits).where(eq(schema.agentClaimEdits.entryId, entryId)).orderBy(asc(schema.agentClaimEdits.seq));
  const claimOf = async (entryId: string, status = "active") => (await writer.select().from(schema.agentClaims).where(and(eq(schema.agentClaims.entryId, entryId), eq(schema.agentClaims.status, status))))[0];

  /** The daily check until nothing is left due (a run takes at most 25 claims), with what it did added up. */
  async function daily() {
    const total = { checked: 0, revoked: 0, unavailable: 0 };
    for (let run = 0; run < 20; run += 1) {
      const result = await claims.recheckClaims(deps());
      total.checked += result.checked;
      total.revoked += result.revoked;
      total.unavailable += result.unavailable;
      if (result.checked === 0 || result.stoppedBy === "chain") break;
    }
    return total;
  }

  let robinhoodEntry: string;
  let bnbEntry: string;

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baseline = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baseline.query(statement);
    }
    await baseline.end();
    await applyPendingMigrations(process.env.DATABASE_URL);
    // Migration 0046 is manual too: it adds Arc's protocol to the four tables.
    const arcMigration = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await arcMigration.query(statement);
    await arcMigration.end();
    // The claim tables are a manual migration, so a boot does not make them: run the file as the owner would paste it.
    pasteMigration = async () => {
      const paste = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0042_agent_claims.sql", "utf8"))) await paste.query(statement);
      await paste.end();
    };
    claims = await import("./claims");
    rateLimit = await import("./rateLimit");
    appRouter = (await import("./routers")).appRouter;
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "claims-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "claims-operator"));
    operatorUserId = operator!.id;
    await source("src-rh", "erc8004");
    await source("src-bnb", "erc8004_bsc");
    await source("src-sol", "solana_8004");
    await source("src-paused", "erc8004", "paused");
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  beforeEach(() => {
    rateLimit.resetRateLimits();
    chainDown = false;
    downChains.clear();
    wrongOnce = null;
    emptyAnswers = false;
    during = null;
    calls = [];
  });

  it("answers that claims are not available while the tables are missing, and asks no chain", async () => {
    robinhoodEntry = await entry("src-rh", "erc8004", 4663, 7, ALICE.address);
    bnbEntry = await entry("src-bnb", "erc8004_bsc", 56, 12, BOB.address);
    expect(await code_(() => request(robinhoodEntry, ALICE.address))).toBe("UNAVAILABLE");
    expect(await code_(() => claims.verifyAndClaim({ nonce: "a1b2c3d4e5f600000001", message: "x", signature: "0x00" }, deps()))).toBe("UNAVAILABLE");
    // The daily check does nothing and says nothing: it never throws, and it asks no chain.
    const logged = (console.error as unknown as { mock?: unknown }).mock;
    expect(await claims.recheckClaims(deps())).toEqual({ checked: 0, revoked: 0, unavailable: 0, stoppedBy: "done" });
    expect(calls).toEqual([]);
    expect(logged).toBeUndefined();
    // What the page asks first: not available while the tables are missing, and still says an entry that the flow does not cover is not claimable.
    expect(await claims.readClaimState(robinhoodEntry)).toEqual({ available: false, claimable: true, claim: null });
    expect(await claims.readClaimState("no-such-entry")).toEqual({ available: true, claimable: false, claim: null });
    expect(await claims.readClaimHistory(robinhoodEntry)).toEqual({ available: false, claimable: true, items: [], truncated: false });
    expect(await code_(() => claims.listClaimsForOperator(robinhoodEntry))).toBe("UNAVAILABLE");
    expect(await code_(() => claims.removeClaimText("any-claim", ["name"], "owner"))).toBe("UNAVAILABLE");
    await pasteMigration();
  });

  it("will not issue a message for an entry that cannot be claimed: another protocol, another chain's key, an unknown id, a hidden entry or an unapproved source", async () => {
    const solana = await entry("src-sol", "solana_8004", 0, 0, null, ALICE.address);
    const wrongChain = await entry("src-rh", "erc8004", 4663, 8, ALICE.address, ALICE.address, { externalKey: `eip155:1:${REGISTRY}:8` });
    const wrongRegistry = await entry("src-rh", "erc8004", 4663, 9, ALICE.address, ALICE.address, { externalKey: `eip155:4663:0x${"1".repeat(40)}:9` });
    const hidden = await entry("src-rh", "erc8004", 4663, 10, ALICE.address, ALICE.address, { hidden: true });
    const paused = await entry("src-paused", "erc8004", 4663, 11, ALICE.address);
    for (const id of [solana, wrongChain, wrongRegistry, hidden, paused, "no-such-entry"]) {
      rateLimit.resetRateLimits();
      expect(await code_(() => request(id, ALICE.address)), id).toBe("NOT_CLAIMABLE");
    }
    rateLimit.resetRateLimits();
    expect(await code_(() => request(robinhoodEntry, "not-an-address"))).toBe("BAD_REQUEST");
    expect(await code_(() => request(robinhoodEntry, ALICE.address, "edit", { name: "x" }))).toBe("NO_CLAIM");
    expect(await writer.select().from(schema.agentClaimNonces)).toEqual([]);
  });

  it("issues the sign-in message with everything it binds, and keeps only the hash of the nonce", async () => {
    const issued = await request(robinhoodEntry, ALICE.address);
    expect(issued.message.split("\n")).toEqual([
      "nooscape.si wants you to sign in with your Ethereum account:",
      ALICE.checksum,
      "",
      "Claim this agent on Nooscape. This only proves you own the wallet. No transaction, no gas, no approval.",
      "",
      `URI: https://nooscape.si/agents/${robinhoodEntry}`,
      "Version: 1",
      "Chain ID: 4663",
      `Nonce: ${issued.nonce}`,
      "Issued At: 2026-10-18T20:00:00.000Z",
      "Expiration Time: 2026-10-18T20:10:00.000Z",
      "Resources:",
      `- eip155:4663:${REGISTRY}:7`,
    ]);
    const rows = await writer.select().from(schema.agentClaimNonces).where(eq(schema.agentClaimNonces.entryId, robinhoodEntry));
    expect(rows).toHaveLength(1);
    // The times are unix seconds, so no session time zone can change the text the message is rebuilt from.
    expect(rows[0]).toMatchObject({ nonceHash: sha256(issued.nonce), action: "claim", wallet: ALICE.address, chainId: 4663, editText: null, issuedAt: Date.parse("2026-10-18T20:00:00Z") / 1000, expiresAt: Date.parse("2026-10-18T20:10:00Z") / 1000, usedAt: null, outcome: null });
    expect(JSON.stringify(rows)).not.toContain(issued.nonce);
    // No chain is asked to issue a message.
    expect(calls).toEqual([]);
  });

  it("refuses a message that is not exactly the one issued, a signature that is not the wallet's, a used or an expired nonce, and the wrong action", async () => {
    const issued = await request(robinhoodEntry, ALICE.address);
    const good = ALICE.sign(issued.message);
    const verify = (overrides: Partial<{ nonce: string; message: string; signature: string }>, at = clock) => claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature: good, ...overrides }, { ...deps(), now: () => at });
    expect(await code_(() => verify({ message: issued.message.replace("Chain ID: 4663", "Chain ID: 56") }))).toBe("NONCE");
    expect(await code_(() => verify({ message: `${issued.message} ` }))).toBe("NONCE");
    expect(await code_(() => verify({ nonce: "a1b2c3d4e5f6ffffffff" }))).toBe("NONCE");
    expect(await code_(() => verify({ nonce: "short" }))).toBe("NONCE");
    expect(await code_(() => verify({}, new Date(clock.getTime() + 11 * 60_000)))).toBe("NONCE");
    // A claim nonce cannot be spent as an edit.
    expect(await code_(() => claims.verifyAndEdit({ nonce: issued.nonce, message: issued.message, signature: good, edit: { name: "x" } }, deps()))).toBe("NONCE");
    // None of that spent the nonce: a message that is not the one issued is not an attempt to use it.
    expect((await writer.select().from(schema.agentClaimNonces).where(eq(schema.agentClaimNonces.nonceHash, sha256(issued.nonce))))[0]!.usedAt).toBeNull();
    // A signature from another wallet, from the same wallet over other text, and two that are not signatures at all. Each is the caller's
    // doing, so each spends its nonce: a second try with the same message is refused, and a new message is needed.
    for (const sign of [(message: string) => BOB.sign(message), (message: string) => ALICE.sign(`${message}!`), () => "0x1234", () => `0x${"0".repeat(130)}`]) {
      rateLimit.resetRateLimits();
      const fresh = await request(robinhoodEntry, ALICE.address);
      const attempt = { nonce: fresh.nonce, message: fresh.message, signature: sign(fresh.message) };
      expect(await code_(() => claims.verifyAndClaim(attempt, deps()))).toBe("BAD_SIGNATURE");
      expect(await code_(() => claims.verifyAndClaim({ ...attempt, signature: ALICE.sign(fresh.message) }, deps()))).toBe("NONCE");
      expect((await writer.select().from(schema.agentClaimNonces).where(eq(schema.agentClaimNonces.nonceHash, sha256(fresh.nonce))))[0]).toMatchObject({ outcome: "refused" });
    }
    // The first nonce is still good, and nothing was claimed.
    expect(await writer.select().from(schema.agentClaims)).toEqual([]);
    expect(await claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature: good }, deps())).toMatchObject({ status: "active" });
    // Put the entry back as the next tests expect it.
    await writer.delete(schema.agentClaims).where(eq(schema.agentClaims.entryId, robinhoodEntry));
    await writer.delete(schema.agentClaimEdits).where(eq(schema.agentClaimEdits.entryId, robinhoodEntry));
  });

  it("refuses a signature that is the high-s twin of a good one", async () => {
    const issued = await request(robinhoodEntry, ALICE.address);
    const good = ALICE.sign(issued.message);
    const n = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const twin = `0x${good.slice(2, 66)}${(n - BigInt(`0x${good.slice(66, 130)}`)).toString(16).padStart(64, "0")}${(parseInt(good.slice(130), 16) === 27 ? 28 : 27).toString(16)}`;
    expect(await code_(() => claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature: twin }, deps()))).toBe("BAD_SIGNATURE");
  });

  it("asks the registry who owns the agent, refuses a wallet that does not and spends that nonce, and does not spend one on a chain it could not read", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 20, CAROL.address);
    const verify = (issued: { nonce: string; message: string }, wallet: typeof ALICE) => claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature: wallet.sign(issued.message) }, deps());
    // The directory recorded Carol, the chain says Carol: Alice signs for it and is refused, and her nonce is spent.
    const asAlice = await request(entryId, ALICE.address);
    expect(await code_(() => verify(asAlice, ALICE))).toBe("NOT_OWNER");
    expect(await code_(() => verify(asAlice, ALICE))).toBe("NONCE");
    // A token the registry does not know (the call reverts) has no owner.
    owners.delete("4663:20");
    const unknown = await request(entryId, CAROL.address);
    expect(await code_(() => verify(unknown, CAROL))).toBe("NOT_OWNER");
    // The chain is down: try again later, and the nonce is still good. An empty answer is an outage too, not a token that is gone.
    owners.set("4663:20", CAROL.address);
    const asCarol = await request(entryId, CAROL.address);
    chainDown = true;
    expect(await code_(() => verify(asCarol, CAROL))).toBe("CHAIN_UNAVAILABLE");
    chainDown = false;
    emptyAnswers = true;
    expect(await code_(() => verify(asCarol, CAROL))).toBe("CHAIN_UNAVAILABLE");
    emptyAnswers = false;
    expect(await verify(asCarol, CAROL)).toMatchObject({ status: "active", wallet: CAROL.address });
    expect(calls.some(entry => entry.method === "eth_call" && entry.chainId === 4663)).toBe(true);
  });

  it("makes a claim for the owner, with the history row, the digest of the signature and the owner asked once", async () => {
    const issued = await request(robinhoodEntry, ALICE.address);
    const signature = ALICE.sign(issued.message);
    calls = [];
    const result = await claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature }, deps());
    expect(result).toMatchObject({ status: "active", wallet: ALICE.address });
    expect(calls).toEqual([{ chainId: 4663, method: "eth_call" }]);
    const claim = (await claimOf(robinhoodEntry))!;
    expect(claim).toMatchObject({ entryId: robinhoodEntry, inForceEntryId: robinhoodEntry, protocol: "erc8004", chainId: 4663, registry: REGISTRY, tokenId: "7", wallet: ALICE.address, status: "active", signatureDigest: sha256(signature), name: null, website: null, description: null, links: null });
    expect(await history(robinhoodEntry)).toMatchObject([{ kind: "claim", wallet: ALICE.address, signatureDigest: sha256(signature), field: null, reason: null }]);
    // The nonce is spent: the same message and signature cannot make another claim, or the same one twice.
    expect(await code_(() => claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature }, deps()))).toBe("NONCE");
    // The owner asking again is told it is claimed, and no new message is issued.
    expect(await code_(() => request(robinhoodEntry, ALICE.address))).toBe("ALREADY_CLAIMED");
  });

  it("tells the page whether an entry can be claimed and what claim is in force, never a signature, and nothing for one that is revoked", async () => {
    const solana = await entry("src-sol", "solana_8004", 0, 0, null, ALICE.address);
    const hidden = await entry("src-rh", "erc8004", 4663, 12, ALICE.address, ALICE.address, { hidden: true });
    expect(await claims.readClaimState(solana)).toEqual({ available: true, claimable: false, claim: null });
    expect(await claims.readClaimState(hidden)).toEqual({ available: true, claimable: false, claim: null });
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 13, BOB.address);
    expect(await claims.readClaimState(entryId)).toEqual({ available: true, claimable: true, claim: null });
    const made = await claimAs(BOB, entryId);
    await editAs(BOB, entryId, { name: "Bob Agent", links: ["https://example.org/docs"] });
    const state = await claims.readClaimState(entryId);
    expect(state).toMatchObject({ available: true, claimable: true, claim: { status: "active", wallet: BOB.address, profile: { name: "Bob Agent", website: null, description: null, links: ["https://example.org/docs"] } } });
    expect(Object.keys(state.claim!).sort()).toEqual(["claimedAt", "lastOwnerCheckAt", "profile", "status", "wallet"]);
    expect(JSON.stringify(state)).not.toMatch(/signatureDigest|nonce/i);
    await claims.setClaimHeld(made.claimId, true, clock);
    expect((await claims.readClaimState(entryId)).claim).toMatchObject({ status: "frozen", wallet: BOB.address });
    await claims.setClaimHeld(made.claimId, false, clock);
    // A claim that was revoked is not in force: the entry reads as unclaimed.
    owners.set("56:13", CAROL.address);
    await claimAs(CAROL, entryId);
    expect((await claims.readClaimState(entryId)).claim).toMatchObject({ wallet: CAROL.address, profile: { name: null, links: [] } });
  });

  it("lets only one of two claims made at the same moment through", async () => {
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 30, BOB.address);
    const issued = await request(entryId, BOB.address);
    const signature = BOB.sign(issued.message);
    const outcomes = await Promise.allSettled([claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature }, deps()), claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature }, deps())]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await writer.select().from(schema.agentClaims).where(eq(schema.agentClaims.entryId, entryId))).toHaveLength(1);
    expect((await history(entryId)).filter(row => row.kind === "claim")).toHaveLength(1);
  });

  it("refuses a fleet: a wallet listed for 50 registrations here cannot claim one agent, and 49 can", async () => {
    const make = async (wallet: typeof ALICE, count: number, firstToken: number) => {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) ids.push(await entry("src-rh", "erc8004", 4663, firstToken + index, wallet.address));
      return ids[0]!;
    };
    const fleetEntry = await make(FLEETER, 50, 1000);
    expect(await code_(() => request(fleetEntry, FLEETER.address))).toBe("FLEET");
    const smallEntry = await make(SIGNER, 49, 2000);
    expect(await code_(() => request(smallEntry, SIGNER.address))).toBe("ok");
  });

  it("counts the wallet an entry was registered by, so an agent moved out of a fleet to a fresh wallet is still a fleet's, and caps the claims one wallet holds", async () => {
    // Carol registered 50 and moved one of them to Bob, who registered nothing. The directory still records Carol; the chain says Bob.
    const ids: string[] = [];
    for (let index = 0; index < 50; index += 1) ids.push(await entry("src-rh", "erc8004", 4663, 3000 + index, CAROL.address));
    owners.set("4663:3000", BOB.address);
    expect(await code_(() => request(ids[0]!, BOB.address))).toBe("FLEET");
    // A wallet that already holds 50 claims in force is a fleet too, whatever the directory lists for it.
    const holder = testWallet("0x7777777777777777777777777777777777777777777777777777777777777777");
    for (let index = 0; index < 50; index += 1) {
      const held = await entry("src-bnb", "erc8004_bsc", 56, 4000 + index, holder.address, null);
      await writer.insert(schema.agentClaims).values({ id: `held-${index}`, entryId: held, inForceEntryId: held, protocol: "erc8004_bsc", chainId: 56, registry: REGISTRY, tokenId: String(4000 + index), wallet: holder.address, status: "active", claimedAt: clock, statusChangedAt: clock, lastOwnerCheckAt: clock, signatureDigest: "0".repeat(64) });
    }
    const fifty1 = await entry("src-bnb", "erc8004_bsc", 56, 4050, holder.address, null);
    expect(await code_(() => request(fifty1, holder.address))).toBe("FLEET");
  });

  it("accepts a contract wallet that its own signer controls (EIP-1271), and refuses one that does not, a plain wallet and a counterfactual signature", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 40, SAFE, SAFE);
    code.add(`4663:${SAFE}`);
    // The safe accepts what its signer signed over the hash of the message.
    accepts.set(`4663:${SAFE}`, (hash, signature) => signature === SIGNER.signHash(Uint8Array.from(Buffer.from(hash.slice(2), "hex"))));
    // A signature from the wrong key and a counterfactual one each spend their own message; the right one claims.
    const wrong = await request(entryId, SAFE);
    expect(await code_(() => claims.verifyAndClaim({ nonce: wrong.nonce, message: wrong.message, signature: ALICE.sign(wrong.message) }, deps()))).toBe("BAD_SIGNATURE");
    const counterfactual = await request(entryId, SAFE);
    expect(await code_(() => claims.verifyAndClaim({ nonce: counterfactual.nonce, message: counterfactual.message, signature: `0x${"ab".repeat(10)}${"6492".repeat(16)}` }, deps()))).toBe("COUNTERFACTUAL");
    const issued = await request(entryId, SAFE);
    expect(issued.message).toContain(`\n0x`);
    const bySigner = SIGNER.signHash(personalMessageHash(issued.message));
    expect(await claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature: bySigner }, deps())).toMatchObject({ status: "active", wallet: SAFE });
    // An address with no code cannot sign by contract, however its signature looks.
    const plain = await entry("src-rh", "erc8004", 4663, 41, "0x6666666666666666666666666666666666666666");
    const asked = await request(plain, "0x6666666666666666666666666666666666666666");
    expect(await code_(() => claims.verifyAndClaim({ nonce: asked.nonce, message: asked.message, signature: SIGNER.sign(asked.message) }, deps()))).toBe("BAD_SIGNATURE");
  });

  it("applies a signed edit to the fields it names, logs each old and new value with the signature's digest, and leaves the rest", async () => {
    const edit = { name: "Alice Agent", website: "https://example.org/agent#top", links: ["https://example.org/docs", "https://example.org/docs", "https://github.com/alice/agent"] };
    const result = await editAs(ALICE, robinhoodEntry, edit);
    expect(result.changed).toBe(3);
    expect(await claimOf(robinhoodEntry)).toMatchObject({ name: "Alice Agent", website: "https://example.org/agent", description: null, links: JSON.stringify(["https://example.org/docs", "https://github.com/alice/agent"]) });
    const rows = (await history(robinhoodEntry)).filter(row => row.kind === "edit");
    expect(rows.map(row => [row.field, row.oldValue, row.newValue])).toEqual([
      ["name", null, "Alice Agent"],
      ["website", null, "https://example.org/agent"],
      ["links", null, JSON.stringify(["https://example.org/docs", "https://github.com/alice/agent"])],
    ]);
    for (const row of rows) expect(row).toMatchObject({ wallet: ALICE.address });
    expect(new Set(rows.map(row => row.signatureDigest)).size).toBe(1);
    // A second edit changes one field, logs the old value, and clearing a field is an edit too.
    const second = await editAs(ALICE, robinhoodEntry, { name: "Alice Agent v2", website: null });
    expect(second.changed).toBe(2);
    const after = (await history(robinhoodEntry)).filter(row => row.kind === "edit").slice(3);
    expect(after.map(row => [row.field, row.oldValue, row.newValue])).toEqual([
      ["name", "Alice Agent", "Alice Agent v2"],
      ["website", "https://example.org/agent", null],
    ]);
    // An edit that changes nothing writes nothing.
    const same = await editAs(ALICE, robinhoodEntry, { name: "Alice Agent v2" });
    expect(same.changed).toBe(0);
    expect((await history(robinhoodEntry)).filter(row => row.kind === "edit")).toHaveLength(5);
  });

  it("refuses an edit that is not valid before it issues a message, and one that is not the edit the owner signed", async () => {
    for (const [edit, field] of [
      [{ website: "http://example.org" }, "website"],
      [{ website: "https://localhost/x" }, "website"],
      [{ website: "https://10.0.0.1/x" }, "website"],
      [{ website: "https://user:pw@example.org/" }, "website"],
      [{ links: ["https://example.org", "javascript:alert(1)"] }, "links"],
      [{ links: Array.from({ length: 6 }, (_, index) => `https://example.org/${index}`) }, "links"],
      [{ name: "x".repeat(121) }, "name"],
      [{ description: "x".repeat(1001) }, "description"],
    ] as const) {
      try {
        await request(robinhoodEntry, ALICE.address, "edit", edit);
        throw new Error(`accepted ${JSON.stringify(edit)}`);
      } catch (error) {
        expect(error, JSON.stringify(edit)).toBeInstanceOf(claims.ClaimError);
        expect((error as InstanceType<typeof claims.ClaimError>).code).toBe("INVALID_EDIT");
        expect((error as InstanceType<typeof claims.ClaimError>).field).toBe(field);
      }
    }
    expect(await code_(() => request(robinhoodEntry, ALICE.address, "edit", {}))).toBe("INVALID_EDIT");
    // The message shows the edit itself, so a wallet shows what the owner is signing for, and the nonce for one edit cannot be spent on another.
    later(11);
    const issued = await request(robinhoodEntry, ALICE.address, "edit", { description: "what I signed" });
    expect(issued.message).toContain('Changes: {"description":"what I signed"}');
    expect(await code_(() => claims.verifyAndEdit({ nonce: issued.nonce, message: issued.message, signature: ALICE.sign(issued.message), edit: { description: "something else" } }, deps()))).toBe("NONCE");
    expect((await claimOf(robinhoodEntry))!.description).toBeNull();
    // A stranger can ask for the message for the claimant's wallet, but cannot hide what it says: the website and the links are in it.
    const phishing = await request(robinhoodEntry, ALICE.address, "edit", { website: "https://phish.example/", links: ["https://phish.example/pay"] }, "stranger");
    expect(phishing.message).toContain('"website":"https://phish.example/"');
    expect(phishing.message).toContain('"links":["https://phish.example/pay"]');
  });

  it("keeps text safe for public pages: control and invisible characters are cleaned out of what an owner writes", async () => {
    await editAs(ALICE, robinhoodEntry, { description: "  Fast\u0000 ‮agent​  " });
    expect((await claimOf(robinhoodEntry))!.description).toBe("Fast agent");
  });

  it("refuses an edit from anyone who is not the claimant, and an edit from a wallet that has no claim", async () => {
    expect(await code_(() => request(robinhoodEntry, BOB.address, "edit", { name: "mine now" }))).toBe("NO_CLAIM");
    expect(await code_(() => request(bnbEntry, ALICE.address, "edit", { name: "x" }))).toBe("NO_CLAIM");
  });

  it("stops at 20 edits an agent a day, counted before any chain is asked", async () => {
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 50, BOB.address);
    await claimAs(BOB, entryId);
    for (let index = 0; index < 20; index += 1) await editAs(BOB, entryId, { name: `Name ${index}` });
    calls = [];
    later(11);
    expect(await code_(() => request(entryId, BOB.address, "edit", { name: "one too many" }))).toBe("TOO_MANY_EDITS");
    expect(calls).toEqual([]);
    // A day later the count has run out of window.
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    expect(await code_(() => request(entryId, BOB.address, "edit", { name: "next day" }))).toBe("ok");
  });

  it("limits the messages one client may ask for one wallet to five in ten minutes, and requests from one client to twenty", async () => {
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 60, CAROL.address);
    for (let index = 0; index < 5; index += 1) await request(entryId, CAROL.address, "claim", undefined, "client-a");
    expect(await code_(() => request(entryId, CAROL.address, "claim", undefined, "client-a"))).toBe("RATE_LIMITED");
    later(11);
    expect(await code_(() => request(entryId, CAROL.address, "claim", undefined, "client-a"))).toBe("ok");
    for (let index = 0; index < 20; index += 1) claims.limitClient("203.0.113.7");
    expect(() => claims.limitClient("203.0.113.7")).toThrow(/Too many requests/);
    expect(() => claims.limitClient("203.0.113.8")).not.toThrow();
  });

  it("never lets a stranger spend an owner's allowance: someone who names a wallet uses only their own, and an entry that is not there costs nothing", async () => {
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 61, CAROL.address);
    // A stranger asks as often as they are allowed for messages for Carol's wallet, and for an entry that does not exist.
    for (let index = 0; index < 5; index += 1) await request(entryId, CAROL.address, "claim", undefined, "stranger");
    expect(await code_(() => request(entryId, CAROL.address, "claim", undefined, "stranger"))).toBe("RATE_LIMITED");
    for (let index = 0; index < 20; index += 1) expect(await code_(() => request("no-such-entry", CAROL.address, "claim", undefined, "stranger"))).toBe("NOT_CLAIMABLE");
    // Carol, from her own client, is not held up at all.
    for (let index = 0; index < 5; index += 1) expect(await code_(() => request(entryId, CAROL.address, "claim", undefined, "carol"))).toBe("ok");
  });

  it("does not count an edit that was refused against the 20 a day, so a stranger cannot use up an owner's edits", async () => {
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 62, BOB.address);
    await claimAs(BOB, entryId);
    // Twenty messages for edits are asked and spent on bad signatures, as a stranger would do with the claimant's wallet.
    for (let index = 0; index < 20; index += 1) {
      later(11);
      const issued = await request(entryId, BOB.address, "edit", { name: `Edit ${index}` }, "stranger");
      expect(await code_(() => claims.verifyAndEdit({ nonce: issued.nonce, message: issued.message, signature: ALICE.sign(issued.message), edit: { name: `Edit ${index}` } }, deps()))).toBe("BAD_SIGNATURE");
    }
    // The owner's own edit still goes through.
    expect((await editAs(BOB, entryId, { name: "Mine" })).changed).toBe(1);
  });

  it("revokes the claim when the registry says the agent changed hands: the edit is refused, the history says so, and the new owner may claim", async () => {
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 70, BOB.address);
    await claimAs(BOB, entryId);
    await editAs(BOB, entryId, { name: "Bob Agent" });
    // The agent is sold to Alice.
    owners.set("56:70", ALICE.address);
    const issued = await request(entryId, BOB.address, "edit", { name: "Still Bob" });
    later(11);
    expect(await code_(() => claims.verifyAndEdit({ nonce: issued.nonce, message: issued.message, signature: BOB.sign(issued.message), edit: { name: "Still Bob" } }, { ...deps(), now: () => new Date(clock.getTime() - 10 * 60_000) }))).toBe("OWNER_CHANGED");
    expect(await claimOf(entryId)).toBeUndefined();
    const revoked = (await claimOf(entryId, "revoked"))!;
    expect(revoked).toMatchObject({ inForceEntryId: null, wallet: BOB.address, name: "Bob Agent" });
    expect((await history(entryId)).filter(row => row.kind === "revoke")).toMatchObject([{ reason: "owner_changed", wallet: ALICE.address }]);
    // The new owner claims fresh: a new claim, with none of the old profile.
    await claimAs(ALICE, entryId);
    expect(await claimOf(entryId)).toMatchObject({ wallet: ALICE.address, name: null });
    expect(await writer.select().from(schema.agentClaims).where(eq(schema.agentClaims.entryId, entryId))).toHaveLength(2);
  });

  it("ends the old claim at once when the new owner claims before any edit or daily check noticed", async () => {
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 80, BOB.address);
    await claimAs(BOB, entryId);
    owners.set("56:80", CAROL.address);
    await claimAs(CAROL, entryId);
    expect(await claimOf(entryId)).toMatchObject({ wallet: CAROL.address });
    expect((await claimOf(entryId, "revoked"))!.wallet).toBe(BOB.address);
    expect((await history(entryId)).map(row => row.kind)).toEqual(["claim", "revoke", "claim"]);
  });

  it("lets the operator hold a claim, which stops its edits and any other claim, and take the hold off", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 90, ALICE.address);
    await claimAs(ALICE, entryId);
    const claim = (await claimOf(entryId))!;
    expect(await claims.setClaimHeld(claim.id, true, clock)).toEqual({ status: "frozen" });
    expect(await code_(() => request(entryId, ALICE.address, "edit", { name: "x" }))).toBe("FROZEN");
    owners.set("4663:90", CAROL.address);
    expect(await code_(() => request(entryId, CAROL.address))).toBe("FROZEN");
    owners.set("4663:90", ALICE.address);
    expect(await claims.setClaimHeld(claim.id, false, clock)).toEqual({ status: "active" });
    expect(await code_(() => request(entryId, ALICE.address, "edit", { name: "x" }))).toBe("ok");
    expect((await history(entryId)).map(row => row.kind)).toEqual(["claim", "freeze", "unfreeze"]);
    expect(await code_(() => claims.setClaimHeld("no-such-claim", true))).toBe("NO_CLAIM");
  });

  it("treats two messages for the same owner, signed one after the other, as one claim, and still stops an edit when the hold came after the message was issued", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 95, ALICE.address);
    const first = await request(entryId, ALICE.address);
    const second = await request(entryId, ALICE.address);
    const made = await claims.verifyAndClaim({ nonce: first.nonce, message: first.message, signature: ALICE.sign(first.message) }, deps());
    const again = await claims.verifyAndClaim({ nonce: second.nonce, message: second.message, signature: ALICE.sign(second.message) }, deps());
    expect(again.claimId).toBe(made.claimId);
    expect((await history(entryId)).map(row => row.kind)).toEqual(["claim"]);
    expect(await writer.select().from(schema.agentClaims).where(eq(schema.agentClaims.entryId, entryId))).toHaveLength(1);
    // A message for an edit was issued; the operator then put the claim on hold. The edit is refused, and nothing is written.
    const edit = { name: "too late" };
    const issued = await request(entryId, ALICE.address, "edit", edit);
    await claims.setClaimHeld(made.claimId, true, clock);
    expect(await code_(() => claims.verifyAndEdit({ nonce: issued.nonce, message: issued.message, signature: ALICE.sign(issued.message), edit }, deps()))).toBe("FROZEN");
    expect((await claimOf(entryId, "frozen"))!.name).toBeNull();
    await claims.setClaimHeld(made.claimId, false, clock);
  });

  it("does not end a claim on one wrong answer: when the first answer is not the claimant the registry is asked again, and only two agreeing answers revoke", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 110, ALICE.address);
    await claimAs(ALICE, entryId);
    // One blip on an edit: the first answer says Bob, the second says Alice, and the edit goes through.
    wrongOnce = { token: "4663:110", owner: BOB.address };
    expect((await editAs(ALICE, entryId, { name: "Still mine" })).changed).toBe(1);
    expect(await claimOf(entryId)).toMatchObject({ wallet: ALICE.address, name: "Still mine" });
    // The same in the daily check.
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    wrongOnce = { token: "4663:110", owner: BOB.address };
    expect(await daily()).toMatchObject({ revoked: 0 });
    expect(wrongOnce).toBeNull();
    expect(await claimOf(entryId)).toMatchObject({ wallet: ALICE.address });
    // Two answers that agree are an answer: the agent is Bob's now.
    owners.set("4663:110", BOB.address);
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    expect((await daily()).revoked).toBe(1);
    expect(await claimOf(entryId)).toBeUndefined();
  });

  it("takes an empty answer from the registry for an outage on an edit and in the daily check, and the claim stays", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 111, ALICE.address);
    await claimAs(ALICE, entryId);
    emptyAnswers = true;
    const issued = await request(entryId, ALICE.address, "edit", { name: "x" });
    expect(await code_(() => claims.verifyAndEdit({ nonce: issued.nonce, message: issued.message, signature: ALICE.sign(issued.message), edit: { name: "x" } }, deps()))).toBe("CHAIN_UNAVAILABLE");
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    // Every chain answers "0x" here, so each chain with a claim due is found unreadable, and none of them is asked about again in the run.
    const run = await claims.recheckClaims(deps());
    expect(run).toMatchObject({ checked: 0, revoked: 0, stoppedBy: "chain" });
    expect(run.unavailable).toBeGreaterThanOrEqual(1);
    expect(await claimOf(entryId)).toMatchObject({ wallet: ALICE.address });
    // The nonce was not spent by an outage.
    expect((await writer.select().from(schema.agentClaimNonces).where(eq(schema.agentClaimNonces.nonceHash, sha256(issued.nonce))))[0]!.usedAt).toBeNull();
  });

  it("refuses an edit when an operator's hold lands while the registry is being asked: nothing is written and the nonce is not used", async () => {
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 112, BOB.address);
    const made = await claimAs(BOB, entryId);
    const edit = { name: "too late" };
    const issued = await request(entryId, BOB.address, "edit", edit);
    during = async () => {
      await claims.setClaimHeld(made.claimId, true, clock);
    };
    expect(await code_(() => claims.verifyAndEdit({ nonce: issued.nonce, message: issued.message, signature: BOB.sign(issued.message), edit }, deps()))).toBe("NO_CLAIM");
    expect((await claimOf(entryId, "frozen"))!.name).toBeNull();
    expect((await history(entryId)).map(row => row.kind)).toEqual(["claim", "freeze"]);
    expect((await writer.select().from(schema.agentClaimNonces).where(eq(schema.agentClaimNonces.nonceHash, sha256(issued.nonce))))[0]!.usedAt).toBeNull();
    await claims.setClaimHeld(made.claimId, false, clock);
  });

  it("sweeps nonce rows two days after they expire, in the daily check, and keeps the rest", async () => {
    const entryId = await entry("src-bnb", "erc8004_bsc", 56, 113, BOB.address);
    const base = Math.floor(clock.getTime() / 1000);
    const row = (id: string, expiresAt: number) => ({ id, nonceHash: sha256(id), action: "claim", entryId, wallet: BOB.address, chainId: 56, issuedAt: expiresAt - 600, expiresAt });
    await writer.insert(schema.agentClaimNonces).values([row("sweep-old", base - 3 * 86_400), row("sweep-recent", base - 86_400), row("sweep-live", base + 600)]);
    await claims.recheckClaims(deps());
    const left = (await writer.select({ id: schema.agentClaimNonces.id }).from(schema.agentClaimNonces).where(eq(schema.agentClaimNonces.entryId, entryId))).map(found => found.id).sort();
    expect(left).toEqual(["sweep-live", "sweep-recent"]);
  });

  it("writes no log line that names a wallet, whatever happens", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map(method => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))));
    try {
      const entryId = await entry("src-rh", "erc8004", 4663, 114, ALICE.address);
      const issued = await request(entryId, ALICE.address);
      await code_(() => claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature: BOB.sign(issued.message) }, deps()));
      await claimAs(ALICE, entryId);
      await editAs(ALICE, entryId, { name: "logged?" });
      chainDown = true;
      clock = new Date(clock.getTime() + 24 * 3_600_000);
      await claims.recheckClaims(deps());
      chainDown = false;
      await code_(() => claims.verifyAndClaim({ nonce: "zzzzzzzzzz", message: "x", signature: "0x00" }, deps()));
      for (let index = 0; index < 25; index += 1) await code_(async () => claims.limitClient('203.0.113.99'));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    for (const line of lines) {
      for (const wallet of [ALICE.address, ALICE.checksum, BOB.address, BOB.checksum]) expect(line.toLowerCase(), line).not.toContain(wallet.toLowerCase());
    }
  });

  it("checks each claimed agent's owner once a day, revokes the ones that changed hands, leaves the rest, and stops when the chain is down", async () => {
    const stays = await entry("src-rh", "erc8004", 4663, 100, ALICE.address);
    const moves = await entry("src-rh", "erc8004", 4663, 101, BOB.address);
    const gone = await entry("src-bnb", "erc8004_bsc", 56, 102, CAROL.address);
    await claimAs(ALICE, stays);
    await claimAs(BOB, moves);
    await claimAs(CAROL, gone);
    // Claims made earlier in this file have fallen due as the clock moved on: settle them first, so what follows is these three alone.
    await daily();
    // Nothing is due for 23 hours.
    calls = [];
    expect(await claims.recheckClaims(deps())).toEqual({ checked: 0, revoked: 0, unavailable: 0, stoppedBy: "done" });
    expect(calls).toEqual([]);
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    owners.set("4663:101", ALICE.address);
    owners.delete("56:102");
    chainDown = true;
    // Every chain is down, so each chain with a claim due is found unreadable and nothing is asked about again in the run.
    const down = await claims.recheckClaims(deps());
    expect(down).toMatchObject({ checked: 0, stoppedBy: "chain" });
    expect(down.unavailable).toBeGreaterThanOrEqual(1);
    expect(await claimOf(moves)).toBeDefined();
    chainDown = false;
    expect(await daily()).toMatchObject({ revoked: 2 });
    expect(await claimOf(stays)).toMatchObject({ wallet: ALICE.address, lastOwnerCheckAt: clock });
    expect(await claimOf(moves)).toBeUndefined();
    expect(await claimOf(gone)).toBeUndefined();
    expect((await history(moves)).filter(row => row.kind === "revoke")).toMatchObject([{ reason: "owner_changed", wallet: ALICE.address }]);
    expect((await history(gone)).filter(row => row.kind === "revoke")).toMatchObject([{ reason: "token_gone", wallet: null }]);
    // Asked again, nothing is due.
    calls = [];
    expect(await claims.recheckClaims(deps())).toMatchObject({ checked: 0 });
    expect(calls).toEqual([]);
  });

  it("shows the history of an entry's claims, newest first: each claim and edit with its text, signer and digest, a hold, and an end with no wallet on it", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 401, ALICE.address);
    await claimAs(ALICE, entryId);
    await editAs(ALICE, entryId, { name: "One", website: "https://one.example/" });
    const made = (await claimOf(entryId))!;
    await claims.setClaimHeld(made.id, true, clock);
    await claims.setClaimHeld(made.id, false, clock);
    owners.set("4663:401", BOB.address);
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    expect((await daily()).revoked).toBe(1);
    const shown = await claims.readClaimHistory(entryId);
    expect(shown).toMatchObject({ available: true, claimable: true, truncated: false });
    expect(shown.items.map(item => item.kind).sort()).toEqual(["claim", "edit", "edit", "freeze", "revoke", "unfreeze"]);
    expect(shown.items.map(item => item.seq)).toEqual([...shown.items.map(item => item.seq)].sort((a, b) => b - a));
    expect(shown.items[0]).toMatchObject({ kind: "revoke", reason: "owner_changed", wallet: null, signatureDigest: null, withheld: false });
    expect(shown.items.find(item => item.kind === "freeze")).toMatchObject({ reason: "operator", wallet: null, signatureDigest: null });
    expect(shown.items.find(item => item.kind === "edit" && item.field === "name")).toMatchObject({ oldValue: null, newValue: "One", withheld: false, wallet: ALICE.address });
    expect(shown.items.find(item => item.kind === "edit" && item.field === "website")).toMatchObject({ newValue: "https://one.example/" });
    expect(shown.items.find(item => item.kind === "claim")).toMatchObject({ wallet: ALICE.address });
    for (const item of shown.items.filter(found => found.kind === "claim" || found.kind === "edit")) expect(item.signatureDigest).toMatch(/^[0-9a-f]{64}$/);
    // Nothing else of a row leaves the server: no id, no claim id, no entry id, no signature.
    for (const item of shown.items) expect(Object.keys(item).sort()).toEqual(["field", "kind", "newValue", "occurredAt", "oldValue", "reason", "seq", "signatureDigest", "wallet", "withheld"]);
    // An entry the flow does not cover has no history to show, and a hidden one is not covered.
    expect(await claims.readClaimHistory("no-such-entry")).toEqual({ available: true, claimable: false, items: [], truncated: false });
  });

  it("removes text from view without changing the history: the field is cleared, earlier edits show only that a change was made, later edits show their text", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 402, ALICE.address);
    await claimAs(ALICE, entryId);
    await editAs(ALICE, entryId, { name: "Bad name", description: "Keep this" });
    const made = (await claimOf(entryId))!;
    const before = await history(entryId);
    expect(await claims.removeClaimText(made.id, ["name"], "owner", clock)).toEqual({ removed: ["name"] });
    expect((await claims.readClaimState(entryId)).claim!.profile).toEqual({ name: null, website: null, description: "Keep this", links: [] });
    let shown = await claims.readClaimHistory(entryId);
    expect(shown.items[0]).toMatchObject({ kind: "redact", field: "name", reason: "owner_request", wallet: null, signatureDigest: null });
    expect(shown.items.find(item => item.kind === "edit" && item.field === "name")).toMatchObject({ withheld: true, oldValue: null, newValue: null });
    expect(shown.items.find(item => item.kind === "edit" && item.field === "description")).toMatchObject({ withheld: false, newValue: "Keep this" });
    // The private record is whole: every row is as it was, and the text is still in it.
    const after = await history(entryId);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.find(row => row.kind === "edit" && row.field === "name")).toMatchObject({ newValue: "Bad name" });
    // What the owner writes afterwards is a later row, and it shows.
    await editAs(ALICE, entryId, { name: "Good name" });
    shown = await claims.readClaimHistory(entryId);
    expect(shown.items.find(item => item.kind === "edit" && item.newValue === "Good name")).toMatchObject({ withheld: false });
    expect(shown.items.filter(item => item.kind === "edit" && item.field === "name" && item.withheld)).toHaveLength(1);
    // Every field when none is named, a claim that is not there, and nothing named.
    expect(await claims.removeClaimText(made.id, ["name", "website", "description", "links"], "nooscape", clock)).toEqual({ removed: ["name", "website", "description", "links"] });
    // Who asked is the only thing the history says about a removal: here the owner for the name, then Nooscape for the rest.
    expect((await claims.readClaimHistory(entryId)).items.filter(item => item.kind === "redact").map(item => [item.field, item.reason]).sort()).toEqual([["description", "nooscape"], ["links", "nooscape"], ["name", "nooscape"], ["name", "owner_request"], ["website", "nooscape"]]);
    expect((await claims.readClaimState(entryId)).claim!.profile).toEqual({ name: null, website: null, description: null, links: [] });
    expect((await claims.readClaimHistory(entryId)).items.filter(item => item.kind === "edit").every(item => item.withheld)).toBe(true);
    expect(await code_(() => claims.removeClaimText("no-such-claim", ["name"], "owner"))).toBe("NO_CLAIM");
    expect(await code_(() => claims.removeClaimText(made.id, [], "owner"))).toBe("BAD_REQUEST");
  });

  it("removes the text of a claim that has ended, by its id, and the new owner's claim is untouched", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 403, ALICE.address);
    await claimAs(ALICE, entryId);
    await editAs(ALICE, entryId, { name: "Old owner's name" });
    const old = (await claimOf(entryId))!;
    owners.set("4663:403", BOB.address);
    await claimAs(BOB, entryId);
    await editAs(BOB, entryId, { name: "New owner's name" });
    expect((await claimOf(entryId, "revoked"))!.id).toBe(old.id);
    expect(await claims.removeClaimText(old.id, ["name"], "nooscape", clock)).toEqual({ removed: ["name"] });
    expect((await claimOf(entryId, "revoked"))!.name).toBeNull();
    expect((await claims.readClaimState(entryId)).claim!.profile.name).toBe("New owner's name");
    const items = (await claims.readClaimHistory(entryId)).items;
    expect(items.find(item => item.kind === "edit" && item.wallet === ALICE.address)).toMatchObject({ withheld: true, newValue: null });
    expect(items.find(item => item.kind === "edit" && item.wallet === BOB.address)).toMatchObject({ withheld: false, newValue: "New owner's name" });
  });

  it("shows no text while a claim is on hold, in the state or in the history, and the text is back when the hold is lifted", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 404, ALICE.address);
    await claimAs(ALICE, entryId);
    await editAs(ALICE, entryId, { name: "Mine", links: ["https://a.example/"] });
    const made = (await claimOf(entryId))!;
    await claims.setClaimHeld(made.id, true, clock);
    expect((await claims.readClaimState(entryId)).claim).toMatchObject({ status: "frozen", profile: { name: null, website: null, description: null, links: [] } });
    const held = (await claims.readClaimHistory(entryId)).items.filter(item => item.kind === "edit");
    expect(held).toHaveLength(2);
    expect(held.every(item => item.withheld && item.oldValue === null && item.newValue === null)).toBe(true);
    // The table keeps the text.
    expect(await claimOf(entryId, "frozen")).toMatchObject({ name: "Mine" });
    await claims.setClaimHeld(made.id, false, clock);
    expect((await claims.readClaimState(entryId)).claim!.profile).toEqual({ name: "Mine", website: null, description: null, links: ["https://a.example/"] });
    expect((await claims.readClaimHistory(entryId)).items.filter(item => item.kind === "edit").every(item => !item.withheld)).toBe(true);
  });

  it("returns the newest hundred rows of a long history and says there are more", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 405, ALICE.address);
    await claimAs(ALICE, entryId);
    const made = (await claimOf(entryId))!;
    await writer.insert(schema.agentClaimEdits).values(Array.from({ length: 105 }, (_, index) => ({ id: `long-${entryId}-${index}`, claimId: made.id, entryId, kind: "freeze", reason: "operator", occurredAt: clock })));
    const shown = await claims.readClaimHistory(entryId);
    expect(shown.items).toHaveLength(claims.CLAIM_HISTORY_LIMIT);
    expect(shown.truncated).toBe(true);
    const all = await history(entryId);
    expect(shown.items[0]!.seq).toBe(all[all.length - 1]!.seq);
  });

  it("answers the history through the router to anyone, and keeps the operator's lookup and removal to the operator", async () => {
    const entryId = await entry("src-rh", "erc8004", 4663, 406, ALICE.address);
    await claimAs(ALICE, entryId);
    await editAs(ALICE, entryId, { name: "Router name" });
    const made = (await claimOf(entryId))!;
    const caller = () => appRouter.createCaller({ req: { ip: "198.51.100.30", headers: {} }, res: {}, user: null } as unknown as TrpcContext);
    expect((await caller().claim.history({ entryId })).items.map(item => item.kind)).toEqual(["edit", "claim"]);
    await expect(caller().claim.history({ entryId, extra: 1 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Closed to the public.
    await expect(caller().claim.operatorClaims({ entryId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller().claim.removeText({ claimId: made.id, fields: ["name"], by: "nooscape" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect((await claimOf(entryId))!.name).toBe("Router name");
    // Open to the operator, and strict: a field the flow does not own is refused before it reaches the claim code.
    operatorSession.current = { id: operatorUserId };
    try {
      const listed = await caller().claim.operatorClaims({ entryId });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: made.id, status: "active", wallet: ALICE.address, profile: { name: "Router name" } });
      await expect(caller().claim.removeText({ claimId: made.id, fields: ["evidenceTier"], by: "owner" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller().claim.removeText({ claimId: made.id, fields: [], by: "owner" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller().claim.removeText({ claimId: made.id, fields: ["name"] } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller().claim.removeText({ claimId: made.id, fields: ["name"], by: "the owner, probably" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await caller().claim.removeText({ claimId: made.id, fields: ["name"], by: "owner" })).toEqual({ removed: ["name"] });
      await expect(caller().claim.removeText({ claimId: "no-such-claim", fields: ["name"], by: "owner" })).rejects.toMatchObject({ code: "NOT_FOUND", message: claims.CLAIM_MESSAGES.NO_CLAIM });
    } finally {
      operatorSession.current = null;
    }
    expect((await claimOf(entryId))!.name).toBeNull();
  });

  it("is the router's to answer: a strict edit refuses a field the flow does not own, the operator's hold is closed to the public, and each call is counted", async () => {
    const caller = (address?: string) => appRouter.createCaller({ req: { ip: address, headers: {} }, res: {}, user: null } as unknown as TrpcContext);
    const tier = caller("198.51.100.1").claim.nonce({ entryId: robinhoodEntry, wallet: ALICE.address, action: "edit", edit: { name: "x", evidenceTier: "tier_4" } as never });
    await expect(tier).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("198.51.100.1").claim.nonce({ entryId: robinhoodEntry, wallet: ALICE.address, action: "claim", extra: 1 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Nothing the schema refused reached the claim code: no message was issued for either.
    expect((await writer.select().from(schema.agentClaimNonces).where(eq(schema.agentClaimNonces.entryId, robinhoodEntry))).filter(found => found.editText?.includes("evidenceTier"))).toEqual([]);
    await expect(caller("198.51.100.1").claim.freeze({ claimId: "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller("198.51.100.1").claim.unfreeze({ claimId: "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // A wrong thing is answered with the fixed text and the right code.
    await expect(caller("198.51.100.2").claim.verify({ nonce: "a1b2c3d4e5f6aaaaaaaa", message: "x", signature: "0x1234" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: claims.CLAIM_MESSAGES.NONCE });
    await expect(caller("198.51.100.2").claim.nonce({ entryId: "nope", wallet: ALICE.address, action: "claim" })).rejects.toMatchObject({ code: "NOT_FOUND", message: claims.CLAIM_MESSAGES.NOT_CLAIMABLE });
    // The twenty-first call from one client in ten minutes is refused before it does any work.
    for (let index = 0; index < 18; index += 1) await caller("198.51.100.2").claim.verify({ nonce: "a1b2c3d4e5f6aaaaaaaa", message: "x", signature: "0x1234" }).catch(() => {});
    await expect(caller("198.51.100.2").claim.verify({ nonce: "a1b2c3d4e5f6aaaaaaaa", message: "x", signature: "0x1234" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  describe("an agent on Arc (docs/arc-claims-2026-10-20.md)", () => {
    const ARC_ON = "chain_arc,claims_arc";
    /** A wallet no other test has used, so it holds no claims and is no fleet. */
    const ERIN = testWallet("0x5555555555555555555555555555555555555555555555555555555555555555");
    let arcEntry: string;
    /** Runs a step with the switches as the list says, and puts them back. */
    async function withFeatures<T>(list: string | undefined, run: () => Promise<T>): Promise<T> {
      const saved = process.env.VITE_FEATURES;
      if (list === undefined) delete process.env.VITE_FEATURES;
      else process.env.VITE_FEATURES = list;
      try {
        return await run();
      } finally {
        if (saved === undefined) delete process.env.VITE_FEATURES;
        else process.env.VITE_FEATURES = saved;
      }
    }

    it("cannot be claimed until Arc's claims are on, whatever else is, and the words for an entry that cannot be claimed name the registries that can", async () => {
      await source("src-arc", "erc8004_arc");
      arcEntry = await entry("src-arc", "erc8004_arc", 5042, 21, ALICE.address);
      // Off, or only part of the way on: Arc's page can be on, and the panel too, and an Arc agent still cannot be claimed.
      for (const list of [undefined, "claims", "chain_arc", "claims_arc", "claims,chain_arc", "claims,claims_arc"]) {
        await withFeatures(list, async () => {
          rateLimit.resetRateLimits();
          expect(await code_(() => request(arcEntry, ALICE.address)), String(list)).toBe("NOT_CLAIMABLE");
          expect(await claims.readClaimState(arcEntry), String(list)).toEqual({ available: true, claimable: false, claim: null });
        });
      }
      expect(await writer.select().from(schema.agentClaimNonces).where(eq(schema.agentClaimNonces.entryId, arcEntry))).toEqual([]);
      // The refusal says which registries can be claimed on: the two it always named, and Arc once its claims are on.
      const solana = await entry("src-sol", "solana_8004", 0, 0, null, ALICE.address);
      const refusal = (list: string | undefined) =>
        withFeatures(list, async () => {
          rateLimit.resetRateLimits();
          try {
            await request(solana, ALICE.address);
          } catch (error) {
            return (error as Error).message;
          }
          return "claimable";
        });
      expect(await refusal(undefined)).toBe(claims.CLAIM_MESSAGES.NOT_CLAIMABLE);
      expect(await refusal(ARC_ON)).toBe("This entry cannot be claimed. Only agents on the Robinhood Chain, BNB Smart Chain and Arc registries can.");
    });

    it("is claimed as the others are: Arc's chain id and registry are in the message, the registry is asked on Arc, and the page is told it can be claimed", async () => {
      await withFeatures(ARC_ON, async () => {
        const issued = await request(arcEntry, ALICE.address);
        const lines = issued.message.split("\n");
        expect(lines).toContain("Chain ID: 5042");
        expect(lines).toContain(`- eip155:5042:${REGISTRY}:21`);
        expect(lines).toContain(`URI: https://nooscape.si/agents/${arcEntry}`);
        const made = await claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature: ALICE.sign(issued.message) }, deps());
        expect(made).toMatchObject({ status: "active", wallet: ALICE.address });
        expect(await claimOf(arcEntry)).toMatchObject({ protocol: "erc8004_arc", chainId: 5042, registry: REGISTRY, tokenId: "21", wallet: ALICE.address });
        // Every read of the chain was on Arc.
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(call => call.chainId === 5042)).toBe(true);
        expect(await claims.readClaimState(arcEntry)).toMatchObject({ available: true, claimable: true, claim: { status: "active", wallet: ALICE.address } });
        expect((await history(arcEntry)).map(row => row.kind)).toEqual(["claim"]);
      });
    });

    it("is refused to a wallet that Arc's registry does not record as the owner, and takes an edit from the owner, asking Arc each time", async () => {
      await withFeatures(ARC_ON, async () => {
        const other = await entry("src-arc", "erc8004_arc", 5042, 22, BOB.address);
        const issued = await request(other, ALICE.address);
        expect(await code_(() => claims.verifyAndClaim({ nonce: issued.nonce, message: issued.message, signature: ALICE.sign(issued.message) }, deps()))).toBe("NOT_OWNER");
        expect(await claimOf(other)).toBeUndefined();
        calls = [];
        expect((await editAs(ALICE, arcEntry, { name: "Arc agent" })).changed).toBe(1);
        expect(await claimOf(arcEntry)).toMatchObject({ name: "Arc agent" });
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(call => call.chainId === 5042)).toBe(true);
      });
    });

    it("is not claimed on an Arc registration that is held out: an entry the public cannot see has no claim", async () => {
      await withFeatures(ARC_ON, async () => {
        const hidden = await entry("src-arc", "erc8004_arc", 5042, 24, ALICE.address, ALICE.address, { hidden: true });
        expect(await code_(() => request(hidden, ALICE.address))).toBe("NOT_CLAIMABLE");
        const wrongRegistry = await entry("src-arc", "erc8004_arc", 5042, 25, ALICE.address, ALICE.address, { externalKey: `eip155:5042:0x${"1".repeat(40)}:25` });
        rateLimit.resetRateLimits();
        expect(await code_(() => request(wrongRegistry, ALICE.address))).toBe("NOT_CLAIMABLE");
        const wrongChain = await entry("src-arc", "erc8004_arc", 5042, 26, ALICE.address, ALICE.address, { externalKey: `eip155:1:${REGISTRY}:26` });
        rateLimit.resetRateLimits();
        expect(await code_(() => request(wrongChain, ALICE.address))).toBe("NOT_CLAIMABLE");
      });
    });

    it("is ended by the daily check when Arc shows a new owner, and a claim on a chain whose claims are off is neither asked about nor given the place of one that can be", async () => {
      // Arc's owner has changed, and a claim on Robinhood Chain is due as well. Arc's claim is the oldest.
      owners.set("5042:21", BOB.address);
      const robinhood = await entry("src-rh", "erc8004", 4663, 23, ERIN.address);
      await claimAs(ERIN, robinhood);
      clock = new Date(clock.getTime() + 24 * 3_600_000);
      await writer.update(schema.agentClaims).set({ lastOwnerCheckAt: new Date("2000-01-01T00:00:00Z") }).where(eq(schema.agentClaims.entryId, arcEntry));
      // Claims off: the check takes one claim that can be checked, and does not ask Arc about Arc's.
      await withFeatures(undefined, async () => {
        const result = await claims.recheckClaims(deps(), 1);
        expect(result.checked).toBe(1);
        expect(calls.some(call => call.chainId === 5042)).toBe(false);
      });
      expect(await claimOf(arcEntry)).toMatchObject({ wallet: ALICE.address });
      // Claims on: Arc's is the oldest, so it is the one checked, and the registry now says Bob.
      calls = [];
      await withFeatures(ARC_ON, async () => {
        expect(await claims.recheckClaims(deps(), 1)).toMatchObject({ checked: 1, revoked: 1 });
        expect(calls.every(call => call.chainId === 5042)).toBe(true);
      });
      expect(await claimOf(arcEntry)).toBeUndefined();
      const revoked = (await history(arcEntry)).at(-1)!;
      expect(revoked).toMatchObject({ kind: "revoke", reason: "owner_changed", wallet: BOB.address });
    });

    it("does not let a chain that cannot be read stop the daily check of the others: Arc's node is down and the Robinhood Chain claims behind Arc's are still asked about", async () => {
      const arcMine = await entry("src-arc", "erc8004_arc", 5042, 27, BOB.address);
      const rhMine = await entry("src-rh", "erc8004", 4663, 28, ERIN.address);
      await withFeatures(ARC_ON, async () => {
        await claimAs(BOB, arcMine);
      });
      await claimAs(ERIN, rhMine);
      clock = new Date(clock.getTime() + 24 * 3_600_000);
      // Arc's claim is the oldest that is due, as it would be after a few days of a node that is down, and the Robinhood Chain claim is the
      // oldest after it, so a run that stops at Arc's would not reach it.
      await writer.update(schema.agentClaims).set({ lastOwnerCheckAt: new Date("2000-01-01T00:00:00Z") }).where(eq(schema.agentClaims.entryId, arcMine));
      await writer.update(schema.agentClaims).set({ lastOwnerCheckAt: new Date("2001-01-01T00:00:00Z") }).where(eq(schema.agentClaims.entryId, rhMine));
      downChains.add(5042);
      try {
        await withFeatures(ARC_ON, async () => {
          calls = [];
          const run = await claims.recheckClaims(deps());
          expect(run).toMatchObject({ revoked: 0, stoppedBy: "chain", unavailable: 1 });
          // The claims on the other chains were asked about all the same, and Arc's node was asked once and then left alone for the run.
          expect(run.checked).toBeGreaterThanOrEqual(1);
          expect(calls.some(call => call.chainId === 4663)).toBe(true);
          expect(calls.filter(call => call.chainId === 5042)).toEqual([]);
        });
      } finally {
        downChains.clear();
      }
      // Arc's claim was left as it was, still the oldest and in force, and the Robinhood Chain claim was checked today.
      const arcRow = (await writer.select().from(schema.agentClaims).where(eq(schema.agentClaims.entryId, arcMine)))[0]!;
      expect(arcRow).toMatchObject({ status: "active", wallet: BOB.address });
      expect(arcRow.lastOwnerCheckAt.getTime()).toBe(Date.parse("2000-01-01T00:00:00Z"));
      const rhRow = (await writer.select().from(schema.agentClaims).where(eq(schema.agentClaims.entryId, rhMine)))[0]!;
      expect(rhRow.lastOwnerCheckAt.getTime()).toBe(Math.floor(clock.getTime() / 1000) * 1000);
      // With Arc's node back, its claim is the first one asked about and is found in order.
      await withFeatures(ARC_ON, async () => {
        expect(await claims.recheckClaims(deps(), 1)).toMatchObject({ checked: 1, revoked: 0, unavailable: 0, stoppedBy: "done" });
      });
      expect((await writer.select().from(schema.agentClaims).where(eq(schema.agentClaims.entryId, arcMine)))[0]!.lastOwnerCheckAt.getTime()).toBe(Math.floor(clock.getTime() / 1000) * 1000);
    });
  });
});
