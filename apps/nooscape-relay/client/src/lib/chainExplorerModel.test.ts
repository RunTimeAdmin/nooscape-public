import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildWorldEntities,
  filterWorldEntities,
  isChainWorld,
  normalizeEvmEvents,
  normalizeSolanaEvents,
  worldCrew,
  worldEntityLabel,
  CHAIN_GROUP_REPORT,
  CHAIN_IDENTITY_PROTOCOLS,
  CHAIN_SHOWS_ACKNOWLEDGED,
  CHAIN_WORLDS,
  ENTRY_EVENT_WORLDS,
  formatObserved,
  registrationShare,
  undrawnRegistryNote,
  WORLD_ARRANGEMENT,
  worldProtocolLabel,
  worldsOn,
  worldZones,
  type ChainWorldEntity,
} from "./chainExplorerModel";
import type { MapFleet } from "@shared/mapFleets";

const record = (id: string, protocols = '["erc8004"]') => ({
  agentId: id,
  displayName: id,
  protocols,
  primaryCapability: "Research",
  evidenceTier: "tier_2",
  sourceCount: 1,
  lastObservedAt: "2026-10-19T10:00:00Z",
});
const evm = {
  entryId: "entry",
  displayName: "Registry identity",
  kind: "secondary" as const,
  blockNumber: 123,
  logIndex: 2,
  transactionHash: "0x123",
  fromAddress: "0xfrom",
  toAddress: "0xto",
  isHandout: true,
};
const entity = (id: string): ChainWorldEntity => ({
  id,
  name: id,
  protocol: "erc8004",
  kind: "acknowledged",
  detail: "Not reviewed",
  evidenceTier: null,
  sourceCount: null,
  observedAt: null,
  count: null,
  fleet: null,
});

