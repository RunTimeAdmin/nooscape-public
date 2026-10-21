import { createHash } from "node:crypto";
import { storagePut } from "../storage";
import { assertPublicHostname } from "./a2a";
import type { IngestionSource } from "../../drizzle/schema";
import type { DirectoryEntryDraft, RawObservationInput, SolanaRegistryCandidate } from "./types";

export const METAPLEX_LIST_URL = "https://api.metaplex.com/v1/agents?page=1&pageSize=24&sort=latest&activeOnly=true";
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
/** Each retained page stays within this fixed record boundary. */
const MAX_RECORDS = 24;
/**
 * Reviewed scan bounds for one snapshot. A 2026-10-09 live probe showed the list
 * runs 480+ records deep, but pages past the newest few are dominated by
 * data:-URI auto-registrations (ERC-8004 registration-v1 metadata inlined by the
 * registrar) which the canonical-HTTPS locator rule rejects. Ten pages cover the
 * structurally eligible newest head (42 accepted at probe time) with headroom
 * for the list's composition to shift. Deeper growth requires an explicit
 * ceiling review, not a larger silent default.
 */
export const METAPLEX_MAX_PAGES = 10;
/** Hard accepted-records ceiling for one snapshot, bounding operator review size. */
export const METAPLEX_MAX_ACCEPTED_RECORDS = 192;
const REQUEST_TIMEOUT_MS = 20_000;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class MetaplexRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaplexRegistryValidationError";
  }
}

type MetaplexAgent = Record<string, unknown>;

function boundedText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : null;
}

