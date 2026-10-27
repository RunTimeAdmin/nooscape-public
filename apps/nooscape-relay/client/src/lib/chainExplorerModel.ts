import { CHAINS, parseProtocolList, type ChainKey } from "@shared/chains";
import { featureOn } from "@shared/features";
import { FLEET_KIND_LABEL, fleetKindLabel, fleetTitle, ROBINHOOD_LIGHT_MIN, type MapFleet } from "@shared/mapFleets";
import type { Arrangement } from "./chainWorldLayout";

export const CHAIN_WORLDS = {
  robinhood: {
    title: "The orbital field",
    subtitle: "A new sky for agent identities.",
    description: "Explore the identities and registry changes Nooscape has recorded on Robinhood Chain, and the few wallets that registered most of them.",
    accent: "#C3F53C",
    secondary: "#66E8FF",
    number: "01",
    terrain: "Orbital observatory",
    registry: "ERC-8004",
  },
  solana: {
    title: "The prism garden",
    subtitle: "Three registries. One living field.",
    description: "Follow registrations, ownership changes and profile edits across Solana’s agent registries.",
    accent: "#A78BFA",
    secondary: "#5EEAD4",
    number: "02",
    terrain: "Registry archipelago",
    registry: "Metaplex · 8004 · SAID",
  },
  bnb: {
    title: "The amber foundry",
    subtitle: "Groups, not agents.",
    description: "Inspect the groups of BNB Chain registrations that share a wallet, a link, a host or a template. Individual registrations are not drawn here.",
    accent: "#F3BA2F",
    secondary: "#F59B73",
    number: "03",
    terrain: "Fleet observatory",
    registry: "ERC-8004 / BNB",
  },
  arc: {
    title: "The glass harbor",
    subtitle: "A new registry, read in full.",
    description: "Inspect the entries the directory lists on Arc and the groups of registrations that share a wallet, a link or a host. A group is not an agent, and a registration is not an endorsement.",
    accent: "#ACC6E9",
    secondary: "#9F72FF",
    number: "04",
    terrain: "Harbor observatory",
    registry: "ERC-8004 / Arc",
  },
  base: {
    title: "The open shore",
    subtitle: "A busy registry, read in groups.",
    description: "Inspect the groups of Base registrations that share a wallet, a link or a host. A group is not an agent, and a registration is not an endorsement. Individual registrations are not drawn here.",
    accent: "#3B82F6",
    secondary: "#67E8F9",
    number: "05",
    terrain: "Shore observatory",
    registry: "ERC-8004 / Base",
  },
  ethereum: {
    title: "The pale spire",
    subtitle: "A long ledger, read in groups.",
    description: "Inspect the groups of Ethereum registrations that share a wallet, a link or a host. A group is not an agent, and a registration is not an endorsement. Individual registrations are not drawn here.",
    accent: "#7DD3FC",
    secondary: "#C4B5FD",
    number: "06",
    terrain: "Spire observatory",
    registry: "ERC-8004 / Ethereum",
  },
} as const;
export const isChainWorld = (value: string): value is ChainKey => (CHAINS as readonly string[]).includes(value);

/** The chains that have a page of their own: the original three, and Arc, Base and Ethereum while their switches are on. */
export type WorldKey = ChainKey | "arc" | "base" | "ethereum";

/** The worlds a build offers, in the order their pages are numbered. Arc, Base and Ethereum are there only while `chain_arc`, `chain_base` and `chain_ethereum` are in the build's switch list (shared/features.ts). */
export const worldsOn = (features: string | undefined): WorldKey[] => [
  ...CHAINS,
  ...(featureOn("chain_arc", features) ? (["arc"] as const) : []),
  ...(featureOn("chain_base", features) ? (["base"] as const) : []),
  ...(featureOn("chain_ethereum", features) ? (["ethereum"] as const) : []),
];

/**
 * The worlds that have no feed of their own: a recorded event is shown only for the entry that is selected, from the entry's own activity.
 * BNB Chain has no global feed, and Arc, Base and Ethereum have none yet.
 */
export const ENTRY_EVENT_WORLDS: readonly WorldKey[] = ["bnb", "arc", "base", "ethereum"];

/** Only protocols that register identities belong in the character field. Reputation and settlement ledgers are separate. */
export const CHAIN_IDENTITY_PROTOCOLS: Record<WorldKey, readonly string[]> = {
  robinhood: ["erc8004"],
  solana: ["solana_registry", "solana_8004", "solana_said"],
  bnb: ["erc8004_bsc"],
  arc: ["erc8004_arc"],
  base: ["erc8004_base"],
  ethereum: ["erc8004_eth"],
};

