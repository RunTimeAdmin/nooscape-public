/**
 * Features that are built and stay off until the owner turns them on. VITE_FEATURES holds the ones that are on, as a comma
 * list ("watch,patrols,claims"). The client reads it when it is built and the server when it runs, so a feature's page and the
 * status the server gives its address agree. A name that is not a feature is ignored, and an unset list turns nothing on.
 *
 *  - `watch` and `patrols`: the two scaffold pages (docs/watch-patrols-scaffold-2026-10-15.md), each with a route of its own.
 *  - `claims`: the "Claim this agent" panel on the page of an EVM registry entry (docs/claims-2026-10-18.md). It has no route: it
 *    is a section of an existing page. It stays off until the Privacy and Terms pages say what it does and the owner turns it on.
 *  - `chain_base`, `chain_ethereum` and `chain_arc`: one switch for each chain the ERC-8004 identity pass reads besides BNB Chain
 *    (docs/multichain-erc8004-2026-10-20.md). While a chain's switch is off its pass does not run, its source cannot be staged, and
 *    nothing of it is shown or served.
 *  - `claims_arc`: the claim flow for agents on Arc (docs/arc-claims-2026-10-20.md). It works only while `chain_arc` is on as well, and the
 *    panel itself is `claims`. It is a switch of its own so that Arc's claims are turned on on purpose and not when its page goes live.
 *  - `claims_base` and `claims_ethereum`: the same for agents on Base and on Ethereum (docs/base-ethereum-claims-2026-10-28.md), each working
 *    only while its chain's own switch is on as well.
 */
export const FEATURES = ["watch", "patrols", "claims", "chain_base", "chain_ethereum", "chain_arc", "claims_arc", "claims_base", "claims_ethereum"] as const;

export type Feature = (typeof FEATURES)[number];

export function featureOn(feature: Feature, list: string | undefined): boolean {
  return (list ?? "")
    .split(",")
    .map(item => item.trim().toLowerCase())
    .includes(feature);
}

/** Whether agents on Arc can be claimed: Arc itself is on and its claims have been switched on. Robinhood Chain and BNB Smart Chain need neither. */
export const arcClaimsOn = (list: string | undefined): boolean => featureOn("chain_arc", list) && featureOn("claims_arc", list);

/** Whether agents on Base can be claimed: Base itself is on and its claims have been switched on. */
export const baseClaimsOn = (list: string | undefined): boolean => featureOn("chain_base", list) && featureOn("claims_base", list);

/** Whether agents on Ethereum can be claimed: Ethereum itself is on and its claims have been switched on. */
export const ethereumClaimsOn = (list: string | undefined): boolean => featureOn("chain_ethereum", list) && featureOn("claims_ethereum", list);
