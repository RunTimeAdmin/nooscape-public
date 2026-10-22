import express, { Router, type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { CHECK_MIN_TIER, tierAtLeast, type ApiTier } from "@shared/apiKey";
import { listedChainLabel } from "@shared/chains";
import { API_CHAINS, agentIdOfKey, apiChainOfProtocol, servedChains, type ApiChain } from "./apiChains";
import { API_LICENSE } from "./apiLicense";
import { apiV1SpecFor } from "./apiV1Spec";
import { isWebhookPath, sharedWebhookService, webhookRoutes, type WebhookService } from "./apiWebhooks";
import {
  API_TIER_NAMES,
  API_TIERS,
  apiMeter,
  ApiKeyError,
  KEY_ADDRESS_PER_MINUTE,
  KEY_PATTERN,
  readKeyUsage,
  resolveApiKey,
  type ApiKeyRecord,
  type MeterResult,
  type UsageReport,
} from "./apiKeys";
import { checkFlags, checkRequestSchemaFor, CHECK_RESULT_LIMIT, CHECK_STATEMENT, hostOfUrl, type CheckFlagsInput } from "./apiCheck";
import { findVisibleDirectoryEntriesByKey, getAgentDirectoryEntry, listVisibleDirectoryKeys, MAX_AGENT_ENTRY_ACTIVITY_EVENTS, readAgentCheckFacts, searchAgentDirectory } from "./db";
import { isCircuitOpenError } from "./dbBreaker";
import { clientKeyFrom, consumeRateLimit } from "./rateLimit";
import { railsOf, usdOf, type Rail, type Reply, type X402Config, type X402Endpoint } from "./x402";
import { sharedPaymentService, type PayContext, type PaymentService } from "./x402Service";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * The REST API, version 1 (docs/data-access-2026-10-19.md): JSON under /api/v1 that reads the public record and changes none of it,
 * separate from the tRPC the site's own pages use. The public tier needs no key: one agent by chain and registry id, and a search. A free key (stage D2) raises the limit and
 * unlocks a batch lookup, an agent's history and the key's own usage. Every answer says when it was read (`as_of`), where from
 * (`source`) and under what terms (`license`).
 *
 * What it will not do, whoever asks and whatever they pay (the spec's hard rules): change a record, a tier or an evidence level;
 * serve an entry the site hides, a closed entry or one from an inactive source (it reads through the same visibility rule as every
 * public read); show owner-written text without saying it is the owner's word, or at all while a claim is on hold; or say that an
 * agent is safe or unsafe. It states facts with their dates. Two POSTs read from a body and write nothing (the batch lookup and the
 * check). The one place it writes is a Builder or Pro key's own watchlist and webhook (stage D5), in server/apiWebhooks.ts.
 */

export const API_V1_RATE_LIMIT = { requests: 30, windowMs: 60_000 } as const;
export const BATCH_MAX = 25;

export { API_LICENSE };

export { API_CHAINS, agentIdOfKey, apiChainOfProtocol };
export type { ApiChain };

export const BNB_CHECKED_LABEL = "Checked, unproven";
export const BNB_NOT_CHECKED_LABEL = "Not checked";
export const ACKNOWLEDGED_STATEMENT = "Acknowledged means a source listed this agent. It is not a review, a tier or an endorsement, and it does not mean the agent works, is safe or is what it says it is.";
export const OWNER_TEXT_STATEMENT = "Written by the claim holder. Nooscape has not checked it, and it does not change how this entry is listed.";

export const PAGE_ORIGIN = "https://nooscape.si";

type Entry = NonNullable<Awaited<ReturnType<typeof getAgentDirectoryEntry>>>;
type SearchPage = Awaited<ReturnType<typeof searchAgentDirectory>>;

/** What `claim.state` answers (the public procedure), as far as the API reads it. */
export type ClaimStateRead = {
  available: boolean;
  claimable: boolean;
  claim: { status: "active" | "frozen"; wallet: string; claimedAt: Date | string; lastOwnerCheckAt: Date | string; profile: { name: string | null; website: string | null; description: string | null; links: string[] } } | null;
};

/** What `claim.history` answers (the public procedure). Text that was removed, or belongs to a claim on hold, has already been left out. */
export type ClaimHistoryRead = {
  available: boolean;
  claimable: boolean;
  truncated: boolean;
  items: Array<{
    seq: number;
    kind: string;
    field: string | null;
    oldValue: string | null;
    newValue: string | null;
    withheld: boolean;
    wallet: string | null;
    signatureDigest: string | null;
    reason: string | null;
    occurredAt: Date | string;
  }>;
};

/** The keys: who a key is, what a request may do today, and what a key has used. The tables behind it are the database's. */
export type KeyAccess = {
  resolve: (rawKey: string) => Promise<ApiKeyRecord | null>;
  consume: (keyId: string, perDay: number, endpoint: string) => Promise<MeterResult>;
  usage: (record: ApiKeyRecord, days: number) => Promise<UsageReport>;
};

export type ApiV1Deps = {
  now: () => Date;
  findEntries: (protocols: readonly string[], externalKey: string) => Promise<Array<{ id: string; protocol: string; externalKey: string }>>;
  getEntry: (id: string) => Promise<Entry | null>;
  search: (input: { query: string; limit: number; protocols?: readonly string[] }) => Promise<SearchPage>;
  keysOf: (ids: readonly string[]) => Promise<Map<string, string>>;
  claimOf: (entryId: string, req: Request) => Promise<ClaimStateRead | null>;
  claimHistory: (entryId: string, req: Request) => Promise<ClaimHistoryRead | null>;
  /** The ledger facts a check needs beyond the entry: where the identity ledger stands, and the Solana ledger's transfers. */
  checkFacts: (entryId: string) => Promise<CheckFlagsInput["facts"] | null>;
  keys: KeyAccess;
  /** Pay per call (stage D4): null or absent when it is off. */
  payments?: PaymentService | null;
  /** Watchlists and the webhook (stage D5): null or absent when they are off. */
  webhooks?: WebhookService | null;
};

const callerFor = (req: Request) => appRouter.createCaller({ req, res: {}, user: null } as unknown as TrpcContext);

export const defaultApiV1Deps: ApiV1Deps = {
  now: () => new Date(),
  findEntries: findVisibleDirectoryEntriesByKey,
  getEntry: getAgentDirectoryEntry,
  search: searchAgentDirectory,
  keysOf: listVisibleDirectoryKeys,
  // Through the public procedures: this code reads claims the way the site's page does and does not import the claim module.
  claimOf: async (entryId, req) => {
    try {
      return await callerFor(req).claim.state({ entryId });
    } catch {
      return null;
    }
  },
  claimHistory: async (entryId, req) => {
    try {
      return await callerFor(req).claim.history({ entryId });
    } catch {
      return null;
    }
  },
  checkFacts: readAgentCheckFacts,
  keys: {
    resolve: rawKey => resolveApiKey(rawKey),
    consume: (keyId, perDay, endpoint) => apiMeter.consume(keyId, perDay, endpoint),
    usage: (record, days) => readKeyUsage(record, days),
  },
  payments: sharedPaymentService(),
  webhooks: sharedWebhookService(),
};

// ---------------------------------------------------------------- the answers

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

const pageUrl = (entryId: string) => `${PAGE_ORIGIN}/agents/${entryId}`;

export type ApiEnvelope<T> = {
  api_version: "v1";
  as_of: string;
  source: Record<string, unknown>;
  license: typeof API_LICENSE;
  data: T;
};

/** The owner's words for a claim in force, labelled as the owner's, or null when there is none or the claim is on hold. */
function claimBody(state: ClaimStateRead | null) {
  const claim = state?.claim;
  if (!claim) return null;
  const profile = claim.profile;
  const hasText = Boolean(profile.name || profile.website || profile.description || profile.links.length > 0);
  return {
    status: claim.status === "frozen" ? ("on_hold" as const) : ("active" as const),
    wallet: claim.wallet,
    claimed_at: iso(claim.claimedAt),
    last_owner_check_at: iso(claim.lastOwnerCheckAt),
    owner_text: claim.status === "active" && hasText ? { statement: OWNER_TEXT_STATEMENT, name: profile.name, website: profile.website, description: profile.description, links: profile.links } : null,
  };
}

function sourceOf(chain: ApiChain, externalKey: string, entry: Entry) {
  const table = API_CHAINS[chain];
  const activity = (entry as { activity?: { mintBlock: number | null } | null }).activity ?? null;
  return {
    kind: "registry" as const,
    chain,
    chain_id: table.chainId,
    registry: entry.protocol,
    registry_address: table.registry,
    key: externalKey,
    first_seen_at: iso(entry.firstSeenAt),
    last_seen_at: iso(entry.lastSeenAt)!,
    mint_block: activity?.mintBlock ?? null,
  };
}

/** What Nooscape has on record about an agent and what that does not mean: always acknowledged, and on BNB Smart Chain whether its registration was read. */
function evidenceOf(read: { checked: boolean; readAt: Date | string | null } | null) {
  return {
    layer: "acknowledged",
    level: read === null ? null : read.checked ? "checked_unproven" : "not_checked",
    label: read === null ? null : read.checked ? BNB_CHECKED_LABEL : BNB_NOT_CHECKED_LABEL,
    read_at: read?.checked ? iso(read.readAt) : null,
    statement: ACKNOWLEDGED_STATEMENT,
  };
}

/** One agent's facts: what the site's own page shows, with the claim beside it and never in its place. */
function agentData(chain: ApiChain, externalKey: string, entry: Entry, claim: ClaimStateRead | null): Record<string, unknown> {
  const read = (entry as { registrationRead?: { checked: boolean; readAt: Date | string | null } | null }).registrationRead ?? null;
  const related = (entry as { related?: { sameWallet: number; sameName: number; sameHost: number } | null }).related ?? null;
  const activity = (entry as { activity?: { mintBlock: number | null; secondaryTransferCount: number | null; handoutCount: number | null; uriUpdateCount: number | null } | null }).activity ?? null;
  const ratings = (entry as { ratings?: { measuredThroughBlock: number | null; ratingCount: number; activeRatingCount: number; revokedCount: number; responseCount: number } | null }).ratings ?? null;
  const twin = (entry as { twin?: { entryId: string; displayName: string; protocol: string; linkedProtocol: string; metadataKey: string; linkedExternalKey: string } | null }).twin ?? null;
  return {
    chain,
    agent_id: agentIdOfKey(chain, externalKey),
    registry: entry.protocol,
    nooscape_id: entry.id,
    page_url: pageUrl(entry.id),
    name: entry.displayName,
    registrant: entry.registrant,
    locator_host: entry.locatorHost,
    first_seen_at: iso(entry.firstSeenAt),
    last_seen_at: iso(entry.lastSeenAt)!,
    evidence: evidenceOf(read),
    source_note: entry.sourceSignalNote,
    feedback_count: entry.feedbackCount ?? null,
    related: related ? { same_wallet: related.sameWallet, same_name: related.sameName, same_host: related.sameHost } : null,
    activity: activity ? { mint_block: activity.mintBlock, secondary_transfers: activity.secondaryTransferCount, handouts: activity.handoutCount, uri_updates: activity.uriUpdateCount } : null,
    ratings: ratings
      ? { measured_through_block: ratings.measuredThroughBlock, rating_count: ratings.ratingCount, active_rating_count: ratings.activeRatingCount, revoked_count: ratings.revokedCount, response_count: ratings.responseCount }
      : null,
    twin: twin ? { nooscape_id: twin.entryId, name: twin.displayName, registry: twin.protocol, linked_registry: twin.linkedProtocol, metadata_key: twin.metadataKey, linked_key: twin.linkedExternalKey } : null,
    claim: claimBody(claim),
  };
}

/** One agent, from the directory entry the site's own page reads. */
export function agentAnswer(chain: ApiChain, externalKey: string, entry: Entry, claim: ClaimStateRead | null): ApiEnvelope<Record<string, unknown>> {
  const source = sourceOf(chain, externalKey, entry);
  return { api_version: "v1", as_of: source.last_seen_at, source, license: API_LICENSE, data: agentData(chain, externalKey, entry, claim) };
}

export type ApiErrorCode = "bad_request" | "invalid_key" | "key_required" | "tier_required" | "not_found" | "ambiguous" | "method_not_allowed" | "rate_limited" | "quota_exceeded" | "unavailable";

type ApiProblem = { code: ApiErrorCode; message: string; registries?: string[] };

/** One agent's history: the identity's chain events the directory holds, and the public history of its claims. */
export function historyAnswer(chain: ApiChain, externalKey: string, entry: Entry, claimHistory: ClaimHistoryRead | null): ApiEnvelope<Record<string, unknown>> {
  const source = sourceOf(chain, externalKey, entry);
  const events = (entry as { activity?: { events: Array<{ kind: string; blockNumber: number; transactionHash: string; logIndex: number; fromAddress: string | null; toAddress: string | null; isHandout?: boolean }> } | null }).activity?.events ?? [];
  return {
    api_version: "v1",
    as_of: source.last_seen_at,
    source,
    license: API_LICENSE,
    data: {
      chain,
      agent_id: agentIdOfKey(chain, externalKey),
      registry: entry.protocol,
      nooscape_id: entry.id,
      registry_events: events.map(event => ({ kind: event.kind, block_number: event.blockNumber, transaction_hash: event.transactionHash, log_index: event.logIndex, from: event.fromAddress, to: event.toAddress, is_handout: event.isHandout ?? false })),
      registry_events_truncated: events.length >= MAX_AGENT_ENTRY_ACTIVITY_EVENTS,
      claim_history: {
        available: claimHistory?.available ?? false,
        truncated: claimHistory?.truncated ?? false,
        items: (claimHistory?.items ?? []).map(item => ({
          seq: item.seq,
          kind: item.kind,
          field: item.field,
          old_value: item.oldValue,
          new_value: item.newValue,
          withheld: item.withheld,
          wallet: item.wallet,
          signature_digest: item.signatureDigest,
          reason: item.reason,
          occurred_at: iso(item.occurredAt)!,
        })),
      },
    },
  };
}

export type BatchItem = { chain: string; id: string; status: number; as_of: string | null; source: Record<string, unknown> | null; agent: Record<string, unknown> | null; error: ApiProblem | null };

export function batchAnswer(items: BatchItem[], now: Date): ApiEnvelope<Record<string, unknown>> {
  return { api_version: "v1", as_of: now.toISOString(), source: { kind: "batch", requested: items.length }, license: API_LICENSE, data: { results: items } };
}

export function usageAnswer(record: ApiKeyRecord, report: UsageReport, now: Date): Record<string, unknown> {
  const tier = API_TIERS[record.tier];
  return {
    api_version: "v1",
    as_of: now.toISOString(),
    license: API_LICENSE,
    data: {
      key: { prefix: record.prefix, tier: record.tier },
      limits: { per_minute: tier.perMinute, per_day: tier.perDay },
      today: { date: report.today.date, used: report.today.used, remaining: report.today.remaining, limit: report.today.limit, resets_at: report.today.resetsAt.toISOString() },
      days: report.days.map(day => ({ date: day.date, total: day.total, by_endpoint: day.endpoints })),
    },
  };
}

/** One listing's check: who it is, the evidence level, the four flags and the sources they were read from. */
function checkResult(chain: ApiChain, externalKey: string, entry: Entry, facts: CheckFlagsInput["facts"], now: Date) {
  const read = (entry as { registrationRead?: { checked: boolean; readAt: Date | string | null } | null }).registrationRead ?? null;
  const ratings = (entry as { ratings?: { measuredThroughBlock: number | null } | null }).ratings ?? null;
  return {
    agent: {
      chain,
      agent_id: agentIdOfKey(chain, externalKey),
      registry: entry.protocol,
      nooscape_id: entry.id,
      name: entry.displayName,
      registrant: entry.registrant,
      locator_host: entry.locatorHost,
      page_url: pageUrl(entry.id),
    },
    evidence: evidenceOf(read),
    flags: checkFlags({ chain, now, entry: entry as unknown as CheckFlagsInput["entry"], facts }),
    sources: {
      registry: sourceOf(chain, externalKey, entry),
      activity_through_block: facts.activityThroughBlock,
      ratings_measured_through_block: ratings?.measuredThroughBlock ?? null,
      registration_read_at: read?.checked ? iso(read.readAt) : null,
    },
  };
}

export type CheckResult = ReturnType<typeof checkResult>;

export function checkAnswer(subject: { type: "agent" | "wallet" | "url"; value: string; host: string | null }, results: CheckResult[], matchedTotal: number, capped: boolean, now: Date): ApiEnvelope<Record<string, unknown>> {
  return {
    api_version: "v1",
    as_of: now.toISOString(),
    source: { kind: "check", subject: subject.type },
    license: API_LICENSE,
    data: { subject, statement: CHECK_STATEMENT, matched_total: matchedTotal, matched_total_capped: capped, results },
  };
}

export type SearchQuery = { q?: string; owner?: string; host?: string; chain?: ApiChain; limit: number };

/** A search page: one summary per agent, newest first, each with the address of its own answer. */
export function searchAnswer(query: SearchQuery, page: SearchPage, keys: Map<string, string>, now: Date, chains: readonly ApiChain[] = servedChains()): ApiEnvelope<Record<string, unknown>> {
  const owner = query.owner?.toLowerCase();
  const results = page.entries.flatMap(entry => {
    const chain = apiChainOfProtocol(entry.protocol, chains);
    const key = keys.get(entry.id);
    if (!chain || !key) return [];
    if (owner && entry.registrant?.toLowerCase() !== owner) return [];
    if (query.host && entry.locatorHost?.toLowerCase() !== query.host) return [];
    const agentId = agentIdOfKey(chain, key);
    return [
      {
        chain,
        agent_id: agentId,
        registry: entry.protocol,
        nooscape_id: entry.id,
        name: entry.displayName,
        registrant: entry.registrant,
        locator_host: entry.locatorHost,
        first_seen_at: iso(entry.firstSeenAt),
        last_seen_at: iso(entry.lastSeenAt),
        evidence_layer: "acknowledged" as const,
        links: { agent: `/api/v1/agents/${chain}/${agentId}`, page: pageUrl(entry.id) },
      },
    ];
  });
  // `owner` and `host` are exact filters over the page the search returned, so past the first page "at least" is all that can be said.
  const narrowed = Boolean(owner || query.host);
  return {
    api_version: "v1",
    as_of: now.toISOString(),
    source: { kind: "directory_search", chains: query.chain ? [query.chain] : chains, registries: query.chain ? API_CHAINS[query.chain].protocols : chains.flatMap(chain => API_CHAINS[chain].protocols) },
    license: API_LICENSE,
    data: {
      query: { q: query.q ?? null, owner: query.owner ?? null, host: query.host ?? null, chain: query.chain ?? null, limit: query.limit },
      matched_total: narrowed ? results.length : page.matchedTotal,
      matched_total_capped: narrowed ? page.entries.length >= query.limit : Boolean((page as { matchedTotalCapped?: boolean }).matchedTotalCapped),
      results,
    },
  };
}

/** The pay-per-call block of the index: every network that takes payment in the order a 402 offers them, and the first of them repeated at the top. */
function payPerCall(pay: X402Config) {
  const rails = railsOf(pay);
  // Only Arc takes a smart-contract wallet, and only when its node is set.
  const wallets = (rail: Rail) => (rail.network === pay.network && pay.rpc ? ["regular", "smart_contract"] : ["regular"]);
  const first = rails[0]!;
  return {
    protocol: "x402",
    version: 2,
    network: first.network,
    asset: first.asset,
    pay_to: first.payTo,
    networks: rails.map(rail => ({ network: rail.network, asset: rail.asset, pay_to: rail.payTo, wallets: wallets(rail) })),
    prices: { lookup: { amount: pay.prices.agent, usd: usdOf(pay.prices.agent) }, check: { amount: pay.prices.check, usd: usdOf(pay.prices.check) } },
    applies_to: ["GET /api/v1/agents/{chain}/{id} past the free limit, with no key", "POST /api/v1/check with no key"],
    wallets: wallets(first),
  };
}

export function indexAnswer(now: Date, pay: X402Config | null = null, unresolvedOverHour: number | null | undefined = undefined, chains: readonly ApiChain[] = servedChains()) {
  return {
    api_version: "v1",
    as_of: now.toISOString(),
    license: API_LICENSE,
    documentation: `${PAGE_ORIGIN}/developers`,
    openapi: `${PAGE_ORIGIN}/api/v1/openapi.json`,
    rate_limit: { requests: API_V1_RATE_LIMIT.requests, per: "minute", scope: "ip_address" },
    ...(pay ? { pay_per_call: payPerCall(pay) } : {}),
    // Present while pay per call is on or paused: how many payments have not settled for over an hour. The live health check reads it.
    ...(unresolvedOverHour === undefined ? {} : { payments_unresolved_over_hour: unresolvedOverHour }),
    keys: {
      get_a_key: `${PAGE_ORIGIN}/developers/keys`,
      header: "Authorization: Bearer <key>",
      tiers: API_TIER_NAMES.map(tier => ({ tier, per_minute: API_TIERS[tier].perMinute, per_day: API_TIERS[tier].perDay })),
    },
    chains: chains.map(chain => ({ chain, label: listedChainLabel(chain), registries: API_CHAINS[chain].protocols })),
    endpoints: [
      { method: "GET", path: "/api/v1/agents/{chain}/{id}", summary: "One agent by chain and registry id." },
      { method: "GET", path: "/api/v1/agents/search", summary: "Search agents by name, host, registry key or wallet." },
      { method: "POST", path: "/api/v1/agents/batch", summary: "Up to 25 agents in one request. Needs a key." },
      { method: "GET", path: "/api/v1/agents/{chain}/{id}/history", summary: "An agent's registry events and the public history of its claims. Needs a key." },
      { method: "GET", path: "/api/v1/usage", summary: "What the key has used. Needs a key." },
      // While pay per call takes payments the check can also be paid for with no key, and the index says so; otherwise a Pro key is the only way in.
      {
        method: "POST",
        path: "/api/v1/check",
        summary: `Pre-flight facts for an agent, a wallet or an endpoint URL, with their dates. Needs a Pro key${pay ? `, or ${usdOf(pay.prices.check)} a call with no key` : ""}.`,
      },
      { method: "GET", path: "/api/v1/watches", summary: "The listings this key watches. Needs a Builder key." },
      { method: "POST", path: "/api/v1/watches", summary: "Watch up to 25 more listings, up to 100 in all. Needs a Builder key." },
      { method: "DELETE", path: "/api/v1/watches/{nooscape_id}", summary: "Stop watching a listing. Needs a Builder key." },
      { method: "GET", path: "/api/v1/webhook", summary: "This key's webhook and its signing secret. Needs a Builder key." },
      { method: "PUT", path: "/api/v1/webhook", summary: "Set the https address that events are sent to, and send it a test. Needs a Builder key." },
      { method: "DELETE", path: "/api/v1/webhook", summary: "Remove the webhook. Needs a Builder key." },
      { method: "POST", path: "/api/v1/webhook/rotate-secret", summary: "Give the webhook a new signing secret. Needs a Builder key." },
      { method: "GET", path: "/api/v1/webhook/deliveries", summary: "The last 20 events sent to the webhook and what became of each. Needs a Builder key." },
      { method: "GET", path: "/api/v1/openapi.json", summary: "This API, described in OpenAPI 3.1." },
    ],
    statement: "Reads the public record and changes none of it. Payment never changes a record, a tier or an evidence level. Facts with their dates, never a verdict.",
  };
}

// ---------------------------------------------------------------- the errors

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  invalid_key: 401,
  key_required: 401,
  tier_required: 403,
  not_found: 404,
  ambiguous: 409,
  method_not_allowed: 405,
  rate_limited: 429,
  quota_exceeded: 429,
  unavailable: 503,
};

function fail(res: Response, code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}) {
  res.set("Cache-Control", "no-store");
  res.status(STATUS[code]).json({ error: { code, message, ...extra } });
}

