import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { storagePut } from "../storage";
import { isClearlyUnsafeHostname, isForbiddenIp } from "../netGuard";
import { fetchUnderDeadline } from "./deadlineFetch";
import type { IngestionSource } from "../../drizzle/schema";
import type { A2aNormalizedCandidate, RawObservationInput } from "./types";

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export class A2aValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2aValidationError";
  }
}

function handleFromName(name: string, hostname: string) {
  const normalized = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (normalized || hostname.replace(/[^a-z0-9]+/gi, "-").toLowerCase()).slice(0, 160);
}

function optionalHttpsUrl(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("protocol");
    return url.toString();
  } catch {
    throw new A2aValidationError(`${field} must be a valid HTTPS URL when present.`);
  }
}

/**
 * The service address a card declares. A2A 0.3 puts one at the top level (`url`); A2A 1.0 lists its interfaces in
 * `supportedInterfaces`, the preferred one first. The top-level `url` is read as before, and a card whose `url` is
 * present and not https is still refused. Without one, the first interface whose `url` is a valid https address is
 * taken. An interface that is not (a gRPC `host:port`, say) is passed over, and a card with none is not refused for
 * it: this is optional metadata, read and never called.
 */
function declaredEndpointUrl(card: Record<string, unknown>) {
  const topLevel = optionalHttpsUrl(card.url, "AgentCard url");
  if (topLevel !== null) return topLevel;
  if (!Array.isArray(card.supportedInterfaces)) return null;
  for (const entry of card.supportedInterfaces) {
    if (!entry || typeof entry !== "object") continue;
    try {
      const url = optionalHttpsUrl((entry as Record<string, unknown>).url, "AgentCard supportedInterfaces url");
      if (url !== null) return url;
    } catch {
      // Not an https address: the next interface may be.
    }
  }
  return null;
}

/**
 * Canonicalizes an administrator-supplied A2A root before it can be stored as a
 * source. The adapter only ever fetches the exact well-known card on this host.
 */
export function validateA2aSourceRoot(rootUrl: string) {
  let url: URL;
  try {
    url = new URL(rootUrl);
  } catch {
    throw new A2aValidationError("A2A source must be a valid HTTPS URL.");
  }

  if (url.protocol !== "https:") {
    throw new A2aValidationError("A2A sources must use HTTPS.");
  }
  if (url.username || url.password || url.port || isClearlyUnsafeHostname(url.hostname)) {
    throw new A2aValidationError("The A2A source hostname is not allowed.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const cardUrl = new URL(AGENT_CARD_PATH, `https://${hostname}`).toString();
  return {
    rootUrl: `https://${hostname}`,
    allowedHostname: hostname,
    cardUrl,
    sourceKey: `a2a-${hostname.replace(/[^a-z0-9]+/g, "-")}`.slice(0, 64),
  };
}

/** Ensures DNS does not resolve the approved hostname into private address space. */
export async function assertPublicHostname(hostname: string) {
  if (isClearlyUnsafeHostname(hostname)) {
    throw new A2aValidationError("The A2A hostname is not publicly routable.");
  }

  let records: Awaited<ReturnType<typeof lookup>>[];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new A2aValidationError("The A2A hostname could not be resolved.");
  }

  if (records.length === 0 || records.some(record => isForbiddenIp(record.address))) {
    throw new A2aValidationError("The A2A hostname resolves to a forbidden network address.");
  }
}

export function normalizeA2aAgentCard(raw: unknown, cardUrl: string): A2aNormalizedCandidate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new A2aValidationError("The AgentCard must be a JSON object.");
  }

  const card = raw as Record<string, unknown>;
  if (typeof card.name !== "string" || card.name.trim().length === 0 || card.name.length > 255) {
    throw new A2aValidationError("The AgentCard requires a name of at most 255 characters.");
  }

  const description =
    typeof card.description === "string" && card.description.trim().length > 0
      ? card.description.trim().slice(0, 8_000)
      : null;
  const skills = Array.isArray(card.skills)
    ? card.skills
        .filter(skill => skill && typeof skill === "object" && !Array.isArray(skill))
        .map(skill => (skill as Record<string, unknown>).name)
        .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
        .slice(0, 32)
    : [];
  const endpointUrl = declaredEndpointUrl(card);
  const securitySchemes = card.securitySchemes;
  const authentication =
    securitySchemes && typeof securitySchemes === "object" && !Array.isArray(securitySchemes)
      ? Object.keys(securitySchemes as Record<string, unknown>).slice(0, 8).join(", ") || null
      : null;

  return {
    displayName: card.name.trim(),
    handle: handleFromName(card.name.trim(), new URL(cardUrl).hostname),
    summary: description,
    primaryCapability: skills[0] ?? null,
    specialties: skills,
    agentCardUrl: cardUrl,
    endpointUrl,
    authentication,
  };
}

