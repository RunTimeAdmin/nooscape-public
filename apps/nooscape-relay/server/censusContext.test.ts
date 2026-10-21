import { describe, expect, it } from "vitest";
import { extractEcosystemContext } from "./censusContext";

describe("extractEcosystemContext", () => {
  it("returns only bounded aggregate metrics and top chain rows", () => {
    const context = extractEcosystemContext(
      {
        updatedAt: "2026-10-08T00:00:00.000Z",
        x402: {
          totalTxs: 1_200_000,
          facilitatorsTracked: 7,
          chains: [
            { name: "Base", txs: 900_000 },
            { name: "Solana", txs: 300_000 },
          ],
        },
        erc8004Registry: { totalAgents: 44_000 },
        baseAgentic: { totalTxs: 8_000 },
        sources: [{ name: "must not be returned" }],
      },
      { label: "Approved census", locator: "https://example.com/data.json", contentHash: "a".repeat(64) },
      new Date("2026-10-07T00:00:00.000Z"),
    );

    expect(context).toMatchObject({
      observedAt: "2026-10-08T00:00:00.000Z",
      source: { label: "Approved census", contentHash: "a".repeat(64) },
      metrics: expect.arrayContaining([
        expect.objectContaining({ label: "x402 transactions", value: 1_200_000 }),
        expect.objectContaining({ label: "ERC-8004 identities", value: 44_000 }),
      ]),
      chains: [{ name: "Base", transactions: 900_000 }, { name: "Solana", transactions: 300_000 }],
    });
    expect(JSON.stringify(context)).not.toContain("must not be returned");
  });

  it("fails closed when there are no usable aggregate metrics", () => {
    expect(extractEcosystemContext({ updatedAt: "not a metric" }, { label: "x", locator: "https://x.test", contentHash: "x" }, new Date())).toBeNull();
  });
});
