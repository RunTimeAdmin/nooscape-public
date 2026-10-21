import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { RegistryProfile } from "@shared/chains";
import { agentDirectoryEntries, agentDirectoryRegistryOverflow, agentDirectoryRegistryRows, ingestionSources, type IngestionSource } from "../drizzle/schema";
import { getDb, isSuppressedLocatorHost, requireDb, suppressedLocatorHostSql } from "./db";
import type { DirectoryEntryDraft } from "./ingestion/types";
import { sanitizePublicText } from "./publicText";
import { cachedDirectoryRead, invalidateDirectoryReadsSoftly } from "./readCache";

/**
 * Registry rows: every registration of a mass registry (today the BNB Chain
 * ERC-8004 identity registry, 373,567 registrations), held out of the directory
 * table. The chain pass writes them here, a classification step gives each one
 * a listing state from recorded facts alone, and only the rows that pass the
 * published rules are published into agent_directory_entries, so the directory
 * and its search and aggregates read a few thousand rows instead of hundreds of
 * thousands (docs/bsc-erc8004-2026-10-13.md, sections 4 and 5).
 *
 * Nothing here fetches, scores, or judges. The rules count registrations that
 * share a profile link, a locator host, or a registering wallet, and look at
 * whether a name is only a number. A registration that is held out is not
 * called fake: it is called shared, because the chain says many registrations
 * point at the same place.
 */

/** Where a registry row stands against the listing rules (agent_directory_registry_rows.listing). */
export const REGISTRY_LISTING = {
  /** No usable profile link: no URI, an unrecognized scheme, or inline JSON that did not parse. */
  NO_LINK: 0,
  /** Passes every rule; published into the directory. */
  LISTED: 1,
  /** Shares its profile link, host, or wallet with many other registrations. */
  GROUPED: 2,
  /** Written, not yet classified. */
  PENDING: 3,
  /** The recorded name is only a number. */
  NUMERIC_NAME: 4,
} as const;

/** The thresholds the rules use. Every count is over all registrations of the source, listed or not. */
export type RegistryListingRules = {
  /** A profile link (the exact URI) recorded by this many registrations or more is shared. */
  sharedProfileLinkFrom: number;
  /** A locator host recorded by this many registrations or more is a platform host. */
  sharedHostFrom: number;
  /** A wallet that registered this many agents or more is a mass registrant. */
  sharedWalletFrom: number;
};

/**
 * The published rules for the BNB Chain registry. Chosen against the measured
 * registry on 2026-10-13: 373,567 registrations, 299,120 wallets. A link of its
 * own, a host fewer than 50 registrations point at, and a wallet that
 * registered fewer than 10 agents leave about 6,600. The host bar sits at 50
 * because three multi-tenant hosts hold 67 to 111 listed-looking registrations
 * each; the next host down has 13. A wallet bar of 2 would leave about 5,200
 * but would hold out every developer with more than one agent. Changing a
 * number here changes the listing at the next classification (and loosening one
 * needs the reviewed migration described in the design record); the Home page
 * prints these numbers from the server, so the page and the rule cannot disagree.
 */
export const BSC_LISTING_RULES: RegistryListingRules = {
  sharedProfileLinkFrom: 2,
  sharedHostFrom: 50,
  sharedWalletFrom: 10,
};

/** SHA-256 of the empty string: the profile hash of a registration that set no URI. Never a real shared link. */
const EMPTY_URI_SHA256 = createHash("sha256").update("").digest("hex");

const ROWS = sql.raw("agent_directory_registry_rows");
const ENTRIES = sql.raw("agent_directory_entries");

const CHUNK = 2_000;

/** Listed rows inserted into the directory per statement, so the first publish of a few thousand rows is a handful of short writes. */
const PUBLISH_INSERT_CHUNK = 2_000;

type AffectedHeader = [{ affectedRows?: number }];
const affected = (result: unknown) => Number((result as AffectedHeader)[0]?.affectedRows ?? 0);

/**
 * Inserts the registrations of one window, INSERT-IGNORE'd against the
 * (sourceId, externalKey) key so a re-scan can never overwrite a row (and so
 * never regress a profile link a later window updated). A draft carries its
 * starting listing state: no-link rows are born excluded, everything else is
 * born pending.
 */