describe("chain world evidence model", () => {
  it("accepts only supported exact chain keys", () => {
    expect(["robinhood", "solana", "bnb"].every(isChainWorld)).toBe(true);
    expect(["ethereum", "BNB", "bnb/", "constructor"].some(isChainWorld)).toBe(
      false
    );
  });
  it("does not create substitute agents when the source reads are empty", () => {
    expect(buildWorldEntities("bnb", [], [])).toEqual([]);
    expect(normalizeEvmEvents([])).toEqual([]);
    expect(normalizeSolanaEvents([])).toEqual([]);
  });
  it("includes a multi-chain public record only in its explicitly mapped chains", () => {
    const records = [
      record("multi", '["solana_said","erc8004_bsc"]'),
      record("web", '["a2a"]'),
    ];
    expect(buildWorldEntities("bnb", records, []).map(row => row.id)).toEqual([
      "multi",
    ]);
    expect(
      buildWorldEntities("solana", records, []).map(row => row.id)
    ).toEqual(["multi"]);
    expect(buildWorldEntities("robinhood", records, [])).toEqual([]);
  });
  it("keeps reputation and settlement ledgers out of the identity character field", () => {
    const records = [
      record("settlement-only", '["usdg_settlement"]'),
      record("reputation-only", '["erc8004_reputation"]'),
    ];
    expect(buildWorldEntities("robinhood", records, [])).toEqual([]);
    expect(
      buildWorldEntities(
        "robinhood",
        [],
        [],
        [
          {
            id: "settlement-entry",
            displayName: "Settlement",
            protocol: "usdg_settlement",
            locatorHost: null,
          },
        ]
      )
    ).toEqual([]);
  });
  it("retains exact recorded addresses, transaction and height, without inventing time", () => {
    const [event] = normalizeEvmEvents([evm]);
    expect(event).toMatchObject({
      kind: "transfer",
      label: "Registration hand-out",
      height: 123,
      from: "0xfrom",
      to: "0xto",
      transaction: "0x123",
      observedAt: null,
    });
    expect(event?.id).toBe("erc8004:0x123:2");
  });
  it("scopes event IDs to a chain protocol and orders by recorded block/log", () => {
    const rows = normalizeEvmEvents(
      [evm, { ...evm, blockNumber: 121, logIndex: 4, kind: "mint" }],
      "erc8004_bsc"
    );
    expect(rows[0]?.kind).toBe("register");
    expect(rows[0]?.protocol).toBe("erc8004_bsc");
    expect(rows[1]?.id).not.toBe(normalizeEvmEvents([evm])[0]?.id);
  });
  it("uses observation slots/time for Solana and excludes unknown or closed events", () => {
    const row = {
      id: "sol-event",
      entryId: "entry",
      displayName: "Sol identity",
      protocol: "solana_said",
      kind: "profile_update",
      slot: 55,
      transactionSignature: "signature",
      fromOwner: null,
      toOwner: "owner",
      recordedAt: "2026-10-19T01:02:03Z",
    };
    const rows = normalizeSolanaEvents([
      row,
      { ...row, id: "closed", kind: "asset_closed" },
      { ...row, id: "other-chain", protocol: "erc8004" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "profile",
      heightLabel: "Observation slot",
      observedAt: "2026-10-19T01:02:03.000Z",
      from: null,
    });
  });
  it("event-derived identities are acknowledged, never scored or reviewed", () => {
    const [row] = buildWorldEntities(
      "robinhood",
      [],
      normalizeEvmEvents([evm])
    );
    expect(row).toMatchObject({
      id: "entry",
      kind: "acknowledged",
      sourceCount: null,
      evidenceTier: null,
    });
    expect(worldEntityLabel(row!)).toBe("Acknowledged · not reviewed");
    expect(buildWorldEntities("solana", [], normalizeEvmEvents([evm]))).toEqual(
      []
    );
  });
  it("keeps reviewed evidence when an acknowledged event uses exactly the same ID", () => {
    const rows = buildWorldEntities(
      "robinhood",
      [record("entry")],
      normalizeEvmEvents([evm])
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("reviewed");
    expect(rows[0]?.evidenceTier).toBe("tier_2");
  });
  it("does not conflate aggregate groups with individual identities or add their counts", () => {
    const group = {
      id: "g",
      kind: "wallet" as const,
      chain: "bnb" as const,
      name: null,
      wallet: "0xowner",
      registry: null,
      count: 105,
      wallets: 1,
    };
    const [row] = buildWorldEntities("bnb", [], [], [], [group]);
    expect(row).toMatchObject({
      id: "group:g",
      kind: "group",
      count: 105,
      evidenceTier: null,
    });
    expect(worldEntityLabel(row!)).toBe("Registration group · not an agent");
    expect(buildWorldEntities("robinhood", [], [], [], [group])).toEqual([]);
  });
  it("filters only loaded records and retains protocol isolation", () => {
    const rows = [entity("owl"), { ...entity("sol"), protocol: "solana_said" }];
    expect(filterWorldEntities(rows, "OWL")).toEqual([rows[0]]);
    expect(filterWorldEntities(rows, "", "solana_said")).toEqual([rows[1]]);
    expect(filterWorldEntities(rows, "missing")).toEqual([]);
  });
  it("bounds the animated crew while keeping selected and replayed identities visible", () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      entity(String(index))
    );
    const crew = worldCrew(rows, "900", "950");
    expect(crew).toHaveLength(16);
    expect(crew.map(row => row.id)).toContain("900");
    expect(crew.map(row => row.id)).toContain("950");
    expect(worldCrew([], "missing", null)).toEqual([]);
  });
  it("does not reposition the visible crew on ordinary selection", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      entity(String(index))
    );
    expect(worldCrew(rows, "5", "8")).toEqual(rows);
  });
  it("cuts the crew to the room the stage has, and to nothing when there is none", () => {
    const rows = Array.from({ length: 30 }, (_, index) => entity(String(index)));
    expect(worldCrew(rows, null, null, 9)).toHaveLength(9);
    expect(worldCrew(rows, "25", null, 9).map(row => row.id)).toContain("25");
    expect(worldCrew(rows, null, null, 0)).toEqual([]);
  });
  it("draws BNB Chain as groups and reviewed records only, never as individual registrations", () => {
    expect(CHAIN_SHOWS_ACKNOWLEDGED).toEqual({ robinhood: true, solana: true, bnb: false, arc: true, base: false, ethereum: false });
    const group = { id: "g", kind: "platform_host" as const, chain: "bnb" as const, name: "evoevo.ai", wallet: null, registry: null, count: 7174, wallets: null };
    const bnbEntry = { id: "bnb-entry", displayName: "test", protocol: "erc8004_bsc", locatorHost: "x.example" };
    const bnbEvents = normalizeEvmEvents([{ ...evm, entryId: "bnb-entry" }], "erc8004_bsc");
    const rows = buildWorldEntities("bnb", [], bnbEvents, [bnbEntry], [group]);
    expect(rows.map(row => [row.kind, row.id])).toEqual([["group", "group:g"]]);
    // A reviewed BNB Chain record is still drawn, beside the groups.
    const reviewed = buildWorldEntities("bnb", [record("rec", '["erc8004_bsc"]')], bnbEvents, [bnbEntry], [group]);
    expect(reviewed.map(row => [row.kind, row.id])).toEqual([
      ["reviewed", "rec"],
      ["group", "group:g"],
    ]);
    // The other two chains still show the entries their feeds name.
    expect(buildWorldEntities("robinhood", [], normalizeEvmEvents([evm])).map(row => row.kind)).toEqual(["acknowledged"]);
  });
  it("puts each group on the registry it counts and keeps the light it stands for", () => {
    const wallet = (chain: "robinhood" | "solana" | "bnb", registry: "8004" | "metaplex" | null) => ({ id: `${chain}-${registry}`, kind: "wallet" as const, chain, name: null, wallet: "0xabc", registry, count: 120, wallets: null });
    expect(buildWorldEntities("robinhood", [], [], [], [wallet("robinhood", null)])[0]).toMatchObject({ protocol: "erc8004", kind: "group", count: 120 });
    expect(buildWorldEntities("solana", [], [], [], [wallet("solana", "8004")])[0]?.protocol).toBe("solana_8004");
    expect(buildWorldEntities("solana", [], [], [], [wallet("solana", "metaplex")])[0]?.protocol).toBe("solana_registry");
    expect(buildWorldEntities("bnb", [], [], [], [wallet("bnb", null)])[0]?.protocol).toBe("erc8004_bsc");
    expect(buildWorldEntities("robinhood", [], [], [], [wallet("robinhood", null)])[0]?.fleet).toMatchObject({ chain: "robinhood", wallet: "0xabc" });
    // A group only ever stands on its own chain.
    expect(buildWorldEntities("solana", [], [], [], [wallet("robinhood", null)])).toEqual([]);
  });
  it("words a recorded time in UTC, and says nothing for one that is missing or not a time", () => {
    expect(formatObserved("2026-10-09T03:27:28.000Z")).toBe("9 Oct 2026, 03:27 UTC");
    expect(formatObserved(null)).toBeNull();
    expect(formatObserved("not a time")).toBeNull();
  });
});