const problem = (res: Response, found: ApiProblem) => fail(res, found.code, found.message, found.registries ? { registries: found.registries } : {});

/** The schemas that depend on which chains are served, built once for each list of them: the switches change only when the server restarts. */
const byServed = <T>(build: (chains: readonly ApiChain[]) => T) => {
  const made = new Map<string, T>();
  return (chains: readonly ApiChain[]): T => {
    const key = chains.join(",");
    const known = made.get(key);
    if (known) return known;
    const fresh = build(chains);
    made.set(key, fresh);
    return fresh;
  };
};

const searchSchemaFor = byServed(chains =>
  z
    .object({
      q: z.string().trim().min(2).max(64).optional(),
      owner: z
        .string()
        .trim()
        .regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, "owner must be a wallet address")
        .optional(),
      host: z
        .string()
        .trim()
        .toLowerCase()
        .min(3)
        .max(253)
        .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, "host must be a host name")
        .optional(),
      chain: z.enum(chains as [ApiChain, ...ApiChain[]]).optional(),
      limit: z.coerce.number().int().min(1).max(25).default(10),
    })
    .strict()
    .refine(value => [value.q, value.owner, value.host].filter(item => item !== undefined).length === 1, { message: "give exactly one of q, owner or host" }),
);

const checkSchemaFor = byServed(checkRequestSchemaFor);

