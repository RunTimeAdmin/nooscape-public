import { FLEET_MIN } from "./noosphere";

/**
 * The fleets and templates the home map draws as one light each: the BNB Chain groups (docs/bsc-fleet-lights-2026-10-16.md),
 * the Solana owner wallets (docs/solana-lights-2026-10-18.md) and the Robinhood Chain registering wallets
 * (docs/robinhood-lights-2026-10-19.md). Pure and shared, so the server that reads the groups and
 * the page that draws and words them agree, and none of it needs a database to test.
 *
 * A light is a shared fact with a count: a registering wallet, one profile link, one host or one registration template that
 * many registrations have in common, or, on Solana, one owner wallet a registry records. It carries no score, no rank and no
 * verdict, and it says in words what the shared fact does not show. Individual registrations are never drawn.
 */

export const MAP_FLEET_KINDS = ["wallet", "shared_link", "platform_host", "template"] as const;
export type MapFleetKind = (typeof MAP_FLEET_KINDS)[number];

/**
 * The chain a light is on: BNB Chain groups are drawn as circles, Solana owner wallets as diamonds, Robinhood Chain registering wallets as hexagons.
 * Arc's groups are drawn as domes, Base's as crosses and Ethereum's as pentagons, on the chain's own page and, while its switch is on, on the home map.
 */
type MapFleetChain = "bnb" | "solana" | "robinhood" | "arc" | "base" | "ethereum";

/** The outline of a light. Each chain has its own, so no light is told apart from another by colour alone. */
export type FleetShape = "circle" | "diamond" | "hexagon" | "dome" | "cross" | "pentagon";

/** The most BNB Chain lights the map draws. The rest are counted, not drawn. */
export const MAP_FLEETS_LIMIT = 10;

/**
 * The Solana registries that get a light, with the name each is given in words. SAID has none: every SAID identity is keyed to a
 * wallet of its own, so no SAID wallet holds more than one entry and there is nothing to group.
 */
export const SOLANA_LIGHT_REGISTRIES = {
  solana_8004: { key: "8004", label: "8004 registry" },
  solana_registry: { key: "metaplex", label: "Metaplex agent registry" },
} as const;
type SolanaLightRegistry = (typeof SOLANA_LIGHT_REGISTRIES)[keyof typeof SOLANA_LIGHT_REGISTRIES]["key"];
/** An owner wallet is drawn when a registry records it as holding at least this many registrations. */
export const SOLANA_LIGHT_MIN = 100;
/** The most Solana lights the map draws, apart from BNB Chain's ten. The rest are counted, not drawn. */
export const SOLANA_LIGHTS_LIMIT = 8;

/** A registering wallet on Robinhood Chain is drawn when the directory records it against at least this many registrations. */
export const ROBINHOOD_LIGHT_MIN = 100;
/** The most Robinhood Chain lights the map draws, apart from the other chains'. The rest are counted, not drawn. */
export const ROBINHOOD_LIGHTS_LIMIT = 8;

/** The most Arc lights the home map draws: the largest groups of the Arc page's, whatever their kind. The rest are counted, not drawn. */
export const ARC_LIGHTS_LIMIT = 8;

/** The same for Base and Ethereum, each with a constant of its own so that tuning one never moves another. Five each and not eight: with the other chains' lights the map is already full at the width of a phone (docs/base-ethereum-lights-2026-10-28.md). */
export const BASE_LIGHTS_LIMIT = 5;
export const ETHEREUM_LIGHTS_LIMIT = 5;

export type MapFleet = {
  /** A stable id for the light, derived from the shared fact. It is not the fact itself. */
  id: string;
  kind: MapFleetKind;
  chain: MapFleetChain;
  /** A host, or the name the registrations record, cleaned for public text. Null for a wallet and for a link with neither. */
  name: string | null;
  /** The registering wallet (BNB Chain, Robinhood Chain) or the owner wallet the registry records (Solana), for a wallet light only. A chain fact, never a verified operator. */
  wallet: string | null;
  /** The Solana registry a light counts, null on BNB Chain. */
  registry: SolanaLightRegistry | null;
  /** Registrations that share the fact. */
  count: number;
  /** How many registering wallets they come from, where it was counted. */
  wallets: number | null;
};

export type SolanaLights = {
  /** The largest owner wallets, largest first, at most {@link SOLANA_LIGHTS_LIMIT}. */
  fleets: MapFleet[];
  /** How many owner wallets hold at least {@link SOLANA_LIGHT_MIN} registrations in one registry, drawn or not. */
  groups: number;
  /** When the directory was read for them (ISO 8601), or null. */
  asOf: string | null;
};

