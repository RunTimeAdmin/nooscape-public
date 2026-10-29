import { describe, expect, it } from "vitest";
import {
  CLAIM_HEADING,
  CLAIM_MEANS_LINE,
  claimChainLabel,
  claimedLine,
  claimIntro,
  claimViewOf,
  cleanText,
  EMPTY_FORM,
  editFromForm,
  formFromProfile,
  HELD_LINE,
  lastCheckedLine,
  linesOf,
  NO_COST_LINE,
  entryIdFrom,
  FIELD_LABEL,
  HISTORY_NOTE,
  historyLine,
  historySummary,
  NOTICE,
  noticeText,
  OWNER_LINK_REL,
  OWNER_TEXT_NOTE,
  readableValue,
  safeHttpsHref,
  TEXT_NOT_SHOWN,
  type ClaimHistoryView,
  STEP_LABEL,
  type ClaimStateView,
} from "./claimFlow";

/** The panel's decisions and words (docs/claims-2026-10-18.md), without a browser. */
const WALLET = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const state = (overrides: Partial<ClaimStateView> = {}): ClaimStateView => ({ available: true, claimable: true, claim: null, ...overrides });
const claim = (status: "active" | "frozen" = "active", wallet = WALLET.toLowerCase()) => ({ status, wallet, claimedAt: new Date("2026-10-18T20:00:00Z"), lastOwnerCheckAt: new Date("2026-10-18T21:00:00Z"), profile: { name: "Alice Agent", website: "https://example.org/", description: null, links: ["https://example.org/docs"] } });

describe("which view the panel shows", () => {
  it("shows nothing until the server has answered, and nothing when claims are not available or the entry cannot be claimed", () => {
    expect(claimViewOf(undefined, null)).toBe("loading");
    expect(claimViewOf(state({ available: false }), WALLET)).toBe("hidden");
    expect(claimViewOf(state({ claimable: false }), WALLET)).toBe("hidden");
  });

  it("offers the claim when nobody has claimed, whether or not a wallet is connected", () => {
    expect(claimViewOf(state(), null)).toBe("open");
    expect(claimViewOf(state(), WALLET)).toBe("open");
  });

  it("shows the claim to everyone, and the edit form only to the wallet that holds it, in either case", () => {
    expect(claimViewOf(state({ claim: claim() }), null)).toBe("claimed");
    expect(claimViewOf(state({ claim: claim() }), "0x" + "1".repeat(40))).toBe("claimed");
    expect(claimViewOf(state({ claim: claim() }), WALLET)).toBe("yours");
    expect(claimViewOf(state({ claim: claim() }), WALLET.toLowerCase())).toBe("yours");
  });

  it("shows a claim on hold as on hold, even to its owner", () => {
    expect(claimViewOf(state({ claim: claim("frozen") }), WALLET)).toBe("held");
    expect(claimViewOf(state({ claim: claim("frozen") }), null)).toBe("held");
  });
});

