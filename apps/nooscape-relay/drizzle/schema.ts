import {
  bigint,
  boolean,
  date,
  decimal,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

/**
 * The only server-side authority for fetching an external source. A public request
 * can never insert an arbitrary URL here: only an authenticated administrator can
 * register a source, and the hostname is preserved as an explicit policy boundary.
 */
export const ingestionSources = mysqlTable(
  "ingestion_sources",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceKey: varchar("sourceKey", { length: 64 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    protocol: mysqlEnum("protocol", ["a2a", "anp", "agntcy", "erc8004", "erc8004_reputation", "catalog", "census", "solana_registry", "solana_8004", "usdg_settlement", "solana_said", "erc8004_bsc", "erc8004_base", "erc8004_eth", "erc8004_arc"]).notNull(),
    rootUrl: varchar("rootUrl", { length: 2048 }).notNull(),
    allowedHostname: varchar("allowedHostname", { length: 255 }).notNull(),
    state: mysqlEnum("state", ["review", "active", "paused", "rejected"])
      .default("review")
      .notNull(),
    /** Manual-only sources can be reviewed and run explicitly but never claimed by the scheduled worker. */
    executionPolicy: mysqlEnum("executionPolicy", ["scheduled", "manual_only"]).default("scheduled").notNull(),
    scheduleMinutes: int("scheduleMinutes").default(15).notNull(),
    cursor: text("cursor"),
    nextRunAt: timestamp("nextRunAt"),
    lastSuccessfulAt: timestamp("lastSuccessfulAt"),
    failureCount: int("failureCount").default(0).notNull(),
    lastError: text("lastError"),
    createdByUserId: int("createdByUserId")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("ingestion_sources_source_key_uq").on(table.sourceKey),
    index("ingestion_sources_state_next_run_idx").on(table.state, table.nextRunAt),
  ]
);

/**
 * Separates source ingestion from public presentation. An active source can
 * produce retained evidence without being displayed in the public Atlas until
 * an operator records an explicit projection decision. A `public` decision is
 * bound to one completed run (`approvedRunId`): only observations linked to
 * that reviewed run may project, so later scheduled runs stay withheld until
 * an operator reviews and approves them.
 */
export const sourceProjectionDecisions = mysqlTable(
  "source_projection_decisions",
  {
    sourceId: varchar("sourceId", { length: 36 })
      .primaryKey()
      .references(() => ingestionSources.id),
    state: mysqlEnum("state", ["review", "public", "revoked"]).default("review").notNull(),
    rationale: text("rationale").notNull(),
    decidedByUserId: int("decidedByUserId")
      .notNull()
      .references(() => users.id),
    decidedAt: timestamp("decidedAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    /** The single completed run whose retained observations may be public. */
    approvedRunId: varchar("approvedRunId", { length: 36 }),
  },
  table => [
    foreignKey({ columns: [table.approvedRunId], foreignColumns: [ingestionRuns.id], name: "spd_approved_run_fk" }),
  ]
);

/** An append-only operational record for every bounded source run. */
export const ingestionRuns = mysqlTable(
  "ingestion_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => ingestionSources.id),
    trigger: mysqlEnum("trigger", ["manual", "scheduled", "replay"]).notNull(),
    status: mysqlEnum("status", ["running", "completed", "failed", "skipped"]).notNull(),
    cursorBefore: text("cursorBefore"),
    cursorAfter: text("cursorAfter"),
    requestCount: int("requestCount").default(0).notNull(),
    discoveredCount: int("discoveredCount").default(0).notNull(),
    acceptedCount: int("acceptedCount").default(0).notNull(),
    rejectedCount: int("rejectedCount").default(0).notNull(),
    errorSummary: varchar("errorSummary", { length: 1024 }),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    finishedAt: timestamp("finishedAt"),
  },
  table => [index("ingestion_runs_source_started_idx").on(table.sourceId, table.startedAt)]
);

/**
 * The master directory: every agent a source observed, acknowledged without
 * judgment. Entries exist so search can answer "is this agent out there
 * speaking?" even when the record never met the evidence bar for a reviewed
 * public record. Locator-class facts only — no self-descriptions, no tiers, no
 * map placement; acknowledgement is not endorsement and never upgrades trust.
 */
const directoryEntryColumns = {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => ingestionSources.id),
    /** The source's own stable key for the agent (catalog record id, mint, or ERC-8004 composite id). */
    externalKey: varchar("externalKey", { length: 512 }).notNull(),
    displayName: varchar("displayName", { length: 255 }).notNull(),
    locatorHost: varchar("locatorHost", { length: 255 }),
    protocol: mysqlEnum("protocol", ["a2a", "anp", "agntcy", "erc8004", "erc8004_reputation", "catalog", "census", "solana_registry", "solana_8004", "usdg_settlement", "solana_said", "erc8004_bsc", "erc8004_base", "erc8004_eth", "erc8004_arc"]).notNull(),
    /** Why this entry is directory-only (e.g. no upstream signals, inline data: metadata). */
    sourceSignalNote: varchar("sourceSignalNote", { length: 512 }),
    /**
     * The wallet currently recorded on-chain for this identity — the ERC-8004
     * registration event's registrant, or the Metaplex chain pass's current
     * Core asset owner. An event-anchored chain fact decoded from chain data
     * itself — never a verified operator identity. Widened to 64 so Solana
     * base58 addresses (43–44 chars) fit beside EVM addresses (42 chars).
     */
    registrant: varchar("registrant", { length: 64 }),
    /**
     * Block of the mint Transfer (ERC-721 Transfer from 0x0). Event-anchored
     * chain fact; null until the activity walk reaches the mint, and always
     * null for non-chain sources.
     */
    mintBlock: int("mintBlock", { unsigned: true }),
    /**
     * Every ownership change after mint (secondary Transfers), rolled up from
     * the activity ledger. Null until the activity walk has covered the agent —
     * null is "not measured yet", never zero.
     */
    secondaryTransferCount: int("secondaryTransferCount", { unsigned: true }),
    /**
     * Secondary Transfers within the block-proxied hour of minting (36,000
     * blocks at the observed ~0.1 s/block): a platform hand-out, not a sale.
     * Null until the activity walk has covered the agent.
     */
    handoutCount: int("handoutCount", { unsigned: true }),
    /** URIUpdated events for this agent. Null until the activity walk has covered it. */
    uriUpdateCount: int("uriUpdateCount", { unsigned: true }),
    /**
     * The 8004 AgentAccount PDA this row's asset was last observed live under —
     * the chain-facts address a closure confirmation re-reads via
     * getAccountInfo before the pass hides the row: the enumeration alone
     * never proves a disappearance, and a truncated listing must never
     * masquerade as closures. Null for every other protocol, and null until
     * the row's first live 8004 pass after migration 0026 — the PDA is only
     * knowable while the account exists.
     */
    accountPubkey: varchar("accountPubkey", { length: 64 }),
    /**
     * SHA-256 hex of the 8004 registration URI as last acknowledged. The
     * fingerprint compares the whole link: an IPFS CID swap or a path edit
     * replaces the agent's file without touching the display name or the
     * https host, and only the hash turns that into an honest profile_update
     * event. Null for every other protocol and until the row's first live 8004
     * pass; a null prior hash adopts the chain state silently, exactly like a
     * null prior registrant. The Robinhood name step also writes it, for the
     * entries whose name is still "Agent #n": the hash of the registration link
     * it read from the chain (the hash of the empty link when there is none),
     * which is how it knows an entry's link has been read and which entries a
     * name read from that link belongs to (docs/approvals/2026-10-17-robinhood-entry-names.md).
     */
    profileUriHash: varchar("profileUriHash", { length: 64 }),
    /**
     * The AgentAccount's live on-chain feedback counter (the first reputation
     * window's u64 count) — the census-exact number of feedback records
     * against this agent, decoded free from the state every pass already
     * fetches. Refreshed by every 8004 pass; a count change deliberately fires
     * no ledger event (the per-rating event walk is a later workstream), and
     * the response/revoke counters decode to zero census-wide, so only the
     * feedback window is stored. Null for every other protocol and until the
     * row's first live 8004 pass under migration 0028.
     */
    feedbackCount: int("feedbackCount", { unsigned: true }),
    /**
     * Operator-controlled visibility flag: hidden entries are excluded from all
     * public directory reads. Used for entries with dead locator hosts (e.g.
     * agentrank.info) or other operator-identified issues. Default false.
     */
    hidden: boolean("hidden").default(false).notNull(),
    /**
     * Set when a chain pass acknowledged this entry's asset closing on-chain
     * (a Metaplex Core asset burned/closed while the identity PDA remains).
     * The row keeps its last display name and registrant for provenance but
     * leaves every public read; a later live acknowledgement (the asset
     * registered again) clears the marker and the row returns. Distinct from
     * `hidden`, which is operator-controlled. Null for every other protocol.
     */
    assetClosedAt: timestamp("assetClosedAt"),
    firstSeenAt: timestamp("firstSeenAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    lastRunId: varchar("lastRunId", { length: 36 }),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
};

export const agentDirectoryEntries = mysqlTable("agent_directory_entries", directoryEntryColumns, table => [
    uniqueIndex("agent_directory_source_external_uq").on(table.sourceId, table.externalKey),
    index("agent_directory_display_name_idx").on(table.displayName),
    index("agent_directory_last_seen_idx").on(table.lastSeenAt),
    // The home page's "new in the last day" counts read the entries by when they were first seen (migration 0041, applied by hand).
    index("agent_directory_first_seen_idx").on(table.firstSeenAt),
    index("agent_directory_registrant_idx").on(table.registrant),
    index("agent_directory_hidden_idx").on(table.hidden),
  ]
);

/**
 * Every registration of a mass registry, held out of the directory table. The
 * BNB Chain ERC-8004 registry holds 373,567 registrations, most of them
 * templates and platform issuers; stored in agent_directory_entries they would
 * more than double the table every public aggregate and search scans. So the
 * chain pass writes them here instead, column for column like a directory
 * entry plus a listing state, and a classification step publishes only the
 * registrations that pass the published rules (docs/bsc-erc8004-2026-10-13.md,
 * sections 4 and 5) into agent_directory_entries. Public surfaces read only
 * counts computed from these rows (the registry profile and the look-alike
 * counts), never the rows themselves. There is no FULLTEXT index on purpose.
 */
export const agentDirectoryRegistryRows = mysqlTable("agent_directory_registry_rows", {
    ...directoryEntryColumns,
    /**
     * Where the registration stands against the listing rules:
     * 0 = no usable profile link (no URI, an unrecognized scheme, or inline JSON
     *     that did not parse);
     * 1 = listed (published to agent_directory_entries);
     * 2 = grouped (it shares its profile link, host, or wallet with many other
     *     registrations);
     * 3 = pending (written, not yet classified);
     * 4 = its name is only a number.
     * The state is a pure function of the recorded facts and the published
     * thresholds; the classification step recomputes it, it is never asserted.
     */
    listing: tinyint("listing", { unsigned: true }).default(3).notNull(),
  },
  table => [
    uniqueIndex("agent_registry_rows_source_external_uq").on(table.sourceId, table.externalKey),
    // The listing rules count registrations per wallet, host, and profile link inside one source; each
    // count is an index-only scan on these composites. (sourceId, listing) finds the pending and listed
    // rows and serves the registry profile's per-state counts.
    index("agent_registry_rows_registrant_idx").on(table.sourceId, table.registrant),
    index("agent_registry_rows_host_idx").on(table.sourceId, table.locatorHost),
    index("agent_registry_rows_profile_idx").on(table.sourceId, table.profileUriHash),
    index("agent_registry_rows_listing_idx").on(table.sourceId, table.listing),
  ]
);

/**
 * The registrations of one host that a chain pass counted and did not store, because the host already holds its cap of stored rows
 * (`hostRowCap` in server/ingestion/erc8004Chains.ts, docs/flood-host-cap-2026-10-21.md). One platform registered 140,000 agents a day
 * on Base, a registry row and two ledger rows each, against a database limit of 6 GB. A host that far past the listing rule's bar is
 * held out whatever its rows say, so its rows add nothing the count does not. The count is added to the host's stored rows wherever
 * the registry is counted (agentRegistryRows.ts). `lastBlock` is the highest block counted so far, so a window applied twice counts
 * nothing twice.
 */
export const agentDirectoryRegistryOverflow = mysqlTable(
  "agent_directory_registry_overflow",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 }).notNull(),
    /** The lower-case host the registrations point at. */
    locatorHost: varchar("locatorHost", { length: 255 }).notNull(),
    /** Registrations counted and not stored, in all. */
    overflowCount: int("overflowCount", { unsigned: true }).notNull(),
    /** The highest block among them. */
    lastBlock: int("lastBlock", { unsigned: true }).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("agent_registry_overflow_key_uq").on(table.sourceId, table.locatorHost)]
);

