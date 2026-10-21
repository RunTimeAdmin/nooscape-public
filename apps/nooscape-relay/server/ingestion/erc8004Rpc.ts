import { fetchUnderDeadline } from "./deadlineFetch";
import type { Erc8004Chain } from "./erc8004Chains";

/**
 * Keyed JSON-RPC client for the ERC-8004 identity pass on one EVM chain.
 *
 * A provider's endpoint carries the account key in its URL path, so the URL lives only in the environment variable the chain
 * entry names, and the central rule of this module is that nothing it throws, and nothing derived from a provider response, can
 * contain it: error messages are fixed strings built from the chain's label, the method name and an HTTP status, and any
 * provider-supplied text is scrubbed of long tokens and capped before it is surfaced.
 *
 * The chain is an argument. Its timeout, response cap and retry ladder come from its entry (erc8004Chains.ts), and the words of
 * every message from its label, so a second chain's messages read as that chain's.
 */

/** Base class: every failure here is a fixed, URL-free message. The name says which chain it was (for example BscRpcError). */
export class Erc8004RpcError extends Error {
  constructor(message: string, name = "Erc8004RpcError") {
    super(message);
    this.name = name;
  }
}

/** The RPC edge answered with a non-success HTTP status; carries it for transient classification. */
export class Erc8004RpcHttpError extends Erc8004RpcError {
  readonly status: number;

  constructor(status: number, message: string, name = "Erc8004RpcHttpError") {
    super(message, name);
    this.status = status;
  }
}

/**
 * The provider refused a log query as too wide. `block_range` means the window exceeded the provider's hard block ceiling (a bug
 * in the planner, since the planner never exceeds it); `result_size` means too many results or too large a response, which a
 * narrower window can fix.
 */
export class Erc8004RpcRangeError extends Erc8004RpcError {
  readonly reason: "block_range" | "result_size";

  constructor(reason: "block_range" | "result_size", message: string, name = "Erc8004RpcRangeError") {
    super(message, name);
    this.reason = reason;
  }
}

export class Erc8004RpcNotConfiguredError extends Erc8004RpcError {
  constructor(message: string, name = "Erc8004RpcNotConfiguredError") {
    super(message, name);
  }
}

/**
 * The request ran out of time. A class of its own so that a chain that tries a timeout again can tell it from other faults; it has
 * the message and the name every chain's RPC error has always had.
 */
export class Erc8004RpcTimeoutError extends Erc8004RpcError {}

/** The node answered, at the RPC layer, that it is busy or limiting its callers. Same message and name as any other RPC error. */
export class Erc8004RpcBusyError extends Erc8004RpcError {}

const sleepReal = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Provider-supplied text, made safe to surface: any `secrets` given (pieces of the endpoint, longest first) are removed, long
 * token-like runs are redacted, and the length is capped.
 */
export function scrubProviderText(text: string, secrets: readonly string[] = []): string {
  let scrubbed = text;
  for (const secret of secrets) scrubbed = scrubbed.split(secret).join("<redacted>");
  return scrubbed.replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>").slice(0, 200);
}

/**
 * The pieces of a private endpoint that must not come out in a provider's error text, longest first: the address, its host, its
 * path and each long segment of the path. A key in the path is usually a long token the scrubber already catches, but a path
 * prefix that keeps the node private can be shorter than that, so the pieces themselves are removed.
 */