export type RobinhoodLights = {
  /** The largest registering wallets, largest first, at most {@link ROBINHOOD_LIGHTS_LIMIT}. */
  fleets: MapFleet[];
  /** How many registering wallets the directory records against at least {@link ROBINHOOD_LIGHT_MIN} registrations, drawn or not. */
  groups: number;
  /** When the directory was read for them (ISO 8601), or null. */
  asOf: string | null;
  /** How many Robinhood Chain entries the directory lists, counted in the same read as the wallets, so a share of them is one figure from one moment. Null when there is none. */
  listed: number | null;
};

export type MapFleets = {
  /** The largest BNB Chain groups, largest first, at most {@link MAP_FLEETS_LIMIT}. */
  fleets: MapFleet[];
  /** How many groups of these kinds are stored in all, drawn or not. */
  groups: number;
  /** The registrations the registry held when the groups were last counted, or null. */
  registrations: number | null;
  /** When the groups were last counted (ISO 8601), or null. */
  asOf: string | null;
  /** The Solana owner wallets. A separate field, so a page loaded before it was added reads exactly the BNB Chain lights it did. */
  solana: SolanaLights;
  /** The Robinhood Chain registering wallets. A separate field for the same reason. */
  robinhood: RobinhoodLights;
};

/**
 * The groups of registrations an extra chain's own page draws (Arc, Base and Ethereum): the registering wallets, hosts and profile links that
 * {@link FLEET_MIN} or more registrations share, counted over every registration the registry holds, listed or not. Read from the
 * registry rows, so it needs no table of its own, and it carries a shared fact and a count and nothing about any one registration.
 */
export type RegistryFleets = {
  /** The largest groups of each kind, largest first within a kind, at most {@link REGISTRY_FLEETS_LIMIT} of a kind. */
  fleets: MapFleet[];
  /** How many groups meet the rule, drawn or not. */
  groups: number;
  /** How many registering wallets meet the rule, drawn or not, so a share of the registrations can say whether the wallets drawn are all of them. */
  walletGroups: number;
  /** The registrations the registry holds, counted in the same read as the groups (so a share of them is one figure from one moment). Null when there is none. */
  recorded: number | null;
  /** When the registry was read for them (ISO 8601), or null. */
  asOf: string | null;
};

/** The most groups of one kind an extra chain's page draws. The rest are counted, not drawn. */
export const REGISTRY_FLEETS_LIMIT = 8;

export const EMPTY_REGISTRY_FLEETS: RegistryFleets = { fleets: [], groups: 0, walletGroups: 0, recorded: null, asOf: null };

export const EMPTY_SOLANA_LIGHTS: SolanaLights = { fleets: [], groups: 0, asOf: null };
export const EMPTY_ROBINHOOD_LIGHTS: RobinhoodLights = { fleets: [], groups: 0, asOf: null, listed: null };

/** What the read answers when there is nothing to draw: the table is not there, the source is not approved, or the read failed. */
export const EMPTY_MAP_FLEETS: MapFleets = { fleets: [], groups: 0, registrations: null, asOf: null, solana: EMPTY_SOLANA_LIGHTS, robinhood: EMPTY_ROBINHOOD_LIGHTS };

export const isMapFleetKind = (value: unknown): value is MapFleetKind => typeof value === "string" && (MAP_FLEET_KINDS as readonly string[]).includes(value);

/** A wallet as the page shows it: the first six and the last four characters. */
export const shortWallet = (wallet: string): string => (wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet);

/** A count for the label under a light: 126,839 is 126.8k, 9,684 is 9.6k, 300 stays 300. */
export function compactCount(count: number): string {
  if (count < 1_000) return String(count);
  // Cut, not rounded, so a label never claims more than the count.
  if (count < 1_000_000) return `${(Math.floor(count / 100) / 10).toFixed(1)}k`;
  return `${(Math.floor(count / 100_000) / 10).toFixed(1)}M`;
}

/** What the light is called: the host or recorded name, or the plainest description of the shared fact. */
export function fleetTitle(fleet: Pick<MapFleet, "kind" | "name" | "wallet">): string {
  switch (fleet.kind) {
    case "wallet":
      return fleet.wallet ? `Wallet ${shortWallet(fleet.wallet)}` : "One registering wallet";
    case "shared_link":
      return fleet.name ?? "One profile link without a host";
    case "platform_host":
      return fleet.name ?? "One host";
    case "template":
      return fleet.name ? `${fleet.name} (and look-alikes)` : "One registration template";
  }
}