async function readBoundedJson(response: Response) {
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    throw new A2aValidationError("AgentCard exceeds the 256 KiB response limit.");
  }
  if (!response.body) throw new A2aValidationError("AgentCard response had no body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new A2aValidationError("AgentCard exceeds the 256 KiB response limit.");
    }
    chunks.push(value);
  }

  const rawText = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return { rawText, rawJson: JSON.parse(rawText) as unknown };
  } catch {
    throw new A2aValidationError("AgentCard did not contain valid JSON.");
  }
}

/**
 * Fetches one approved A2A card. It refuses redirects, validates the source host
 * before connecting, and stores the exact raw JSON as an immutable object.
 */
export async function fetchA2aAgentCard(source: IngestionSource) {
  if (source.protocol !== "a2a") throw new A2aValidationError("Source protocol is not A2A.");
  if (source.state !== "active") throw new A2aValidationError("Only active sources may be fetched.");

  const normalized = validateA2aSourceRoot(source.rootUrl);
  if (normalized.allowedHostname !== source.allowedHostname) {
    throw new A2aValidationError("Stored A2A host policy does not match the source root.");
  }
  await assertPublicHostname(source.allowedHostname);

  // The body read stays under the armed timer: a stalled or trickling
  // response body aborts exactly like the header phase, never hanging the
  // run on a server that sent headers and then went quiet.
  const { response, body: bounded } = await fetchUnderDeadline({
    url: normalized.cardUrl,
    init: {
      method: "GET",
      headers: {
        Accept: "application/json, application/*+json;q=0.9",
        "User-Agent": "Nooscape-Source-Indexer/0.1 (+https://nooscape.si)",
      },
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
    isDomainError: error => error instanceof A2aValidationError,
    onTimeout: () => new A2aValidationError("A2A source request timed out."),
    onFailure: () => new A2aValidationError("A2A source request failed without following redirects."),
    read: async res => {
      if (!res.ok) throw new A2aValidationError(`A2A source returned HTTP ${res.status}.`);
      return readBoundedJson(res);
    },
  });
  const { rawText, rawJson } = bounded;
  const candidate = normalizeA2aAgentCard(rawJson, normalized.cardUrl);
  const observedAt = new Date();
  const contentHash = createHash("sha256").update(rawText).digest("hex");
  const storage = await storagePut(
    `nooscape/raw/a2a/${source.id}/${contentHash}.json`,
    rawText,
    "application/json"
  );
  const contentType = response.headers.get("content-type") ?? "application/json";
  const findings = contentType.includes("json") ? [] : ["Response content type was not a JSON media type."];

  const observation: RawObservationInput = {
    canonicalLocator: normalized.cardUrl,
    contentHash,
    rawObjectKey: storage.key,
    contentType,
    httpStatus: response.status,
    validationStatus: findings.length > 0 ? "partial" : "valid",
    validationFindings: findings,
    observedAt,
  };

  return { candidate, observation };
}
