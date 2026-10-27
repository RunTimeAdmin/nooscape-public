import { z } from "zod";
import { AGENT_ID_MAX_CHARS, CHAIN_KEYS, type ApiChain } from "./apiChains";
import { CHAIN_BLOCKS_PER_DAY } from "./db";

/**
 * The pre-flight check (docs/data-access-2026-10-19.md, stage D3): for an agent, a wallet or an endpoint URL, the evidence level, a few
 * flags and the sources they were read from. Facts only. A flag is a dated count or date from Nooscape's own records with the basis it
 * rests on, and `present` says only that Nooscape has recorded one. Nothing here says that an agent is safe or unsafe, and no flag is
 * weighed into a score. This file holds the parts that need nothing from the API's router: the request, the thresholds and the flags.
 */

export const CHECK_STATEMENT =
  "These are dated facts about a listing, each with the date or block it was read at. None of them is a verdict: Nooscape does not say that an agent is safe or unsafe, and a flag that is present is a fact to weigh and not a finding.";

/** A listing first seen by Nooscape within this many days has `first_seen.present` true. */
export const FIRST_SEEN_WITHIN_DAYS = 30;
/** The most listings a check of a wallet or an endpoint URL answers for, newest first. */
export const CHECK_RESULT_LIMIT = 10;
/** The registry events the entry read keeps for one agent (server/db.ts). When it holds this many, it may not hold the latest. */
export const REGISTRY_EVENT_LIST_LIMIT = 24;

const REGISTRY_OPTIONS = ["solana_8004", "solana_said", "solana_registry", "solana_agenc"] as const;

const walletText = z
  .string()
  .trim()
  .regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, "wallet must be a wallet address");

/**
 * Exactly one subject: an agent by chain and id, the wallet that registered agents, or the host of an endpoint URL. `chains` are the
 * chains the API serves now, which the router reads from the switches on each request (server/apiChains.ts).
 */
export const checkRequestSchemaFor = (chains: readonly ApiChain[]) =>
  z
    .object({
      agent: z.object({ chain: z.string().max(16), id: z.string().max(AGENT_ID_MAX_CHARS), registry: z.enum(REGISTRY_OPTIONS).optional() }).strict().optional(),
      wallet: walletText.optional(),
      url: z.string().trim().min(8).max(2048).optional(),
      chain: z.enum(chains as [ApiChain, ...ApiChain[]]).optional(),
    })
    .strict()
    .refine(value => [value.agent, value.wallet, value.url].filter(item => item !== undefined).length === 1, { message: "give exactly one of agent, wallet or url" })
    .refine(value => value.chain === undefined || value.agent === undefined, { message: "chain narrows a wallet or a url, and an agent already names its chain" });

/** The request as it reads with every extra chain off: the three chains the API has always served. */
const checkRequestSchema = checkRequestSchemaFor(CHAIN_KEYS);

export type CheckRequest = z.infer<typeof checkRequestSchema>;

/** The lower-case host of an http or https address, or null for anything else. Nothing is fetched: the host is only matched against the hosts agents registered. */
export function hostOfUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return host.length > 0 ? host : null;
}

// ---------------------------------------------------------------- the flags

type Iso = string | null;
const iso = (value: Date | string | null | undefined): Iso => (value ? new Date(value).toISOString() : null);

export type CheckFlagsInput = {
  chain: ApiChain;
  now: Date;
  entry: {
    firstSeenAt: Date | string | null;
    related?: { sameWallet: number; sameName: number; sameHost: number } | null;
    activity?: {
      secondaryTransferCount: number | null;
      handoutCount: number | null;
      events: Array<{ kind: string; blockNumber: number; isHandout?: boolean }>;
    } | null;
    ratings?: { measuredThroughBlock: number | null; ratingCount: number; revokedCount: number } | null;
  };
  facts: { activityThroughBlock: number | null; solana: { transfers: number; latestRecordedAt: Date | string | null } | null };
};

