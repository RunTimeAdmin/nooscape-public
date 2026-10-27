import { describe, expect, it } from "vitest";
import {
  agencAuthorityExplanation,
  ownerWalletExplanation,
  registrantExplanation,
  registrantExplanationFor,
  registrantLabel,
  registrantNarration,
  registrantNarrationFor,
  registryWalletNarration,
  bnbWalletNarration,
  saidAuthorityExplanation,
  sharedWalletNoun,
  formatRecordedAt,
  solanaActivityEventLabel,
  solanaActivityExplanation,
  solanaRegistries,
  solanaRegistryLabel,
  walletKind,
} from "./evidenceExplain";

/**
 * The wallet stored against a directory row means different things per
 * protocol, and the ERC-8004 wording ("registered ... decoded from the
 * registration event itself") is only true for ERC-8004. Metaplex and 8004
 * Solana store the asset's current owner; SAID stores the identity's current
 * authority, which the owner can hand to another wallet. Each kind gets copy
 * that says what it is, and ERC-8004 keeps exactly the wording it had.
 */
describe("walletKind", () => {
  it("classifies each protocol by what its stored wallet is", () => {
    expect(walletKind("erc8004")).toBe("registrant");
    expect(walletKind("solana_registry")).toBe("owner");
    expect(walletKind("solana_8004")).toBe("owner");
    expect(walletKind("solana_said")).toBe("authority");
    expect(walletKind("solana_agenc")).toBe("authority");
  });

  it("defaults any other protocol to the existing registrant wording", () => {
    for (const protocol of ["catalog", "a2a", "census", "something_new"]) expect(walletKind(protocol)).toBe("registrant");
  });
});

describe("registrant copy is worded per wallet kind", () => {
  it("keeps ERC-8004 (and the default) on the original wording exactly", () => {
    for (const protocol of ["erc8004", "catalog", "a2a"]) {
      expect(registrantLabel(protocol)).toBe("Registering wallet");
      expect(registrantExplanationFor(protocol)).toBe(registrantExplanation);
      expect(registrantNarrationFor(protocol, 0)).toBe(registrantNarration(0));
      expect(registrantNarrationFor(protocol, 3)).toBe(registrantNarration(3));
      expect(sharedWalletNoun(protocol)).toBe("registering wallet");
    }
  });

  it("describes a Metaplex or 8004 wallet as the current owner, not the registrant", () => {
    for (const protocol of ["solana_registry", "solana_8004"]) {
      expect(registrantLabel(protocol)).toBe("Current owner wallet");
      const text = registrantExplanationFor(protocol);
      expect(text).toBe(ownerWalletExplanation);
      expect(text).toContain("current owner");
      expect(text).toContain("not necessarily the wallet that registered the identity");
      expect(text).toContain("not a verified operator");
      expect(text).not.toContain("registration event");
    }
  });

  it("describes SAID's wallet as the current authority, not as the registering wallet", () => {
    expect(registrantLabel("solana_said")).toBe("Controlling wallet");
    const text = registrantExplanationFor("solana_said");
    expect(text).toBe(saidAuthorityExplanation);
    expect(text).toContain("authority");
    expect(text).toContain("can differ from the wallet the identity was registered under");
    expect(text).toContain("not a verified operator");
    expect(text).not.toContain("registration event");
  });

  it("describes an AgenC agent's wallet as its authority in the AgenC program account, and says nothing of SAID", () => {
    expect(registrantLabel("solana_agenc")).toBe("Controlling wallet");
    const text = registrantExplanationFor("solana_agenc");
    expect(text).toBe(agencAuthorityExplanation);
    expect(text).toContain("AgenC program account");
    expect(text).toContain("controls the agent");
    expect(text).toContain("not a verified operator");
    expect(text).not.toContain("SAID");
    expect(text).not.toContain("registration event");
  });

  it("words fold counts for owner and authority wallets without claiming they registered the identities", () => {
    for (const protocol of ["solana_registry", "solana_8004", "solana_said", "solana_agenc"]) {
      expect(registrantNarrationFor(protocol, 0)).toBe("This wallet is recorded against only this identity in the directory so far.");
      expect(registrantNarrationFor(protocol, 1)).toBe("This wallet is also recorded against 1 other identity in the directory.");
      expect(registrantNarrationFor(protocol, 2)).toBe("This wallet is also recorded against 2 other identities in the directory.");
      expect(registrantNarrationFor(protocol, 2)).not.toContain("registered");
      expect(sharedWalletNoun(protocol)).toBe("recorded wallet");
    }
  });
});


