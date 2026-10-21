import { Erc8004ChainOffError } from "./erc8004Chain";
import { erc8004ChainOn, type Erc8004Chain } from "./erc8004Chains";
import { providerPolicy } from "./erc8004Rpc";
import { INGESTION_PROTOCOLS, type IngestionProtocol } from "./types";

/**
 * The source an operator stages for a chain of the ERC-8004 identity pass that has a switch (docs/multichain-erc8004-2026-10-20.md).
 * It is made from the chain's entry in the chain list, not from a constant in the router: the list knows each chain's source key,
 * protocol and host, and for a chain whose provider is the operator's own (Arc) the host is read from the endpoint variable at the
 * moment of staging and recorded in the row. Staging is refused while the chain's switch is off, so a chain that is off leaves no
 * source behind. Like BNB Chain's, the staged source is manual_only: nothing runs until an operator approves it and runs it, and the
 * scheduled flip is a later, reviewed migration.
 *
 * Throws `Erc8004ChainOffError` while the switch is off, and `Erc8004RpcNotConfiguredError` when the chain's provider is the
 * operator's and its endpoint variable is unset or unusable. Neither message holds a value of the environment.
 */
function ingestionProtocolOf(chain: Erc8004Chain): IngestionProtocol {
  const protocol = INGESTION_PROTOCOLS.find(known => known === chain.protocol);
  if (!protocol) throw new Error(`${chain.protocol} is not an ingestion protocol.`);
  return protocol;
}

export function chainSourcePreset(chain: Erc8004Chain, features: string | undefined = process.env.VITE_FEATURES) {
  if (!erc8004ChainOn(chain, features)) {
    throw new Erc8004ChainOffError(`The ${chain.chainLabel} identity pass is switched off (${chain.feature}), so its source cannot be staged.`);
  }
  const policy = providerPolicy(chain);
  return {
    sourceKey: chain.sourceKey,
    label: `${chain.label} ERC-8004 identity registry`,
    protocol: ingestionProtocolOf(chain),
    rootUrl: policy.rootUrl,
    allowedHostname: policy.allowedHostname,
    executionPolicy: "manual_only" as const,
    scheduleMinutes: 1_440,
  };
}
