import { describe, expect, it } from "vitest";
import {
  ARC_LIGHTS_LIMIT,
  arcLightsCaption,
  ARC_OVERLAP_NOTE,
  compactCount,
  EMPTY_MAP_FLEETS,
  EMPTY_ROBINHOOD_LIGHTS,
  EMPTY_SOLANA_LIGHTS,
  FLEET_KIND_LABEL,
  FLEET_NOT_PROVED,
  FLEET_OVERLAP_NOTE,
  fleetFact,
  fleetKindLabel,
  fleetNotProved,
  fleetOverlapNote,
  fleetShape,
  fleetsCaption,
  fleetTitle,
  isMapFleetKind,
  MAP_FLEET_KINDS,
  MAP_FLEETS_LIMIT,
  ROBINHOOD_LIGHT_MIN,
  ROBINHOOD_LIGHTS_LIMIT,
  ROBINHOOD_NOT_PROVED,
  ROBINHOOD_OVERLAP_NOTE,
  robinhoodLightsCaption,
  shortWallet,
  SOLANA_LIGHT_MIN,
  SOLANA_LIGHT_REGISTRIES,
  SOLANA_LIGHTS_LIMIT,
  SOLANA_NOT_PROVED,
  SOLANA_OVERLAP_NOTE,
  SOLANA_WALLET_LABEL,
  solanaLightsCaption,
  type MapFleet,
} from "@shared/mapFleets";
import { MEASURED, REGISTRIES } from "../client/src/lib/solanaRegistryReport";
import { shapeMapFleets, shapeRobinhoodLights, shapeSolanaLights } from "./mapFleets";