function parsePublicHttpsUrl(value: unknown, label: string) {
  const raw = boundedText(value, 2_048);
  if (!raw) throw new MetaplexRegistryValidationError(`${label} is missing.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MetaplexRegistryValidationError(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new MetaplexRegistryValidationError(`${label} must be a canonical HTTPS URL.`);
  }
  return url;
}

function handleFromMint(name: string, mintAddress: string) {
  const label = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 132);
  return `${label || "solana-agent"}-${mintAddress.slice(0, 10).toLowerCase()}`;
}

function validateMetaplexOrigin(url: URL, label: string) {
  if (url.hostname !== "api.metaplex.com") {
    throw new MetaplexRegistryValidationError(`${label} must remain on the approved Metaplex API origin.`);
  }
  return url.toString();
}

/** Parses public index metadata only; it does not dereference the A2A endpoint. */
export function normalizeMetaplexAgent(record: unknown): SolanaRegistryCandidate | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const agent = record as MetaplexAgent;
  if (agent.network !== "solana-mainnet" || agent.isActive !== true) return null;

  const mintAddress = boundedText(agent.mintAddress, 64);
  const displayName = boundedText(agent.name, 255);
  if (!mintAddress || !SOLANA_ADDRESS.test(mintAddress) || !displayName) return null;

  let agentMetadataUrl: string;
  try {
    agentMetadataUrl = validateMetaplexOrigin(parsePublicHttpsUrl(agent.agentMetadataUri, "Metaplex agent metadata URL"), "Metaplex agent metadata URL");
  } catch {
    return null;
  }

  const metadata = agent.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
    ? agent.metadata as Record<string, unknown>
    : {};
  const services = Array.isArray(metadata.services) ? metadata.services : [];
  const a2aService = services.find((service): service is Record<string, unknown> => Boolean(
    service && typeof service === "object" && !Array.isArray(service) && (service as Record<string, unknown>).name === "A2A",
  ));
  let agentCardUrl: string | null = null;
  if (a2aService?.endpoint) {
    try {
      agentCardUrl = validateMetaplexOrigin(parsePublicHttpsUrl(a2aService.endpoint, "Metaplex A2A service URL"), "Metaplex A2A service URL");
    } catch {
      // A declared endpoint outside the fixed registry origin is intentionally not stored.
      agentCardUrl = null;
    }
  }

  const authority = boundedText(agent.authority, 64);
  const walletAddress = boundedText(agent.walletAddress, 64);
  const signals = [
    "Indexed by Metaplex public agent registry.",
    boundedText(metadata.type, 255) ? "Registry reports an ERC-8004-compatible metadata type; Nooscape has not independently verified it." : null,
    authority && SOLANA_ADDRESS.test(authority) ? "Registry reports a Solana authority address; Nooscape has not independently verified control." : null,
    walletAddress && SOLANA_ADDRESS.test(walletAddress) ? "Registry reports a Solana wallet address; Nooscape has not independently verified control." : null,
    agentCardUrl ? "Registry declares an A2A service URL; Nooscape did not invoke it." : null,
  ].filter((signal): signal is string => Boolean(signal));

  return {
    displayName,
    handle: handleFromMint(displayName, mintAddress),
    summary: boundedText(agent.description, 8_000) ?? boundedText(metadata.description, 8_000),
    primaryCapability: "Solana registry metadata",
    specialties: ["Solana", "Metaplex registry", agentCardUrl ? "A2A declared" : null].filter((item): item is string => Boolean(item)),
    mintAddress,
    authority: authority && SOLANA_ADDRESS.test(authority) ? authority : null,
    walletAddress: walletAddress && SOLANA_ADDRESS.test(walletAddress) ? walletAddress : null,
    agentMetadataUrl,
    agentCardUrl,
    network: "solana-mainnet",
    sourceSignals: signals,
  };
}

export function parseMetaplexListPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MetaplexRegistryValidationError("Metaplex response must be a JSON object.");
  }
  const root = payload as Record<string, unknown>;
  const data = root.data;
  if (root.success !== true || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new MetaplexRegistryValidationError("Metaplex response does not declare a successful agent list.");
  }
  const agents = (data as Record<string, unknown>).agents;
  if (!Array.isArray(agents) || agents.length > MAX_RECORDS) {
    throw new MetaplexRegistryValidationError("Metaplex response exceeds the approved 24-record page boundary.");
  }

  const candidates = agents.map(normalizeMetaplexAgent).filter((candidate): candidate is SolanaRegistryCandidate => Boolean(candidate));
  return { discoveredCount: agents.length, rejectedCount: agents.length - candidates.length, candidates };
}

async function readLimitedJson(response: Response) {
  if (!response.body) throw new MetaplexRegistryValidationError("Metaplex response had no body.");
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new MetaplexRegistryValidationError("Metaplex response exceeds the 1 MiB response limit.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MetaplexRegistryValidationError("Metaplex response exceeds the 1 MiB response limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))));
  } catch {
    throw new MetaplexRegistryValidationError("Metaplex response was not valid JSON.");
  }
}

/** Derives an approved same-origin page URL by rewriting only the page parameter. */
export function metaplexPageUrl(rootUrl: string, page: number) {
  let url: URL;
  try {
    url = new URL(rootUrl);
  } catch {
    throw new MetaplexRegistryValidationError("Metaplex source rootUrl must be a valid URL.");
  }
  validateMetaplexOrigin(url, "Metaplex list URL");
  url.searchParams.set("page", String(page));
  return url.toString();
}

/**
 * Builds master-directory acknowledgements from raw registry records, including
 * the ones normalizeMetaplexAgent must reject (inline data: metadata, missing
 * mint-adjacent fields). An entry only asserts "this registration is out
 * there" — never a reviewed record, map placement, or trust tier.
 */
export function metaplexDirectoryDrafts(agents: unknown[]): DirectoryEntryDraft[] {
  const drafts: DirectoryEntryDraft[] = [];
  for (const record of agents) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const agent = record as MetaplexAgent;
    const mintAddress = boundedText(agent.mintAddress, 64);
    if (!mintAddress || !SOLANA_ADDRESS.test(mintAddress)) continue;
    const displayName = boundedText(agent.name, 255) ?? `Unnamed registry agent ${mintAddress.slice(0, 10)}`;
    let locatorHost: string | null = null;
    if (typeof agent.agentMetadataUri === "string" && agent.agentMetadataUri.startsWith("https://")) {
      try {
        locatorHost = new URL(agent.agentMetadataUri).hostname.toLowerCase();
      } catch {
        locatorHost = null;
      }
    }
    const active = agent.isActive === true;
    const draft: DirectoryEntryDraft = {
      externalKey: mintAddress,
      displayName,
      locatorHost,
      sourceSignalNote:
        typeof agent.agentMetadataUri === "string" && agent.agentMetadataUri.startsWith("data:")
          ? "Registry record with inline data: metadata; acknowledged only."
          : active
            ? "Active registry record below the evidence bar; acknowledged only."
            : "Inactive registry record; acknowledged only.",
    };
    drafts.push(draft);
  }
  return drafts;
}

/** Fetches one registry page and reads its bounded body under the armed timer. */
async function fetchMetaplexPage(pageUrl: string) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(pageUrl, {
      method: "GET",
      redirect: "error",
      signal: timeout.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Nooscape-Source-Indexer/0.3 (+https://nooscape.si)",
      },
    });
    if (!response.ok) throw new MetaplexRegistryValidationError(`Metaplex registry returned HTTP ${response.status}.`);
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new MetaplexRegistryValidationError("Metaplex registry did not declare a JSON response.");
    }
    // The body read stays under the armed timer: a stalled body aborts exactly
    // like the header phase.
    return { status: response.status, payload: await readLimitedJson(response) };
  } catch (error) {
    if (error instanceof MetaplexRegistryValidationError) throw error;
    if (timeout.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new MetaplexRegistryValidationError("Metaplex registry request timed out.");
    }
    throw new MetaplexRegistryValidationError("Metaplex registry request failed without following redirects.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a bounded multi-page snapshot of the approved registry: every page stays
 * within the fixed 24-record boundary and at most METAPLEX_MAX_PAGES pages are
 * fetched. It never follows redirects, scans chain RPC, or dereferences
 * per-agent metadata and A2A service URLs. The same pages also yield
 * master-directory acknowledgements for records the evidence bar rejects.
 */
export async function fetchMetaplexRegistry(source: IngestionSource) {
  if (source.protocol !== "solana_registry" || source.sourceKey !== "metaplex-solana-agent-registry") {
    throw new MetaplexRegistryValidationError("Source is not the approved Metaplex Solana registry.");
  }
  if (source.state !== "active") throw new MetaplexRegistryValidationError("Only active sources may be fetched.");
  if (source.rootUrl !== METAPLEX_LIST_URL || source.allowedHostname !== "api.metaplex.com") {
    throw new MetaplexRegistryValidationError("Stored Metaplex source policy does not match the approved registry page.");
  }
  await assertPublicHostname(source.allowedHostname);

  const candidates: SolanaRegistryCandidate[] = [];
  const seenMints = new Set<string>();
  const directorySeen = new Map<string, DirectoryEntryDraft>();
  let discoveredCount = 0;
  let pagesFetched = 0;
  let firstPageStatus = 0;

  for (let page = 1; page <= METAPLEX_MAX_PAGES; page += 1) {
    const fetched = await fetchMetaplexPage(metaplexPageUrl(source.rootUrl, page));
    if (page === 1) firstPageStatus = fetched.status;
    const payload = fetched.payload;
    const pageSnapshot = parseMetaplexListPayload(payload);
    pagesFetched = page;
    discoveredCount += pageSnapshot.discoveredCount;
    for (const candidate of pageSnapshot.candidates) {
      if (seenMints.has(candidate.mintAddress)) continue;
      seenMints.add(candidate.mintAddress);
      candidates.push(candidate);
    }
    const rawAgents = (payload as { data?: { agents?: unknown } }).data?.agents;
    if (Array.isArray(rawAgents)) {
      for (const draft of metaplexDirectoryDrafts(rawAgents)) {
        if (!directorySeen.has(draft.externalKey)) directorySeen.set(draft.externalKey, draft);
      }
    }
    // A short page is the registry's end; the accepted ceiling bounds review size.
    if (pageSnapshot.discoveredCount < MAX_RECORDS || candidates.length >= METAPLEX_MAX_ACCEPTED_RECORDS) break;
  }
  if (candidates.length > METAPLEX_MAX_ACCEPTED_RECORDS) candidates.length = METAPLEX_MAX_ACCEPTED_RECORDS;

  const observedAt = new Date();
  const observations: Array<{ candidate: SolanaRegistryCandidate; observation: RawObservationInput }> = [];
  for (const candidate of candidates) {
    const rawText = JSON.stringify(candidate);
    const contentHash = createHash("sha256").update(rawText).digest("hex");
    const stored = await storagePut(`nooscape/raw/solana-registry/${source.id}/${contentHash}.json`, rawText, "application/json");
    observations.push({
      candidate,
      observation: {
        canonicalLocator: candidate.agentMetadataUrl,
        contentHash,
        rawObjectKey: stored.key,
        contentType: "application/json",
        httpStatus: firstPageStatus,
        validationStatus: "valid",
        validationFindings: [
          `Bounded ${pagesFetched}-page Metaplex public registry scan retained (each page within the approved 24-record boundary).`,
          "Nooscape did not perform an on-chain RPC query, dereference a per-agent document, or invoke an A2A endpoint.",
          ...candidate.sourceSignals,
        ],
        observedAt,
      },
    });
  }
  return { discoveredCount, rejectedCount: discoveredCount - candidates.length, observations, pagesFetched, directory: Array.from(directorySeen.values()) };
}
