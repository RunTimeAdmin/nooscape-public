import { createHash } from "node:crypto";
import { storagePut } from "../storage";
import { assertPublicHostname } from "./a2a";
import { fetchUnderDeadline } from "./deadlineFetch";
import { canonicalHost } from "../hostName";
import type { IngestionSource } from "../../drizzle/schema";
import type { CatalogNormalizedCandidate, RawObservationInput } from "./types";

/**
 * Two public A2A registries read as catalogs: a2aregistry.org (a community registry, probe results and no identity field) and the
 * registry behind api.a2a-registry.org (an owner-claim and DNS or ANS check it calls "verified"). Both are small variants of the
 * Agenstry catalog adapter: paged JSON instead of a gzip NDJSON feed, a different record shape, and a selection rule of their own
 * (docs/approvals/2026-11-06-a2aregistry-catalog.md and docs/approvals/2026-11-06-a2a-registry-org-catalog.md; the measurements are
 * from the scout's read of 2026-11-06, docs/a2a-registries-2026-11-06.md).
 *
 * What a run reads is the list endpoint and nothing else. No URL inside a record is followed: not the card, not the service address, not
 * the registry's own probe, recheck or flag routes. A record that is taken stays catalog discovery metadata at Tier 2, and what the
 * registry says about itself (a probe, a check, a verification level) is kept as an upstream assertion and never as Nooscape's.
 */

export type A2aRegistryKey = "a2aregistry-public-api" | "a2a-registry-org-public-api";
export const A2A_REGISTRY_SOURCE_KEYS: readonly A2aRegistryKey[] = ["a2aregistry-public-api", "a2a-registry-org-public-api"];

/** The parser that reads these records, recorded with each observation. */
export const A2A_REGISTRY_PARSER_VERSION = "a2a-registry-catalog-v1-source-scoped";

/**
 * Reviewed intake ceiling for one run, for both registries. a2aregistry.org had about 285 records that pass its rule on 2026-11-06 and the
 * other registry about 89, so this binds at once on the first and not on the second. When more qualify, the oldest are taken, so the set
 * does not change from one run to the next as new records arrive. Each taken record is one more to check before it is shown; the
 * ceiling sits inside what the review tooling lists in one run (`MAX_RUN_REVIEW_OBSERVATIONS`), and raising it is the operator's decision.
 */
export const A2A_REGISTRY_MAX_ACCEPTED_RECORDS = 96;

/** Both registries cap a page at 100 records. */
const PAGE_SIZE = 100;
/** At least this long between two requests to the same registry. */
export const A2A_REGISTRY_PAUSE_MS = 1_200;
const REQUEST_TIMEOUT_MS = 20_000;

export class A2aRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2aRegistryValidationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : null;
}

/** A canonical HTTPS URL (no credentials, no port) or null. */
function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return url;
}

/**
 * Hosting platforms where each tenant is its own party. On these the whole host is the unit, so one vendor's templated agents
 * count once and a platform's other tenants do not count against it. Everywhere else the unit is the registrable domain. The list is the
 * eight platforms the approval names, the one the largest block of records sat on, and four more the 2026-11-06 lists showed; a platform
 * that is not on it folds its tenants into one party, which can only drop a record.
 */
const TENANT_PLATFORMS = [
  "workers.dev", "vercel.app", "onrender.com", "railway.app", "fly.dev", "pages.dev", "github.io", "run.app", "tcloudbaseapp.com",
  "netlify.app", "supabase.co", "chatgpt.site", "sslip.io",
];

/** Two-label public suffixes the registrable domain must reach past. A host under one that is not listed collapses into fewer units, which is the safe way to be wrong. */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "or.jp", "ne.jp", "com.br", "com.cn",
  "com.hk", "com.sg", "com.tw", "com.mx", "com.tr", "com.ar", "co.in", "co.kr", "co.za", "com.ua", "com.pl",
]);

/**
 * The party a host stands for: the whole host on a hosting platform, the registrable domain elsewhere, null for an address that is not
 * a DNS name. This is a short fixed list and not the public suffix list, so a host the list does not know is grouped with its
 * neighbours and not split from them: it can only drop a record, never add one.
 */