/** The kind in words, for the key and the card's eyebrow. */
export const FLEET_KIND_LABEL: Record<MapFleetKind, string> = {
  wallet: "Same registering wallet",
  shared_link: "Same profile link",
  platform_host: "Same host",
  template: "Same registration template",
};

/** A Solana light's kind in words: the wallet is the owner the registry records today, not necessarily the one that registered. */
export const SOLANA_WALLET_LABEL = "Same owner wallet";

/** The outline a light is drawn with: a circle for BNB Chain, a diamond for Solana, a hexagon for Robinhood Chain, a dome for Arc, a cross for Base, a pentagon for Ethereum. */
export const fleetShape = (fleet: Pick<MapFleet, "chain"> | undefined): FleetShape =>
  fleet?.chain === "solana" ? "diamond" : fleet?.chain === "robinhood" ? "hexagon" : fleet?.chain === "arc" ? "dome" : fleet?.chain === "base" ? "cross" : fleet?.chain === "ethereum" ? "pentagon" : "circle";

/** The kind of a light in words, whichever chain it is on. */
export const fleetKindLabel = (fleet: Pick<MapFleet, "kind" | "chain">): string => (fleet.chain === "solana" ? SOLANA_WALLET_LABEL : FLEET_KIND_LABEL[fleet.kind]);

/** The registry a Solana light counts, in words. */
export const solanaRegistryLabel = (registry: SolanaLightRegistry | null): string => Object.values(SOLANA_LIGHT_REGISTRIES).find(entry => entry.key === registry)?.label ?? "registry";

const grouped = (count: number) => count.toLocaleString("en-US");

/** The shared fact, stated with its count and nothing else. */
export function fleetFact(fleet: Pick<MapFleet, "kind" | "chain" | "registry" | "name" | "count">): string {
  const count = grouped(fleet.count);
  if (fleet.chain === "robinhood") return `${count} registrations on Robinhood Chain name the same registering wallet.`;
  if (fleet.chain === "solana") return `${count} registrations in the ${solanaRegistryLabel(fleet.registry)} on Solana record the same owner wallet today.`;
  const place = fleet.chain === "arc" ? "Arc" : fleet.chain === "base" ? "Base" : fleet.chain === "ethereum" ? "Ethereum" : "BNB Chain";
  switch (fleet.kind) {
    case "wallet":
      return `${count} registrations on ${place} name the same registering wallet.`;
    case "shared_link":
      return `${count} registrations on ${place} record exactly the same profile link.`;
    case "platform_host":
      return `${count} registrations on ${place} point their profile link at ${fleet.name ?? "the same host"}.`;
    case "template":
      return `${count} registrations on ${place} the directory lists have the same name, description and endpoint host, digits aside.`;
  }
}

/** What the shared fact does not show. Said on the card beside the fact, whatever the kind. */
export const FLEET_NOT_PROVED: Record<MapFleetKind, string> = {
  wallet: "A registering wallet is the address that sent the registrations. It does not say who runs the agents, who holds them now, or whether any of them works.",
  shared_link: "Many registrations can record one link because a platform or a tool made them. It does not say who runs them or whether any of them works.",
  platform_host: "A host can serve many unrelated people. Pointing at one host does not say who runs the agents or whether any of them works.",
  template: "Look-alike registrations can come from one operator or from a template many people used. It does not say which, or whether any of them works.",
};

/** What an owner wallet on Solana does not show: the registry records who holds a registration today, and a holder can change. */
export const SOLANA_NOT_PROVED = "An owner wallet is the address the registry records as holding the registrations today. A registration can be transferred, so it does not say who registered them, who runs the agents, or whether any of them works.";

/** What a registering wallet on Robinhood Chain does not show: a platform can register many identities and hand them to other people. */
export const ROBINHOOD_NOT_PROVED = "A registering wallet is the address that registered these identities. A platform can register many and hand them to other people, so it does not say who holds them now, who runs the agents, or whether any of them works.";

/** What the shared fact does not show, for this light. */
export const fleetNotProved = (fleet: Pick<MapFleet, "kind" | "chain">): string =>
  fleet.chain === "robinhood" ? ROBINHOOD_NOT_PROVED : fleet.chain === "solana" ? SOLANA_NOT_PROVED : FLEET_NOT_PROVED[fleet.kind];

/** The two things every light's card adds: the groups are counted apart, and they overlap. */
export const FLEET_OVERLAP_NOTE = "Lights are counted one by one and can overlap: a registration can share a wallet with one light and a host with another.";

/** The same for a Solana light: it counts one registry, so a wallet that holds registrations in both has a light for each. */
export const SOLANA_OVERLAP_NOTE = "Each light counts one registry, so a wallet that holds registrations in both the 8004 and the Metaplex registry has a light for each.";

