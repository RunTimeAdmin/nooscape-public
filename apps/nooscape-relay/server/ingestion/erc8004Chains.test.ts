import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BSC_LISTING_RULES } from "../agentRegistryRows";
import { BNB_FETCH_SENTENCE } from "../bscSourceNote";
import {
  ARC_CHAIN,
  ARC_LISTING_RULES,
  BASE_CHAIN,
  BASE_LISTING_RULES,
  BSC_CHAIN,
  ERC8004_CHAINS,
  ETHEREUM_CHAIN,
  ERC8004_REPUTATION_REGISTRY,
  ETHEREUM_LISTING_RULES,
  FLOOD_HOST_ROW_CAP,
  erc8004ChainOfProtocol,
  erc8004ChainOn,
  validateErc8004Chains,
  type Erc8004Chain,
} from "./erc8004Chains";
import { DEMO_CHAIN } from "./erc8004TestChain";
import { evmIdentityChain } from "./evmIdentityChains";
import { ROBINHOOD_HANDOUT_BLOCK_WINDOW } from "./robinhood";

const MIB = 1024 * 1024;
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

/**
 * The list of chains the one ERC-8004 identity pass reads. Every entry is pinned here field by field: a change to any of them is a
 * change to a pass that is running or about to, and must be seen as one. The values come from measurements made on 2026-10-20 and
 * recorded in the comments of erc8004Chains.ts (docs/multichain-erc8004-2026-10-20.md has the numbers).
 */
describe("the BNB Smart Chain entry", () => {
  it("holds the facts the pass has always used", () => {
    expect(BSC_CHAIN).toMatchObject({
      protocol: "erc8004_bsc",
      chainKey: "bnb",
      chainId: 56,
      chainIdHex: "0x38",
      label: "BNB Smart Chain",
      chainLabel: "BNB Chain",
      identityRegistry: REGISTRY,
      deployBlock: 79_027_268,
      maxLogRange: 50_000,
      maxWindowLogs: 30_000,
      handoutBlockWindow: 8_000,
      sourceKey: "bsc-erc8004-identity-registry",
      provider: { kind: "pinned", rootUrl: "https://bsc-mainnet.nodereal.io", allowedHostname: "bsc-mainnet.nodereal.io" },
      rpcEnvVar: "BSC_RPC_URL",
      cursorPrefix: "bsc",
      errorPrefix: "Bsc",
      logTag: "BSC",
      fetchSentence: BNB_FETCH_SENTENCE,
      feature: null,
    });
    expect(BSC_CHAIN.rpc).toEqual({ timeoutMs: 30_000, maxResponseBytes: 8 * MIB, retryStatuses: [429, 500, 502, 503, 504], backoffMs: [1_000, 3_000] });
    expect(BSC_CHAIN.budget).toEqual({ maxWindows: 60, concurrency: 6, maxElapsedMs: 30_000, maxEvents: 20_000 });
    // It has no listing rules of its own, so the registry rows module's published defaults apply, as they always have.
    expect(BSC_CHAIN.listingRules).toBeUndefined();
    // And none of the options the shared client gained for a node it shares: it makes its calls as it always has.
    expect(Object.keys(BSC_CHAIN.rpc).sort()).toEqual(["backoffMs", "maxResponseBytes", "retryStatuses", "timeoutMs"]);
  });

  it("reads its endpoint from the environment when asked and never holds it", () => {
    expect(typeof BSC_CHAIN.readRpcUrl()).toBe("string");
    expect(JSON.stringify(BSC_CHAIN)).not.toMatch(/nodereal[.]io[/]v1/);
  });
});