/**
 * How many ratings a chain's ERC-8004 reputation registry holds, counted and not stored (docs/extra-chain-ratings-2026-10-21.md). One row for each
 * of the chains the identity pass reads beyond BNB Chain: the step in server/chainRatings.ts reads the registry's NewFeedback and FeedbackRevoked
 * events from the identity registry's deploy block to the finalized head, a window at a time, and adds each window's two counts in the same statement
 * that moves `nextBlock` past it, so a window is counted once however often it is read. No event is kept, so a platform that rates at scale cannot
 * grow the table. `caughtUpAt` is set the first time the read reaches the finalized head: before then the count is a part of the history, and the page
 * says "not measured" and not a smaller number.
 */
export const chainReputationCounts = mysqlTable("chain_reputation_counts", {
  /** The chain's key on the site: arc, base or ethereum. */
  chainKey: varchar("chainKey", { length: 16 }).primaryKey(),
  /** NewFeedback events counted. A rating that was later revoked is still one of them. */
  ratings: int("ratings", { unsigned: true }).notNull().default(0),
  /** FeedbackRevoked events counted. */
  revocations: int("revocations", { unsigned: true }).notNull().default(0),
  /** Every block below this one has been read. */
  nextBlock: int("nextBlock", { unsigned: true }).notNull(),
  /** When a read first reached the finalized head; null while the history is still being read. */
  caughtUpAt: timestamp("caughtUpAt"),
  /** When the step last started on this chain, for the gap between runs. */
  lastRunAt: timestamp("lastRunAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/**
 * The chain-activity ledger: one row per accepted ERC-8004 activity event
 * (mint Transfer, secondary Transfer, URIUpdated), retained so every per-agent
 * rollup is replayable from raw events and window re-apply stays idempotent.
 * Event-anchored locator facts only — ownership changes say an agent moved
 * between wallets, never who operates it or whether it works.
 */
export const agentDirectoryChainActivity = mysqlTable(
  "agent_directory_chain_activity",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => ingestionSources.id),
    transactionHash: varchar("transactionHash", { length: 66 }).notNull(),
    logIndex: int("logIndex").notNull(),
    /** mint = Transfer from 0x0 · secondary = Transfer with a prior owner · uri_update = URIUpdated. */
    kind: mysqlEnum("kind", ["mint", "secondary", "uri_update"]).notNull(),
    blockNumber: int("blockNumber", { unsigned: true }).notNull(),
    /** The directory entry this event belongs to (ERC-8004 composite id). */
    externalKey: varchar("externalKey", { length: 512 }).notNull(),
    /** Transfer `from` (0x0 for mints); null for URIUpdated. */
    fromAddress: varchar("fromAddress", { length: 42 }),
    /** Transfer `to`; null for URIUpdated. */
    toAddress: varchar("toAddress", { length: 42 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("agent_directory_activity_event_uq").on(table.sourceId, table.transactionHash, table.logIndex),
    index("agent_directory_activity_entry_idx").on(table.sourceId, table.externalKey),
    index("agent_directory_activity_block_idx").on(table.sourceId, table.blockNumber),
  ]
);

/**
 * The Solana chain-activity ledger: one row per accepted Metaplex or 8004
 * registry event (register, transfer, profile_update, asset_closed), retained
 * so per-agent history replays from raw events and window re-apply stays
 * idempotent. The Solana sibling of `agent_directory_chain_activity`, keyed by
 * transaction signature instead of (hash, logIndex) — a diff pass attributes
 * each change the transaction whose instructions made it, and one transaction
 * can produce several kinds for one asset (a transfer and a rename in the same
 * tx), so the event kind joins the uniqueness key: dropping it silently lost
 * the second event of any multi-kind transaction. Chain facts only: an owner
 * change says the asset moved between wallets, never who operates the agent or
 * whether it works.
 */
export const agentSolanaActivity = mysqlTable(
  "agent_solana_activity",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => ingestionSources.id),
    /** Base58 transaction signature (87–88 chars); the event's evidence anchor. */
    transactionSignature: varchar("transactionSignature", { length: 96 }).notNull(),
    /** Slot of the pass that observed the change (not the attributed slot — an honest bound). */
    slot: int("slot", { unsigned: true }).notNull(),
    /** The directory entry this event belongs to (the asset pubkey). */
    externalKey: varchar("externalKey", { length: 512 }).notNull(),
    /** register = mint to initial owner · transfer = ownership changed · profile_update = name or URI changed · asset_closed = closed/burned. */
    kind: mysqlEnum("kind", ["register", "transfer", "profile_update", "asset_closed"]).notNull(),
    /** Prior owner; null for registers and profile updates. */
    fromOwner: varchar("fromOwner", { length: 64 }),
    /** New owner; null for closes. */
    toOwner: varchar("toOwner", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("agent_solana_activity_event_uq").on(table.sourceId, table.transactionSignature, table.externalKey, table.kind),
    index("agent_solana_activity_entry_idx").on(table.sourceId, table.externalKey),
    index("agent_solana_activity_slot_idx").on(table.sourceId, table.slot),
  ]
);

/**
 * One row per distinct 8004 registration URI the pass has sought a display
 * name for, keyed by (sourceId, uriHash) so a re-registration of the same
 * link reuses its verdict instead of refetching. The 8004 pass never
 * dereferences URIs inside its chain-facts event spine; this table is the
 * fetcher's own record: a budgeted queue (30 per pass, newest-hash first)
 * resolves `ipfs://` links through the configured gateway and `https://`
 * links directly, behind the shared SSRF net guard, with failures recorded as
 * statuses — `failed` retries (bounded attempts), `no_name` is terminal
 * (valid content that carries no usable name), and `resolved` holds the
 * self-asserted name. Locator-class trust posture: a fetched name is exactly
 * as self-asserted as an inline-decoded one, and it is only ever applied to a
 * row whose chain-decoded name is still the placeholder.
 */
export const agentRegistrationResolutions = mysqlTable(
  "agent_registration_resolutions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => ingestionSources.id),
    /** The directory externalKey the URI belongs to (the agent asset pubkey). */
    externalKey: varchar("externalKey", { length: 64 }).notNull(),
    /** SHA-256 hex of the full registration URI — the queue's idempotency key. */
    uriHash: varchar("uriHash", { length: 64 }).notNull(),
    /** Where the name was sought: `web` (https/http), `ipfs` (gateway), or `meta` (on-chain MetadataEntryPda name). */
    uriKind: varchar("uriKind", { length: 16 }).notNull(),
    /** The fetched locator: the URI itself, or the metadata account pubkey for meta rows. */
    uri: varchar("uri", { length: 512 }).notNull(),
    /** resolved = usable name stored · no_name = terminal, content carries no name · failed = retried up to the attempt cap. */
    status: mysqlEnum("status", ["resolved", "no_name", "failed"]).notNull(),
    /** Why a fetch failed (guard block, timeout, size cap, HTTP status); null for terminal statuses. */
    failReason: varchar("failReason", { length: 200 }),
    /** The self-asserted name, trimmed and capped; null unless status is resolved. */
    resolvedName: varchar("resolvedName", { length: 200 }),
    /** Fetch attempts made against this hash; the adapter computes prior+1. */
    attempts: int("attempts").default(0).notNull(),
    lastAttemptAt: timestamp("lastAttemptAt").notNull(),
    /** When the name first resolved; stays fixed across later no-op passes. */
    fetchedAt: timestamp("fetchedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("agent_registration_resolution_uq").on(table.sourceId, table.uriHash),
    index("agent_registration_resolution_status_idx").on(table.sourceId, table.status),
  ]
);

/**
 * One row per machine-readable cross-chain reference read from the 8004
 * program's MetadataEntryPda accounts (free-form key/value metadata attached
 * to an agent asset). The live vocabulary is ad-hoc — `erc8004-eth: #25045`,
 * `chain-registrations: 5-chains` — so the raw metadata key is stored beside
 * the value: a bare `#25045` names nothing without the key that scopes its
 * registry. `linkedEntryId` resolves only when exactly one acknowledged
 * directory entry carries the linked externalKey; ambiguous matches stay null
 * rather than guessing. Upsert-only by design — nothing un-links in v1 — and
 * the rows carry no trust: a self-asserted cross-chain claim is recorded, not
 * verified.
 */
export const agentDirectoryChainLinks = mysqlTable(
  "agent_directory_chain_links",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => ingestionSources.id),
    /** The linking entry's externalKey (the agent asset pubkey the metadata is attached to). */
    externalKey: varchar("externalKey", { length: 64 }).notNull(),
    /** The raw metadata key the link was read from (`erc8004-eth`, `chain-registrations`, …). */
    metadataKey: varchar("metadataKey", { length: 64 }).notNull(),
    /** The protocol family the value appears to point into; `other` for ad-hoc vocabularies with no approved protocol. */
    linkedProtocol: mysqlEnum("linkedProtocol", [
      "a2a",
      "anp",
      "agntcy",
      "erc8004",
      "erc8004_reputation",
      "catalog",
      "census",
      "solana_registry",
      "solana_8004",
      "usdg_settlement",
      "other",
    ]).notNull(),
    /** The raw linked value (`#25045`, `eip155:8453`, `5-chains`) — matched verbatim against other sources' externalKeys. */
    linkedExternalKey: varchar("linkedExternalKey", { length: 128 }).notNull(),
    /** Directory entry id when exactly one acknowledged entry carries the linked externalKey; null when none or ambiguous. */
    linkedEntryId: varchar("linkedEntryId", { length: 36 }),
    /** SHA-256 hex of the raw value — change detection for the upsert-only row. */
    metadataValueHash: varchar("metadataValueHash", { length: 64 }).notNull(),
    discoveredAt: timestamp("discoveredAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("agent_directory_chain_link_uq").on(table.sourceId, table.externalKey, table.metadataKey, table.linkedExternalKey),
    index("agent_directory_chain_link_linked_idx").on(table.linkedExternalKey),
  ]
);

/**
 * The USDG settlement ledger: one row per accepted EIP-3009 settlement on the
 * canonical Robinhood Chain Global Dollar contract — an AuthorizationUsed event
 * paired with the ERC-20 Transfer it spent, decoded from one receipt. Retained
 * so rail-level totals replay from raw events and window re-apply stays
 * idempotent. Rail facts only: a settlement says value moved between two
 * wallets on-chain, never which registered agent (if any) either wallet
 * operates — per-agent attribution stays gated on the census-integrity rule.
 */
export const agentDirectoryUsdgSettlements = mysqlTable(
  "agent_directory_usdg_settlements",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => ingestionSources.id),
    transactionHash: varchar("transactionHash", { length: 66 }).notNull(),
    /** Log index of the AuthorizationUsed event that keyed the settlement. */
    logIndex: int("logIndex").notNull(),
    blockNumber: int("blockNumber", { unsigned: true }).notNull(),
    /** Transfer `from` — the authorizer whose EIP-3009 pre-approval was spent. */
    payerAddress: varchar("payerAddress", { length: 42 }).notNull(),
    /** Transfer `to` — the wallet that received the settled USDG. */
    payeeAddress: varchar("payeeAddress", { length: 42 }).notNull(),
    /** Transaction sender — the relayer that submitted the pre-authorized transfer. */
    relayerAddress: varchar("relayerAddress", { length: 42 }).notNull(),
    /** Raw 6-decimal USDG amount, kept exact as a decimal string; never a float. */
    valueRaw: decimal("valueRaw", { precision: 30, scale: 0 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("agent_directory_usdg_settlement_uq").on(table.sourceId, table.transactionHash, table.logIndex),
    index("agent_directory_usdg_settlement_block_idx").on(table.sourceId, table.blockNumber),
  ]
);

/**
 * The Reputation Registry ledger: one row per accepted ERC-8004 reputation
 * event against a registered agent — a third party's NewFeedback, its later
 * FeedbackRevoked, or a ResponseAppended reply. Chain-anchored opinion facts
 * only: who rated, when, and with what raw score, stored exactly as emitted.
 * Scores have no shared scale (each rater's value rides its own decimals), so
 * the ledger never aggregates across raters, and dynamic strings are untrusted
 * text capped at 512 bytes — URIs are never dereferenced. A revocation does
 * not delete its rating: FeedbackRevoked rows carry the contract's feedback
 * index, and NewFeedback rows carry the chain-order rank (`pairOrdinal`) that
 * reconstructs that index from the pair's complete history — the read-side
 * join decides which rating a revocation removes.
 */
export const agentReputationEvents = mysqlTable(
  "agent_reputation_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => ingestionSources.id),
    transactionHash: varchar("transactionHash", { length: 66 }).notNull(),
    logIndex: int("logIndex").notNull(),
    kind: mysqlEnum("kind", ["new_feedback", "feedback_revoked", "response_appended"]).notNull(),
    blockNumber: int("blockNumber", { unsigned: true }).notNull(),
    /** The rated agent's registry token id; ids beyond the safe-integer range are rejected at decode. */
    agentId: bigint("agentId", { mode: "number" }).notNull(),
    /** The rating client (rater wallet) — revoked/response rows repeat it from their topics. */
    clientAddress: varchar("clientAddress", { length: 42 }).notNull(),
    /**
     * The contract's per-(agentId, clientAddress) 1-indexed feedback counter,
     * emitted by every kind (NewFeedback data head, FeedbackRevoked and
     * ResponseAppended topics) — the exact join key a revocation matches on.
     */
    feedbackIndex: bigint("feedbackIndex", { mode: "number" }),
    /** Raw int128 score as an exact decimal string; null for revoked/response rows. */
    valueRaw: decimal("valueRaw", { precision: 39, scale: 0 }),
    /** The rater's own decimal placement; null for revoked/response rows. */
    valueDecimals: int("valueDecimals"),
    /** Untrusted text, each capped at 512 bytes with an explicit truncation marker. */
    tag1: varchar("tag1", { length: 512 }),
    tag2: varchar("tag2", { length: 512 }),
    /** Third NewFeedback string (EIP: `endpoint`); observed empty on live events. */
    endpoint: varchar("endpoint", { length: 512 }),
    /** Fourth NewFeedback string (EIP: `feedbackURI`) — stored capped, never dereferenced. */
    feedbackUri: varchar("feedbackUri", { length: 512 }),
    /** NewFeedback bytes32 feedbackHash, hex-encoded; null for revoked/response rows. */
    feedbackHash: varchar("feedbackHash", { length: 66 }),
    /** ResponseAppended only: who appended the response. */
    responderAddress: varchar("responderAddress", { length: 42 }),
    /**
     * Chain-order rank of this NewFeedback row among the (agentId,
     * clientAddress) pair's rating rows. The contract emits the same counter
     * as feedbackIndex, so rank === feedbackIndex on a complete ledger; any
     * divergence is the mechanical deep-history gap detector the
     * reconciliation step checks after the backward walk finishes.
     */
    pairOrdinal: int("pairOrdinal", { unsigned: true }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("agent_reputation_event_uq").on(table.sourceId, table.transactionHash, table.logIndex),
    index("agent_reputation_agent_idx").on(table.sourceId, table.agentId),
    index("agent_reputation_pair_idx").on(table.sourceId, table.agentId, table.clientAddress, table.blockNumber, table.logIndex),
    /** The revocation join: rating rows for one (agent, client, feedbackIndex) triple. */
    index("agent_reputation_feedback_idx").on(table.sourceId, table.agentId, table.clientAddress, table.feedbackIndex),
    index("agent_reputation_block_idx").on(table.sourceId, table.blockNumber),
  ]
);

/**
 * A content-addressed observation points to immutable object storage. Raw bytes do
 * not live in the database; the database retains an object key and SHA-256 digest.
 */
export const sourceObservations = mysqlTable(
  "source_observations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => ingestionSources.id),
    protocol: mysqlEnum("protocol", ["a2a", "anp", "agntcy", "erc8004", "erc8004_reputation", "catalog", "census", "solana_registry", "solana_8004", "usdg_settlement", "solana_said", "erc8004_bsc", "erc8004_base", "erc8004_eth", "erc8004_arc"]).notNull(),
    canonicalLocator: varchar("canonicalLocator", { length: 2048 }).notNull(),
    locatorHash: varchar("locatorHash", { length: 64 }).notNull(),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    rawObjectKey: varchar("rawObjectKey", { length: 512 }).notNull(),
    contentType: varchar("contentType", { length: 255 }).notNull(),
    httpStatus: int("httpStatus"),
    parserVersion: varchar("parserVersion", { length: 64 }).notNull(),
    validationStatus: mysqlEnum("validationStatus", ["valid", "invalid", "partial"])
      .notNull(),
    validationFindings: text("validationFindings").notNull(),
    observedAt: timestamp("observedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("source_observations_content_uq").on(
      table.sourceId,
      table.locatorHash,
      table.contentHash
    ),
    index("source_observations_source_observed_idx").on(table.sourceId, table.observedAt),
  ]
);

