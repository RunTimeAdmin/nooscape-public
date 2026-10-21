import { describe, expect, it } from "vitest";
import {
  RobinhoodRegistryValidationError,
  splitBackfillWindow,
} from "./robinhood";
import {
  USDG_AUTHORIZATION_USED_TOPIC,
  USDG_CONTRACT_ADDRESS,
  USDG_MAX_SETTLEMENTS_PER_WINDOW,
  USDG_TRANSFER_TOPIC,
  decodeUsdgSettlement,
  parseUsdgSettlementCursor,
  usdgSettlementCursorAfter,
} from "./usdg";

const BOUNDS = { fromBlock: 83_000_000, toBlock: 83_500_000 };
const PAYER = "0x1111114fb6f85783a2e9d12b4e2b4a1f5a5e6b7c";
const PAYEE = "0x222222a5c4b6ea0e21a0b02ee1b0ef7ff8db56cd";
const RELAYER = "0x333333e1a1ba5ab5ea7ff237b0e19c17f9d9a3c1";

function padAddress(address: string) {
  return `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

function padUint(value: number) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function padUintBig(value: bigint) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function buildAuthLog(input: { block?: number; logIndex?: number; authorizer?: string; hash?: string; address?: string; topics?: string[] } = {}) {
  return {
    address: input.address ?? USDG_CONTRACT_ADDRESS,
    topics: input.topics ?? [
      USDG_AUTHORIZATION_USED_TOPIC,
      padAddress(input.authorizer ?? PAYER),
      padUint(0xdeadbeef),
    ],
    data: "0x",
    blockNumber: `0x${(input.block ?? 83_100_000).toString(16)}`,
    transactionHash: input.hash ?? `0x${"ab".repeat(32)}`,
    logIndex: `0x${(input.logIndex ?? 3).toString(16)}`,
    removed: false,
  };
}

function buildTransferLog(input: { from?: string; to?: string; valueRaw?: string; logIndex?: number; data?: string } = {}) {
  return {
    address: USDG_CONTRACT_ADDRESS,
    topics: [
      USDG_TRANSFER_TOPIC,
      padAddress(input.from ?? PAYER),
      padAddress(input.to ?? PAYEE),
    ],
    data: input.data ?? padUintBig(BigInt(input.valueRaw ?? 1_000)),
    blockNumber: `0x${(83_100_000).toString(16)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: `0x${(input.logIndex ?? 4).toString(16)}`,
    removed: false,
  };
}

function buildReceipt(input: { logs?: unknown[]; from?: string } = {}) {
  return {
    from: input.from ?? RELAYER,
    logs: input.logs ?? [buildAuthLog(), buildTransferLog()],
  };
}

describe("parseUsdgSettlementCursor", () => {
  it("seeds a fresh source", () => {
    expect(parseUsdgSettlementCursor(null)).toEqual({ mode: "seed" });
    expect(parseUsdgSettlementCursor("")).toEqual({ mode: "seed" });
    expect(parseUsdgSettlementCursor("  ")).toEqual({ mode: "seed" });
  });

  it("resumes a walk and terminates at done", () => {
    expect(parseUsdgSettlementCursor("us:83296767")).toEqual({ mode: "walk", toBlock: 83_296_767 });
    expect(parseUsdgSettlementCursor("us:done")).toEqual({ mode: "done" });
  });

  it("fails closed on any other position", () => {
    expect(() => parseUsdgSettlementCursor("ac:100")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseUsdgSettlementCursor("us:0")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseUsdgSettlementCursor("us:-5")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseUsdgSettlementCursor("garbage")).toThrow(RobinhoodRegistryValidationError);
  });

  it("round-trips the walk position", () => {
    expect(usdgSettlementCursorAfter(83_296_768)).toBe("us:83296767");
    expect(usdgSettlementCursorAfter(1)).toBe("us:done");
    expect(parseUsdgSettlementCursor(usdgSettlementCursorAfter(83_296_768))).toEqual({ mode: "walk", toBlock: 83_296_767 });
  });
});

