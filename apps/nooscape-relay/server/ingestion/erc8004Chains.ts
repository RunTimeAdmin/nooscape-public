import { featureOn, type Feature } from "@shared/features";
import { ENV } from "../_core/env";
import type { RegistryListingRules } from "../agentRegistryRows";
import { arcRpcUrl } from "../arcRpc";
import { BNB_FETCH_SENTENCE } from "../bscSourceNote";

/**
 * The EVM chains whose ERC-8004 identity registry is read by the one chain pass (erc8004Chain.ts, erc8004Rpc.ts and
 * runErc8004Chain.ts). A chain is one entry here and nothing else in the pass: its addresses and block facts, its provider, its
 * limits for one run, its cursor, and the words its messages use. The registry is the same contract at the same address on every
 * chain it runs on, so the decoding is shared and only these facts differ.
 *
 * Robinhood Chain is not here: its walk anchors on block hashes and reads the registry's reputation and activity as well, so it
 * keeps its own adapter (robinhood.ts) and its behaviour is not touched.
 *
 * Nothing here is a secret. A provider's address carries an account key, so it is read from the environment when a run starts
 * (`readRpcUrl`) and never held, logged or put in a message: see erc8004Rpc.ts.
 */

/** How the RPC client behaves for one chain. */
export type Erc8004RpcPolicy = {
  /** One request, from the first byte sent to the last byte read. */
  timeoutMs: number;
  /** The most a response may hold; a longer one is refused as too large. */
  maxResponseBytes: number;
  /** HTTP statuses that are tried again on the ladder below. */
  retryStatuses: readonly number[];
  /** The wait before each further attempt, in order. The attempt after the last wait is the last one. */
  backoffMs: readonly number[];
  /**
   * The fraction of each wait that is added at random, so a retry is not at the same moment every time (0.25 adds up to a quarter
   * of the wait). Absent: the waits are exact. Only a chain on a node shared with something else sets it.
   */
  jitter?: number;
  /** The least time between the end of one call and the start of the next in a run. Absent: no gap. */
  minGapMs?: number;
  /** A request that timed out is tried again on the ladder, as a retried status is. Absent: a timeout ends the call. */
  retryTimeouts?: boolean;
  /** An RPC-layer answer saying the node is busy or limiting its callers is tried again on the ladder. Absent: it ends the call. */
  retryBusy?: boolean;
  /**
   * A refusal with an HTTP error status that is not retried is read for the provider's JSON-RPC explanation, so a window that is
   * too wide or a plan that is too small is named as that and not as "HTTP 400". Alchemy answers such a refusal with a 400.
   */
  readErrorBodies?: boolean;
};

/** What one run may do before it stops and keeps its progress. */
export type Erc8004RunBudget = {
  /** Consecutive windows planned per run. */
  maxWindows: number;
  /** Windows fetched at once. */
  concurrency: number;
  /** No new window is applied after this much wall time; the one in flight finishes. */
  maxElapsedMs: number;
  /** No new window is applied once this many events have been accepted. */
  maxEvents: number;
};

/**
 * Which host the pass may talk to, and the origin its source row records.
 *
 * `pinned`: one provider, named here. The pass refuses an endpoint on any other host, and refuses a source row that records
 * anything else. BNB Chain, Ethereum and Base are pinned.
 *
 * `derived`: the provider is the operator's own, so its host is not in the code. The host is read from the endpoint variable when
 * the operator stages the source, and the source row records it (`https://` and the host). On every run the variable's host must
 * equal the row's, so changing the variable can never send the pass to a host the operator did not stage. Arc is derived.
 */
export type Erc8004Provider = { kind: "pinned"; rootUrl: string; allowedHostname: string } | { kind: "derived" };