/** The pure parts of the BNB fleet lights: the shaping of the stored groups and the words around each light. The database read is in mapFleets.integration.test.ts. */
const row = (kind: string, clusterKey: string, memberCount: number, overrides: Partial<{ label: string | null; walletCount: number | null; computedAt: Date }> = {}) => ({
  kind,
  clusterKey,
  label: null as string | null,
  walletCount: null as number | null,
  computedAt: new Date("2026-10-16T12:00:00Z"),
  memberCount,
  ...overrides,
});
const WALLET = "0x8ce2b1348740d27d6075f602ad679a041407fdec";
const SOLANA_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("shaping the stored groups", () => {
  it("returns the largest first, at most the limit, and says how many groups there are in all", () => {
    const rows = Array.from({ length: 14 }, (_, n) => row("platform_host", `host-${n}.example.io`, 100 + n, { label: `host-${n}.example.io` }));
    const shaped = shapeMapFleets(rows, { groups: 14, registrations: 375_343 });
    expect(shaped.fleets.length).toBe(MAP_FLEETS_LIMIT);
    expect(shaped.fleets.map(fleet => fleet.count)).toEqual([113, 112, 111, 110, 109, 108, 107, 106, 105, 104]);
    expect(shaped.groups).toBe(14);
    expect(shaped.registrations).toBe(375_343);
  });

  it("breaks a tie by the shared fact, so the same groups come back in the same order whatever order they are read in", () => {
    const rows = [row("platform_host", "b.example", 60, { label: "b.example" }), row("platform_host", "a.example", 60, { label: "a.example" }), row("wallet", WALLET, 60)];
    const first = shapeMapFleets(rows, { groups: 3, registrations: null }).fleets;
    const second = shapeMapFleets([...rows].reverse(), { groups: 3, registrations: null }).fleets;
    expect(first.map(fleet => fleet.kind)).toEqual(["wallet", "platform_host", "platform_host"]);
    expect(first.map(fleet => fleet.name)).toEqual([null, "a.example", "b.example"]);
    expect(second).toEqual(first);
  });

  it("names a wallet by its address and a host or link by its label, and gives neither the other's field", () => {
    const [wallet, host, link] = shapeMapFleets(
      [row("wallet", WALLET, 300, { label: "ignored" }), row("platform_host", "metadata.evoevo.ai", 200, { label: "metadata.evoevo.ai" }), row("shared_link", "f".repeat(64), 100, { label: "Ave.ai Trading Agent" })],
      { groups: 3, registrations: null }
    ).fleets;
    expect(wallet).toMatchObject({ kind: "wallet", wallet: WALLET, name: null });
    expect(host).toMatchObject({ kind: "platform_host", name: "metadata.evoevo.ai", wallet: null });
    expect(link).toMatchObject({ kind: "shared_link", name: "Ave.ai Trading Agent", wallet: null });
  });

  it("never returns the stored key of a link or a template, only an id derived from it", () => {
    const key = "9f".repeat(32);
    const { fleets } = shapeMapFleets([row("shared_link", key, 80), row("template", "0123456789abcdef", 70, { label: "Look Alike" })], { groups: 2, registrations: null });
    for (const fleet of fleets) {
      expect(fleet.id).toMatch(/^bsc-fleet-[0-9a-f]{16}$/);
      expect(JSON.stringify(fleet)).not.toContain(key);
      expect(JSON.stringify(fleet)).not.toContain("0123456789abcdef");
    }
    expect(new Set(fleets.map(fleet => fleet.id)).size).toBe(2);
  });

  it("cleans a recorded name for public text, and leaves none where nothing is left of it", () => {
    const { fleets } = shapeMapFleets(
      [row("shared_link", "a".repeat(64), 90, { label: "  Bad\u0000 ‮name‬​  " }), row("template", "b".repeat(16), 80, { label: "\u0007​" }), row("shared_link", "c".repeat(64), 70, { label: "x".repeat(300) })],
      { groups: 3, registrations: null }
    );
    expect(fleets[0]!.name).toBe("Bad name");
    expect(fleets[1]!.name).toBeNull();
    expect(fleets[2]!.name!.length).toBe(80);
  });

  it("skips a kind it does not know, the registry summary row and an empty group, and dates the groups by the newest", () => {
    const shaped = shapeMapFleets(
      [
        row("registry", "all", 375_343),
        row("future_kind", "x", 999),
        row("wallet", WALLET, 0),
        row("wallet", "0x1111111111111111111111111111111111111111", 55, { computedAt: new Date("2026-10-16T13:00:00Z") }),
        row("platform_host", "h.example", 50, { label: "h.example", computedAt: new Date("2026-10-16T12:00:00Z") }),
      ],
      { groups: 2, registrations: 375_343 }
    );
    expect(shaped.fleets.map(fleet => fleet.kind)).toEqual(["wallet", "platform_host"]);
    expect(shaped.asOf).toBe("2026-10-16T13:00:00.000Z");
  });

  it("answers an empty read with nothing to draw", () => {
    expect(shapeMapFleets([], { groups: 0, registrations: null })).toEqual(EMPTY_MAP_FLEETS);
  });

  it("marks every BNB Chain group as BNB Chain, with no Solana registry", () => {
    const [light] = shapeMapFleets([row("wallet", WALLET, 300)], { groups: 1, registrations: null }).fleets;
    expect(light).toMatchObject({ chain: "bnb", registry: null });
  });
});

