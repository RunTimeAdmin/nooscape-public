import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { agentClaimEdits, agentDirectoryChainActivity, agentDirectoryEntries, agentReputationEvents, agentSolanaActivity } from "../drizzle/schema";
import { getDb, isHandoutEvent, listVisibleDirectoryKeys, requireDb, type DirectoryMintAnchor } from "./db";
import { evmIdentityChain } from "./ingestion/evmIdentityChains";

/**
 * Where the webhook pass reads what happened (docs/data-access-2026-10-19.md, stage D5): the claim history, the ownership ledgers, the
 * Robinhood rating ledger and the entries themselves. Every read is for the listings somebody watches, in chunks, so a pass costs what
 * the watches cost and not what the ledgers hold. Nothing here writes.
 */

export type WatchedEntry = { id: string; protocol: string; sourceId: string; externalKey: string; visible: boolean };

export type ClaimEditFact = { seq: number; entryId: string; kind: string; field: string | null; wallet: string | null; reason: string | null; occurredAt: Date };
export type TransferFact = { ref: string; entryId: string; from: string | null; to: string | null; blockNumber: number | null; transactionRef: string; isHandout: boolean; createdAt: Date };
/** A rating added or taken back. It says that, and when Nooscape recorded it: the public API gives counts and not the rating, who made it or where it is. */
export type RatingFact = { ref: string; entryId: string; kind: "added" | "revoked"; createdAt: Date };

/** What a read found, and whether it stopped at the limit (so there may be more). */
export type Found<T> = { rows: T[]; full: boolean };

export type EventSource = {
  entries: (ids: string[]) => Promise<WatchedEntry[]>;
  maxClaimSeq: () => Promise<number>;
  /** Claim history rows after a sequence number and not older than a date. The date keeps a re-read from reaching rows whose deliveries have been tidied away. */
  claimEdits: (afterSeq: number, entryIds: string[], since: Date) => Promise<Found<ClaimEditFact>>;
  /** Ownership changes recorded since a time, for entries on the EVM ledger or the Solana one. */
  transfers: (since: Date, entries: WatchedEntry[]) => Promise<Found<TransferFact>>;
  /** Ratings added or revoked since a time, for Robinhood entries. */
  ratings: (since: Date, entries: WatchedEntry[]) => Promise<Found<RatingFact>>;
};

/** Most rows one read returns. A read that comes back full says so, and the pass does not move its cursor past it. */
export const READ_LIMIT = 5_000;
const CHUNK = 200;

const chunks = <T>(items: T[], size = CHUNK): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const isEvm = (entry: WatchedEntry) => entry.externalKey.startsWith("eip155:");
const tokenIdOf = (entry: WatchedEntry) => Number(entry.externalKey.split(":")[3]);

