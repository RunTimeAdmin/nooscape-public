import { EXTRA_CHAIN_SPECS, type ExtraChainSpec } from "@shared/chains";
import { featureOn } from "@shared/features";

/** What the operator's console calls a source protocol. */
export function protocolLabel(protocol: string): string {
  if (protocol === "catalog") return "Catalog";
  if (protocol === "census") return "Census";
  if (protocol === "solana_registry") return "Solana registry";
  if (protocol === "solana_8004") return "8004 Solana registry";
  if (protocol === "solana_said") return "SAID Solana registry";
  if (protocol === "solana_agenc") return "AgenC Solana registry";
  if (protocol === "erc8004") return "ERC-8004 registry";
  if (protocol === "erc8004_bsc") return "BNB Chain ERC-8004 registry";
  const extra = EXTRA_CHAIN_SPECS.find(spec => spec.protocol === protocol);
  if (extra) return `${extra.label} ERC-8004 registry`;
  if (protocol === "erc8004_reputation") return "ERC-8004 reputation";
  if (protocol === "usdg_settlement") return "USDG settlements";
  return protocol.toUpperCase();
}

/** The extra chains whose source the console offers to stage: the ones switched on in this build, in the order the tabs list them. */
export function extraChainsToStage(features: string | undefined): ExtraChainSpec[] {
  return EXTRA_CHAIN_SPECS.filter(spec => featureOn(spec.feature, features));
}