describe("the edit form", () => {
  const profile = claim().profile;

  it("starts from what the owner has written, with the links one to a line", () => {
    expect(formFromProfile(profile)).toEqual({ name: "Alice Agent", website: "https://example.org/", description: "", links: "https://example.org/docs" });
    expect(formFromProfile({ name: null, website: null, description: null, links: [] })).toEqual(EMPTY_FORM);
  });

  it("is not an edit when nothing changed, and says so", () => {
    expect(editFromForm(formFromProfile(profile), profile)).toEqual({ ok: false, field: "name", message: "Change at least one field first." });
    // Spaces around a value are not a change.
    expect(editFromForm({ ...formFromProfile(profile), name: "  Alice Agent  " }, profile).ok).toBe(false);
  });

  it("names only the fields that changed, cleaned, and turns an emptied field into a clearing edit", () => {
    const changed = editFromForm({ ...formFromProfile(profile), name: "  Alice\u0000 Agent v2 ", website: "", description: "Fast\u202e agent" }, profile);
    expect(changed).toEqual({ ok: true, edit: { name: "Alice Agent v2", website: null, description: "Fast agent" } });
    expect(editFromForm({ ...formFromProfile(profile), links: "" }, profile)).toEqual({ ok: true, edit: { links: [] } });
  });

  it("changes the links when the list changes, drops empty lines and repeats, and refuses what the server would", () => {
    expect(editFromForm({ ...formFromProfile(profile), links: "https://example.org/docs\n\n https://github.com/alice \nhttps://github.com/alice#x" }, profile)).toEqual({ ok: true, edit: { links: ["https://example.org/docs", "https://github.com/alice"] } });
    expect(editFromForm({ ...formFromProfile(profile), website: "http://example.org" }, profile)).toMatchObject({ ok: false, field: "website" });
    expect(editFromForm({ ...formFromProfile(profile), links: "https://localhost./x" }, profile)).toMatchObject({ ok: false, field: "links" });
    expect(editFromForm({ ...formFromProfile(profile), name: "x".repeat(121) }, profile)).toMatchObject({ ok: false, field: "name", message: "At most 120 characters." });
    expect(editFromForm({ ...formFromProfile(profile), links: Array.from({ length: 6 }, (_, index) => `https://example.org/${index}`).join("\n") }, profile)).toMatchObject({ ok: false, field: "links" });
  });

  it("cleans text the way the server does, and splits lines on either kind of break", () => {
    expect(cleanText("  a\u0000b \u200b c ", 10)).toBe("a b c");
    expect(cleanText("   ", 10)).toBeNull();
    expect(cleanText("x".repeat(20), 5)).toBe("xxxxx");
    expect(linesOf("a\r\n\r\n b \nc")).toEqual(["a", "b", "c"]);
  });
});

describe("the chain a claim can be made on", () => {
  it("names Robinhood Chain and BNB Smart Chain whatever the build has on, and no other protocol", () => {
    for (const features of [undefined, "", "claims", "chain_arc", "claims_arc"]) {
      expect(claimChainLabel("erc8004", features), String(features)).toBe("Robinhood Chain");
      expect(claimChainLabel("erc8004_bsc", features), String(features)).toBe("BNB Smart Chain");
    }
    for (const protocol of ["solana_8004", "solana_said", "a2a", "catalog", "erc8004_reputation", "erc8004_base", "erc8004_eth", ""]) expect(claimChainLabel(protocol, "chain_arc,claims_arc,chain_base,chain_ethereum"), protocol).toBeNull();
  });

  it("names Arc only while Arc and its claims are both on in the build", () => {
    expect(claimChainLabel("erc8004_arc", "chain_arc,claims_arc")).toBe("Arc");
    expect(claimChainLabel("erc8004_arc", " Claims , CLAIMS_ARC , Chain_Arc ")).toBe("Arc");
    for (const features of [undefined, "", "claims", "chain_arc", "claims_arc", "claims,chain_arc"]) expect(claimChainLabel("erc8004_arc", features), String(features)).toBeNull();
  });

  it("names Base only while Base and its claims are both on in the build, and Ethereum only while Ethereum and its claims are", () => {
    expect(claimChainLabel("erc8004_base", "chain_base,claims_base")).toBe("Base");
    expect(claimChainLabel("erc8004_eth", "chain_ethereum,claims_ethereum")).toBe("Ethereum");
    expect(claimChainLabel("erc8004_base", " Claims , CLAIMS_BASE , Chain_Base ")).toBe("Base");
    for (const features of [undefined, "", "claims", "chain_base", "claims_base", "claims,chain_base", "chain_ethereum,claims_ethereum,chain_arc,claims_arc"]) expect(claimChainLabel("erc8004_base", features), String(features)).toBeNull();
    for (const features of [undefined, "", "claims", "chain_ethereum", "claims_ethereum", "claims,chain_ethereum", "chain_base,claims_base,chain_arc,claims_arc"]) expect(claimChainLabel("erc8004_eth", features), String(features)).toBeNull();
    // Each chain's switches open that chain only.
    expect(claimChainLabel("erc8004_arc", "chain_base,claims_base,chain_ethereum,claims_ethereum")).toBeNull();
  });

  it("reads the build's own list when none is given, which is none in a test", () => {
    expect(claimChainLabel("erc8004_arc")).toBeNull();
    expect(claimChainLabel("erc8004")).toBe("Robinhood Chain");
  });
});

