import { describe, expect, it } from "vitest";
import { EXTRA_CHAINS, extraProtocolOf } from "./chains";
import {
  CENSUS_CHAINS,
  CENSUS_FIGURES,
  CENSUS_FIGURE_LABEL,
  CENSUS_SOURCE,
  censusChainOn,
  censusFigureOfLabel,
  SOLANA_CENSUS_REGISTRIES,
  solanaFigureKey,
} from "./censusToday";

describe("the chains with a Today block", () => {
  it("are the extra chains that have a census report, the two older ones, the Solana registry census and the BNB Chain rating census", () => {
    expect([...CENSUS_CHAINS].sort()).toEqual([...EXTRA_CHAINS, "bnb", "robinhood", "solana", "bnb_ratings"].sort());
  });

  it("read the Solana census from its three registries' entries and the rating census from the ratings ledger, both always on", () => {
    expect(CENSUS_SOURCE.solana).toEqual({ kind: "solana" });
    expect(CENSUS_SOURCE.bnb_ratings).toEqual({ kind: "bsc_ratings" });
    expect([...SOLANA_CENSUS_REGISTRIES]).toEqual(["solana_said", "solana_8004", "solana_registry"]);
    expect(solanaFigureKey("solana_8004", "distinctLinks")).toBe("solana_8004.distinctLinks");
    for (const chain of ["solana", "bnb_ratings"] as const) {
      expect(censusChainOn(chain, undefined)).toBe(true);
      expect(censusChainOn(chain, "")).toBe(true);
    }
  });

  it("read each extra chain's own source, and its ratings under the chain's own key", () => {
    for (const chain of EXTRA_CHAINS) {
      expect(CENSUS_SOURCE[chain]).toEqual({ kind: "rows", protocol: extraProtocolOf(chain), ratingsKey: chain });
    }
  });

  it("keep BNB Chain's registrations in rows and Robinhood Chain's as entries, neither with a ratings count of this kind", () => {
    expect(CENSUS_SOURCE.bnb).toEqual({ kind: "rows", protocol: "erc8004_bsc", ratingsKey: null });
    expect(CENSUS_SOURCE.robinhood).toEqual({ kind: "entries", protocol: "erc8004", ratingsKey: null });
  });

  it("are on while their switch is, and BNB Chain and Robinhood Chain always", () => {
    expect(censusChainOn("bnb", undefined)).toBe(true);
    expect(censusChainOn("robinhood", "")).toBe(true);
    expect(censusChainOn("monad", undefined)).toBe(false);
    expect(censusChainOn("monad", "chain_monad")).toBe(true);
    expect(censusChainOn("gnosis", "claims,chain_gnosis")).toBe(true);
    expect(censusChainOn("gnosis", "chain_monad")).toBe(false);
    expect(censusChainOn("celo", "claims,chain_celo")).toBe(true);
    expect(censusChainOn("celo", "chain_gnosis")).toBe(false);
    expect(censusChainOn("arc", "claims_arc")).toBe(false);
  });
});

describe("the counts of a first table", () => {
  it("have a label each, and no two share one", () => {
    expect(new Set(CENSUS_FIGURES.map(figure => CENSUS_FIGURE_LABEL[figure])).size).toBe(CENSUS_FIGURES.length);
  });

  it("are found again from the label a page uses", () => {
    for (const figure of CENSUS_FIGURES) expect(censusFigureOfLabel(CENSUS_FIGURE_LABEL[figure])).toBe(figure);
    expect(censusFigureOfLabel("Entries the directory shows")).toBeNull();
  });

  it("are written without a long dash", () => {
    for (const figure of CENSUS_FIGURES) expect(CENSUS_FIGURE_LABEL[figure]).not.toMatch(/[\u2013\u2014]/);
  });
});