/** The four flags the plan names: new, ownership changed, revoked feedback share, fleet size. */
export function checkFlags({ chain, now, entry, facts }: CheckFlagsInput) {
  // ---- new: when Nooscape first saw the listing
  const first = entry.firstSeenAt ? new Date(entry.firstSeenAt) : null;
  const ageMs = first ? now.getTime() - first.getTime() : null;
  const firstSeen = {
    present: ageMs === null ? null : ageMs < FIRST_SEEN_WITHIN_DAYS * 24 * 60 * 60 * 1000,
    first_seen_at: iso(first),
    days_since_first_seen: ageMs === null ? null : Math.max(Math.floor(ageMs / (24 * 60 * 60 * 1000)), 0),
    threshold_days: FIRST_SEEN_WITHIN_DAYS,
    basis: "When Nooscape first saw this listing. It is not when the agent was registered: a listing found while Nooscape read a registry's history is dated by that read.",
  };

  // ---- ownership changed: transfers Nooscape has recorded
  const activity = entry.activity ?? null;
  let ownership: Record<string, unknown>;
  if (activity && activity.secondaryTransferCount !== null && activity.handoutCount !== null) {
    const changes = Math.max(activity.secondaryTransferCount - activity.handoutCount, 0);
    // The entry read keeps the oldest events and no more than this many, so with that many in hand the latest may not be among them.
    const complete = activity.events.length < REGISTRY_EVENT_LIST_LIMIT;
    const transferBlocks = activity.events.filter(event => event.kind === "secondary" && !event.isHandout).map(event => event.blockNumber);
    const latest = complete && transferBlocks.length > 0 ? Math.max(...transferBlocks) : null;
    const head = facts.activityThroughBlock;
    const blocksSince = latest !== null && head !== null ? Math.max(head - latest, 0) : null;
    ownership = {
      present: changes > 0,
      changes_recorded: changes,
      handouts_recorded: activity.handoutCount,
      latest_change_block: latest,
      ledger_through_block: head,
      blocks_since_latest_change: blocksSince,
      // Only Robinhood Chain has a block rate the site states (about 0.1 s). The ledger holds blocks, not clocks, so this is a proxy and not a date.
      block_days_since_latest_change: chain === "robinhood" && blocksSince !== null ? Math.round((blocksSince / CHAIN_BLOCKS_PER_DAY) * 10) / 10 : null,
      latest_change_recorded_at: null,
      basis:
        "Changes of hands recorded in Nooscape's ledger of the registry's transfers, apart from the platform hand-outs made just after a mint. The ledger holds block numbers and not times." +
        (chain === "robinhood" ? " A block day is 864,000 blocks, a proxy." : "") +
        (latest === null && changes > 0 && !complete ? " This agent has more events than the list read for it holds, so the latest block is not given." : ""),
    };
  } else if (facts.solana) {
    ownership = {
      present: facts.solana.transfers > 0,
      changes_recorded: facts.solana.transfers,
      handouts_recorded: null,
      latest_change_block: null,
      ledger_through_block: null,
      blocks_since_latest_change: null,
      block_days_since_latest_change: null,
      latest_change_recorded_at: iso(facts.solana.latestRecordedAt),
      basis:
        "Transfers recorded when two reads of the registry showed a new owner. The date is when Nooscape recorded it, so a transfer is no later than that and may be earlier. One before Nooscape's first read of the agent is not recorded.",
    };
  } else {
    ownership = {
      present: null,
      changes_recorded: null,
      handouts_recorded: null,
      latest_change_block: null,
      ledger_through_block: null,
      blocks_since_latest_change: null,
      block_days_since_latest_change: null,
      latest_change_recorded_at: null,
      basis: "Ownership changes are not measured for this registry, or the ledger has not covered this agent yet. That is not the same as none.",
    };
  }

  // ---- revoked feedback share: ratings read on Robinhood Chain
  const ratings = entry.ratings ?? null;
  const revoked = ratings
    ? {
        present: ratings.revokedCount > 0,
        rating_count: ratings.ratingCount,
        revoked_count: ratings.revokedCount,
        revoked_share: ratings.ratingCount > 0 ? Math.round((ratings.revokedCount / ratings.ratingCount) * 1000) / 1000 : null,
        measured_through_block: ratings.measuredThroughBlock,
        basis: "Ratings recorded against the agent in the registry's reputation ledger, and how many of them were later revoked by the rater. It says nothing about whether a rating was fair.",
      }
    : {
        present: null,
        rating_count: null,
        revoked_count: null,
        revoked_share: null,
        measured_through_block: null,
        basis: "Ratings are read on Robinhood Chain only, so nothing is measured for this agent.",
      };

  // ---- fleet size: listings registered by one wallet
  const related = entry.related ?? null;
  const fleet = related
    ? {
        present: related.sameWallet > 0,
        listed_by_same_wallet: related.sameWallet + 1,
        same_host_others: related.sameHost,
        same_name_others: related.sameName,
        basis: "A fleet means identities registered by one wallet, and nothing more. The count includes this agent, and counts the listings Nooscape shows.",
      }
    : { present: null, listed_by_same_wallet: null, same_host_others: null, same_name_others: null, basis: "The look-alike counts are not available for this agent." };

  return { first_seen: firstSeen, ownership_changes: ownership, revoked_feedback: revoked, fleet };
}
