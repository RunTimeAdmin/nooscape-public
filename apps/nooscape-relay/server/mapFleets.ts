import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { bscClusters, ingestionSources } from "../drizzle/schema";
import {
  EMPTY_MAP_FLEETS,
  EMPTY_ROBINHOOD_LIGHTS,
  EMPTY_SOLANA_LIGHTS,
  isMapFleetKind,
  MAP_FLEET_KINDS,
  MAP_FLEETS_LIMIT,
  ROBINHOOD_LIGHT_MIN,
  ROBINHOOD_LIGHTS_LIMIT,
  SOLANA_LIGHT_MIN,
  SOLANA_LIGHT_REGISTRIES,
  SOLANA_LIGHTS_LIMIT,
  type MapFleet,
  type MapFleets,
  type RobinhoodLights,
  type SolanaLights,
} from "@shared/mapFleets";
import { countRobinhoodListed, getDb, listRobinhoodRegistrantHoldings, listSolanaOwnerHoldings, requireDb } from "./db";
import { isCircuitOpenError } from "./dbBreaker";
import { sanitizePublicText } from "./publicText";
import { cachedDirectoryRead } from "./readCache";
import { isMissingTable } from "./driverErrors";

/**
 * The fleets and templates behind the lights on the home map. The BNB Chain lights (docs/bsc-fleet-lights-2026-10-16.md)
 * come from the groups the clustering step keeps in `bsc_clusters` (docs/bsc-clusters-2026-10-16.md); the Solana lights
 * (docs/solana-lights-2026-10-18.md) are the owner wallets the directory records for 100 or more registrations in one of two
 * registries; the Robinhood Chain lights (docs/robinhood-lights-2026-10-19.md) are the registering wallets the directory records
 * for 100 or more registrations. None reads anything about any one registration: no registration, entry or agent is returned, only a shared
 * fact, its kind and how many registrations share it.
 *
 * Fails closed to nothing. Until migration 0038 is run the BNB Chain table is not there, and until an operator has approved the
 * BNB Chain source there is nothing public to describe; either way the BNB Chain half of the map is exactly what it was. The
 * Solana half is read from the directory itself, so it needs no table, and a failed read of it leaves the BNB Chain lights alone.
 */

type ClusterRow = { kind: string; clusterKey: string; label: string | null; memberCount: number; walletCount: number | null; computedAt: Date };
type OwnerRow = { protocol: string; registrant: string; holdings: number };
type RegistrantRow = { registrant: string; holdings: number };

/** Public text for a name or host, or null when nothing is left of it. */
const cleaned = (value: string | null): string | null => sanitizePublicText(value, 80);

/** The map's groups from the stored rows: the largest first, at most `limit`, with a stable id for each. Pure. */
export function shapeMapFleets(rows: readonly ClusterRow[], summary: { groups: number; registrations: number | null }, limit: number = MAP_FLEETS_LIMIT): MapFleets {
  const fleets: MapFleet[] = [];
  let asOf: Date | null = null;
  for (const row of [...rows].sort((a, b) => b.memberCount - a.memberCount || (a.clusterKey < b.clusterKey ? -1 : 1))) {
    if (!isMapFleetKind(row.kind) || row.memberCount <= 0) continue;
    if (fleets.length >= limit) break;
    fleets.push({
      id: `bsc-fleet-${createHash("sha256").update(`${row.kind}:${row.clusterKey}`).digest("hex").slice(0, 16)}`,
      kind: row.kind,
      chain: "bnb",
      name: row.kind === "wallet" ? null : cleaned(row.label),
      wallet: row.kind === "wallet" ? row.clusterKey : null,
      registry: null,
      count: row.memberCount,
      wallets: row.walletCount,
    });
    if (asOf === null || row.computedAt > asOf) asOf = row.computedAt;
  }
  return { fleets, groups: summary.groups, registrations: summary.registrations, asOf: asOf ? asOf.toISOString() : null, solana: EMPTY_SOLANA_LIGHTS, robinhood: EMPTY_ROBINHOOD_LIGHTS };
}

/**
 * The Solana lights from the owner wallets the directory records: those with at least the minimum registrations in a registry
 * that gets a light, largest first, at most `limit`, with a stable id for each and the date of the read. A registry that is
 * not one of the two (SAID) never gets a light, whatever it holds. Pure.
 */
export function shapeSolanaLights(rows: readonly OwnerRow[], readAt: Date, limit: number = SOLANA_LIGHTS_LIMIT): SolanaLights {
  const eligible = rows
    .filter(row => Object.hasOwn(SOLANA_LIGHT_REGISTRIES, row.protocol) && row.registrant !== "" && row.holdings >= SOLANA_LIGHT_MIN)
    .sort((a, b) => b.holdings - a.holdings || (a.protocol < b.protocol ? -1 : a.protocol > b.protocol ? 1 : 0) || (a.registrant < b.registrant ? -1 : a.registrant > b.registrant ? 1 : 0));
  const fleets: MapFleet[] = eligible.slice(0, limit).map(row => ({
    id: `sol-fleet-${createHash("sha256").update(`${row.protocol}:${row.registrant}`).digest("hex").slice(0, 16)}`,
    kind: "wallet",
    chain: "solana",
    name: null,
    wallet: row.registrant,
    registry: SOLANA_LIGHT_REGISTRIES[row.protocol as keyof typeof SOLANA_LIGHT_REGISTRIES].key,
    count: row.holdings,
    wallets: null,
  }));
  return fleets.length === 0 ? EMPTY_SOLANA_LIGHTS : { fleets, groups: eligible.length, asOf: readAt.toISOString() };
}