export async function insertAgentRegistryRows(input: {
  source: IngestionSource;
  runId: string;
  drafts: DirectoryEntryDraft[];
}): Promise<number> {
  if (input.drafts.length === 0) return 0;
  const db = requireDb(await getDb());
  const seenAt = new Date();
  for (let index = 0; index < input.drafts.length; index += CHUNK) {
    const rows = input.drafts.slice(index, index + CHUNK).map(draft => ({
      id: randomUUID(),
      sourceId: input.source.id,
      externalKey: draft.externalKey,
      displayName: draft.displayName,
      locatorHost: draft.locatorHost,
      protocol: input.source.protocol,
      sourceSignalNote: draft.sourceSignalNote,
      registrant: draft.registrant ?? null,
      profileUriHash: draft.profileUriHash ?? null,
      hidden: isSuppressedLocatorHost(draft.locatorHost),
      listing: draft.listing ?? REGISTRY_LISTING.PENDING,
      lastSeenAt: seenAt,
      lastRunId: input.runId,
    }));
    await db.insert(agentDirectoryRegistryRows).ignore().values(rows);
  }
  return input.drafts.length;
}

/** The externalKeys, of those given, that the source has a stored row for. */
async function storedExternalKeys(sourceId: string, keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = Array.from(new Set(keys));
  if (unique.length === 0) return found;
  const db = requireDb(await getDb());
  for (let index = 0; index < unique.length; index += 1_000) {
    const rows = await db
      .select({ key: agentDirectoryRegistryRows.externalKey })
      .from(agentDirectoryRegistryRows)
      .where(and(eq(agentDirectoryRegistryRows.sourceId, sourceId), inArray(agentDirectoryRegistryRows.externalKey, unique.slice(index, index + 1_000))));
    for (const row of rows) found.add(row.key);
  }
  return found;
}

/**
 * Applies a chain's host cap to the registrations of one window. A host that already holds `cap` stored rows takes no more: each
 * further registration from it is counted in agent_directory_registry_overflow and not stored, and neither is any ledger event of
 * its token (keepStoredTokens). One platform registered 140,000 agents a day on Base, a registry row and two ledger rows each,
 * against a database limit of 6 GB (docs/flood-host-cap-2026-10-21.md). The cap sits far above the listing rule's bar for a host,
 * so a host that reaches it is held out whatever its rows say, and the listing is the same with the rows or the count. The pages
 * add the count back to the host's stored rows (readRegistryCounts, readRegistryGroups).
 *
 * `items` are in chain order and carry the host their URI points at; a registration with no https host is never capped. The first
 * registrations of a host, in chain order, are the ones stored. Applying a window again changes nothing: a registration that has a
 * row is kept (the insert ignores it), and a block at or below the host's `lastBlock` was counted already. Returns the items to
 * store, in their order, and how many registrations this call counted.
 */
export async function keepWithinHostCap<T extends { host: string | null; blockNumber: number; externalKey: string }>(
  source: IngestionSource,
  items: T[],
  cap: number
): Promise<{ kept: T[]; counted: number }> {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("A host cap must be a positive whole number.");
  const hosts = Array.from(new Set(items.map(item => item.host).filter((host): host is string => host !== null)));
  if (hosts.length === 0) return { kept: items, counted: 0 };
  const db = requireDb(await getDb());

  // Room left under the cap for each host. The count stops at the cap, so a host with hundreds of thousands of rows costs the same
  // index range as one at the cap.
  const room = new Map<string, number>();
  for (const host of hosts) {
    const [rows] = (await db.execute(
      sql`SELECT COUNT(*) AS total FROM (SELECT 1 FROM ${ROWS} WHERE sourceId = ${source.id} AND locatorHost = ${host} LIMIT ${sql.raw(String(cap))}) AS capped`
    )) as unknown as [Array<{ total: number | string }>];
    room.set(host, Math.max(0, cap - Number(rows[0]?.total ?? 0)));
  }

  const beyond: T[] = [];
  for (const item of items) {
    if (item.host === null) continue;
    const left = room.get(item.host) ?? 0;
    if (left > 0) room.set(item.host, left - 1);
    else beyond.push(item);
  }
  if (beyond.length === 0) return { kept: items, counted: 0 };

  // A registration past the cap may already have a row, from an earlier try at this window that stored it while the host had room.
  const stored = await storedExternalKeys(source.id, beyond.map(item => item.externalKey));
  const over = beyond.filter(item => !stored.has(item.externalKey));
  if (over.length === 0) return { kept: items, counted: 0 };

  const byHost = new Map<string, T[]>();
  for (const item of over) {
    const bucket = byHost.get(item.host!);
    if (bucket) bucket.push(item);
    else byHost.set(item.host!, [item]);
  }
  const counted = await db
    .select({ host: agentDirectoryRegistryOverflow.locatorHost, lastBlock: agentDirectoryRegistryOverflow.lastBlock })
    .from(agentDirectoryRegistryOverflow)
    .where(and(eq(agentDirectoryRegistryOverflow.sourceId, source.id), inArray(agentDirectoryRegistryOverflow.locatorHost, Array.from(byHost.keys()))));
  const countedThrough = new Map(counted.map(row => [row.host, row.lastBlock]));
  let newlyCounted = 0;
  for (const [host, hostItems] of Array.from(byHost.entries())) {
    // Blocks arrive in order and a window holds whole blocks, so a block at or below the highest one counted was counted already.
    const fresh = hostItems.filter(item => item.blockNumber > (countedThrough.get(host) ?? -1));
    if (fresh.length === 0) continue;
    const newest = fresh.reduce((highest, item) => Math.max(highest, item.blockNumber), 0);
    await db
      .insert(agentDirectoryRegistryOverflow)
      .values({ id: randomUUID(), sourceId: source.id, locatorHost: host, overflowCount: fresh.length, lastBlock: newest })
      .onDuplicateKeyUpdate({
        set: {
          overflowCount: sql`${agentDirectoryRegistryOverflow.overflowCount} + ${fresh.length}`,
          lastBlock: sql`GREATEST(${agentDirectoryRegistryOverflow.lastBlock}, ${newest})`,
        },
      });
    newlyCounted += fresh.length;
  }
  const skip = new Set<T>(over);
  return { kept: items.filter(item => !skip.has(item)), counted: newlyCounted };
}