const REGISTRY_OPTIONS = ["solana_8004", "solana_said", "solana_registry"] as const;
const lookupQuery = z.object({ registry: z.enum(REGISTRY_OPTIONS).optional() }).strict();
const batchSchema = z
  .object({ agents: z.array(z.object({ chain: z.string().max(16), id: z.string().max(64), registry: z.enum(REGISTRY_OPTIONS).optional() }).strict()).min(1).max(BATCH_MAX) })
  .strict();

const describeFailure = (issues: z.core.$ZodIssue[]) => issues.map(issue => (issue.path.length > 0 && !/^(owner|host) must/.test(issue.message) ? `${issue.path.join(".")}: ` : "") + issue.message).join("; ");

const withoutParameters = (message: string) => message.split("\nparams:")[0]!;

async function guarded(res: Response, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiKeyError && error.code === "UNAVAILABLE") {
      res.set("Retry-After", "60");
      return fail(res, "unavailable", error.message);
    }
    // The same posture as the site's other public reads: the cause goes to the log, the caller is told only that it cannot be read now.
    if (!isCircuitOpenError(error)) console.warn("[ApiV1] read failed:", error instanceof Error ? withoutParameters(error.message) : String(error));
    res.set("Retry-After", "30");
    fail(res, "unavailable", "This data cannot be read right now. Try again shortly.");
  }
}