describe("shaping the Solana owner wallets", () => {
  const holding = (protocol: string, registrant: string, holdings: number) => ({ protocol, registrant, holdings });
  const READ_AT = new Date("2026-10-18T12:00:00Z");
  const W = (n: number) => `Wallet${String(n).padStart(2, "0")}`.padEnd(44, "x");

  it("keeps the wallets that hold the minimum or more in a registry that gets a light, largest first, and counts them all", () => {
    const shaped = shapeSolanaLights(
      [holding("solana_8004", W(1), 326), holding("solana_registry", W(2), 332), holding("solana_8004", W(3), 195), holding("solana_registry", W(4), SOLANA_LIGHT_MIN), holding("solana_8004", W(5), SOLANA_LIGHT_MIN - 1), holding("solana_registry", W(6), 97)],
      READ_AT
    );
    expect(shaped.fleets.map(light => light.count)).toEqual([332, 326, 195, SOLANA_LIGHT_MIN]);
    expect(shaped.fleets.map(light => light.registry)).toEqual(["metaplex", "8004", "8004", "metaplex"]);
    expect(shaped.groups).toBe(4);
    expect(shaped.asOf).toBe("2026-10-18T12:00:00.000Z");
    for (const light of shaped.fleets) expect(light).toMatchObject({ kind: "wallet", chain: "solana", name: null, wallets: null });
    expect(shaped.fleets[0]!.wallet).toBe(W(2));
  });

  it("draws at most the limit and still counts the rest", () => {
    const rows = Array.from({ length: 12 }, (_, n) => holding("solana_8004", W(n), 100 + n));
    const shaped = shapeSolanaLights(rows, READ_AT);
    expect(shaped.fleets).toHaveLength(SOLANA_LIGHTS_LIMIT);
    expect(shaped.groups).toBe(12);
    expect(shaped.fleets.map(light => light.count)).toEqual([111, 110, 109, 108, 107, 106, 105, 104]);
  });

  it("never gives a light to SAID or to any other protocol, however many entries a wallet holds", () => {
    const shaped = shapeSolanaLights([holding("solana_said", W(1), 5_000), holding("erc8004", W(2), 5_000), holding("constructor", W(3), 5_000), holding("toString", W(4), 5_000), holding("solana_8004", W(5), 100)], READ_AT);
    expect(shaped.fleets.map(light => light.wallet)).toEqual([W(5)]);
    expect(shaped.groups).toBe(1);
    expect(Object.keys(SOLANA_LIGHT_REGISTRIES)).toEqual(["solana_8004", "solana_registry"]);
  });

  it("gives one wallet a light in each registry it holds enough in, with ids of their own, and the same lights in the same order whatever order they are read in", () => {
    const rows = [holding("solana_8004", W(1), 150), holding("solana_registry", W(1), 150), holding("solana_8004", W(2), 150)];
    const first = shapeSolanaLights(rows, READ_AT).fleets;
    const second = shapeSolanaLights([...rows].reverse(), READ_AT).fleets;
    expect(first).toHaveLength(3);
    expect(new Set(first.map(light => light.id)).size).toBe(3);
    for (const light of first) expect(light.id).toMatch(/^sol-fleet-[0-9a-f]{16}$/);
    expect(second).toEqual(first);
    expect(first.map(light => `${light.registry}:${light.wallet}`)).toEqual([`8004:${W(1)}`, `8004:${W(2)}`, `metaplex:${W(1)}`]);
  });

  it("skips a row with no wallet and answers an empty read, or one with nothing large enough, with no lights at all", () => {
    expect(shapeSolanaLights([holding("solana_8004", "", 500)], READ_AT)).toEqual(EMPTY_SOLANA_LIGHTS);
    expect(shapeSolanaLights([holding("solana_8004", W(1), 99)], READ_AT)).toEqual(EMPTY_SOLANA_LIGHTS);
    expect(shapeSolanaLights([], READ_AT)).toEqual(EMPTY_SOLANA_LIGHTS);
  });

  it("rests on what the census measured on 2026-10-18: three wallets of 100 or more in each of the two registries, and one entry for every SAID wallet", () => {
    const wallets = (protocol: string) => MEASURED.q2.find(([name, bucket]) => name === protocol && bucket === "100-999")?.[2];
    expect(wallets("solana_8004")).toBe(3);
    expect(wallets("solana_registry")).toBe(3);
    // The same wallets are the six the rule draws today: the census's bucket starts where the rule's minimum does.
    expect(SOLANA_LIGHT_MIN).toBe(100);
    const said = MEASURED.q2.filter(([name]) => name === "solana_said");
    expect(said).toHaveLength(1);
    expect(said[0]!.slice(1)).toEqual(["1", 13_779, 13_779, 1]);
    // Every registry the census covers is either given a light or is SAID.
    expect(REGISTRIES.filter(protocol => !Object.hasOwn(SOLANA_LIGHT_REGISTRIES, protocol))).toEqual(["solana_said"]);
  });
});