/** Retains the link between a run and a deduplicated observation. */
export const sourceObservationRuns = mysqlTable(
  "source_observation_runs",
  {
    runId: varchar("runId", { length: 36 })
      .notNull()
      .references(() => ingestionRuns.id),
    observationId: varchar("observationId", { length: 36 })
      .notNull()
      .references(() => sourceObservations.id),
    linkedAt: timestamp("linkedAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("source_observation_runs_uq").on(table.runId, table.observationId)]
);

/** Stable public agent profile. Trust is stored as evidence and policy, not a mutable score. */
export const agents = mysqlTable(
  "agents",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    displayName: varchar("displayName", { length: 255 }).notNull(),
    handle: varchar("handle", { length: 160 }).notNull(),
    primaryCapability: varchar("primaryCapability", { length: 160 }),
    summary: text("summary"),
    lifecycle: mysqlEnum("lifecycle", ["active", "inactive", "unknown", "conflicted"])
      .default("unknown")
      .notNull(),
    mapX: int("mapX"),
    mapY: int("mapY"),
    firstSeenAt: timestamp("firstSeenAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("agents_handle_uq").on(table.handle)]
);

/** Strong public identifiers and the exact observation that established each one. */
export const agentIdentities = mysqlTable(
  "agent_identities",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agentId", { length: 36 })
      .notNull()
      .references(() => agents.id),
    identityType: mysqlEnum("identityType", ["a2a_url", "anp_url", "erc8004", "did", "domain", "wallet", "solana_mint", "catalog_record"])
      .notNull(),
    externalId: varchar("externalId", { length: 2048 }).notNull(),
    externalIdHash: varchar("externalIdHash", { length: 64 }).notNull(),
    sourceObservationId: varchar("sourceObservationId", { length: 36 })
      .notNull()
      .references(() => sourceObservations.id),
    verificationState: mysqlEnum("verificationState", ["asserted", "verified", "conflicted"])
      .default("asserted")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("agent_identities_external_uq").on(table.identityType, table.externalIdHash),
    index("agent_identities_agent_idx").on(table.agentId),
  ]
);

/** A declared endpoint is metadata only; discovery never invokes a tool or transaction. */
export const agentEndpoints = mysqlTable(
  "agent_endpoints",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agentId", { length: 36 })
      .notNull()
      .references(() => agents.id),
    protocol: mysqlEnum("protocol", ["a2a", "anp", "agntcy", "erc8004", "catalog", "census"]).notNull(),
    endpointUrl: varchar("endpointUrl", { length: 2048 }).notNull(),
    endpointHash: varchar("endpointHash", { length: 64 }).notNull(),
    authentication: varchar("authentication", { length: 160 }),
    domainVerification: mysqlEnum("domainVerification", ["unverified", "verified", "mismatch"])
      .default("unverified")
      .notNull(),
    lastHealth: mysqlEnum("lastHealth", ["unknown", "healthy", "unreachable"])
      .default("unknown")
      .notNull(),
    sourceObservationId: varchar("sourceObservationId", { length: 36 })
      .notNull()
      .references(() => sourceObservations.id),
    lastObservedAt: timestamp("lastObservedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("agent_endpoints_url_uq").on(table.agentId, table.endpointHash),
    index("agent_endpoints_agent_idx").on(table.agentId),
  ]
);

/**
 * A one-time token proves control of an already-discovered agent domain. It does
 * not prove legal identity, publisher-key ownership, or service safety.
 */
export const domainVerificationChallenges = mysqlTable(
  "domain_verification_challenges",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agentId", { length: 36 })
      .notNull()
      .references(() => agents.id),
    domain: varchar("domain", { length: 255 }).notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull(),
    proofUrl: varchar("proofUrl", { length: 2048 }).notNull(),
    state: mysqlEnum("state", ["pending", "verified", "failed", "expired"])
      .default("pending")
      .notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    verifiedAt: timestamp("verifiedAt"),
    /**
     * Post-verification validity: domain control is not permanent. The window
     * is renewed by an operator recheck and revoked fail-closed when the live
     * proof stops matching or the pinned public card changes.
     */
    verificationExpiresAt: timestamp("verificationExpiresAt"),
    recheckedAt: timestamp("recheckedAt"),
    revokedAt: timestamp("revokedAt"),
    proofObjectKey: varchar("proofObjectKey", { length: 512 }),
    proofHash: varchar("proofHash", { length: 64 }),
    createdByUserId: int("createdByUserId")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("domain_verification_challenges_token_uq").on(table.tokenHash),
    index("domain_verification_challenges_agent_state_idx").on(table.agentId, table.state),
  ]
);

/** Singleton control plane for the host-managed, rate-limited ingestion worker. */
export const ingestionWorkerConfig = mysqlTable("ingestion_worker_config", {
  id: varchar("id", { length: 32 }).primaryKey(),
  state: mysqlEnum("state", ["paused", "enabled"]).default("paused").notNull(),
  tickSeconds: int("tickSeconds").default(900).notNull(),
  maxSourcesPerTick: int("maxSourcesPerTick").default(1).notNull(),
  minGlobalIntervalMinutes: int("minGlobalIntervalMinutes").default(15).notNull(),
  lastStartedAt: timestamp("lastStartedAt"),
  lastCompletedAt: timestamp("lastCompletedAt"),
  lastError: varchar("lastError", { length: 1024 }),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Publisher policy is intentionally separate from discovery or identity validity. */
export const publisherKeys = mysqlTable(
  "publisher_keys",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    issuerName: varchar("issuerName", { length: 255 }).notNull(),
    publicKeyFingerprint: varchar("publicKeyFingerprint", { length: 512 }).notNull(),
    /** Public material only; private publisher keys never enter Nooscape. */
    publicKeyPem: text("publicKeyPem"),
    permittedDomains: text("permittedDomains").notNull(),
    permittedProtocols: text("permittedProtocols").notNull(),
    state: mysqlEnum("state", ["pending", "allowlisted", "expired", "revoked"])
      .default("pending")
      .notNull(),
    expiresAt: timestamp("expiresAt"),
    revokedAt: timestamp("revokedAt"),
    policyVersion: varchar("policyVersion", { length: 64 }).notNull(),
    attestationObjectKey: varchar("attestationObjectKey", { length: 512 }),
    attestationHash: varchar("attestationHash", { length: 64 }),
    attestationSignature: text("attestationSignature"),
    rotationOfKeyId: varchar("rotationOfKeyId", { length: 36 }),
    rotationProofHash: varchar("rotationProofHash", { length: 64 }),
    approvedByUserId: int("approvedByUserId").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    createdByUserId: int("createdByUserId")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("publisher_keys_fingerprint_uq").on(table.publicKeyFingerprint)]
);

/** Historical state changes prevent a current revocation from rewriting the past. */
export const publisherKeyHistory = mysqlTable(
  "publisher_key_history",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    publisherKeyId: varchar("publisherKeyId", { length: 36 })
      .notNull()
      .references(() => publisherKeys.id),
    state: mysqlEnum("state", ["pending", "allowlisted", "expired", "revoked"]).notNull(),
    reason: varchar("reason", { length: 1024 }),
    changedByUserId: int("changedByUserId")
      .notNull()
      .references(() => users.id),
    changedAt: timestamp("changedAt").defaultNow().notNull(),
  },
  table => [index("publisher_key_history_key_changed_idx").on(table.publisherKeyId, table.changedAt)]
);

/** Connects a validated identity to a publisher policy record. */
export const publisherBindings = mysqlTable(
  "publisher_bindings",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentIdentityId: varchar("agentIdentityId", { length: 36 })
      .notNull()
      .references(() => agentIdentities.id),
    publisherKeyId: varchar("publisherKeyId", { length: 36 })
      .notNull()
      .references(() => publisherKeys.id),
    validationMethod: varchar("validationMethod", { length: 255 }).notNull(),
    sourceObservationId: varchar("sourceObservationId", { length: 36 })
      .notNull()
      .references(() => sourceObservations.id),
    validatedAt: timestamp("validatedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("publisher_bindings_identity_key_uq").on(table.agentIdentityId, table.publisherKeyId),
  ]
);

/** A reviewer resolves first-time sources, identity collisions, and policy changes. */
export const reviewItems = mysqlTable(
  "review_items",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    type: mysqlEnum("type", ["source", "identity_collision", "publisher_key", "endpoint_mismatch"])
      .notNull(),
    status: mysqlEnum("status", ["pending", "approved", "rejected"])
      .default("pending")
      .notNull(),
    subjectType: varchar("subjectType", { length: 64 }).notNull(),
    subjectId: varchar("subjectId", { length: 36 }).notNull(),
    rationale: text("rationale").notNull(),
    createdByUserId: int("createdByUserId")
      .notNull()
      .references(() => users.id),
    decidedByUserId: int("decidedByUserId").references(() => users.id),
    decidedAt: timestamp("decidedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("review_items_status_created_idx").on(table.status, table.createdAt)]
);

/** Append-only evidence events power exports and the future public verifier. */
export const evidenceEvents = mysqlTable(
  "evidence_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agentId", { length: 36 })
      .notNull()
      .references(() => agents.id),
    sourceObservationId: varchar("sourceObservationId", { length: 36 })
      .notNull()
      .references(() => sourceObservations.id),
    eventType: varchar("eventType", { length: 160 }).notNull(),
    description: text("description").notNull(),
    proofReference: varchar("proofReference", { length: 2048 }),
    payloadHash: varchar("payloadHash", { length: 64 }),
    observedAt: timestamp("observedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("evidence_events_agent_observed_idx").on(table.agentId, table.observedAt)]
);

/** A strong-identity collision is reviewable; it never silently re-points an identity. */
export const identityMergeReviews = mysqlTable(
  "identity_merge_reviews",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    identityType: mysqlEnum("identityType", ["a2a_url", "anp_url", "erc8004", "did", "domain", "wallet", "solana_mint", "catalog_record"])
      .notNull(),
    externalIdHash: varchar("externalIdHash", { length: 64 }).notNull(),
    existingAgentId: varchar("existingAgentId", { length: 36 }).notNull(),
    proposedAgentId: varchar("proposedAgentId", { length: 36 }).notNull(),
    sourceObservationId: varchar("sourceObservationId", { length: 36 }).notNull(),
    state: mysqlEnum("state", ["pending", "merged", "rejected"]).default("pending").notNull(),
    rationale: text("rationale").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    resolvedAt: timestamp("resolvedAt"),
  },
  table => [
    uniqueIndex("identity_merge_reviews_identity_observation_uq").on(table.identityType, table.externalIdHash, table.sourceObservationId),
    index("identity_merge_reviews_state_idx").on(table.state, table.createdAt),
    foreignKey({ columns: [table.existingAgentId], foreignColumns: [agents.id], name: "imr_existing_agent_fk" }),
    foreignKey({ columns: [table.proposedAgentId], foreignColumns: [agents.id], name: "imr_proposed_agent_fk" }),
    foreignKey({ columns: [table.sourceObservationId], foreignColumns: [sourceObservations.id], name: "imr_observation_fk" }),
  ]
);

/**
 * A source-scoped presentation snapshot. Public reads use only snapshots tied to
 * an explicit public source decision; global agent fields remain reconciliation
 * metadata and cannot be rewritten by an unreviewed source.
 */
export const agentPublicSnapshots = mysqlTable(
  "agent_public_snapshots",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agentId", { length: 36 }).notNull(),
    sourceId: varchar("sourceId", { length: 36 }).notNull(),
    sourceObservationId: varchar("sourceObservationId", { length: 36 }).notNull(),
    displayName: varchar("displayName", { length: 255 }).notNull(),
    displayHandle: varchar("displayHandle", { length: 160 }).notNull(),
    primaryCapability: varchar("primaryCapability", { length: 160 }),
    untrustedSelfDescription: text("untrustedSelfDescription"),
    protocols: text("protocols").notNull(),
    publisherState: mysqlEnum("publisherState", ["allowlisted", "expired", "revoked", "unverified"])
      .default("unverified")
      .notNull(),
    evidenceTier: mysqlEnum("evidenceTier", ["tier_0", "tier_1", "tier_2", "tier_3", "tier_4"])
      .default("tier_2")
      .notNull(),
    sourceCount: int("sourceCount").default(1).notNull(),
    observedAt: timestamp("observedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("agent_public_snapshots_source_observation_uq").on(table.sourceObservationId),
    index("agent_public_snapshots_agent_observed_idx").on(table.agentId, table.observedAt),
    index("agent_public_snapshots_source_observed_idx").on(table.sourceId, table.observedAt),
    foreignKey({ columns: [table.agentId], foreignColumns: [agents.id], name: "aps_agent_fk" }),
    foreignKey({ columns: [table.sourceId], foreignColumns: [ingestionSources.id], name: "aps_source_fk" }),
    foreignKey({ columns: [table.sourceObservationId], foreignColumns: [sourceObservations.id], name: "aps_observation_fk" }),
  ]
);

/** Denormalized, indexed map surface; adapters never write public map records directly. */
export const agentReadModel = mysqlTable(
  "agent_read_model",
  {
    agentId: varchar("agentId", { length: 36 })
      .primaryKey()
      .references(() => agents.id),
    displayName: varchar("displayName", { length: 255 }).notNull(),
    handle: varchar("handle", { length: 160 }).notNull(),
    primaryCapability: varchar("primaryCapability", { length: 160 }),
    summary: text("summary"),
    protocols: text("protocols").notNull(),
    publisherState: mysqlEnum("publisherState", ["allowlisted", "expired", "revoked", "unverified"])
      .default("unverified")
      .notNull(),
    evidenceTier: mysqlEnum("evidenceTier", ["tier_0", "tier_1", "tier_2", "tier_3", "tier_4"])
      .default("tier_2")
      .notNull(),
    sourceCount: int("sourceCount").default(0).notNull(),
    lastObservedAt: timestamp("lastObservedAt").defaultNow().notNull(),
    evidenceSummary: text("evidenceSummary").notNull(),
    /**
     * Domain-control validity copy for the public read path: the tier_3
     * overlay only projects while this window is open and the visible card
     * still matches the fingerprint pinned at verification time.
     */
    verificationExpiresAt: timestamp("verificationExpiresAt"),
    verifiedCardHash: varchar("verifiedCardHash", { length: 64 }),
    /**
     * Publisher-key validity copy for the public read path: the tier_4
     * overlay resolves this through effectivePublisherKeyState at read time,
     * so an expired key fails closed on the list path without waiting for the
     * next worker tick. Null when no allowlisted key has a configured expiry.
     */
    publisherExpiresAt: timestamp("publisherExpiresAt"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("agent_read_model_freshness_idx").on(table.lastObservedAt)]
);

/**
 * Record withdrawals are operator governance layered on top of the reviewed-run
 * gate: append-only events that withhold exactly one agent record from the
 * public census without touching its source, its approved run, or its retained
 * evidence. The newest event per agent decides visibility, so a reinstate
 * restores the record without rewriting history.
 */
export const agentRecordWithdrawals = mysqlTable(
  "agent_record_withdrawals",
  {
    /** Append-only ledger: the auto-increment id is the event order. */
    id: int("id").autoincrement().primaryKey(),
    agentId: varchar("agentId", { length: 36 }).notNull(),
    action: mysqlEnum("action", ["withdraw", "reinstate"]).notNull(),
    reason: varchar("reason", { length: 1024 }).notNull(),
    decidedByUserId: int("decidedByUserId")
      .notNull()
      .references(() => users.id),
    decidedAt: timestamp("decidedAt").defaultNow().notNull(),
  },
  table => [
    index("agent_record_withdrawals_agent_decided_idx").on(table.agentId, table.decidedAt),
    foreignKey({ columns: [table.agentId], foreignColumns: [agents.id], name: "arw_agent_fk" }),
  ]
);

/**
 * The Owl's Catch: one factual finding a day, chosen by a fixed rule (shared/owlsCatch.ts) and stored with the
 * values its words are made from, so a day's catch can be shown again exactly as it was found. A day with no
 * finding is stored too (rule "none"), so a day is decided once. Public reads only ever read it; the worker's
 * first tick of the UTC day is the only writer.
 */
export const owlsCatch = mysqlTable(
  "owls_catch",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    /** The UTC date, YYYY-MM-DD. */
    catchDate: varchar("catchDate", { length: 10 }).notNull(),
    /** "fleet", "milestone", or "none" for a day with no finding. */
    rule: varchar("rule", { length: 16 }).notNull(),
    /** JSON: the values the words are built from. */
    facts: text("facts").notNull(),
    /** Which read the facts came from. */
    sourceQuery: varchar("sourceQuery", { length: 255 }).notNull(),
    /** JSON array: up to twenty directory entry ids behind a fleet. */
    agentIds: text("agentIds").notNull(),
    selectedAt: timestamp("selectedAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("owls_catch_date_uq").on(table.catchDate)]
);

/**
 * What Nooscape-Checker found when it asked an endpoint that a reviewed agent declares: whether it answered, with
 * which status, how long it took and a fingerprint of the first 4 KiB, with the date (docs/agent-checks-2026-10-16.md).
 * A fact with its date, never a tier, an order or a verdict. Only the checks run writes it, and public reads only read
 * it. Nothing refers to this table and it refers to nothing, so it can be dropped without touching another table.
 */
export const agentChecks = mysqlTable(
  "agent_checks",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agentId", { length: 36 }).notNull(),
    endpointId: varchar("endpointId", { length: 36 }).notNull(),
    /** What was asked. "liveness" is the only kind so far. */
    kind: varchar("kind", { length: 16 }).notNull(),
    checkedAt: timestamp("checkedAt").defaultNow().notNull(),
    /**
     * "answered": a complete HTTP answer, whatever its status. "no_answer": it was asked and did not answer in full.
     * "skipped": it was not asked, or the ask was stopped, for a reason in the rules (robots.txt, the address, the URL).
     */
    outcome: varchar("outcome", { length: 16 }).notNull(),
    /** Why it did not answer or was skipped: a safeFetch reason. Null for an answer. */
    reason: varchar("reason", { length: 32 }),
    statusCode: int("statusCode"),
    latencyMs: int("latencyMs"),
    /** SHA-256 of the first 4 KiB of the answer, in hex. */
    bodySha256: varchar("bodySha256", { length: 64 }),
  },
  table => [
    index("agent_checks_endpoint_idx").on(table.endpointId, table.kind, table.checkedAt),
    index("agent_checks_agent_idx").on(table.agentId, table.kind, table.checkedAt),
  ]
);

/**
 * The fleets and templates of the BNB Chain ERC-8004 registry (docs/bsc-clusters-2026-10-16.md): a registering wallet
 * with `FLEET_MIN` registrations or more, a profile link or a host that many registrations share, and a group of listed
 * entries with the same name, description and endpoint host. One row for each group, with how many registrations are in
 * it. A shared fact with its date, never a score, a tier or a verdict, and BNB stays directory-only. Only the clustering
 * step writes it and nothing refers to it, so it can be dropped without touching another table.
 */
export const bscClusters = mysqlTable(
  "bsc_clusters",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 }).notNull(),
    /** "wallet", "shared_link", "platform_host" or "template"; and "registry", one summary row dated by the last refresh of the rest. */
    kind: varchar("kind", { length: 16 }).notNull(),
    /** The shared fact: the wallet, the SHA-256 of the link, the host, or the template key. */
    clusterKey: varchar("clusterKey", { length: 255 }).notNull(),
    /** A host, or a recorded name cleaned for public text. Null when the group has neither. */
    label: varchar("label", { length: 200 }),
    /** Registrations in the registry that share the fact. */
    memberCount: int("memberCount", { unsigned: true }).notNull(),
    /** How many of them the directory lists. */
    listedCount: int("listedCount", { unsigned: true }).notNull(),
    /** How many registering wallets they come from. Null where it was not counted. */
    walletCount: int("walletCount", { unsigned: true }),
    computedAt: timestamp("computedAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("bsc_clusters_key_uq").on(table.sourceId, table.kind, table.clusterKey),
    index("bsc_clusters_size_idx").on(table.sourceId, table.kind, table.memberCount),
  ]
);