/**
 * The events whose token has a stored row. A token the host cap counted and did not store has no row for its ledger events to roll
 * up onto, so they are dropped with it. Only a chain with a host cap asks for this; every other chain keeps every event, as it
 * always has.
 */
export async function keepStoredTokens<T extends { externalKey: string }>(sourceId: string, events: T[]): Promise<T[]> {
  if (events.length === 0) return events;
  const stored = await storedExternalKeys(sourceId, events.map(event => event.externalKey));
  return events.filter(event => stored.has(event.externalKey));
}

export type RegistryUriUpdate = {
  externalKey: string;
  locatorHost: string | null;
  profileUriHash: string;
  /** False when the new URI is empty, an unrecognized scheme, or inline JSON that did not parse. */
  hasProfileLink: boolean;
};

/**
 * Applies ERC-8004 URIUpdated facts to rows that already exist. The new link's
 * host and SHA-256 replace the stored ones (updates arrive in chain order and
 * the last one wins), and the row goes back to pending, or to excluded when
 * the new link is unusable, so the next classification re-evaluates it against
 * the current link. A row whose name is only a number stays that way. The
 * registrant and the name as asserted at registration never change.
 *
 * A group can also shrink when a row leaves it: the rows that stayed behind in
 * a group that fell below its threshold go back to pending as well, so the
 * listing stays a function of the current facts. An update for a row the
 * source has not registered is a harmless no-op.
 *
 * All of it is one transaction. The groups a row left are known only from the
 * row's previous link, which the update overwrites, so a failure between the
 * updates and the re-pending would otherwise lose them: the retry would see the
 * new link as the old one and strand the rows left behind as grouped.
 */
