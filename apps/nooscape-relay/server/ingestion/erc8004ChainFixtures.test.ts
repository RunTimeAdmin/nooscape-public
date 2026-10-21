import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeRegisteredLog, decodeUriUpdatedLog, directoryDraft, externalKey, hasProfileLink, parseWindowLogs, uriFacts } from "./erc8004Chain";
import { ARC_CHAIN, BASE_CHAIN, BSC_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./erc8004Chains";
import { ARC_FIXTURES, BASE_FIXTURES, ETHEREUM_FIXTURES, type ChainFixtureLog, type ChainFixtures } from "./erc8004ChainFixtures";
import { Erc8004RpcHttpError, Erc8004RpcRangeError, callRpc } from "./erc8004Rpc";

/**
 * Real registry logs from Ethereum, Base and Arc (erc8004ChainFixtures.ts), decoded under each chain's own entry and held to
 * facts an independent Python decode produced. What is shown here: each chain reads its own recording, a registration becomes a
 * registry row keyed to that chain and worded as that chain's, the same agent id on two chains is two different entries, a log
 * that is malformed, from another address or outside the window is refused without stopping the rest, and each provider's real
 * refusal of a window that was too wide is named as one by the real client. Nothing here calls a node.
 */
const CASES: Array<[string, Erc8004Chain, ChainFixtures]> = [
  ["Ethereum", ETHEREUM_CHAIN, ETHEREUM_FIXTURES],
  ["Base", BASE_CHAIN, BASE_FIXTURES],
  ["Arc", ARC_CHAIN, ARC_FIXTURES],
];
const EVERYTHING = { fromBlock: 0, toBlock: Number.MAX_SAFE_INTEGER };
const blockOf = (log: ChainFixtureLog) => Number.parseInt(log.blockNumber as string, 16);
const logIndexOf = (log: ChainFixtureLog) => Number.parseInt(log.logIndex as string, 16);
const allLogs = (fixtures: ChainFixtures): ChainFixtureLog[] => [
  ...Object.values(fixtures.registered).map(entry => entry.log),
  ...Object.values(fixtures.mints),
  fixtures.secondary.log,
  ...fixtures.uriUpdates.map(update => update.log),
];
/** The URI a Registered or URIUpdated log carries, read here as the ABI says: offset, length, bytes. */
function uriOfLog(log: ChainFixtureLog): string {
  const raw = Buffer.from((log.data as string).slice(2), "hex");
  const offset = Number(raw.readBigUInt64BE(24));
  const length = Number(raw.readBigUInt64BE(offset + 24));
  return raw.subarray(offset + 32, offset + 32 + length).toString("utf8");
}

describe.each(CASES)("the %s recording", (_name, chain, fixtures) => {
  it("is of this chain: its protocol, its chain id answer, its registry, and blocks from its own history", () => {
    expect(fixtures.protocol).toBe(chain.protocol);
    expect(fixtures.chainId).toBe(chain.chainIdHex);
    const finalized = Number.parseInt(fixtures.finalized.number, 16);
    for (const log of allLogs(fixtures)) {
      expect((log.address as string).toLowerCase()).toBe(chain.identityRegistry.toLowerCase());
      expect(blockOf(log)).toBeGreaterThanOrEqual(chain.deployBlock);
      expect(blockOf(log)).toBeLessThanOrEqual(finalized);
      expect(log.removed).toBe(false);
    }
  });

  it("holds a registration of every kind this chain's recording has, with a mint for each", () => {
    expect(Object.keys(fixtures.registered).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(fixtures.mints).sort()).toEqual(Object.values(fixtures.registered).map(entry => entry.expected.agentId).sort());
    const kinds = new Set(Object.values(fixtures.registered).map(entry => entry.expected.uriKind));
    expect(kinds.has("web") || kinds.has("ipfs")).toBe(true);
    expect(kinds.has("inline-json") || kinds.has("empty")).toBe(true);
  });

  it("decodes each registration to the facts the independent decode found", () => {
    for (const [label, { log, expected }] of Object.entries(fixtures.registered)) {
      const registration = decodeRegisteredLog(chain, log, EVERYTHING);
      expect(registration, label).not.toBeNull();
      expect([registration!.agentId, registration!.owner, registration!.blockNumber, registration!.logIndex], label).toEqual([expected.agentId, expected.owner, expected.blockNumber, expected.logIndex]);
      const facts = uriFacts(registration!.uri);
      expect(
        { uriKind: facts.uriKind, uriLength: registration!.uri.length, profileUriHash: facts.profileUriHash, locatorHost: facts.locatorHost, inlineName: facts.inlineName, truncated: facts.truncated },
        label
      ).toEqual({ uriKind: expected.uriKind, uriLength: expected.uriLength, profileUriHash: expected.profileUriHash, locatorHost: expected.locatorHost, inlineName: expected.inlineName, truncated: expected.truncated });
    }
  });

  it("builds each registry row keyed to this chain and worded as this chain's, from chain facts alone", () => {
    for (const [label, { log, expected }] of Object.entries(fixtures.registered)) {
      const draft = directoryDraft(chain, decodeRegisteredLog(chain, log, EVERYTHING)!);
      expect(draft.externalKey, label).toBe(`eip155:${chain.chainId}:${chain.identityRegistry}:${expected.agentId}`);
      expect(draft.displayName, label).toBe(expected.inlineName ?? `Agent #${expected.agentId}`);
      expect(draft.registrant, label).toBe(expected.owner);
      expect(draft.locatorHost, label).toBe(expected.locatorHost);
      expect(draft.profileUriHash, label).toBe(expected.profileUriHash);
      // A link of a usable kind is born pending; an empty URI, an unrecognized scheme or inline JSON that did not parse is born held out.
      const usable = expected.uriKind === "web" || expected.uriKind === "ipfs" || (expected.uriKind === "inline-json" && expected.inlineName !== null);
      expect(draft.listing, label).toBe(usable ? 3 : 0);
      expect(draft.sourceSignalNote, label).toMatch(new RegExp(`^${chain.label} ERC-8004 registration\\. `));
      expect(draft.sourceSignalNote, label).toMatch(/ The event records owner 0x[0-9a-f]{40}; current ownership is not verified\.$/);
      if (expected.uriKind === "empty") expect(draft.sourceSignalNote).toContain("No URI was set at registration.");
      if (expected.uriKind === "web" || expected.uriKind === "ipfs" || expected.uriKind === "other") {
        expect(draft.sourceSignalNote, label).toContain(chain.fetchSentence);
        expect(draft.sourceSignalNote, label).not.toContain("directory pass reads");
      }
      expect(hasProfileLink(uriFacts(uriOfLog(log))), label).toBe(expected.uriKind !== "empty" && expected.uriKind !== "other" && (expected.uriKind !== "inline-json" || expected.inlineName !== null));
    }
  });

  it("gives the same agent id on another chain a different entry", () => {
    for (const other of [BSC_CHAIN, ETHEREUM_CHAIN, BASE_CHAIN, ARC_CHAIN].filter(candidate => candidate !== chain)) {
      for (const { expected } of Object.values(fixtures.registered)) {
        expect(externalKey(other, expected.agentId)).not.toBe(externalKey(chain, expected.agentId));
      }
    }
  });

  it("refuses a registration from another address, outside the window, or marked removed", () => {
    const [{ log }] = Object.values(fixtures.registered);
    expect(decodeRegisteredLog(chain, { ...log, address: "0x1234567890abcdef1234567890abcdef12345678" }, EVERYTHING)).toBeNull();
    expect(decodeRegisteredLog(chain, log, { fromBlock: blockOf(log) + 1, toBlock: blockOf(log) + 10 })).toBeNull();
    expect(decodeRegisteredLog(chain, log, { fromBlock: 0, toBlock: blockOf(log) - 1 })).toBeNull();
    expect(decodeRegisteredLog(chain, { ...log, removed: true }, EVERYTHING)).toBeNull();
    expect(decodeRegisteredLog(chain, log, { fromBlock: blockOf(log), toBlock: blockOf(log) })).not.toBeNull();
  });

  it("reads a whole recorded window in chain order: every registration, mint, change of hands and URI update, and nothing rejected", () => {
    const shuffled = [...allLogs(fixtures)].reverse();
    const parsed = parseWindowLogs(chain, shuffled, EVERYTHING);
    const registrations = Object.keys(fixtures.registered).length;
    expect(parsed.registrations).toHaveLength(registrations);
    expect(parsed.uriUpdates).toHaveLength(fixtures.uriUpdates.length);
    expect(parsed.activity).toHaveLength(registrations + 1 + fixtures.uriUpdates.length);
    expect(parsed.rejectedCount).toBe(0);
    expect(parsed.discoveredCount).toBe(shuffled.length);
    const inOrder = (rows: Array<{ blockNumber: number; logIndex: number }>) => rows.every((row, index) => index === 0 || row.blockNumber > rows[index - 1]!.blockNumber || (row.blockNumber === rows[index - 1]!.blockNumber && row.logIndex > rows[index - 1]!.logIndex));
    expect(inOrder(parsed.registrations)).toBe(true);
    expect(inOrder(parsed.activity)).toBe(true);
    expect(parsed.activity.filter(event => event.kind === "mint")).toHaveLength(registrations);
    const secondary = parsed.activity.filter(event => event.kind === "secondary");
    expect(secondary).toHaveLength(1);
    expect([secondary[0]!.externalKey, secondary[0]!.fromAddress, secondary[0]!.toAddress, secondary[0]!.blockNumber]).toEqual([
      `eip155:${chain.chainId}:${chain.identityRegistry}:${fixtures.secondary.agentId}`,
      fixtures.secondary.from,
      fixtures.secondary.to,
      fixtures.secondary.blockNumber,
    ]);
    for (const event of parsed.activity) expect(event.externalKey.startsWith(`eip155:${chain.chainId}:${chain.identityRegistry}:`)).toBe(true);
  });

  it("decodes each URI update to its agent and to the facts of its new URI", () => {
    for (const update of fixtures.uriUpdates) {
      const decoded = decodeUriUpdatedLog(chain, update.log, EVERYTHING);
      expect(decoded, update.label).not.toBeNull();
      expect([decoded!.externalKey, decoded!.blockNumber, decoded!.logIndex], update.label).toEqual([`eip155:${chain.chainId}:${chain.identityRegistry}:${update.agentId}`, update.blockNumber, update.logIndex]);
      const facts = uriFacts(decoded!.uri!);
      expect([facts.uriKind, decoded!.uri!.length, facts.profileUriHash, facts.locatorHost, facts.inlineName], update.label).toEqual([update.newKind, update.uriLength, update.profileUriHash, update.locatorHost, update.inlineName]);
    }
  });

  it("refuses the malformed versions of a real log and still reads the good ones beside them", () => {
    const [{ log }] = Object.values(fixtures.registered);
    const topics = log.topics as string[];
    const malformed: unknown[] = [
      { ...log, topics: topics.slice(0, 2) },
      { ...log, topics: [topics[0], topics[1], "0xnot-a-word"] },
      { ...log, topics: ["0x" + "ab".repeat(32), topics[1], topics[2]] },
      { ...log, data: "0x1234" },
      { ...log, data: `0x${"00".repeat(31)}ff${"00".repeat(32)}` },
      { ...log, transactionHash: "0xshort" },
      { ...log, blockNumber: "not a block" },
      "not a log",
      null,
    ];
    const parsed = parseWindowLogs(chain, [log, ...malformed], EVERYTHING);
    expect(parsed.registrations).toHaveLength(1);
    expect(parsed.rejectedCount).toBe(malformed.length);
    expect(parsed.discoveredCount).toBe(malformed.length + 1);
  });
});

describe("what each provider said to a window that was too wide", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const answer = (refusal: { status: number; body: unknown }) => new Response(JSON.stringify(refusal.body), { status: refusal.status });
  const outcome = async (chain: Erc8004Chain) => {
    try {
      await callRpc(chain, "eth_getLogs", [], { url: `https://${chain.provider.kind === "pinned" ? chain.provider.allowedHostname : "node.example"}/v1/KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEY`, sleep: async () => {} });
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected a refusal");
  };

  it("names NodeReal's two refusals on Ethereum: a window past its ceiling is a block-range fault, too many logs is a result-size one", async () => {
    const [tooWide, tooMany] = ETHEREUM_FIXTURES.refusals;
    expect(tooWide!.status).toBe(200);
    fetchMock.mockResolvedValueOnce(answer(tooWide!));
    const range = await outcome(ETHEREUM_CHAIN);
    expect(range).toBeInstanceOf(Erc8004RpcRangeError);
    expect((range as Erc8004RpcRangeError).reason).toBe("block_range");
    fetchMock.mockResolvedValueOnce(answer(tooMany!));
    const size = await outcome(ETHEREUM_CHAIN);
    expect((size as Erc8004RpcRangeError).reason).toBe("result_size");
    expect(size.message).toBe("Ethereum eth_getLogs was rejected as returning too many results.");
  });

  it("names Alchemy's refusal on Base, sent as an HTTP 400, a result-size fault, and sees only the status where the chain does not read bodies", async () => {
    const [refusal] = BASE_FIXTURES.refusals;
    expect(refusal!.status).toBe(400);
    fetchMock.mockResolvedValueOnce(answer(refusal!));
    const base = await outcome(BASE_CHAIN);
    expect(base).toBeInstanceOf(Erc8004RpcRangeError);
    expect((base as Erc8004RpcRangeError).reason).toBe("result_size");
    expect(base.message).toBe("Base eth_getLogs was rejected as returning too many results.");
    // The same answer to a chain that does not read the body is only a status, as it always was.
    fetchMock.mockResolvedValueOnce(answer(refusal!));
    const other = await outcome(ETHEREUM_CHAIN);
    expect(other).toBeInstanceOf(Erc8004RpcHttpError);
    expect(other.message).toBe("Ethereum eth_getLogs returned HTTP 400.");
  });

  it("has nothing recorded for Arc, whose node never refused a window", () => {
    expect(ARC_FIXTURES.refusals).toEqual([]);
  });

  it("retries a bare 429 on each chain's own ladder and then stops with the status", async () => {
    for (const [chain, ladder] of [
      [ETHEREUM_CHAIN, [1_000, 3_000]],
      [BASE_CHAIN, [1_000, 3_000]],
      [ARC_CHAIN, [1_000, 2_000, 4_000]],
    ] as const) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => new Response("", { status: 429 }));
      const sleeps: number[] = [];
      let error: Error | null = null;
      try {
        await callRpc(chain, "eth_getLogs", [], { url: "https://node.example/v1/x", random: () => 0, sleep: async ms => void sleeps.push(ms) });
      } catch (caught) {
        error = caught as Error;
      }
      expect(error, chain.protocol).toBeInstanceOf(Erc8004RpcHttpError);
      expect((error as Erc8004RpcHttpError).status).toBe(429);
      expect(sleeps, chain.protocol).toEqual(ladder);
      expect(fetchMock, chain.protocol).toHaveBeenCalledTimes(ladder.length + 1);
    }
  });
});

describe("the recordings hold nothing they should not", () => {
  it("carries no provider address, key or token: only chain data", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const text = readFileSync(path.resolve(process.cwd(), "server", "ingestion", "erc8004ChainFixtures.ts"), "utf8");
    expect(text).not.toMatch(/alchemy[.]com|nodereal[.]io|quiknode|infura|ankr|X402_RPC|\/v[12]\/[A-Za-z0-9_-]{16,}/i);
    expect(text).not.toMatch(/\b(?:\d{1,3}[.]){3}\d{1,3}\b/);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+[.][\w.-]+/);
  });
});
