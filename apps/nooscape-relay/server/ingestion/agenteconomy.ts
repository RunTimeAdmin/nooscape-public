import { createHash } from "node:crypto";
import { storagePut } from "../storage";
import { assertPublicHostname } from "./a2a";
import { fetchUnderDeadline } from "./deadlineFetch";
import type { IngestionSource } from "../../drizzle/schema";
import type { RawObservationInput } from "./types";

const FEED_URL = "https://agenteconomy.to/data.json";
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;

class AgentEconomyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEconomyValidationError";
  }
}

async function readBoundedJson(response: Response) {
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    throw new AgentEconomyValidationError("Agent Economy payload exceeds the 256 KiB response limit.");
  }
  if (!response.body) throw new AgentEconomyValidationError("Agent Economy response had no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AgentEconomyValidationError("Agent Economy payload exceeds the 256 KiB response limit.");
    }
    chunks.push(value);
  }
  const rawText = new TextDecoder().decode(Buffer.concat(chunks));
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new AgentEconomyValidationError("Agent Economy payload was not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AgentEconomyValidationError("Agent Economy payload must be a JSON object.");
  }
  const value = payload as Record<string, unknown>;
  const meta = value.meta;
  if (typeof value.updatedAt !== "string" || !meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new AgentEconomyValidationError("Agent Economy payload is missing provenance fields.");
  }
  return { rawText, payload: value };
}

/**
 * Fetches aggregate chain/protocol context only. This source never creates agent
 * profiles, trust tiers, or identity assertions.
 */
export async function fetchAgentEconomyCensus(source: IngestionSource) {
  if (source.protocol !== "census" || source.sourceKey !== "agent-economy-public-census") {
    throw new AgentEconomyValidationError("Source is not the approved Agent Economy census.");
  }
  if (source.state !== "active") throw new AgentEconomyValidationError("Only active sources may be fetched.");
  const sourceUrl = new URL(source.rootUrl);
  if (sourceUrl.toString() !== FEED_URL || source.allowedHostname !== sourceUrl.hostname) {
    throw new AgentEconomyValidationError("Stored census source policy does not match the approved feed.");
  }
  await assertPublicHostname(source.allowedHostname);

  // The body read stays under the armed timer: a stalled body aborts exactly
  // like the header phase.
  const { response, body: bounded } = await fetchUnderDeadline({
    url: FEED_URL,
    init: {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "Nooscape-Source-Indexer/0.2 (+https://nooscape.si)" },
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
    isDomainError: error => error instanceof AgentEconomyValidationError,
    onTimeout: () => new AgentEconomyValidationError("Agent Economy request timed out."),
    onFailure: () => new AgentEconomyValidationError("Agent Economy request failed without following redirects."),
    read: async res => {
      if (!res.ok) throw new AgentEconomyValidationError(`Agent Economy returned HTTP ${res.status}.`);
      if (!res.headers.get("content-type")?.toLowerCase().includes("json")) {
        throw new AgentEconomyValidationError("Agent Economy response was not JSON.");
      }
      return readBoundedJson(res);
    },
  });
  const { rawText, payload } = bounded;
  const contentHash = createHash("sha256").update(rawText).digest("hex");
  const stored = await storagePut(`nooscape/raw/census/${source.id}/${contentHash}.json`, rawText, "application/json");
  const sourceCount = Array.isArray(payload.sources) ? payload.sources.length : 0;
  const protocolSections = Object.keys(payload).filter(key => !["updatedAt", "meta", "sources"].includes(key)).slice(0, 32);
  const observation: RawObservationInput = {
    canonicalLocator: FEED_URL,
    contentHash,
    rawObjectKey: stored.key,
    contentType: response.headers.get("content-type") ?? "application/json",
    httpStatus: response.status,
    validationStatus: "valid",
    validationFindings: [
      `Aggregate dataset updated at ${payload.updatedAt}.`,
      `Payload declares ${sourceCount} provenance sources and ${protocolSections.length} protocol sections.`,
      "Aggregate census data is not individual-agent identity or trust evidence.",
    ],
    observedAt: new Date(),
  };
  return { observation, summary: { updatedAt: payload.updatedAt, sourceCount, protocolSections } };
}