describe("the Ethereum entry", () => {
  it("holds the facts measured on 2026-10-20", () => {
    expect(ETHEREUM_CHAIN).toMatchObject({
      protocol: "erc8004_eth",
      chainKey: "ethereum",
      chainId: 1,
      chainIdHex: "0x1",
      label: "Ethereum",
      chainLabel: "Ethereum",
      identityRegistry: REGISTRY,
      deployBlock: 24_339_871,
      maxLogRange: 2_000,
      maxWindowLogs: 30_000,
      handoutBlockWindow: 299,
      sourceKey: "ethereum-erc8004-identity-registry",
      provider: { kind: "pinned", rootUrl: "https://eth-mainnet.nodereal.io", allowedHostname: "eth-mainnet.nodereal.io" },
      rpcEnvVar: "ETH_RPC_URL",
      cursorPrefix: "eth",
      errorPrefix: "Eth",
      logTag: "ETH",
      feature: "chain_ethereum",
    });
    expect(ETHEREUM_CHAIN.rpc).toEqual({ timeoutMs: 30_000, maxResponseBytes: 24 * MIB, retryStatuses: [429, 500, 502, 503, 504], backoffMs: [1_000, 3_000] });
    expect(ETHEREUM_CHAIN.budget).toEqual({ maxWindows: 100, concurrency: 3, maxElapsedMs: 30_000, maxEvents: 5_000 });
    expect(ETHEREUM_CHAIN.listingRules).toBe(ETHEREUM_LISTING_RULES);
  });

  it("walks the registry's whole history in windows the provider accepts: nothing wider than its 50,000-block ceiling", () => {
    expect(ETHEREUM_CHAIN.maxLogRange).toBeLessThanOrEqual(50_000);
  });
});

describe("the Base entry", () => {
  it("holds the facts measured on 2026-10-20", () => {
    expect(BASE_CHAIN).toMatchObject({
      protocol: "erc8004_base",
      chainKey: "base",
      chainId: 8453,
      chainIdHex: "0x2105",
      label: "Base",
      chainLabel: "Base",
      identityRegistry: REGISTRY,
      deployBlock: 41_663_783,
      maxLogRange: 1_000,
      maxWindowLogs: 40_000,
      handoutBlockWindow: 1_800,
      sourceKey: "base-erc8004-identity-registry",
      provider: { kind: "pinned", rootUrl: "https://base-mainnet.g.alchemy.com", allowedHostname: "base-mainnet.g.alchemy.com" },
      rpcEnvVar: "BASE_RPC_URL",
      cursorPrefix: "base",
      errorPrefix: "Base",
      logTag: "BASE",
      feature: "chain_base",
    });
    expect(BASE_CHAIN.rpc).toEqual({ timeoutMs: 30_000, maxResponseBytes: 24 * MIB, retryStatuses: [429, 500, 502, 503, 504], backoffMs: [1_000, 3_000], readErrorBodies: true });
    expect(BASE_CHAIN.budget).toEqual({ maxWindows: 200, concurrency: 2, maxElapsedMs: 30_000, maxEvents: 40_000 });
    expect(BASE_CHAIN.listingRules).toBe(BASE_LISTING_RULES);
  });

  it("walks no wider than the provider's plan allows: its Pay As You Go plan answered 10,000 blocks in full, the Free plan 10", () => {
    expect(BASE_CHAIN.maxLogRange).toBeLessThanOrEqual(10_000);
    expect(BASE_CHAIN.maxLogRange).toBeGreaterThan(10);
  });
});

