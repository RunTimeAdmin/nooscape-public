import { describe, expect, it } from "vitest";
import { EMPTY_REGISTRY_FLEETS, REGISTRY_FLEETS_LIMIT } from "@shared/mapFleets";
import { FLEET_MIN } from "@shared/noosphere";
import type { RegistryGroupKind, RegistryGroupRow, RegistryGroupsRead } from "./agentRegistryRows";
import { shapeRegistryFleets } from "./registryFleets";

/**
 * The pure part of the groups on an extra chain's own page (docs/chain-worlds-2026-10-20.md, "The Arc world"): how the counted
 * wallets, hosts and profile links become the formations the page draws. The counting is in registryFleets.integration.test.ts.
 */
const AT = new Date("2026-10-20T17:00:00Z");
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const group = (kind: RegistryGroupKind, key: string, count: number, over: Partial<RegistryGroupRow> = {}): RegistryGroupRow => ({ kind, key, count, host: kind === "platform_host" ? key : null, name: null, ...over });
const read = (groups: RegistryGroupRow[], over: Partial<RegistryGroupsRead> = {}): RegistryGroupsRead => ({
  groups,
  totals: {
    wallet: groups.filter(row => row.kind === "wallet").length,
    platform_host: groups.filter(row => row.kind === "platform_host").length,
    shared_link: groups.filter(row => row.kind === "shared_link").length,
  },
  recorded: 2_587,
  ...over,
});
const dirty = `  Bad${String.fromCharCode(0)} ${String.fromCharCode(0x202e)}name${String.fromCharCode(0x202c)}${String.fromCharCode(0x200b)}  `;

