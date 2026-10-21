import { describe, expect, it } from "vitest";
import { factsOf } from "./agentChecks";
import { BSC_LISTING_RULES } from "./agentRegistryRows";
import { SUPPRESSED_LOCATOR_DOMAINS } from "./db";
import {
  assignG1,
  B1_LISTING_RULES,
  B1_SUPPRESSED_DOMAINS,
  buildEntryResult,
  buildRegistry,
  classifyRegistry,
  createCuBucket,
  csvCell,
  groupByKey,
  inlineJsonText,
  isComplete,
  isSuppressedHost,
  junkFlags,
  listingCounts,
  normalizeForTemplate,
  parseRegistrationText,
  probeOutcomeOf,
  readAgentCard,
  sizeTable,
  summarize,
  templateKeyOf,
  toCsv,
  type EntryInput,
  type ProbeFacts,
  type RegistrationFacts,
} from "./bscB1";
import { BSC_IDENTITY_REGISTRY } from "./ingestion/bscChain";
import { FLEET_MIN } from "@shared/noosphere";

/** Tests for the pure part of PR-B1's measurement (docs/bsc-b1-measurement-2026-10-16.md). Nothing here uses the network. */

const registration = (agentId: string, owner: string, uri: string) => ({ agentId, owner, uri, blockNumber: 1, transactionHash: "0x", logIndex: 0 });
const WALLET = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const REGISTRY = BSC_IDENTITY_REGISTRY;

const card = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Alpha Desk",
    description: "Answers questions about invoices for small shops.",
    image: "https://alphadesk.io/logo.png",
    services: [
      { name: "A2A", endpoint: "https://alphadesk.io/.well-known/agent-card.json", version: "0.3.0" },
      { name: "twitter", endpoint: "https://x.com/alphadesk" },
      { name: "ENS", endpoint: "alpha.eth" },
    ],
    registrations: [{ agentId: 7, agentRegistry: `eip155:56:${REGISTRY}` }],
    x402Support: true,
    ...overrides,
  });

const facts = (overrides: Partial<RegistrationFacts> = {}): RegistrationFacts => {
  const parsed = parseRegistrationText(card(), "7", REGISTRY);
  if (!parsed.ok) throw new Error("fixture does not parse");
  return { ...parsed.facts, ...overrides };
};

describe("the copies of the production rules", () => {
  it("lists with the thresholds the directory uses", () => {
    expect(B1_LISTING_RULES).toEqual(BSC_LISTING_RULES);
  });

  it("skips the domains the directory never surfaces", () => {
    expect([...B1_SUPPRESSED_DOMAINS]).toEqual([...SUPPRESSED_LOCATOR_DOMAINS]);
    expect(isSuppressedHost("api.agentrank.info")).toBe(true);
    expect(isSuppressedHost("notagentrank.info")).toBe(false);
    expect(isSuppressedHost(null)).toBe(false);
  });

  it("calls a fetch result what the liveness check calls it", () => {
    const answered = { ok: true as const, url: "https://a.example", status: 404, headers: {}, body: Buffer.alloc(0), truncated: false, bodySha256: "x", address: null, tlsProtocol: null, redirects: [], latencyMs: 5 };
    const failures = (["timeout", "connection_failed", "tls_failed", "response_invalid", "unresolvable", "robots_disallowed", "robots_unavailable", "forbidden_address", "redirect_invalid", "not_https"] as const).map(reason => ({
      ok: false as const,
      reason,
      detail: "",
      url: "https://a.example",
      redirects: [],
      latencyMs: 0,
    }));
    for (const result of [answered, ...failures]) expect(probeOutcomeOf(result), "reason" in result ? result.reason : "answered").toBe(factsOf(result)?.outcome);
  });
});