/**
 * The Solana activity ledger's wording. A transfer is an owner or authority
 * change and is never called a sale; the recorded time is the pass's, shown in
 * UTC, and a bad value degrades to plain text instead of "Invalid Date".
 */
describe("Solana activity event wording", () => {
  it("labels each ledger kind in plain words, with SAID's transfer named for its authority", () => {
    expect(solanaActivityEventLabel("register", "solana_said")).toBe("Registered");
    expect(solanaActivityEventLabel("profile_update", "solana_8004")).toBe("Profile edited");
    expect(solanaActivityEventLabel("transfer", "solana_registry")).toBe("Changed owner");
    expect(solanaActivityEventLabel("transfer", "solana_8004")).toBe("Changed owner");
    expect(solanaActivityEventLabel("transfer", "solana_said")).toBe("Authority handed to another wallet");
  });

  it("never reads a transfer as a sale and never echoes an unknown kind", () => {
    for (const protocol of ["solana_registry", "solana_8004", "solana_said"]) {
      expect(solanaActivityEventLabel("transfer", protocol).toLowerCase()).not.toMatch(/sold|sale|bought/);
    }
    expect(solanaActivityEventLabel("something_new", "solana_said")).toBe("Registry event");
  });

  it("names each registry and falls back without leaking the protocol key", () => {
    expect(solanaRegistries.map(registry => solanaRegistryLabel(registry.protocol))).toEqual(["SAID", "8004", "Metaplex"]);
    expect(solanaRegistryLabel("erc8004")).toBe("Solana registry");
  });

  it("formats the recorded time in UTC from a Date or an ISO string, and survives garbage", () => {
    expect(formatRecordedAt(new Date(Date.UTC(2026, 9, 13, 16, 30, 25)))).toBe("2026-10-13 16:30 UTC");
    expect(formatRecordedAt("2026-10-13T16:30:25.000Z")).toBe("2026-10-13 16:30 UTC");
    expect(formatRecordedAt("not a date")).toBe("time unavailable");
  });

  it("states the recorded-time boundary and the not-a-sale boundary in the page explanation", () => {
    expect(solanaActivityExplanation).toContain("not the chain's own timestamp");
    expect(solanaActivityExplanation).toContain("the slot is the one the pass observed, not the transaction's own");
    expect(solanaActivityExplanation).toContain("never read as sales");
    expect(solanaActivityExplanation).not.toMatch(/\u2014|\u2013/);
  });
});

describe("the BNB Chain registry's wallet narration", () => {
  it("counts over the whole registry and says some registrations may not be listed", () => {
    expect(registrantNarrationFor("erc8004_bsc", 0)).toBe("This wallet has registered only this identity on BNB Chain.");
    expect(registrantNarrationFor("erc8004_bsc", 1)).toBe("This wallet has also registered 1 other identity on BNB Chain, counted over the whole registry (some may not be listed here).");
    expect(registrantNarrationFor("erc8004_bsc", 4)).toBe(bnbWalletNarration(4));
    expect(bnbWalletNarration(4)).toContain("4 other identities");
    expect(bnbWalletNarration(4)).not.toContain("in the directory");
  });

  it("leaves every other protocol's narration exactly as it was", () => {
    expect(registrantNarrationFor("erc8004", 3)).toBe(registrantNarration(3));
    expect(registrantNarrationFor("solana_said", 2)).toBe("This wallet is also recorded against 2 other identities in the directory.");
  });
});

describe("the wallet narration of the other registries the chain pass reads", () => {
  it("is the BNB Chain narration with the chain's own name", () => {
    expect(registrantNarrationFor("erc8004_base", 0)).toBe("This wallet has registered only this identity on Base.");
    expect(registrantNarrationFor("erc8004_eth", 1)).toBe("This wallet has also registered 1 other identity on Ethereum, counted over the whole registry (some may not be listed here).");
    expect(registrantNarrationFor("erc8004_arc", 5)).toBe("This wallet has also registered 5 other identities on Arc, counted over the whole registry (some may not be listed here).");
    expect(registrantNarrationFor("erc8004_arc", 5)).not.toContain("in the directory");
  });

  it("leaves the BNB Chain narration word for word what it was", () => {
    expect(registryWalletNarration("BNB Chain", 4)).toBe(bnbWalletNarration(4));
    expect(registrantNarrationFor("erc8004_bsc", 0)).toBe("This wallet has registered only this identity on BNB Chain.");
    expect(registrantNarrationFor("erc8004_bsc", 1)).toBe("This wallet has also registered 1 other identity on BNB Chain, counted over the whole registry (some may not be listed here).");
  });
});