describe("decodeUsdgSettlement", () => {
  it("decodes a settlement from the paired logs and receipt", () => {
    const settlement = decodeUsdgSettlement(buildAuthLog(), buildReceipt(), BOUNDS);
    expect(settlement).toEqual({
      transactionHash: `0x${"ab".repeat(32)}`,
      logIndex: 3,
      blockNumber: 83_100_000,
      payerAddress: PAYER,
      payeeAddress: PAYEE,
      relayerAddress: RELAYER,
      valueRaw: "1000",
    });
  });

  it("pairs through unrelated logs from other contracts", () => {
    const receipt = buildReceipt({
      logs: [
        { address: "0x9999999999999999999999999999999999999999", topics: [USDG_TRANSFER_TOPIC, padAddress(PAYER), padAddress(PAYEE)], data: padUint(999_999), logIndex: 0 },
        buildAuthLog({ logIndex: 3 }),
        buildTransferLog({ logIndex: 4, valueRaw: "2500000" }),
      ],
    });
    const settlement = decodeUsdgSettlement(buildAuthLog(), receipt, BOUNDS);
    expect(settlement?.valueRaw).toBe("2500000");
  });

  it("keeps values exact past float precision", () => {
    const exact = "9007199254740993";
    const settlement = decodeUsdgSettlement(buildAuthLog(), buildReceipt({ logs: [buildAuthLog(), buildTransferLog({ valueRaw: exact })] }), BOUNDS);
    expect(settlement?.valueRaw).toBe(exact);
  });

  it("rejects when no Transfer from the authorizer exists", () => {
    const receipt = buildReceipt({ logs: [buildAuthLog(), buildTransferLog({ from: PAYEE, to: PAYER })] });
    expect(decodeUsdgSettlement(buildAuthLog(), receipt, BOUNDS)).toBeNull();
  });

  it("rejects an ambiguous pairing — multiple Transfers from the authorizer", () => {
    const receipt = buildReceipt({
      logs: [
        buildAuthLog(),
        buildTransferLog({ logIndex: 4, valueRaw: "1000" }),
        buildTransferLog({ logIndex: 5, valueRaw: "2000" }),
      ],
    });
    expect(decodeUsdgSettlement(buildAuthLog(), receipt, BOUNDS)).toBeNull();
  });

  it("rejects a value above the fail-closed bound", () => {
    const overBound = BigInt("1000000000000000000000000") + BigInt(1);
    const receipt = buildReceipt({ logs: [buildAuthLog(), buildTransferLog({ valueRaw: overBound.toString() })] });
    expect(decodeUsdgSettlement(buildAuthLog(), receipt, BOUNDS)).toBeNull();
  });

  it("rejects malformed transfer data instead of guessing", () => {
    const receipt = buildReceipt({ logs: [buildAuthLog(), buildTransferLog({ data: "0xdead" })] });
    expect(decodeUsdgSettlement(buildAuthLog(), receipt, BOUNDS)).toBeNull();
  });

  it("rejects an auth log from any address but the canonical contract", () => {
    expect(decodeUsdgSettlement(buildAuthLog({ address: "0x5fc5360d0400a0fd4f2af552add042d716f1d169" }), buildReceipt(), BOUNDS)).toBeNull();
  });

  it("rejects out-of-bounds blocks, removed logs, and malformed topics", () => {
    expect(decodeUsdgSettlement(buildAuthLog({ block: 84_000_000 }), buildReceipt(), BOUNDS)).toBeNull();
    expect(decodeUsdgSettlement({ ...buildAuthLog(), removed: true }, buildReceipt(), BOUNDS)).toBeNull();
    expect(decodeUsdgSettlement(buildAuthLog({ topics: [USDG_TRANSFER_TOPIC, padAddress(PAYER)] }), buildReceipt(), BOUNDS)).toBeNull();
  });

  it("rejects a receipt without a valid sender", () => {
    expect(decodeUsdgSettlement(buildAuthLog(), buildReceipt({ from: "not-an-address" }), BOUNDS)).toBeNull();
    expect(decodeUsdgSettlement(buildAuthLog(), { logs: [] }, BOUNDS)).toBeNull();
  });
});

describe("settlement window bounds", () => {
  it("keeps the receipt budget per run small and the window split shared", () => {
    expect(USDG_MAX_SETTLEMENTS_PER_WINDOW).toBe(200);
    // The narrowing reuses the ERC-8004 newest-half rule: same tiling,
    // same no-skip guarantee.
    expect(splitBackfillWindow(1_000, 2_001)).toEqual({ fromBlock: 1_501, toBlock: 2_001 });
    expect(() => splitBackfillWindow(5, 5)).toThrow(RobinhoodRegistryValidationError);
  });
});