/**
 * Whether a figure may stand for an entry the directory lists and Nooscape has not reviewed. BNB Chain is groups only, as on the home map
 * (docs/bsc-fleet-lights-2026-10-16.md, invariant 23): no single BNB Chain registration is drawn, so only a reviewed public record and the
 * groups appear there. Base is groups only too, as the operator asked ("similar to bnb"): the directory lists 2.3 percent of the registrations
 * its registry holds (docs/base-census-2026-10-21.md), so no single Base registration is drawn either. Ethereum is groups only as well:
 * the directory lists 9.4 percent of its registrations (docs/ethereum-go-live-2026-10-27.md), and most of those still show a number for a name.
 */
export const CHAIN_SHOWS_ACKNOWLEDGED: Record<WorldKey, boolean> = { robinhood: true, solana: true, bnb: false, arc: true, base: false, ethereum: false };

/** The dated report that describes a chain's groups, where there is one. */
export const CHAIN_GROUP_REPORT: Record<WorldKey, { href: string; label: string } | null> = {
  robinhood: { href: "/field/robinhood-registry-2026-10-20", label: "Robinhood Chain registry census, 20 October 2026" },
  solana: { href: "/field/solana-registries-2026-10-18", label: "Solana registry census, 18 October 2026" },
  bnb: { href: "/field/bnb-registry-2026-10-16", label: "BNB Chain registry census, 16 October 2026" },
  arc: { href: "/field/arc-registry-2026-10-20", label: "Arc registry census, 20 October 2026" },
  base: { href: "/field/base-registry-2026-10-21", label: "Base registry census, 21 October 2026" },
  ethereum: null,
};

export type ChainWorldEvent = {
  id: string;
  entryId: string;
  name: string;
  protocol: string;
  kind: "register" | "transfer" | "profile" | "feedback";
  label: string;
  height: number;
  heightLabel: string;
  transaction: string;
  from: string | null;
  to: string | null;
  observedAt: string | null;
};
export type ChainWorldEntity = {
  id: string;
  name: string;
  protocol: string;
  kind: "reviewed" | "acknowledged" | "group";
  detail: string;
  evidenceTier: string | null;
  sourceCount: number | null;
  observedAt: string | null;
  count: number | null;
  /** The light a group stands for, with the shared fact in it. Null for a record or an entry. */
  fleet: MapFleet | null;
};
type PublicWorldRecord = {
  agentId: string;
  displayName: string;
  protocols: string;
  primaryCapability: string | null;
  evidenceTier: string;
  sourceCount: number;
  lastObservedAt: Date | string;
};
export type AcknowledgedWorldRecord = {
  id: string;
  displayName: string;
  protocol: string;
  locatorHost: string | null;
};
type EvmWorldEvent = {
  entryId: string;
  displayName: string;
  kind: "mint" | "secondary" | "uri_update";
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  fromAddress: string | null;
  toAddress: string | null;
  isHandout?: boolean;
};
type SolanaWorldEvent = {
  id: string;
  entryId: string;
  displayName: string;
  protocol: string;
  kind: string;
  slot: number;
  transactionSignature: string;
  fromOwner: string | null;
  toOwner: string | null;
  recordedAt: Date | string;
};
const iso = (value: Date | string): string | null => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** A recorded time as a reader wants it: 9 Oct 2026, 03:27 UTC. */
export function formatObserved(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

export function normalizeEvmEvents(rows: readonly EvmWorldEvent[], protocol = "erc8004"): ChainWorldEvent[] {
  return [...rows]
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex || a.transactionHash.localeCompare(b.transactionHash))
    .map(row => ({
      id: `${protocol}:${row.transactionHash}:${row.logIndex}`,
      entryId: row.entryId,
      name: row.displayName,
      protocol,
      kind: row.kind === "mint" ? "register" : row.kind === "secondary" ? "transfer" : "profile",
      label: row.kind === "mint" ? "Identity registered" : row.kind === "uri_update" ? "Profile link updated" : row.isHandout ? "Registration hand-out" : "Ownership transferred",
      height: row.blockNumber,
      heightLabel: "Block",
      transaction: row.transactionHash,
      from: row.fromAddress,
      to: row.toAddress,
      observedAt: null,
    }));
}
export function normalizeSolanaEvents(rows: readonly SolanaWorldEvent[]): ChainWorldEvent[] {
  // The pass slot is an observation anchor, not necessarily the transaction's slot.
  return rows
    .filter(row => CHAIN_IDENTITY_PROTOCOLS.solana.includes(row.protocol) && ["register", "transfer", "profile_update"].includes(row.kind))
    .map(row => ({
      id: `solana:${row.id}`,
      entryId: row.entryId,
      name: row.displayName,
      protocol: row.protocol,
      kind: row.kind === "register" ? ("register" as const) : row.kind === "transfer" ? ("transfer" as const) : ("profile" as const),
      label: row.kind === "register" ? "Identity registered" : row.kind === "transfer" ? "Owner / authority changed" : "Profile updated",
      height: row.slot,
      heightLabel: "Observation slot",
      transaction: row.transactionSignature,
      from: row.fromOwner,
      to: row.toOwner,
      observedAt: iso(row.recordedAt),
    }))
    .sort((a, b) => (a.observedAt ?? "").localeCompare(b.observedAt ?? "") || a.height - b.height || a.id.localeCompare(b.id));
}

