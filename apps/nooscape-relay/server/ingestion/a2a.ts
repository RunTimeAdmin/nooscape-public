import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { storagePut } from "../storage";
import { isClearlyUnsafeHostname, isForbiddenIp } from "../netGuard";
import { SAFE_FETCH_MAX_BODY_CEILING, SAFE_FETCH_TIMEOUT_MS, safeFetch, type SafeFetchDeps, type SafeFetchResult } from "../safeFetch";
import type { IngestionSource } from "../../drizzle/schema";
import type { A2aNormalizedCandidate, RawObservationInput } from "./types";

/** The most of a card that is read: the most safeFetch will keep (256 KiB). A longer card is refused, not cut short and parsed. */
const MAX_RESPONSE_BYTES = SAFE_FETCH_MAX_BODY_CEILING;
/** One deadline for DNS, the connection, the headers and the body together. It was 8 seconds before the card moved to safeFetch, which allows 5 at most. */
const REQUEST_TIMEOUT_MS = SAFE_FETCH_TIMEOUT_MS;
const AGENT_CARD_PATH = "/.well-known/agent-card.json";
const INDEXER_USER_AGENT = "Nooscape-Source-Indexer/0.1 (+https://nooscape.si)";

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

function parseCardBody(body: Buffer) {
  const rawText = new TextDecoder().decode(body);
  try {
    return { rawText, rawJson: JSON.parse(rawText) as unknown };
  } catch {
    throw new A2aValidationError("AgentCard did not contain valid JSON.");
  }
}

/** Why safeFetch brought no answer, in the adapter's own words (the messages the host checks used to give where they still apply). */
function cardRefusal(result: Extract<SafeFetchResult, { ok: false }>) {
  switch (result.reason) {
    case "forbidden_host":
      return new A2aValidationError("The A2A hostname is not publicly routable.");
    case "forbidden_address":
      return new A2aValidationError("The A2A hostname resolves to a forbidden network address.");
    case "unresolvable":
      return new A2aValidationError("The A2A hostname could not be resolved.");
    case "timeout":
      return new A2aValidationError("A2A source request timed out.");
    case "redirect_invalid":
    case "too_many_redirects":
      return new A2aValidationError("A2A source request failed without following redirects.");
    default:
      return new A2aValidationError(`A2A source request failed (${result.reason}).`);
  }
}

/**
 * Fetches one approved A2A card. It refuses redirects and stores the exact raw JSON as an immutable object. The request goes through
 * safeFetch: the name is resolved once, every answer must be public address space, and the connection is made to those answers and to
 * none other, so a host cannot answer the check with one address and the connection with another (outside review of 2 November 2026,
 * M1). The certificate must be valid for the name. `network` is for tests: the resolver and the request that safeFetch leans on.
 */
export async function fetchA2aAgentCard(source: IngestionSource, network: Partial<SafeFetchDeps> = {}) {
  if (source.protocol !== "a2a") throw new A2aValidationError("Source protocol is not A2A.");
  if (source.state !== "active") throw new A2aValidationError("Only active sources may be fetched.");

  const normalized = validateA2aSourceRoot(source.rootUrl);
  if (normalized.allowedHostname !== source.allowedHostname) {
    throw new A2aValidationError("Stored A2A host policy does not match the source root.");
  }

  const answer = await safeFetch(
    normalized.cardUrl,
    { method: "GET", accept: "application/json, application/*+json;q=0.9", userAgent: INDEXER_USER_AGENT, timeoutMs: REQUEST_TIMEOUT_MS, maxBodyBytes: MAX_RESPONSE_BYTES, maxRedirects: 0 },
    network
  );
  if (!answer.ok) throw cardRefusal(answer);
  if (answer.status < 200 || answer.status > 299) throw new A2aValidationError(`A2A source returned HTTP ${answer.status}.`);
  // safeFetch cuts a longer body at the cap and says so. A card cut short is not a card.
  if (answer.truncated) throw new A2aValidationError("AgentCard exceeds the 256 KiB response limit.");
  const { rawText, rawJson } = parseCardBody(answer.body);
  const candidate = normalizeA2aAgentCard(rawJson, normalized.cardUrl);
  const observedAt = new Date();
  const contentHash = createHash("sha256").update(rawText).digest("hex");
  const storage = await storagePut(
    `nooscape/raw/a2a/${source.id}/${contentHash}.json`,
    rawText,
    "application/json"
  );
  const contentType = answer.headers["content-type"] ?? "application/json";
  const findings = contentType.includes("json") ? [] : ["Response content type was not a JSON media type."];

  const observation: RawObservationInput = {
    canonicalLocator: normalized.cardUrl,
    contentHash,
    rawObjectKey: storage.key,
    contentType,
    httpStatus: answer.status,
    validationStatus: findings.length > 0 ? "partial" : "valid",
    validationFindings: findings,
    observedAt,
  };

  return { candidate, observation };
}