/**
 * What the clustering found about one listed BNB entry (gate G1): the link it was read from, its template key and
 * endpoint host when its registration is inline JSON, and whether it is independent, in a template group or in a wallet
 * fleet. Stored on the entry with its date. Only the clustering step writes it.
 */
export const bscEntryEvidence = mysqlTable(
  "bsc_entry_evidence",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 }).notNull(),
    externalKey: varchar("externalKey", { length: 128 }).notNull(),
    /** The link (SHA-256 of the URI) the evidence was read from. A different link on the registry row means the evidence is old. */
    profileUriHash: varchar("profileUriHash", { length: 64 }).notNull(),
    /** "inline" (decoded from the link itself) or "link_not_read" (a web or ipfs link, which this step does not fetch). */
    readStatus: varchar("readStatus", { length: 24 }).notNull(),
    templateKey: varchar("templateKey", { length: 16 }),
    endpointHost: varchar("endpointHost", { length: 255 }),
    /** "independent", "template_group", "wallet_fleet", "wallet_fleet_and_template_group", or "unread". */
    g1: varchar("g1", { length: 32 }).notNull(),
    /** Listed entries with the same template key, this one included. 1 when it has none. */
    templateSize: int("templateSize", { unsigned: true }).notNull(),
    /** Registrations by the entry's wallet in the whole registry. */
    walletRegistrations: int("walletRegistrations", { unsigned: true }).notNull(),
    readAt: timestamp("readAt").defaultNow().notNull(),
    computedAt: timestamp("computedAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("bsc_entry_evidence_key_uq").on(table.sourceId, table.externalKey),
    index("bsc_entry_evidence_template_idx").on(table.sourceId, table.templateKey),
  ]
);

