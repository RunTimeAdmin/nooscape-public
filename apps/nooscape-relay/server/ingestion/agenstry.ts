import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { pipeline, Readable } from "node:stream";
import readline from "node:readline";
import { storagePut } from "../storage";
import { assertPublicHostname } from "./a2a";
import type { IngestionSource } from "../../drizzle/schema";
import type { CatalogNormalizedCandidate, DirectoryEntryDraft, RawObservationInput } from "./types";

const FEED_URL = "https://agenstry.com/api/feed/all.jsonl.gz";
const FEED_HOSTNAME = new URL(FEED_URL).hostname;
/**
 * Compressed-body bound for the full federation feed. A 2026-10-09 snapshot
 * measured 262,024 records at ~17.9 MiB compressed; the reader streams and
 * parses line-by-line so memory stays bounded, and this remains a hard abuse
 * ceiling rather than a scan target.
 */
const MAX_COMPRESSED_BYTES = 24 * 1024 * 1024;
/**
 * Decompressed-body bound for the same feed. Gzip can expand its input up
 * to ~1000:1, so the compressed cap above says nothing about the bytes the
 * reader is asked to buffer: without this ceiling a hostile or compromised
 * feed expands a small wire body into many times the download before the
 * walk notices. The ceiling sits far above what the bounded walk (300,000
 * lines) can legitimately consume; growth past it requires a reviewed
 * ceiling change, not a larger silent default.
 */
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
/**
 * Evidence-window bound for one snapshot. The feed interleaves record kinds
 * (mcp, skill, paid_api, workflow) across ~262k lines; the 2026-10-09 snapshot
 * showed every signal-bearing a2a_agent record (2,846 of them) inside the
 * first 10,000 lines, so a 12,000-line window covers the complete reviewed
 * intake while the master-directory walk below spans the whole feed.
 */
const MAX_RECORDS_SCANNED = 12_000;
/**
 * Whole-feed scan stop for the master-directory walk. The 2026-10-09 snapshot
 * held 262,024 lines; 300,000 bounds the walk with growth headroom.
 */
const MAX_DIRECTORY_SCAN_LINES = 300_000;
/**
 * Reviewed intake ceiling for one snapshot. A 2026-10-09 feed snapshot held 80
 * unique-provider-host signal-bearing records; the ceiling admits all of them
 * plus headroom for growth while each accepted record must still pass
 * immutable-evidence review before it can be publicly projected.
 */
export const AGENSTRY_MAX_ACCEPTED_RECORDS = 96;
/**
 * Safety bound on directory acknowledgements retained per run. The 2026-10-09
 * snapshot held 206,019 mcp + 4,691 paid_api + 2,846 a2a_agent records
 * (~213.7k acknowledged kinds); 240,000 admits all of them with headroom.
 * skill and workflow records are deliberately not acknowledged: they are
 * authored content, not agents. Growth past this bound requires a reviewed
 * ceiling change, not a larger silent default.
 */
export const AGENSTRY_MAX_DIRECTORY_ENTRIES = 240_000;
const MAX_RECORD_BYTES = 32 * 1024;
/**
 * Pre-buffer bound on the single line readline is currently assembling.
 * readline buffers a whole line into a string before the loop below ever
 * sees it, so the post-hoc MAX_RECORD_BYTES check cannot stop one
 * multi-hundred-MB line from crashing the process inside readline's line
 * assembly (V8 caps string length). A line crossing this bound
 * mid-assembly tears the download down instead; lines between
 * MAX_RECORD_BYTES and this bound still take the reject-and-continue path
 * below.
 */
const MAX_LINE_BYTES = 1024 * 1024;
/**
 * The full-feed pull moves ~17.9 MiB compressed; 120 seconds keeps the
 * documented anonymous-feed cadence intact on shared-hosting egress while
 * still bounding the request.
 */
const REQUEST_TIMEOUT_MS = 120_000;

export class AgenstryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgenstryValidationError";
  }
}

function handleFromCatalogRecord(name: string, recordId: string) {
  const label = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 144);
  const suffix = createHash("sha256").update(recordId).digest("hex").slice(0, 10);
  return `${label || "agenstry-agent"}-${suffix}`;
}

function publicHttpsUrl(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new AgenstryValidationError(`${label} must be a non-empty HTTPS URL.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgenstryValidationError(`${label} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new AgenstryValidationError(`${label} must be a canonical HTTPS URL.`);
  }
  return url;
}

function boundedText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : null;
}

function normalizedHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function normalizeRecord(record: unknown): CatalogNormalizedCandidate | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const value = record as Record<string, unknown>;
  if (value.kind !== "a2a_agent" || value.sanction_flag === true) return null;

  const externalRecordId = boundedText(value.id, 512);
  const displayName = boundedText(value.name, 255);
  if (!externalRecordId || !displayName) return null;

  let agentCardUrl: URL;
  let providerUrl: URL;
  try {
    agentCardUrl = publicHttpsUrl(value.url, "Agenstry agent-card URL");
    providerUrl = publicHttpsUrl(value.provider_url ?? value.url, "Agenstry provider URL");
  } catch {
    return null;
  }

  // A catalog's own agent card is not a discovered agent. Reject records whose
  // card is served by the catalog host itself so a directory cannot appear in
  // its own discovery results (e.g., Agenstry's self-listing).
  if (normalizedHostname(agentCardUrl.hostname) === normalizedHostname(FEED_HOSTNAME)) return null;

  const catalogSignals = [
    value.signed === true ? "source-reported signed record" : null,
    value.domain_verified === true ? "source-reported domain verification" : null,
    value.verified_owner === true ? "source-reported owner verification" : null,
  ].filter((signal): signal is string => Boolean(signal));
  // Bound the first live batch to records with an upstream signal. Nooscape retains
  // these as assertions only; it does not inherit the catalog's trust assessment.
  if (catalogSignals.length === 0) return null;

  // Only advertised specialties belong in this list. The protocol version is
  // registry metadata: the previous positional fallback (`specialties[0]`)
  // promoted version strings like "1.0" into primaryCapability whenever the
  // source omitted a category.
  const category = boundedText(value.category, 160);
  const paymentProtocol = boundedText(value.payment_protocol, 160);
  const specialties = [category, paymentProtocol].filter((item): item is string => Boolean(item));

  return {
    displayName,
    handle: handleFromCatalogRecord(displayName, externalRecordId),
    summary: boundedText(value.description, 8_000),
    primaryCapability: category,
    specialties,
    agentCardUrl: agentCardUrl.toString(),
    endpointUrl: providerUrl.toString(),
    authentication: boundedText(value.payment_protocol, 160),
    externalRecordId,
    catalogSignals,
  };
}

const DIRECTORY_KINDS = new Set(["a2a_agent", "mcp", "paid_api"]);

/**
 * Builds a master-directory acknowledgement from an acknowledged catalog kind:
 * a2a_agent cards, MCP server listings, and paid API endpoints — the surfaces
 * an agent ecosystem actually speaks through. skill files and workflow
 * templates are deliberately excluded: they are authored content, not agents.
 * The draft is deliberately weaker than normalizeRecord: an entry only asserts
 * "this agent is out there speaking" with its locator host — it never becomes
 * a reviewed record, never appears on the Atlas map, and carries no trust tier.
 */
export function agenstryDirectoryDraft(record: unknown): DirectoryEntryDraft | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const value = record as Record<string, unknown>;
  const kind = typeof value.kind === "string" ? value.kind : null;
  if (!kind || !DIRECTORY_KINDS.has(kind) || value.sanction_flag === true) return null;

  // 480 leaves room for the kind prefix below under the 512-byte externalKey
  // column bound, so a prefixed key can never overflow storage.
  const recordId = boundedText(value.id, 480);
  const displayName = boundedText(value.name, 255);
  if (!recordId || !displayName) return null;

  let locatorHost: string | null = null;
  try {
    locatorHost = publicHttpsUrl(value.url, "Agenstry record URL").hostname.toLowerCase();
  } catch {
    locatorHost = null;
  }
  if (locatorHost && normalizedHostname(locatorHost) === normalizedHostname(FEED_HOSTNAME)) return null;

  // Non-a2a kinds prefix their key so one feed id can never collide across
  // kinds under the (sourceId, externalKey) uniqueness contract.
  const externalKey = kind === "a2a_agent" ? recordId : `${kind}:${recordId}`;

  if (kind === "a2a_agent") {
    const signals = value.signed === true || value.domain_verified === true || value.verified_owner === true;
    return {
      externalKey,
      displayName,
      locatorHost,
      sourceSignalNote: signals
        ? "Source reports upstream verification signals; evidence review has not accepted the record."
        : "Observed without upstream signals; acknowledged only.",
    };
  }
  return {
    externalKey,
    displayName,
    locatorHost,
    sourceSignalNote:
      kind === "mcp"
        ? "MCP server listing observed in the public federation feed; listing host retained, service not reviewed."
        : "Paid API endpoint observed in the public federation feed; payment claims are unreviewed assertions.",
  };
}