export type Erc8004Chain = {
  /** The directory protocol of the source that reads this chain (the `protocol` value on its rows). */
  protocol: string;
  /** The chain's key on the site. */
  chainKey: string;
  chainId: number;
  /** The chain id as the node answers `eth_chainId`: lowercase hex with no leading zeros. */
  chainIdHex: string;
  /** What the source row and the claims panel call the chain, for example "BNB Smart Chain". */
  label: string;
  /** What messages and the site call the chain, for example "BNB Chain". */
  chainLabel: string;
  /** The identity registry proxy. */
  identityRegistry: string;
  /** The block the registry was deployed at: no code at the block before it. */
  deployBlock: number;
  /** The widest `eth_getLogs` block range the provider allows. A window is never wider. */
  maxLogRange: number;
  /** More logs than this in one window is a provider fault, never trusted. */
  maxWindowLogs: number;
  /** About an hour of blocks, for the hand-out rule (a transfer from the minting wallet inside the mint hour). */
  handoutBlockWindow: number;
  sourceKey: string;
  /** The provider host the pass may talk to and what the source row records. The keyed endpoint itself lives only in the environment. */
  provider: Erc8004Provider;
  /** The name of the environment variable that holds the endpoint, for messages. */
  rpcEnvVar: string;
  /** The endpoint, read when a run starts. Empty when it is not set. Secret: never log it or put it in a message. */
  readRpcUrl: () => string;
  rpc: Erc8004RpcPolicy;
  budget: Erc8004RunBudget;
  /** The cursor is `<prefix>:<next block>`. */
  cursorPrefix: string;
  /** Error classes carry this in their names, for example "Bsc" for BscRpcError. */
  errorPrefix: string;
  /** The tag in front of this pass's log lines, without brackets. */
  logTag: string;
  /** The sentence a registry row's note ends its description of a link with. */
  fetchSentence: string;
  /** The listing rules for this chain's registrations. Absent means the registry rows module's own defaults. */
  listingRules?: RegistryListingRules;
  /**
   * The most registry rows one host may hold. A registration past it is counted (agent_directory_registry_overflow) and gets no row and
   * no ledger event (agentRegistryRows.ts, keepWithinHostCap). Absent: every registration is stored, as BNB Chain's always have been.
   */
  hostRowCap?: number;
  /**
   * The chain's ERC-8004 reputation registry, where ratings are written, when the ratings step counts them (server/chainRatings.ts).
   * `registry` is its address and `window` the most blocks one `eth_getLogs` asks for. Absent: the chain's ratings are not measured.
   */
  reputation?: { registry: string; window: number };
  /** The switch that turns the chain on, or null for a chain that is always on. */
  feature: Feature | null;
};

/** A chain whose provider host is named in the code. */
export type PinnedErc8004Chain = Erc8004Chain & { provider: Extract<Erc8004Provider, { kind: "pinned" }> };

/**
 * BNB Smart Chain (docs/bnb-chain-agents-plan-2026-10-13.md, decisions D1 to D3). Chain facts only, no scores and no tiers (D1),
 * and the pass never fetches an agent URI (D2). The values below are the ones the pass has always used.
 */
export const BSC_CHAIN: PinnedErc8004Chain = {
  protocol: "erc8004_bsc",
  chainKey: "bnb",
  chainId: 56,
  chainIdHex: "0x38",
  label: "BNB Smart Chain",
  chainLabel: "BNB Chain",
  /** The identity registry proxy, deployed at the same address on every chain it runs on. */
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  /** The block the registry was deployed at (no code at the block before it; verified on an archive node 2026-10-13). */
  deployBlock: 79_027_268,
  /** The provider's hard `eth_getLogs` ceiling ("exceed maximum block range: 50000"), measured 2026-10-13. */
  maxLogRange: 50_000,
  maxWindowLogs: 30_000,
  /** BNB Smart Chain measured 0.450 s per block on 2026-10-13 (10,000 blocks in 4,500 s), so an hour is 8,000 blocks. */
  handoutBlockWindow: 8_000,
  sourceKey: "bsc-erc8004-identity-registry",
  provider: { kind: "pinned", rootUrl: "https://bsc-mainnet.nodereal.io", allowedHostname: "bsc-mainnet.nodereal.io" },
  rpcEnvVar: "BSC_RPC_URL",
  readRpcUrl: () => ENV.bscRpcUrl,
  rpc: {
    timeoutMs: 30_000,
    /** A dense 50,000-block window measured 1.9 MB; 8 MiB is generous headroom, not a target. */
    maxResponseBytes: 8 * 1024 * 1024,
    retryStatuses: [429, 500, 502, 503, 504],
    backoffMs: [1_000, 3_000],
  },
  budget: {
    /** Consecutive 50,000-block windows planned per run (3M blocks). */
    maxWindows: 60,
    /** Windows fetched at once. The provider rate-limits, so this stays small. */
    concurrency: 6,
    /**
     * No new window is applied after this much wall time; the one in flight finishes. The listing refresh
     * that follows takes up to about half this long on a dense run, so a run stays under a minute.
     */
    maxElapsedMs: 30_000,
    /**
     * No new window is applied once this many events have been accepted. Each accepted registration is a row to
     * classify afterwards, so the cap is what keeps a dense run short: with 60,000 a run took 53 to 69 s end to end in
     * the benchmark, with 30,000 up to 57 s, and a dense window can add up to about 25,000 events past the cap.
     */
    maxEvents: 20_000,
  },
  cursorPrefix: "bsc",
  errorPrefix: "Bsc",
  logTag: "BSC",
  fetchSentence: BNB_FETCH_SENTENCE,
  feature: null,
};

