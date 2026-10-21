import { createHash } from "node:crypto";
import { extraProtocolOf, type ExtraChainKey } from "@shared/chains";
import { EMPTY_REGISTRY_FLEETS, REGISTRY_FLEETS_LIMIT, type MapFleet, type MapFleetKind, type RegistryFleets } from "@shared/mapFleets";
import { FLEET_MIN } from "@shared/noosphere";
import { readRegistryGroups, type RegistryGroupsRead } from "./agentRegistryRows";
import { sanitizePublicText } from "./publicText";
import { cachedDirectoryRead } from "./readCache";

/**
 * The groups behind the formations on an extra chain's own page (docs/chain-worlds-2026-10-20.md, "The Arc world", and docs/base-world-2026-10-21.md): the registering
 * wallets, hosts and profile links that {@link FLEET_MIN} or more of the chain's registrations share. They come straight from the
 * registry rows the chain pass stores, so there is no table to migrate and no step to run, and the figures are the ones the
 * listing rules count (docs/multichain-erc8004-2026-10-20.md). Nothing about any one registration is returned: a shared fact, its
 * kind, and how many registrations share it.
 *
 * Fails closed to nothing: while the chain is not indexed, and until a walk that reached the finalized head has published, the
 * answer is empty, because before that the stored rows are only a part of the chain.
 */

/** The chain a group is on, for the chains that have a page of their own. */
type WorldExtraChain = Extract<ExtraChainKey, "arc" | "base">;

const cleaned = (value: string | null): string | null => sanitizePublicText(value, 80);

/** What a shared profile link is called: its host, or a name its members record that is not the placeholder every unnamed registration gets. */
function linkLabel(host: string | null, name: string | null): string | null {
  if (host) return cleaned(host);
  if (name && !/^Agent #\d+$/.test(name)) return cleaned(name);
  return null;
}

/** The groups as the page draws them: the largest of each kind, with a stable id for each (derived from the shared fact, not the fact itself). Pure. */
export function shapeRegistryFleets(chain: WorldExtraChain, read: RegistryGroupsRead, readAt: Date, limit: number = REGISTRY_FLEETS_LIMIT): RegistryFleets {
  const kinds: MapFleetKind[] = ["wallet", "platform_host", "shared_link"];
  const fleets: MapFleet[] = kinds.flatMap(kind =>
    read.groups
      .filter(group => group.kind === kind && group.count > 0)
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, limit)
      .map(group => ({
        id: `${chain}-fleet-${createHash("sha256").update(`${chain}:${group.kind}:${group.key}`).digest("hex").slice(0, 16)}`,
        kind,
        chain,
        name: kind === "wallet" ? null : kind === "platform_host" ? cleaned(group.host) : linkLabel(group.host, group.name),
        wallet: kind === "wallet" ? group.key : null,
        registry: null,
        count: group.count,
        wallets: kind === "wallet" ? 1 : null,
      }))
  );
  const groups = read.totals.wallet + read.totals.platform_host + read.totals.shared_link;
  const recorded = read.recorded > 0 ? read.recorded : null;
  if (fleets.length === 0) return { ...EMPTY_REGISTRY_FLEETS, recorded };
  return { fleets, groups: Math.max(groups, fleets.length), walletGroups: Math.max(read.totals.wallet, fleets.filter(fleet => fleet.kind === "wallet").length), recorded, asOf: readAt.toISOString() };
}

/** The groups of a chain's registry, from the shared directory cache. */
export function readRegistryFleets(chain: WorldExtraChain): Promise<RegistryFleets> {
  return cachedDirectoryRead(`directory:registry-fleets:${chain}`, async () => {
    const read = await readRegistryGroups(extraProtocolOf(chain), FLEET_MIN, REGISTRY_FLEETS_LIMIT);
    return read ? shapeRegistryFleets(chain, read, new Date()) : EMPTY_REGISTRY_FLEETS;
  });
}