async function readBoundedCatalog(response: Response, downloadSignal: AbortSignal) {
  if (!response.body) throw new AgenstryValidationError("Agenstry response had no body.");
  let compressedBytes = 0;
  const source = Readable.fromWeb(response.body as import("stream/web").ReadableStream<Uint8Array>);
  source.on("data", (chunk: Buffer) => {
    compressedBytes += chunk.byteLength;
    // Cut the connection at the cap instead of downloading past it; the
    // catch below reports the violation.
    if (compressedBytes > MAX_COMPRESSED_BYTES) source.destroy();
  });
  const gunzip = createGunzip();
  // pipeline — not a bare pipe — forwards a source error (transport cut,
  // fetch abort) into gunzip so the line iterator rejects; a bare pipe
  // strands the stage and the loop below would park the run forever.
  pipeline(source, gunzip, () => undefined);
  // The armed download timer's abort is the termination guarantee even when
  // the body stalls without erroring: destroying the source tears down the
  // pipeline and the iteration rejects.
  downloadSignal.addEventListener("abort", () => source.destroy());
  const lines = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  lines.on("error", () => undefined);
  // The gunzip side needs its own bounds: gzip expands its input up to
  // ~1000:1, so the wire cap above says nothing about the bytes readline is
  // asked to buffer. The running totals below trip on the expanded stream —
  // the whole body, and the single line currently being assembled — and
  // tear all three stages down: a bomb's compressed wire body is tiny, so
  // the source has usually delivered and ended long before the expanded cap
  // trips, and source.destroy() alone would let the engine inflate the
  // whole bomb. The line interface closes FIRST — a stream destroy alone
  // strands readline's pending line iterator — then the expansion engine
  // dies mid-flush and the wire is cut. The partial line readline already
  // holds is bounded by the bytes emitted so far.
  let decompressedBytes = 0;
  let inProgressLineBytes = 0;
  let decompressedLimitExceeded = false;
  let lineLimitExceeded = false;
  gunzip.on("data", (chunk: Buffer) => {
    decompressedBytes += chunk.byteLength;
    inProgressLineBytes += chunk.byteLength;
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline !== -1) inProgressLineBytes = chunk.byteLength - lastNewline - 1;
    if (decompressedBytes > MAX_DECOMPRESSED_BYTES) {
      decompressedLimitExceeded = true;
      lines.close();
      gunzip.destroy();
      source.destroy();
    } else if (inProgressLineBytes > MAX_LINE_BYTES) {
      lineLimitExceeded = true;
      lines.close();
      gunzip.destroy();
      source.destroy();
    }
  });
  const candidates: Array<{ candidate: CatalogNormalizedCandidate; rawText: string }> = [];
  const providerHosts = new Set<string>();
  const directorySeen = new Map<string, DirectoryEntryDraft>();
  let discoveredCount = 0;
  let rejectedCount = 0;

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      discoveredCount += 1;
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
        rejectedCount += 1;
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          rejectedCount += 1;
          continue;
        }
        // Evidence intake is bounded to the approved head window: every
        // a2a_agent record sits inside it, so the reviewed snapshot never
        // depends on the full-feed directory walk below.
        if (discoveredCount <= MAX_RECORDS_SCANNED) {
          const candidate = normalizeRecord(parsed);
          if (!candidate) {
            rejectedCount += 1;
          } else {
            const hostname = new URL(candidate.endpointUrl ?? candidate.agentCardUrl).hostname;
            if (!providerHosts.has(hostname) && candidates.length < AGENSTRY_MAX_ACCEPTED_RECORDS) {
              providerHosts.add(hostname);
              candidates.push({ candidate, rawText: JSON.stringify(parsed) });
            }
          }
        }
        // Directory harvest spans the whole feed: every mcp, paid_api, and
        // a2a_agent record becomes an acknowledgement, evidence-eligible or
        // not, so search can prove agents the evidence bar must reject.
        if (directorySeen.size < AGENSTRY_MAX_DIRECTORY_ENTRIES) {
          const draft = agenstryDirectoryDraft(parsed);
          if (draft && !directorySeen.has(draft.externalKey)) directorySeen.set(draft.externalKey, draft);
        }
      }
      if (discoveredCount >= MAX_DIRECTORY_SCAN_LINES) {
        source.destroy();
        break;
      }
    }
    if (decompressedLimitExceeded) {
      throw new AgenstryValidationError("Agenstry catalog exceeded the decompressed response limit.");
    }
    if (lineLimitExceeded) {
      throw new AgenstryValidationError("Agenstry catalog exceeded the decompressed line limit.");
    }
    if (compressedBytes > MAX_COMPRESSED_BYTES) {
      throw new AgenstryValidationError("Agenstry catalog exceeded the compressed response limit.");
    }
  } catch (error) {
    if (error instanceof AgenstryValidationError) throw error;
    // A mid-stream cut must never surface as a truncated-but-complete
    // snapshot: our own cap cuts (wire, expanded body, or single line), the
    // armed timer's abort, and any other early end each fail loudly with
    // their own verdict.
    if (decompressedLimitExceeded) {
      throw new AgenstryValidationError("Agenstry catalog exceeded the decompressed response limit.");
    }
    if (lineLimitExceeded) {
      throw new AgenstryValidationError("Agenstry catalog exceeded the decompressed line limit.");
    }
    if (compressedBytes > MAX_COMPRESSED_BYTES) {
      throw new AgenstryValidationError("Agenstry catalog exceeded the compressed response limit.");
    }
    if (downloadSignal.aborted) throw new AgenstryValidationError("Agenstry catalog download timed out.");
    throw new AgenstryValidationError("Agenstry catalog download ended early.");
  } finally {
    lines.close();
  }
  if (downloadSignal.aborted) throw new AgenstryValidationError("Agenstry catalog download timed out.");
  return { candidates, discoveredCount, rejectedCount, directory: Array.from(directorySeen.values()) };
}

