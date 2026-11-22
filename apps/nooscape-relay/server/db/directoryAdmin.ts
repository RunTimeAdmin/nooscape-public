/** An operator's directory actions: one entry by id, the claim lookups, and hiding and unhiding entries. Part of server/db.ts, which re-exports every module of this folder. */
import { and, asc, eq, sql } from "drizzle-orm";
import { agentDirectoryEntries, agentDirectoryRegistryRows, ingestionSources } from "../../drizzle/schema";
import { isMissingTable } from "../driverErrors";
import { type Erc8004ChainProtocol } from "../ingestion/types";
import { OperatorRuleError } from "../operatorRuleError";
import { invalidateDirectoryReads } from "../readCache";
import { getDb, requireDb, withInvalidation } from "./core";
import { directoryVisibilityCondition, suppressedLocatorHostSql } from "./directoryVisibility";

/**
 * Internal lookup of a directory entry by id, ignoring visibility filters.
 * Used by operator mutations that need to find hidden entries.
 */
export async function getDirectoryEntryById(id: string) {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({
      id: agentDirectoryEntries.id,
      displayName: agentDirectoryEntries.displayName,
      locatorHost: agentDirectoryEntries.locatorHost,
      hidden: agentDirectoryEntries.hidden,
    })
    .from(agentDirectoryEntries)
    .where(eq(agentDirectoryEntries.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The directory entry a claim is about (docs/claims-2026-10-18.md), under the same visibility rule as every public read: an entry
 * that is hidden, closed or from an inactive source cannot be claimed. Only what a claim needs is returned.
 */
export async function getDirectoryEntryForClaim(id: string) {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ id: agentDirectoryEntries.id, protocol: agentDirectoryEntries.protocol, externalKey: agentDirectoryEntries.externalKey, registrant: agentDirectoryEntries.registrant })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentDirectoryEntries.id, id), directoryVisibilityCondition()))
    .limit(1);
  return row ?? null;
}

/** How many entries the directory lists for one registering wallet on one protocol, under the public visibility rule. The fleet rule of the claim flow reads it. */
export async function countVisibleEntriesOfRegistrant(protocol: "erc8004" | Erc8004ChainProtocol, registrant: string): Promise<number> {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    // The pass stores the registering wallet lower-case, so this is an equality on the registrant index and not a scan.
    .where(and(eq(agentDirectoryEntries.protocol, protocol), eq(agentDirectoryEntries.registrant, registrant.toLowerCase()), directoryVisibilityCondition()));
  return Number(row?.total ?? 0);
}

/**
 * Operator-controlled hiding of a directory entry. Used for entries with dead
 * locator hosts (e.g. agentrank.info) or other operator-identified issues.
 * Returns the updated entry state; throws if the entry doesn't exist.
 */
export const hideDirectoryEntry = withInvalidation(hideDirectoryEntryImpl, invalidateDirectoryReads);

async function hideDirectoryEntryImpl(entryId: string) {
  const db = requireDb(await getDb());
  const existing = await getDirectoryEntryById(entryId);
  if (!existing) throw new OperatorRuleError("Directory entry not found.");
  if (existing.hidden) throw new OperatorRuleError("Directory entry is already hidden.");
  // The registry row of a mass registry's entry carries its own copy of the flag, which the public group reads filter on. It goes
  // with the entry in one transaction, so a hidden entry is not counted or named in a group while it waits for the next publish.
  await db.transaction(async tx => {
    await tx.update(agentDirectoryEntries).set({ hidden: true }).where(eq(agentDirectoryEntries.id, entryId));
    try {
      await tx.execute(sql`
        UPDATE agent_directory_registry_rows
        JOIN agent_directory_entries ON agent_directory_entries.sourceId = agent_directory_registry_rows.sourceId AND agent_directory_entries.externalKey = agent_directory_registry_rows.externalKey
        SET agent_directory_registry_rows.hidden = 1
        WHERE agent_directory_entries.id = ${entryId}
      `);
    } catch (error) {
      // A database that has no registry rows table yet has nothing to keep in step.
      if (!isMissingTable(error)) throw error;
    }
  });
  return { ...existing, hidden: true };
}

/**
 * Operator-controlled unhiding of a directory entry. Restores visibility
 * (subject to source state). Returns the updated entry state.
 */
export const unhideDirectoryEntry = withInvalidation(unhideDirectoryEntryImpl, invalidateDirectoryReads);

async function unhideDirectoryEntryImpl(entryId: string) {
  const db = requireDb(await getDb());
  const existing = await getDirectoryEntryById(entryId);
  if (!existing) throw new OperatorRuleError("Directory entry not found.");
  if (!existing.hidden) throw new OperatorRuleError("Directory entry is not hidden.");
  // The registry row follows the entry (see hideDirectoryEntry), except that a registration on a suppressed host stays hidden there
  // whatever the operator does to its entry, as it was when it was inserted.
  await db.transaction(async tx => {
    await tx.update(agentDirectoryEntries).set({ hidden: false }).where(eq(agentDirectoryEntries.id, entryId));
    try {
      await tx.execute(sql`
        UPDATE agent_directory_registry_rows
        JOIN agent_directory_entries ON agent_directory_entries.sourceId = agent_directory_registry_rows.sourceId AND agent_directory_entries.externalKey = agent_directory_registry_rows.externalKey
        SET agent_directory_registry_rows.hidden = IF(${suppressedLocatorHostSql(agentDirectoryRegistryRows.locatorHost)}, 1, 0)
        WHERE agent_directory_entries.id = ${entryId}
      `);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
  });
  return { ...existing, hidden: false };
}

/**
 * Lists currently hidden directory entries for the operator control plane.
 */
export async function listHiddenDirectoryEntries() {
  const db = requireDb(await getDb());
  return db
    .select({
      id: agentDirectoryEntries.id,
      displayName: agentDirectoryEntries.displayName,
      locatorHost: agentDirectoryEntries.locatorHost,
      protocol: agentDirectoryEntries.protocol,
    })
    .from(agentDirectoryEntries)
    .where(eq(agentDirectoryEntries.hidden, true))
    .orderBy(asc(agentDirectoryEntries.displayName))
    .limit(500);
}
