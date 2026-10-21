/**
 * A thin client for the public Nooscape API (https://nooscape.si/api/v1). It adds no data and no logic of its own: it makes the request,
 * turns an answer that is not a success into an error that says in plain words what to do, and hands back the API's JSON untouched.
 *
 * It holds no wallet and signs nothing. An optional API key is sent as a bearer token and is never put in an error, a log or a result.
 * A request that is refused is not retried: the caller is told when to try again.
 */

export const DEFAULT_BASE_URL = "https://nooscape.si/api/v1";
export const DEFAULT_TIMEOUT_MS = 15_000;
/** The most of an answer that is read. The API's largest answers are far smaller than this. */
export const MAX_BODY_CHARS = 1_000_000;

export const CHAINS = ["robinhood", "bnb", "solana"] as const;
export type Chain = (typeof CHAINS)[number];

/** Solana addresses can be listed by more than one registry; this chooses one. */
export const SOLANA_REGISTRIES = ["solana_8004", "solana_said", "solana_registry"] as const;
export type SolanaRegistry = (typeof SOLANA_REGISTRIES)[number];

export type ErrorKind =
  | "payment_required"
  | "key_required"
  | "invalid_key"
  | "tier_required"
  | "not_found"
  | "ambiguous"
  | "bad_request"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable"
  | "timeout"
  | "network"
  | "unexpected";

/** What the API asks for in a 402: the terms of an x402 payment, as it states them. */
export type PaymentTerms = { scheme: string; network: string; asset: string; payTo: string; amount: string; usd: string | null };

export class NooscapeError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | null;
  /** Seconds the API asked the caller to wait, from Retry-After. */
  readonly retryAfterSeconds: number | null;
  readonly payment: PaymentTerms[] | null;
  readonly requiredTier: string | null;
  readonly registries: string[] | null;

  constructor(kind: ErrorKind, message: string, extra: { status?: number; retryAfterSeconds?: number | null; payment?: PaymentTerms[]; requiredTier?: string | null; registries?: string[] } = {}) {
    super(message);
    this.name = "NooscapeError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.payment = extra.payment ?? null;
    this.requiredTier = extra.requiredTier ?? null;
    this.registries = extra.registries ?? null;
  }
}