/**
 * The hosts that 50 or more listed BNB entries declare as the host of their first agent address (docs/bsc-clusters-2026-10-16.md,
 * "Endpoint-host groups"). One row for each host, with the version and the date of the rule that found it. Stored and read by
 * nothing else: the map, the key's total and every public page read `bsc_clusters` only, so these groups draw no light and change
 * no count. Only the clustering step writes it, and it can be dropped without touching another table.
 */
export const bscEndpointHostGroups = mysqlTable(
  "bsc_endpoint_host_groups",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 }).notNull(),
    /** The lower-case host of the first agent address. */
    host: varchar("host", { length: 255 }).notNull(),
    /** Listed entries that declare it. */
    listedCount: int("listedCount", { unsigned: true }).notNull(),
    /** How many registering wallets they come from. */
    walletCount: int("walletCount", { unsigned: true }).notNull(),
    /** The rule that grouped them, such as "endpoint-host/1", and the day the operator adopted that version (YYYY-MM-DD). */
    ruleVersion: varchar("ruleVersion", { length: 32 }).notNull(),
    ruleDate: varchar("ruleDate", { length: 10 }).notNull(),
    computedAt: timestamp("computedAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("bsc_endpoint_host_groups_key_uq").on(table.sourceId, table.host)]
);

/**
 * The nonces the server issued for "Claim this agent" (docs/claims-2026-10-18.md): one row for each message an owner was asked to sign.
 * Only the SHA-256 of a nonce is kept, never the nonce, and a row is used once (`usedAt`) and dies after ten minutes. It holds what the
 * server needs to rebuild the message it issued, so a signature can only be checked against the text the server itself wrote.
 */