describe("the registry as the listing rules see it", () => {
  it("keeps the first registration of an agent, applies link updates in order, and leaves the name and wallet alone", () => {
    const rows = buildRegistry(
      [registration("1", WALLET(1), "https://one.example/a.json"), registration("1", WALLET(2), "https://other.example/b.json"), registration("2", WALLET(2), "")],
      [
        { agentId: "1", uri: "https://one.example/b.json" },
        { agentId: "1", uri: "https://one.example/c.json" },
        { agentId: "99", uri: "https://nobody.example/x.json" },
        { agentId: "2", uri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" },
      ]
    );
    expect(rows.size).toBe(2);
    expect(rows.get("1")).toMatchObject({ owner: WALLET(1), displayName: "Agent #1", uri: "https://one.example/c.json", locatorHost: "one.example", hasLink: true });
    expect(rows.get("2")).toMatchObject({ uriKind: "ipfs", locatorHost: null, hasLink: true });
  });

  it("names a row from inline JSON at registration only", () => {
    const inline = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Inline Agent" }))}`;
    const rows = buildRegistry([registration("5", WALLET(5), inline)], [{ agentId: "5", uri: "https://moved.example/x.json" }]);
    expect(rows.get("5")?.displayName).toBe("Inline Agent");
    expect(rows.get("5")?.locatorHost).toBe("moved.example");
  });

  it("applies the rules in their order, counting every row", () => {
    const rows = buildRegistry(
      [
        registration("1", WALLET(1), "https://solo.example/1.json"), // listed
        registration("2", WALLET(2), ""), // no link
        registration("3", WALLET(3), `data:application/json,${encodeURIComponent(JSON.stringify({ name: "12345" }))}`), // numeric name
        registration("4", WALLET(4), "https://twin.example/t.json"), // shared link
        registration("5", WALLET(5), "https://twin.example/t.json"),
        ...Array.from({ length: 50 }, (_, n) => registration(`${100 + n}`, WALLET(1000 + n), `https://platform.example/${n}.json`)), // platform host
        ...Array.from({ length: 10 }, (_, n) => registration(`${200 + n}`, WALLET(9), `https://w${n}.example/p.json`)), // mass registrant
      ],
      []
    );
    const { listing } = classifyRegistry(rows);
    expect(listing.get("1")).toBe("listed");
    expect(listing.get("2")).toBe("no_link");
    expect(listing.get("3")).toBe("numeric_name");
    expect(listing.get("4")).toBe("grouped_shared_link");
    expect(listing.get("5")).toBe("grouped_shared_link");
    expect(listing.get("100")).toBe("grouped_platform_host");
    expect(listing.get("200")).toBe("grouped_mass_registrant");
    expect(listingCounts(listing)).toEqual({ recorded: 5 + 50 + 10, listed: 1, grouped: 2 + 50 + 10, withoutProfileLink: 1, numericName: 1 });
  });

  it("counts a row that is held out toward the groups of the rest", () => {
    // 49 listed-looking rows on a host and one no-link row on the same host do not reach 50: a no-link row has no host.
    const forty9 = Array.from({ length: 49 }, (_, n) => registration(`${n}`, WALLET(n), `https://edge.example/${n}.json`));
    expect(Array.from(classifyRegistry(buildRegistry(forty9, [])).listing.values()).every(state => state === "listed")).toBe(true);
    // The fiftieth, with a link of its own, makes the host a platform host for all of them.
    const fifty = [...forty9, registration("49", WALLET(49), "https://edge.example/49.json")];
    expect(Array.from(classifyRegistry(buildRegistry(fifty, [])).listing.values()).every(state => state === "grouped_platform_host")).toBe(true);
    // A numeric-name row counts toward the group of the link it now points at, so its twin is held out as shared.
    const numeric = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "777" }))}`;
    const twins = classifyRegistry(
      buildRegistry([registration("a", WALLET(1), numeric), registration("b", WALLET(2), "https://twin.example/t.json")], [{ agentId: "a", uri: "https://twin.example/t.json" }])
    ).listing;
    expect(twins.get("a")).toBe("numeric_name");
    expect(twins.get("b")).toBe("grouped_shared_link");
  });
});

describe("pacing", () => {
  it("spaces calls by their cost over the rate, with no burst", async () => {
    let clock = 0;
    const waits: number[] = [];
    const bucket = createCuBucket(75, {
      now: () => clock,
      sleep: async ms => {
        waits.push(ms);
        clock += ms;
      },
    });
    for (let call = 0; call < 4; call += 1) await bucket.take(50);
    // 50 CU at 75 CU/s is one slot every 666.67 ms: nothing at first, then each call waits for the one before it.
    expect(waits.length).toBe(3);
    expect(waits.every(wait => Math.abs(wait - 666.67) < 0.01)).toBe(true);
    expect(bucket.spent()).toBe(200);
    expect(clock / 1000).toBeGreaterThanOrEqual((200 - 50) / 75 - 0.001);
  });

  it("does not store up credit while idle", async () => {
    let clock = 0;
    const bucket = createCuBucket(100, { now: () => clock, sleep: async ms => void (clock += ms) });
    await bucket.take(100);
    clock += 60_000;
    const before = clock;
    await bucket.take(100);
    await bucket.take(100);
    expect(clock - before).toBeCloseTo(1000, 5);
  });

  it("refuses a rate that is not positive", () => {
    expect(() => createCuBucket(0)).toThrow();
  });
});

describe("reading a registration file", () => {
  it("reads the fields, keeps the agent addresses apart from profiles and non-https names, and finds the back reference", () => {
    const parsed = parseRegistrationText(card(), "7", REGISTRY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.facts).toMatchObject({
      name: "Alpha Desk",
      description: "Answers questions about invoices for small shops.",
      hasImage: true,
      typeMarker: true,
      backReference: true,
      x402: true,
      agentEndpoints: ["https://alphadesk.io/.well-known/agent-card.json"],
      a2aEndpoints: ["https://alphadesk.io/.well-known/agent-card.json"],
      socialEndpointCount: 1,
      otherEndpointCount: 1,
    });
    expect(parseRegistrationText(card(), "8", REGISTRY)).toMatchObject({ ok: true, facts: { backReference: false } });
  });

  it("reads the older `endpoints` list, drops repeats, and ignores a plain http address", () => {
    const parsed = parseRegistrationText(
      JSON.stringify({ name: "n", endpoints: [{ name: "web", endpoint: "https://a.example/x" }, { name: "api", endpoint: "https://a.example/x" }, { name: "web", endpoint: "http://plain.example/" }] }),
      "1",
      REGISTRY
    );
    expect(parsed).toMatchObject({ ok: true, facts: { agentEndpoints: ["https://a.example/x"], otherEndpointCount: 1 } });
  });

  it("refuses a link with credentials, and a social host under a neutral service name", () => {
    const parsed = parseRegistrationText(JSON.stringify({ services: [{ name: "web", endpoint: "https://user:pw@a.example/" }, { name: "web", endpoint: "https://www.github.com/me" }] }), "1", REGISTRY);
    expect(parsed).toMatchObject({ ok: true, facts: { agentEndpoints: [], otherEndpointCount: 1, socialEndpointCount: 1 } });
  });

  it("counts an address under a field the standard does not use, and does not count it as an agent endpoint", () => {
    const parsed = parseRegistrationText(
      JSON.stringify({
        name: "n",
        website: "https://site.example.io",
        external_url: "https://x.com/me",
        services: [{ name: "api", protocol: "http", url: "https://api.example.io/v1" }, { name: "web", endpoint: "https://real.example.io/a", url: "https://real.example.io/a" }],
      }),
      "1",
      REGISTRY
    );
    expect(parsed).toMatchObject({ ok: true, facts: { agentEndpoints: ["https://real.example.io/a"], altAddressCount: 2 } });
  });

  it("strips a byte order mark and says why a file is not read", () => {
    expect(parseRegistrationText(`﻿${card()}`, "7", REGISTRY).ok).toBe(true);
    expect(parseRegistrationText("<html>", "7", REGISTRY)).toEqual({ ok: false, reason: "not_json" });
    expect(parseRegistrationText("[1,2]", "7", REGISTRY)).toEqual({ ok: false, reason: "not_object" });
    expect(parseRegistrationText("null", "7", REGISTRY)).toEqual({ ok: false, reason: "not_object" });
  });

  it("decodes inline JSON in both encodings", () => {
    const json = JSON.stringify({ name: "Ünïcode ✓" });
    expect(inlineJsonText(`data:application/json,${encodeURIComponent(json)}`)).toBe(json);
    expect(inlineJsonText(`data:application/json;base64,${Buffer.from(json).toString("base64")}`)).toBe(json);
    expect(inlineJsonText("data:application/json,%E0%A4%A")).toBeNull();
    expect(inlineJsonText("https://a.example/x.json")).toBeNull();
  });

  it("is complete with a name, a description and an agent address, and not otherwise", () => {
    expect(isComplete(facts())).toBe(true);
    expect(isComplete(facts({ name: null }))).toBe(false);
    expect(isComplete(facts({ description: null }))).toBe(false);
    expect(isComplete(facts({ agentEndpoints: [] }))).toBe(false);
  });
});

describe("junk and empty", () => {
  it("flags nothing on an ordinary registration", () => {
    expect(junkFlags(facts())).toEqual([]);
  });

  it("flags stock placeholder names and descriptions", () => {
    expect(junkFlags(facts({ name: "Test Agent 2", description: "This is a test" }))).toEqual(["placeholder_name", "placeholder_description"]);
    expect(junkFlags(facts({ name: "TBD", description: "Lorem ipsum dolor sit amet" }))).toEqual(["placeholder_name", "placeholder_description"]);
    expect(junkFlags(facts({ name: "Agent", description: "Description" }))).toEqual(["placeholder_name", "placeholder_description"]);
  });

  it("flags near-empty text and a description that is only the name", () => {
    expect(junkFlags(facts({ name: "A", description: "ok" }))).toEqual(["short_name", "short_description"]);
    expect(junkFlags(facts({ name: "Vault Keeper", description: "vault   keeper!" }))).toEqual(["name_is_description"]);
  });

  it("flags an agent whose every address is an example or private one, and not one with a real address as well", () => {
    expect(junkFlags(facts({ agentEndpoints: ["https://example.com/a", "https://localhost/b"] }))).toEqual(["placeholder_endpoint"]);
    expect(junkFlags(facts({ agentEndpoints: ["https://192.168.1.4/a"] }))).toEqual(["placeholder_endpoint"]);
    expect(junkFlags(facts({ agentEndpoints: ["https://example.com/a", "https://real.example.io/b"] }))).toEqual([]);
  });
});

describe("an A2A agent card", () => {
  it("is valid with a name, a description and an address", () => {
    expect(readAgentCard(JSON.stringify({ name: "a", description: "d", url: "https://a.example/rpc" }))).toEqual({ state: "valid" });
    expect(readAgentCard(JSON.stringify({ name: "a", description: "d", supportedInterfaces: [{ url: "https://a.example/rpc" }] }))).toEqual({ state: "valid" });
  });

  it("says what is missing", () => {
    expect(readAgentCard("nope")).toEqual({ state: "invalid", reason: "not_json" });
    expect(readAgentCard("[]")).toEqual({ state: "invalid", reason: "not_object" });
    expect(readAgentCard(JSON.stringify({ description: "d", url: "https://a" }))).toEqual({ state: "invalid", reason: "no_name" });
    expect(readAgentCard(JSON.stringify({ name: "a", url: "https://a" }))).toEqual({ state: "invalid", reason: "no_description" });
    expect(readAgentCard(JSON.stringify({ name: "a", description: "d" }))).toEqual({ state: "invalid", reason: "no_address" });
  });
});

describe("templates and fleets", () => {
  it("normalizes case, digits, punctuation and width the same way", () => {
    expect(normalizeForTemplate("  Trading Bot #0042!! ")).toBe(normalizeForTemplate("trading bot #7"));
    expect(normalizeForTemplate("ＡＢＣ")).toBe("abc");
    expect(normalizeForTemplate(null)).toBe("");
  });

  it("gives two registrations of one text on one host the same key, and any difference another", () => {
    const base = templateKeyOf(facts({ name: "Bot 1", description: "Swaps tokens", agentEndpoints: ["https://a.example/x"] }));
    expect(base).toBe(templateKeyOf(facts({ name: "bot 99", description: "SWAPS tokens.", agentEndpoints: ["https://a.example/y"] })));
    expect(base).not.toBe(templateKeyOf(facts({ name: "Bot 1", description: "Swaps tokens", agentEndpoints: ["https://b.example/x"] })));
    expect(base).not.toBe(templateKeyOf(facts({ name: "Bot 1", description: "Swaps coins", agentEndpoints: ["https://a.example/x"] })));
    expect(templateKeyOf(facts({ name: null, description: null }))).toBeNull();
  });

  it("groups by key at a minimum size, largest first, and leaves out a null key", () => {
    const groups = groupByKey(
      [
        { id: "a", key: "k1" },
        { id: "b", key: "k2" },
        { id: "c", key: "k1" },
        { id: "d", key: "k1" },
        { id: "e", key: "k2" },
        { id: "f", key: null },
        { id: "g", key: "k3" },
      ],
      2
    );
    expect(groups).toEqual([
      { key: "k1", members: ["a", "c", "d"] },
      { key: "k2", members: ["b", "e"] },
    ]);
  });

  it("makes a wallet with the fleet minimum a fleet and a pair of identical templates a template, and keeps the rest independent", () => {
    const walletSize = new Map([
      [WALLET(1), FLEET_MIN],
      [WALLET(2), 3],
      [WALLET(3), 1],
      [WALLET(4), 1],
      [WALLET(5), FLEET_MIN - 1],
    ]);
    const result = assignG1(
      [
        { agentId: "a", owner: WALLET(1), templateKey: "x" },
        { agentId: "b", owner: WALLET(2), templateKey: "t" },
        { agentId: "c", owner: WALLET(3), templateKey: "t" },
        { agentId: "d", owner: WALLET(4), templateKey: "u" },
        { agentId: "e", owner: WALLET(1), templateKey: "x" },
        { agentId: "f", owner: WALLET(5), templateKey: null },
      ],
      walletSize
    );
    expect(Object.fromEntries(Array.from(result.byAgent, ([id, value]) => [id, value.kind]))).toEqual({
      a: "wallet_fleet_and_template_group",
      b: "template_group",
      c: "template_group",
      d: "independent",
      e: "wallet_fleet_and_template_group",
      f: "independent",
    });
    expect(result.walletFleets).toEqual([{ key: WALLET(1), members: ["a", "e"] }]);
    expect(result.templates.map(group => group.members)).toEqual([["b", "c"], ["a", "e"]]);
    expect(result.byAgent.get("b")).toMatchObject({ walletRegistrations: 3, templateSize: 2 });
  });

  it("tabulates group sizes against bars", () => {
    expect(sizeTable([2, 2, 5, 60], [2, 5, 50])).toEqual([
      { bar: 2, groups: 4, members: 69 },
      { bar: 5, groups: 2, members: 65 },
      { bar: 50, groups: 1, members: 60 },
    ]);
  });
});

describe("one entry's result and the counts", () => {
  const row = (agentId: string) => buildRegistry([registration(agentId, WALLET(Number(agentId)), `https://reg${agentId}.example/a.json`)], []).get(agentId)!;
  const probe = (overrides: Partial<ProbeFacts> = {}): ProbeFacts => ({ url: "https://alphadesk.io/.well-known/agent-card.json", a2a: true, outcome: "answered", status: 200, reason: "", card: { state: "valid" }, ...overrides });
  const input = (agentId: string, overrides: Partial<EntryInput> = {}): EntryInput => ({
    row: row(agentId),
    externalKey: `eip155:56:${REGISTRY}:${agentId}`,
    walletRegistrations: 1,
    walletListed: 1,
    read: { status: "ok", facts: facts() },
    g1: { kind: "independent", templateSize: 1 },
    templateKey: "k",
    hostGroupSize: 1,
    probes: [probe()],
    ...overrides,
  });

  it("passes G2 with a complete registration, no junk and an address that answers", () => {
    const result = buildEntryResult(input("1"));
    expect(result).toMatchObject({ g2: true, complete: true, junk: "", aOutcome: "answered", aStatus: 200, aSuccessClass: true, cCard: "valid", firstFailure: "" });
  });

  it("names the first thing that stops an entry, in order", () => {
    expect(buildEntryResult(input("2", { read: { status: "http:404", facts: null }, probes: null, notProbedWhy: "no_registration" })).firstFailure).toBe("registration: http:404");
    expect(buildEntryResult(input("3", { read: { status: "ok", facts: facts({ description: null }) } })).firstFailure).toBe("incomplete: no name or description");
    expect(buildEntryResult(input("4", { read: { status: "ok", facts: facts({ agentEndpoints: [], a2aEndpoints: [] }) }, probes: null, notProbedWhy: "no_agent_endpoint" })).firstFailure).toBe("incomplete: no agent endpoint");
    expect(buildEntryResult(input("5", { read: { status: "ok", facts: facts({ name: "test" }) } })).firstFailure).toBe("junk: placeholder_name");
    expect(buildEntryResult(input("6", { probes: [probe({ outcome: "no_answer", status: null, reason: "timeout", card: null })] })).firstFailure).toBe("endpoint: no_answer (timeout)");
    expect(buildEntryResult(input("7", { probes: [probe({ outcome: "skipped", status: null, reason: "robots_disallowed", card: null })] })).firstFailure).toBe("endpoint: skipped (robots_disallowed)");
  });

  it("counts any complete answer as live and keeps the 2xx or 3xx subset apart", () => {
    const notFound = buildEntryResult(input("8", { probes: [probe({ status: 404, card: null })] }));
    expect(notFound).toMatchObject({ g2: true, aOutcome: "answered", aStatus: 404, aSuccessClass: false, cCard: "invalid:http_404" });
  });

  it("does not put an entry that G1 collapsed into G2", () => {
    expect(buildEntryResult(input("9", { g1: { kind: "template_group", templateSize: 3 } })).g2).toBe(false);
    expect(buildEntryResult(input("9", { g1: { kind: "template_group", templateSize: 3 } })).firstFailure).toBe("");
  });

  it("reports the card of an address that is not an agent card as not declared", () => {
    expect(buildEntryResult(input("10", { probes: [probe({ a2a: false, card: null })] })).cCard).toBe("not_declared");
  });

  it("summarizes independents, failures and the passing set", () => {
    const entries = [
      buildEntryResult(input("1")),
      buildEntryResult(input("2", { read: { status: "fetch:timeout", facts: null }, probes: null, notProbedWhy: "no_registration" })),
      buildEntryResult(input("3", { read: { status: "ok", facts: facts({ name: "demo" }) } })),
      buildEntryResult(input("4", { probes: [probe({ outcome: "no_answer", status: null, reason: "unresolvable", card: null })] })),
      buildEntryResult(input("5", { g1: { kind: "template_group", templateSize: 2 } })),
      buildEntryResult(input("6", { g1: { kind: "wallet_fleet", templateSize: 1 } })),
    ];
    const summary = summarize(entries, { suppressedSkipped: 0, walletSizes: [1, 1, 1, 1, 1, 1], sharedHostSizes: [], sameTextSizes: [], templateSizes: [2] });
    expect(summary.g0.listed).toBe(6);
    expect(summary.g1).toMatchObject({ independent: 4, templateMembers: 1, templateGroups: 1, walletFleetMembers: 1, withoutContent: 1 });
    expect(summary.g2).toMatchObject({ independents: 4, read: 3, complete: 3, notJunk: 2, answered: 1, passed: 1, a2aCardValidOfPassed: 1 });
    expect(Object.fromEntries(summary.firstFailure.map(item => [item.label, item.count]))).toEqual({
      "registration: fetch:timeout": 1,
      "junk: placeholder_name": 1,
      "endpoint: no_answer (unresolvable)": 1,
    });
  });

  it("writes a csv a spreadsheet will not run, with one line per entry", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
    const csv = toCsv([buildEntryResult(input("1")), buildEntryResult(input("2", { read: { status: "ok", facts: facts({ name: "+SUM(A1)" }) } }))]);
    const lines = csv.trimEnd().split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]!.split(",")[0]).toBe("agentId");
    expect(lines[2]).toContain("'+SUM(A1)");
  });
});