describe("shaping the Robinhood Chain registering wallets", () => {
  const holding = (registrant: string, holdings: number) => ({ registrant, holdings });
  const READ_AT = new Date("2026-10-19T12:00:00Z");
  const W = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

  it("keeps the wallets that hold the minimum or more, largest first, and counts them all", () => {
    const shaped = shapeRobinhoodLights([holding(W(1), 5_593), holding(W(2), 1_091), holding(W(3), ROBINHOOD_LIGHT_MIN), holding(W(4), ROBINHOOD_LIGHT_MIN - 1), holding(W(5), 12)], READ_AT);
    expect(shaped.fleets.map(light => light.count)).toEqual([5_593, 1_091, ROBINHOOD_LIGHT_MIN]);
    expect(shaped.groups).toBe(3);
    expect(shaped.asOf).toBe("2026-10-19T12:00:00.000Z");
    for (const light of shaped.fleets) expect(light).toMatchObject({ kind: "wallet", chain: "robinhood", name: null, registry: null, wallets: null });
    expect(shaped.fleets[0]!.wallet).toBe(W(1));
  });

  it("carries the number of entries the directory lists, read with the wallets, and nothing for a number that cannot be one", () => {
    const rows = [holding(W(1), 5_593), holding(W(2), 1_091)];
    expect(shapeRobinhoodLights(rows, READ_AT, ROBINHOOD_LIGHTS_LIMIT, 8_882).listed).toBe(8_882);
    expect(shapeRobinhoodLights(rows, READ_AT).listed).toBeNull();
    expect(shapeRobinhoodLights(rows, READ_AT, ROBINHOOD_LIGHTS_LIMIT, -1).listed).toBeNull();
    expect(shapeRobinhoodLights(rows, READ_AT, ROBINHOOD_LIGHTS_LIMIT, Number.NaN).listed).toBeNull();
    expect(shapeRobinhoodLights([], READ_AT, ROBINHOOD_LIGHTS_LIMIT, 8_882)).toEqual(EMPTY_ROBINHOOD_LIGHTS);
  });

  it("draws at most the limit and still counts the rest", () => {
    const rows = Array.from({ length: ROBINHOOD_LIGHTS_LIMIT + 3 }, (_, index) => holding(W(index + 1), 500 - index));
    const shaped = shapeRobinhoodLights(rows, READ_AT);
    expect(shaped.fleets).toHaveLength(ROBINHOOD_LIGHTS_LIMIT);
    expect(shaped.groups).toBe(ROBINHOOD_LIGHTS_LIMIT + 3);
  });

  it("gives each wallet an id derived from it, never the address, and the same lights in the same order whatever order they are read in", () => {
    const rows = [holding(W(1), 300), holding(W(2), 300), holding(W(3), 150)];
    const forward = shapeRobinhoodLights(rows, READ_AT);
    const backward = shapeRobinhoodLights([...rows].reverse(), READ_AT);
    expect(backward.fleets).toEqual(forward.fleets);
    expect(new Set(forward.fleets.map(light => light.id)).size).toBe(3);
    for (const light of forward.fleets) {
      expect(light.id).toMatch(/^rh-fleet-[0-9a-f]{16}$/);
      expect(light.id).not.toContain(light.wallet!.slice(2, 12));
    }
  });

  it("skips a row with no wallet and answers an empty read, or one with nothing large enough, with no lights at all", () => {
    expect(shapeRobinhoodLights([holding("", 500)], READ_AT)).toEqual(EMPTY_ROBINHOOD_LIGHTS);
    expect(shapeRobinhoodLights([], READ_AT)).toEqual(EMPTY_ROBINHOOD_LIGHTS);
    expect(shapeRobinhoodLights([holding(W(1), ROBINHOOD_LIGHT_MIN - 1)], READ_AT)).toEqual(EMPTY_ROBINHOOD_LIGHTS);
  });

  it("is part of the empty answer, and the BNB Chain groups carry none", () => {
    expect(EMPTY_MAP_FLEETS.robinhood).toEqual(EMPTY_ROBINHOOD_LIGHTS);
    expect(shapeMapFleets([row("wallet", WALLET, 13_419)], { groups: 1, registrations: null }).robinhood).toEqual(EMPTY_ROBINHOOD_LIGHTS);
  });
});