export async function applyAgentRegistryUriUpdates(input: {
  source: IngestionSource;
  runId: string;
  updates: RegistryUriUpdate[];
  rules?: RegistryListingRules;
}): Promise<number> {
  if (input.updates.length === 0) return 0;
  const rules = input.rules ?? BSC_LISTING_RULES;
  const db = requireDb(await getDb());
  try {
    return await db.transaction(async tx => {
      const leftHashes = new Set<string>();
      const leftHosts = new Set<string>();
      let applied = 0;
      for (const update of input.updates) {
        const [previous] = await tx
          .select({ profileUriHash: agentDirectoryRegistryRows.profileUriHash, locatorHost: agentDirectoryRegistryRows.locatorHost })
          .from(agentDirectoryRegistryRows)
          .where(and(eq(agentDirectoryRegistryRows.sourceId, input.source.id), eq(agentDirectoryRegistryRows.externalKey, update.externalKey)))
          .limit(1);
        if (!previous) continue;
        await tx
          .update(agentDirectoryRegistryRows)
          .set({
            locatorHost: update.locatorHost,
            profileUriHash: update.profileUriHash,
            lastRunId: input.runId,
            listing: update.hasProfileLink
              ? sql`CASE WHEN ${agentDirectoryRegistryRows.listing} = ${REGISTRY_LISTING.NUMERIC_NAME} THEN ${REGISTRY_LISTING.NUMERIC_NAME} ELSE ${REGISTRY_LISTING.PENDING} END`
              : REGISTRY_LISTING.NO_LINK,
          })
          .where(and(eq(agentDirectoryRegistryRows.sourceId, input.source.id), eq(agentDirectoryRegistryRows.externalKey, update.externalKey)));
        if (previous.profileUriHash && previous.profileUriHash !== update.profileUriHash) leftHashes.add(previous.profileUriHash);
        if (previous.locatorHost && previous.locatorHost !== update.locatorHost) leftHosts.add(previous.locatorHost);
        applied += 1;
      }
      await repend(tx, input.source.id, "profileUriHash", Array.from(leftHashes), rules.sharedProfileLinkFrom);
      await repend(tx, input.source.id, "locatorHost", Array.from(leftHosts), rules.sharedHostFrom);
      return applied;
    });
  } finally {
    invalidateDirectoryReadsSoftly();
  }
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** What repend needs: the database handle or a transaction on it. */
type Executor = Pick<Db, "select" | "update">;

/**
 * Sends the grouped rows of every listed key whose group has fallen below the
 * threshold back to pending. Keys still at or above the threshold keep their
 * rows grouped, which is the common case: a template group losing one member.
 */
async function repend(db: Executor, sourceId: string, column: "profileUriHash" | "locatorHost", keys: string[], threshold: number) {
  const target = column === "profileUriHash" ? agentDirectoryRegistryRows.profileUriHash : agentDirectoryRegistryRows.locatorHost;
  for (let index = 0; index < keys.length; index += 500) {
    const chunk = keys.slice(index, index + 500);
    const sizes = await db
      .select({ key: target, size: sql<number>`count(*)` })
      .from(agentDirectoryRegistryRows)
      .where(and(eq(agentDirectoryRegistryRows.sourceId, sourceId), inArray(target, chunk)))
      .groupBy(target);
    const sizeByKey = new Map(sizes.map(row => [row.key, Number(row.size)]));
    const shrunk = chunk.filter(key => (sizeByKey.get(key) ?? 0) < threshold);
    if (shrunk.length === 0) continue;
    await db
      .update(agentDirectoryRegistryRows)
      .set({ listing: REGISTRY_LISTING.PENDING })
      .where(and(eq(agentDirectoryRegistryRows.sourceId, sourceId), eq(agentDirectoryRegistryRows.listing, REGISTRY_LISTING.GROUPED), inArray(target, shrunk)));
  }
}

/** True when any row of the source is waiting for classification. */
export async function hasPendingRegistryRows(sourceId: string): Promise<boolean> {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ id: agentDirectoryRegistryRows.id })
    .from(agentDirectoryRegistryRows)
    .where(and(eq(agentDirectoryRegistryRows.sourceId, sourceId), eq(agentDirectoryRegistryRows.listing, REGISTRY_LISTING.PENDING)))
    .limit(1);
  return Boolean(row);
}

/**
 * Sets the listing state of every pending or listed row from the recorded facts
 * and the thresholds. Set-based, one statement per rule, each driven from the
 * pending and listed rows through the (sourceId, listing) index and probing a
 * materialized set of the keys that reach the threshold (an index-only scan per
 * rule). Grouped, excluded, and numeric-name rows are not touched.
 *
 * Order matters and is the whole rule: a name that is only a number is excluded
 * first (it never counts as grouped), then each shared-key rule groups the rows
 * that fall in a big group, and whatever is still pending is listed. Running it
 * again with nothing new changes nothing.
 */
export async function classifyAgentRegistryListing(sourceId: string, rules: RegistryListingRules = BSC_LISTING_RULES): Promise<void> {
  const db = requireDb(await getDb());
  await db.execute(sql`
    UPDATE ${ROWS} SET listing = ${REGISTRY_LISTING.NUMERIC_NAME}
    WHERE sourceId = ${sourceId} AND listing = ${REGISTRY_LISTING.PENDING} AND displayName REGEXP '^[0-9]+$'
  `);
  const groupBy = (column: "profileUriHash" | "locatorHost" | "registrant", threshold: number) => sql`
    UPDATE ${ROWS} AS r
    JOIN (
      SELECT ${sql.raw(column)} AS k FROM ${ROWS}
      WHERE sourceId = ${sourceId} AND ${sql.raw(column)} IS NOT NULL
      GROUP BY ${sql.raw(column)} HAVING COUNT(*) >= ${threshold}
    ) AS big ON big.k = r.${sql.raw(column)}
    SET r.listing = ${REGISTRY_LISTING.GROUPED}
    WHERE r.sourceId = ${sourceId} AND r.listing IN (${REGISTRY_LISTING.LISTED}, ${REGISTRY_LISTING.PENDING})
  `;
  await db.execute(groupBy("profileUriHash", rules.sharedProfileLinkFrom));
  await db.execute(groupBy("locatorHost", rules.sharedHostFrom));
  await db.execute(groupBy("registrant", rules.sharedWalletFrom));
  await db.execute(sql`
    UPDATE ${ROWS} SET listing = ${REGISTRY_LISTING.LISTED}
    WHERE sourceId = ${sourceId} AND listing = ${REGISTRY_LISTING.PENDING}
  `);
}

export type RegistryPublishResult = { inserted: number; refreshed: number; removed: number };