/** The same for a Robinhood Chain light: a registration has one registering wallet, so it is counted in at most one light. */
export const ROBINHOOD_OVERLAP_NOTE = "Each light is one registering wallet, so a registration is counted in at most one light.";

/** The same for an Arc, Base or Ethereum group, which is a formation on the chain's own page and not a light. */
export const ARC_OVERLAP_NOTE = "Groups are counted one by one and can overlap: a registration can share a wallet with one group and a host with another.";

export const fleetOverlapNote = (fleet: Pick<MapFleet, "chain">): string =>
  fleet.chain === "robinhood" ? ROBINHOOD_OVERLAP_NOTE : fleet.chain === "solana" ? SOLANA_OVERLAP_NOTE : fleet.chain === "arc" || fleet.chain === "base" || fleet.chain === "ethereum" ? ARC_OVERLAP_NOTE : FLEET_OVERLAP_NOTE;

/** The sentence under the map about the BNB Chain lights, with how many are drawn of how many are stored. */
export function fleetsCaption(fleets: Pick<MapFleets, "fleets" | "groups" | "registrations">): string | null {
  if (fleets.fleets.length === 0) return null;
  const registrations = fleets.registrations !== null ? `, found among the ${grouped(fleets.registrations)} registrations the registry holds` : "";
  const groups = Math.max(fleets.groups, fleets.fleets.length);
  return `Large circles are BNB Chain groups of registrations that share one fact: ${fleets.fleets.length} of ${grouped(groups)} ${groups === 1 ? "group" : "groups"}${registrations}. Each circle is one group, not one agent. No individual BNB Chain registration is drawn.`;
}

/** The sentence under the map about the Solana lights: how many are drawn of how many there are, what a diamond is, and why SAID has none. */
export function solanaLightsCaption(solana: Pick<SolanaLights, "fleets" | "groups">): string | null {
  if (solana.fleets.length === 0) return null;
  const groups = Math.max(solana.groups, solana.fleets.length);
  return `Large diamonds are Solana owner wallets that the 8004 or the Metaplex agent registry records as holding ${grouped(SOLANA_LIGHT_MIN)} or more registrations: ${solana.fleets.length} of ${grouped(groups)} ${groups === 1 ? "wallet" : "wallets"}, as the directory held them at its last read. Each diamond is one wallet in one registry, not one agent. SAID has none: each SAID identity has a wallet of its own.`;
}

/** The sentence under the map about an extra chain's lights: how many are drawn of how many groups meet the rule, and what its shape is. `drawn` is how many the map shows. */
function registryLightsCaption(place: string, shape: string, shapes: string, registry: Pick<RegistryFleets, "groups">, drawn: number): string | null {
  if (drawn <= 0) return null;
  const groups = Math.max(registry.groups, drawn);
  return `Large ${shapes} are ${place} groups of registrations that share one wallet, host or profile link, ${grouped(FLEET_MIN)} or more registrations each: ${drawn} of ${grouped(groups)} ${groups === 1 ? "group" : "groups"}, as the registry held them at its last read. Each ${shape} is one group, not one agent. No individual ${place} registration is drawn.`;
}

/** The sentence under the map about the Arc lights, which are domes. */
export const arcLightsCaption = (arc: Pick<RegistryFleets, "groups">, drawn: number): string | null => registryLightsCaption("Arc", "dome", "domes", arc, drawn);

/** The sentence under the map about the Base lights, which are crosses. */
export const baseLightsCaption = (base: Pick<RegistryFleets, "groups">, drawn: number): string | null => registryLightsCaption("Base", "cross", "crosses", base, drawn);

/** The sentence under the map about the Ethereum lights, which are pentagons. */
export const ethereumLightsCaption = (ethereum: Pick<RegistryFleets, "groups">, drawn: number): string | null => registryLightsCaption("Ethereum", "pentagon", "pentagons", ethereum, drawn);

/** The sentence under the map about the Robinhood Chain lights: how many are drawn of how many there are, and what a hexagon is. */
export function robinhoodLightsCaption(robinhood: Pick<RobinhoodLights, "fleets" | "groups">): string | null {
  if (robinhood.fleets.length === 0) return null;
  const groups = Math.max(robinhood.groups, robinhood.fleets.length);
  return `Large hexagons are Robinhood Chain registering wallets that the directory records against ${grouped(ROBINHOOD_LIGHT_MIN)} or more registrations: ${robinhood.fleets.length} of ${grouped(groups)} ${groups === 1 ? "wallet" : "wallets"}, as the directory held them at its last read. Each hexagon is one wallet, not one agent. No individual registration is drawn.`;
}