/**
 * The listing rules of the chains added after BNB Chain. PROVISIONAL: they are BNB Chain's numbers (agentRegistryRows.ts,
 * BSC_LISTING_RULES, chosen against that registry on 2026-10-13), taken before any of these registries has had a census. The
 * operator tunes each after its first census. Each chain has a constant of its own, so tuning one never moves another.
 */
export const ETHEREUM_LISTING_RULES: RegistryListingRules = { sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 };
export const BASE_LISTING_RULES: RegistryListingRules = { sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 };
export const ARC_LISTING_RULES: RegistryListingRules = { sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 };

/**
 * The most registry rows one host may hold on the chains added after BNB Chain (docs/flood-host-cap-2026-10-21.md). One platform
 * registered 140,000 agents a day on Base, each a registry row and two ledger rows, against a database limit of 6 GB. Forty times the
 * listing rule's bar for a host (50), so a host that reaches it is held out whatever its rows say, and the rows past it add nothing
 * the count in agent_directory_registry_overflow does not. BNB Chain keeps every row: its pass is not capped.
 */
export const FLOOD_HOST_ROW_CAP = 2_000;

/** The ERC-8004 reputation registry, at the same address on Ethereum, Base and Arc (Arc's contract page names it; each had code there on 2026-10-21). */
export const ERC8004_REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

/**
 * What a registration note says about the link, for the chains whose pass reads no registration file. It says what happened when the
 * registration was recorded, so it stays true if a later pass ever reads files (the BNB Chain note once said it did not fetch, and
 * had to be rewritten when its pass began to).
 */
const RECORDED_ONLY_SENTENCE = "Nooscape did not fetch it when it recorded this registration.";

const MIB = 1024 * 1024;

/**
 * Ethereum mainnet. The identity registry is the same 130-byte proxy at the same address as on every chain (checked 2026-10-20:
 * `eth_chainId` answers 0x1 and `eth_getCode` at the address is 130 bytes). Facts measured 2026-10-20 through NodeReal's archive
 * endpoint (https://docs.nodereal.io/reference/getting-started-with-your-api names the host and the `/v1/<key>` path):
 *  - deploy block 24,339,871 (2026-01-29 10:20:23 UTC), found by binary search on `eth_getCode` (25 probes; empty at 24,339,870,
 *    130 bytes at 24,339,871). Two other ways agree: the first log of any kind from the address is at that block, and the explorers'
 *    creation transaction is in it. The first registration event is at 24,339,925.
 *  - NodeReal refuses a window over 50,000 blocks ("exceed maximum block range: 50000") and a response over 50,000 logs ("logs
 *    count exceeds the limit 50000"). The registry is dense at launch and sparse after: the first 10,000 blocks hold 45,518 events
 *    (about 670 bytes each), and the densest 2,000-block window among them holds 19,200 events and 12.4 MiB, so the response cap
 *    below is twice that and the bound on events is half as much again. A window of 50,000 blocks could not be read in the burst.
 *  - 12.04 s per block over the last 100,000 blocks, so an hour is 299 blocks. `finalized` is served and sat 71 to 93 blocks behind.
 */