/**
 * Makes agent_directory_entries agree with the listed rows: listed rows missing
 * from the directory are inserted, listed rows whose profile link or chain
 * rollups changed are refreshed, and rows that are no longer listed are removed.
 * Operator-controlled state on an existing directory row (hidden) is never
 * touched, and survives a row leaving and coming back: the flag is copied onto
 * the registry row before its entry is removed, so a later re-listing inserts
 * it hidden. Only rows that are held out are removed; a pending row keeps its
 * entry until classification decides, so two overlapping runs cannot delete a
 * row the other is about to relist. Every statement is set-based and bounded by
 * the listed set; the insert runs in chunks, each a short write.
 */
export async function publishAgentRegistryListing(sourceId: string, options: { insertChunk?: number } = {}): Promise<RegistryPublishResult> {
  const db = requireDb(await getDb());
  const chunk = options.insertChunk ?? PUBLISH_INSERT_CHUNK;
  let inserted = 0;
  for (;;) {
    const added = affected(
      await db.execute(sql`
        INSERT INTO ${ENTRIES} (
          id, sourceId, externalKey, displayName, locatorHost, protocol, sourceSignalNote, registrant,
          mintBlock, secondaryTransferCount, handoutCount, uriUpdateCount, accountPubkey, profileUriHash,
          feedbackCount, hidden, assetClosedAt, firstSeenAt, lastSeenAt, lastRunId
        )
        SELECT
          UUID(), r.sourceId, r.externalKey, r.displayName, r.locatorHost, r.protocol, r.sourceSignalNote, r.registrant,
          r.mintBlock, r.secondaryTransferCount, r.handoutCount, r.uriUpdateCount, r.accountPubkey, r.profileUriHash,
          r.feedbackCount, r.hidden, r.assetClosedAt, r.firstSeenAt, r.lastSeenAt, r.lastRunId
        FROM ${ROWS} AS r
        WHERE r.sourceId = ${sourceId} AND r.listing = ${REGISTRY_LISTING.LISTED}
          AND NOT EXISTS (
            SELECT 1 FROM ${ENTRIES} AS e WHERE e.sourceId = r.sourceId AND e.externalKey = r.externalKey
          )
        LIMIT ${chunk}
      `)
    );
    inserted += added;
    if (added < chunk) break;
  }
  const refreshed = affected(
    await db.execute(sql`
      UPDATE ${ENTRIES} AS e
      JOIN ${ROWS} AS r ON r.sourceId = e.sourceId AND r.externalKey = e.externalKey
      SET
        e.locatorHost = r.locatorHost,
        e.profileUriHash = r.profileUriHash,
        e.mintBlock = r.mintBlock,
        e.secondaryTransferCount = r.secondaryTransferCount,
        e.handoutCount = r.handoutCount,
        e.uriUpdateCount = r.uriUpdateCount,
        e.lastRunId = r.lastRunId
      WHERE e.sourceId = ${sourceId} AND r.listing = ${REGISTRY_LISTING.LISTED}
        AND NOT (
          e.locatorHost <=> r.locatorHost
          AND e.profileUriHash <=> r.profileUriHash
          AND e.mintBlock <=> r.mintBlock
          AND e.secondaryTransferCount <=> r.secondaryTransferCount
          AND e.handoutCount <=> r.handoutCount
          AND e.uriUpdateCount <=> r.uriUpdateCount
        )
    `)
  );
  const heldOut = sql`${REGISTRY_LISTING.NO_LINK}, ${REGISTRY_LISTING.GROUPED}, ${REGISTRY_LISTING.NUMERIC_NAME}`;
  await db.execute(sql`
    UPDATE ${ROWS} AS r
    JOIN ${ENTRIES} AS e ON e.sourceId = r.sourceId AND e.externalKey = r.externalKey
    SET r.hidden = e.hidden
    WHERE r.sourceId = ${sourceId} AND r.listing IN (${heldOut}) AND r.hidden <> e.hidden
  `);
  const removed = affected(
    await db.execute(sql`
      DELETE e FROM ${ENTRIES} AS e
      JOIN ${ROWS} AS r ON r.sourceId = e.sourceId AND r.externalKey = e.externalKey
      WHERE e.sourceId = ${sourceId} AND r.listing IN (${heldOut})
    `)
  );
  return { inserted, refreshed, removed };
}

export type RegistryRefreshResult = { classified: boolean; published: RegistryPublishResult | null };

/**
 * One refresh after a chain pass: classify when anything is new, changed, or
 * pending, and publish when the walk is caught up. Publishing waits for a
 * caught-up walk on purpose: group sizes are only complete once every
 * registration up to the finalized head has been read, and a row listed on a
 * partial read could be grouped by the next window and flicker out of the
 * directory. A publish is always preceded by a classification, whatever the
 * caller knew changed: a classification that failed after its window was applied
 * leaves nothing pending to remember it (a window of registrations with no usable
 * link adds to a wallet's count without adding a pending row), so the state, not
 * the event, decides.
 */
