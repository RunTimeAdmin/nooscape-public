import { describe, expect, it } from "vitest";
import { publicDisplayName, sanitizePrimaryCapability, sanitizePublicText } from "./publicText";

describe("public text sanitization", () => {
  it("strips invisible characters (zero-width, bidi, soft hyphen)", () => {
    expect(sanitizePublicText("a\u200Bb\u202Ec\u2066d\u00ADe")).toBe("abcde");
  });

  it("flattens control characters and collapses whitespace", () => {
    expect(sanitizePublicText("a\n\tb\u0000c  d")).toBe("a b c d");
    expect(sanitizePublicText("  padded  ")).toBe("padded");
  });

  it("returns null for non-strings and empty results", () => {
    expect(sanitizePublicText(null)).toBeNull();
    expect(sanitizePublicText(undefined)).toBeNull();
    expect(sanitizePublicText("")).toBeNull();
    expect(sanitizePublicText("\u200B\u202A")).toBeNull();
  });

  it("caps the served length", () => {
    expect(sanitizePublicText("x".repeat(20), 8)).toBe("xxxxxxxx");
  });

  it("suppresses version-like capability values", () => {
    expect(sanitizePrimaryCapability("1.0")).toBeNull();
    expect(sanitizePrimaryCapability("0.3.0")).toBeNull();
    expect(sanitizePrimaryCapability("1.0.1")).toBeNull();
    expect(sanitizePrimaryCapability("0.3")).toBeNull();
  });

  it("keeps real capability labels intact", () => {
    expect(sanitizePrimaryCapability("verification")).toBe("verification");
    expect(sanitizePrimaryCapability("Agent Card Generator")).toBe("Agent Card Generator");
    expect(sanitizePrimaryCapability("a2a_x402")).toBe("a2a_x402");
    expect(sanitizePrimaryCapability(null)).toBeNull();
  });
});

describe("the name a reader shows for an entry", () => {
  const evmKey = (id: string) => `eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:${id}`;
  const solanaKey = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  // A bidirectional override, a zero-width space and a BEL: nothing is left once they are taken out.
  const blank = String.fromCharCode(0x202e, 0x200b, 0x0007);

  it("is the registrant's text with the invisible characters taken out, whatever the key", () => {
    expect(publicDisplayName("Pay\u202Epal\u0007Bot", evmKey("12"))).toBe("Paypal Bot");
    expect(publicDisplayName("  Acme   Agent ", solanaKey)).toBe("Acme Agent");
    expect(publicDisplayName("x".repeat(300), null)).toHaveLength(255);
  });

  it("is the placeholder the registries use when nothing is left of the text, with the id the key ends in", () => {
    expect(publicDisplayName(blank, evmKey("7"))).toBe("Agent #7");
    expect(publicDisplayName("", evmKey("123456789"))).toBe("Agent #123456789");
    expect(publicDisplayName(null, "7")).toBe("Agent #7");
  });

  it("is plain Agent when the key carries no agent number, and never the raw text", () => {
    for (const key of [solanaKey, null, undefined, "", evmKey("0x12"), evmKey("1234567890")]) {
      const shown = publicDisplayName(blank, key);
      expect(shown).toBe("Agent");
      expect(shown).not.toContain(String.fromCharCode(0x202e));
    }
  });
});