// ---------------------------------------------------------------- finding an agent

type Lookup = { ok: true; chain: ApiChain; key: string; entry: Entry; claim: ClaimStateRead | null } | { ok: false; error: ApiProblem };

/** One agent by chain and id, with every refusal as a value, so a batch can carry it as one item's answer. */
async function lookupAgent(deps: ApiV1Deps, req: Request, chainText: string, id: string, registry: string | undefined): Promise<Lookup> {
  const served = servedChains();
  const chain = served.find(key => key === chainText);
  if (!chain) return { ok: false, error: { code: "bad_request", message: `chain must be one of ${served.join(", ")}` } };
  const table = API_CHAINS[chain];
  if (!table.idPattern.test(id)) return { ok: false, error: { code: "bad_request", message: chain === "solana" ? "id must be a Solana address" : "id must be a registry token id (digits only)" } };
  if (registry && chain !== "solana") return { ok: false, error: { code: "bad_request", message: "registry applies to solana only" } };
  const protocols = registry ? [registry] : table.protocols;
  const key = table.keyOf(id);
  const matches = await deps.findEntries(protocols, key);
  if (matches.length === 0) return { ok: false, error: { code: "not_found", message: "No listed agent has that id on that chain." } };
  if (matches.length > 1) return { ok: false, error: { code: "ambiguous", message: "More than one registry lists that address. Add registry=.", registries: matches.map(match => match.protocol).sort() } };
  const entry = await deps.getEntry(matches[0]!.id);
  if (!entry) return { ok: false, error: { code: "not_found", message: "No listed agent has that id on that chain." } };
  return { ok: true, chain, key, entry, claim: await deps.claimOf(entry.id, req) };
}