describe("the Arc entry", () => {
  it("holds the facts measured on 2026-10-20", () => {
    expect(ARC_CHAIN).toMatchObject({
      protocol: "erc8004_arc",
      chainKey: "arc",
      chainId: 5042,
      chainIdHex: "0x13b2",
      label: "Arc",
      chainLabel: "Arc",
      identityRegistry: REGISTRY,
      deployBlock: 13_344_062,
      maxLogRange: 100_000,
      maxWindowLogs: 30_000,
      handoutBlockWindow: 7_080,
      sourceKey: "arc-erc8004-identity-registry",
      provider: { kind: "derived" },
      rpcEnvVar: "X402_RPC",
      cursorPrefix: "arc",
      errorPrefix: "Arc",
      logTag: "ARC",
      feature: "chain_arc",
    });
    expect(ARC_CHAIN.rpc).toEqual({
      timeoutMs: 6_000,
      maxResponseBytes: 2 * MIB,
      retryStatuses: [429, 500, 502, 503, 504],
      backoffMs: [1_000, 2_000, 4_000],
      jitter: 0.25,
      minGapMs: 250,
      retryTimeouts: true,
      retryBusy: true,
    });
    expect(ARC_CHAIN.budget).toEqual({ maxWindows: 10, concurrency: 1, maxElapsedMs: 20_000, maxEvents: 1_000 });
    expect(ARC_CHAIN.listingRules).toBe(ARC_LISTING_RULES);
  });

  it("shares its node with payment checks and goes easy on it: one request at a time, a pause, and a shorter timeout than a payment check's", () => {
    // The payment client's own default, read from its source so the two cannot drift apart unseen.
    const source = readFileSync(path.resolve(process.cwd(), "server", "x402Chain.ts"), "utf8");
    const paymentTimeout = Number((/export function rpcClient[^)]*timeoutMs = ([0-9_]+)/.exec(source)?.[1] ?? "").replace(/_/g, ""));
    expect(paymentTimeout).toBe(8_000);
    expect(ARC_CHAIN.rpc.timeoutMs).toBeLessThan(paymentTimeout);
    expect(ARC_CHAIN.budget.concurrency).toBe(1);
    expect(ARC_CHAIN.rpc.minGapMs).toBeGreaterThanOrEqual(250);
    // Back-off doubles and then stops: after the last wait the run ends and keeps its cursor.
    expect(ARC_CHAIN.rpc.backoffMs).toEqual([1_000, 2_000, 4_000]);
  });

  it("reads the node through the payment code's one setting, and has no variable of its own", () => {
    expect(ARC_CHAIN.rpcEnvVar).toBe("X402_RPC");
    const source = readFileSync(path.resolve(process.cwd(), "server", "ingestion", "erc8004Chains.ts"), "utf8");
    expect(source).not.toContain("ARC_RPC_URL");
    // The public Arc address is named here without being written out, so this file does not hold it either.
    expect(source).not.toContain(["rpc", "mainnet", "arc", "io"].join("."));
  });
});

describe("what the measurements ask of the caps", () => {
  // The densest windows measured on 2026-10-20. A cap below one of these would stall the walk at that window.
  const ETHEREUM_DENSEST_2000 = { events: 19_200, bytes: 12_994_910 };
  const BASE_DENSEST_1000 = { events: 10_404, bytes: Math.round(6.72 * MIB) };

  it("leaves Ethereum's response cap and event bound room above its densest 2,000-block window", () => {
    expect(ETHEREUM_CHAIN.rpc.maxResponseBytes).toBeGreaterThanOrEqual(1.5 * ETHEREUM_DENSEST_2000.bytes);
    expect(ETHEREUM_CHAIN.maxWindowLogs).toBeGreaterThanOrEqual(1.5 * ETHEREUM_DENSEST_2000.events);
  });

  it("would not have, with BNB Chain's 8 MiB: that window is larger, which is why Ethereum's cap is its own", () => {
    expect(ETHEREUM_DENSEST_2000.bytes).toBeGreaterThan(BSC_CHAIN.rpc.maxResponseBytes);
  });

  it("leaves Base's response cap and event bound room above its densest 1,000-block window, which is in a surge", () => {
    expect(BASE_CHAIN.rpc.maxResponseBytes).toBeGreaterThanOrEqual(3 * BASE_DENSEST_1000.bytes);
    expect(BASE_CHAIN.maxWindowLogs).toBeGreaterThanOrEqual(3 * BASE_DENSEST_1000.events);
  });

  it("keeps a window to the smallest the pass splits to on the chain in a surge", () => {
    expect(BASE_CHAIN.maxLogRange).toBe(1_000);
  });
});