function endpointSecrets(url: string): string[] {
  try {
    const parsed = new URL(url);
    const pieces = [url, parsed.href, parsed.host, parsed.hostname, parsed.pathname, parsed.search, ...parsed.pathname.split("/").filter(segment => segment.length >= 6)];
    return Array.from(new Set(pieces.filter(piece => piece.length >= 3))).sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

const rpcError = (chain: Erc8004Chain, message: string) => new Erc8004RpcError(message, `${chain.errorPrefix}RpcError`);
const timeoutError = (chain: Erc8004Chain, message: string) => new Erc8004RpcTimeoutError(message, `${chain.errorPrefix}RpcError`);
const busyError = (chain: Erc8004Chain, message: string) => new Erc8004RpcBusyError(message, `${chain.errorPrefix}RpcError`);

/** Words a node uses to say it is busy or is limiting its callers. JSON-RPC code -32005 is the standard "limit exceeded". */
const BUSY_WORDS = /rate.?limit|too many requests|too busy|server is busy|\bbusy\b|try again|overloaded|temporarily unavailable|capacity/i;
const httpError = (chain: Erc8004Chain, status: number, message: string) => new Erc8004RpcHttpError(status, message, `${chain.errorPrefix}RpcHttpError`);
const rangeError = (chain: Erc8004Chain, reason: "block_range" | "result_size", message: string) => new Erc8004RpcRangeError(reason, message, `${chain.errorPrefix}RpcRangeError`);
const notConfigured = (chain: Erc8004Chain, message: string) => new Erc8004RpcNotConfiguredError(message, `${chain.errorPrefix}RpcNotConfiguredError`);

/** The host a pinned chain names. A chain whose provider is derived has none of its own: the caller gives the host its source row records. */
function pinnedHost(chain: Erc8004Chain): string {
  if (chain.provider.kind !== "pinned") throw new Error(`The ${chain.chainLabel} provider is the operator's: give the host its source row records.`);
  return chain.provider.allowedHostname;
}

/** The endpoint, checked so far as its own form goes: configured, a URL, https, and no credentials in the userinfo position. */
function parseEndpoint(chain: Erc8004Chain, configured: string): URL {
  const variable = chain.rpcEnvVar;
  if (!configured) {
    throw notConfigured(chain, `${variable} is not configured, so the ${chain.chainLabel} identity pass cannot run.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw notConfigured(chain, `${variable} is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") throw notConfigured(chain, `${variable} must be an https URL.`);
  if (parsed.username || parsed.password) throw notConfigured(chain, `${variable} must not carry userinfo.`);
  return parsed;
}

/**
 * The endpoint to call. It must be configured, https, free of credentials in the userinfo position, and its host must be exactly
 * the approved source's allowed hostname, so changing the variable can never redirect the pass to a host nobody approved. For a
 * pinned chain that host is the chain's own; for a derived one it is the host the operator's source row recorded when it was
 * staged, so the caller always passes the row's. The returned string is secret and is passed straight to the request; it is never
 * logged or thrown.
 */
export function resolveRpcUrl(chain: Erc8004Chain, allowedHostname: string = pinnedHost(chain), configured: string = chain.readRpcUrl()): string {
  const parsed = parseEndpoint(chain, configured);
  if (parsed.hostname.toLowerCase() !== allowedHostname.toLowerCase()) {
    throw notConfigured(chain, `${chain.rpcEnvVar} does not point at the approved ${chain.chainLabel} RPC host.`);
  }
  return configured;
}

/**
 * What a source row for this chain records: the origin and the host. A pinned chain names them; a derived chain takes them from
 * the endpoint variable, so the operator's own host is written when they stage the source and is never in the code. Only the host
 * is kept: no port, path, query or key.
 */
export function providerPolicy(chain: Erc8004Chain, configured: string = chain.readRpcUrl()): { rootUrl: string; allowedHostname: string } {
  if (chain.provider.kind === "pinned") return { rootUrl: chain.provider.rootUrl, allowedHostname: chain.provider.allowedHostname };
  const host = parseEndpoint(chain, configured).hostname.toLowerCase();
  return { rootUrl: `https://${host}`, allowedHostname: host };
}

function classifyRpcError(chain: Erc8004Chain, method: string, error: { code?: unknown; message?: unknown }, url: string): Erc8004RpcError {
  const message = typeof error.message === "string" ? error.message : "";
  // Alchemy's "Log response size exceeded. You can make eth_getLogs requests with up to a 10,000 block range ..." mentions a block
  // range but says the response was too large, which a narrower window fixes; it is checked first for that reason.
  if (/log response size exceeded/i.test(message)) {
    return rangeError(chain, "result_size", `${chain.chainLabel} ${method} was rejected as returning too many results.`);
  }
  if (/block range/i.test(message)) {
    return rangeError(chain, "block_range", `${chain.chainLabel} ${method} was rejected as exceeding the provider's block range.`);
  }
  if (/more than [0-9]+ results|too many results|response size|result size|exceed(s|ed)? (the )?(max|limit)/i.test(message)) {
    return rangeError(chain, "result_size", `${chain.chainLabel} ${method} was rejected as returning too many results.`);
  }
  // A vendor's host is public. An operator's own is not, so for a chain whose provider is derived the endpoint's pieces go as well.
  const shown = message ? `: ${scrubProviderText(message, chain.provider.kind === "derived" ? endpointSecrets(url) : [])}` : "";
  const text = `${chain.chainLabel} ${method} failed at the RPC layer${shown}`;
  // Only the class differs: the message and name are the same for a busy node as for any other RPC-layer fault.
  return error.code === -32005 || BUSY_WORDS.test(message) ? busyError(chain, text) : rpcError(chain, text);
}

/**
 * The explanation a provider gives in the body of a refusal that has an error status, classified as an RPC-layer answer is, or
 * null when there is none to read. The body is small by nature and held to the response cap all the same.
 */
async function explainRefusal(chain: Erc8004Chain, method: string, response: Response, url: string): Promise<Erc8004RpcError | null> {
  try {
    const text = await response.text();
    if (text.length > chain.rpc.maxResponseBytes) return null;
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } | null } | null;
    return body && typeof body === "object" && body.error ? classifyRpcError(chain, method, body.error, url) : null;
  } catch {
    return null;
  }
}

async function callOnce(chain: Erc8004Chain, url: string, method: string, params: unknown[]): Promise<unknown> {
  const label = chain.chainLabel;
  const limit = chain.rpc.maxResponseBytes;
  const { body } = await fetchUnderDeadline<unknown>({
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Nooscape-Source-Indexer/0.3 (+https://nooscape.si)" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    timeoutMs: chain.rpc.timeoutMs,
    isDomainError: error => error instanceof Erc8004RpcError,
    onTimeout: () => timeoutError(chain, `${label} ${method} request timed out.`),
    onFailure: () => rpcError(chain, `${label} ${method} request failed.`),
    read: async response => {
      if (!response.ok) {
        if (chain.rpc.readErrorBodies && !chain.rpc.retryStatuses.includes(response.status)) {
          const explained = await explainRefusal(chain, method, response, url);
          if (explained) throw explained;
        }
        throw httpError(chain, response.status, `${label} ${method} returned HTTP ${response.status}.`);
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > limit) {
        throw rangeError(chain, "result_size", `${label} ${method} response exceeds the response limit.`);
      }
      const text = await response.text();
      if (text.length > limit) {
        throw rangeError(chain, "result_size", `${label} ${method} response exceeds the response limit.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw rpcError(chain, `${label} ${method} response was not valid JSON.`);
      }
      return parsed;
    },
  });
  if (!body || typeof body !== "object") throw rpcError(chain, `${label} ${method} response is not a JSON-RPC object.`);
  const envelope = body as { result?: unknown; error?: { code?: unknown; message?: unknown } | null };
  if (envelope.error) throw classifyRpcError(chain, method, envelope.error, url);
  if (!("result" in envelope)) throw rpcError(chain, `${label} ${method} response carries no result.`);
  return envelope.result;
}

/**
 * Keeps a gap between the calls of one run: no call starts sooner than `minGapMs` after the one before it ended. A chain on a node
 * shared with something else uses it so the pass leaves room for the other's requests. `now` and `sleep` are injectable for tests.
 */
export type Pacer = { wait: () => Promise<void>; done: () => void };

export function createPacer(minGapMs: number, deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Pacer {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepReal;
  let lastEnd: number | null = null;
  return {
    async wait() {
      if (lastEnd === null) return;
      const remaining = lastEnd + minGapMs - now();
      if (remaining > 0) await sleep(remaining);
    },
    done() {
      lastEnd = now();
    },
  };
}

/** Whether a failed attempt is tried again on the ladder: a retried status always, a timeout or a busy node when the chain says so. */
function isRetryable(chain: Erc8004Chain, error: unknown): boolean {
  const { retryStatuses, retryTimeouts, retryBusy } = chain.rpc;
  if (error instanceof Erc8004RpcHttpError) return retryStatuses.includes(error.status);
  if (retryTimeouts && error instanceof Erc8004RpcTimeoutError) return true;
  if (retryBusy && error instanceof Erc8004RpcBusyError) return true;
  return false;
}

/**
 * One JSON-RPC call with a short transient-retry ladder (the chain's retried statuses, then its waits in order, with a random share
 * added when the chain asks for jitter). Every wire attempt is reported so the run's request count stays honest. `url`, `sleep`,
 * `random`, `pace` and `countAttempt` are injectable for tests; `pace` keeps a gap between the calls of a run.
 */
export async function callRpc(
  chain: Erc8004Chain,
  method: string,
  params: unknown[],
  options: { url?: string; countAttempt?: () => void; sleep?: (ms: number) => Promise<void>; random?: () => number; pace?: Pacer } = {}
): Promise<unknown> {
  const url = options.url ?? resolveRpcUrl(chain);
  const sleep = options.sleep ?? sleepReal;
  const random = options.random ?? Math.random;
  const { backoffMs, jitter } = chain.rpc;
  const attemptOnce = async () => {
    try {
      return await callOnce(chain, url, method, params);
    } finally {
      // The call has ended, answered or not; the gap is counted from here, not from the end of a wait that follows.
      options.pace?.done();
    }
  };
  for (let attempt = 0; ; attempt += 1) {
    await options.pace?.wait();
    options.countAttempt?.();
    try {
      return await attemptOnce();
    } catch (error) {
      if (attempt >= backoffMs.length || !isRetryable(chain, error)) {
        throw error;
      }
      const wait = backoffMs[attempt]!;
      await sleep(jitter ? wait * (1 + random() * jitter) : wait);
    }
  }
}
