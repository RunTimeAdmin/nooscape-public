import { describe, expect, it } from "vitest";
import { sanitizePrimaryCapability, sanitizePublicText } from "./publicText";

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
