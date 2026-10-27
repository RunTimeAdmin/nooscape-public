import { TRPCError } from "@trpc/server";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  approvePublisherKeyPolicy,
  breakdownAgentDirectoryByProtocol,
  readChainStats,
  readChainStatsWithExtras,
  readDirectoryArrivals,
  readNoosphereSample,
  completeDomainVerification,
  configureIngestionWorker,
  countAgentDirectoryEntries,
  countAgentDirectoryMintMeasured,
  countAgentDirectoryRegistrants,
  countRunLinkedPublicSnapshots,
  createIngestionSource,
  createDomainVerificationChallenge,
  decideIngestionSource,
  decideRecordWithdrawal,
  decideSourceProjection,
  getCompletedRunForSource,
  getAgentDirectoryEntry,
  getDirectoryEntryById,
  getDomainVerificationChallenge,
  getOrCreateIngestionWorkerConfig,
  getPublisherKeyById,
  getLiveAtlasProvenanceCoverage,
  getIngestionSource,
  getLatestCompletedRunForSource,
  getLatestSourceObservation,
  hideDirectoryEntry,
  listActiveWithdrawnAgentIds,
  listDomainChallenges,
  listHiddenDirectoryEntries,
  listIngestionSources,
  listLiveAtlasRecords,
  listMapAcknowledgedSample,
  listAgentEvidenceTimeline,
  listAgentDirectoryWallets,
  listNewestGatedSnapshotSummaries,
  listPublisherKeyPolicies,
  listPublicIngestionSourceStatuses,
  listRecordWithdrawalEvents,
  listReviewItems,
  listSourceProjectionDecisions,
  listLatestRunObservationsForReview,
  MAX_RUN_REVIEW_OBSERVATIONS,
  readAgentDirectoryActivityDaySeries,
  readAgentDirectoryActivityFeed,
  readSolanaActivityFeed,
  readSolanaActivityTotals,
  readAgentDirectoryActivityTotals,
  readAgentDirectoryFunnelCounts,
  readUsdgSettlementTotals,
  recheckDomainVerification,
  revokePublisherKeyPolicy,
  searchAgentDirectory,
  stagePublisherKeyPolicy,
  unhideDirectoryEntry,
} from "../db";
import { readBscRegistryProfile, readRegistryCounts } from "../agentRegistryRows";
import { extraChainsOn, extraProtocolOf, type ChainStat, type ExtraChainKey, type ExtraChainStat, type RegistryProfile } from "@shared/chains";
import { readCatchArchive, readCatchForDate, readTodaysCatch, unavailableCatch } from "../owlsCatch";
import { storagePut, verifyStoredObject } from "../storage";
import { isCatchDate } from "@shared/owlsCatch";
import { validateA2aSourceRoot } from "../ingestion/a2a";
import { runApprovedA2aSource } from "../ingestion/runA2a";
import { runApprovedAgenstrySource } from "../ingestion/runAgenstry";
import { runApprovedAgentEconomySource } from "../ingestion/runAgentEconomy";
import { runApproved8004SolanaSource } from "../ingestion/run8004Solana";
import { runApprovedSaidSource } from "../ingestion/runSaid";
import { runApprovedAgencSource } from "../ingestion/runAgenc";
import { AGENC_CHAIN_SOURCE_KEY } from "../ingestion/agencChain";
import { runApprovedBscRegistrySource } from "../ingestion/runBsc";
import { BSC_ALLOWED_HOSTNAME, BSC_ROOT_URL, BSC_SOURCE_KEY, BscRegistryValidationError } from "../ingestion/bscChain";
import { BscRpcError, BscRpcNotConfiguredError } from "../ingestion/bscRpc";
import { runApprovedErc8004ChainSource } from "../ingestion/runErc8004Chain";
import { Erc8004ChainOffError } from "../ingestion/erc8004Chain";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN, erc8004ChainOfProtocol } from "../ingestion/erc8004Chains";
import { Erc8004RpcNotConfiguredError } from "../ingestion/erc8004Rpc";
import { chainSourcePreset } from "../ingestion/chainPresets";
import { runApprovedMetaplexRegistrySource } from "../ingestion/runMetaplex";
import { METAPLEX_LIST_URL } from "../ingestion/metaplex";
import { runApprovedRobinhoodRegistrySource } from "../ingestion/runRobinhood";
import { runApprovedRobinhoodReputationSource } from "../ingestion/runRobinhoodReputation";
import { runApprovedUsdgSettlementSource } from "../ingestion/runUsdg";
import { ROBINHOOD_RPC_URL, RobinhoodWalkModeRefusedError } from "../ingestion/robinhood";
import { runRateLimitedIngestionTick } from "../ingestion/worker";
import { readPublicChecks, runLivenessChecks } from "../agentChecks";
import { runWebhookPass } from "../webhookPass";
import { EMPTY_MAP_FLEETS, EMPTY_REGISTRY_FLEETS } from "@shared/mapFleets";
import { readMapFleets } from "../mapFleets";
import { readRegistryFleets } from "../registryFleets";
import {
  buildDomainProofUrl,
  createDomainVerificationToken,
  fetchDomainControlProof,
  hashDomainVerificationToken,
  normalizeHttpsDomain,
} from "../domainVerification";
import {
  supportedPublisherProtocols,
  validatePublisherKeyProof,
  validatePublisherRotationProof,
} from "../publisherVerification";
import { getPublicEcosystemContext } from "../censusContext";
import { operatorProcedure, publicProcedure, router } from "../_core/trpc";
import { isCircuitOpenError } from "../dbBreaker";
import { describeFailure, driverErrorHas, noteSectionFailure } from "../driverErrors";
import { OperatorRuleError } from "../operatorRuleError";

const sourceRegistrationInput = z.object({
  label: z.string().trim().min(3).max(160),
  rootUrl: z.string().trim().url().max(2048),
  scheduleMinutes: z.number().int().min(5).max(1_440).default(15),
});

