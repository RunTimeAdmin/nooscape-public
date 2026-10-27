import { getLatestCensusObservation } from "./db";
import { storageReadText } from "./storage";

type EcosystemMetric = {
  label: string;
  value: number;
  detail: string;
};

export type EcosystemContext = {
  observedAt: string;
  source: { label: string; locator: string; contentHash: string };
  metrics: EcosystemMetric[];
  chains: Array<{ name: string; transactions: number }>;
};

type UnknownRecord = Record<string, unknown>;

const CACHE_TTL_MS = 60_000;
let cached: { expiresAt: number; value: EcosystemContext | null } | null = null;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** Extracts an explicitly bounded public aggregate view; raw census bytes are never returned. */
export function extractEcosystemContext(payload: unknown, source: EcosystemContext["source"], observedAt: Date): EcosystemContext | null {
  const root = asRecord(payload);
  if (!root) return null;
  const x402 = asRecord(root.x402);
  const registry = asRecord(root.erc8004Registry);
  const baseAgentic = asRecord(root.baseAgentic);
  const metrics: EcosystemMetric[] = [];

  const appendMetric = (label: string, value: unknown, detail: string) => {
    const numeric = finiteNumber(value);
    if (numeric !== null) metrics.push({ label, value: numeric, detail });
  };

  appendMetric("x402 transactions", x402?.totalTxs, "Aggregate payment activity tracked by Agent Economy");
  appendMetric("ERC-8004 identities", registry?.totalAgents, "Aggregate registry count; not a Nooscape trust score");
  appendMetric("Base agentic transactions", baseAgentic?.totalTxs, "Aggregate address-activity scope reported by the source");
  appendMetric("Facilitators tracked", x402?.facilitatorsTracked, "Source-reported x402 facilitator coverage");

  const chainRows = Array.isArray(x402?.chains) ? x402.chains : [];
  const chains = chainRows
    .map(entry => {
      const row = asRecord(entry);
      const name = text(row?.name, "Unknown chain");
      const transactions = finiteNumber(row?.txs);
      return transactions === null ? null : { name, transactions };
    })
    .filter((entry): entry is { name: string; transactions: number } => Boolean(entry))
    .sort((left, right) => right.transactions - left.transactions)
    .slice(0, 8);

  if (metrics.length === 0) return null;
  return {
    observedAt: text(root.updatedAt, observedAt.toISOString()),
    source,
    metrics: metrics.slice(0, 4),
    chains,
  };
}

export async function getPublicEcosystemContext(): Promise<EcosystemContext | null> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const observation = await getLatestCensusObservation();
    if (!observation) return null;
    const rawText = await storageReadText(observation.rawObjectKey);
    const value = extractEcosystemContext(
      JSON.parse(rawText),
      { label: observation.sourceLabel, locator: observation.canonicalLocator, contentHash: observation.contentHash },
      observation.observedAt,
    );
    cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  } catch (error) {
    console.warn("[Ecosystem context] Failed to derive aggregate context:", error);
    cached = { value: null, expiresAt: Date.now() + CACHE_TTL_MS };
    return null;
  }
}