describe("the zones of a world", () => {
  const fleet = (id: string, chain: "robinhood" | "solana" | "bnb", kind: "wallet" | "shared_link" | "platform_host" | "template", registry: "8004" | "metaplex" | null = null, count = 150) => ({
    id,
    kind,
    chain,
    name: kind === "wallet" ? null : `${id}.example.io`,
    wallet: kind === "wallet" ? "0xabc" : null,
    registry,
    count,
    wallets: null,
  });
  const solRecord = (id: string, protocol: string) => record(id, `["${protocol}"]`);

  it("sets Robinhood Chain out as a plate of registering wallets and a plate of identities, and leaves out the one with nothing", () => {
    expect(WORLD_ARRANGEMENT).toEqual({ robinhood: "split", solana: "columns", bnb: "columns", arc: "columns", base: "columns", ethereum: "columns" });
    const both = buildWorldEntities("robinhood", [record("rec")], [], [], [fleet("w1", "robinhood", "wallet"), fleet("w2", "robinhood", "wallet", null, 5_593)]);
    const zones = worldZones("robinhood", both);
    expect(zones.map(zone => zone.id)).toEqual(["wallets", "identities"]);
    expect(zones[0]!.groups).toHaveLength(2);
    expect(zones[0]!.figures).toEqual([]);
    expect(zones[0]!.sublabel).toBe("Each recorded against 100 or more entries");
    expect(zones[1]!.figures.map(entity => entity.id)).toEqual(["rec"]);
    expect(worldZones("robinhood", buildWorldEntities("robinhood", [record("rec")], [])).map(zone => zone.id)).toEqual(["identities"]);
    expect(worldZones("robinhood", [])).toEqual([]);
  });

  it("stands Solana's groups and records in the lane of the registry each is recorded in, and says what each lane holds", () => {
    const entities = buildWorldEntities(
      "solana",
      [solRecord("m1", "solana_registry"), solRecord("m2", "solana_registry")],
      normalizeSolanaEvents([
        { id: "e1", entryId: "s8004", displayName: "Eight", protocol: "solana_8004", kind: "register", slot: 1, transactionSignature: "sig1", fromOwner: null, toOwner: "o", recordedAt: "2026-10-19T00:00:00Z" },
        { id: "e2", entryId: "said1", displayName: "Said", protocol: "solana_said", kind: "register", slot: 2, transactionSignature: "sig2", fromOwner: null, toOwner: "o", recordedAt: "2026-10-19T00:00:01Z" },
      ]),
      [],
      [fleet("g8004", "solana", "wallet", "8004", 326), fleet("gmeta", "solana", "wallet", "metaplex", 332)]
    );
    const zones = worldZones("solana", entities, [
      { protocol: "solana_said", count: 13_987 },
      { protocol: "solana_registry", count: 1_599 },
      { protocol: "solana_8004", count: 1_511 },
    ]);
    expect(zones.map(zone => zone.id)).toEqual(["solana_registry", "solana_8004", "solana_said"]);
    const byId = Object.fromEntries(zones.map(zone => [zone.id, zone]));
    expect(byId.solana_registry!.figures.map(entity => entity.id)).toEqual(["m1", "m2"]);
    expect(byId.solana_registry!.groups.map(entity => entity.id)).toEqual(["group:gmeta"]);
    expect(byId.solana_8004!.groups.map(entity => entity.id)).toEqual(["group:g8004"]);
    expect(byId.solana_8004!.figures.map(entity => entity.id)).toEqual(["s8004"]);
    expect(byId.solana_said!.groups).toEqual([]);
    expect(byId.solana_registry!.sublabel).toBe("1,599 listed");
    // SAID has no groups, and the lane says why, in the home map's own reason.
    expect(byId.solana_said!.sublabel).toBe("13,987 listed \u00B7 no groups: each identity has a wallet of its own");
    // A lane with nothing in it is left out, and a missing count leaves the lane without one.
    expect(worldZones("solana", entities.filter(entity => entity.protocol !== "solana_said")).map(zone => zone.id)).toEqual(["solana_registry", "solana_8004"]);
    expect(worldZones("solana", entities)[0]!.sublabel).toBeNull();
  });

  it("says on Solana's page that AgenC is counted and not drawn, only while the count includes it", () => {
    const counted = [{ protocol: "solana_said", count: 14_174 }, { protocol: "solana_agenc", count: 256 }];
    const note = undrawnRegistryNote("solana", counted);
    expect(note).toBe("AgenC, a fourth, is counted below but has no recorded events, so it is not drawn.");
    // The note is true only while the page draws nothing of AgenC: if it is ever added to the drawn registries, the note goes.
    expect(CHAIN_IDENTITY_PROTOCOLS.solana).not.toContain("solana_agenc");
    expect(note).not.toMatch(/scam|fraud|fake|spam|bot farm|sybil|malicious|suspicious|junk|trust|score|rank|verified|safe/i);
    expect(note).not.toMatch(/[–—]/);
    // No count, a zero count, no list, or any other chain: no sentence.
    expect(undrawnRegistryNote("solana", [{ protocol: "solana_said", count: 14_174 }])).toBeNull();
    expect(undrawnRegistryNote("solana", [{ protocol: "solana_agenc", count: 0 }])).toBeNull();
    expect(undrawnRegistryNote("solana")).toBeNull();
    expect(undrawnRegistryNote("robinhood", counted)).toBeNull();
    expect(undrawnRegistryNote("base", counted)).toBeNull();
  });

  it("stands each BNB Chain group on the platform of the shared fact it counts, in a fixed order, and never an unreviewed registration", () => {
    const groups = [
      fleet("h1", "bnb", "platform_host", null, 130_144),
      fleet("h2", "bnb", "platform_host", null, 40_983),
      fleet("l1", "bnb", "shared_link", null, 127_498),
      fleet("w1", "bnb", "wallet", null, 13_419),
    ];
    const bnbEntry = { id: "bnb-entry", displayName: "test", protocol: "erc8004_bsc", locatorHost: "x.example" };
    const zones = worldZones("bnb", buildWorldEntities("bnb", [], normalizeEvmEvents([{ ...evm, entryId: "bnb-entry" }], "erc8004_bsc"), [bnbEntry], groups));
    expect(zones.map(zone => zone.id)).toEqual(["platform_host", "shared_link", "wallet"]);
    expect(zones.map(zone => zone.label)).toEqual(["Same host", "Same profile link", "Same registering wallet"]);
    expect(zones.map(zone => zone.sublabel)).toEqual(["2 groups drawn", "1 group drawn", "1 group drawn"]);
    expect(zones.flatMap(zone => zone.figures)).toEqual([]);
    // A reviewed BNB Chain record would stand on a plate of its own.
    const withRecord = worldZones("bnb", buildWorldEntities("bnb", [record("rec", '["erc8004_bsc"]')], [], [], groups));
    expect(withRecord.at(-1)).toMatchObject({ id: "records", label: "Reviewed records", sublabel: null });
    expect(withRecord.at(-1)!.figures.map(entity => entity.id)).toEqual(["rec"]);
  });
});