export const ETHEREUM_CHAIN: PinnedErc8004Chain = {
  protocol: "erc8004_eth",
  chainKey: "ethereum",
  chainId: 1,
  chainIdHex: "0x1",
  label: "Ethereum",
  chainLabel: "Ethereum",
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  deployBlock: 24_339_871,
  maxLogRange: 2_000,
  maxWindowLogs: 30_000,
  handoutBlockWindow: 299,
  sourceKey: "ethereum-erc8004-identity-registry",
  provider: { kind: "pinned", rootUrl: "https://eth-mainnet.nodereal.io", allowedHostname: "eth-mainnet.nodereal.io" },
  rpcEnvVar: "ETH_RPC_URL",
  readRpcUrl: () => ENV.ethRpcUrl,
  rpc: {
    timeoutMs: 30_000,
    /** Twice the densest window measured (12.4 MiB). BNB Chain's 8 MiB would reject that window and the walk could not pass it. */
    maxResponseBytes: 24 * MIB,
    retryStatuses: [429, 500, 502, 503, 504],
    backoffMs: [1_000, 3_000],
  },
  budget: {
    /** 100 windows of 2,000 blocks: 200,000 blocks a run, so the quiet part of the history is read in about ten runs. */
    maxWindows: 100,
    concurrency: 3,
    maxElapsedMs: 30_000,
    /** Starts smaller than BNB Chain's 20,000. The launch burst alone is tens of thousands of events; the operator raises it after the first runs. */
    maxEvents: 5_000,
  },
  cursorPrefix: "eth",
  errorPrefix: "Eth",
  logTag: "ETH",
  fetchSentence: RECORDED_ONLY_SENTENCE,
  listingRules: ETHEREUM_LISTING_RULES,
  hostRowCap: FLOOD_HOST_ROW_CAP,
  /** Read from the identity registry's deploy block. Window: NodeReal's ceiling is 50,000 blocks, and the registry has had a few thousand ratings in all. */
  reputation: { registry: ERC8004_REPUTATION_REGISTRY, window: 50_000 },
  feature: "chain_ethereum",
};

/**
 * Base mainnet (chain id 8453, `eth_chainId` 0x2105). The registry is the same proxy at the same address (checked 2026-10-20). Read
 * through Alchemy (https://www.alchemy.com/docs/reference/base-api-quickstart names the host and the `/v2/<key>` path), because
 * NodeReal's Base endpoint serves history only from block 50,000,000 (about 65 days) and the registry's Base history starts earlier.
 * Facts measured 2026-10-20:
 *  - deploy block 41,663,783 (2026-02-03 11:08:33 UTC), the block of the registry's creation transaction. No endpoint serves state
 *    that far back, so there is no `eth_getCode` search. The explorer's creation transaction names the block; the block header's
 *    timestamp matches the explorer's; two public nodes and Alchemy each return 3 logs from the address in it; and Alchemy's first
 *    log of any kind from the address, found by a forward walk from 41,663,000, is in it, with none in the 10 blocks before. The
 *    first registration event is at block 41,673,162, about 5 hours later.
 *  - 2.0000 s per block over the last 100,000 blocks, so an hour is 1,800 blocks. `finalized` is served and sat 617 to 852 behind.
 *  - Alchemy's Free plan allows `eth_getLogs` over 10 blocks, so it cannot walk this history; the Pay As You Go plan answers a window
 *    of 10,000 blocks in full ("up to a 10,000 block range and no limit on the response size, or any block range with a cap of 10K
 *    logs") and refuses a 250,000-block window that holds more than 10,000 logs. A plan that allows only 10 blocks refuses the first
 *    window with a block-range error, and the run fails with the cursor untouched.
 *  - The registry is quiet for most of its life (38 of 40 sampled 1,000-block windows across it hold 40 events or fewer) and is now
 *    in a surge: the latest 10,000 blocks hold 82,477 events (26,647 registrations from 26,606 wallets, 55,830 transfers), and the rate
 *    per 1,000 blocks rose from about 2,300 to 10,404 over the last 30,000 blocks, a 6.7 MiB response at 682 bytes an event. The
 *    window is therefore 1,000 blocks, the smallest the pass splits to, and the caps below leave 3.6 times the densest window.
 *  - 321,929 registrations to the head, counted exactly: 222,661 (69%) in the last 10 days and 54,227 in the latest 24 hours, against
 *    a few hundred a day before. The pass walks all of it from the deploy block.
 */
