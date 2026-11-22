import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Small state races found by the frontend audit of 22 November 2026, held by the shape of the code (the client's tests run without a
 * DOM). Each says what the user would have seen.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("checking an evidence packet", () => {
  const page = read("./VerifyEvidence.tsx");
  const handler = page.slice(page.indexOf("const handleFile = async"), page.indexOf("return (", page.indexOf("const handleFile = async")));

  it("checks only the newest file picked, so a verdict never sits beside another file's name", () => {
    expect(page).toContain("const picked = useRef(0);");
    expect(handler).toContain("const mine = (picked.current += 1);");
    const afterRead = handler.slice(handler.indexOf("await file.text()"));
    // The check comes after the read and before the packet is kept or sent.
    expect(afterRead.indexOf("if (picked.current !== mine) return;")).toBeGreaterThan(0);
    expect(afterRead.indexOf("if (picked.current !== mine) return;")).toBeLessThan(afterRead.indexOf("verifyEvidence.mutate("));
    // An older file's read error does not replace the newer file's state either.
    const failed = handler.slice(handler.indexOf("} catch (error) {"));
    expect(failed.indexOf("if (picked.current !== mine) return;")).toBeLessThan(failed.indexOf("setParseError("));
  });
});

describe("a developer's key", () => {
  const page = read("./DeveloperKeys.tsx");

  it("cannot be looked up while another is being ended, whose end clears the lookup", () => {
    expect(page).toContain('aria-describedby="key-lookup-hint" disabled={looking || revoke.isPending} />');
    expect(page).toContain("disabled={looking || revoke.isPending || lookup.trim().length === 0}");
  });
});

describe("the operator's lists", () => {
  const keys = read("../components/apikeys/OperatorKeys.tsx");
  const claims = read("../components/claim/OperatorClaims.tsx");

  it("read again when the same question is asked again", () => {
    expect(keys).toContain("if (asked && asked.email === next) void keys.refetch();");
    expect(claims).toContain("if (lookedUp === id) void claims.refetch();");
  });

  it("put the tier menu back on the key's tier when a change is refused", () => {
    const failed = keys.slice(keys.indexOf("onError: error => {"), keys.indexOf("const end = "));
    expect(failed).toContain("setTier(savedTier);");
  });

  it("keep a claim's buttons off until the list shows the change, so a second press does not repeat it", () => {
    expect(claims).toContain("const busy = hold.isPending || release.isPending || remove.isPending || refreshing;");
    expect(claims).toContain("refreshing={claims.isFetching}");
  });
});