describe("the words", () => {
  it("say what claiming asks and costs, and what a claim is, in plain words", () => {
    expect(CLAIM_HEADING).toBe("Claim this agent");
    expect(claimIntro("BNB Smart Chain")).toBe("If you own this agent's registration on BNB Smart Chain, you can claim it. Claiming asks your wallet for one signature, which proves you control the wallet the registry records as the owner.");
    expect(NO_COST_LINE).toBe("It sends no transaction, costs no gas, asks for no approval and gives Nooscape no access to your funds.");
    expect(CLAIM_MEANS_LINE).toContain("It is not a review, a tier or a score");
    expect(claimedLine(WALLET)).toBe("Claimed by the owner wallet 0x7E5F…5Bdf. Claims are self-described and unverified beyond wallet ownership.");
    expect(HELD_LINE).toBe("This claim is on hold.");
    expect(lastCheckedLine("Oct 18 at 4:00 PM CT")).toBe("The registry was last asked who owns this agent on Oct 18 at 4:00 PM CT. If the agent changes hands, the claim ends.");
  });

  it("say before the signature what claiming agrees to and where what is kept is written", () => {
    expect(noticeText()).toBe("By claiming you agree to the Terms for claiming. What Nooscape keeps is on the Privacy page.");
    expect(NOTICE.terms).toBe("Terms for claiming");
    expect(NOTICE.privacy).toBe("Privacy page");
  });

  it("carry no score, rank, grade or verdict word and no long dash", () => {
    const everything = [CLAIM_HEADING, claimIntro("Robinhood Chain"), NO_COST_LINE, CLAIM_MEANS_LINE, claimedLine(WALLET), HELD_LINE, lastCheckedLine("x"), ...Object.values(STEP_LABEL)].join(" ");
    expect(everything).not.toMatch(/\b(rank|grade|verified|trusted|safe|certified|endorsed)\b|[–—]/i);
    expect(everything.replace(/is not a review, a tier or a score/, "")).not.toMatch(/\bscore\b/i);
  });
});

describe("an address the owner wrote, as a link", () => {
  it("is a link only when it is an https address, and then in its normal form", () => {
    expect(safeHttpsHref("https://example.org/docs")).toBe("https://example.org/docs");
    expect(safeHttpsHref("HTTPS://Example.ORG")).toBe("https://example.org/");
    for (const bad of ["http://example.org", "javascript:alert(1)", "data:text/html,x", "//evil.example", "ftp://example.org", "example.org", "https://", "", "   "]) {
      expect(safeHttpsHref(bad), bad).toBeNull();
    }
  });

  it("carries no search credit and no opener", () => {
    expect(OWNER_LINK_REL).toBe("nofollow ugc noopener noreferrer");
  });
});

const row = (overrides: Partial<ClaimHistoryView>): ClaimHistoryView => ({ seq: 1, kind: "edit", field: "name", oldValue: null, newValue: null, withheld: false, wallet: null, signatureDigest: null, reason: null, occurredAt: new Date("2026-10-18T20:00:00Z"), ...overrides });
const WALLET_1 = "0x14791697260e4c9a71f18484c9f997b308e59325";
const DIGEST = "a".repeat(64);