// ---------------------------------------------------------------- the router

/** Browsers on other sites may read the API; it is public, read only and carries no credential but the key a caller chooses to send. */
function openToReaders(_req: Request, res: Response, next: NextFunction) {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE",
    "Access-Control-Expose-Headers": "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-Quota-Limit, X-Quota-Remaining, X-Quota-Reset, X-Api-Tier, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    "Access-Control-Max-Age": "86400",
    "Cross-Origin-Resource-Policy": "cross-origin",
    // An answer to a request with a key is not the answer to one without, to a cache that keeps them apart.
    Vary: "Authorization",
  });
  next();
}

/** The endpoint a request is for, as the usage counts name it. */
export function endpointOf(path: string): string {
  if (path === "/" || path === "") return "index";
  if (path === "/openapi.json") return "openapi";
  if (path === "/usage") return "usage";
  if (path === "/agents/search") return "search";
  if (path === "/agents/batch") return "batch";
  if (path === "/check") return "check";
  if (isWebhookPath(path)) return path.startsWith("/watches") ? "watches" : "webhook";
  if (/^\/agents\/[^/]+\/[^/]+\/history$/.test(path)) return "history";
  if (/^\/agents\/[^/]+\/[^/]+$/.test(path)) return "agent";
  return "other";
}

const secondsUntil = (when: Date, now: Date) => Math.max(Math.ceil((when.getTime() - now.getTime()) / 1000), 1);

/**
 * What a caller with no key may pay for: one agent's lookup, past the free limit, and the pre-flight check. A request that carries a
 * payment costs a signature check, and then a database write and a call to the facilitator, and a signed authorization costs its maker
 * nothing, so those are held to 60 a minute from one address. Being told the price costs almost nothing and is held to 300.
 */
const PAID_ATTEMPTS_PER_MINUTE = 60;
const OFFERS_PER_MINUTE = 300;

function payableEndpoint(req: Request): X402Endpoint | null {
  if (req.path.length > 200) return null;
  // The route reads a percent-encoded chain or id as the plain one, and the address of the resource is what a catalogue lists: an encoding is not paid for.
  if (req.path.includes("%")) return null;
  const endpoint = endpointOf(req.path);
  if (req.method === "GET" && endpoint === "agent") return "agent";
  if (req.method === "POST" && endpoint === "check") return "check";
  return null;
}

/**
 * A payment reply is read by a program, so it leaves out the headers that only a document needs: a Content-Security-Policy of about 360
 * bytes, a Permissions-Policy, a Cross-Origin-Opener-Policy, a Referrer-Policy and an X-Frame-Options, about 540 bytes together. The 402's
 * header block was 3.9 KB at the edge and a proxy may buffer 4 KB; the room goes to the block that describes the route. Nosniff, HSTS and the
 * cross-origin resource policy stay, and an answer, and every other response, keeps all of them.
 */