const approvedPublicSources = {
  agenstry: {
    sourceKey: "agenstry-public-catalog",
    label: "Agenstry public federation catalog",
    protocol: "catalog" as const,
    rootUrl: "https://agenstry.com/api/feed/all.jsonl.gz",
    allowedHostname: "agenstry.com",
    // The documented anonymous feed permits six requests/hour. A 24-hour cadence
    // keeps the first population wave deliberately below that boundary.
    scheduleMinutes: 1_440,
  },
  agentEconomy: {
    sourceKey: "agent-economy-public-census",
    label: "Agent Economy public aggregate census",
    protocol: "census" as const,
    rootUrl: "https://agenteconomy.to/data.json",
    allowedHostname: "agenteconomy.to",
    // Upstream freshness claims differ, so begin daily and revise only after an
    // observed cadence review.
    scheduleMinutes: 1_440,
  },
  metaplex: {
    sourceKey: "metaplex-solana-agent-registry",
    label: "Metaplex public Solana agent registry",
    protocol: "solana_registry" as const,
    rootUrl: METAPLEX_LIST_URL,
    allowedHostname: "api.metaplex.com",
    // No cron path: this feed is staged, reviewed, and fetched only by an operator.
    executionPolicy: "manual_only" as const,
    scheduleMinutes: 1_440,
  },
  robinhood: {
    sourceKey: "robinhood-erc8004-identity-registry",
    label: "Robinhood Chain ERC-8004 identity registry",
    protocol: "erc8004" as const,
    rootUrl: ROBINHOOD_RPC_URL,
    allowedHostname: "rpc.mainnet.chain.robinhood.com",
    // No cron path: one bounded on-chain log window is staged, reviewed, and
    // fetched only by an operator.
    executionPolicy: "manual_only" as const,
    scheduleMinutes: 1_440,
  },
  usdgSettlements: {
    sourceKey: "robinhood-usdg-settlements",
    label: "Robinhood Chain USDG settlement ledger",
    protocol: "usdg_settlement" as const,
    rootUrl: ROBINHOOD_RPC_URL,
    allowedHostname: "rpc.mainnet.chain.robinhood.com",
    // No cron path: one bounded settlement window (one receipt per settlement)
    // is staged, reviewed, and walked only by an operator. Ledger facts only —
    // settlement runs can never add reviewed records.
    executionPolicy: "manual_only" as const,
    scheduleMinutes: 1_440,
  },
  robinhoodReputation: {
    sourceKey: "robinhood-erc8004-reputation-registry",
    label: "Robinhood Chain ERC-8004 reputation registry",
    protocol: "erc8004_reputation" as const,
    rootUrl: ROBINHOOD_RPC_URL,
    allowedHostname: "rpc.mainnet.chain.robinhood.com",
    // No cron path: one bounded ratings window is staged, reviewed, and walked
    // only by an operator. Chain-anchored opinion facts only — ratings runs
    // can never add reviewed records and never blend scores across raters.
    executionPolicy: "manual_only" as const,
    scheduleMinutes: 1_440,
  },
  solana8004: {
    sourceKey: "solana-8004-agent-registry",
    label: "8004 Solana agent registry",
    protocol: "solana_8004" as const,
    // The registry's machine surface is Solana mainnet itself: production
    // chain reads resolve the env-configured provider through the shared
    // paced Solana RPC client (the same keyed endpoint the Metaplex chain
    // pass uses); the row records the canonical public RPC the program was
    // live-verified against (1,504 of 1,504 accounts, 2026-10-11).
    rootUrl: "https://api.mainnet-beta.solana.com",
    allowedHostname: "api.mainnet-beta.solana.com",
    // No cron path at birth: the chain pass is staged, reviewed, and driven
    // only by an operator — seed inventory first, then diff passes.
    executionPolicy: "manual_only" as const,
    scheduleMinutes: 1_440,
  },
  said: {
    sourceKey: "solana-said-agent-registry",
    label: "SAID Solana agent registry",
    protocol: "solana_said" as const,
    // Like the 8004 and Metaplex passes, the registry's machine surface is
    // Solana mainnet itself, read through the shared paced RPC client; the
    // row records the canonical public RPC the program was live-verified
    // against (13,313 of 13,313 AgentIdentity accounts, 2026-10-13). SAID's
    // own HTTP API is not a source of this row: its scores are SAID-computed
    // and its screen endpoint is paid.
    rootUrl: "https://api.mainnet-beta.solana.com",
    allowedHostname: "api.mainnet-beta.solana.com",
    // No cron path at birth: staged, seeded, and reviewed by an operator
    // first; the scheduled flip is a separate reviewed migration.
    executionPolicy: "manual_only" as const,
    scheduleMinutes: 1_440,
  },
  agenc: {
    sourceKey: AGENC_CHAIN_SOURCE_KEY,
    label: "AgenC Solana agent registry",
    protocol: "solana_agenc" as const,
    // Like the SAID, 8004 and Metaplex passes, the registry's machine surface is Solana mainnet itself, read through the shared paced RPC
    // client; the row records the canonical public RPC the program was live-verified against (256 of 256 AgentRegistration accounts,
    // 2026-10-26). AgenC's own HTTP API is not a source of this row: its feeds are hosted, its robots.txt disallows /api/ to crawlers,
    // and the chain is the source of truth.
    rootUrl: "https://api.mainnet-beta.solana.com",
    allowedHostname: "api.mainnet-beta.solana.com",
    // No cron path at birth: staged, run and compared to the chain by an operator first; the scheduled flip is a separate reviewed migration.
    executionPolicy: "manual_only" as const,
    scheduleMinutes: 1_440,
  },
  bsc: {
    sourceKey: BSC_SOURCE_KEY,
    label: "BNB Smart Chain ERC-8004 identity registry",
    protocol: "erc8004_bsc" as const,
    // The registry is the same contract as on Robinhood Chain. The row records
    // the provider HOST the pass may talk to; the keyed endpoint itself lives
    // only in the BSC_RPC_URL environment variable, never in the database. The
    // pass reads only the registry's own events from finalized blocks and never
    // fetches an agent URI (operator decisions D1 and D2, 2026-10-13).
    rootUrl: BSC_ROOT_URL,
    allowedHostname: BSC_ALLOWED_HOSTNAME,
    // No cron path at birth: staged, seeded (about 36 runs for the backfill,
    // and nothing reaches the directory until the last one publishes), and
    // reviewed by an operator first; the scheduled flip is a separate reviewed
    // migration.
    executionPolicy: "manual_only" as const,
    scheduleMinutes: 1_440,
  },
} as const;

/**
 * The chains of the identity pass that have a switch (docs/multichain-erc8004-2026-10-20.md), by the name the staging action gives them.
 * Their sources are made from the chain's entry (ingestion/chainPresets.ts), not from a constant here.
 */
const switchedChains = { ethereum: ETHEREUM_CHAIN, base: BASE_CHAIN, arc: ARC_CHAIN } as const;

