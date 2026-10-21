import { describe, expect, it } from "vitest";
import { buildClaimMessage, CLAIM_DOMAIN, CLAIM_MESSAGE_MAX, CLAIM_NONCE_TTL_MS, CLAIM_ORIGIN, CLAIM_STATEMENT, claimResource, editStatement, type ClaimMessageFields } from "./claimMessage";

/** The message an owner signs (docs/claims-2026-10-18.md): an EIP-4361 sign-in that binds the site, the page, the chain, the agent, a nonce and a time. */
const fields: ClaimMessageFields = {
  address: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  action: "claim",
  entryId: "11111111-2222-3333-4444-555555555555",
  chainId: 4663,
  registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  tokenId: "7",
  nonce: "a1b2c3d4e5f60001",
  issuedAt: new Date("2026-10-18T20:00:00Z"),
  expiresAt: new Date("2026-10-18T20:10:00Z"),
  editText: null,
};

describe("the claim message", () => {
  it("is an EIP-4361 sign-in for nooscape.si, one line for each thing it binds", () => {
    expect(buildClaimMessage(fields).split("\n")).toEqual([
      "nooscape.si wants you to sign in with your Ethereum account:",
      "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
      "",
      "Claim this agent on Nooscape. This only proves you own the wallet. No transaction, no gas, no approval.",
      "",
      "URI: https://nooscape.si/agents/11111111-2222-3333-4444-555555555555",
      "Version: 1",
      "Chain ID: 4663",
      "Nonce: a1b2c3d4e5f60001",
      "Issued At: 2026-10-18T20:00:00.000Z",
      "Expiration Time: 2026-10-18T20:10:00.000Z",
      "Resources:",
      "- eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:7",
    ]);
    expect(CLAIM_DOMAIN).toBe("nooscape.si");
    expect(CLAIM_ORIGIN).toBe("https://nooscape.si");
    expect(CLAIM_NONCE_TTL_MS).toBe(600_000);
  });

  it("is the same text for the same fields, and a different text for any one field that differs", () => {
    const base = buildClaimMessage(fields);
    expect(buildClaimMessage({ ...fields })).toBe(base);
    for (const change of [
      { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
      { entryId: "11111111-2222-3333-4444-555555555556" },
      { chainId: 56 },
      { registry: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359" },
      { tokenId: "8" },
      { nonce: "a1b2c3d4e5f60002" },
      { issuedAt: new Date("2026-10-18T20:00:01Z") },
      { expiresAt: new Date("2026-10-18T20:10:01Z") },
      { action: "edit" as const, editText: '{"name":"A"}' },
    ]) {
      expect(buildClaimMessage({ ...fields, ...change }), JSON.stringify(change)).not.toBe(base);
    }
  });

  it("shows an edit as it is, the changes written out as JSON in the statement, so the wallet shows what is being signed for", () => {
    const text = JSON.stringify({ website: "https://phish.example/", links: ["https://example.org/docs"] });
    const message = buildClaimMessage({ ...fields, action: "edit", editText: text });
    expect(message).toContain(editStatement(text));
    expect(editStatement(text)).toBe(`Edit the owner-provided profile of this agent on Nooscape. This only proves you own the wallet. No transaction, no gas, no approval. Changes: ${text}`);
    // The whole statement is one line, as EIP-4361 requires: JSON writes a line break inside a value as \n, never as a break.
    const withBreak = buildClaimMessage({ ...fields, action: "edit", editText: JSON.stringify({ description: "a\nb" }) });
    expect(withBreak.split("\n")).toHaveLength(buildClaimMessage(fields).split("\n").length);
    expect(buildClaimMessage({ ...fields, action: "edit", editText: JSON.stringify({ website: "https://example.org/" }) })).not.toBe(message);
  });

  it("is longest for the largest edit and still inside the limit the server accepts", () => {
    const largest = JSON.stringify({ name: "n".repeat(120), website: `https://example.org/${"w".repeat(270)}`, description: "d".repeat(1000), links: Array.from({ length: 5 }, () => `https://example.org/${"l".repeat(270)}`) });
    expect(buildClaimMessage({ ...fields, action: "edit", editText: largest }).length).toBeLessThan(CLAIM_MESSAGE_MAX);
    expect(largest.length).toBeLessThan(4000);
  });

  it("says in plain words that it asks for no transaction, no gas and no approval, and asks for none", () => {
    for (const text of [CLAIM_STATEMENT, editStatement('{"name":"A"}')]) {
      expect(text).toContain("This only proves you own the wallet. No transaction, no gas, no approval.");
      expect(text).not.toMatch(/send|transfer|approve (?!\.)|allowance|spend/i);
    }
    expect(buildClaimMessage(fields)).not.toMatch(/[–—]/);
  });

  it("names the entry in the CAIP-10 style the directory keys it by", () => {
    expect(claimResource(56, "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", "12")).toBe("eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:12");
  });
});