export const agentClaimNonces = mysqlTable(
  "agent_claim_nonces",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    /** SHA-256 of the nonce, hex. */
    nonceHash: varchar("nonceHash", { length: 64 }).notNull(),
    /** "claim" or "edit". */
    action: varchar("action", { length: 8 }).notNull(),
    entryId: varchar("entryId", { length: 36 }).notNull(),
    /** The wallet the message names, lower-case. */
    wallet: varchar("wallet", { length: 42 }).notNull(),
    chainId: int("chainId").notNull(),
    /** The edit the message shows, as the canonical JSON the owner signs (docs/claims-2026-10-18.md), for an edit; null for a claim. */
    editText: varchar("editText", { length: 4000 }),
    /** Unix seconds, not a TIMESTAMP: the message is rebuilt from these, and a session time zone must not be able to change its text. */
    issuedAt: int("issuedAt", { unsigned: true }).notNull(),
    expiresAt: int("expiresAt", { unsigned: true }).notNull(),
    usedAt: int("usedAt", { unsigned: true }),
    /** "applied" when the nonce made a claim or an edit, "refused" when it was spent by a verification that failed; null while unused. */
    outcome: varchar("outcome", { length: 8 }),
  },
  table => [
    uniqueIndex("agent_claim_nonces_hash_uq").on(table.nonceHash),
    index("agent_claim_nonces_expiry_idx").on(table.expiresAt),
    index("agent_claim_nonces_edits_idx").on(table.entryId, table.action, table.usedAt),
  ]
);