describe("the words around a light", () => {
  const fleet = (kind: MapFleet["kind"], overrides: Partial<MapFleet> = {}): MapFleet => ({ id: "x", kind, chain: "bnb", name: null, wallet: null, registry: null, count: 126_839, wallets: null, ...overrides });
  const owner = (overrides: Partial<MapFleet> = {}): MapFleet => fleet("wallet", { chain: "solana", wallet: SOLANA_WALLET, registry: "8004", count: 326, ...overrides });

  it("knows the four kinds and no other", () => {
    expect([...MAP_FLEET_KINDS]).toEqual(["wallet", "shared_link", "platform_host", "template"]);
    expect(isMapFleetKind("template")).toBe(true);
    expect(isMapFleetKind("registry")).toBe(false);
    expect(isMapFleetKind(7)).toBe(false);
  });

  it("titles each light by its shared fact", () => {
    expect(fleetTitle(fleet("wallet", { wallet: WALLET }))).toBe("Wallet 0x8ce2…fdec");
    expect(fleetTitle(fleet("wallet"))).toBe("One registering wallet");
    expect(fleetTitle(fleet("shared_link", { name: "Ave.ai Trading Agent" }))).toBe("Ave.ai Trading Agent");
    expect(fleetTitle(fleet("shared_link"))).toBe("One profile link without a host");
    expect(fleetTitle(fleet("platform_host", { name: "metadata.evoevo.ai" }))).toBe("metadata.evoevo.ai");
    expect(fleetTitle(fleet("template", { name: "CryptoMaster Agent #2" }))).toBe("CryptoMaster Agent #2 (and look-alikes)");
  });

  it("states the count with the fact, and nothing else about the registrations", () => {
    expect(fleetFact(fleet("wallet"))).toBe("126,839 registrations on BNB Chain name the same registering wallet.");
    expect(fleetFact(fleet("shared_link"))).toBe("126,839 registrations on BNB Chain record exactly the same profile link.");
    expect(fleetFact(fleet("platform_host", { name: "metadata.evoevo.ai" }))).toBe("126,839 registrations on BNB Chain point their profile link at metadata.evoevo.ai.");
    expect(fleetFact(fleet("template", { count: 300 }))).toBe("300 registrations on BNB Chain the directory lists have the same name, description and endpoint host, digits aside.");
  });

  it("says what the shared fact does not show, for every kind, and never grades", () => {
    for (const kind of MAP_FLEET_KINDS) {
      expect(FLEET_NOT_PROVED[kind]).toMatch(/does not say|does not show/);
      expect(FLEET_NOT_PROVED[kind]).toMatch(/whether any of them works/);
    }
    const everything = [
      ...Object.values(FLEET_NOT_PROVED),
      ...Object.values(FLEET_KIND_LABEL),
      FLEET_OVERLAP_NOTE,
      ...MAP_FLEET_KINDS.map(kind => fleetFact(fleet(kind))),
      SOLANA_NOT_PROVED,
      SOLANA_WALLET_LABEL,
      SOLANA_OVERLAP_NOTE,
      fleetFact(owner()),
      fleetFact(owner({ registry: "metaplex" })),
      solanaLightsCaption({ fleets: [owner()], groups: 6 })!,
    ].join(" ");
    expect(everything).not.toMatch(/scam|fraud|fake|spam|bot farm|sybil|malicious|suspicious|junk|trust|score|rank/i);
    expect(everything).not.toMatch(/[–—]/);
  });

  it("words a Solana light as the owner wallet a registry records today, never as who registered or runs anything", () => {
    expect(fleetKindLabel(owner())).toBe("Same owner wallet");
    expect(fleetKindLabel(fleet("wallet"))).toBe("Same registering wallet");
    expect(fleetFact(owner())).toBe("326 registrations in the 8004 registry on Solana record the same owner wallet today.");
    expect(fleetFact(owner({ registry: "metaplex", count: 332 }))).toBe("332 registrations in the Metaplex agent registry on Solana record the same owner wallet today.");
    expect(fleetNotProved(owner())).toBe(SOLANA_NOT_PROVED);
    expect(SOLANA_NOT_PROVED).toMatch(/can be transferred/);
    expect(SOLANA_NOT_PROVED).toMatch(/does not say who registered them/);
    expect(SOLANA_NOT_PROVED).toMatch(/whether any of them works/);
    expect(fleetNotProved(fleet("wallet"))).toBe(FLEET_NOT_PROVED.wallet);
    expect(fleetOverlapNote(owner())).toBe(SOLANA_OVERLAP_NOTE);
    expect(fleetOverlapNote(fleet("wallet"))).toBe(FLEET_OVERLAP_NOTE);
    expect(fleetTitle(owner())).toBe("Wallet 7xKXtg…gAsU");
  });

  it("captions the Solana lights with how many are drawn of how many there are, and says why SAID has none", () => {
    const caption = solanaLightsCaption({ fleets: [owner(), owner({ registry: "metaplex" })], groups: 6 })!;
    expect(caption).toContain("100 or more registrations");
    expect(caption).toContain("2 of 6 wallets");
    expect(caption).toContain("Each diamond is one wallet in one registry, not one agent.");
    expect(caption).toContain("SAID has none: each SAID identity has a wallet of its own.");
    expect(solanaLightsCaption({ fleets: [owner()], groups: 0 })).toContain("1 of 1 wallet,");
    expect(solanaLightsCaption(EMPTY_SOLANA_LIGHTS)).toBeNull();
  });

  it("words a Robinhood Chain light as the registering wallet, never as who holds or runs anything", () => {
    const registering = (overrides: Partial<MapFleet> = {}): MapFleet => fleet("wallet", { chain: "robinhood", wallet: WALLET, count: 5_593, ...overrides });
    expect(fleetShape(registering())).toBe("hexagon");
    expect(fleetShape(owner())).toBe("diamond");
    expect(fleetShape(fleet("wallet"))).toBe("circle");
    expect(fleetShape(undefined)).toBe("circle");
    expect(fleetKindLabel(registering())).toBe("Same registering wallet");
    expect(fleetFact(registering())).toBe("5,593 registrations on Robinhood Chain name the same registering wallet.");
    expect(fleetNotProved(registering())).toBe(ROBINHOOD_NOT_PROVED);
    expect(ROBINHOOD_NOT_PROVED).toMatch(/hand them to other people/);
    expect(ROBINHOOD_NOT_PROVED).toMatch(/does not say who holds them now, who runs the agents, or whether any of them works/);
    expect(ROBINHOOD_NOT_PROVED).not.toMatch(/scam|fraud|fake|spam|sybil|malicious|suspicious|score|rank|trust|safe|verified/i);
    expect(fleetOverlapNote(registering())).toBe(ROBINHOOD_OVERLAP_NOTE);
    expect(fleetTitle(registering())).toBe("Wallet 0x8ce2…fdec");
  });

  it("captions the Robinhood Chain lights with how many are drawn of how many there are", () => {
    const registering = (): MapFleet => fleet("wallet", { chain: "robinhood", wallet: WALLET, count: 5_593 });
    const caption = robinhoodLightsCaption({ fleets: [registering(), registering()], groups: 5 })!;
    expect(caption).toContain("Large hexagons are Robinhood Chain registering wallets");
    expect(caption).toContain("100 or more registrations");
    expect(caption).toContain("2 of 5 wallets");
    expect(caption).toContain("Each hexagon is one wallet, not one agent. No individual registration is drawn.");
    expect(robinhoodLightsCaption({ fleets: [registering()], groups: 0 })).toContain("1 of 1 wallet,");
    expect(robinhoodLightsCaption(EMPTY_ROBINHOOD_LIGHTS)).toBeNull();
  });

  it("words an Arc group as a formation on the Arc page, with the facts BNB Chain's groups state", () => {
    const arc = (kind: MapFleet["kind"], overrides: Partial<MapFleet> = {}): MapFleet => fleet(kind, { chain: "arc", count: 868, ...overrides });
    expect(fleetShape(arc("wallet"))).toBe("dome");
    expect(fleetKindLabel(arc("wallet"))).toBe("Same registering wallet");
    expect(fleetFact(arc("wallet"))).toBe("868 registrations on Arc name the same registering wallet.");
    expect(fleetFact(arc("shared_link"))).toBe("868 registrations on Arc record exactly the same profile link.");
    expect(fleetFact(arc("platform_host", { name: "run.example.app" }))).toBe("868 registrations on Arc point their profile link at run.example.app.");
    expect(fleetFact(arc("platform_host"))).toBe("868 registrations on Arc point their profile link at the same host.");
    expect(fleetNotProved(arc("wallet"))).toBe(FLEET_NOT_PROVED.wallet);
    expect(fleetOverlapNote(arc("wallet"))).toBe(ARC_OVERLAP_NOTE);
    // An Arc group is a formation on a page and not a light on the map, so its note does not call it one.
    expect(ARC_OVERLAP_NOTE).not.toMatch(/light/i);
    expect(fleetTitle(arc("wallet", { wallet: WALLET }))).toBe("Wallet 0x8ce2…fdec");
    const words = [ARC_OVERLAP_NOTE, ...MAP_FLEET_KINDS.map(kind => fleetFact(arc(kind)))].join(" ");
    expect(words).not.toMatch(/scam|fraud|fake|spam|bot farm|sybil|malicious|suspicious|junk|trust|score|rank|verified|safe/i);
    expect(words).not.toMatch(/[–—]/);
    // The shapes of the four chains are four, so a group is never told from another by colour alone.
    expect(new Set([fleetShape(arc("wallet")), fleetShape(owner()), fleetShape(fleet("wallet", { chain: "robinhood" })), fleetShape(fleet("wallet"))]).size).toBe(4);
  });

  it("words a Base group as a formation on the Base page, with the facts Arc's groups state, and draws it as a cross", () => {
    const base = (kind: MapFleet["kind"], overrides: Partial<MapFleet> = {}): MapFleet => fleet(kind, { chain: "base", count: 286_832, ...overrides });
    expect(fleetShape(base("platform_host"))).toBe("cross");
    expect(fleetKindLabel(base("platform_host"))).toBe("Same host");
    expect(fleetFact(base("wallet"))).toBe("286,832 registrations on Base name the same registering wallet.");
    expect(fleetFact(base("shared_link"))).toBe("286,832 registrations on Base record exactly the same profile link.");
    expect(fleetFact(base("platform_host", { name: "run.example.app" }))).toBe("286,832 registrations on Base point their profile link at run.example.app.");
    expect(fleetFact(base("platform_host"))).toBe("286,832 registrations on Base point their profile link at the same host.");
    expect(fleetNotProved(base("platform_host"))).toBe(FLEET_NOT_PROVED.platform_host);
    // Like an Arc group, a Base group is a formation on a page and not a light on the map, so it shares Arc's note.
    expect(fleetOverlapNote(base("wallet"))).toBe(ARC_OVERLAP_NOTE);
    const words = MAP_FLEET_KINDS.map(kind => fleetFact(base(kind))).join(" ");
    expect(words).not.toMatch(/scam|fraud|fake|spam|bot farm|sybil|malicious|suspicious|junk|trust|score|rank|verified|safe/i);
    expect(words).not.toMatch(/[–—]/);
    // The shapes of the five chains are five, so a group is never told from another by colour alone.
    const shapes = [base("wallet"), fleet("wallet", { chain: "arc" }), owner(), fleet("wallet", { chain: "robinhood" }), fleet("wallet")].map(fleetShape);
    expect(new Set(shapes).size).toBe(5);
  });

  it("captions the Arc lights with how many are drawn of how many groups there are, and says what a dome is", () => {
    expect(ARC_LIGHTS_LIMIT).toBe(8);
    expect(arcLightsCaption({ groups: 11 }, 8)).toBe(
      "Large domes are Arc groups of registrations that share one wallet, host or profile link, 50 or more registrations each: 8 of 11 groups, as the registry held them at its last read. Each dome is one group, not one agent. No individual Arc registration is drawn."
    );
    expect(arcLightsCaption({ groups: 0 }, 1)).toContain("1 of 1 group,");
    expect(arcLightsCaption({ groups: 3 }, 0)).toBeNull();
    const words = arcLightsCaption({ groups: 11 }, 8)!;
    expect(words).not.toMatch(/scam|fraud|fake|spam|bot farm|sybil|malicious|suspicious|junk|trust|score|rank|verified|safe/i);
    expect(words).not.toMatch(/[–—]/);
  });

  it("shortens a wallet and a count", () => {
    expect(shortWallet(WALLET)).toBe("0x8ce2…fdec");
    expect(shortWallet("0x12")).toBe("0x12");
    expect([300, 999, 1_000, 9_684, 126_839, 999_999, 1_250_000].map(compactCount)).toEqual(["300", "999", "1.0k", "9.6k", "126.8k", "999.9k", "1.2M"]);
  });

  it("captions the lights with how many are drawn of how many there are, and says no registration is drawn", () => {
    const caption = fleetsCaption({ fleets: [fleet("wallet"), fleet("platform_host")], groups: 226, registrations: 375_343 })!;
    expect(caption).toContain("2 of 226 groups");
    expect(caption).toContain("375,343 registrations");
    expect(caption).toContain("Each circle is one group, not one agent.");
    expect(caption).toContain("No individual BNB Chain registration is drawn.");
    expect(fleetsCaption({ fleets: [], groups: 0, registrations: null })).toBeNull();
    expect(fleetsCaption({ fleets: [fleet("wallet")], groups: 0, registrations: null })).toContain("1 of 1 group");
  });
});
