import { describe, expect, it } from "vitest";
import { MetaplexRegistryValidationError, parseMetaplexListPayload } from "./metaplex";

const validAgent = {
  mintAddress: "So11111111111111111111111111111111111111112",
  name: "Solana Registry Test Agent",
  description: "Public metadata for a bounded ingestion test.",
  network: "solana-mainnet",
  isActive: true,
  authority: "Vote111111111111111111111111111111111111111",
  walletAddress: "SysvarC1ock11111111111111111111111111111111",
  agentMetadataUri: "https://api.metaplex.com/v1/agents/So11111111111111111111111111111111111111112",
  metadata: {
    type: "erc8004-agent",
    services: [{ name: "A2A", endpoint: "https://api.metaplex.com/v1/agents/So11111111111111111111111111111111111111112/a2a" }],
  },
};

describe("Metaplex Solana registry adapter", () => {
  it("normalizes only active Solana-mainnet registry metadata", () => {
    const result = parseMetaplexListPayload({ success: true, data: { agents: [validAgent] } });
    expect(result).toMatchObject({ discoveredCount: 1, rejectedCount: 0 });
    expect(result.candidates[0]).toMatchObject({
      displayName: "Solana Registry Test Agent",
      mintAddress: validAgent.mintAddress,
      network: "solana-mainnet",
      agentCardUrl: validAgent.metadata.services[0].endpoint,
    });
    expect(result.candidates[0]?.sourceSignals.join(" ")).toContain("Nooscape did not invoke it");
  });

  it("does not retain declared agent service URLs outside the fixed registry origin", () => {
    const result = parseMetaplexListPayload({
      success: true,
      data: { agents: [{ ...validAgent, metadata: { services: [{ name: "A2A", endpoint: "https://untrusted.example/agent-card.json" }] } }] },
    });
    expect(result.candidates[0]?.agentCardUrl).toBeNull();
  });

  it("rejects pages larger than the approved 24-record boundary", () => {
    expect(() => parseMetaplexListPayload({ success: true, data: { agents: Array.from({ length: 25 }, () => validAgent) } }))
      .toThrow(MetaplexRegistryValidationError);
  });
});