export function registrableUnit(hostname: string): string | null {
  const host = canonicalHost(hostname);
  if (!host || host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const bare = host.replace(/^www\./, "");
  const labels = bare.split(".");
  if (labels.length < 2) return null;
  if (TENANT_PLATFORMS.some(platform => bare === platform || bare.endsWith(`.${platform}`))) return bare;
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join(".") : lastTwo;
}

/** The units of a list of addresses, for the hosts that already hold a reviewed record. */
export function unitsOfUrls(urls: readonly string[]): Set<string> {
  const units = new Set<string>();
  for (const url of urls) {
    try {
      const unit = registrableUnit(new URL(url).hostname);
      if (unit) units.add(unit);
    } catch {
      // An address that is not a URL names no host.
    }
  }
  return units;
}

type Selection = {
  id: string;
  displayName: string;
  summary: string | null;
  category: string | null;
  cardUrl: URL;
  endpointUrl: URL;
  /** When the registry first had the record, in milliseconds; infinite when it does not say, so it sorts last. */
  createdAtMs: number;
  /** What the registry says about itself, kept as findings. */
  signals: string[];
};

type RegistryPolicy = {
  sourceKey: A2aRegistryKey;
  label: string;
  /** The approved list endpoint, without its query. */
  listUrl: string;
  /** The registrable domains of the registry itself: a card served from there is the registry and not a discovered agent. */
  selfUnits: readonly string[];
  /** The query for page `index` (counted from 0). */
  pageQuery: (index: number) => string;
  /** The most records the registry may report before the run refuses to guess at the rest. */
  maxRecords: number;
  maxPageBytes: number;
  maxRecordBytes: number;
  /** Whether the answer carries `success: true`. */
  needsSuccessFlag: boolean;
  select: (record: Record<string, unknown>) => Selection | null;
};

function timeMs(value: unknown, scale: "iso" | "epoch-seconds"): number {
  const ms = scale === "iso" ? (typeof value === "string" ? Date.parse(value) : Number.NaN) : typeof value === "number" ? value * 1_000 : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * a2aregistry.org: the registry's own probes are the only signal, and it has no identity field. A record is taken when it is not hidden
 * or flagged, passed the conformance check, is healthy and passed the task probe, with an HTTPS card and service address.
 */
function selectCommunityRecord(record: Record<string, unknown>): Selection | null {
  if (record.hidden !== false || record.flag_count !== 0) return null;
  if (record.conformance !== true || record.is_healthy !== true) return null;
  const task = record.task_conformance;
  if (!isObject(task) || task.category !== "WORKING") return null;
  const id = boundedText(record.id, 512);
  const name = boundedText(record.name, 255);
  const card = httpsUrl(record.wellKnownURI);
  const service = httpsUrl(record.url);
  if (!id || !name || !card || !service) return null;
  const provider = isObject(record.provider) ? httpsUrl(record.provider.url) : null;
  return {
    id,
    displayName: name,
    summary: boundedText(record.description, 8_000),
    category: boundedText(record.category, 160),
    cardUrl: card,
    endpointUrl: provider ?? card,
    createdAtMs: timeMs(record.created_at, "iso"),
    signals: [
      "registry-reported conformance check: passed",
      "registry-reported health check: healthy",
      "registry-reported task probe: working",
    ],
  };
}

/**
 * api.a2a-registry.org: a record is taken when it is public, active, an A2A record the registry itself calls verified, with no failed
 * check since, and not an import with no owner. A paid placement (a spotlight, a promotion or a badge) must not shape what is taken.
 */
function selectOwnerVerifiedRecord(record: Record<string, unknown>): Selection | null {
  if (record.visibility !== "public" || record.status !== "ACTIVE" || record.protocolStd !== "a2a") return null;
  if (record.verification_level !== "verified" || record.consecutiveFailures !== 0) return null;
  if (record.owner_org_slug === "system-unclaimed") return null;
  if (record.is_spotlight === true || record.is_promoted_top === true || boundedText(record.badge_label, 160)) return null;
  const id = boundedText(record.id, 512);
  const name = boundedText(record.displayName, 255);
  const card = httpsUrl(record.manifestUrl);
  if (!id || !name || !card) return null;
  return {
    id,
    displayName: name,
    summary: boundedText(record.description, 8_000),
    category: boundedText(record.category, 160),
    cardUrl: card,
    endpointUrl: httpsUrl(record.owner_org_website) ?? card,
    createdAtMs: timeMs(record.createdAt, "epoch-seconds"),
    signals: ["registry-reported verification level: verified", "registry-reported check status: no failed check since"],
  };
}

/**
 * Bounds, from the scout's full read on 2026-11-06. a2aregistry.org: 649 records in 7 pages, the largest page 825,369 bytes and the
 * largest record 100,822 bytes. api.a2a-registry.org: 2,034 records in 21 pages, the largest page 1,098,456 bytes and the largest record
 * 185,520 bytes (it keeps a copy of each card inside the record). A registry that reports more records than the scan limit fails the run
 * and does not drop the rest without a word: raising a limit is a reviewed change.
 */
const POLICIES: Record<A2aRegistryKey, RegistryPolicy> = {
  "a2aregistry-public-api": {
    sourceKey: "a2aregistry-public-api",
    label: "a2aregistry.org community A2A registry",
    listUrl: "https://a2aregistry.org/api/agents",
    selfUnits: ["a2aregistry.org"],
    pageQuery: index => `limit=${PAGE_SIZE}&offset=${index * PAGE_SIZE}`,
    maxRecords: 2_000,
    maxPageBytes: 2 * 1024 * 1024,
    maxRecordBytes: 128 * 1024,
    needsSuccessFlag: false,
    select: selectCommunityRecord,
  },
  "a2a-registry-org-public-api": {
    sourceKey: "a2a-registry-org-public-api",
    label: "A2A Registry public API (a2a-registry.org)",
    listUrl: "https://api.a2a-registry.org/public/agents",
    selfUnits: ["a2a-registry.org"],
    // This API ignores `offset` and counts pages from 1.
    pageQuery: index => `limit=${PAGE_SIZE}&page=${index + 1}`,
    maxRecords: 5_000,
    maxPageBytes: 1.5 * 1024 * 1024,
    maxRecordBytes: 256 * 1024,
    needsSuccessFlag: true,
    select: selectOwnerVerifiedRecord,
  },
};

export function isA2aRegistrySourceKey(sourceKey: string): sourceKey is A2aRegistryKey {
  return (A2A_REGISTRY_SOURCE_KEYS as readonly string[]).includes(sourceKey);
}

/** The approved list endpoint, scan limit and page size of a registry source, for the tests and the records. */
export function a2aRegistryPolicy(sourceKey: A2aRegistryKey) {
  const { listUrl, maxRecords, maxPageBytes, maxRecordBytes } = POLICIES[sourceKey];
  return { listUrl, maxRecords, maxPageBytes, maxRecordBytes, pageSize: PAGE_SIZE };
}

async function readBoundedJson(response: Response, maxBytes: number, label: string) {
  if (!response.ok) throw new A2aRegistryValidationError(`${label} returned HTTP ${response.status}.`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
    throw new A2aRegistryValidationError(`${label} did not declare a JSON payload.`);
  }
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new A2aRegistryValidationError(`${label} page exceeds the response limit.`);
  }
  if (!response.body) throw new A2aRegistryValidationError(`${label} response had no body.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new A2aRegistryValidationError(`${label} page exceeds the response limit.`);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new A2aRegistryValidationError(`${label} page was not valid JSON.`);
  }
}

export type FetchA2aRegistryOptions = {
  /** Units (see `registrableUnit`) that already hold a reviewed record from another source: records on them are not taken. */
  skipUnits?: ReadonlySet<string>;
  /** Waits between two requests; replaced in tests. */
  pause?: (ms: number) => Promise<void>;
};

/**
 * Reads one bounded snapshot of a registry's list and returns the observations for the records the registry's rule selects. Records
 * are taken one per unit (the oldest when several share one), not on a unit that already holds a reviewed record from another
 * source, oldest first up to the intake ceiling. Counts: `discoveredCount` is the distinct records read and `rejectedCount` every one
 * of them that was not taken, so a record that qualified past the ceiling is counted there too. `qualifiedCount` is how many
 * parties qualified before the ceiling, so a run that hit it can be told from one that did not.
 */
export async function fetchA2aRegistryCatalog(source: IngestionSource, options: FetchA2aRegistryOptions = {}) {
  if (source.protocol !== "catalog" || !isA2aRegistrySourceKey(source.sourceKey)) {
    throw new A2aRegistryValidationError("Source is not an approved A2A registry catalog.");
  }
  const policy = POLICIES[source.sourceKey];
  if (source.state !== "active") throw new A2aRegistryValidationError("Only active sources may be fetched.");
  const sourceUrl = new URL(source.rootUrl);
  if (sourceUrl.toString() !== policy.listUrl || source.allowedHostname !== sourceUrl.hostname) {
    throw new A2aRegistryValidationError("Stored catalog source policy does not match the approved registry.");
  }
  await assertPublicHostname(source.allowedHostname);

  const pause = options.pause ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const maxPages = Math.ceil(policy.maxRecords / PAGE_SIZE);
  const seen = new Set<string>();
  const taken: Array<{ selection: Selection; unit: string; rawText: string; httpStatus: number }> = [];
  let discoveredCount = 0;
  let requestCount = 0;
  let walked = 0;
  let total = Number.POSITIVE_INFINITY;

  for (let index = 0; index < maxPages && walked < total; index += 1) {
    if (index > 0) await pause(A2A_REGISTRY_PAUSE_MS);
    requestCount += 1;
    const { response, body } = await fetchUnderDeadline<unknown>({
      url: `${policy.listUrl}?${policy.pageQuery(index)}`,
      init: {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "Nooscape-Source-Indexer/0.2 (+https://nooscape.si)" },
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
      isDomainError: error => error instanceof A2aRegistryValidationError,
      onTimeout: () => new A2aRegistryValidationError(`${policy.label} request timed out.`),
      onFailure: () => new A2aRegistryValidationError(`${policy.label} request failed without following redirects.`),
      read: response => readBoundedJson(response, policy.maxPageBytes, policy.label),
    });
    if (!isObject(body) || !Array.isArray(body.agents) || (policy.needsSuccessFlag && body.success !== true)) {
      throw new A2aRegistryValidationError(`${policy.label} page did not have the documented shape.`);
    }
    if (body.agents.length > PAGE_SIZE) {
      throw new A2aRegistryValidationError(`${policy.label} page held more records than the page size.`);
    }
    if (index === 0) {
      if (typeof body.total !== "number" || !Number.isSafeInteger(body.total) || body.total < 0) {
        throw new A2aRegistryValidationError(`${policy.label} did not report a record total.`);
      }
      if (body.total > policy.maxRecords) {
        throw new A2aRegistryValidationError(`${policy.label} reports ${body.total} records, over the approved scan limit of ${policy.maxRecords}.`);
      }
      total = body.total;
    }
    if (body.agents.length === 0) break;
    walked += body.agents.length;

    for (const record of body.agents) {
      const id = isObject(record) ? boundedText(record.id, 512) : null;
      if (!isObject(record) || !id) {
        discoveredCount += 1;
        continue;
      }
      // A registry that gains records while it is read shifts its pages; a record seen twice is one record.
      if (seen.has(id)) continue;
      seen.add(id);
      discoveredCount += 1;
      const rawText = JSON.stringify(record);
      if (Buffer.byteLength(rawText) > policy.maxRecordBytes) continue;
      const selection = policy.select(record);
      if (!selection) continue;
      const unit = registrableUnit(selection.cardUrl.hostname);
      if (!unit || policy.selfUnits.includes(unit)) continue;
      taken.push({ selection, unit, rawText, httpStatus: response.status });
    }
  }
  if (walked < total) {
    throw new A2aRegistryValidationError(`${policy.label} list ended after ${walked} of the ${total} records it reported.`);
  }

  // One per unit, the oldest; none on a unit another source's reviewed record already holds; oldest first up to the ceiling.
  const byAge = (a: { selection: Selection }, b: { selection: Selection }) =>
    a.selection.createdAtMs < b.selection.createdAtMs ? -1 : a.selection.createdAtMs > b.selection.createdAtMs ? 1 : a.selection.id < b.selection.id ? -1 : 1;
  const oldestPerUnit = new Map<string, (typeof taken)[number]>();
  for (const entry of [...taken].sort(byAge)) {
    if (options.skipUnits?.has(entry.unit) || oldestPerUnit.has(entry.unit)) continue;
    oldestPerUnit.set(entry.unit, entry);
  }
  const chosen = Array.from(oldestPerUnit.values()).slice(0, A2A_REGISTRY_MAX_ACCEPTED_RECORDS);

  const observedAt = new Date();
  const observations: Array<{ candidate: CatalogNormalizedCandidate; observation: RawObservationInput }> = [];
  for (const { selection, rawText, httpStatus } of chosen) {
    const contentHash = createHash("sha256").update(rawText).digest("hex");
    const stored = await storagePut(`nooscape/raw/catalog/${source.id}/${contentHash}.json`, rawText, "application/json");
    const specialties = selection.category ? [selection.category] : [];
    observations.push({
      candidate: {
        displayName: selection.displayName,
        handle: handleFromRecord(selection.displayName, selection.id),
        summary: selection.summary,
        primaryCapability: selection.category,
        specialties,
        agentCardUrl: selection.cardUrl.toString(),
        endpointUrl: selection.endpointUrl.toString(),
        authentication: null,
        externalRecordId: selection.id,
        catalogSignals: selection.signals,
      },
      observation: {
        canonicalLocator: `${policy.listUrl}#${encodeURIComponent(selection.id)}`,
        contentHash,
        rawObjectKey: stored.key,
        contentType: "application/json",
        httpStatus,
        validationStatus: "valid",
        validationFindings: [
          `Retained from ${policy.label}.`,
          ...selection.signals.map(signal => `${signal}; not independently verified by Nooscape.`),
        ],
        observedAt,
      },
    });
  }
  return { observations, discoveredCount, qualifiedCount: oldestPerUnit.size, rejectedCount: discoveredCount - observations.length, requestCount };
}

function handleFromRecord(name: string, recordId: string) {
  const label = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 144);
  return `${label || "registry-agent"}-${createHash("sha256").update(recordId).digest("hex").slice(0, 10)}`;
}
