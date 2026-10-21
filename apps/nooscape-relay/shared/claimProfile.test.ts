import { describe, expect, it } from "vitest";
import { applyClaimEdit, canonicalClaimEdit, CLAIM_FIELDS, CLAIM_LIMITS, claimEditChanges, EMPTY_CLAIM_PROFILE, normalizeClaimEdit, normalizeClaimUrl, type ClaimProfile } from "./claimProfile";

/** What an owner may write about a claimed agent (docs/claims-2026-10-18.md): four fields, sized and shaped, and nothing else. */
const clean = (text: string, max: number) => {
  const cleaned = text.replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, max);
};

describe("the fields an owner may write", () => {
  it("are four, and only those: not a tier, a state, a rating or whether the entry is listed", () => {
    expect([...CLAIM_FIELDS]).toEqual(["name", "website", "description", "links"]);
    expect(CLAIM_LIMITS).toEqual({ name: 120, website: 300, description: 1000, link: 300, links: 5 });
  });
});

describe("a link", () => {
  it("is kept when it is https on a public name, and cleaned of its fragment and an explicit 443", () => {
    expect(normalizeClaimUrl("https://Example.ORG/Agent?x=1#top")).toBe("https://example.org/Agent?x=1");
    expect(normalizeClaimUrl("  https://example.org:443/a  ")).toBe("https://example.org/a");
    expect(normalizeClaimUrl("https://sub.example.co.uk")).toBe("https://sub.example.co.uk/");
  });

  it("is refused when it is not https, carries credentials, names a port, a local name or an address, or is too long or not a link", () => {
    for (const bad of [
      "http://example.org",
      "ftp://example.org",
      "javascript:alert(1)",
      "data:text/html,hi",
      "//example.org",
      "example.org",
      "https://user@example.org/",
      "https://user:pw@example.org/",
      "https://example.org:8443/",
      "https://localhost/",
      "https://intranet/",
      "https://printer.local/",
      "https://a.internal/",
      "https://127.0.0.1/",
      "https://10.0.0.1/",
      "https://2130706433/",
      "https://0x7f.1/",
      "https://[::1]/",
      "https://[2001:db8::1]/",
      // A name written with its trailing dot is the same name: the parser keeps the dot, so each is refused as it stands.
      "https://localhost./x",
      "https://printer.local./",
      "https://router.lan./admin",
      "https://example.org./",
      `https://example.org/${"a".repeat(300)}`,
      "",
      "   ",
    ]) {
      expect(normalizeClaimUrl(bad), bad).toBeNull();
    }
  });
});

describe("an edit", () => {
  it("is refused when it names no field", () => {
    expect(normalizeClaimEdit({}, clean)).toEqual({ ok: false, field: "name", message: "Name at least one field to change." });
    expect(normalizeClaimEdit({ name: undefined }, clean).ok).toBe(false);
  });

  it("names only the fields it changes, cleans the words, and ignores any key that is not one of the four", () => {
    const result = normalizeClaimEdit({ name: "  Alice\u0000 Agent ", description: "Fast‮", evidenceTier: "tier_4", hidden: true } as never, clean);
    expect(result).toEqual({ ok: true, fields: { name: "Alice Agent", description: "Fast" } });
  });

  it("clears a field with null, an empty box, or an empty list", () => {
    expect(normalizeClaimEdit({ name: null, website: null, description: "   ", links: [] }, clean)).toEqual({ ok: true, fields: { name: null, website: null, description: null, links: [] } });
  });

  it("refuses text that is too long rather than cutting it, and a website or link that is not allowed, naming the field", () => {
    expect(normalizeClaimEdit({ name: "x".repeat(121) }, clean)).toEqual({ ok: false, field: "name", message: "At most 120 characters." });
    expect(normalizeClaimEdit({ description: "x".repeat(1001) }, clean)).toMatchObject({ ok: false, field: "description" });
    expect(normalizeClaimEdit({ website: "http://example.org" }, clean)).toMatchObject({ ok: false, field: "website" });
    expect(normalizeClaimEdit({ links: ["https://example.org", "http://example.org"] }, clean)).toMatchObject({ ok: false, field: "links" });
    expect(normalizeClaimEdit({ links: Array.from({ length: 6 }, (_, index) => `https://example.org/${index}`) }, clean)).toMatchObject({ ok: false, field: "links", message: "At most 5 links." });
    expect(normalizeClaimEdit({ links: [7 as never] }, clean)).toMatchObject({ ok: false, field: "links" });
    expect(normalizeClaimEdit({ name: 7 as never }, clean)).toMatchObject({ ok: false, field: "name" });
  });

  it("keeps each link once, in the order given", () => {
    expect(normalizeClaimEdit({ links: ["https://b.example.org/", "https://a.example.org/", "https://b.example.org/#x"] }, clean)).toEqual({ ok: true, fields: { links: ["https://b.example.org/", "https://a.example.org/"] } });
  });
});

describe("what an owner signs and what is logged", () => {
  it("is the same text for the same edit, whatever order its fields were given in", () => {
    expect(canonicalClaimEdit({ links: ["https://a.example.org/"], name: "A" })).toBe(canonicalClaimEdit({ name: "A", links: ["https://a.example.org/"] }));
    expect(canonicalClaimEdit({ name: "A" })).toBe('{"name":"A"}');
    expect(canonicalClaimEdit({ name: null, links: [] })).toBe('{"name":null,"links":[]}');
    expect(canonicalClaimEdit({ name: "A" })).not.toBe(canonicalClaimEdit({ name: "B" }));
  });

  it("changes only the named fields, and lists only the ones that really change, with the links as a JSON list", () => {
    const profile: ClaimProfile = { name: "Old", website: "https://example.org/", description: null, links: ["https://a.example.org/"] };
    const edit = { name: "New", website: "https://example.org/", links: [] as string[] };
    expect(applyClaimEdit(profile, edit)).toEqual({ name: "New", website: "https://example.org/", description: null, links: [] });
    expect(claimEditChanges(profile, edit)).toEqual([
      { field: "name", oldValue: "Old", newValue: "New" },
      { field: "links", oldValue: JSON.stringify(["https://a.example.org/"]), newValue: null },
    ]);
    expect(claimEditChanges(EMPTY_CLAIM_PROFILE, { name: null })).toEqual([]);
    expect(applyClaimEdit(EMPTY_CLAIM_PROFILE, {})).toEqual(EMPTY_CLAIM_PROFILE);
  });
});