describe("the share of the listed entries the registering wallets are recorded against", () => {
  const wallet = (id: string, count: number) => ({ id, kind: "wallet" as const, chain: "robinhood" as const, name: null, wallet: `0x${id.padEnd(40, "a")}`, registry: null, count, wallets: null });

  it("says how many wallets, how many entries and what whole percent, rounded down", () => {
    const share = registrationShare([wallet("b", 1_091), wallet("a", 5_593), wallet("c", 902)], 8_882)!;
    expect(share.wallets).toBe(3);
    expect(share.held).toBe(7_586);
    expect(share.listed).toBe(8_882);
    // 7,586 of 8,882 is 85.4 percent: the whole percent is 85, never 86.
    expect(share.percent).toBe(85);
    expect(share.rest).toBe(1_296);
    expect(share.segments.map(segment => segment.count)).toEqual([5_593, 1_091, 902]);
    expect(share.segments.map(segment => segment.percent)).toEqual([63, 12.3, 10.2]);
    expect(share.segments[0]).toMatchObject({ id: "a", label: "Wallet 0xaaaa\u2026aaaa" });
  });

  it("says whether the wallets drawn are all the wallets that meet the rule", () => {
    const wallets = [wallet("a", 500), wallet("b", 300)];
    expect(registrationShare(wallets, 2_000)!.complete).toBe(true);
    expect(registrationShare(wallets, 2_000, 2)!.complete).toBe(true);
    expect(registrationShare(wallets, 2_000, 1)!.complete).toBe(true);
    // More meet the rule than are drawn: what is left is not all on small wallets.
    expect(registrationShare(wallets, 2_000, 5)!.complete).toBe(false);
    expect(registrationShare(wallets, 2_000, null)!.complete).toBe(true);
  });

  it("never rounds a share up to the whole or past it", () => {
    expect(registrationShare([wallet("a", 999)], 1_000)!.percent).toBe(99);
    expect(registrationShare([wallet("a", 1_000)], 1_000)!.percent).toBe(100);
    expect(registrationShare([wallet("a", 1_000)], 1_000)!.rest).toBe(0);
  });

  it("orders wallets of the same size by id, so the same wallets are in the same order every time", () => {
    const a = registrationShare([wallet("z", 200), wallet("m", 200)], 1_000)!;
    const b = registrationShare([wallet("m", 200), wallet("z", 200)], 1_000)!;
    expect(a.segments.map(segment => segment.id)).toEqual(["m", "z"]);
    expect(b).toEqual(a);
  });

  it("says nothing when there is nothing to say, or when the reads disagree", () => {
    expect(registrationShare([], 8_882)).toBeNull();
    expect(registrationShare([wallet("a", 100)], null)).toBeNull();
    expect(registrationShare([wallet("a", 100)], undefined)).toBeNull();
    expect(registrationShare([wallet("a", 100)], 0)).toBeNull();
    expect(registrationShare([wallet("a", 100)], Number.NaN)).toBeNull();
    // More held than listed: two reads of different moments. No share over the whole.
    expect(registrationShare([wallet("a", 500), wallet("b", 600)], 1_000)).toBeNull();
  });
});

