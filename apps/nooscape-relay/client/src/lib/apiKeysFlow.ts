import { API_TIERS, KEY_PATTERN, type ApiTier } from "@shared/apiKey";
import { GENERIC_ERROR_LINE } from "./claimFlow";

/**
 * The API keys page's words and its one read (docs/data-access-2026-10-19.md, stage D2). The page makes a key through the site's own
 * server, shows it once, and looks a key's use up through the public API the way any caller would. Nothing here is saved in the
 * browser: the key lives in the page's memory until the page is closed. client/src/lib/apiKeysClient.test.ts holds these lines to the
 * code and to the Privacy page.
 */

export const KEYS_PATH = "/developers/keys";

export const SHOWN_ONCE_LINE = "This is the only time the key is shown. Nooscape keeps a hash of it and cannot show it again. If you lose it, end it and make another.";
export const KEEP_SAFE_LINE = "Treat it like a password: keep it out of any page or repository other people can read.";
export const NOTHING_SAVED_LINE = "This page saves nothing in your browser. Close it and the key is gone from the screen.";
export const EMAIL_USE_LINE = "Your email is kept with the key and used only to write to you about it. No email is sent to confirm it, and it is not checked.";
export const USAGE_COUNTS_LINE = "Looking up the use of a key counts as one request against it.";
export const NEVER_CHANGES_LINE = "A key raises how much you can ask. It never changes what the API says: payment never changes a record, a tier or an evidence level.";
export const PAID_TIERS_LINE = "The Builder and Pro tiers are arranged by email. No prices are set yet.";
export const CHECK_TIER_LINE =
  "The pre-flight check, which gives dated facts about an agent, a wallet or an endpoint address, needs a Pro key. With no key it can be paid for per call where pay per call is on: see the developer page.";
export const KEY_UNLOCKS = ["a batch lookup of up to 25 agents in one request", "an agent's history: its registry events and the public history of its claims", "the use of your own key"] as const;

/** The tiers as the page lists them: the name, what it allows, and the plain-words line. */
export const tierLines = (): Array<{ tier: ApiTier; label: string; line: string }> =>
  (Object.keys(API_TIERS) as ApiTier[]).map(tier => ({
    tier,
    label: API_TIERS[tier].label,
    line: `${API_TIERS[tier].perMinute.toLocaleString("en-US")} a minute, ${API_TIERS[tier].perDay.toLocaleString("en-US")} a day`,
  }));

export const looksLikeKey = (text: string) => KEY_PATTERN.test(text.trim());

export const curlFor = (key: string, origin: string) => `curl -H "Authorization: Bearer ${key}" "${origin}/api/v1/agents/batch" \\\n  -d '{"agents":[{"chain":"robinhood","id":"7"}]}' -H "Content-Type: application/json"`;

export type UsageView = {
  prefix: string;
  tier: string;
  perMinute: number;
  perDay: number;
  today: { date: string; used: number; remaining: number; limit: number; resetsAt: string };
  days: Array<{ date: string; total: number; byEndpoint: Record<string, number> }>;
};

/** A lookup that failed, with words for the visitor. The message never holds the key. */
export class KeyLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyLookupError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const numberOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const textOf = (value: unknown) => (typeof value === "string" ? value : "");

/** The use of a key, read from the public API with the key as a caller would send it. */
export async function fetchUsage(key: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<UsageView> {
  let response: Response;
  try {
    response = await fetchImpl("/api/v1/usage", { headers: { Authorization: `Bearer ${key.trim()}` } });
  } catch {
    throw new KeyLookupError(GENERIC_ERROR_LINE);
  }
  const body: unknown = await response.json().catch(() => null);
  const code = isRecord(body) && isRecord(body.error) ? textOf(body.error.code) : "";
  if (response.status === 401) throw new KeyLookupError("That key is not valid, or it has been ended.");
  if (response.status === 429) throw new KeyLookupError(code === "quota_exceeded" ? "This key has used its requests for today. The count restarts at 00:00 UTC." : "Too many requests. Wait a minute and try again.");
  if (response.status === 503) throw new KeyLookupError("Keys are not available right now. Try again shortly.");
  if (response.status !== 200 || !isRecord(body) || !isRecord(body.data)) throw new KeyLookupError(GENERIC_ERROR_LINE);
  const data = body.data;
  const keyPart = isRecord(data.key) ? data.key : {};
  const limits = isRecord(data.limits) ? data.limits : {};
  const today = isRecord(data.today) ? data.today : {};
  const days = Array.isArray(data.days) ? data.days : [];
  return {
    prefix: textOf(keyPart.prefix),
    tier: textOf(keyPart.tier),
    perMinute: numberOf(limits.per_minute),
    perDay: numberOf(limits.per_day),
    today: { date: textOf(today.date), used: numberOf(today.used), remaining: numberOf(today.remaining), limit: numberOf(today.limit), resetsAt: textOf(today.resets_at) },
    days: days.filter(isRecord).map(day => ({
      date: textOf(day.date),
      total: numberOf(day.total),
      byEndpoint: isRecord(day.by_endpoint) ? Object.fromEntries(Object.entries(day.by_endpoint).map(([name, count]) => [name, numberOf(count)])) : {},
    })),
  };
}

/** The endpoints of one day as the page lists them, most used first: "agent 3, usage 1". */
export const endpointsLine = (byEndpoint: Record<string, number>) =>
  Object.entries(byEndpoint)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, count]) => `${name} ${count.toLocaleString("en-US")}`)
    .join(", ");
