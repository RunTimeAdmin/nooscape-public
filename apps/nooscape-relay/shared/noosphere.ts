import { chainOf, parseProtocolList, type ChainKey } from "./chains";

/**
 * The sample behind the Home hero: the registered agents as lights. Pure and shared, so the server that
 * builds the sample and the page that draws it agree on its shape, and so none of it needs a database to
 * test.
 *
 * What a light is made of, and nothing else: a placement hash, the chain the agent is registered on, whether
 * Nooscape holds reviewed evidence for it, and which registering-wallet fleet it belongs to. It carries no
 * name, no score and no rank, and nothing here has an input that can be paid for.
 */

/**
 * The protocols that register an agent on a chain, which is what the Noosphere draws. The locator
 * protocols (catalog, A2A and the rest) are listings seen on directories, and the reputation and
 * settlement ledgers are not agents, so none of those are lights.
 */
export const NOOSPHERE_PROTOCOLS = ["erc8004", "erc8004_bsc", "solana_registry", "solana_8004", "solana_said"] as const;

/** The most lights the sample holds, so the payload and the canvas stay small. */
export const MAX_LIGHTS = 1500;
/** How many sampled registrations the query aims for, leaving room under the cap for the reviewed records. */
export const TARGET_SAMPLE = 1400;
/** A registering wallet with at least this many acknowledged registrations is a fleet. */
export const FLEET_MIN = 50;
/** At most this many fleets are named. */
export const MAX_FLEETS = 12;

/** The chain a light is on, as a small number: 0 is none, then Robinhood, Solana, BNB. */
export const LIGHT_CHAIN_ORDER = [null, "robinhood", "solana", "bnb"] as const;
type LightChain = 0 | 1 | 2 | 3;

/** [placement hash, chain, 1 if Nooscape holds reviewed evidence for it, fleet number from 1 or 0 for none]. */
export type Light = readonly [hash: number, chain: LightChain, steady: 0 | 1, fleet: number];

export type Fleet = {
  /** The registering wallet, a chain fact decoded from the registration events. It is not a verified operator. */
  wallet: string;
  /** How many acknowledged registrations the directory holds for this wallet. */
  size: number;
  chain: ChainKey | null;
  /** Where most of the wallet's registrations point, or null. */
  host: string | null;
};

export type NoosphereSample = {
  /** When the sample was read (ISO 8601). */
  asOf: string;
  /** The registrations the sample is drawn from: every acknowledged on-chain registration. */
  total: number;
  /** How many of them are drawn. */
  sampled: number;
  /** The reviewed records, all drawn, as steady lights. */
  steady: number;
  lights: Light[];
  fleets: Fleet[];
};

/** Every how-many-th registration the query keeps, so the sample holds about `target` of them. */
export function sampleModulus(total: number, target = TARGET_SAMPLE): number {
  return total <= target || target <= 0 ? 1 : Math.ceil(total / target);
}

export const lightChain = (chain: ChainKey | null): LightChain => LIGHT_CHAIN_ORDER.indexOf(chain) as LightChain;

/** A 32-bit FNV-1a hash of an id: where a record sits on the map, the same on every visit. */
export function placementHash(id: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    value ^= id.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/** The first protocol in a reviewed record's list that is on a chain, or null. */
function reviewedChain(protocols: string): ChainKey | null {
  for (const protocol of parseProtocolList(protocols)) {
    const chain = chainOf(protocol);
    if (chain) return chain;
  }
  return null;
}

export type SampleInput = {
  now: Date;
  total: number;
  /** The sampled registrations: the query's CRC32 of the entry id, its protocol and its registering wallet. */
  rows: ReadonlyArray<{ hash: number; protocol: string; registrant: string | null }>;
  /** The reviewed public records, which are the steady lights. */
  reviewed: ReadonlyArray<{ agentId: string; protocols: string }>;
  /** The registering wallets with the most registrations, largest first, with where they mostly point. */
  wallets: ReadonlyArray<{ registrant: string; agentCount: number; dominantHost: string | null }>;
};

export function buildNoosphereSample(input: SampleInput): NoosphereSample {
  // Reviewed records first, in id order, each once: the steady lights, all drawn.
  const seen = new Set<string>();
  const steadyLights: Light[] = [];
  for (const record of [...input.reviewed].sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0))) {
    if (seen.has(record.agentId) || steadyLights.length >= MAX_LIGHTS) continue;
    seen.add(record.agentId);
    steadyLights.push([placementHash(record.agentId), lightChain(reviewedChain(record.protocols)), 1, 0]);
  }

  // Fleets: the wallets with enough registrations, largest first.
  const fleetWallets = input.wallets
    .filter(wallet => wallet.registrant !== "" && wallet.agentCount >= FLEET_MIN)
    .sort((a, b) => b.agentCount - a.agentCount || (a.registrant < b.registrant ? -1 : 1))
    .slice(0, MAX_FLEETS);
  const fleetNumber = new Map(fleetWallets.map((wallet, index) => [wallet.registrant, index + 1]));

  // Sampled registrations, in hash order so a cap keeps the same ones every time.
  const room = Math.max(0, MAX_LIGHTS - steadyLights.length);
  const rows = input.rows
    .filter(row => (NOOSPHERE_PROTOCOLS as readonly string[]).includes(row.protocol))
    .sort((a, b) => a.hash - b.hash || ((a.registrant ?? "") < (b.registrant ?? "") ? -1 : 1))
    .slice(0, room);
  const lights: Light[] = rows.map(row => [row.hash >>> 0, lightChain(chainOf(row.protocol)), 0, row.registrant ? (fleetNumber.get(row.registrant) ?? 0) : 0]);

  // A fleet's chain is the one most of its sampled registrations are on.
  const tallies = fleetWallets.map(() => [0, 0, 0, 0]);
  rows.forEach(row => {
    const number = row.registrant ? fleetNumber.get(row.registrant) : undefined;
    if (number) tallies[number - 1]![lightChain(chainOf(row.protocol))] += 1;
  });
  const fleets: Fleet[] = fleetWallets.map((wallet, index) => {
    const tally = tallies[index]!;
    let best: LightChain = 0;
    for (const candidate of [1, 2, 3] as const) if (tally[candidate]! > tally[best]!) best = candidate;
    return { wallet: wallet.registrant, size: wallet.agentCount, chain: LIGHT_CHAIN_ORDER[best] ?? null, host: wallet.dominantHost };
  });

  return {
    asOf: input.now.toISOString(),
    total: input.total,
    sampled: lights.length,
    steady: steadyLights.length,
    lights: [...steadyLights, ...lights],
    fleets,
  };
}