/**
 * A claim on a directory entry by the wallet the registry says owns it (docs/claims-2026-10-18.md), with the few things the owner has
 * written about it. A claim is the owner's own word, never a tier, a review or a score. `inForceEntryId` is the entry's id while the
 * claim is in force (active or frozen) and null once it is revoked, so a unique index allows one claim in force for an entry and any
 * number of revoked ones. The row is updated in step with the append-only `agent_claim_edits`, which is the public history.
 */
export const agentClaims = mysqlTable(
  "agent_claims",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    entryId: varchar("entryId", { length: 36 }).notNull(),
    inForceEntryId: varchar("inForceEntryId", { length: 36 }),
    protocol: varchar("protocol", { length: 16 }).notNull(),
    chainId: int("chainId").notNull(),
    registry: varchar("registry", { length: 42 }).notNull(),
    tokenId: varchar("tokenId", { length: 80 }).notNull(),
    /** The claiming wallet, lower-case: the owner the registry recorded when the claim was made. */
    wallet: varchar("wallet", { length: 42 }).notNull(),
    /** "active", "frozen" (held by the operator) or "revoked". */
    status: varchar("status", { length: 12 }).notNull(),
    claimedAt: timestamp("claimedAt").notNull(),
    statusChangedAt: timestamp("statusChangedAt").notNull(),
    /** When the registry was last asked who owns the agent, at the claim, at an edit or by the daily check. */
    lastOwnerCheckAt: timestamp("lastOwnerCheckAt").notNull(),
    /** SHA-256 of the signature that made the claim, hex. */
    signatureDigest: varchar("signatureDigest", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }),
    website: varchar("website", { length: 300 }),
    description: varchar("description", { length: 1000 }),
    /** A JSON list of at most five https addresses, or null. */
    links: varchar("links", { length: 2000 }),
  },
  table => [
    uniqueIndex("agent_claims_in_force_uq").on(table.inForceEntryId),
    index("agent_claims_entry_idx").on(table.entryId, table.claimedAt),
    // The cap on claims in force for one wallet counts this index alone.
    index("agent_claims_wallet_idx").on(table.wallet, table.inForceEntryId),
    index("agent_claims_check_idx").on(table.status, table.lastOwnerCheckAt),
  ]
);

/**
 * The public history of the claims, append-only: one row for each claim, edit (a field, with its old and new value), freeze, unfreeze
 * and revocation (including the owner having changed), with the time, the wallet and the digest of the signature behind it. No code
 * updates or deletes a row here (a test fails if one does).
 */
export const agentClaimEdits = mysqlTable(
  "agent_claim_edits",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    /** The order the rows were written in: a timestamp is only to the second, so the history is read by this. */
    seq: bigint("seq", { mode: "number", unsigned: true }).notNull().autoincrement(),
    claimId: varchar("claimId", { length: 36 }).notNull(),
    entryId: varchar("entryId", { length: 36 }).notNull(),
    /** "claim", "edit", "freeze", "unfreeze" or "revoke". */
    kind: varchar("kind", { length: 12 }).notNull(),
    /** The field an edit changed: "name", "website", "description" or "links". */
    field: varchar("field", { length: 16 }),
    oldValue: varchar("oldValue", { length: 2000 }),
    newValue: varchar("newValue", { length: 2000 }),
    /** The wallet behind the row: the signer of a claim or an edit, the new owner on a revocation for a change of owner. */
    wallet: varchar("wallet", { length: 42 }),
    signatureDigest: varchar("signatureDigest", { length: 64 }),
    /** Why a claim was revoked or frozen, in a fixed word such as "owner_changed". Never free text. */
    reason: varchar("reason", { length: 32 }),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("agent_claim_edits_seq_uq").on(table.seq),
    index("agent_claim_edits_entry_idx").on(table.entryId, table.seq),
    index("agent_claim_edits_claim_idx").on(table.claimId, table.seq),
  ]
);

/**
 * API keys (docs/data-access-2026-10-19.md, stage D2): who may call the REST API with a key, and at what tier. The key itself is shown
 * once, when it is made, and is never stored: only its SHA-256, which is enough to find it again because a key is 30 random bytes.
 * No network address is kept here. A revoked key stays, so its usage and its dates can still be read.
 */
export const apiKeys = mysqlTable(
  "api_keys",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    /** SHA-256 of the key, hex. */
    keyHash: varchar("keyHash", { length: 64 }).notNull(),
    /** The start of the key ("nsk_" and six characters), so an owner and the operator can tell keys apart. Not enough to use it. */
    keyPrefix: varchar("keyPrefix", { length: 16 }).notNull(),
    ownerEmail: varchar("ownerEmail", { length: 254 }).notNull(),
    /** "free", "builder" or "pro". The operator sets the paid ones by hand. */
    tier: varchar("tier", { length: 12 }).notNull().default("free"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
    lastUsedAt: timestamp("lastUsedAt"),
  },
  table => [uniqueIndex("api_keys_hash_uq").on(table.keyHash), index("api_keys_email_idx").on(table.ownerEmail, table.revokedAt)]
);

/** What each key asked of the API, one row for a key, a UTC day and an endpoint, counted up as requests are answered. */
export const apiUsage = mysqlTable(
  "api_usage",
  {
    keyId: varchar("keyId", { length: 36 }).notNull(),
    day: date("day", { mode: "string" }).notNull(),
    endpoint: varchar("endpoint", { length: 24 }).notNull(),
    count: int("count", { unsigned: true }).notNull().default(0),
  },
  table => [primaryKey({ name: "api_usage_pk", columns: [table.keyId, table.day, table.endpoint] })]
);

/**
 * Pay per call (docs/data-access-2026-10-19.md, stage D4): one row for each USDC authorization a caller signed for an API call. It holds
 * what is needed to settle it once, to serve its caller again if the answer was lost, and to tell the operator what is unresolved.
 * Never the signature, never a network address. The unique index on the chain, who signed and the nonce they used is what stops one
 * authorization from being settled twice.
 */
export const apiPayments = mysqlTable(
  "api_payments",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    /** The order the rows were written in: a timestamp is only to the second. */
    seq: bigint("seq", { mode: "number", unsigned: true }).notNull().autoincrement(),
    /** The idempotency key sent to the facilitator ("nsc_" and 32 hex characters). */
    paymentId: varchar("paymentId", { length: 36 }).notNull(),
    /** "eip155:5042" (Arc mainnet) or "eip155:5042002" (Arc testnet). */
    network: varchar("network", { length: 20 }).notNull(),
    /** "agent" or "check". */
    endpoint: varchar("endpoint", { length: 12 }).notNull(),
    /** The paying wallet, lower case. */
    payer: varchar("payer", { length: 42 }).notNull(),
    /** The 32-byte nonce the payer chose, 0x and 64 hex. */
    nonce: varchar("nonce", { length: 66 }).notNull(),
    /** USDC base units (six decimals): 5000 is $0.005. */
    amount: int("amount", { unsigned: true }).notNull(),
    /** When the authorization stops being valid, in Unix seconds. */
    validBefore: bigint("validBefore", { mode: "number", unsigned: true }).notNull(),
    /** A hash of what was asked, so a payment is served for that request and no other. */
    subjectHash: varchar("subjectHash", { length: 64 }).notNull(),
    /** "settling" (sent, no answer recorded), "open" (it may still settle), "paid", "refused" (nothing moved) or "closed" (set aside by the operator). */
    status: varchar("status", { length: 10 }).notNull(),
    /** The settlement transaction, once the facilitator named one. */
    transaction: varchar("transaction", { length: 66 }),
    /** Why a payment is refused or still open, in the facilitator's words, cut short. */
    reason: varchar("reason", { length: 200 }),
    /** How many times it was sent to the facilitator, and how many times its answer was served. */
    sends: tinyint("sends", { unsigned: true }).notNull().default(0),
    serves: tinyint("serves", { unsigned: true }).notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("api_payments_seq_uq").on(table.seq),
    uniqueIndex("api_payments_authorization_uq").on(table.network, table.payer, table.nonce),
    index("api_payments_status_idx").on(table.status, table.seq),
  ]
);