/** The protocol a group of this chain sits on, so it filters and is labelled with the registry it counts. */
const groupProtocol = (chain: WorldKey, group: MapFleet): string =>
  chain === "bnb"
    ? "erc8004_bsc"
    : chain === "arc"
      ? "erc8004_arc"
      : chain === "base"
        ? "erc8004_base"
        : chain === "ethereum"
          ? "erc8004_eth"
          : chain === "robinhood"
            ? "erc8004"
            : group.registry === "8004"
              ? "solana_8004"
              : "solana_registry";

/** Only real, visible record IDs become selectable entities. No hash-only samples or invented agents. */
export function buildWorldEntities(
  chain: WorldKey,
  records: readonly PublicWorldRecord[],
  events: readonly ChainWorldEvent[],
  acknowledgements: readonly AcknowledgedWorldRecord[] = [],
  groups: readonly MapFleet[] = []
): ChainWorldEntity[] {
  const entities = new Map<string, ChainWorldEntity>();
  for (const record of records) {
    const protocol = parseProtocolList(record.protocols).find(item => CHAIN_IDENTITY_PROTOCOLS[chain].includes(item));
    if (!protocol) continue;
    entities.set(record.agentId, {
      id: record.agentId,
      name: record.displayName,
      protocol,
      kind: "reviewed",
      detail: record.primaryCapability ?? "Public discovery record",
      evidenceTier: record.evidenceTier,
      sourceCount: record.sourceCount,
      observedAt: iso(record.lastObservedAt),
      count: null,
      fleet: null,
    });
  }
  if (CHAIN_SHOWS_ACKNOWLEDGED[chain]) {
    for (const record of acknowledgements) {
      if (!CHAIN_IDENTITY_PROTOCOLS[chain].includes(record.protocol) || entities.has(record.id)) continue;
      entities.set(record.id, {
        id: record.id,
        name: record.displayName,
        protocol: record.protocol,
        kind: "acknowledged",
        detail: record.locatorHost ?? "Registry identity · not reviewed",
        evidenceTier: null,
        sourceCount: null,
        observedAt: null,
        count: null,
        fleet: null,
      });
    }
    for (const event of events) {
      if (!CHAIN_IDENTITY_PROTOCOLS[chain].includes(event.protocol) || entities.has(event.entryId)) continue;
      entities.set(event.entryId, {
        id: event.entryId,
        name: event.name,
        protocol: event.protocol,
        kind: "acknowledged",
        detail: "Entry from recorded activity · not reviewed",
        evidenceTier: null,
        sourceCount: null,
        observedAt: event.observedAt,
        count: null,
        fleet: null,
      });
    }
  }
  for (const group of groups) {
    if (group.chain !== chain) continue;
    entities.set(`group:${group.id}`, {
      id: `group:${group.id}`,
      name: fleetTitle(group),
      protocol: groupProtocol(chain, group),
      kind: "group",
      detail: fleetKindLabel(group),
      evidenceTier: null,
      sourceCount: null,
      observedAt: null,
      count: group.count,
      fleet: group,
    });
  }
  return Array.from(entities.values());
}