export async function refreshAgentRegistryListing(
  source: IngestionSource,
  options: { classify: boolean; publish: boolean; rules?: RegistryListingRules }
): Promise<RegistryRefreshResult> {
  try {
    const classify = options.classify || options.publish || (await hasPendingRegistryRows(source.id));
    if (classify) await classifyAgentRegistryListing(source.id, options.rules ?? BSC_LISTING_RULES);
    const published = options.publish ? await publishAgentRegistryListing(source.id) : null;
    return { classified: classify, published };
  } finally {
    invalidateDirectoryReadsSoftly();
  }
}

export type AgentRegistryProfile = {
  /** Every registration the chain pass has stored for the source. */
  recorded: number;
  /** Registrations that pass the rules. */
  listed: number;
  /** Listed registrations already published into the directory; lower than `listed` until a walk that has caught up publishes. */
  published: number;
  grouped: number;
  withoutProfileLink: number;
  numericName: number;
  pending: number;
  /** The profile links shared by the most registrations, labeled by their host, or by the name every member records. */
  sharedProfileGroups: Array<{ label: string; registrations: number }>;
  /** The hosts the most registrations point at. */
  topHosts: Array<{ host: string; registrations: number }>;
  rules: RegistryListingRules;
};

/**
 * What fills the registry, as counts over recorded facts: how many registrations
 * are stored, how many pass the rules, how many are held out and why, and the
 * biggest shared profile links and hosts. Index-only scans over the source's
 * rows; the caller caches it.
 */