describe("shaping the groups of an extra chain's registry", () => {
  it("rests on the same minimum as the lights on the home map", () => {
    expect(FLEET_MIN).toBe(50);
    expect(REGISTRY_FLEETS_LIMIT).toBe(8);
  });

  it("keeps the largest groups of each kind, largest first, at most the limit of a kind, and counts them all", () => {
    const wallets = Array.from({ length: 11 }, (_, index) => group("wallet", wallet(index + 1), 60 + index));
    const shaped = shapeRegistryFleets("arc", read([...wallets, group("platform_host", "a.example", 868), group("shared_link", "ab".repeat(32), 246, { host: "b.example" })]), AT);
    const drawnWallets = shaped.fleets.filter(fleet => fleet.kind === "wallet");
    expect(drawnWallets).toHaveLength(8);
    expect(drawnWallets.map(fleet => fleet.count)).toEqual([70, 69, 68, 67, 66, 65, 64, 63]);
    expect(shaped.fleets.map(fleet => fleet.kind)).toEqual([...drawnWallets.map(() => "wallet"), "platform_host", "shared_link"]);
    expect(shaped.groups).toBe(13);
    expect(shaped.walletGroups).toBe(11);
    expect(shaped.asOf).toBe("2026-10-20T17:00:00.000Z");
  });

  it("names a wallet by its address and a host or link by its label, and gives neither the other's field", () => {
    const shaped = shapeRegistryFleets(
      "arc",
      read([group("wallet", wallet(1), 1_000), group("platform_host", "run.example.app", 868), group("shared_link", "cd".repeat(32), 246, { host: "links.example", name: "Same Name" }), group("shared_link", "ef".repeat(32), 100, { host: null, name: "Same Name" })]),
      AT
    );
    const [w, h, l1, l2] = shaped.fleets;
    expect(w).toMatchObject({ kind: "wallet", chain: "arc", name: null, wallet: wallet(1), registry: null, count: 1_000, wallets: 1 });
    expect(h).toMatchObject({ kind: "platform_host", name: "run.example.app", wallet: null, wallets: null });
    // A link is called by its host first, then by a name its members record.
    expect(l1).toMatchObject({ kind: "shared_link", name: "links.example", wallet: null });
    expect(l2).toMatchObject({ kind: "shared_link", name: "Same Name" });
  });

  it("never calls a link by the placeholder name every unnamed registration gets, and leaves it unnamed when it has nothing else", () => {
    const [placeholder, bare] = shapeRegistryFleets("arc", read([group("shared_link", "11".repeat(32), 90, { name: "Agent #1234" }), group("shared_link", "22".repeat(32), 80)]), AT).fleets;
    expect(placeholder!.name).toBeNull();
    expect(bare!.name).toBeNull();
  });

  it("gives each group an id derived from the shared fact, never the fact itself, and the same groups in the same order whatever order they are read in", () => {
    const key = "9f".repeat(32);
    const rows = [group("wallet", wallet(7), 300), group("shared_link", key, 120, { host: "x.example" }), group("platform_host", "h.example", 90), group("wallet", wallet(8), 300)];
    const forward = shapeRegistryFleets("arc", read(rows), AT).fleets;
    const reversed = shapeRegistryFleets("arc", read([...rows].reverse()), AT).fleets;
    expect(reversed.map(fleet => fleet.id)).toEqual(forward.map(fleet => fleet.id));
    for (const fleet of forward) {
      expect(fleet.id).toMatch(/^arc-fleet-[0-9a-f]{16}$/);
      expect(fleet.id).not.toContain(key.slice(0, 16));
    }
    expect(JSON.stringify(forward.filter(fleet => fleet.kind === "shared_link"))).not.toContain(key);
    expect(new Set(forward.map(fleet => fleet.id)).size).toBe(4);
  });

  it("breaks a tie by the shared fact, so equal groups never swap places", () => {
    const shaped = shapeRegistryFleets("arc", read([group("wallet", wallet(9), 100), group("wallet", wallet(2), 100), group("wallet", wallet(5), 100)]), AT);
    expect(shaped.fleets.map(fleet => fleet.wallet)).toEqual([wallet(2), wallet(5), wallet(9)]);
  });

  it("cleans a recorded name for public text, and leaves none where nothing is left of it", () => {
    const shaped = shapeRegistryFleets(
      "arc",
      read([group("shared_link", "aa".repeat(32), 90, { name: dirty }), group("shared_link", "bb".repeat(32), 80, { name: `${String.fromCharCode(7)}${String.fromCharCode(0x200b)}` }), group("shared_link", "cc".repeat(32), 70, { name: "x".repeat(300) })]),
      AT
    );
    expect(shaped.fleets[0]!.name).toBe("Bad name");
    expect(shaped.fleets[1]!.name).toBeNull();
    expect(shaped.fleets[2]!.name!.length).toBe(80);
  });

  it("carries the registrations the registry holds, read with the groups, and nothing for a count that is not one", () => {
    expect(shapeRegistryFleets("arc", read([group("wallet", wallet(1), 60)], { recorded: 2_587 }), AT).recorded).toBe(2_587);
    expect(shapeRegistryFleets("arc", read([group("wallet", wallet(1), 60)], { recorded: 0 }), AT).recorded).toBeNull();
  });

  it("answers a registry with no group at the minimum with nothing to draw, keeping the count of what it holds", () => {
    expect(shapeRegistryFleets("arc", read([], { recorded: 0 }), AT)).toEqual(EMPTY_REGISTRY_FLEETS);
    expect(shapeRegistryFleets("arc", read([]), AT)).toEqual({ ...EMPTY_REGISTRY_FLEETS, recorded: 2_587 });
  });

  it("skips an empty group", () => {
    expect(shapeRegistryFleets("arc", read([group("wallet", wallet(1), 0)]), AT).fleets).toEqual([]);
  });

  it("says nothing about any one registration: no key of a link, no field of an entry, no score", () => {
    const [fleet] = shapeRegistryFleets("arc", read([group("shared_link", "dd".repeat(32), 246, { host: "h.example" })]), AT).fleets;
    expect(Object.keys(fleet!).sort()).toEqual(["chain", "count", "id", "kind", "name", "registry", "wallet", "wallets"]);
  });
});
