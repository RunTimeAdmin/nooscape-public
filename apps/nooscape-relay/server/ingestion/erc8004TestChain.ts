import { BSC_CHAIN, type Erc8004Chain, type PinnedErc8004Chain } from "./erc8004Chains";
import { BSC_FIXTURE_MINTS, BSC_FIXTURE_REGISTERED, BSC_FIXTURE_URI_UPDATES } from "./bscFixtures";

/**
 * A chain that is not in the list, for the tests that show the one chain pass is not BNB Chain's: a different chain id, registry,
 * deploy block, log range, cursor prefix, provider and set of words. Nothing in the pass may know it by name, so every test that
 * runs the pass on it is a test that the pass reads the chain it is given. Used by tests only.
 */
export const DEMO_CHAIN: PinnedErc8004Chain = {
  ...BSC_CHAIN,
  protocol: "erc8004_demo",
  chainKey: "demo",
  chainId: 7777,
  chainIdHex: "0x1e61",
  label: "Demo Chain Mainnet",
  chainLabel: "Demo Chain",
  identityRegistry: "0x1234567890AbcdEF1234567890aBcdef12345678",
  deployBlock: 1_000,
  maxLogRange: 10_000,
  maxWindowLogs: 500,
  handoutBlockWindow: 1_800,
  sourceKey: "demo-erc8004-identity-registry",
  provider: { kind: "pinned", rootUrl: "https://demo-mainnet.example", allowedHostname: "demo-mainnet.example" },
  rpcEnvVar: "DEMO_RPC_URL",
  readRpcUrl: () => "",
  rpc: { timeoutMs: 5_000, maxResponseBytes: 1024 * 1024, retryStatuses: [429], backoffMs: [10, 20, 40] },
  budget: { maxWindows: 10, concurrency: 2, maxElapsedMs: 20_000, maxEvents: 1_000 },
  cursorPrefix: "demo",
  errorPrefix: "Demo",
  logTag: "DEMO",
  fetchSentence: "Nooscape has not read it.",
  listingRules: undefined,
  feature: null,
};

export type LogShape = Record<string, unknown> & { topics: string[] };

/** A real registry log, moved to another registry's address. */
export const atRegistry = <T extends Record<string, unknown>>(log: T, registry: string): T => ({ ...log, address: registry });

export const hexNum = (value: number) => `0x${value.toString(16)}`;
export const word = (value: number) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

const regBase = BSC_FIXTURE_REGISTERED.empty!.log as LogShape;
const mintBase = BSC_FIXTURE_MINTS["6"]! as LogShape;
const updateBase = BSC_FIXTURE_URI_UPDATES[1]!.log as LogShape;

/** A registration (empty URI), the mint that goes with it, and a later URI update, cloned from real logs and set at a chain's registry. */
export const registrationAt = (chain: Erc8004Chain, agentId: number, block: number, logIndex = 0): LogShape => ({
  ...regBase,
  address: chain.identityRegistry,
  blockNumber: hexNum(block),
  logIndex: hexNum(logIndex),
  transactionHash: word(block * 100 + logIndex),
  topics: [regBase.topics[0]!, word(agentId), regBase.topics[2]!],
});

export const mintAt = (chain: Erc8004Chain, agentId: number, block: number, logIndex = 1): LogShape => ({
  ...mintBase,
  address: chain.identityRegistry,
  blockNumber: hexNum(block),
  logIndex: hexNum(logIndex),
  transactionHash: word(block * 100 + logIndex),
  topics: [mintBase.topics[0]!, mintBase.topics[1]!, mintBase.topics[2]!, word(agentId)],
});

export const uriUpdateAt = (chain: Erc8004Chain, agentId: number, block: number, logIndex = 2): LogShape => ({
  ...updateBase,
  address: chain.identityRegistry,
  blockNumber: hexNum(block),
  logIndex: hexNum(logIndex),
  transactionHash: word(block * 100 + logIndex),
  topics: [updateBase.topics[0]!, word(agentId), updateBase.topics[2]!],
});