/** The figures of a world: the entries, never the groups. At most `limit`, with the selected one and the one a replayed event is about kept in view. */
export function worldCrew(entities: readonly ChainWorldEntity[], selectedId: string | null, eventEntryId: string | null, limit = 16) {
  // The current historical event and manual selection stay reachable, without promoting an inferred connection.
  const priority = new Set([selectedId, eventEntryId]);
  const base = entities.slice(0, Math.max(0, limit));
  const additions = entities.filter(item => priority.has(item.id) && !base.some(shown => shown.id === item.id));
  for (const addition of additions) {
    const removable = base.map(item => priority.has(item.id)).lastIndexOf(false);
    if (removable >= 0) base.splice(removable, 1, addition);
    else if (base.length < limit) base.push(addition);
  }
  return base;
}
export function filterWorldEntities(entities: readonly ChainWorldEntity[], query: string, protocol = "all") {
  const needle = query.trim().toLocaleLowerCase();
  return entities.filter(
    entity => (protocol === "all" || entity.protocol === protocol) && (!needle || `${entity.name} ${entity.id} ${entity.protocol} ${entity.detail}`.toLocaleLowerCase().includes(needle))
  );
}
export function worldEntityLabel(entity: ChainWorldEntity) {
  return entity.kind === "group" ? "Registration group · not an agent" : entity.kind === "acknowledged" ? "Acknowledged · not reviewed" : "Reviewed public record";
}
export function worldProtocolLabel(protocol: string) {
  return (
    (
      {
        erc8004: "ERC-8004",
        erc8004_bsc: "ERC-8004 / BNB",
        erc8004_arc: "ERC-8004 / Arc",
        erc8004_base: "ERC-8004 / Base",
        erc8004_eth: "ERC-8004 / Ethereum",
        solana_registry: "Metaplex",
        solana_8004: "8004 Solana",
        solana_said: "SAID",
      } as Record<string, string>
    )[protocol] ?? protocol.replace(/_/g, " ")
  );
}

/**
 * Solana's page draws three registries and counts a fourth. AgenC's pass lists its agents and records no registration, ownership change or
 * profile edit, so there is nothing of it to draw (docs/agenc-solana-2026-10-26.md). Said only while the chain's own count includes it.
 */
export function undrawnRegistryNote(chain: WorldKey, registries: ReadonlyArray<{ protocol: string; count: number }> = []): string | null {
  return chain === "solana" && registries.some(row => row.protocol === "solana_agenc" && row.count > 0)
    ? "AgenC, a fourth, is counted below but has no recorded events, so it is not drawn."
    : null;
}

/** How each world sets its zones out: Robinhood Chain a narrow plate of wallets beside a wide plate of identities, the others in a row of lanes or platforms. */
export const WORLD_ARRANGEMENT: Record<WorldKey, Arrangement> = { robinhood: "split", solana: "columns", bnb: "columns", arc: "columns", base: "columns", ethereum: "columns" };

/** A zone of a world: a plate with a name, the formations of its groups and the figures of its records. */
export type WorldZone = { id: string; label: string; sublabel: string | null; groups: ChainWorldEntity[]; figures: ChainWorldEntity[] };

/** The three Solana registries, in the order the lanes stand. */
const SOLANA_LANES = [
  { id: "solana_registry", label: "Metaplex agent registry" },
  { id: "solana_8004", label: "8004 registry" },
  { id: "solana_said", label: "SAID registry" },
] as const;
/** The kinds of shared fact a BNB Chain group can be, in the order the platforms stand. */
const BNB_PLATFORMS = ["platform_host", "shared_link", "wallet", "template"] as const;
/** The kinds of shared fact an Arc group can be, in the order the platforms stand. Arc has no template groups. */
const ARC_PLATFORMS = ["wallet", "platform_host", "shared_link"] as const;
/** The kinds of shared fact a Base group can be, in BNB Chain's order: the host first, because the hosts hold most of the registry. Base has no template groups. */
const BASE_PLATFORMS = ["platform_host", "shared_link", "wallet"] as const;
/** The same for an Ethereum group, in the order BNB Chain's and Base's pages use: the host first. Ethereum has no template groups. */
const ETHEREUM_PLATFORMS = BASE_PLATFORMS;

/**
 * The zones of a world, and what stands in each. A place means only what its zone says: on Solana a registry (the one a record or a wallet
 * is recorded in), on BNB Chain a kind of shared fact (the one a group counts), on Robinhood Chain the wallets that registered many entries
 * and the identities themselves. A zone with nothing in it is not returned.
 */
