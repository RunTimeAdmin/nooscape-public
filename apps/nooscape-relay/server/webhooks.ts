import { createHmac } from "node:crypto";
import { API_LICENSE } from "./apiLicense";
import { checkFetchTarget } from "./safeFetch";

/**
 * Webhooks (docs/data-access-2026-10-19.md, stage D5): the parts that need no database and no network. A key with a webhook is told, at the
 * address its owner gave, when something is recorded about a listing it watches. Nothing here changes what Nooscape says about any agent: an
 * event is a fact with its date, in the words the public API already uses, and says nothing that the API would not.
 */

export const EVENT_TYPES = ["ownership.changed", "feedback.added", "feedback.revoked", "claim.changed", "listing.removed", "listing.restored"] as const;
export type EventType = (typeof EVENT_TYPES)[number] | "ping";

/** Listings one key may watch, and how many it may add in one call. */
export const WATCH_LIMIT = 100;
export const WATCH_ADD_LIMIT = 25;
/** Seconds to wait after the first, second, ... fifth failed try. A sixth failure gives the delivery up. */
export const RETRY_AFTER_SECONDS: readonly number[] = [60, 300, 1_800, 7_200, 43_200];
export const MAX_ATTEMPTS = RETRY_AFTER_SECONDS.length + 1;
/** Failures in a row after which a webhook is turned off until its owner sets it again. */
export const DISABLE_AFTER_FAILURES = 20;
export const DELIVERY_TIMEOUT_MS = 5_000;
export const WEBHOOK_USER_AGENT = "Nooscape-Webhooks/1.0 (+https://nooscape.si/developers)";
export const MAX_URL_LENGTH = 500;
/** What the server keeps of a delivered or given-up delivery, in days. */
export const KEEP_DELIVERIES_DAYS = 30;

/** The server's secret for signing, or null when it is not set (webhooks are then off). Throws on one that is too short to be a secret. */
export function loadSigningKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = (env.WEBHOOK_SIGNING_KEY ?? "").trim();
  if (!key) return null;
  if (key.length < 32) throw new Error("WEBHOOK_SIGNING_KEY must be at least 32 characters");
  return key;
}

/**
 * The secret a key's owner verifies deliveries with. Derived, not stored: the same key and version give the same secret, so it can be
 * shown again, and a new version (a rotation) gives a new one. It is shown to the key's owner and to nobody else.
 */
export function signingSecret(signingKey: string, keyId: string, version: number): string {
  return `whsec_${createHmac("sha256", signingKey).update(`nooscape-webhook:${keyId}:${version}`).digest("base64url")}`;
}

/** The signature of one delivery: HMAC-SHA256 of "<timestamp>.<body>" under the key's secret, in hex. */
export function signature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** The headers of one try. The timestamp is the time of this try, so a receiver can refuse an old one; the body is the same on every try. */
export function deliveryHeaders(input: { secret: string; deliveryId: string; type: string; timestamp: number; body: string }): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-nooscape-event": input.type,
    "x-nooscape-delivery": input.deliveryId,
    "x-nooscape-timestamp": String(input.timestamp),
    "x-nooscape-signature": `t=${input.timestamp},v1=${signature(input.secret, input.timestamp, input.body)}`,
  };
}

/** Why an address cannot be a webhook's, in words for its owner, or null. The address is checked again by every delivery. */
export function webhookUrlProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return "url must be an https address";
  if (raw.length > MAX_URL_LENGTH) return `url must be at most ${MAX_URL_LENGTH} characters`;
  const refused = checkFetchTarget(raw);
  if (!refused) return null;
  return (
    {
      invalid_url: "url is not an address",
      not_https: "url must be https",
      credentials_in_url: "url must not carry a user name or password",
      port_not_allowed: "url must not name a port: the standard https port is the only one used",
      forbidden_host: "url must name a public host, not an address or an internal name",
    } as Record<string, string>
  )[refused.reason] ?? "url is not one that will be called";
}

/** Exponential-ish wait before the next try after `attempts` failed tries, in seconds, or null when the delivery is given up. */
export function retryAfterSeconds(attempts: number): number | null {
  return attempts >= 1 && attempts <= RETRY_AFTER_SECONDS.length ? RETRY_AFTER_SECONDS[attempts - 1]! : null;
}

type AgentRef = { chain: string; agentId: string; registry: string; entryId: string };

const STATEMENT = "A fact Nooscape recorded, with its date. It is a record, not a review, and it says nothing about whether an agent works.";
const PAGE_ORIGIN = "https://nooscape.si";

/** The JSON of one event, exactly as it is stored and sent. */
export function eventBody(input: { id: string; type: EventType; createdAt: Date; agent: AgentRef | null; data: Record<string, unknown> }): string {
  const agent = input.agent
    ? {
        chain: input.agent.chain,
        agent_id: input.agent.agentId,
        registry: input.agent.registry,
        nooscape_id: input.agent.entryId,
        page_url: `${PAGE_ORIGIN}/agents/${input.agent.entryId}`,
        links: { agent: `${PAGE_ORIGIN}/api/v1/agents/${input.agent.chain}/${input.agent.agentId}` },
      }
    : null;
  return JSON.stringify({ api_version: "v1", id: input.id, type: input.type, created_at: input.createdAt.toISOString(), agent, data: input.data, statement: STATEMENT, license: API_LICENSE });
}
