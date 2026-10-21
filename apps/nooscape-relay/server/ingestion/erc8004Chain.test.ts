import { describe, expect, it } from "vitest";
import { BSC_FIXTURE_MINTS, BSC_FIXTURE_REGISTERED, BSC_FIXTURE_URI_UPDATES } from "./bscFixtures";
import {
  Erc8004ValidationError,
  cursorFor,
  decodeRegisteredLog,
  decodeUriUpdatedLog,
  directoryDraft,
  externalKey,
  parseCursor,
  parseWindowLogs,
  planWindows,
  registryChainOf,
} from "./erc8004Chain";
import { BSC_CHAIN } from "./erc8004Chains";
import { DEMO_CHAIN, atRegistry, mintAt, registrationAt, uriUpdateAt } from "./erc8004TestChain";

/**
 * The pure core of the identity pass, run on a chain that is not BNB Chain. The BNB tests (bscChain.test.ts) hold BNB Chain's
 * behaviour exactly; these show that nothing in the core is BNB Chain's: the same functions, given another entry, read another
 * registry, start at another block, tile at another range, write another cursor and say another chain's name.
 */
const WIDE = { fromBlock: 0, toBlock: Number.MAX_SAFE_INTEGER };

describe("the cursor", () => {
  it("starts a fresh source at the chain's own deploy block", () => {
    expect(parseCursor(DEMO_CHAIN, null)).toEqual({ nextBlock: 1_000 });
    expect(parseCursor(BSC_CHAIN, " ")).toEqual({ nextBlock: 79_027_268 });
  });

  it("is written and read with the chain's own prefix", () => {
    expect(cursorFor(DEMO_CHAIN, 123_456)).toBe("demo:123456");
    expect(cursorFor(BSC_CHAIN, 123_456)).toBe("bsc:123456");
    expect(parseCursor(DEMO_CHAIN, " demo:123456 ")).toEqual({ nextBlock: 123_456 });
  });

  it("fails closed on another chain's cursor, below the deploy block, and on anything that is not a position", () => {
    for (const cursor of ["bsc:123456", "demo:999", "demo:", "demo:-5", "demo:abc", "demo:99999999999999999999", "rb:5000", "garbage"]) {
      expect(() => parseCursor(DEMO_CHAIN, cursor), cursor).toThrow(Erc8004ValidationError);
    }
    // The other way round: BNB Chain refuses a demo cursor.
    expect(() => parseCursor(BSC_CHAIN, "demo:123456")).toThrow(Erc8004ValidationError);
  });

  it("names the chain in its refusal, and names the error for the chain", () => {
    const error = (() => {
      try {
        parseCursor(DEMO_CHAIN, "bsc:5");
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected a refusal");
    })();
    expect(error.message).toBe("Stored Demo Chain cursor is not an approved walk position.");
    expect(error.name).toBe("DemoRegistryValidationError");
    const outOfBounds = (() => {
      try {
        parseCursor(DEMO_CHAIN, "demo:999");
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected a refusal");
    })();
    expect(outOfBounds.message).toBe("Stored Demo Chain walk position is out of bounds.");
    expect(outOfBounds.name).toBe("DemoRegistryValidationError");
  });
});

describe("window planning", () => {
  it("tiles at the chain's own range, with no gap and no overlap", () => {
    const windows = planWindows(DEMO_CHAIN, 1_000, 25_999, 100);
    expect(windows).toEqual([
      { from: 1_000, to: 10_999 },
      { from: 11_000, to: 20_999 },
      { from: 21_000, to: 25_999 },
    ]);
    // The same span on BNB Chain's range is one window.
    expect(planWindows(BSC_CHAIN, 79_027_268, 79_027_268 + 25_999, 100)).toHaveLength(1);
  });

  it("stops at the window budget, resumes exactly where it stopped, and is empty when caught up", () => {
    const first = planWindows(DEMO_CHAIN, 1_000, 1_000_000, 3);
    expect(first).toHaveLength(3);
    expect(planWindows(DEMO_CHAIN, first.at(-1)!.to + 1, 1_000_000, 3)[0]!.from).toBe(31_000);
    expect(planWindows(DEMO_CHAIN, 50_001, 50_000, 10)).toEqual([]);
    expect(planWindows(DEMO_CHAIN, 50_000, 50_000, 10)).toEqual([{ from: 50_000, to: 50_000 }]);
  });
});

describe("the key an identity is stored under", () => {
  it("names the chain and the registry, so the same agent id on two chains is two entries", () => {
    expect(externalKey(DEMO_CHAIN, "7")).toBe("eip155:7777:0x1234567890AbcdEF1234567890aBcdef12345678:7");
    expect(externalKey(BSC_CHAIN, "7")).toBe("eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:7");
    expect(externalKey(DEMO_CHAIN, "7")).not.toBe(externalKey(BSC_CHAIN, "7"));
    // The id is the third separator on, as agentIdOfKey reads it.
    expect(externalKey(DEMO_CHAIN, "0").split(":")[3]).toBe("0");
  });

  it("asks the shared decoders about the chain's own id and registry", () => {
    expect(registryChainOf(DEMO_CHAIN)).toEqual({ chainId: 7777, registry: "0x1234567890AbcdEF1234567890aBcdef12345678" });
  });
});

describe("a registration on the chain", () => {
  const log = registrationAt(DEMO_CHAIN, 12, 5_000);

  it("is read from the chain's own registry and no other", () => {
    expect(decodeRegisteredLog(DEMO_CHAIN, log, WIDE)).toMatchObject({ agentId: "12", blockNumber: 5_000 });
    // The same log at BNB Chain's registry is not this chain's, and the demo log is not BNB Chain's.
    expect(decodeRegisteredLog(BSC_CHAIN, log, WIDE)).toBeNull();
    expect(decodeRegisteredLog(DEMO_CHAIN, atRegistry(log, BSC_CHAIN.identityRegistry), WIDE)).toBeNull();
    expect(decodeRegisteredLog(BSC_CHAIN, atRegistry(log, BSC_CHAIN.identityRegistry), WIDE)).not.toBeNull();
  });

  it("matches the registry address whatever its case", () => {
    expect(decodeRegisteredLog(DEMO_CHAIN, atRegistry(log, DEMO_CHAIN.identityRegistry.toLowerCase()), WIDE)).not.toBeNull();
    expect(decodeRegisteredLog(DEMO_CHAIN, atRegistry(log, DEMO_CHAIN.identityRegistry.toUpperCase().replace("0X", "0x")), WIDE)).not.toBeNull();
  });

  it("is held to its window", () => {
    expect(decodeRegisteredLog(DEMO_CHAIN, log, { fromBlock: 5_001, toBlock: 6_000 })).toBeNull();
    expect(decodeRegisteredLog(DEMO_CHAIN, log, { fromBlock: 5_000, toBlock: 5_000 })).not.toBeNull();
  });

  it("becomes a row keyed by the chain, with a note that names the chain and says what the pass did with the link", () => {
    const draft = directoryDraft(DEMO_CHAIN, decodeRegisteredLog(DEMO_CHAIN, log, WIDE)!);
    expect(draft.externalKey).toBe("eip155:7777:0x1234567890AbcdEF1234567890aBcdef12345678:12");
    expect(draft.sourceSignalNote).toContain("Demo Chain Mainnet ERC-8004 registration.");
    expect(draft.sourceSignalNote).toContain("No URI was set at registration.");
    expect(draft.sourceSignalNote).toContain("current ownership is not verified");
    // A registration with a link carries the chain's own fetch sentence.
    const withLink = decodeRegisteredLog(DEMO_CHAIN, atRegistry(BSC_FIXTURE_REGISTERED.evoevo_https!.log, DEMO_CHAIN.identityRegistry), WIDE)!;
    expect(directoryDraft(DEMO_CHAIN, withLink).sourceSignalNote).toContain("a web link. Nooscape has not read it.");
    expect(directoryDraft(BSC_CHAIN, { ...withLink }).sourceSignalNote).toContain("BNB Smart Chain ERC-8004 registration.");
    expect(directoryDraft(BSC_CHAIN, { ...withLink }).sourceSignalNote).not.toContain("Nooscape has not read it.");
  });
});

describe("a window of logs on the chain", () => {
  it("decodes a registration, a mint and a URI update at the chain's registry and keys each to the chain", () => {
    const parsed = parseWindowLogs(DEMO_CHAIN, [uriUpdateAt(DEMO_CHAIN, 12, 5_002), mintAt(DEMO_CHAIN, 12, 5_000), registrationAt(DEMO_CHAIN, 12, 5_000)], WIDE);
    expect(parsed.registrations.map(registration => registration.agentId)).toEqual(["12"]);
    expect(parsed.activity.map(event => [event.kind, event.externalKey])).toEqual([
      ["mint", "eip155:7777:0x1234567890AbcdEF1234567890aBcdef12345678:12"],
      ["uri_update", "eip155:7777:0x1234567890AbcdEF1234567890aBcdef12345678:12"],
    ]);
    expect(parsed.uriUpdates).toHaveLength(1);
    expect(decodeUriUpdatedLog(DEMO_CHAIN, uriUpdateAt(DEMO_CHAIN, 12, 5_002), WIDE)).toMatchObject({ blockNumber: 5_002 });
  });

  it("counts what is another registry's as rejected and never stores it", () => {
    const foreign = [BSC_FIXTURE_MINTS["6"]!, registrationAt(BSC_CHAIN, 3, 5_000), BSC_FIXTURE_URI_UPDATES[0]!.log];
    const parsed = parseWindowLogs(DEMO_CHAIN, [registrationAt(DEMO_CHAIN, 1, 5_000), ...foreign], WIDE);
    expect(parsed).toMatchObject({ discoveredCount: 4, rejectedCount: 3 });
    expect(parsed.registrations).toHaveLength(1);
    expect(parsed.activity).toHaveLength(0);
  });

  it("refuses a response that is not an array or is over the chain's own bound, in the chain's words", () => {
    expect(() => parseWindowLogs(DEMO_CHAIN, { result: [] }, WIDE)).toThrow("Demo Chain identity log response must be an array.");
    expect(() => parseWindowLogs(DEMO_CHAIN, new Array(501).fill(null), WIDE)).toThrow("Demo Chain identity log response exceeds the approved bound of 500 events.");
    // 501 logs is fine for BNB Chain, whose bound is 30,000.
    expect(parseWindowLogs(BSC_CHAIN, new Array(501).fill(null), WIDE)).toMatchObject({ discoveredCount: 501 });
  });
});
