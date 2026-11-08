import { describe, expect, it } from "vitest";
import { partyHostOf } from "./partyHost";

describe("the host a catalog record's card is served from", () => {
  it("is the host of the address in lower case, without its port, credentials, path or query", () => {
    expect(partyHostOf("https://Agent.Example.COM:8443/.well-known/agent-card.json?x=1")).toBe("agent.example.com");
    expect(partyHostOf("https://user:secret@a.example/")).toBe("a.example");
    // The URL parser lowercases the host of an https address by itself and leaves the capitals of any other scheme alone, so the function folds them.
    expect(partyHostOf("a2a://Agent.Example:99/x")).toBe("agent.example");
  });

  it("is null where the address names no host", () => {
    for (const value of [null, undefined, "", "not a url", "https://", "mailto:someone@example.org"]) {
      expect(partyHostOf(value), String(value)).toBeNull();
    }
  });

  it("is null for a host longer than the column that keeps it, and not for one that fits", () => {
    expect(partyHostOf(`https://${"a".repeat(250)}.example/`)).toBeNull();
    expect(partyHostOf(`https://${"a".repeat(60)}.${"b".repeat(60)}.example/`)).toBe(`${"a".repeat(60)}.${"b".repeat(60)}.example`);
  });
});
