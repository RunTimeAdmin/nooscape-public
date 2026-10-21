import { BSC_CHAIN } from "./erc8004Chains";
import {
  ERC8004_IDENTITY_TOPIC_FILTER,
  ERC8004_REGISTERED_TOPIC,
  ERC8004_TRANSFER_TOPIC,
  ERC8004_URI_UPDATED_TOPIC,
  cursorFor,
  decodeRegisteredLog,
  decodeUriUpdatedLog,
  directoryDraft,
  externalKey,
  hasProfileLink,
  parseCursor,
  parseWindowLogs,
  planWindows,
  registryChainOf,
  uriFacts,
  type ChainWindow,
  type Registration,
  type UriFacts,
  type UriUpdate,
  type WindowParse,
} from "./erc8004Chain";
import type { EvmRegistryChain } from "./robinhood";

/**
 * The BNB Smart Chain view of the ERC-8004 identity pass (docs/bnb-chain-agents-plan-2026-10-13.md, decisions D1 to D3).
 *
 * The decoding and planning are one implementation for every chain (erc8004Chain.ts), driven by the chain's entry in
 * erc8004Chains.ts, and this file only gives the BNB Chain's entry its long-standing names: the constants, the cursor
 * functions and the decoders the rest of the BNB code imports. Every value, message and behaviour is the one the pass had
 * before the importer was made generic, and the BNB tests hold that unchanged.
 */

export const BSC_SOURCE_KEY = BSC_CHAIN.sourceKey;
/**
 * What the source row records. The keyed endpoint itself lives only in the
 * environment (BSC_RPC_URL); the row names the provider host the pass is allowed
 * to talk to, and the pass refuses an endpoint whose host differs.
 */
export const BSC_ROOT_URL = BSC_CHAIN.provider.rootUrl;
export const BSC_ALLOWED_HOSTNAME = BSC_CHAIN.provider.allowedHostname;
export const BSC_CHAIN_ID = BSC_CHAIN.chainId;
export const BSC_CHAIN_ID_HEX = BSC_CHAIN.chainIdHex;
/** The identity registry proxy, deployed at the same address on every chain it runs on. */
export const BSC_IDENTITY_REGISTRY = BSC_CHAIN.identityRegistry;
export const BSC_REGISTRY_CHAIN: EvmRegistryChain = registryChainOf(BSC_CHAIN);
/** The block the registry was deployed at (no code at the block before it; verified on an archive node 2026-10-13). */
export const BSC_DEPLOY_BLOCK = BSC_CHAIN.deployBlock;
/** The provider's hard `eth_getLogs` ceiling ("exceed maximum block range: 50000"), measured 2026-10-13. */
export const BSC_MAX_LOG_RANGE = BSC_CHAIN.maxLogRange;

export const BSC_REGISTERED_TOPIC = ERC8004_REGISTERED_TOPIC;
export const BSC_TRANSFER_TOPIC = ERC8004_TRANSFER_TOPIC;
export const BSC_URI_UPDATED_TOPIC = ERC8004_URI_UPDATED_TOPIC;
/** One `eth_getLogs` filter for all three event kinds: topic0 is an OR list at position zero. */
export const BSC_IDENTITY_TOPIC_FILTER: string[][] = ERC8004_IDENTITY_TOPIC_FILTER;

/** The pass's own rules failing on this chain. The same class every chain's pass throws, named for the chain when it is thrown. */
export { Erc8004ValidationError as BscRegistryValidationError } from "./erc8004Chain";

// ---------------------------------------------------------------- cursor and windows

/**
 * The persisted position: `bsc:<next block>` means every block below it is
 * done. A fresh source starts at the deploy block. Anything else fails closed,
 * so a corrupted cursor can never silently rescan or skip history.
 */
export const parseBscCursor = (cursor: string | null): { nextBlock: number } => parseCursor(BSC_CHAIN, cursor);

export const bscCursorFor = (nextBlock: number): string => cursorFor(BSC_CHAIN, nextBlock);

export type BscWindow = ChainWindow;

/**
 * Consecutive ascending windows of at most the provider's range ceiling, from
 * the cursor up to the finalized block, capped at `maxWindows`. Empty when the
 * walk is caught up. Pure.
 */
export const planBscWindows = (nextBlock: number, finalizedBlock: number, maxWindows: number): BscWindow[] => planWindows(BSC_CHAIN, nextBlock, finalizedBlock, maxWindows);

// ---------------------------------------------------------------- URI facts

export type BscUriFacts = UriFacts;

/** What the registry-recorded URI says, derived from its bytes alone. Pure. */
export const bscUriFacts = (uri: string): BscUriFacts => uriFacts(uri);

/**
 * Whether the recorded URI is a usable profile link: a web link, an IPFS
 * reference, or inline JSON that parsed. An empty URI, an unrecognized scheme,
 * and inline JSON that did not parse (or exceeded the derived-view bound) give
 * the listing rules nothing to compare, so such a registration is held out of
 * the directory listing. Decided from the URI's bytes alone; never fetched.
 */
export const bscHasProfileLink = (facts: BscUriFacts): boolean => hasProfileLink(facts);

// ---------------------------------------------------------------- Registered

export type BscRegistration = Registration;

/** The directory key every BSC identity is stored under. */
export const bscExternalKey = (agentId: string): string => externalKey(BSC_CHAIN, agentId);

type Bounds = { fromBlock: number; toBlock: number };

/**
 * Decodes one `Registered(uint256 indexed agentId, string agentURI, address
 * indexed owner)` log. Returns null for anything that is not that event from
 * the approved registry inside the window, or whose URI does not decode as one
 * bounded ABI string; the caller counts it as rejected.
 */
export const decodeBscRegisteredLog = (log: unknown, bounds: Bounds): BscRegistration | null => decodeRegisteredLog(BSC_CHAIN, log, bounds);

/**
 * One registry row for a registration. Everything on it is a chain fact or a
 * locally decoded self-assertion: the name only when the URI is inline JSON
 * that carries one, the host only for an https URI, and never a fetch. It is
 * written to the registry rows table, not the directory: the listing rules
 * decide which registrations are published (see agentRegistryRows.ts).
 */
export const bscDirectoryDraft = (registration: BscRegistration) => directoryDraft(BSC_CHAIN, registration);

// ---------------------------------------------------------------- URIUpdated

export type BscUriUpdate = UriUpdate;

export const decodeBscUriUpdatedLog = (log: unknown, bounds: Bounds): BscUriUpdate | null => decodeUriUpdatedLog(BSC_CHAIN, log, bounds);

// ---------------------------------------------------------------- one window

export type BscWindowParse = WindowParse;

/** A window larger than this is a provider fault (or a burst the range cap should have prevented), never trusted. */
export const BSC_MAX_WINDOW_LOGS = BSC_CHAIN.maxWindowLogs;

/**
 * Decodes one window's `eth_getLogs` response. Registrations become directory
 * rows, mints and transfers and URI updates become ledger rows, and anything
 * else from the registry is counted as rejected and never stored. Events are
 * returned in (block, log index) order so a registration is always applied
 * before the URI update that follows it.
 */
export const parseBscWindowLogs = (logs: unknown, bounds: Bounds): BscWindowParse => parseWindowLogs(BSC_CHAIN, logs, bounds);