/**
 * Watchlists (docs/data-access-2026-10-19.md, stage D5): the listings a key asks to hear about. One row for a key and a listing. `visible` is
 * what was last known of whether the listing is served, so a change is noticed once. No network address, no event, nothing about the owner.
 */
export const apiWatches = mysqlTable(
  "api_watches",
  {
    keyId: varchar("keyId", { length: 36 }).notNull(),
    entryId: varchar("entryId", { length: 36 }).notNull(),
    visible: boolean("visible").notNull().default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [primaryKey({ name: "api_watches_pk", columns: [table.keyId, table.entryId] }), index("api_watches_entry_idx").on(table.entryId)]
);

/**
 * A key's webhook: the one https address its events are sent to. The signing secret is not stored: it is derived from a secret of the
 * server's and this key's id and `secretVersion`, so it can be shown again and rotated by raising the version. `failures` counts deliveries
 * that failed in a row; a webhook that fails too often is turned off (`disabledAt`) until its owner sets it again.
 */
export const apiWebhooks = mysqlTable("api_webhooks", {
  keyId: varchar("keyId", { length: 36 }).primaryKey(),
  url: varchar("url", { length: 500 }).notNull(),
  secretVersion: int("secretVersion", { unsigned: true }).notNull().default(1),
  failures: int("failures", { unsigned: true }).notNull().default(0),
  disabledAt: timestamp("disabledAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

/**
 * One event for one key: the exact JSON that is sent (so every retry sends the same bytes), where it stands, and what the last try got.
 * One row for a key and an event (`eventRef` names the ledger row or the change it came from), so an event is never sent twice by two passes.
 */
export const apiDeliveries = mysqlTable(
  "api_deliveries",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    /** The order the rows were written in. */
    seq: bigint("seq", { mode: "number", unsigned: true }).notNull().autoincrement(),
    keyId: varchar("keyId", { length: 36 }).notNull(),
    eventRef: varchar("eventRef", { length: 96 }).notNull(),
    kind: varchar("kind", { length: 24 }).notNull(),
    entryId: varchar("entryId", { length: 36 }).notNull(),
    body: varchar("body", { length: 4000 }).notNull(),
    /** "pending", "sent" or "dead" (given up after the last try). */
    status: varchar("status", { length: 8 }).notNull().default("pending"),
    attempts: tinyint("attempts", { unsigned: true }).notNull().default(0),
    nextAttemptAt: timestamp("nextAttemptAt").defaultNow().notNull(),
    /** The HTTP status the last try got, or null when it got none. */
    lastStatus: int("lastStatus", { unsigned: true }),
    /** Why the last try failed, in a fixed word (never the receiver's text). */
    lastError: varchar("lastError", { length: 40 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    sentAt: timestamp("sentAt"),
  },
  table => [
    uniqueIndex("api_deliveries_seq_uq").on(table.seq),
    uniqueIndex("api_deliveries_event_uq").on(table.keyId, table.eventRef),
    index("api_deliveries_due_idx").on(table.status, table.nextAttemptAt),
    index("api_deliveries_key_idx").on(table.keyId, table.seq),
  ]
);

/** How far the event pass has read in each ledger (a time, or the last sequence number), so it only ever reads forward. */
export const apiEventCursors = mysqlTable("api_event_cursors", {
  name: varchar("name", { length: 24 }).primaryKey(),
  position: varchar("position", { length: 40 }).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

/**
 * The BNB Chain ERC-8004 reputation registry's feedback, as Nooscape read it (docs/bsc-rater-credibility-2026-10-16.md): one
 * row for each NewFeedback or FeedbackRevoked event, with who sent it, for which agent, and the value. Internal evidence for
 * the rater check; nothing public reads it, and nothing refers to it, so it can be dropped without touching another table.
 */
export const bscFeedbackEvents = mysqlTable(
  "bsc_feedback_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    transactionHash: varchar("transactionHash", { length: 66 }).notNull(),
    logIndex: int("logIndex").notNull(),
    /** "feedback" or "revoked". A revocation names the rating it removes by agent, client and feedbackIndex. */
    kind: varchar("kind", { length: 16 }).notNull(),
    blockNumber: int("blockNumber", { unsigned: true }).notNull(),
    agentId: bigint("agentId", { mode: "number" }).notNull(),
    clientAddress: varchar("clientAddress", { length: 42 }).notNull(),
    feedbackIndex: bigint("feedbackIndex", { mode: "number" }),
    /** The raw int128 value as an exact decimal string; null for a revocation. */
    valueRaw: varchar("valueRaw", { length: 40 }),
    valueDecimals: int("valueDecimals"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("bsc_feedback_event_uq").on(table.transactionHash, table.logIndex),
    index("bsc_feedback_agent_idx").on(table.agentId),
    index("bsc_feedback_client_idx").on(table.clientAddress),
  ]
);

/**
 * What the rater check found about one rated BNB agent: how many raters it has, how many of them are discounted and why, and
 * how many independent ones are left. Stored on the entry with its date as supporting evidence, never a score, a rank or a
 * verdict, and never a reason on its own to promote anything. Only the rater step writes it.
 */
export const bscRaterEvidence = mysqlTable(
  "bsc_rater_evidence",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: varchar("sourceId", { length: 36 }).notNull(),
    externalKey: varchar("externalKey", { length: 128 }).notNull(),
    agentId: bigint("agentId", { mode: "number" }).notNull(),
    /** Ratings not revoked. */
    rawEvents: int("rawEvents", { unsigned: true }).notNull(),
    /** Distinct wallets that sent them. */
    rawRaters: int("rawRaters", { unsigned: true }).notNull(),
    /** Raters that rated 20 or more agents. Counted first, so the four counts below add up to rawRaters. */
    concentratedRaters: int("concentratedRaters", { unsigned: true }).notNull(),
    /** Raters that gave one identical value to nearly everything they rated. */
    uniformRaters: int("uniformRaters", { unsigned: true }).notNull(),
    /** Raters tied to the agent's owner or fleet: the owner's wallet, a fleet wallet, or a wallet that registered an agent with the same link or host. */
    linkedRaters: int("linkedRaters", { unsigned: true }).notNull(),
    /** Raters left after those three. */
    independentRaters: int("independentRaters", { unsigned: true }).notNull(),
    /** Ratings from the independent raters: the others have weight 0. */
    weightedEvents: int("weightedEvents", { unsigned: true }).notNull(),
    /** Registrations by the agent's owner in the whole registry. */
    ownerRegistrations: int("ownerRegistrations", { unsigned: true }).notNull(),
    /** The owner is a fleet wallet (50 registrations or more), so the agent is in a fleet and is not counted. */
    ownerFleet: boolean("ownerFleet").notNull(),
    /** Three independent raters or more, and the owner is not a fleet. Supporting evidence, never a promotion. */
    qualifies: boolean("qualifies").notNull(),
    computedAt: timestamp("computedAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("bsc_rater_evidence_key_uq").on(table.sourceId, table.externalKey),
    index("bsc_rater_evidence_qualifies_idx").on(table.sourceId, table.qualifies),
  ]
);

/** Where the reputation read stands: the next block to scan and the registry implementation it was checked against. One row. */
export const bscReputationState = mysqlTable("bsc_reputation_state", {
  id: varchar("id", { length: 16 }).primaryKey(),
  nextBlock: int("nextBlock", { unsigned: true }).notNull(),
  finalizedBlock: int("finalizedBlock", { unsigned: true }),
  /** The ERC-1967 implementation the registry showed on the last run. */
  implementation: varchar("implementation", { length: 42 }),
  /** When the ratings were last recomputed from the ledger. */
  evaluatedAt: timestamp("evaluatedAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type IngestionSource = typeof ingestionSources.$inferSelect;
export type InsertIngestionSource = typeof ingestionSources.$inferInsert;
export type IngestionRun = typeof ingestionRuns.$inferSelect;
export type SourceObservation = typeof sourceObservations.$inferSelect;
export type Agent = typeof agents.$inferSelect;