export const dbEventSource: EventSource = {
  entries: async ids => {
    if (ids.length === 0) return [];
    const db = requireDb(await getDb());
    const found: Array<{ id: string; protocol: string; sourceId: string; externalKey: string }> = [];
    for (const part of chunks(ids)) {
      found.push(...(await db.select({ id: agentDirectoryEntries.id, protocol: agentDirectoryEntries.protocol, sourceId: agentDirectoryEntries.sourceId, externalKey: agentDirectoryEntries.externalKey }).from(agentDirectoryEntries).where(inArray(agentDirectoryEntries.id, part))));
    }
    const visible = new Set<string>();
    for (const part of chunks(found.map(entry => entry.id))) (await listVisibleDirectoryKeys(part)).forEach((_key, id) => visible.add(id));
    return found.map(entry => ({ ...entry, visible: visible.has(entry.id) }));
  },

  maxClaimSeq: async () => {
    const db = requireDb(await getDb());
    const [row] = await db.select({ top: sql<number | null>`max(${agentClaimEdits.seq})` }).from(agentClaimEdits);
    return Number(row?.top ?? 0);
  },

  claimEdits: async (afterSeq, entryIds, since) => {
    const db = requireDb(await getDb());
    const out: ClaimEditFact[] = [];
    let full = false;
    for (const part of chunks(entryIds)) {
      const rows = await db
        .select({ seq: agentClaimEdits.seq, entryId: agentClaimEdits.entryId, kind: agentClaimEdits.kind, field: agentClaimEdits.field, wallet: agentClaimEdits.wallet, reason: agentClaimEdits.reason, occurredAt: agentClaimEdits.occurredAt })
        .from(agentClaimEdits)
        .where(and(gt(agentClaimEdits.seq, afterSeq), gte(agentClaimEdits.occurredAt, since), inArray(agentClaimEdits.entryId, part)))
        .orderBy(asc(agentClaimEdits.seq))
        .limit(READ_LIMIT);
      full ||= rows.length >= READ_LIMIT;
      out.push(...rows.map(row => ({ ...row, seq: Number(row.seq) })));
    }
    return { rows: out, full };
  },

  transfers: async (since, entries) => {
    const db = requireDb(await getDb());
    const out: TransferFact[] = [];
    let full = false;
    const evm = entries.filter(isEvm);
    const solana = entries.filter(entry => !isEvm(entry));
    for (const part of chunks(evm)) {
      const byKey = new Map(part.map(entry => [`${entry.sourceId}\n${entry.externalKey}`, entry]));
      const keys = part.map(entry => entry.externalKey);
      const rows = await db
        .select({
          id: agentDirectoryChainActivity.id,
          sourceId: agentDirectoryChainActivity.sourceId,
          externalKey: agentDirectoryChainActivity.externalKey,
          kind: agentDirectoryChainActivity.kind,
          blockNumber: agentDirectoryChainActivity.blockNumber,
          transactionHash: agentDirectoryChainActivity.transactionHash,
          fromAddress: agentDirectoryChainActivity.fromAddress,
          toAddress: agentDirectoryChainActivity.toAddress,
          createdAt: agentDirectoryChainActivity.createdAt,
        })
        .from(agentDirectoryChainActivity)
        .where(and(inArray(agentDirectoryChainActivity.externalKey, keys), inArray(agentDirectoryChainActivity.kind, ["mint", "secondary"]), gte(agentDirectoryChainActivity.createdAt, since)))
        .limit(READ_LIMIT);
      full ||= rows.length >= READ_LIMIT;
      // The mint of each listing, which the hand-out rule measures from. It may be older than the window, so it is read on its own.
      const anchors = new Map<string, DirectoryMintAnchor>();
      const mints = await db
        .select({ sourceId: agentDirectoryChainActivity.sourceId, externalKey: agentDirectoryChainActivity.externalKey, block: sql<number | null>`min(${agentDirectoryChainActivity.blockNumber})`, to: sql<string | null>`min(${agentDirectoryChainActivity.toAddress})` })
        .from(agentDirectoryChainActivity)
        .where(and(inArray(agentDirectoryChainActivity.externalKey, keys), eq(agentDirectoryChainActivity.kind, "mint")))
        .groupBy(agentDirectoryChainActivity.sourceId, agentDirectoryChainActivity.externalKey);
      for (const mint of mints) anchors.set(`${mint.sourceId}\n${mint.externalKey}`, { sourceId: mint.sourceId, externalKey: mint.externalKey, anchorMintBlock: mint.block === null ? null : Number(mint.block), anchorMintTo: mint.to });
      for (const row of rows) {
        const entry = byKey.get(`${row.sourceId}\n${row.externalKey}`);
        if (!entry || row.kind !== "secondary") continue;
        out.push({
          ref: `own:${row.id}`,
          entryId: entry.id,
          from: row.fromAddress,
          to: row.toAddress,
          blockNumber: Number(row.blockNumber),
          transactionRef: row.transactionHash,
          // The mint hour is the chain's own number of blocks, from the table every block-measured rule reads.
          isHandout: isHandoutEvent("secondary", Number(row.blockNumber), row.fromAddress, anchors.get(`${row.sourceId}\n${row.externalKey}`), evmIdentityChain(entry.protocol)?.handoutBlockWindow),
          createdAt: row.createdAt,
        });
      }
    }
    for (const part of chunks(solana)) {
      const byKey = new Map(part.map(entry => [`${entry.sourceId}\n${entry.externalKey}`, entry]));
      const rows = await db
        .select({
          id: agentSolanaActivity.id,
          sourceId: agentSolanaActivity.sourceId,
          externalKey: agentSolanaActivity.externalKey,
          transactionSignature: agentSolanaActivity.transactionSignature,
          fromOwner: agentSolanaActivity.fromOwner,
          toOwner: agentSolanaActivity.toOwner,
          createdAt: agentSolanaActivity.createdAt,
        })
        .from(agentSolanaActivity)
        .where(and(inArray(agentSolanaActivity.externalKey, part.map(entry => entry.externalKey)), eq(agentSolanaActivity.kind, "transfer"), gte(agentSolanaActivity.createdAt, since)))
        .limit(READ_LIMIT);
      full ||= rows.length >= READ_LIMIT;
      for (const row of rows) {
        const entry = byKey.get(`${row.sourceId}\n${row.externalKey}`);
        if (entry) out.push({ ref: `own:${row.id}`, entryId: entry.id, from: row.fromOwner, to: row.toOwner, blockNumber: null, transactionRef: row.transactionSignature, isHandout: false, createdAt: row.createdAt });
      }
    }
    return { rows: out, full };
  },

  ratings: async (since, entries) => {
    const db = requireDb(await getDb());
    const out: RatingFact[] = [];
    let full = false;
    // Only the Robinhood registry's ratings are shown by the public API (as counts), so only they are told about. BNB ratings are internal evidence.
    const wanted = entries.filter(entry => entry.protocol === "erc8004" && isEvm(entry) && Number.isSafeInteger(tokenIdOf(entry)));
    for (const part of chunks(wanted)) {
      const byKey = new Map(part.map(entry => [`${entry.sourceId}\n${tokenIdOf(entry)}`, entry]));
      const rows = await db
        .select({
          id: agentReputationEvents.id,
          sourceId: agentReputationEvents.sourceId,
          agentId: agentReputationEvents.agentId,
          kind: agentReputationEvents.kind,
          createdAt: agentReputationEvents.createdAt,
        })
        .from(agentReputationEvents)
        .where(and(inArray(agentReputationEvents.agentId, part.map(tokenIdOf)), inArray(agentReputationEvents.kind, ["new_feedback", "feedback_revoked"]), gte(agentReputationEvents.createdAt, since)))
        .limit(READ_LIMIT);
      full ||= rows.length >= READ_LIMIT;
      for (const row of rows) {
        const entry = byKey.get(`${row.sourceId}\n${Number(row.agentId)}`);
        if (entry) out.push({ ref: `fb:${row.id}`, entryId: entry.id, kind: row.kind === "new_feedback" ? "added" : "revoked", createdAt: row.createdAt });
      }
    }
    return { rows: out, full };
  },
};