export const BASE_CHAIN: PinnedErc8004Chain = {
  protocol: "erc8004_base",
  chainKey: "base",
  chainId: 8453,
  chainIdHex: "0x2105",
  label: "Base",
  chainLabel: "Base",
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  deployBlock: 41_663_783,
  maxLogRange: 1_000,
  /** 3.8 times the densest 1,000-block window measured (10,404 events). Above this a window is a provider fault and fails the run. */
  maxWindowLogs: 40_000,
  handoutBlockWindow: 1_800,
  sourceKey: "base-erc8004-identity-registry",
  provider: { kind: "pinned", rootUrl: "https://base-mainnet.g.alchemy.com", allowedHostname: "base-mainnet.g.alchemy.com" },
  rpcEnvVar: "BASE_RPC_URL",
  readRpcUrl: () => ENV.baseRpcUrl,
  rpc: {
    timeoutMs: 30_000,
    /** 3.6 times the densest 1,000-block window measured (6.7 MiB). */
    maxResponseBytes: 24 * MIB,
    retryStatuses: [429, 500, 502, 503, 504],
    backoffMs: [1_000, 3_000],
    /** Alchemy explains a refused range, in words, in the body of an HTTP 400. */
    readErrorBodies: true,
  },
  budget: {
    /** 200 windows of 1,000 blocks: 200,000 blocks a run, so the 11 million blocks of history are read in at least 56 runs (189 on 2026-10-20, where the history is dense). */
    maxWindows: 200,
    /** Two at once: a window in the surge is about 7 MB, and a window fetched beyond the run's event cap is read again next run. */
    concurrency: 2,
    maxElapsedMs: 30_000,
    /**
     * 40,000, eight times the first value. The first attended runs on the production database took about 0.4 milliseconds an event
     * (5,000 to 6,000 events in 2 seconds), and the shared worker gives Base about 23 runs a day, so 5,000 events a run could not keep
     * up with a chain that adds 280,000 events a day (docs/base-backfill-throughput-2026-10-20.md). The cap is checked between windows,
     * so a run can pass it by one window.
     */
    maxEvents: 40_000,
  },
  cursorPrefix: "base",
  errorPrefix: "Base",
  logTag: "BASE",
  fetchSentence: RECORDED_ONLY_SENTENCE,
  listingRules: BASE_LISTING_RULES,
  hostRowCap: FLOOD_HOST_ROW_CAP,
  /** Read from the identity registry's deploy block. Window: Alchemy's Pay As You Go plan answers any range that holds 10,000 logs or fewer, and the registry held about 3,000 events in a 10,000-block window on 2026-10-21, so a window of 50,000 is whole in the sparse years and a result-size refusal halves it in the dense days. */
  reputation: { registry: ERC8004_REPUTATION_REGISTRY, window: 50_000 },
  feature: "chain_base",
};

/**
 * Arc mainnet (chain id 5042, `eth_chainId` 0x13b2; https://docs.arc.io/arc/references/connect-to-arc). The registry is the same
 * proxy at the same address (https://docs.arc.io/arc/references/contract-addresses; checked 2026-10-20). The node is the operator's
 * own, reached through the address the payment code keeps in `X402_RPC` (server/arcRpc.ts), so the pass shares it with payment
 * checks and goes easy on it: one request at a time, a pause between requests, a timeout shorter than a payment check's, and waits
 * that back off with jitter. The public Arc RPC is not used. The host is the operator's: see `Erc8004Provider`.
 * Facts measured 2026-10-20 through that node:
 *  - creation block 13,344,062 (2026-08-01 14:51:51 UTC): the first log of any kind from the address, found by a forward walk of
 *    50,000-block windows from block 1. The node serves headers and logs from block 1 but prunes state, so the `eth_getCode`
 *    search is not available; the same method gave Ethereum's block exactly. The first registration event is at 21,156,191
 *    (2026-09-16 12:19:45 UTC), 7.8 million blocks later, and the whole history holds about 6,000 events.
 *  - 0.508 s per block, so an hour is about 7,080 blocks. `finalized` is served and equals the head: Arc finalizes instantly.
 *  - the node accepted windows up to 5,000,000 blocks (5,937 events, 5.6 MB), the widest tried. The window is 100,000 blocks,
 *    which keeps every response under 0.3 MB and each call light.
 */