/**
 * The Robinhood Chain lights from the registering wallets the directory records: those with at least the minimum registrations,
 * largest first, at most `limit`, with a stable id for each and the date of the read. Pure.
 */
export function shapeRobinhoodLights(rows: readonly RegistrantRow[], readAt: Date, limit: number = ROBINHOOD_LIGHTS_LIMIT, listed: number | null = null): RobinhoodLights {
  const eligible = rows
    .filter(row => row.registrant !== "" && row.holdings >= ROBINHOOD_LIGHT_MIN)
    .sort((a, b) => b.holdings - a.holdings || (a.registrant < b.registrant ? -1 : a.registrant > b.registrant ? 1 : 0));
  const fleets: MapFleet[] = eligible.slice(0, limit).map(row => ({
    id: `rh-fleet-${createHash("sha256").update(`erc8004:${row.registrant}`).digest("hex").slice(0, 16)}`,
    kind: "wallet",
    chain: "robinhood",
    name: null,
    wallet: row.registrant,
    registry: null,
    count: row.holdings,
    wallets: null,
  }));
  return fleets.length === 0 ? EMPTY_ROBINHOOD_LIGHTS : { fleets, groups: eligible.length, asOf: readAt.toISOString(), listed: listed !== null && Number.isFinite(listed) && listed >= 0 ? listed : null };
}

/** The Solana lights, read from the directory. A failed read is logged and answers no lights, so it never takes the BNB Chain lights with it. */
async function readSolanaLightsUncached(): Promise<SolanaLights> {
  try {
    const rows = await listSolanaOwnerHoldings(Object.keys(SOLANA_LIGHT_REGISTRIES) as Array<keyof typeof SOLANA_LIGHT_REGISTRIES>, SOLANA_LIGHT_MIN);
    return shapeSolanaLights(rows, new Date());
  } catch (error) {
    if (!isCircuitOpenError(error)) console.warn("[MapFleets] The Solana owner wallets could not be read; drawing none:", error instanceof Error ? error.message : String(error));
    return EMPTY_SOLANA_LIGHTS;
  }
}

/** The Robinhood Chain lights, read from the directory. A failed read is logged and answers no lights, so it never takes the other chains' lights with it. */
async function readRobinhoodLightsUncached(): Promise<RobinhoodLights> {
  try {
    // The count is a second read of the same rows. If it fails the wallets are still drawn, and no share is said.
    const [rows, listed] = await Promise.all([listRobinhoodRegistrantHoldings(ROBINHOOD_LIGHT_MIN), countRobinhoodListed().catch(() => null)]);
    return shapeRobinhoodLights(rows, new Date(), ROBINHOOD_LIGHTS_LIMIT, listed);
  } catch (error) {
    if (!isCircuitOpenError(error)) console.warn("[MapFleets] The Robinhood Chain registering wallets could not be read; drawing none:", error instanceof Error ? error.message : String(error));
    return EMPTY_ROBINHOOD_LIGHTS;
  }
}

async function readMapFleetsUncached(): Promise<MapFleets> {
  const [bnb, solana, robinhood] = await Promise.all([readBnbFleetsUncached(), readSolanaLightsUncached(), readRobinhoodLightsUncached()]);
  return { ...bnb, solana, robinhood };
}

async function readBnbFleetsUncached(): Promise<MapFleets> {
  const db = requireDb(await getDb());
  const [source] = await db
    .select({ id: ingestionSources.id })
    .from(ingestionSources)
    .where(and(eq(ingestionSources.protocol, "erc8004_bsc"), eq(ingestionSources.state, "active")))
    .limit(1);
  if (!source) return EMPTY_MAP_FLEETS;
  const kinds = [...MAP_FLEET_KINDS];
  const mine = and(eq(bscClusters.sourceId, source.id), inArray(bscClusters.kind, kinds));
  try {
    const [rows, counted, registry] = await Promise.all([
      db
        .select({ kind: bscClusters.kind, clusterKey: bscClusters.clusterKey, label: bscClusters.label, memberCount: bscClusters.memberCount, walletCount: bscClusters.walletCount, computedAt: bscClusters.computedAt })
        .from(bscClusters)
        .where(mine)
        .orderBy(desc(bscClusters.memberCount), asc(bscClusters.clusterKey))
        .limit(MAP_FLEETS_LIMIT),
      db.select({ groups: sql<number>`count(*)` }).from(bscClusters).where(mine),
      db
        .select({ registrations: bscClusters.memberCount })
        .from(bscClusters)
        .where(and(eq(bscClusters.sourceId, source.id), eq(bscClusters.kind, "registry")))
        .limit(1),
    ]);
    return shapeMapFleets(rows, { groups: Number(counted[0]?.groups ?? 0), registrations: registry[0] ? Number(registry[0].registrations) : null });
  } catch (error) {
    if (isMissingTable(error)) return EMPTY_MAP_FLEETS;
    throw error;
  }
}

/** The groups for the map, from the shared directory cache. */
export function readMapFleets(): Promise<MapFleets> {
  return cachedDirectoryRead("directory:map-fleets", readMapFleetsUncached);
}