const DOCUMENT_ONLY_HEADERS = ["Content-Security-Policy", "Permissions-Policy", "Cross-Origin-Opener-Policy", "Referrer-Policy", "X-Frame-Options"];
const sendReply = (res: Response, reply: Reply) => {
  for (const name of DOCUMENT_ONLY_HEADERS) res.removeHeader(name);
  res.status(reply.status).set("Cache-Control", "no-store").set(reply.headers).json(reply.body);
};

/**
 * A request with no key that may be paid for. With no payment it is told the price (402). With one, the payment is checked here
 * without touching the database and carried on for the route to settle once the answer is built, so a request that fails costs the
 * caller nothing. Returns false when the response is sent.
 */
async function askForPayment(deps: ApiV1Deps, req: Request, res: Response, endpoint: X402Endpoint, clientKey: string, why: string): Promise<boolean> {
  const payments = deps.payments!;
  const resource = `${payments.config.resourceBase}/api/v1${req.path}`;
  const header = req.get("payment-signature");
  const attempts = header === undefined ? consumeRateLimit(`x402-offer:${clientKey}`, OFFERS_PER_MINUTE, 60_000) : consumeRateLimit(`x402:${clientKey}`, PAID_ATTEMPTS_PER_MINUTE, 60_000);
  if (!attempts.allowed) {
    console.warn(`[RateLimit] x402 limit reached for ${clientKey} (retry in ${Math.max(Math.ceil(attempts.retryAfterMs / 1000), 1)}s)`);
    res.set("Retry-After", String(Math.max(Math.ceil(attempts.retryAfterMs / 1000), 1)));
    fail(res, "rate_limited", "Too many requests. Try again later.");
    return false;
  }
  if (header === undefined) {
    sendReply(res, payments.offer(endpoint, resource, why));
    return false;
  }
  const accepted = await payments.verify(endpoint, header, resource);
  if (!accepted.ok) {
    sendReply(res, accepted.reply);
    return false;
  }
  res.locals.pay = accepted.context;
  return true;
}

/** Sends an answer, charging for it first when the request carries a payment. Whatever is not delivered is not charged. */
async function respond(deps: ApiV1Deps, res: Response, subject: string, body: unknown, charge = true) {
  const pay = res.locals.pay as PayContext | undefined;
  if (!pay || !charge) return void res.json(body);
  const outcome = await deps.payments!.charge(pay, subject);
  if (!outcome.deliver) return sendReply(res, outcome.reply);
  res.set(outcome.headers);
  res.json(body);
}

/**
 * Who is asking and what they may ask. Without a key: 30 requests a minute from one address. With a key: the tier's requests a minute,
 * its requests a day, and a ceiling of 300 a minute from one address whatever the key, so one address cannot spend a stolen key's
 * allowance. A key that is wrong is refused with 401 and does not fall back to the public limit, so a typo is not mistaken for a
 * slow API; guessing keys is counted against the address.
 */
function limits(deps: ApiV1Deps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const clientKey = clientKeyFrom(req);
    const header = req.get("authorization");
    res.locals.apiKey = null;
    if (header === undefined) {
      // A stranger's request must never throw out of here: nothing catches a rejection from this function.
      return guarded(res, async () => {
        const payable = deps.payments ? payableEndpoint(req) : null;
        const state = payable ? await deps.payments!.state() : "off";
        // A paused service offers nothing new, but still takes the payment of a caller it already recorded.
        const canAsk = payable !== null && (state === "on" || (state === "paused" && req.get("payment-signature") !== undefined));
        const price = canAsk ? usdOf(deps.payments!.config.prices[payable]) : "";
        // The check has no free tier: a caller with no key is asked to pay, and does not use up the public limit to find out.
        if (canAsk && payable === "check") {
          return (await askForPayment(deps, req, res, payable, clientKey, `The pre-flight check needs a Pro key or a payment of ${price} per call. PAYMENT-SIGNATURE header is required.`)) ? next() : undefined;
        }
        const verdict = consumeRateLimit(`api-v1:${clientKey}`, API_V1_RATE_LIMIT.requests, API_V1_RATE_LIMIT.windowMs);
        res.set("X-RateLimit-Limit", String(API_V1_RATE_LIMIT.requests));
        res.set("X-RateLimit-Remaining", String(verdict.remaining));
        if (verdict.allowed) return next();
        // Past the free limit a lookup may be paid for instead of waited for.
        if (canAsk && payable === "agent") {
          return (await askForPayment(deps, req, res, payable, clientKey, `The free limit is ${API_V1_RATE_LIMIT.requests} lookups a minute from one address. Pay ${price} for this call, or send an API key. PAYMENT-SIGNATURE header is required.`)) ? next() : undefined;
        }
        const retryAfter = Math.max(Math.ceil(verdict.retryAfterMs / 1000), 1);
        console.warn(`[RateLimit] api-v1 limit reached for ${clientKey} (retry in ${retryAfter}s)`);
        res.set("Retry-After", String(retryAfter));
        return fail(res, "rate_limited", "Too many requests. Try again later.");
      });
    }
    await guarded(res, async () => {
      const match = /^Bearer (\S+)$/.exec(header.trim());
      const raw = match?.[1] ?? "";
      const record = KEY_PATTERN.test(raw) ? await deps.keys.resolve(raw) : null;
      if (!record) {
        // A wrong key costs the address a try, so a run of guesses stops.
        const guess = consumeRateLimit(`api-v1-badkey:${clientKey}`, 20, 60_000);
        if (!guess.allowed) {
          console.warn(`[RateLimit] api-v1-badkey limit reached for ${clientKey} (retry in ${Math.max(Math.ceil(guess.retryAfterMs / 1000), 1)}s)`);
          res.set("Retry-After", String(Math.max(Math.ceil(guess.retryAfterMs / 1000), 1)));
          return fail(res, "rate_limited", "Too many requests. Try again later.");
        }
        return fail(res, "invalid_key", "That key is not valid. Send Authorization: Bearer <key>, with a key that has not been revoked.");
      }
      const tier = API_TIERS[record.tier];
      const address = consumeRateLimit(`api-v1-key-ip:${clientKey}`, KEY_ADDRESS_PER_MINUTE, 60_000);
      if (!address.allowed) {
        console.warn(`[RateLimit] api-v1-key-ip limit reached for ${clientKey} (retry in ${Math.max(Math.ceil(address.retryAfterMs / 1000), 1)}s)`);
        res.set("Retry-After", String(Math.max(Math.ceil(address.retryAfterMs / 1000), 1)));
        return fail(res, "rate_limited", "Too many requests from this address. Try again later.");
      }
      const minute = consumeRateLimit(`api-key:${record.id}`, tier.perMinute, 60_000);
      res.set("X-RateLimit-Limit", String(tier.perMinute));
      res.set("X-RateLimit-Remaining", String(minute.remaining));
      res.set("X-Api-Tier", record.tier);
      if (!minute.allowed) {
        res.set("Retry-After", String(Math.max(Math.ceil(minute.retryAfterMs / 1000), 1)));
        return fail(res, "rate_limited", "Too many requests. Try again later.");
      }
      const day = await deps.keys.consume(record.id, tier.perDay, endpointOf(req.path));
      res.set("X-Quota-Limit", String(day.limit));
      res.set("X-Quota-Remaining", String(day.remaining));
      res.set("X-Quota-Reset", day.resetsAt.toISOString());
      if (!day.allowed) {
        res.set("Retry-After", String(secondsUntil(day.resetsAt, deps.now())));
        return fail(res, "quota_exceeded", "This key has used its requests for today. The count restarts at 00:00 UTC.");
      }
      res.locals.apiKey = record;
      next();
    });
  };
}

