import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSuppressedLocatorHost } from "./db";
import { canonicalHost, hostIsUnder } from "./hostName";

const server = fileURLToPath(new URL(".", import.meta.url));

describe("the host as the directory stores it", () => {
  it("is lower case with every trailing dot removed, however the dot was written", () => {
    expect(canonicalHost("Api.Example")).toBe("api.example");
    expect(canonicalHost("api.example.")).toBe("api.example");
    expect(canonicalHost("api.example..")).toBe("api.example");
    // What the URL parser hands over for the escaped and the full-width spellings of the root dot.
    for (const written of ["https://api.example%2E/x", "https://api.example。/x", "https://api.example．/x", "https://API.example./x"]) {
      expect(canonicalHost(new URL(written).hostname), written).toBe("api.example");
    }
  });

  it("keeps the dots inside the name, and punycode as the parser writes it", () => {
    expect(canonicalHost("a.b.c.example.")).toBe("a.b.c.example");
    expect(canonicalHost(new URL("https://münchen.example./").hostname)).toBe("xn--mnchen-3ya.example");
  });

  it("is null for what is not a host name, whatever the URL parser lets through: punctuation copied from a sentence, an empty label, a label that starts with a hyphen", () => {
    // The real case: a feed record carried a link written in a sentence, and the host was stored as "api-dashboard.search.brave.com)."
    expect(new URL("https://api-dashboard.search.brave.com).").hostname).toBe("api-dashboard.search.brave.com).");
    expect(canonicalHost(new URL("https://api-dashboard.search.brave.com).").hostname)).toBeNull();
    for (const junk of ["api.example.com)", "(api.example.com", "api.example,com", "api example.com", "api.example.com'", "[::1", "[not an address]", "a..b.example", ".example", "-", "-a.example", "a-.example", "a$b.example", "api.example.com;"]) {
      expect(canonicalHost(junk), junk).toBeNull();
    }
  });

  it("keeps what is a host name: letters, digits, hyphens, underscores, an address of four numbers, an address in brackets, punycode", () => {
    for (const name of ["a.example", "a-b.example", "a_b.example", "_dmarc.example", "1.2.3.4", "[::1]", "[2001:db8::7]", "xn--mnchen-3ya.example", "localhost", "a1.b2.c3"]) {
      expect(canonicalHost(name), name).toBe(name);
    }
  });

  it("is null when nothing is left, or when the name is longer than the columns that hold it", () => {
    expect(canonicalHost("")).toBeNull();
    expect(canonicalHost(".")).toBeNull();
    expect(canonicalHost("...")).toBeNull();
    expect(canonicalHost(`${"a".repeat(63)}.`.repeat(4))).not.toBeNull();
    expect(canonicalHost(`${"a".repeat(255)}`)).toBe("a".repeat(255));
    expect(canonicalHost(`${"a".repeat(256)}.`)).toBeNull();
  });
});

describe("a host under a domain", () => {
  it("is the domain itself or any subdomain, in any case and with any trailing dots", () => {
    for (const host of ["agentrank.info", "api.agentrank.info", "AGENTRANK.info", "api.agentrank.info.", "api.agentrank.info..", "a.b.agentrank.info.", " api.agentrank.info "]) {
      expect(hostIsUnder(host, "agentrank.info"), host).toBe(true);
    }
  });

  it("is not a look-alike, a longer name that merely contains the domain, or nothing", () => {
    for (const host of ["notagentrank.info", "agentrank.info.evil.example", "agentrank.information", "evil.example", "info", "", null, undefined]) {
      expect(hostIsUnder(host, "agentrank.info"), String(host)).toBe(false);
    }
  });
});

describe("the operator's suppressed domain", () => {
  it("is suppressed for the domain, its subdomains and every spelling of them with trailing dots", () => {
    // The rule compared the stored host as an exact string, so a host registered as "api.agentrank.info." slipped past it and was listed.
    for (const host of ["agentrank.info", "api.agentrank.info", "api.agentrank.info.", "API.AgentRank.info..", "agentrank.info."]) {
      expect(isSuppressedLocatorHost(host), host).toBe(true);
    }
    for (const host of ["agentrank.information", "notagentrank.info", "agentrank.info.evil.example", null, undefined, ""]) {
      expect(isSuppressedLocatorHost(host), String(host)).toBe(false);
    }
  });
});

describe("every adapter that stores a locator host writes it through canonicalHost", () => {
  // A guard at the source: a new adapter, or an edit, that goes back to `.hostname.toLowerCase()` would store the root dot again. The
  // behaviour of the shared helper is held above; this holds that each place that stores a host uses it.
  const writers = ["ingestion/erc8004Chain.ts", "ingestion/robinhood.ts", "ingestion/saidChain.ts", "ingestion/solana8004.ts", "ingestion/metaplex.ts", "ingestion/agenstry.ts"];
  for (const file of writers) {
    it(`${file}`, () => {
      const source = readFileSync(join(server, file), "utf8");
      expect(source).toContain("canonicalHost(");
      expect(source).not.toContain(").hostname.toLowerCase()");
    });
  }
});