describe("every chain after BNB Chain", () => {
  const later: readonly Erc8004Chain[] = [ETHEREUM_CHAIN, BASE_CHAIN, ARC_CHAIN];

  it("has a switch named for its key, its own listing rules and a note that says only what happened", () => {
    for (const chain of later) {
      expect(chain.feature, chain.protocol).toBe(`chain_${chain.chainKey}`);
      expect(chain.listingRules, chain.protocol).toBeDefined();
      expect(chain.fetchSentence, chain.protocol).toBe("Nooscape did not fetch it when it recorded this registration.");
    }
  });

  it("has listing rules of its own: a constant each, equal to BNB Chain's for now, which are provisional until its first census", () => {
    expect(new Set([ETHEREUM_LISTING_RULES, BASE_LISTING_RULES, ARC_LISTING_RULES]).size).toBe(3);
    for (const rules of [ETHEREUM_LISTING_RULES, BASE_LISTING_RULES, ARC_LISTING_RULES]) {
      expect(rules).toEqual(BSC_LISTING_RULES);
      expect(rules).not.toBe(BSC_LISTING_RULES);
    }
  });

  it("caps the rows one host may hold at forty times the host rule, where BNB Chain keeps every row", () => {
    expect(FLOOD_HOST_ROW_CAP).toBe(2_000);
    for (const chain of later) {
      expect(chain.hostRowCap, chain.protocol).toBe(FLOOD_HOST_ROW_CAP);
      expect(chain.hostRowCap! / chain.listingRules!.sharedHostFrom, chain.protocol).toBe(40);
    }
    expect(BSC_CHAIN.hostRowCap).toBeUndefined();
  });

  it("names the reputation registry the ratings step counts, at the one address, with a window each provider answers in full", () => {
    expect(ERC8004_REPUTATION_REGISTRY).toBe(REPUTATION_REGISTRY);
    expect(later.map(chain => [chain.protocol, chain.reputation])).toEqual([
      ["erc8004_eth", { registry: REPUTATION_REGISTRY, window: 50_000 }],
      ["erc8004_base", { registry: REPUTATION_REGISTRY, window: 50_000 }],
      ["erc8004_arc", { registry: REPUTATION_REGISTRY, window: 100_000 }],
    ]);
    // BNB Chain keeps its own internal ratings read (docs/bsc-rater-credibility-2026-10-16.md) and is not counted by this step.
    expect(BSC_CHAIN.reputation).toBeUndefined();
    // No window is wider than the ceiling its provider gives the identity pass for a call.
    expect(ETHEREUM_CHAIN.reputation!.window).toBeLessThanOrEqual(50_000);
    // Base's is wider than Alchemy's 10,000-block answer in full: the plan answers any range of 10,000 logs or fewer, and a refusal halves the window.
  });

  it("says nothing it cannot back: no chain entry word claims a check, a safety, a trust or a guarantee", () => {
    for (const chain of later) {
      const words = [chain.label, chain.chainLabel, chain.fetchSentence, chain.sourceKey, chain.feature ?? ""].join(" ");
      expect(words, chain.protocol).not.toMatch(/verified|safe|trusted|guaranteed/i);
    }
  });

  it("uses the registry's one address on each, and distinct cursors, keys and protocols", () => {
    for (const chain of later) expect(chain.identityRegistry, chain.protocol).toBe(REGISTRY);
    expect(new Set(ERC8004_CHAINS.map(chain => chain.cursorPrefix)).size).toBe(ERC8004_CHAINS.length);
    expect(new Set(ERC8004_CHAINS.map(chain => chain.sourceKey)).size).toBe(ERC8004_CHAINS.length);
    expect(new Set(ERC8004_CHAINS.map(chain => chain.protocol)).size).toBe(ERC8004_CHAINS.length);
  });

  it("keeps a source key within the column that holds it", () => {
    for (const chain of ERC8004_CHAINS) expect(chain.sourceKey.length, chain.protocol).toBeLessThanOrEqual(64);
  });
});