export function worldZones(chain: WorldKey, entities: readonly ChainWorldEntity[], registries: ReadonlyArray<{ protocol: string; count: number }> = []): WorldZone[] {
  const groups = entities.filter(entity => entity.kind === "group");
  const figures = entities.filter(entity => entity.kind !== "group");
  const zones: WorldZone[] = [];
  if (chain === "robinhood") {
    zones.push(
      { id: "wallets", label: "Registering wallets", sublabel: `Each recorded against ${ROBINHOOD_LIGHT_MIN} or more entries`, groups, figures: [] },
      { id: "identities", label: "Identities", sublabel: "Reviewed records first, then entries from recorded activity", groups: [], figures }
    );
  } else if (chain === "solana") {
    for (const lane of SOLANA_LANES) {
      const listed = registries.find(row => row.protocol === lane.id)?.count;
      const parts = [listed != null ? `${listed.toLocaleString("en-US")} listed` : null, lane.id === "solana_said" ? "no groups: each identity has a wallet of its own" : null].filter(Boolean);
      zones.push({ id: lane.id, label: lane.label, sublabel: parts.length ? parts.join(" \u00B7 ") : null, groups: groups.filter(entity => entity.protocol === lane.id), figures: figures.filter(entity => entity.protocol === lane.id) });
    }
  } else if (chain === "arc") {
    for (const kind of ARC_PLATFORMS) {
      const here = groups.filter(entity => entity.fleet?.kind === kind);
      zones.push({ id: kind, label: FLEET_KIND_LABEL[kind], sublabel: `${here.length} ${here.length === 1 ? "group" : "groups"} drawn`, groups: here, figures: [] });
    }
    zones.push({ id: "entries", label: "Entries", sublabel: "Reviewed records first, then a fixed sample of the entries the directory lists", groups: [], figures });
  } else {
    for (const kind of chain === "base" ? BASE_PLATFORMS : chain === "ethereum" ? ETHEREUM_PLATFORMS : BNB_PLATFORMS) {
      const here = groups.filter(entity => entity.fleet?.kind === kind);
      zones.push({ id: kind, label: FLEET_KIND_LABEL[kind], sublabel: `${here.length} ${here.length === 1 ? "group" : "groups"} drawn`, groups: here, figures: [] });
    }
    // A reviewed BNB Chain, Base or Ethereum record would stand on a plate of its own. There is none today, and no unreviewed registration is ever drawn.
    zones.push({ id: "records", label: "Reviewed records", sublabel: null, groups: [], figures });
  }
  return zones.filter(zone => zone.groups.length + zone.figures.length > 0);
}

type ShareSegment = { id: string; label: string; wallet: string | null; count: number; percent: number };
export type RegistrationShareFigures = {
  /** The entries the directory lists. */
  listed: number;
  /** The entries recorded against the wallets that have a formation. */
  held: number;
  wallets: number;
  /** True when these are all the wallets that meet the rule. False when more meet it than are drawn, so the rest of the entries are not all on small wallets. */
  complete: boolean;
  /** The whole percent of the listed entries that `held` is, rounded down so it never claims more than it is. */
  percent: number;
  /** One for each wallet, largest first, with its share to one decimal place. */
  segments: ShareSegment[];
  /** The entries recorded against wallets with fewer than the minimum each. */
  rest: number;
};

/**
 * How much of the directory's list of entries the registering wallets with a formation are recorded against: one figure from one read,
 * because the lights and the number listed are counted together. Null when there is nothing to say: no wallets, no count, or a count
 * smaller than the wallets' (which two reads of different moments could give, and which is not worth a share over the whole).
 */
export function registrationShare(fleets: readonly MapFleet[], listed: number | null | undefined, walletsMeetingRule?: number | null): RegistrationShareFigures | null {
  if (listed == null || !Number.isFinite(listed) || listed <= 0 || fleets.length === 0) return null;
  const sorted = [...fleets].sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const held = sorted.reduce((sum, fleet) => sum + fleet.count, 0);
  if (held > listed) return null;
  return {
    listed,
    held,
    wallets: sorted.length,
    complete: walletsMeetingRule == null || walletsMeetingRule <= sorted.length,
    percent: Math.floor((held / listed) * 100),
    segments: sorted.map(fleet => ({ id: fleet.id, label: fleetTitle(fleet), wallet: fleet.wallet, count: fleet.count, percent: Math.round((fleet.count / listed) * 1000) / 10 })),
    rest: listed - held,
  };
}