/**
 * An answer about an agent is private to the caller: a browser may keep it for a minute and a shared cache may not. The host's CDN stores a
 * public answer and serves it to a request that carries a key as well, whatever Vary says, which left that request uncounted, without the
 * key's headers, and an ended key unrefused for up to a minute. The two documents below hold no per-caller state and stay public.
 */
const cacheable = (res: Response) => res.set("Cache-Control", "private, max-age=60");

/** The key a request carries must be of at least this tier, or the refusal says which. */
function requireTier(res: Response, minimum: ApiTier): boolean {
  const record = res.locals.apiKey as ApiKeyRecord | null;
  if (record && tierAtLeast(record.tier, minimum)) return true;
  fail(res, "tier_required", `This endpoint needs a ${API_TIERS[minimum].label} key. Paid tiers are arranged by email: see /developers/keys.`, { required_tier: minimum });
  return false;
}

/** The key a request carries, or a refusal that says the endpoint needs one. */
function requireKey(res: Response): ApiKeyRecord | null {
  const record = res.locals.apiKey as ApiKeyRecord | null;
  if (record) return record;
  fail(res, "key_required", "This endpoint needs an API key. Send Authorization: Bearer <key>. A free key is at /developers/keys.");
  return null;
}

export function apiV1Router(deps: ApiV1Deps = defaultApiV1Deps): Router {
  const router = Router({ caseSensitive: true });

  router.use(openToReaders);
  router.use((req, res, next) => {
    if (req.method === "OPTIONS") return void res.status(204).end();
    // The watchlist and the webhook take their own methods, and answer 405 themselves for the rest.
    if (isWebhookPath(req.path)) return next();
    const postOnly = req.path === "/agents/batch" ? "The batch lookup takes POST." : req.path === "/check" ? "The check takes POST." : null;
    if (req.method === "POST" && postOnly) return next();
    if (postOnly || (req.method !== "GET" && req.method !== "HEAD")) {
      res.set("Allow", postOnly ? "POST, OPTIONS" : "GET, HEAD, OPTIONS");
      return fail(res, "method_not_allowed", postOnly ?? "This API is read only.");
    }
    next();
  });
  router.use(limits(deps));

  router.get("/", (_req, res) =>
    guarded(res, async () => {
      res.set("Cache-Control", "public, max-age=300");
      const state = deps.payments ? await deps.payments.state() : "off";
      res.json(indexAnswer(deps.now(), state === "on" ? deps.payments!.config : null, state === "off" ? undefined : await deps.payments!.staleCount()));
    })
  );

  router.get("/openapi.json", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(apiV1SpecFor(servedChains()));
  });

  router.get("/usage", (_req, res) =>
    guarded(res, async () => {
      const record = requireKey(res);
      if (!record) return;
      const report = await deps.keys.usage(record, 30);
      res.set("Cache-Control", "no-store");
      res.json(usageAnswer(record, report, deps.now()));
    })
  );

  // Before the lookup, so "search" is not read as a chain.
  router.get("/agents/search", (req, res) =>
    guarded(res, async () => {
      const served = servedChains();
      const parsed = searchSchemaFor(served).safeParse(req.query);
      if (!parsed.success) return fail(res, "bad_request", describeFailure(parsed.error.issues));
      const query = parsed.data as SearchQuery;
      const text = query.q ?? query.owner ?? query.host!;
      const protocols = query.chain ? API_CHAINS[query.chain].protocols : served.flatMap(chain => API_CHAINS[chain].protocols);
      const page = await deps.search({ query: text, limit: query.limit, protocols });
      if ((page as { busy?: boolean }).busy) {
        res.set("Retry-After", "10");
        return fail(res, "unavailable", "Search is busy. Try again shortly.");
      }
      const keys = await deps.keysOf(page.entries.map(entry => entry.id));
      cacheable(res);
      res.json(searchAnswer(query, page, keys, deps.now(), served));
    })
  );

  // Several agents in one request: the body names up to 25, and each gets its own status, so one that is not listed does not spoil the rest.
  // The key is checked before the body is read, so a caller with none costs no parsing.
  router.post("/agents/batch", (_req, res, next) => (requireKey(res) ? next() : undefined), express.json({ limit: "16kb" }), (req, res) =>
    guarded(res, async () => {
      const parsed = batchSchema.safeParse(req.body);
      if (!parsed.success) return fail(res, "bad_request", describeFailure(parsed.error.issues));
      const wanted = parsed.data.agents;
      const items: BatchItem[] = [];
      for (let start = 0; start < wanted.length; start += 5) {
        const chunk = wanted.slice(start, start + 5);
        items.push(
          ...(await Promise.all(
            chunk.map(async (item): Promise<BatchItem> => {
              const found = await lookupAgent(deps, req, item.chain, item.id, item.registry);
              if (!found.ok) return { chain: item.chain, id: item.id, status: STATUS[found.error.code], as_of: null, source: null, agent: null, error: found.error };
              const answer = agentAnswer(found.chain, found.key, found.entry, found.claim);
              return { chain: item.chain, id: item.id, status: 200, as_of: answer.as_of, source: answer.source, agent: answer.data, error: null };
            })
          ))
        );
      }
      res.set("Cache-Control", "no-store");
      res.json(batchAnswer(items, deps.now()));
    })
  );

  // The pre-flight check: for an agent, a wallet or an endpoint URL, the evidence level and a few dated flags. Facts only, no verdict.
  // The tier is checked before the body is read, like the key.
  router.post("/check", (_req, res, next) => (res.locals.pay || (requireKey(res) && requireTier(res, CHECK_MIN_TIER)) ? next() : undefined), express.json({ limit: "4kb" }), (req, res) =>
    guarded(res, async () => {
      const served = servedChains();
      const parsed = checkSchemaFor(served).safeParse(req.body);
      if (!parsed.success) return fail(res, "bad_request", describeFailure(parsed.error.issues));
      const request = parsed.data;
      const now = deps.now();
      const forRegistry = async (chain: ApiChain, key: string, entry: Entry) => {
        const facts = await deps.checkFacts(entry.id);
        // A free answer says "not measured" when a ledger cannot be read. A paid one is not given in that state, so no one is charged for it.
        if (facts === null && res.locals.pay) throw new Error("the check facts could not be read");
        return checkResult(chain, key, entry, facts ?? { activityThroughBlock: null, solana: null }, now);
      };
      res.set("Cache-Control", "no-store");

      if (request.agent) {
        const found = await lookupAgent(deps, req, request.agent.chain, request.agent.id, request.agent.registry);
        if (!found.ok) return problem(res, found.error);
        const result = await forRegistry(found.chain, found.key, found.entry);
        return void (await respond(deps, res, `agent|${found.chain}|${agentIdOfKey(found.chain, found.key)}|${request.agent.registry ?? ""}`, checkAnswer({ type: "agent", value: `${found.chain}/${agentIdOfKey(found.chain, found.key)}`, host: null }, [result], 1, false, now)));
      }

      // A wallet or an endpoint URL: the listings it matches exactly, newest first, up to the limit.
      const host = request.url ? hostOfUrl(request.url) : null;
      if (request.url && !host) return fail(res, "bad_request", "url must be an http or https address with a host");
      const text = request.wallet ?? host!;
      const protocols = request.chain ? API_CHAINS[request.chain].protocols : served.flatMap(chain => API_CHAINS[chain].protocols);
      const page = await deps.search({ query: text, limit: CHECK_RESULT_LIMIT, protocols });
      if ((page as { busy?: boolean }).busy) {
        res.set("Retry-After", "10");
        return fail(res, "unavailable", "Search is busy. Try again shortly.");
      }
      const wanted = page.entries.filter(entry => (request.wallet ? entry.registrant?.toLowerCase() === text.toLowerCase() : entry.locatorHost?.toLowerCase() === text));
      const keys = await deps.keysOf(wanted.map(entry => entry.id));
      const results: CheckResult[] = [];
      for (const listed of wanted) {
        const chain = apiChainOfProtocol(listed.protocol, served);
        const key = keys.get(listed.id);
        const entry = chain && key ? await deps.getEntry(listed.id) : null;
        if (chain && key && entry) results.push(await forRegistry(chain, key, entry));
      }
      // A full page may not be every match: the count is then "at least" what is listed, and no cursor exists yet.
      const capped = page.entries.length >= CHECK_RESULT_LIMIT;
      // A question that matches no listing is answered and not charged for, as an agent that is not listed is.
      await respond(deps, res, `${request.wallet ? "wallet" : "url"}|${request.wallet ?? request.url}|${request.chain ?? ""}`, checkAnswer({ type: request.wallet ? "wallet" : "url", value: request.wallet ?? request.url!, host }, results, results.length, capped, now), results.length > 0);
    })
  );

  router.get("/agents/:chain/:id/history", (req, res) =>
    guarded(res, async () => {
      if (!requireKey(res)) return;
      const options = lookupQuery.safeParse(req.query);
      if (!options.success) return fail(res, "bad_request", "the only option is registry, and only for solana");
      const found = await lookupAgent(deps, req, req.params.chain ?? "", req.params.id ?? "", options.data.registry);
      if (!found.ok) return problem(res, found.error);
      const history = await deps.claimHistory(found.entry.id, req);
      cacheable(res);
      res.json(historyAnswer(found.chain, found.key, found.entry, history));
    })
  );

  router.get("/agents/:chain/:id", (req, res) =>
    guarded(res, async () => {
      const options = lookupQuery.safeParse(req.query);
      if (!options.success) return fail(res, "bad_request", "the only option is registry, and only for solana");
      const found = await lookupAgent(deps, req, req.params.chain ?? "", req.params.id ?? "", options.data.registry);
      if (!found.ok) return problem(res, found.error);
      // The claim read answers null only when it failed. A paid answer is not given without it, so no one is charged for one that is missing it.
      if (res.locals.pay && found.claim === null) throw new Error("the claim state could not be read");
      cacheable(res);
      await respond(deps, res, `agent|${found.chain}|${agentIdOfKey(found.chain, found.key)}|${options.data.registry ?? ""}`, agentAnswer(found.chain, found.key, found.entry, found.claim));
    })
  );

  // A key's own watchlist and webhook: the one thing here that writes, kept in its own file.
  router.use(webhookRoutes(deps.webhooks ?? null, { fail, guarded, requireKey, requireTier, findEntries: deps.findEntries, describeFailure }));

  router.use((_req, res) => fail(res, "not_found", "No such endpoint. See /api/v1/openapi.json."));

  // A body that is not JSON, or is too large, is answered in the API's own words and not with the framework's page.
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (error as { type?: string } | null)?.type;
    if (type === "entity.too.large") return void res.status(413).set("Cache-Control", "no-store").json({ error: { code: "bad_request", message: "The body is too large." } });
    if (type === "entity.parse.failed") return fail(res, "bad_request", "The body is not valid JSON.");
    console.warn("[ApiV1] request failed:", error instanceof Error ? withoutParameters(error.message) : String(error));
    res.set("Retry-After", "30");
    fail(res, "unavailable", "This data cannot be read right now. Try again shortly.");
  });
  return router;
}

/** Mounted before the tRPC limiter and the body parsers: a read of this API has no body to wait for. */
export function registerApiV1(app: Express, deps: ApiV1Deps = defaultApiV1Deps) {
  // What a key has used is counted in memory and written every few seconds, by the one process that holds it.
  if (deps.keys === defaultApiV1Deps.keys) apiMeter.start();
  app.use("/api/v1", apiV1Router(deps));
}