describe("the history in plain words", () => {
  it("says who claimed, signed by which wallet, with the start of the signature digest", () => {
    expect(historyLine(row({ kind: "claim", field: null, wallet: WALLET_1, signatureDigest: DIGEST }))).toEqual({ title: "Claimed", change: null, signed: "Signed by 0x1479…9325, signature digest aaaaaaaaaaaa…." });
  });

  it("says what an edit set, changed or cleared, and the links as addresses", () => {
    const signed = { wallet: WALLET_1, signatureDigest: DIGEST };
    expect(historyLine(row({ newValue: "Alice", ...signed })).change).toBe("Set to: Alice");
    expect(historyLine(row({ oldValue: "Alice", newValue: "Alicia", ...signed })).change).toBe("Changed from: Alice" + String.fromCharCode(10) + "To: Alicia");
    expect(historyLine(row({ oldValue: "Alice", ...signed })).change).toBe("Cleared. It was: Alice");
    expect(historyLine(row({ field: "links", newValue: JSON.stringify(["https://a.example/", "https://b.example/"]), ...signed }))).toMatchObject({ title: "Changed the links", change: "Set to: https://a.example/, https://b.example/" });
    expect(readableValue("links", "not json")).toBe("not json");
    expect(readableValue("name", "Alice")).toBe("Alice");
  });

  it("says only that a change was made when its text is not shown, and never repeats a value it was given for such a row", () => {
    const line = historyLine(row({ withheld: true, oldValue: "should not appear", newValue: "should not appear either", wallet: WALLET_1, signatureDigest: DIGEST }));
    expect(line.change).toBe(TEXT_NOT_SHOWN);
    expect(JSON.stringify(line)).not.toContain("should not appear");
    expect(historyLine(row({ oldValue: null, newValue: null })).change).toBe(TEXT_NOT_SHOWN);
  });

  it("says a hold, the end of a hold, an end and a removal, with no wallet on any of them", () => {
    expect(historyLine(row({ kind: "freeze", field: null, reason: "operator" }))).toMatchObject({ title: "Put on hold", signed: null });
    expect(historyLine(row({ kind: "unfreeze", field: null }))).toMatchObject({ title: "Taken off hold", change: null, signed: null });
    expect(historyLine(row({ kind: "revoke", field: null, reason: "owner_changed" }))).toEqual({ title: "The claim ended", change: "The registry shows a new owner.", signed: null });
    expect(historyLine(row({ kind: "revoke", field: null, reason: "token_gone" })).change).toBe("The registry no longer shows an owner.");
    expect(historyLine(row({ kind: "revoke", field: null, reason: "something else" })).change).toBeNull();
    expect(historyLine(row({ kind: "redact", field: "website", reason: "owner_request" }))).toEqual({ title: "Removed the website from view at the owner's request", change: null, signed: null });
    expect(historyLine(row({ kind: "redact", field: "links", reason: "nooscape" }))).toEqual({ title: "Removed the links from view by Nooscape", change: null, signed: null });
    // A row with no actor word still reads as a removal, and no reason is ever added to it.
    expect(historyLine(row({ kind: "redact", field: "name", reason: "removed" }))).toEqual({ title: "Removed the name from view", change: null, signed: null });
  });

  it("counts the entries, and the words carry no score, rank or verdict and no long dash", () => {
    expect(historySummary(1)).toBe("1 entry");
    expect(historySummary(7)).toBe("7 entries");
    const words = [OWNER_TEXT_NOTE, HISTORY_NOTE, TEXT_NOT_SHOWN, ...Object.values(FIELD_LABEL)].join(" ");
    expect(words).not.toMatch(/(rank|grade|verified|trusted|safe|certified|endorsed|score)|[–—]/i);
  });
});

describe("the operator's box", () => {
  it("takes an entry's id, or the address of its page with or without a query or a fragment", () => {
    expect(entryIdFrom("  abc-123 ")).toBe("abc-123");
    expect(entryIdFrom("https://nooscape.si/agents/abc-123")).toBe("abc-123");
    expect(entryIdFrom("https://nooscape.si/agents/abc-123?x=1#top")).toBe("abc-123");
    expect(entryIdFrom("nooscape.si/agents/abc-123/")).toBe("abc-123");
    expect(entryIdFrom("")).toBe("");
  });
});