export const ARC_CHAIN: Erc8004Chain = {
  protocol: "erc8004_arc",
  chainKey: "arc",
  chainId: 5042,
  chainIdHex: "0x13b2",
  label: "Arc",
  chainLabel: "Arc",
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  deployBlock: 13_344_062,
  maxLogRange: 100_000,
  maxWindowLogs: 30_000,
  handoutBlockWindow: 7_080,
  sourceKey: "arc-erc8004-identity-registry",
  provider: { kind: "derived" },
  rpcEnvVar: "X402_RPC",
  readRpcUrl: () => arcRpcUrl(process.env) ?? "",
  rpc: {
    /** Shorter than the payment code's 8 s, so a slow node fails the import first and not a payment check. */
    timeoutMs: 6_000,
    maxResponseBytes: 2 * MIB,
    retryStatuses: [429, 500, 502, 503, 504],
    /** Doubling waits, then the run stops and keeps its cursor; the next tick tries again. */
    backoffMs: [1_000, 2_000, 4_000],
    jitter: 0.25,
    minGapMs: 250,
    retryTimeouts: true,
    retryBusy: true,
  },
  budget: {
    maxWindows: 10,
    /** One request at a time, never parallel windows. */
    concurrency: 1,
    maxElapsedMs: 20_000,
    maxEvents: 1_000,
  },
  cursorPrefix: "arc",
  errorPrefix: "Arc",
  logTag: "ARC",
  fetchSentence: RECORDED_ONLY_SENTENCE,
  listingRules: ARC_LISTING_RULES,
  hostRowCap: FLOOD_HOST_ROW_CAP,
  /** Read from the identity registry's deploy block. Window: the identity pass's own window on the same node, which keeps each call light. */
  reputation: { registry: ERC8004_REPUTATION_REGISTRY, window: 100_000 },
  feature: "chain_arc",
};

/** Every chain the pass reads, in the order they were added. */
export const ERC8004_CHAINS: readonly Erc8004Chain[] = [BSC_CHAIN, ETHEREUM_CHAIN, BASE_CHAIN, ARC_CHAIN];

/** The chain a source protocol belongs to, or null when the protocol is not read by this pass. */
export function erc8004ChainOfProtocol(protocol: string): Erc8004Chain | null {
  return ERC8004_CHAINS.find(chain => chain.protocol === protocol) ?? null;
}

/**
 * Whether the chain is switched on: a chain with no switch always is. The list is `VITE_FEATURES`, which the client reads when it is
 * built and the server when it runs (shared/features.ts), so what the site shows and what the pass does agree.
 */
