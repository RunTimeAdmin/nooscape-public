import { describe, expect, it } from "vitest";
import { EXTRA_CHAIN_SPECS } from "@shared/chains";
import { extraChainsToStage, protocolLabel } from "./sourceOperationsModel";

describe("the operator console's source words", () => {
  it("names each extra chain's registry by the chain's name", () => {
    expect(EXTRA_CHAIN_SPECS.map(spec => protocolLabel(spec.protocol))).toEqual([
      "Ethereum ERC-8004 registry",
      "Base ERC-8004 registry",
      "Arc ERC-8004 registry",
      "Monad ERC-8004 registry",
      "Gnosis ERC-8004 registry",
      "Celo ERC-8004 registry",
    ]);
    expect(protocolLabel("erc8004_bsc")).toBe("BNB Chain ERC-8004 registry");
    expect(protocolLabel("erc8004")).toBe("ERC-8004 registry");
    expect(protocolLabel("a2a")).toBe("A2A");
  });

  it("offers to stage only the extra chains switched on in the build, in tab order", () => {
    expect(extraChainsToStage(undefined)).toEqual([]);
    expect(extraChainsToStage("chain_celo,chain_arc,claims_base").map(spec => spec.key)).toEqual(["arc", "celo"]);
    expect(extraChainsToStage(EXTRA_CHAIN_SPECS.map(spec => spec.feature).join(",")).map(spec => spec.key)).toEqual(["ethereum", "base", "arc", "monad", "gnosis", "celo"]);
  });
});