/** A USDC amount in base units (six decimals) as dollars, or null if it is not a plain integer. */
export function usdOf(amount: string): string | null {
  if (!/^[0-9]{1,18}$/.test(amount)) return null;
  const units = BigInt(amount);
  const whole = units / 1_000_000n;
  const cents = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${cents}`;
}

export type CheckSubject = { agent: { chain: Chain; id: string; registry?: SolanaRegistry } } | { wallet: string } | { url: string };

export type ClientOptions = {
  /** Sent as `Authorization: Bearer`. Never logged, never echoed. */
  apiKey?: string | undefined;
  userAgent: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function retryAfterOf(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw || !/^[0-9]{1,6}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

function paymentTermsOf(body: unknown, scrub: (value: string) => string): PaymentTerms[] {
  const accepts = isObject(body) && Array.isArray(body.accepts) ? body.accepts : [];
  return accepts.flatMap(item => {
    if (!isObject(item)) return [];
    const amount = text(item.amount);
    if (!amount) return [];
    const word = (value: unknown, fallback: string) => scrub(text(value) ?? fallback);
    return [{ scheme: word(item.scheme, "exact"), network: word(item.network, "unknown"), asset: word(item.asset, "unknown"), payTo: word(item.payTo, "unknown"), amount: scrub(amount), usd: usdOf(amount) }];
  });
}

export class NooscapeClient {
  private readonly apiKey: string | undefined;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    const key = options.apiKey?.trim();
    this.apiKey = key ? key : undefined;
    this.userAgent = options.userAgent;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  get hasKey(): boolean {
    return this.apiKey !== undefined;
  }

  /** Text taken from an answer is passed on only without the key: an answer that repeated it would otherwise carry it to the user. */
  private scrub = (value: string): string => (this.apiKey && value.includes(this.apiKey) ? value.split(this.apiKey).join("[key]") : value);

  /** GET /agents/search: a name, a host, a registry key or a wallet. */
  search(query: string, chain?: Chain): Promise<unknown> {
    const params = new URLSearchParams({ q: query });
    if (chain) params.set("chain", chain);
    return this.request("GET", `/agents/search?${params.toString()}`);
  }

  /** GET /agents/{chain}/{id}. */
  agent(chain: Chain, id: string, registry?: SolanaRegistry): Promise<unknown> {
    return this.request("GET", `/agents/${encodeURIComponent(chain)}/${encodeURIComponent(id)}${registry ? `?registry=${registry}` : ""}`);
  }

  /** GET /agents/{chain}/{id}/history. Needs a key. */
  history(chain: Chain, id: string, registry?: SolanaRegistry): Promise<unknown> {
    return this.request("GET", `/agents/${encodeURIComponent(chain)}/${encodeURIComponent(id)}/history${registry ? `?registry=${registry}` : ""}`);
  }

  /** POST /check. Needs a Pro key or an x402 payment, which this client does not make. */
  check(subject: CheckSubject, chain?: Chain): Promise<unknown> {
    return this.request("POST", "/check", { ...subject, ...(chain ? { chain } : {}) });
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": this.userAgent };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      // No redirect is followed: the key is only ever sent to the address that was configured.
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw new NooscapeError("timeout", `The Nooscape API did not answer within ${Math.round(this.timeoutMs / 1000)} seconds. Try again shortly.`);
      throw new NooscapeError("network", "Could not reach the Nooscape API. Check the network connection and try again.");
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      throw new NooscapeError("network", "The Nooscape API's answer was cut off. Try again.", { status: response.status });
    }
    if (raw.length > MAX_BODY_CHARS) throw new NooscapeError("unexpected", "The Nooscape API's answer was larger than expected and was not read.", { status: response.status });

    let parsed: unknown = null;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (response.ok) {
      if (parsed === null) throw new NooscapeError("unexpected", "The Nooscape API answered with something that is not JSON.", { status: response.status });
      return parsed;
    }
    throw this.failure(response.status, parsed, response.headers);
  }

  private failure(status: number, body: unknown, headers: Headers): NooscapeError {
    const error = isObject(body) && isObject(body.error) ? body.error : null;
    const code = text(error?.code);
    const rawMessage = text(error?.message);
    const apiMessage = rawMessage === null ? null : this.scrub(rawMessage);
    const retryAfter = retryAfterOf(headers);

    if (status === 402) {
      const payment = paymentTermsOf(body, this.scrub);
      return new NooscapeError("payment_required", "", { status, payment });
    }
    if (status === 401) {
      if (code === "invalid_key") return new NooscapeError("invalid_key", "The API key in NOOSCAPE_API_KEY was refused: it is not valid, or it has been ended. Make a new one at https://nooscape.si/developers/keys.", { status });
      return new NooscapeError("key_required", "This needs an API key. Set the NOOSCAPE_API_KEY environment variable to a key (a free key is at https://nooscape.si/developers/keys).", { status });
    }
    if (status === 403 && code === "tier_required") {
      const required = text(isObject(error) ? error.required_tier : null);
      const yours = headers.get("x-api-tier");
      return new NooscapeError("tier_required", `This needs a ${required ?? "higher"} key${yours ? `, and the key in use is a ${yours} key` : ""}. Paid tiers are arranged by email: see https://nooscape.si/developers/keys.`, { status, requiredTier: required });
    }
    if (status === 404) return new NooscapeError("not_found", "No listed agent matches that. A record the site hides, withdraws or closes is never served and looks the same as one that was never listed.", { status });
    if (status === 409) {
      const registries = Array.isArray(isObject(error) ? error.registries : null) ? ((error as Json).registries as unknown[]).filter((item): item is string => typeof item === "string") : [];
      return new NooscapeError("ambiguous", `More than one registry lists that address${registries.length ? ` (${registries.join(", ")})` : ""}. Say which with the registry argument.`, { status, registries });
    }
    if (status === 429) {
      const wait = retryAfter === null ? "shortly" : `in ${retryAfter} seconds`;
      if (code === "quota_exceeded") return new NooscapeError("quota_exceeded", `This key has used its requests for today. The count restarts at 00:00 UTC (try again ${wait}).`, { status, retryAfterSeconds: retryAfter });
      return new NooscapeError("rate_limited", `The Nooscape API is limiting requests. Try again ${wait}. This server does not retry.`, { status, retryAfterSeconds: retryAfter });
    }
    if (status >= 500) {
      const wait = retryAfter === null ? "shortly" : `in ${retryAfter} seconds`;
      return new NooscapeError("unavailable", `The Nooscape API cannot answer right now (HTTP ${status}). Try again ${wait}.`, { status, retryAfterSeconds: retryAfter });
    }
    if (status === 400) return new NooscapeError("bad_request", `The Nooscape API refused the request: ${apiMessage ?? "it is not valid"}.`, { status });
    return new NooscapeError("unexpected", `The Nooscape API answered HTTP ${status}${apiMessage ? `: ${apiMessage}` : ""}.`, { status });
  }
}