describe("the Arc world", () => {
  const arcFleet = (id: string, kind: "wallet" | "shared_link" | "platform_host", count: number, over: Partial<MapFleet> = {}): MapFleet => ({
    id,
    kind,
    chain: "arc",
    name: kind === "wallet" ? null : `${id}.example.io`,
    wallet: kind === "wallet" ? "0xabc" : null,
    registry: null,
    count,
    wallets: kind === "wallet" ? 1 : null,
    ...over,
  });
  const arcEntry = (id: string) => ({ id, displayName: `Agent #${id}`, protocol: "erc8004_arc", locatorHost: null });

  it("is on offer only while its switch is in the build's list, after the original three", () => {
    const original = ["robinhood", "solana", "bnb"];
    expect(worldsOn(undefined)).toEqual(original);
    expect(worldsOn("")).toEqual(original);
    expect(worldsOn("chain_arc")).toEqual([...original, "arc"]);
    expect(worldsOn(" Watch , CHAIN_ARC ")).toEqual([...original, "arc"]);
    // The other switches, and a name that only looks like it, give Arc no page.
    for (const features of ["chain_ethereum", "chain_arcade", "arc", "claims"]) expect(worldsOn(features), features).not.toContain("arc");
  });

  it("draws the reviewed records, a sample of the listed entries and its own groups, and nothing of another chain", () => {
    const rows = buildWorldEntities(
      "arc",
      [record("rec", '["erc8004_arc"]'), record("bnb-rec", '["erc8004_bsc"]')],
      [],
      [arcEntry("a1"), { ...arcEntry("b1"), protocol: "erc8004_bsc" }],
      [arcFleet("w", "wallet", 1000), arcFleet("elsewhere", "wallet", 60, { chain: "bnb" })]
    );
    expect(rows.map(row => [row.kind, row.id])).toEqual([
      ["reviewed", "rec"],
      ["acknowledged", "a1"],
      ["group", "group:w"],
    ]);
    expect(rows.at(-1)).toMatchObject({ protocol: "erc8004_arc", count: 1000 });
    expect(rows.at(-1)!.fleet).toMatchObject({ chain: "arc", kind: "wallet" });
    // A listed entry is acknowledged, never reviewed.
    expect(rows[1]).toMatchObject({ kind: "acknowledged", evidenceTier: null, sourceCount: null });
  });

  it("stands each group on the platform of the shared fact it counts, in a fixed order, then the entries on a plate of their own", () => {
    const groups = [arcFleet("h1", "platform_host", 868), arcFleet("l1", "shared_link", 246), arcFleet("w1", "wallet", 1000), arcFleet("w2", "wallet", 868), arcFleet("h2", "platform_host", 115)];
    const zones = worldZones("arc", buildWorldEntities("arc", [record("rec", '["erc8004_arc"]')], [], [arcEntry("a1")], groups));
    expect(zones.map(zone => zone.id)).toEqual(["wallet", "platform_host", "shared_link", "entries"]);
    expect(zones.map(zone => zone.label)).toEqual(["Same registering wallet", "Same host", "Same profile link", "Entries"]);
    expect(zones.map(zone => zone.sublabel)).toEqual(["2 groups drawn", "2 groups drawn", "1 group drawn", "Reviewed records first, then a fixed sample of the entries the directory lists"]);
    expect(zones[0]!.groups.map(entity => entity.id)).toEqual(["group:w1", "group:w2"]);
    expect(zones[3]!.figures.map(entity => entity.id)).toEqual(["rec", "a1"]);
    expect(zones.slice(0, 3).flatMap(zone => zone.figures)).toEqual([]);
    expect(zones[3]!.groups).toEqual([]);
    // A plate with nothing on it is not drawn.
    expect(worldZones("arc", buildWorldEntities("arc", [], [], [arcEntry("a1")], [])).map(zone => zone.id)).toEqual(["entries"]);
    expect(worldZones("arc", buildWorldEntities("arc", [], [], [], [arcFleet("w1", "wallet", 60)])).map(zone => zone.id)).toEqual(["wallet"]);
    expect(worldZones("arc", [])).toEqual([]);
  });

  it("has no feed of its own, as BNB Chain has none, so a recorded event is shown for the selected entry", () => {
    expect([...ENTRY_EVENT_WORLDS]).toEqual(["bnb", "arc", "base", "ethereum"]);
    const events = normalizeEvmEvents([{ ...evm, entryId: "a1" }], "erc8004_arc");
    expect(events.map(event => [event.protocol, event.id])).toEqual([["erc8004_arc", "erc8004_arc:0x123:2"]]);
  });

  it("says what share of the registrations on the chain its largest wallets are recorded against, rounded down, and whether they are all of them", () => {
    const wallets = [arcFleet("a", "wallet", 1000), arcFleet("b", "wallet", 868), arcFleet("c", "wallet", 100)];
    expect(registrationShare(wallets, 2587, 3)).toMatchObject({ listed: 2587, held: 1968, wallets: 3, complete: true, percent: 76, rest: 619 });
    // More wallets meet the rule than are drawn: the rest are not all on small wallets.
    expect(registrationShare(wallets, 2587, 9)).toMatchObject({ complete: false, percent: 76 });
    // Nothing is said for a registry that has not been counted, or one the wallets outnumber.
    expect(registrationShare(wallets, null, 3)).toBeNull();
    expect(registrationShare(wallets, 1500, 3)).toBeNull();
  });
});

