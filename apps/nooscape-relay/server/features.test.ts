import { describe, expect, it } from "vitest";
import { arcClaimsOn, baseClaimsOn, ethereumClaimsOn, FEATURES, featureOn } from "@shared/features";

/**
 * The switches behind which the Your Watch and Patrols scaffolds stay off. Off is the default: nothing is on unless
 * VITE_FEATURES names it.
 */
describe("featureOn", () => {
  it("is off for every feature when nothing is set, or the list is empty", () => {
    for (const feature of FEATURES) {
      expect(featureOn(feature, undefined), feature).toBe(false);
      expect(featureOn(feature, ""), feature).toBe(false);
      expect(featureOn(feature, " , ,"), feature).toBe(false);
    }
  });

  it("is on only for the features the list names, in any case and with spaces", () => {
    expect(featureOn("watch", "watch")).toBe(true);
    expect(featureOn("patrols", "watch")).toBe(false);
    expect(featureOn("patrols", "watch,patrols")).toBe(true);
    expect(featureOn("watch", " Watch , Patrols ")).toBe(true);
  });

  it("ignores a name that is not a feature, and does not match part of a name", () => {
    expect(featureOn("watch", "everything")).toBe(false);
    expect(featureOn("watch", "all")).toBe(false);
    expect(featureOn("watch", "watchlist")).toBe(false);
    expect(featureOn("watch", "unwatch,patrols")).toBe(false);
  });

  it("names exactly the two scaffolds, the claim panel, one switch for each extra chain and a claims switch for each of Arc, Base and Ethereum", () => {
    expect([...FEATURES]).toEqual(["watch", "patrols", "claims", "chain_base", "chain_ethereum", "chain_arc", "claims_arc", "claims_base", "claims_ethereum"]);
    expect(featureOn("claims", "claims")).toBe(true);
    expect(featureOn("claims", "watch,patrols")).toBe(false);
    expect(featureOn("claims", "claimsx")).toBe(false);
  });

  it("keeps each chain's switch separate from the others and from its own name", () => {
    expect(featureOn("chain_base", "chain_base")).toBe(true);
    expect(featureOn("chain_base", "chain_ethereum,chain_arc")).toBe(false);
    expect(featureOn("chain_ethereum", " Chain_Ethereum ")).toBe(true);
    expect(featureOn("chain_arc", "arc")).toBe(false);
    expect(featureOn("chain_arc", "chain_arcade")).toBe(false);
    expect(featureOn("chain_base", "base")).toBe(false);
  });
});

describe("arcClaimsOn", () => {
  it("is on only while Arc itself is on and its claims are switched on, each named in the list", () => {
    expect(arcClaimsOn("chain_arc,claims_arc")).toBe(true);
    expect(arcClaimsOn(" Claims , CLAIMS_ARC , Chain_Arc ")).toBe(true);
    for (const list of [undefined, "", "claims", "chain_arc", "claims_arc", "claims,chain_arc", "claims,claims_arc", "chain_base,chain_ethereum,claims_arc", "chain_arcade,claims_arcade"]) {
      expect(arcClaimsOn(list), String(list)).toBe(false);
    }
  });

  it("is a switch of its own: neither the panel's nor the chain's switch turns it on", () => {
    expect(featureOn("claims_arc", "claims,chain_arc")).toBe(false);
    expect(featureOn("claims_arc", "claims_arc")).toBe(true);
    expect(featureOn("claims", "claims_arc")).toBe(false);
    expect(featureOn("claims_arc", "claimsarc")).toBe(false);
  });
});

describe.each([
  { label: "baseClaimsOn", on: baseClaimsOn, chain: "chain_base", claims: "claims_base", other: "chain_ethereum,claims_ethereum,chain_arc,claims_arc" },
  { label: "ethereumClaimsOn", on: ethereumClaimsOn, chain: "chain_ethereum", claims: "claims_ethereum", other: "chain_base,claims_base,chain_arc,claims_arc" },
])("$label", ({ on, chain, claims, other }) => {
  it("is on only while the chain itself is on and its claims are switched on, each named in the list", () => {
    expect(on(`${chain},${claims}`)).toBe(true);
    expect(on(` Claims , ${claims.toUpperCase()} , ${chain} `)).toBe(true);
    for (const list of [undefined, "", "claims", chain, claims, `claims,${chain}`, `claims,${claims}`, other, `${chain}x,${claims}x`]) {
      expect(on(list), String(list)).toBe(false);
    }
  });

  it("is a switch of its own: neither the panel's nor the chain's switch turns it on", () => {
    expect(featureOn(claims as "claims_base", `claims,${chain}`)).toBe(false);
    expect(featureOn(claims as "claims_base", claims)).toBe(true);
    expect(featureOn("claims", claims)).toBe(false);
  });
});