export function erc8004ChainOn(chain: Erc8004Chain, features: string | undefined = process.env.VITE_FEATURES): boolean {
  return chain.feature === null || featureOn(chain.feature, features);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_NUMBER = /^0x[1-9a-f][0-9a-f]*$/;
const PREFIX = /^[a-z]{2,12}$/;
const SOURCE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOSTNAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const LABEL = /^[A-Za-z0-9 ]{2,40}$/;

/**
 * What a chain entry must satisfy, as a list of what is wrong with each entry (empty when the list is sound). A test runs it over
 * ERC8004_CHAINS, so an entry with a missing fact, a wrong hex form or a clash with another entry fails the build and not a run.
 */
export function validateErc8004Chains(chains: readonly Erc8004Chain[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const claim = (field: string, value: string | number, who: string) => {
    const key = `${field}:${String(value).toLowerCase()}`;
    const other = seen.get(key);
    if (other !== undefined) problems.push(`${who} repeats the ${field} of ${other}`);
    else seen.set(key, who);
  };
  for (const chain of chains) {
    const who = chain.protocol;
    claim("protocol", chain.protocol, who);
    claim("chain id", chain.chainId, who);
    claim("source key", chain.sourceKey, who);
    claim("cursor prefix", chain.cursorPrefix, who);
    claim("chain key", chain.chainKey, who);
    if (!/^erc8004_[a-z]+$/.test(chain.protocol)) problems.push(`${who}: the protocol must be erc8004_ and lowercase letters`);
    if (!Number.isSafeInteger(chain.chainId) || chain.chainId < 1) problems.push(`${who}: the chain id must be a positive integer`);
    if (!HEX_NUMBER.test(chain.chainIdHex) || Number.parseInt(chain.chainIdHex.slice(2), 16) !== chain.chainId) problems.push(`${who}: the hex chain id must be the chain id in lowercase hex`);
    if (!ADDRESS.test(chain.identityRegistry)) problems.push(`${who}: the identity registry is not an address`);
    if (!Number.isSafeInteger(chain.deployBlock) || chain.deployBlock < 1) problems.push(`${who}: the deploy block must be a positive integer`);
    // A window that a result-size rejection splits never goes below 1,000 blocks, so a ceiling below that cannot be walked.
    if (!Number.isSafeInteger(chain.maxLogRange) || chain.maxLogRange < 1_000) problems.push(`${who}: the log range must be at least 1,000 blocks`);
    if (!Number.isSafeInteger(chain.maxWindowLogs) || chain.maxWindowLogs < 1) problems.push(`${who}: the window log bound must be a positive integer`);
    if (!Number.isSafeInteger(chain.handoutBlockWindow) || chain.handoutBlockWindow < 1) problems.push(`${who}: the hand-out block window must be a positive integer`);
    if (!SOURCE_KEY.test(chain.sourceKey)) problems.push(`${who}: the source key must be lowercase words joined by hyphens`);
    if (!PREFIX.test(chain.cursorPrefix)) problems.push(`${who}: the cursor prefix must be 2 to 12 lowercase letters`);
    if (!/^[A-Z][A-Za-z]{1,11}$/.test(chain.errorPrefix)) problems.push(`${who}: the error prefix must be a capitalised word`);
    if (!/^[A-Za-z]{2,12}$/.test(chain.logTag)) problems.push(`${who}: the log tag must be a short word`);
    if (!LABEL.test(chain.label) || !LABEL.test(chain.chainLabel)) problems.push(`${who}: the labels must be plain words`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(chain.rpcEnvVar)) problems.push(`${who}: the endpoint variable must be an upper-case name`);
    if (chain.fetchSentence.trim() === "") problems.push(`${who}: the fetch sentence is empty`);
    if (chain.provider.kind === "pinned") {
      const { rootUrl, allowedHostname } = chain.provider;
      try {
        const root = new URL(rootUrl);
        if (root.protocol !== "https:" || root.username || root.password || root.pathname !== "/" || root.search || root.hash) problems.push(`${who}: the root URL must be a bare https origin`);
        if (root.hostname !== allowedHostname) problems.push(`${who}: the allowed host must be the root URL's host`);
      } catch {
        problems.push(`${who}: the root URL is not a URL`);
      }
      if (!HOSTNAME.test(allowedHostname)) problems.push(`${who}: the allowed host must be a lowercase host name`);
    } else if ((chain.provider as { kind: string }).kind !== "derived") {
      problems.push(`${who}: the provider must be pinned or derived`);
    }
    const { rpc, budget } = chain;
    if (!(rpc.timeoutMs > 0) || !(rpc.maxResponseBytes > 0)) problems.push(`${who}: the RPC timeout and response cap must be positive`);
    if (rpc.retryStatuses.some(status => !Number.isInteger(status) || status < 400 || status > 599)) problems.push(`${who}: a retried status must be an HTTP error status`);
    if (rpc.backoffMs.some(wait => !(wait >= 0))) problems.push(`${who}: a back-off wait must not be negative`);
    if (rpc.jitter !== undefined && !(rpc.jitter >= 0 && rpc.jitter <= 1)) problems.push(`${who}: the jitter must be a fraction between 0 and 1`);
    if (rpc.minGapMs !== undefined && !(Number.isFinite(rpc.minGapMs) && rpc.minGapMs >= 0)) problems.push(`${who}: the gap between calls must not be negative`);
    // A gap between calls only means something when calls are made one after another.
    if (rpc.minGapMs !== undefined && rpc.minGapMs > 0 && budget.concurrency !== 1) problems.push(`${who}: a gap between calls needs a run budget that fetches one window at a time`);
    for (const [name, value] of Object.entries(budget)) {
      if (!Number.isSafeInteger(value) || value < 1) problems.push(`${who}: the run budget's ${name} must be a positive integer`);
    }
    if (budget.concurrency > budget.maxWindows) problems.push(`${who}: the run budget fetches more windows at once than it plans`);
    if (chain.listingRules) {
      for (const [name, value] of Object.entries(chain.listingRules)) {
        if (!Number.isSafeInteger(value) || value < 2) problems.push(`${who}: the listing rule ${name} must be 2 or more`);
      }
    }
    if (chain.reputation !== undefined) {
      if (!ADDRESS.test(chain.reputation.registry)) problems.push(`${who}: the reputation registry is not an address`);
      if (!Number.isSafeInteger(chain.reputation.window) || chain.reputation.window < 1) problems.push(`${who}: the reputation window must be a positive whole number of blocks`);
    }
    // Rows past the cap are not stored, so the cap must leave a host's stored rows well over the bar the listing rule counts them against.
    if (chain.hostRowCap !== undefined) {
      const bar = chain.listingRules?.sharedHostFrom ?? 50;
      if (!Number.isSafeInteger(chain.hostRowCap) || chain.hostRowCap < bar * 2) problems.push(`${who}: the host row cap must be a whole number of at least twice the host rule (${bar * 2})`);
    }
  }
  return problems;
}