describe("the Base world", () => {
  const baseFleet = (id: string, kind: "wallet" | "shared_link" | "platform_host", count: number, over: Partial<MapFleet> = {}): MapFleet => ({
    id,
    kind,
    chain: "base",
    name: kind === "wallet" ? null : `${id}.example.io`,
    wallet: kind === "wallet" ? "0xabc" : null,
    registry: null,
    count,
    wallets: kind === "wallet" ? 1 : null,
    ...over,
  });
  const baseEntry = (id: string) => ({ id, displayName: `Agent #${id}`, protocol: "erc8004_base", locatorHost: null });
  const original = ["robinhood", "solana", "bnb"];

  it("is on offer only while its own switch is in the build's list, after Arc when both are on", () => {
    expect(worldsOn("chain_base")).toEqual([...original, "base"]);
    expect(worldsOn(" Watch , CHAIN_BASE ")).toEqual([...original, "base"]);
    expect(worldsOn("chain_base,chain_arc")).toEqual([...original, "arc", "base"]);
    expect(worldsOn("chain_arc,chain_base")).toEqual([...original, "arc", "base"]);
    // The other switches, and a name that only looks like it, give Base no page.
    for (const features of [undefined, "", "chain_arc", "chain_ethereum", "chain_basement", "base", "claims"]) expect(worldsOn(features), String(features)).not.toContain("base");
  });

  it("is drawn as groups and reviewed records only, never as the entries a feed or the directory lists", () => {
    expect(CHAIN_SHOWS_ACKNOWLEDGED.base).toBe(false);
    const rows = buildWorldEntities(
      "base",
      [record("rec", '["erc8004_base"]'), record("bnb-rec", '["erc8004_bsc"]')],
      normalizeEvmEvents([{ ...evm, entryId: "ev" }], "erc8004_base"),
      [baseEntry("a1"), { ...baseEntry("b1"), protocol: "erc8004_bsc" }],
      [baseFleet("h", "platform_host", 286_832), baseFleet("elsewhere", "wallet", 60, { chain: "arc" })]
    );
    expect(rows.map(row => [row.kind, row.id])).toEqual([
      ["reviewed", "rec"],
      ["group", "group:h"],
    ]);
    expect(rows.at(-1)).toMatchObject({ protocol: "erc8004_base", count: 286_832 });
    expect(rows.at(-1)!.fleet).toMatchObject({ chain: "base", kind: "platform_host" });
  });

  it("stands each group on the platform of the shared fact it counts, the host first as on BNB Chain, and a record on a plate after them", () => {
    const groups = [baseFleet("w1", "wallet", 10_272), baseFleet("h1", "platform_host", 286_832), baseFleet("l1", "shared_link", 1_251), baseFleet("h2", "platform_host", 27_726)];
    const zones = worldZones("base", buildWorldEntities("base", [], [], [], groups));
    expect(zones.map(zone => zone.id)).toEqual(["platform_host", "shared_link", "wallet"]);
    expect(zones.map(zone => zone.label)).toEqual(["Same host", "Same profile link", "Same registering wallet"]);
    expect(zones.map(zone => zone.sublabel)).toEqual(["2 groups drawn", "1 group drawn", "1 group drawn"]);
    expect(zones[0]!.groups.map(entity => entity.id)).toEqual(["group:h1", "group:h2"]);
    expect(zones.flatMap(zone => zone.figures)).toEqual([]);
    // A reviewed record stands on a plate of its own after the platforms. An entry the directory lists never does.
    const withRecord = worldZones("base", buildWorldEntities("base", [record("rec", '["erc8004_base"]')], [], [baseEntry("a1")], groups));
    expect(withRecord.map(zone => zone.id)).toEqual(["platform_host", "shared_link", "wallet", "records"]);
    expect(withRecord.at(-1)!.figures.map(entity => entity.id)).toEqual(["rec"]);
    // A plate with nothing on it is not drawn, and a world with nothing on it is not drawn at all.
    expect(worldZones("base", buildWorldEntities("base", [], [], [], [baseFleet("w1", "wallet", 60)])).map(zone => zone.id)).toEqual(["wallet"]);
    expect(worldZones("base", [])).toEqual([]);
  });

  it("has no feed of its own, sets its plates in columns, names its registry, and links its groups to its census report", () => {
    expect(ENTRY_EVENT_WORLDS).toContain("base");
    expect(WORLD_ARRANGEMENT.base).toBe("columns");
    expect(worldProtocolLabel("erc8004_base")).toBe("ERC-8004 / Base");
    expect(CHAIN_WORLDS.base).toMatchObject({ number: "05", registry: "ERC-8004 / Base", title: "The open shore" });
    expect(CHAIN_GROUP_REPORT.base).toEqual({ href: "/field/base-registry-2026-10-21", label: "Base registry census, 21 October 2026" });
  });

  it("takes its colour from the token of Base's tab, so the page and the tab agree, and numbers the worlds one to six", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8").toLowerCase();
    expect(css).toContain(`--ns-chain-base: ${CHAIN_WORLDS.base.accent.toLowerCase()};`);
    expect(Object.values(CHAIN_WORLDS).map(world => world.number)).toEqual(["01", "02", "03", "04", "05", "06"]);
  });

  it("says no more than the census does: no word of an agent, a score or a verdict in what the page's model words", () => {
    const words = [CHAIN_WORLDS.base.title, CHAIN_WORLDS.base.subtitle, CHAIN_WORLDS.base.description, CHAIN_WORLDS.base.terrain].join(" ");
    expect(words).not.toMatch(/scam|fraud|fake|spam|bot farm|sybil|malicious|suspicious|junk|trust|score|rank|verified|safe/i);
    expect(words).not.toMatch(/[–—]/);
    expect(CHAIN_WORLDS.base.description).toContain("A group is not an agent");
    expect(CHAIN_WORLDS.base.description).toContain("Individual registrations are not drawn here");
  });
});