/**
 * Reads one bounded snapshot from Agenstry's documented public federation feed.
 * The adapter never dereferences records' agent-card, provider, payment, or
 * documentation URLs; it only retains the catalog records that Agenstry served.
 * Reviewed evidence intake stays bounded to the feed head where every
 * a2a_agent record lives, while the master-directory walk spans the whole feed
 * and acknowledges every mcp, paid_api, and a2a_agent record it passes.
 */
export async function fetchAgenstryCatalog(source: IngestionSource) {
  if (source.protocol !== "catalog" || source.sourceKey !== "agenstry-public-catalog") {
    throw new AgenstryValidationError("Source is not the approved Agenstry catalog.");
  }
  if (source.state !== "active") throw new AgenstryValidationError("Only active sources may be fetched.");
  const sourceUrl = new URL(source.rootUrl);
  if (sourceUrl.toString() !== FEED_URL || source.allowedHostname !== sourceUrl.hostname) {
    throw new AgenstryValidationError("Stored catalog source policy does not match the approved feed.");
  }
  await assertPublicHostname(source.allowedHostname);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let snapshot: Awaited<ReturnType<typeof readBoundedCatalog>>;
  try {
    response = await fetch(FEED_URL, {
      method: "GET",
      redirect: "error",
      signal: timeout.signal,
      headers: {
        Accept: "application/gzip, application/x-ndjson;q=0.9",
        "User-Agent": "Nooscape-Source-Indexer/0.2 (+https://nooscape.si)",
      },
    });
    if (!response.ok) throw new AgenstryValidationError(`Agenstry catalog returned HTTP ${response.status}.`);
    if (!response.headers.get("content-type")?.toLowerCase().includes("gzip")) {
      throw new AgenstryValidationError("Agenstry catalog did not declare a gzip payload.");
    }
    // The ~18 MiB streaming download stays under the armed timer: a stalled
    // or trickling feed aborts like the header phase, and readBoundedCatalog
    // never surfaces a cut stream as a complete snapshot.
    snapshot = await readBoundedCatalog(response, timeout.signal);
  } catch (error) {
    if (error instanceof AgenstryValidationError) throw error;
    if (timeout.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new AgenstryValidationError("Agenstry catalog request timed out.");
    }
    throw new AgenstryValidationError("Agenstry catalog request failed without following redirects.");
  } finally {
    clearTimeout(timer);
  }
  const observedAt = new Date();
  const observations: Array<{ candidate: CatalogNormalizedCandidate; observation: RawObservationInput }> = [];
  for (const entry of snapshot.candidates) {
    const contentHash = createHash("sha256").update(entry.rawText).digest("hex");
    const stored = await storagePut(`nooscape/raw/catalog/${source.id}/${contentHash}.json`, entry.rawText, "application/json");
    observations.push({
      candidate: entry.candidate,
      observation: {
        canonicalLocator: `${FEED_URL}#${encodeURIComponent(entry.candidate.externalRecordId)}`,
        contentHash,
        rawObjectKey: stored.key,
        contentType: "application/json",
        httpStatus: response.status,
        validationStatus: "valid",
        validationFindings: [
          "Retained from Agenstry public federation feed.",
          ...entry.candidate.catalogSignals.map(signal => `${signal}; not independently verified by Nooscape.`),
        ],
        observedAt,
      },
    });
  }
  return { ...snapshot, observations };
}