export async function readAgentRegistryProfile(sourceId: string, rules: RegistryListingRules = BSC_LISTING_RULES): Promise<AgentRegistryProfile> {
  const db = requireDb(await getDb());
  const stateRows = await db
    .select({ listing: agentDirectoryRegistryRows.listing, total: sql<number>`count(*)` })
    .from(agentDirectoryRegistryRows)
    .where(eq(agentDirectoryRegistryRows.sourceId, sourceId))
    .groupBy(agentDirectoryRegistryRows.listing);
  const countOf = (listing: number) => Number(stateRows.find(row => row.listing === listing)?.total ?? 0);
  const [publishedRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .where(eq(agentDirectoryEntries.sourceId, sourceId));
  const groupRows = await db
    .select({ hash: agentDirectoryRegistryRows.profileUriHash, total: sql<number>`count(*)` })
    .from(agentDirectoryRegistryRows)
    .where(
      and(
        eq(agentDirectoryRegistryRows.sourceId, sourceId),
        sql`${agentDirectoryRegistryRows.profileUriHash} IS NOT NULL AND ${agentDirectoryRegistryRows.profileUriHash} <> ${EMPTY_URI_SHA256}`
      )
    )
    .groupBy(agentDirectoryRegistryRows.profileUriHash)
    .having(sql`count(*) >= ${rules.sharedProfileLinkFrom}`)
    .orderBy(sql`count(*) desc`)
    .limit(5);
  const sharedProfileGroups: AgentRegistryProfile["sharedProfileGroups"] = [];
  for (const group of groupRows) {
    const [member] = await db
      .select({ host: agentDirectoryRegistryRows.locatorHost, name: agentDirectoryRegistryRows.displayName })
      .from(agentDirectoryRegistryRows)
      .where(and(eq(agentDirectoryRegistryRows.sourceId, sourceId), eq(agentDirectoryRegistryRows.profileUriHash, group.hash!)))
      .limit(1);
    // A host names the group; failing that a recorded name does (an inline template shares its name). A placeholder
    // name (Agent #<id>) belongs to one member, not the group, so it never labels it. The name is self-asserted text
    // on a public surface, so it gets the same cleaning as every directory name: no control, bidirectional, or
    // zero-width characters, and a short cap.
    const placeholder = member ? /^Agent #\d+$/.test(member.name) : true;
    const name = member && !placeholder ? sanitizePublicText(member.name, 80) : null;
    sharedProfileGroups.push({ label: member?.host ?? name ?? "a link without a host", registrations: Number(group.total) });
  }
  const hostRows = await db
    .select({ host: agentDirectoryRegistryRows.locatorHost, total: sql<number>`count(*)` })
    .from(agentDirectoryRegistryRows)
    .where(and(eq(agentDirectoryRegistryRows.sourceId, sourceId), sql`${agentDirectoryRegistryRows.locatorHost} IS NOT NULL`))
    .groupBy(agentDirectoryRegistryRows.locatorHost)
    .having(sql`count(*) >= 2`)
    .orderBy(sql`count(*) desc`)
    .limit(5);
  return {
    recorded: stateRows.reduce((sum, row) => sum + Number(row.total ?? 0), 0),
    listed: countOf(REGISTRY_LISTING.LISTED),
    published: Number(publishedRow?.total ?? 0),
    grouped: countOf(REGISTRY_LISTING.GROUPED),
    withoutProfileLink: countOf(REGISTRY_LISTING.NO_LINK),
    numericName: countOf(REGISTRY_LISTING.NUMERIC_NAME),
    pending: countOf(REGISTRY_LISTING.PENDING),
    sharedProfileGroups,
    topHosts: hostRows.map(row => ({ host: row.host!, registrations: Number(row.total) })),
    rules,
  };
}

/**
 * The BNB Chain registry profile for the public Home page, or null while no
 * BNB Chain source is active (nothing is public until an operator approves it)
 * and until a walk that reached the finalized head has published. Before that the
 * stored count is a partial read of the chain, and a page that said "373,567
 * registrations on-chain" of a half-read registry would be wrong. Cached like the
 * other directory aggregates and dropped by every refresh.
 */
export function readBscRegistryProfile(): Promise<AgentRegistryProfile | null> {
  return cachedDirectoryRead("directory:bsc-registry-profile", async () => {
    const db = requireDb(await getDb());
    const [source] = await db
      .select({ id: ingestionSources.id })
      .from(ingestionSources)
      .where(and(eq(ingestionSources.protocol, "erc8004_bsc"), eq(ingestionSources.state, "active")))
      .limit(1);
    if (!source) return null;
    const profile = await readAgentRegistryProfile(source.id, BSC_LISTING_RULES);
    return profile.published > 0 ? profile : null;
  });
}

/**
 * How many registrations a chain's registry holds and how many of them the directory lists: the two figures the Home tab of
 * Ethereum, Base or Arc states in a sentence, as the BNB Chain tab does. Null while no source of the protocol is active, and until
 * a walk that reached the finalized head has published, for the reason given on {@link readBscRegistryProfile}. It is two counts
 * over the source's rows and not the whole profile, so a registry of a million rows costs the page a count and no grouping.
 * Cached like the other directory aggregates and dropped by every refresh.
 */
export function readRegistryCounts(protocol: string): Promise<RegistryProfile | null> {
  return cachedDirectoryRead(`directory:registry-counts:${protocol}`, async () => {
    const db = requireDb(await getDb());
    const [source] = await db
      .select({ id: ingestionSources.id })
      .from(ingestionSources)
      .where(and(eq(ingestionSources.protocol, protocol as IngestionSource["protocol"]), eq(ingestionSources.state, "active")))
      .limit(1);
    if (!source) return null;
    const states = await db
      .select({ listing: agentDirectoryRegistryRows.listing, total: sql<number>`count(*)` })
      .from(agentDirectoryRegistryRows)
      .where(eq(agentDirectoryRegistryRows.sourceId, source.id))
      .groupBy(agentDirectoryRegistryRows.listing);
    const [published] = await db.select({ total: sql<number>`count(*)` }).from(agentDirectoryEntries).where(eq(agentDirectoryEntries.sourceId, source.id));
    const stored = states.reduce((sum, row) => sum + Number(row.total ?? 0), 0);
    if (Number(published?.total ?? 0) === 0 || stored === 0) return null;
    // The registrations a host cap counted and did not store are recorded too.
    const recorded = stored + sumOf(await readOverflowByHost(source.id));
    return { recorded, listed: Number(states.find(row => row.listing === REGISTRY_LISTING.LISTED)?.total ?? 0) };
  });
}

/** The registrations a host cap counted and did not store, by host, for one source. A few rows however large a host grows. */
async function readOverflowByHost(sourceId: string): Promise<Map<string, number>> {
  const db = requireDb(await getDb());
  const rows = await db
    .select({ host: agentDirectoryRegistryOverflow.locatorHost, total: agentDirectoryRegistryOverflow.overflowCount })
    .from(agentDirectoryRegistryOverflow)
    .where(eq(agentDirectoryRegistryOverflow.sourceId, sourceId));
  return new Map(rows.map(row => [row.host, Number(row.total)]));
}

const sumOf = (counts: Map<string, number>) => Array.from(counts.values()).reduce((sum, count) => sum + count, 0);

/** The kinds of shared fact a chain page draws a group for. */
export type RegistryGroupKind = "wallet" | "platform_host" | "shared_link";

/** A wallet, host or profile link that many of a source's registrations share, with how many. For a link, the host and the name of one member, to label it. */
export type RegistryGroupRow = { kind: RegistryGroupKind; key: string; count: number; host: string | null; name: string | null };

export type RegistryGroupsRead = {
  /** The `limit` largest groups of each kind, largest first within a kind. */
  groups: RegistryGroupRow[];
  /** How many groups of each kind meet the rule in all, drawn or not. */
  totals: Record<RegistryGroupKind, number>;
  /** Every registration the source holds, counted in the same read, as {@link readRegistryCounts} counts them. */
  recorded: number;
};

/**
 * The registering wallets, hosts and profile links that `minimum` or more of a chain's registrations share, for the chain's own page:
 * the `limit` largest of each kind and how many there are in all, with the number of registrations the registry holds. Counted over
 * every registration, listed or held out, because the groups are what holds registrations out. A registration that is hidden (by the
 * operator, or because it points at a suppressed host) is not counted in a group, the rule every public read keeps. The host is checked
 * here as well as at insert, because a URI update moves a registration's host without changing its hidden flag. Null while no source
 * of the protocol is active and until a walk that reached the finalized head has published, for the reason given on
 * {@link readBscRegistryProfile}. One scan of the source's rows for each kind; the caller caches it.
 */
export async function readRegistryGroups(protocol: string, minimum: number, limit: number): Promise<RegistryGroupsRead | null> {
  if (!(await readRegistryCounts(protocol))) return null;
  const db = requireDb(await getDb());
  const [source] = await db
    .select({ id: ingestionSources.id })
    .from(ingestionSources)
    .where(and(eq(ingestionSources.protocol, protocol as IngestionSource["protocol"]), eq(ingestionSources.state, "active")))
    .limit(1);
  if (!source) return null;
  const rows = agentDirectoryRegistryRows;
  const live = and(eq(rows.sourceId, source.id), eq(rows.hidden, false), sql`(${rows.locatorHost} IS NULL OR NOT (${suppressedLocatorHostSql(rows.locatorHost)}))`);
  const totals: Record<RegistryGroupKind, number> = { wallet: 0, platform_host: 0, shared_link: 0 };
  const groups: RegistryGroupRow[] = [];

  // One kind: the groups at the rule, the largest first, and how many there are in all. A single scan gives both, because the groups at
  // the rule are few (at most the registry's rows divided by the minimum), so the largest `limit` are cut here and not in SQL. Counting
  // them in a scan of their own made a registry of 285,000 rows take twice as long to read, which a page that reads it cannot afford.
  // A host that a cap stopped storing is counted by its stored rows plus the registrations counted and not stored (readOverflowByHost).
  // Adding them can change which hosts are the largest, so the hosts are ranked again before the cut. Only hosts the scan found are
  // added to: a suppressed or hidden host is not in it, and so stays out.
  const overflow = await readOverflowByHost(source.id);
  const ofKind = async (kind: RegistryGroupKind, column: typeof rows.registrant | typeof rows.locatorHost | typeof rows.profileUriHash, extra = sql`1 = 1`) => {
    const found = await db
      .select({ key: column, total: sql<number>`count(*)` })
      .from(rows)
      .where(and(live, sql`${column} IS NOT NULL`, extra))
      .groupBy(column)
      .having(sql`count(*) >= ${minimum}`)
      .orderBy(sql`count(*) desc`, column);
    totals[kind] = found.length;
    if (kind === "platform_host" && overflow.size > 0) {
      const counted = found.map(row => ({ key: row.key, total: Number(row.total) + (overflow.get(row.key!) ?? 0) }));
      counted.sort((a, b) => b.total - a.total || (a.key! < b.key! ? -1 : a.key! > b.key! ? 1 : 0));
      return counted.slice(0, limit);
    }
    return found.slice(0, limit);
  };

  for (const row of await ofKind("wallet", rows.registrant)) groups.push({ kind: "wallet", key: row.key!, count: Number(row.total), host: null, name: null });
  for (const row of await ofKind("platform_host", rows.locatorHost)) groups.push({ kind: "platform_host", key: row.key!, count: Number(row.total), host: row.key!, name: null });
  for (const link of await ofKind("shared_link", rows.profileUriHash, sql`${rows.profileUriHash} <> ${EMPTY_URI_SHA256}`)) {
    const [member] = await db
      .select({ host: rows.locatorHost, name: rows.displayName })
      .from(rows)
      .where(and(live, eq(rows.profileUriHash, link.key!)))
      .orderBy(rows.id)
      .limit(1);
    groups.push({ kind: "shared_link", key: link.key!, count: Number(link.total), host: member?.host ?? null, name: member?.name ?? null });
  }
  const [recorded] = await db.select({ total: sql<number>`count(*)` }).from(rows).where(eq(rows.sourceId, source.id));
  return { groups, totals, recorded: Number(recorded?.total ?? 0) + sumOf(overflow) };
}