describe("the Ethereum world", () => {
  const ethereumFleet = (id: string, kind: "wallet" | "shared_link" | "platform_host", count: number, over: Partial<MapFleet> = {}): MapFleet => ({
    id,
    kind,
    chain: "ethereum",
    name: kind === "wallet" ? null : `${id}.example.io`,
    wallet: kind === "wallet" ? "0xabc" : null,
    registry: null,
    count,
    wallets: kind === "wallet" ? 1 : null,
    ...over,
  });
  const ethereumEntry = (id: string) => ({ id, displayName: `Agent #${id}`, protocol: "erc8004_eth", locatorHost: null });
  const original = ["robinhood", "solana", "bnb"];

  it("is on offer only while its own switch is in the build's list, last when all three extra chains are on", () => {
    expect(worldsOn("chain_ethereum")).toEqual([...original, "ethereum"]);
    expect(worldsOn(" Watch , CHAIN_ETHEREUM ")).toEqual([...original, "ethereum"]);
    expect(worldsOn("chain_ethereum,chain_base,chain_arc")).toEqual([...original, "arc", "base", "ethereum"]);
    // The other switches, and a name that only looks like it, give Ethereum no page.
    for (const features of [undefined, "", "chain_arc", "chain_base", "chain_ethereumx", "ethereum", "claims"]) expect(worldsOn(features), String(features)).not.toContain("ethereum");
  });

  it("is drawn as groups and reviewed records only, never as the entries a feed or the directory lists", () => {
    expect(CHAIN_SHOWS_ACKNOWLEDGED.ethereum).toBe(false);
    const rows = buildWorldEntities(
      "ethereum",
      [record("rec", '["erc8004_eth"]'), record("bnb-rec", '["erc8004_bsc"]')],
      normalizeEvmEvents([{ ...evm, entryId: "ev" }], "erc8004_eth"),
      [ethereumEntry("a1"), { ...ethereumEntry("b1"), protocol: "erc8004_bsc" }],
      [ethereumFleet("h", "platform_host", 10_000), ethereumFleet("elsewhere", "wallet", 60, { chain: "base" })]
    );
    expect(rows.map(row => [row.kind, row.id])).toEqual([
      ["reviewed", "rec"],
      ["group", "group:h"],
    ]);
    expect(rows.at(-1)).toMatchObject({ protocol: "erc8004_eth", count: 10_000 });
    expect(rows.at(-1)!.fleet).toMatchObject({ chain: "ethereum", kind: "platform_host" });
  });

  it("stands each group on the platform of the shared fact it counts, the host first, and a record on a plate after them", () => {
    const groups = [ethereumFleet("w1", "wallet", 9_989), ethereumFleet("h1", "platform_host", 10_000), ethereumFleet("l1", "shared_link", 120), ethereumFleet("h2", "platform_host", 2_022)];
    const zones = worldZones("ethereum", buildWorldEntities("ethereum", [], [], [], groups));
    expect(zones.map(zone => zone.id)).toEqual(["platform_host", "shared_link", "wallet"]);
    expect(zones.map(zone => zone.label)).toEqual(["Same host", "Same profile link", "Same registering wallet"]);
    expect(zones.map(zone => zone.sublabel)).toEqual(["2 groups drawn", "1 group drawn", "1 group drawn"]);
    expect(zones[0]!.groups.map(entity => entity.id)).toEqual(["group:h1", "group:h2"]);
    expect(zones.flatMap(zone => zone.figures)).toEqual([]);
    // A reviewed record stands on a plate of its own after the platforms. An entry the directory lists never does.
    const withRecord = worldZones("ethereum", buildWorldEntities("ethereum", [record("rec", '["erc8004_eth"]')], [], [ethereumEntry("a1")], groups));
    expect(withRecord.map(zone => zone.id)).toEqual(["platform_host", "shared_link", "wallet", "records"]);
    expect(withRecord.at(-1)!.figures.map(entity => entity.id)).toEqual(["rec"]);
    // A plate with nothing on it is not drawn, and a world with nothing on it is not drawn at all.
    expect(worldZones("ethereum", buildWorldEntities("ethereum", [], [], [], [ethereumFleet("w1", "wallet", 60)])).map(zone => zone.id)).toEqual(["wallet"]);
    expect(worldZones("ethereum", [])).toEqual([]);
  });

  it("has no feed of its own, sets its plates in columns, names its registry, and has no census report to link", () => {
    expect(ENTRY_EVENT_WORLDS).toContain("ethereum");
    expect(WORLD_ARRANGEMENT.ethereum).toBe("columns");
    expect(worldProtocolLabel("erc8004_eth")).toBe("ERC-8004 / Ethereum");
    expect(CHAIN_WORLDS.ethereum).toMatchObject({ number: "06", registry: "ERC-8004 / Ethereum", title: "The pale spire" });
    expect(CHAIN_GROUP_REPORT.ethereum).toBeNull();
    expect(CHAIN_IDENTITY_PROTOCOLS.ethereum).toEqual(["erc8004_eth"]);
  });

  it("takes its colour from the token of Ethereum's tab, so the page and the tab agree", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8").toLowerCase();
    expect(css).toContain(`--ns-chain-ethereum: ${CHAIN_WORLDS.ethereum.accent.toLowerCase()};`);
  });

  it("says no more than the registry does: no word of an agent, a score or a verdict in what the page's model words", () => {
    const words = [CHAIN_WORLDS.ethereum.title, CHAIN_WORLDS.ethereum.subtitle, CHAIN_WORLDS.ethereum.description, CHAIN_WORLDS.ethereum.terrain].join(" ");
    expect(words).not.toMatch(/scam|fraud|fake|spam|bot farm|sybil|malicious|suspicious|junk|trust|score|rank|verified|safe/i);
    expect(words).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
    expect(CHAIN_WORLDS.ethereum.description).toContain("A group is not an agent");
    expect(CHAIN_WORLDS.ethereum.description).toContain("Individual registrations are not drawn here");
  });
});