/** The preset for one of them, with the two refusals it can make (switched off; endpoint not set) put to the operator as what they are. */
function stageableChainSource(name: keyof typeof switchedChains) {
  try {
    return chainSourcePreset(switchedChains[name]);
  } catch (error) {
    // Both messages are fixed and name a switch or a variable, never a value.
    if (error instanceof Erc8004ChainOffError || error instanceof Erc8004RpcNotConfiguredError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
    throw error;
  }
}

const publisherKeyInput = z.object({
  identityId: z.string().uuid(),
  issuerName: z.string().trim().min(3).max(255),
  publicKeyPem: z.string().trim().min(64).max(8_192),
  permittedDomainRoots: z.array(z.string().trim().url().max(2_048)).min(1).max(20),
  permittedProtocols: z.array(z.enum(supportedPublisherProtocols)).min(1).max(supportedPublisherProtocols.length),
  policyVersion: z.string().trim().min(1).max(64),
  expiresAt: z.string().datetime().nullable().optional(),
  attestationSignature: z.string().trim().min(16).max(4_096),
  rotation: z
    .object({
      previousKeyId: z.string().uuid(),
      rotationSignature: z.string().trim().min(16).max(4_096),
    })
    .optional(),
});

function databaseFailure(error: unknown): never {
  // A rule of the product that refused the operator's request is said as it is: its message is written for the operator and carries
  // nothing of the database, and it is not a storage failure to log.
  if (error instanceof OperatorRuleError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
  // The driver message can carry schema, constraint, or query details; the
  // server logs it in full while every client gets the same fixed summary.
  if (!isCircuitOpenError(error)) console.error(`[LiveData] storage failure: ${describeStorageFailure(error)}`);
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Live data is temporarily unavailable." });
}

/**
 * A public read that failed and answered its empty value: the cause goes to the log, unless the breaker has already said the database is
 * paused, so that a timeout or a deadlock does not pass for missing data. The client is told nothing of it.
 */
function logReadFailure(label: string, error: unknown): void {
  if (!isCircuitOpenError(error)) console.warn(`[LiveData] ${label} read failed:`, describeStorageFailure(error));
}

/** The driver's message and code for the log, and the causes Drizzle wraps, on one line and without the parameters it appends (server/driverErrors.ts). */
function describeStorageFailure(error: unknown): string {
  return describeFailure(error);
}

/**
 * Operator API for the bounded ingestion pilot. It exposes an approved-source
 * registry, publisher-key policy gates, and one rate-limited worker; no public
 * request can create a fetch target or alter trust/publisher policy. Census
 * governance decisions (per-record withdrawal and reinstate) are operator-gated
 * and recorded as immutable evidence.
 */
export const liveDataRouter = router({
  availability: publicProcedure.query(async () => {
    try {
      const [sources, worker] = await Promise.all([listIngestionSources(), getOrCreateIngestionWorkerConfig()]);
      return {
        persistentStorageConfigured: true,
        activeSourceCount: sources.filter(source => source.state === "active").length,
        scheduledIngestionEnabled: worker.state === "enabled",
        supportedProtocols: ["a2a", "catalog", "census", "solana_registry", "solana_8004", "erc8004"],
      } as const;
    } catch (error) {
      // Keep the public health response non-sensitive while making a production
      // database configuration failure visible in server-side runtime logs.
      if (!isCircuitOpenError(error)) console.warn("[LiveData] Availability check failed:", describeStorageFailure(error));
      return {
        persistentStorageConfigured: false,
        activeSourceCount: 0,
        scheduledIngestionEnabled: false,
        supportedProtocols: ["a2a", "catalog", "census", "solana_registry", "solana_8004", "erc8004"],
      } as const;
    }
  }),
  publicRecords: publicProcedure.query(async () => {
    try {
      return { records: await listLiveAtlasRecords() };
    } catch (error) {
      logReadFailure("Public records", error);
      return { records: [] };
    }
  }),
  publicCoverage: publicProcedure.query(async () => {
    try {
      return await getLiveAtlasProvenanceCoverage();
    } catch (error) {
      logReadFailure("Public coverage", error);
      // Keep the public dashboard fail-closed: no operational database detail
      // is exposed if a coverage query cannot be evaluated.
      return { publicRecordCount: 0, provenanceReadyCount: 0, coveragePercent: 0 } as const;
    }
  }),
  // The directory is an unreviewed acknowledgement surface: locator-class facts
  // only, never evidence trust or tiers. The one place it reaches the map is
  // `mapAcknowledged` below, as a labelled sample. Both queries fail closed.
  directorySearch: publicProcedure
    .input(z.object({ query: z.string().trim().min(2).max(64), limit: z.number().int().min(1).max(25).default(12) }))
    .query(async ({ input }) => {
      try {
        return await searchAgentDirectory({ query: input.query, limit: input.limit });
      } catch (error) {
        logReadFailure("Directory search", error);
        return { entries: [], matchedTotal: 0 };
      }
    }),
  // A single acknowledged entry for the public agent page. Locator-class facts
  // only; fail closed like the other directory queries.
  directoryEntry: publicProcedure
    .input(z.object({ id: z.string().min(1).max(36) }))
    .query(async ({ input }) => {
      try {
        return { entry: await getAgentDirectoryEntry(input.id) } as const;
      } catch (error) {
        logReadFailure("Directory entry", error);
        return { entry: null } as const;
      }
    }),
  // The public agent page source, in one read. Uniform shape so one page can
  // render both layers: the reviewed record (with its evidence timeline) when
  // the id is in the served set, else the acknowledged entry. A reviewed record
  // also carries the latest checks of the endpoints it declares (an empty list
  // when it declares none or they cannot be read). Fails closed to "none" like
  // every other public read.
  agentProfile: publicProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      try {
        const records = await listLiveAtlasRecords();
        const record = records.find(item => item.agentId === input.id) ?? null;
        const timeline = record ? await listAgentEvidenceTimeline(input.id) : [];
        const entry = record ? null : await getAgentDirectoryEntry(input.id);
        // Only a reviewed record has checks, and the read never throws, so it cannot take the record down with it.
        const checks = record ? await readPublicChecks(input.id) : [];
        return {
          kind: record ? ("reviewed" as const) : entry ? ("acknowledged" as const) : ("none" as const),
          record,
          timeline,
          entry,
          checks,
        };
      } catch (error) {
        // The page then says "No agent found", which is also what an unknown id gets, so the cause goes to the server log:
        // a failed read of a real agent must not look like a missing one with nothing to find afterwards.
        if (!isCircuitOpenError(error)) console.warn("[LiveData] Agent profile read failed:", describeStorageFailure(error));
        return { kind: "none" as const, record: null, timeline: [], entry: null, checks: [] };
      }
    }),
  directoryTotal: publicProcedure.query(async () => {
    try {
      return { total: await countAgentDirectoryEntries() };
    } catch (error) {
      logReadFailure("Directory total", error);
      return { total: 0 };
    }
  }),
  // The acknowledgement ledger in one read: the total plus its protocol split.
  // Locator-class facts only; fail closed like the other directory queries.
  directoryBreakdown: publicProcedure.query(async () => {
    try {
      const [total, byProtocol] = await Promise.all([
        countAgentDirectoryEntries(),
        breakdownAgentDirectoryByProtocol(),
      ]);
      return { total, byProtocol } as const;
    } catch (error) {
      logReadFailure("Directory breakdown", error);
      return { total: 0, byProtocol: [] } as const;
    }
  }),
  // Wallet concentration over ERC-8004 acknowledgements: the registering
  // wallets behind the most registered agents. A wallet here paid the
  // registration transactions on-chain — it is not a verified operator.
  // Fails closed to empty like the other directory queries.
  // The per-chain figures for the Home chain tabs (Robinhood, Solana, BNB). Built only from reads that
  // already apply the public rules; fails closed to no chains rather than to zeros.
  // While no extra chain is on the answer is the three rows and nothing else, as it was before they existed. With one on, `extras`
  // carries a row for each chain that is on (docs/multichain-erc8004-2026-10-20.md); the three rows are not changed by it.
  chainStats: publicProcedure.query(async (): Promise<{ chains: ChainStat[]; extras?: ExtraChainStat[] }> => {
    try {
      const extras = extraChainsOn(process.env.VITE_FEATURES);
      if (extras.length === 0) return { chains: await readChainStats() };
      // A registry's counts that cannot be read leave that chain's sentence out; they do not fail the tabs.
      const profiles: Partial<Record<ExtraChainKey, RegistryProfile | null>> = {};
      await Promise.all(extras.map(async chain => void (profiles[chain] = await readRegistryCounts(extraProtocolOf(chain)).catch(() => null))));
      return await readChainStatsWithExtras(extras, profiles);
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] Chain stats read failed:", describeStorageFailure(error));
      return { chains: [] };
    }
  }),
  // What entered the directory in the last 24 hours, per chain, and the newest few by name: the Home page's "new to the
  // Owl" lines. Counts of visible entries by their own first-seen time; fails closed to no figures, never to zeros.
  arrivals: publicProcedure.query(async () => {
    try {
      return { arrivals: await readDirectoryArrivals() } as const;
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] Arrivals read failed:", describeStorageFailure(error));
      return { arrivals: null } as const;
    }
  }),
  // The Noosphere sample for the Home hero: lights for the registered agents, the reviewed records as steady
  // ones and the registering-wallet fleets. Built only from reads that already apply the public rules; fails
  // closed to no sample, so the hero draws nothing in its place.
  noosphereSample: publicProcedure.query(async () => {
    try {
      return { sample: await readNoosphereSample() } as const;
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] Noosphere sample read failed:", describeStorageFailure(error));
      return { sample: null } as const;
    }
  }),
  // The Owl's Catch: one factual finding a day, chosen by a fixed rule from the directory's own counts and stored
  // with the values its words are made from (shared/owlsCatch.ts). Read-only here: only the worker's first tick of
  // the UTC day writes. Each fails closed, to no catch, so the page says "No catch today" and invents nothing.
  owlsCatch: publicProcedure.query(async () => {
    try {
      return await readTodaysCatch();
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] Owl's Catch read failed:", describeStorageFailure(error));
      return unavailableCatch();
    }
  }),
  owlsCatchArchive: publicProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).optional()).query(async ({ input }) => {
    try {
      return { catches: await readCatchArchive(input?.limit ?? 30) } as const;
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] Owl's Catch archive read failed:", describeStorageFailure(error));
      return { catches: [] } as const;
    }
  }),
  owlsCatchByDate: publicProcedure.input(z.object({ date: z.string().refine(isCatchDate, "Not a date") })).query(async ({ input }) => {
    try {
      return { catch: await readCatchForDate(input.date) } as const;
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] Owl's Catch read failed:", describeStorageFailure(error));
      return { catch: null } as const;
    }
  }),
  directoryWalletCensus: publicProcedure.query(async () => {
    try {
      return { wallets: await listAgentDirectoryWallets(12) } as const;
    } catch (error) {
      logReadFailure("Wallet census", error);
      return { wallets: [] } as const;
    }
  }),
  // What fills the BNB Chain ERC-8004 registry, as counts over recorded facts:
  // how many registrations the chain holds, how many the listing rules publish
  // into the directory, and how many are held out and why. Null until an
  // operator has approved the BNB Chain source. Facts only: Nooscape fetched no
  // profile link. Fails closed to null like the other directory queries.
  directoryBscRegistry: publicProcedure.query(async () => {
    try {
      return { profile: await readBscRegistryProfile() } as const;
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] BNB Chain registry profile read failed:", describeStorageFailure(error));
      return { profile: null } as const;
    }
  }),
  // A fixed sample of the registrations the directory lists on BNB Chain, and how
  // many it lists in all, for the home map. They are acknowledged entries, never
  // reviewed records: the map draws them hollow and says so, and the sample is
  // picked by a rule that ignores quality (the ids that hash lowest). Fails
  // closed to an empty sample, so the map is then exactly the reviewed records.
  mapAcknowledged: publicProcedure.query(async () => {
    try {
      return { chain: "bnb" as const, ...(await listMapAcknowledgedSample("erc8004_bsc")) };
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] map acknowledged sample read failed:", describeStorageFailure(error));
      return { chain: "bnb" as const, entries: [], listed: 0 };
    }
  }),
  // The BNB Chain fleets and templates for the home map: the largest groups of
  // registrations that share a wallet, a profile link, a host or a registration
  // template, each with its count, from the groups the clustering step stores
  // (docs/bsc-fleet-lights-2026-10-16.md). No registration is returned, only the
  // shared fact. Fails closed to no groups, which is also what it answers until
  // migration 0038 is run, so the map is then exactly what it was.
  mapFleets: publicProcedure.query(async () => {
    try {
      return await readMapFleets();
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] map fleets read failed:", describeStorageFailure(error));
      return EMPTY_MAP_FLEETS;
    }
  }),
  // The groups behind the formations on an extra chain's own page (Arc and Base): the registering wallets, hosts and profile links that 50 or
  // more of its registrations share, from the registry rows (docs/chain-worlds-2026-10-20.md). No registration is returned, only the
  // shared fact. Fails closed to no groups, which is also what it answers while the chain's switch is off or before its first
  // complete pass has published.
  registryFleets: publicProcedure.input(z.object({ chain: z.enum(["arc", "base", "ethereum"]) })).query(async ({ input }) => {
    try {
      if (!extraChainsOn(process.env.VITE_FEATURES).includes(input.chain)) return EMPTY_REGISTRY_FLEETS;
      return await readRegistryFleets(input.chain);
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] registry fleets read failed:", describeStorageFailure(error));
      return EMPTY_REGISTRY_FLEETS;
    }
  }),
  // The same fixed sample of listed entries the home map draws for BNB Chain, for an extra chain's own page: acknowledged entries,
  // never reviewed records, picked by a rule that ignores quality (the ids that hash lowest). Fails closed to an empty sample.
  chainSample: publicProcedure.input(z.object({ chain: z.enum(["arc"]) })).query(async ({ input }) => {
    try {
      if (!extraChainsOn(process.env.VITE_FEATURES).includes(input.chain)) return { entries: [], listed: 0 };
      return await listMapAcknowledgedSample("erc8004_arc");
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] chain sample read failed:", describeStorageFailure(error));
      return { entries: [], listed: 0 };
    }
  }),
  // Rail-level totals over the measured USDG settlements: counts, the median
  // value, the micropayment share, and block coverage. Rail facts only — no
  // attribution number, because no bounded scan has yet resolved settlement
  // participants to registry identities (2026-10-10 probe: zero overlap).
  // Null totals keep the money panel absent rather than showing false zeros;
  // fails closed like the other directory queries.
  directoryUsdgSettlements: publicProcedure.query(async () => {
    try {
      return { totals: await readUsdgSettlementTotals() } as const;
    } catch (error) {
      logReadFailure("USDG settlements", error);
      return { totals: null } as const;
    }
  }),
  // The public What-changed surface: the newest measured identity-registry
  // events (mints, hand-outs vs later changes of hands, profile-link edits),
  // the per-block-day series since launch, and the totals both derive from.
  // Everything is measured "as of" the activity ledger's high-water block —
  // the walk only moves forward from genesis to its walk point, so the feed
  // is an honest rear-view mirror, not a live ticker. Fails closed to an
  // empty feed, empty series, and null totals.
  directoryActivityFeed: publicProcedure.query(async () => {
    try {
      const [totals, feed, series] = await Promise.all([
        readAgentDirectoryActivityTotals(),
        readAgentDirectoryActivityFeed(),
        readAgentDirectoryActivityDaySeries(),
      ]);
      return { totals, feed, series } as const;
    } catch (error) {
      // Same convention as the availability check: the public response stays
      // fail-closed and non-sensitive, while the swallowed cause (driver code
      // and message) becomes visible in server-side runtime logs.
      if (!isCircuitOpenError(error)) console.warn("[LiveData] Activity feed read failed:", describeStorageFailure(error));
      return { totals: null, feed: [], series: [] } as const;
    }
  }),
  // The Solana registries' anchored events (Metaplex, 8004, SAID): registrations,
  // owner or authority changes, and profile edits, each anchored to the
  // transaction that made it. A separate procedure so the identity-registry
  // feed above stays exactly as it was; a Solana read failure degrades only
  // this section. Fails closed to empty, with the cause in the server log.
  directorySolanaActivity: publicProcedure.query(async () => {
    try {
      const [feed, totals] = await Promise.all([readSolanaActivityFeed(), readSolanaActivityTotals()]);
      return { feed, totals } as const;
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn("[LiveData] Solana activity read failed:", describeStorageFailure(error));
      return { feed: [], totals: [] } as const;
    }
  }),
  // The public honesty funnel: how far an acknowledged agent can travel toward
  // independently proven. Every step is a countable fact; a step Nooscape
  // cannot count yet arrives as null and renders as "not measured yet", never
  // as a false zero. Fails closed to an empty step list.
  directoryFunnel: publicProcedure.query(async () => {
    try {
      const [counts, records] = await Promise.all([readAgentDirectoryFunnelCounts(), listLiveAtlasRecords()]);
      let withRegistrant: number | null = null;
      try {
        withRegistrant = await countAgentDirectoryRegistrants();
      } catch (error) {
        // The registrant migration is still pending; the step stays explicitly
        // unmeasured until the operator applies it and the walk fills it. That case
        // is quiet; any other failure is logged, and the step stays unmeasured too.
        noteSectionFailure("Directory funnel registrant step", error);
      }
      let activityTotals: Awaited<ReturnType<typeof readAgentDirectoryActivityTotals>> | null = null;
      let mintMeasured: number | null = null;
      try {
        activityTotals = await readAgentDirectoryActivityTotals();
        // The mint step counts every listed EVM identity registry (Robinhood Chain
        // and BNB Chain), so it stays a subset of the acknowledged step.
        mintMeasured = await countAgentDirectoryMintMeasured();
      } catch (error) {
        // The chain-activity migration is still pending; the mint step and the
        // activity totals stay explicitly unmeasured until the operator applies
        // 0013 and the activity walk fills them. That case is quiet; any other
        // failure is logged, and the steps stay unmeasured too.
        noteSectionFailure("Directory funnel activity step", error);
      }
      const domainProven = records.filter(
        record => record.evidenceTier === "tier_3" || record.evidenceTier === "tier_4"
      ).length;
      return {
        steps: [
          { key: "acknowledged" as const, value: counts.acknowledged },
          { key: "withLocator" as const, value: counts.withLocator },
          { key: "withRegistrant" as const, value: withRegistrant },
          { key: "withMintMeasured" as const, value: mintMeasured },
          { key: "reviewed" as const, value: records.length },
          { key: "domainProven" as const, value: domainProven },
        ],
        activityTotals,
      } as const;
    } catch (error) {
      logReadFailure("Directory funnel", error);
      return { steps: [], activityTotals: null } as const;
    }
  }),
  ecosystemContext: publicProcedure.query(async () => {
    // Derived aggregate metrics only. The retained raw census document is never
    // sent to the browser and failures return an empty context.
    return { context: await getPublicEcosystemContext() };
  }),
  sourceStatuses: publicProcedure.query(async () => {
    try {
      return { sources: await listPublicIngestionSourceStatuses() };
    } catch (error) {
      logReadFailure("Source statuses", error);
      // The public status surface must fail closed rather than disclose an
      // underlying storage error or source configuration.
      return { sources: [] };
    }
  }),
  admin: router({
    sources: operatorProcedure.query(async () => {
      try {
        const [sources, reviews, projections] = await Promise.all([listIngestionSources(), listReviewItems(), listSourceProjectionDecisions()]);
        // The control plane needs to compare the approved run with the newest
        // completed run per source so unreviewed runs are visible as pending.
        const approvedRuns: Record<string, { finishedAt: Date | null }> = {};
        const latestRuns: Record<string, {
          id: string;
          trigger: string;
          finishedAt: Date | null;
          discoveredCount: number;
          acceptedCount: number;
          rejectedCount: number;
          linkedRecordCount: number;
        }> = {};
        for (const source of sources) {
          const decision = projections.find(projection => projection.sourceId === source.id);
          if (decision?.approvedRunId) {
            const approvedRun = await getCompletedRunForSource(source.id, decision.approvedRunId);
            if (approvedRun) approvedRuns[source.id] = { finishedAt: approvedRun.finishedAt ?? null };
          }
          const latestRun = await getLatestCompletedRunForSource(source.id);
          if (latestRun) {
            latestRuns[source.id] = {
              id: latestRun.id,
              trigger: latestRun.trigger,
              finishedAt: latestRun.finishedAt ?? null,
              discoveredCount: latestRun.discoveredCount,
              acceptedCount: latestRun.acceptedCount,
              rejectedCount: latestRun.rejectedCount,
              linkedRecordCount: await countRunLinkedPublicSnapshots(latestRun.id),
            };
          }
        }
        return { sources, reviews, projections, approvedRuns, latestRuns };
      } catch (error) {
        return databaseFailure(error);
      }
    }),
    registerA2aSource: operatorProcedure.input(sourceRegistrationInput).mutation(async ({ ctx, input }) => {
      const admin = ctx.user;
      const normalized = validateA2aSourceRoot(input.rootUrl);
      try {
        return await createIngestionSource({
          sourceKey: normalized.sourceKey,
          label: input.label,
          protocol: "a2a",
          rootUrl: normalized.rootUrl,
          allowedHostname: normalized.allowedHostname,
          state: "review",
          scheduleMinutes: input.scheduleMinutes,
          createdByUserId: admin.id,
        });
      } catch (error) {
        return databaseFailure(error);
      }
    }),
    registerApprovedPublicSource: operatorProcedure
      .input(z.object({ source: z.enum(["agenstry", "agentEconomy", "metaplex", "robinhood", "usdgSettlements", "robinhoodReputation", "solana8004", "said", "agenc", "bsc", "ethereum", "base", "arc"]) }))
      .mutation(async ({ ctx, input }) => {
        const candidate =
          input.source === "ethereum" || input.source === "base" || input.source === "arc"
            ? stageableChainSource(input.source)
            : approvedPublicSources[input.source];
        try {
          const existing = (await listIngestionSources()).find(source => source.sourceKey === candidate.sourceKey);
          if (existing) return { sourceId: existing.id, state: existing.state, created: false } as const;
          const created = await createIngestionSource({ ...candidate, state: "review", createdByUserId: ctx.user.id });
          return { ...created, state: "review" as const, created: true };
        } catch (error) {
          // The AgenC protocol value reaches the database by hand (migration 0051). Until it has, the database refuses the row, and the
          // operator is told which step is missing instead of that live data is unavailable.
          if (input.source === "agenc" && driverErrorHas(error, "WARN_DATA_TRUNCATED") && describeFailure(error).includes("'protocol'")) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The database does not have the AgenC protocol value yet. Paste migration 0051 first (docs/agenc-solana-2026-10-26.md), then stage the source again." });
          }
          return databaseFailure(error);
        }
      }),
    decideSource: operatorProcedure
      .input(
        z.object({
          sourceId: z.string().uuid(),
          decision: z.enum(["active", "paused", "rejected"]),
          rationale: z.string().trim().min(3).max(1_000),
        })
      )
      .mutation(async ({ ctx, input }) => {
        try {
          const source = await getIngestionSource(input.sourceId);
          if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Ingestion source not found." });
          await decideIngestionSource({ ...input, decidedByUserId: ctx.user.id });
          return { success: true } as const;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          return databaseFailure(error);
        }
      }),
    decideProjection: operatorProcedure
      .input(
        z.object({
          sourceId: z.string().uuid(),
          decision: z.enum(["public", "revoked"]),
          rationale: z.string().trim().min(12).max(1_000),
          runId: z.string().uuid().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        try {
          const source = await getIngestionSource(input.sourceId);
          if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Ingestion source not found." });
          let approvedRunId: string | null = null;
          if (input.decision === "public") {
            if (source.state !== "active" || !source.lastSuccessfulAt) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: "Only an active source with a completed observation can be projected publicly.",
              });
            }
            // Public visibility requires an explicitly reviewed run: implicit
            // approval of the newest completed run risks publishing unreviewed
            // data. The operator control plane must send the runId it verified.
            if (!input.runId) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "A public projection requires an explicit runId identifying the reviewed run.",
              });
            }
            const reviewedRun = await getCompletedRunForSource(input.sourceId, input.runId);
            if (!reviewedRun) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: "The approved run must be a completed run of this source.",
              });
            }
            approvedRunId = reviewedRun.id;
          }
          await decideSourceProjection({
            sourceId: input.sourceId,
            state: input.decision,
            rationale: input.rationale,
            decidedByUserId: ctx.user.id,
            approvedRunId,
          });
          return { success: true, approvedRunId } as const;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          return databaseFailure(error);
        }
      }),
    recordWithdrawals: operatorProcedure.query(async () => {
      try {
        const [ledgerEvents, withdrawnIds] = await Promise.all([listRecordWithdrawalEvents(), listActiveWithdrawnAgentIds()]);
        // Withdrawn records no longer appear in the served set, so the control
        // plane resolves their display identity from the retained reviewed-run
        // snapshots. The newest ledger event per agent carries the reason.
        const summaries = await listNewestGatedSnapshotSummaries(withdrawnIds);
        const summaryByAgent = new Map(summaries.map(summary => [summary.agentId, summary]));
        const latestEventByAgent = new Map<string, (typeof ledgerEvents)[number]>();
        ledgerEvents.forEach(event => latestEventByAgent.set(event.agentId, event));
        return {
          withdrawals: withdrawnIds.map(agentId => {
            const summary = summaryByAgent.get(agentId);
            const event = latestEventByAgent.get(agentId);
            return {
              agentId,
              displayName: summary?.displayName ?? agentId,
              handle: summary?.handle ?? null,
              reason: event?.reason ?? "",
              decidedAt: event?.decidedAt ?? null,
            };
          }),
          ledgerEvents,
        };
      } catch (error) {
        return databaseFailure(error);
      }
    }),
    withdrawRecord: operatorProcedure
      .input(z.object({ agentId: z.string().uuid(), reason: z.string().trim().min(12).max(1_000) }))
      .mutation(async ({ ctx, input }) => {
        try {
          if ((await listActiveWithdrawnAgentIds()).includes(input.agentId)) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This record is already withdrawn." });
          }
          const served = (await listLiveAtlasRecords()).some(record => record.agentId === input.agentId);
          if (!served) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Only a record currently served by the reviewed-run gate can be withdrawn.",
            });
          }
          return await decideRecordWithdrawal({ ...input, action: "withdraw", decidedByUserId: ctx.user.id });
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          return databaseFailure(error);
        }
      }),
    reinstateRecord: operatorProcedure
      .input(z.object({ agentId: z.string().uuid(), reason: z.string().trim().min(12).max(1_000) }))
      .mutation(async ({ ctx, input }) => {
        try {
          if (!(await listActiveWithdrawnAgentIds()).includes(input.agentId)) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This record is not currently withdrawn." });
          }
          return await decideRecordWithdrawal({ ...input, action: "reinstate", decidedByUserId: ctx.user.id });
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          return databaseFailure(error);
        }
      }),
    hiddenDirectoryEntries: operatorProcedure.query(async () => {
      try {
        return { entries: await listHiddenDirectoryEntries() };
      } catch (error) {
        return databaseFailure(error);
      }
    }),
    hideDirectoryEntry: operatorProcedure
      .input(z.object({ entryId: z.string().min(1).max(36) }))
      .mutation(async ({ input }) => {
        try {
          const entry = await getDirectoryEntryById(input.entryId);
          if (!entry) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Directory entry not found." });
          }
          if (entry.hidden) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Directory entry is already hidden." });
          }
          const updated = await hideDirectoryEntry(input.entryId);
          return { success: true, entry: updated };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          return databaseFailure(error);
        }
      }),
    unhideDirectoryEntry: operatorProcedure
      .input(z.object({ entryId: z.string().min(1).max(36) }))
      .mutation(async ({ input }) => {
        try {
          const entry = await getDirectoryEntryById(input.entryId);
          if (!entry) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Directory entry not found." });
          }
          if (!entry.hidden) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Directory entry is not hidden." });
          }
          const updated = await unhideDirectoryEntry(input.entryId);
          return { success: true, entry: updated };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          return databaseFailure(error);
        }
      }),
    verifySourceEvidence: operatorProcedure.input(z.object({ sourceId: z.string().uuid() })).query(async ({ input }) => {
      try {
        const source = await getIngestionSource(input.sourceId);
        if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Ingestion source not found." });
        const observation = await getLatestSourceObservation(input.sourceId);
        if (!observation) throw new TRPCError({ code: "NOT_FOUND", message: "No retained observation found for this source." });
        const storage = await verifyStoredObject(observation.rawObjectKey, observation.contentHash);
        return {
          source: { id: source.id, label: source.label, state: source.state, hostname: source.allowedHostname },
          observation: {
            id: observation.id,
            agentId: observation.agentId,
            canonicalLocator: observation.canonicalLocator,
            contentHash: observation.contentHash,
            contentType: observation.contentType,
            httpStatus: observation.httpStatus,
            validationStatus: observation.validationStatus,
            validationFindings: observation.validationFindings,
            observedAt: observation.observedAt,
          },
          storage,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        return databaseFailure(error);
      }
    }),
    verifySourceEvidenceBatch: operatorProcedure.input(z.object({ sourceId: z.string().uuid() })).query(async ({ input }) => {
      try {
        const source = await getIngestionSource(input.sourceId);
        if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Ingestion source not found." });
        const review = await listLatestRunObservationsForReview(input.sourceId, MAX_RUN_REVIEW_OBSERVATIONS);
        const { observations } = review;
        if (observations.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "No retained observations found for this source." });
        const checks = [];
        for (const observation of observations) {
          checks.push({
            observationId: observation.id,
            agentId: observation.agentId,
            canonicalLocator: observation.canonicalLocator,
            ...(await verifyStoredObject(observation.rawObjectKey, observation.contentHash)),
          });
        }
        return {
          source: { id: source.id, label: source.label, state: source.state, hostname: source.allowedHostname },
          run: review.run && {
            id: review.run.id,
            trigger: review.run.trigger,
            discoveredCount: review.run.discoveredCount,
            acceptedCount: review.run.acceptedCount,
            rejectedCount: review.run.rejectedCount,
            finishedAt: review.run.finishedAt,
          },
          count: checks.length,
          allHashesMatch: checks.every(check => check.hashMatches),
          allGovernanceLocked: checks.every(check => check.retentionMode === "GOVERNANCE" && check.retainUntil !== null),
          checks,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        return databaseFailure(error);
      }
    }),
    domainChallenges: operatorProcedure.query(async () => {
      try {
        return { challenges: await listDomainChallenges() };
      } catch (error) {
        return databaseFailure(error);
      }
    }),
    issueDomainChallenge: operatorProcedure
      .input(z.object({ agentId: z.string().uuid(), domainRoot: z.string().trim().url().max(2048) }))
      .mutation(async ({ ctx, input }) => {
        try {
          const domain = normalizeHttpsDomain(input.domainRoot);
          const token = createDomainVerificationToken();
          const challengeId = randomUUID();
          const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1_000);
          const challenge = await createDomainVerificationChallenge({
            id: challengeId,
            agentId: input.agentId,
            domain,
            tokenHash: hashDomainVerificationToken(token),
            proofUrl: buildDomainProofUrl(domain, challengeId),
            expiresAt,
            createdByUserId: ctx.user.id,
          });
          // The bearer token is intentionally returned only at creation time; only
          // its SHA-256 digest is persisted.
          return {
            ...challenge,
            token,
            instructions: `Publish the exact token as plain text at ${challenge.proofUrl} before ${expiresAt.toISOString()}. This verifies domain control only; it cannot verify publisher identity or service behavior.`,
          };
        } catch (error) {
          return databaseFailure(error);
        }
      }),
    verifyDomainChallenge: operatorProcedure.input(z.object({ challengeId: z.string().uuid() })).mutation(async ({ input }) => {
      try {
        const challenge = await getDomainVerificationChallenge(input.challengeId);
        if (!challenge) throw new TRPCError({ code: "NOT_FOUND", message: "Domain verification challenge not found." });
        if (challenge.state !== "pending" || challenge.expiresAt <= new Date()) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Domain verification challenge is not pending." });
        }
        const proof = await fetchDomainControlProof(challenge.domain, challenge.id, challenge.tokenHash);
        const stored = await storagePut(
          `nooscape/raw/domain-control/${challenge.id}/${proof.proofHash}.txt`,
          proof.proofBody,
          proof.contentType
        );
        return await completeDomainVerification({ challengeId: challenge.id, proofObjectKey: stored.key, proofHash: proof.proofHash });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        return databaseFailure(error);
      }
    }),
    recheckDomainVerification: operatorProcedure.input(z.object({ challengeId: z.string().uuid() })).mutation(async ({ input }) => {
      try {
        const challenge = await getDomainVerificationChallenge(input.challengeId);
        if (!challenge) throw new TRPCError({ code: "NOT_FOUND", message: "Domain verification challenge not found." });
        if (challenge.state !== "verified" || challenge.revokedAt) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only an active verified challenge can be rechecked." });
        }
        // A failed live re-fetch revokes the tier_3 upgrade fail-closed; the
        // outcome field of the result distinguishes renewed from revoked.
        return await recheckDomainVerification({ challengeId: input.challengeId });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        return databaseFailure(error);
      }
    }),
    publisherPolicies: operatorProcedure.query(async () => {
      try {
        return { policies: await listPublisherKeyPolicies() };
      } catch (error) {
        return databaseFailure(error);
      }
    }),
    stagePublisherKey: operatorProcedure.input(publisherKeyInput).mutation(async ({ ctx, input }) => {
      try {
        const proof = validatePublisherKeyProof(input);
        let rotationProofHash: string | undefined;
        let rotationPayload: string | undefined;
        if (input.rotation) {
          const previous = await getPublisherKeyById(input.rotation.previousKeyId);
          if (!previous?.publicKeyPem) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The prior publisher key is unavailable for rotation validation." });
          }
          rotationPayload = validatePublisherRotationProof({
            previousPublicKeyPem: previous.publicKeyPem,
            previousKeyId: previous.id,
            newKeyFingerprint: proof.publicKeyFingerprint,
            newProofHash: proof.proofHash,
            rotationSignature: input.rotation.rotationSignature,
          });
          rotationProofHash = createHash("sha256").update(rotationPayload).digest("hex");
        }
        const retainedProof = JSON.stringify({
          attestation: JSON.parse(proof.canonicalPayload),
          attestationSignature: proof.attestationSignature,
          rotation: input.rotation && rotationPayload
            ? { payload: JSON.parse(rotationPayload), signature: input.rotation.rotationSignature }
            : null,
        });
        const stored = await storagePut(
          `nooscape/raw/publisher-keys/${proof.publicKeyFingerprint.replace(/[^A-Za-z0-9._-]/g, "_")}/${proof.proofHash}.json`,
          retainedProof,
          "application/json"
        );
        return await stagePublisherKeyPolicy({
          identityId: input.identityId,
          proof,
          attestationObjectKey: stored.key,
          rotationOfKeyId: input.rotation?.previousKeyId,
          rotationProofHash,
          createdByUserId: ctx.user.id,
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        return databaseFailure(error);
      }
    }),
    approvePublisherKey: operatorProcedure
      .input(z.object({ keyId: z.string().uuid(), rationale: z.string().trim().min(12).max(1_000) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await approvePublisherKeyPolicy({ ...input, decidedByUserId: ctx.user.id });
        } catch (error) {
          return databaseFailure(error);
        }
      }),
    revokePublisherKey: operatorProcedure
      .input(z.object({ keyId: z.string().uuid(), rationale: z.string().trim().min(12).max(1_000) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await revokePublisherKeyPolicy({ ...input, decidedByUserId: ctx.user.id });
        } catch (error) {
          return databaseFailure(error);
        }
      }),
    workerStatus: operatorProcedure.query(async () => {
      try {
        return await getOrCreateIngestionWorkerConfig();
      } catch (error) {
        return databaseFailure(error);
      }
    }),
    configureWorker: operatorProcedure
      .input(
        z.object({
          state: z.enum(["paused", "enabled"]),
          // Two per tick is the reviewed ceiling: the scheduled sources share the
          // cadence, and each Solana pass is paced by its own RPC client.
          maxSourcesPerTick: z.union([z.literal(1), z.literal(2)]),
          minGlobalIntervalMinutes: z.number().int().min(15).max(1_440),
        })
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await configureIngestionWorker({ ...input, updatedByUserId: ctx.user.id });
        } catch (error) {
          return databaseFailure(error);
        }
      }),
    runWorkerTick: operatorProcedure.mutation(async () => {
      try {
        return await runRateLimitedIngestionTick();
      } catch (error) {
        return databaseFailure(error);
      }
    }),
    // The second cron job: Nooscape-Checker asks the endpoints that reviewed agents declare and records what came back
    // (server/agentChecks.ts, docs/agent-checks-2026-10-16.md). It has its own endpoint because the ingestion tick is at
    // capacity. It answers with counts only and never fails: "unavailable" until the checks table exists, and then
    // nothing is asked of any host.
    runChecks: operatorProcedure.mutation(async () => runLivenessChecks()),
    // The third cron job: webhook deliveries (server/webhookPass.ts, docs/data-access-2026-10-19.md, stage D5). It writes what is new for the
    // listings that keys watch, sends what is due to the addresses their owners gave, and tidies. It answers with counts only. It is "off"
    // until the webhook tables exist and WEBHOOK_SIGNING_KEY is set, and a run that cannot read the database answers "error" and says why
    // only in the log.
    runWebhooks: operatorProcedure.mutation(async () => {
      try {
        return await runWebhookPass();
      } catch (error) {
        console.warn("[Webhooks] pass failed:", describeFailure(error));
        return { status: "error" as const };
      }
    }),
    runSource: operatorProcedure
      .input(z.object({ sourceId: z.string().uuid(), mode: z.enum(["observe", "backfill", "registrants", "activity"]).default("observe") }))
      .mutation(async ({ input }) => {
        try {
          const source = await getIngestionSource(input.sourceId);
          if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Ingestion source not found." });
          if (source.state !== "active") {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Approve the source before running ingestion.",
            });
          }
          if (source.protocol === "a2a") return await runApprovedA2aSource(source, "manual");
          if (source.protocol === "catalog") return await runApprovedAgenstrySource(source, "manual");
          if (source.protocol === "census") return await runApprovedAgentEconomySource(source, "manual");
          if (source.protocol === "solana_registry") {
            // The API pilot (observe) and the on-chain chain pass (activity)
            // are the only Metaplex surfaces; the walk modes have no meaning.
            if (input.mode === "backfill" || input.mode === "registrants") {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "The Metaplex Solana registry supports the observe and activity modes only.",
              });
            }
            return await runApprovedMetaplexRegistrySource(source, "manual", input.mode === "activity" ? "activity" : "observe");
          }
          if (source.protocol === "solana_8004") {
            // The 8004 registry has one surface: the on-chain chain pass
            // (seed inventory until an `s8004:` cursor exists, then diff
            // passes). Observe and the walk modes have no meaning here.
            if (input.mode !== "activity") {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "The 8004 Solana registry supports the chain activity pass only.",
              });
            }
            return await runApproved8004SolanaSource(source, "manual");
          }
          if (source.protocol === "solana_said") {
            // The SAID registry has one surface: the on-chain identity pass
            // (seed inventory until a `said:` cursor exists, then refresh
            // passes). Observe and the walk modes have no meaning here.
            if (input.mode !== "activity") {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "The SAID Solana registry supports the chain activity pass only.",
              });
            }
            return await runApprovedSaidSource(source, "manual");
          }
          if (source.protocol === "solana_agenc") {
            // The AgenC registry has one surface: the on-chain agent pass (inventory until an `agenc:` cursor exists, then refresh passes).
            // Observe and the walk modes have no meaning here.
            if (input.mode !== "activity") {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "The AgenC Solana registry supports the chain activity pass only.",
              });
            }
            return await runApprovedAgencSource(source, "manual");
          }
          if (source.protocol === "erc8004_bsc") {
            // The BNB Chain registry has one surface: the chain pass (a forward
            // walk from the deploy block, then the finalized tail). Observe and
            // the Robinhood walk modes have no meaning here.
            if (input.mode !== "activity") {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "The BNB Chain identity registry supports the chain activity pass only.",
              });
            }
            return await runApprovedBscRegistrySource(source, "manual");
          }
          const chain = erc8004ChainOfProtocol(source.protocol);
          if (chain) {
            // Ethereum, Base and Arc read the same registry the same way (the one chain pass, erc8004Chains.ts): one surface, the chain
            // pass. The pass itself refuses to run while the chain's switch is off.
            if (input.mode !== "activity") {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `The ${chain.chainLabel} identity registry supports the chain activity pass only.`,
              });
            }
            return await runApprovedErc8004ChainSource(chain, source, "manual");
          }
          if (source.protocol === "erc8004") return await runApprovedRobinhoodRegistrySource(source, "manual", input.mode);
          if (source.protocol === "erc8004_reputation") {
            // The ratings walk has no observe or registrants surface: only the
            // backward backfill window and the forward ratings fill exist, and
            // the adapter rejects every position/mode mismatch itself.
            return await runApprovedRobinhoodReputationSource(source, "manual", input.mode === "activity" ? "activity" : "backfill");
          }
          if (source.protocol === "usdg_settlement") return await runApprovedUsdgSettlementSource(source, "manual");
          throw new TRPCError({ code: "BAD_REQUEST", message: `No bounded adapter is available for ${source.protocol}.` });
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          // A walk click the persisted position cannot honor is an operator
          // mistake: say so, instead of the generic storage failure.
          if (error instanceof RobinhoodWalkModeRefusedError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
          // The BNB Chain pass's failures are fixed, URL-free messages by construction (bscRpc.ts), so an operator
          // can be told which one it was. Without this an unset endpoint variable and a provider refusing the key
          // both read as "Live data is temporarily unavailable".
          if (error instanceof BscRpcNotConfiguredError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
          if (error instanceof BscRpcError || error instanceof BscRegistryValidationError) throw new TRPCError({ code: "BAD_GATEWAY", message: error.message });
          // These BNB names are the shared classes, so the same two lines serve Ethereum, Base and Arc. A chain whose switch is off is
          // said to be off, which is not a fault of the node or of live data.
          if (error instanceof Erc8004ChainOffError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
          return databaseFailure(error);
        }
      }),
  }),
});