describe("a chain's switch", () => {
  it("leaves BNB Chain on whatever the list says, and every other chain off until it is named", () => {
    for (const list of [undefined, "", " , ", "watch,patrols,claims"]) {
      expect(erc8004ChainOn(BSC_CHAIN, list), String(list)).toBe(true);
      for (const chain of [ETHEREUM_CHAIN, BASE_CHAIN, ARC_CHAIN]) expect(erc8004ChainOn(chain, list), `${chain.protocol} with ${String(list)}`).toBe(false);
    }
  });

  it("turns on only the chain the list names, in any case and with spaces, and not part of a name", () => {
    expect(erc8004ChainOn(BASE_CHAIN, "chain_base")).toBe(true);
    expect(erc8004ChainOn(ETHEREUM_CHAIN, "chain_base")).toBe(false);
    expect(erc8004ChainOn(ARC_CHAIN, "watch, Chain_Arc ,claims")).toBe(true);
    expect(erc8004ChainOn(ARC_CHAIN, "chain_arcade")).toBe(false);
    expect(erc8004ChainOn(ETHEREUM_CHAIN, "ethereum")).toBe(false);
  });

  it("reads VITE_FEATURES when no list is given, as the client's build and the server's run both do", () => {
    const before = process.env.VITE_FEATURES;
    try {
      process.env.VITE_FEATURES = "chain_ethereum";
      expect(erc8004ChainOn(ETHEREUM_CHAIN)).toBe(true);
      expect(erc8004ChainOn(BASE_CHAIN)).toBe(false);
      delete process.env.VITE_FEATURES;
      expect(erc8004ChainOn(ETHEREUM_CHAIN)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.VITE_FEATURES;
      else process.env.VITE_FEATURES = before;
    }
  });
});

describe("the list of chains", () => {
  it("is sound", () => {
    expect(validateErc8004Chains(ERC8004_CHAINS)).toEqual([]);
    expect(ERC8004_CHAINS.map(chain => chain.protocol)).toEqual(["erc8004_bsc", "erc8004_eth", "erc8004_base", "erc8004_arc"]);
  });

  it("stays sound with a further chain beside the others, so a chain can be added by an entry alone", () => {
    expect(validateErc8004Chains([...ERC8004_CHAINS, DEMO_CHAIN])).toEqual([]);
  });

  const problemsWith = (patch: Partial<Erc8004Chain>) => validateErc8004Chains([BSC_CHAIN, { ...DEMO_CHAIN, ...patch }]);
  const says = (problems: string[], text: string) => problems.some(problem => problem.includes(text));
  const pinned = (rootUrl: string, allowedHostname: string): Erc8004Chain["provider"] => ({ kind: "pinned", rootUrl, allowedHostname });

  it("finds an entry that repeats another's protocol, chain id, source key, cursor prefix or chain key", () => {
    expect(says(problemsWith({ protocol: "erc8004_bsc" }), "repeats the protocol")).toBe(true);
    expect(says(problemsWith({ chainId: 56, chainIdHex: "0x38" }), "repeats the chain id")).toBe(true);
    expect(says(problemsWith({ sourceKey: BSC_CHAIN.sourceKey }), "repeats the source key")).toBe(true);
    expect(says(problemsWith({ cursorPrefix: "bsc" }), "repeats the cursor prefix")).toBe(true);
    expect(says(problemsWith({ chainKey: "bnb" }), "repeats the chain key")).toBe(true);
  });

  it("finds a chain id whose hex form is not its own", () => {
    expect(says(problemsWith({ chainIdHex: "0x1e62" }), "hex chain id")).toBe(true);
    expect(says(problemsWith({ chainIdHex: "0x01e61" }), "hex chain id")).toBe(true);
    expect(says(problemsWith({ chainIdHex: "0X1e61" }), "hex chain id")).toBe(true);
  });

  it("finds a registry that is not an address, and facts that are not positive whole numbers", () => {
    expect(says(problemsWith({ identityRegistry: "0x1234" }), "not an address")).toBe(true);
    expect(says(problemsWith({ deployBlock: 0 }), "deploy block")).toBe(true);
    expect(says(problemsWith({ handoutBlockWindow: 0 }), "hand-out block window")).toBe(true);
    expect(says(problemsWith({ maxWindowLogs: 1.5 }), "window log bound")).toBe(true);
  });

  it("finds a log range a split result could never walk", () => {
    expect(says(problemsWith({ maxLogRange: 999 }), "at least 1,000 blocks")).toBe(true);
    expect(problemsWith({ maxLogRange: 1_000 })).toEqual([]);
  });

  it("finds a pinned provider whose root URL is not a bare https origin, or whose host is not the allowed host", () => {
    expect(says(problemsWith({ provider: pinned("http://demo-mainnet.example", "demo-mainnet.example") }), "bare https origin")).toBe(true);
    expect(says(problemsWith({ provider: pinned("https://demo-mainnet.example/v1/key", "demo-mainnet.example") }), "bare https origin")).toBe(true);
    expect(says(problemsWith({ provider: pinned("https://user:pass@demo-mainnet.example", "demo-mainnet.example") }), "bare https origin")).toBe(true);
    expect(says(problemsWith({ provider: pinned("https://demo-mainnet.example", "other-host.example") }), "root URL's host")).toBe(true);
    expect(says(problemsWith({ provider: pinned("not a url", "demo-mainnet.example") }), "not a URL")).toBe(true);
    expect(says(problemsWith({ provider: pinned("https://Demo-Mainnet.example", "Demo-Mainnet.example") }), "lowercase host name")).toBe(true);
  });

  it("accepts a derived provider, which names no host, and finds a provider that is neither kind", () => {
    expect(problemsWith({ provider: { kind: "derived" } })).toEqual([]);
    expect(says(problemsWith({ provider: { kind: "somewhere" } as unknown as Erc8004Chain["provider"] }), "pinned or derived")).toBe(true);
  });

  it("finds a run budget that is not positive, or that fetches more windows at once than it plans", () => {
    expect(says(problemsWith({ budget: { ...DEMO_CHAIN.budget, maxEvents: 0 } }), "maxEvents")).toBe(true);
    expect(says(problemsWith({ budget: { ...DEMO_CHAIN.budget, concurrency: 11 } }), "more windows at once")).toBe(true);
  });

  it("finds an RPC policy with a retried status that is not an error, or a negative wait", () => {
    expect(says(problemsWith({ rpc: { ...DEMO_CHAIN.rpc, retryStatuses: [200] } }), "HTTP error status")).toBe(true);
    expect(says(problemsWith({ rpc: { ...DEMO_CHAIN.rpc, backoffMs: [-1] } }), "negative")).toBe(true);
    expect(says(problemsWith({ rpc: { ...DEMO_CHAIN.rpc, timeoutMs: 0 } }), "timeout")).toBe(true);
  });

  it("finds a jitter that is not a fraction, a negative gap, and a gap on a run that fetches several windows at once", () => {
    expect(says(problemsWith({ rpc: { ...DEMO_CHAIN.rpc, jitter: 1.5 } }), "jitter")).toBe(true);
    expect(says(problemsWith({ rpc: { ...DEMO_CHAIN.rpc, jitter: -0.1 } }), "jitter")).toBe(true);
    expect(problemsWith({ rpc: { ...DEMO_CHAIN.rpc, jitter: 0.25 } })).toEqual([]);
    expect(says(problemsWith({ rpc: { ...DEMO_CHAIN.rpc, minGapMs: -5 } }), "gap between calls")).toBe(true);
    expect(says(problemsWith({ rpc: { ...DEMO_CHAIN.rpc, minGapMs: 250 }, budget: { ...DEMO_CHAIN.budget, concurrency: 2 } }), "one window at a time")).toBe(true);
    expect(problemsWith({ rpc: { ...DEMO_CHAIN.rpc, minGapMs: 250 }, budget: { ...DEMO_CHAIN.budget, concurrency: 1 } })).toEqual([]);
  });

  it("finds a reputation registry that is not an address, and a window that is not a positive whole number of blocks", () => {
    const registry = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
    expect(problemsWith({ reputation: { registry, window: 10_000 } })).toEqual([]);
    expect(says(problemsWith({ reputation: { registry: "0x1234", window: 10_000 } }), "reputation registry")).toBe(true);
    expect(says(problemsWith({ reputation: { registry, window: 0 } }), "reputation window")).toBe(true);
    expect(says(problemsWith({ reputation: { registry, window: 1.5 } }), "reputation window")).toBe(true);
    expect(problemsWith({ reputation: undefined })).toEqual([]);
  });

  it("finds a host cap that is not a whole number, or that leaves a host's stored rows too close to the host rule", () => {
    // The default host rule is 50, so the cap must be at least 100: one stored row moving host must not ungroup the rest.
    expect(says(problemsWith({ hostRowCap: 99 }), "host row cap")).toBe(true);
    expect(says(problemsWith({ hostRowCap: 100.5 }), "host row cap")).toBe(true);
    expect(problemsWith({ hostRowCap: 100 })).toEqual([]);
    expect(problemsWith({ hostRowCap: undefined })).toEqual([]);
    expect(says(problemsWith({ hostRowCap: 99, listingRules: { sharedProfileLinkFrom: 2, sharedHostFrom: 40, sharedWalletFrom: 10 } }), "host row cap")).toBe(false);
  });

  it("finds listing rules that would hold nothing out, and names that would break a message or a key", () => {
    expect(says(problemsWith({ listingRules: { sharedProfileLinkFrom: 1, sharedHostFrom: 50, sharedWalletFrom: 10 } }), "listing rule")).toBe(true);
    expect(problemsWith({ listingRules: { sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 } })).toEqual([]);
    expect(says(problemsWith({ errorPrefix: "demo" }), "error prefix")).toBe(true);
    expect(says(problemsWith({ cursorPrefix: "Demo" }), "cursor prefix")).toBe(true);
    expect(says(problemsWith({ sourceKey: "Demo Source" }), "source key")).toBe(true);
    expect(says(problemsWith({ rpcEnvVar: "demo_rpc" }), "endpoint variable")).toBe(true);
    expect(says(problemsWith({ fetchSentence: " " }), "fetch sentence")).toBe(true);
  });
});

describe("looking a chain up", () => {
  it("finds the chain by the protocol of its source, and finds none for a protocol the pass does not read", () => {
    expect(erc8004ChainOfProtocol("erc8004_bsc")).toBe(BSC_CHAIN);
    expect(erc8004ChainOfProtocol("erc8004_eth")).toBe(ETHEREUM_CHAIN);
    expect(erc8004ChainOfProtocol("erc8004_base")).toBe(BASE_CHAIN);
    expect(erc8004ChainOfProtocol("erc8004_arc")).toBe(ARC_CHAIN);
    // Robinhood Chain keeps its own walk, and the others are not chains of this pass.
    for (const protocol of ["erc8004", "erc8004_reputation", "solana_8004", "catalog", "constructor", "__proto__", ""]) {
      expect(erc8004ChainOfProtocol(protocol), protocol).toBeNull();
    }
  });

  it("gives the EVM chain facts the hand-out rule needs, from the list for a chain of the pass and from Robinhood Chain's own constant for it", () => {
    expect(evmIdentityChain("erc8004")).toEqual({ chainId: 4663, label: "Robinhood Chain", handoutBlockWindow: ROBINHOOD_HANDOUT_BLOCK_WINDOW });
    expect(evmIdentityChain("erc8004")!.handoutBlockWindow).toBe(36_000);
    expect(evmIdentityChain("erc8004_bsc")).toEqual({ chainId: 56, label: "BNB Smart Chain", handoutBlockWindow: 8_000 });
    expect(evmIdentityChain("erc8004_eth")).toEqual({ chainId: 1, label: "Ethereum", handoutBlockWindow: 299 });
    expect(evmIdentityChain("erc8004_base")).toEqual({ chainId: 8453, label: "Base", handoutBlockWindow: 1_800 });
    expect(evmIdentityChain("erc8004_arc")).toEqual({ chainId: 5042, label: "Arc", handoutBlockWindow: 7_080 });
    for (const protocol of ["erc8004_reputation", "usdg_settlement", "solana_8004", "constructor", "__proto__", "toString", ""]) {
      expect(evmIdentityChain(protocol), protocol).toBeNull();
    }
  });
});
