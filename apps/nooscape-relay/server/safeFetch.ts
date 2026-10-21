import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import https from "node:https";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { isClearlyUnsafeHostname, isForbiddenIp } from "./netGuard";

/**
 * The one way Nooscape asks a third-party host a question. A check (does this endpoint answer, what does it return) is
 * informational: it records a fact with its date and never changes a tier, a place on the map or what the public sees
 * first (docs/approvals/2026-10-15-informational-use-and-bnb-map.md). The hosts are chosen by whoever registered the
 * agent, so every request is treated as hostile:
 *
 * - https only, with no userinfo and no port, to a name that could be a public DNS name (no IP literal, no single
 *   label, nothing under .local, .internal or localhost).
 * - The name is resolved once per hop and every answer must be public address space. The connection is then made to
 *   the answers that were checked and to nothing else: a custom `lookup` hands the socket only those addresses, so a
 *   host that answers differently the second time (DNS rebinding) cannot steer the connection. The TLS handshake still
 *   names the host and the certificate must be valid for it. There is no way to turn certificate checking off.
 * - A redirect is followed by hand, at most three times, each hop going through the same checks. A hop to http, to a
 *   name or an address that fails them, or without a usable Location, ends the fetch.
 * - One deadline covers the whole chain (DNS, every connection, every body), the body is read through a byte cap, and
 *   a fresh connection is made for every request (no pool, no keep-alive, no compression).
 * - The user agent names a page that says who is asking and how a host opts out. No cookie or credential is ever sent.
 *
 * A POST is for a host that asked to be called (a webhook address its owner gave us), not for a host that did not: it sends one body
 * with a few named headers, follows no redirect (a 3xx is a failure to deliver), and goes through every check above.
 *
 * `safeFetch` never throws. A host that answers badly, slowly or not at all is a result with a reason, and so is a
 * request it refused to make. A status of 400 or more is an answer, and a fact: `ok` means the host answered.
 */

/** Sent with every request. The page it names must exist before the first check runs. */
export const CHECKER_USER_AGENT = "Nooscape-Checker/1.0 (+https://nooscape.si/checker)";
export const SAFE_FETCH_TIMEOUT_MS = 5_000;
export const SAFE_FETCH_MAX_BODY_BYTES = 4 * 1024;
export const SAFE_FETCH_MAX_REDIRECTS = 3;
/** The most a caller can ask to be read. A check that needs more than this needs a decision of its own. */
export const SAFE_FETCH_MAX_BODY_CEILING = 256 * 1024;

const MAX_URL_LENGTH = 2048;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE = 1024;
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** The most a POST may send. */
export const SAFE_FETCH_MAX_POST_BYTES = 64 * 1024;
const MAX_POST_HEADERS = 12;
const POST_HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const POST_HEADER_VALUE = /^[\x20-\x7e]{1,300}$/;
const POST_USER_AGENT = /^[\x20-\x7e]{1,200}$/;
/** Headers a caller may not set: the ones the request itself decides, and anything that could carry a session or change the framing. */
const BLOCKED_POST_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "trailer", "expect", "cookie", "set-cookie", "accept-encoding", "user-agent", "proxy-authorization"]);
/** Headers that can carry a session and are never kept. */
const DROPPED_HEADERS = new Set(["set-cookie", "set-cookie2"]);
const ACCEPT_PATTERN = /^[\w!#$%&'*+.^`|~\/;=, -]{1,200}$/;
const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const HOSTNAME_PATTERN = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);

/** `value` kept between `low` and `high` if it is a finite number. NaN and Infinity (what a missing setting becomes) are not a limit, so they get `fallback`. */
function bounded(value: number | undefined, fallback: number, low: number, high: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.floor(value))) : fallback;
}

/** Why a request was refused or did not get an answer. The first group is about the URL, the second about the network, the third about politeness. */
export type SafeFetchReason =
  | "invalid_url"
  | "not_https"
  | "credentials_in_url"
  | "port_not_allowed"
  | "forbidden_host"
  | "unresolvable"
  | "forbidden_address"
  | "redirect_invalid"
  | "too_many_redirects"
  | "timeout"
  | "connection_failed"
  | "tls_failed"
  | "response_invalid"
  | "robots_disallowed"
  | "robots_unavailable"
  | "budget_exhausted";

export type SafeFetchOptions = {
  method?: "GET" | "HEAD" | "POST";
  /** POST only: what is sent (at most 64 KiB), the headers it carries (a few plain ones: no host, cookie or framing header), and the user agent. */
  body?: string;
  headers?: Record<string, string>;
  userAgent?: string;
  /** One deadline for the whole chain: DNS, every hop and every body. It can be made shorter than 5 seconds and not longer. */
  timeoutMs?: number;
  /** The most body bytes kept (4 KiB unless asked, 256 KiB at most). A longer body is cut here and the result says so. */
  maxBodyBytes?: number;
  /** The most redirects followed. It can be made lower than 3 and not higher. */
  maxRedirects?: number;
  /** An Accept header. Only plain media-type characters are allowed. */
  accept?: string;
  /**
   * Runs for each hop after its address has been checked and before anything connects. It can refuse the hop. The time it
   * takes (a wait for its turn at a host, a look at robots.txt) is not counted against the deadline or in `latencyMs`,
   * which measure the host and not the manners.
   */
  beforeRequest?: (hop: { url: URL; hop: number }) => Promise<{ ok: true } | { ok: false; reason: SafeFetchReason; detail?: string }>;
};

export type SafeFetchResult =
  | {
      ok: true;
      /** Where the last hop went. */
      url: string;
      status: number;
      /** Lower-case names, the first value of each, cut at 1 KiB. Cookies are left out. */
      headers: Record<string, string>;
      body: Buffer;
      /** The host sent more than `maxBodyBytes`; `body` and `bodySha256` cover the part that was read. */
      truncated: boolean;
      /** SHA-256 of the bytes in `body`, in hex. */
      bodySha256: string;
      /** The address the connection was made to, one of those that were checked. */
      address: string | null;
      tlsProtocol: string | null;
      /** The URL of each redirect that was followed, in order. */
      redirects: string[];
      latencyMs: number;
    }
  | { ok: false; reason: SafeFetchReason; detail: string; url: string; redirects: string[]; latencyMs: number };

export type ResolvedAddress = { address: string; family: 4 | 6 };

/** What `safeFetch` leans on. Tests replace them; nothing else should. */
export type SafeFetchDeps = {
  resolve: (hostname: string) => Promise<ResolvedAddress[]>;
  request: (options: https.RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;
  isForbidden: (address: string) => boolean;
  now: () => number;
};

/**
 * Not `dns.lookup`. That runs on the thread pool the rest of the server shares (files, crypto, compression), which has four
 * threads, and a name whose DNS never answers would hold one until the system resolver gives up. This asks the name
 * servers directly, off the pool, and gives up on its own.
 */
const resolver = new Resolver({ timeout: 1500, tries: 2 });

async function resolveAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  const found: ResolvedAddress[] = [
    ...(v4.status === "fulfilled" ? v4.value.map(address => ({ address, family: 4 as const })) : []),
    ...(v6.status === "fulfilled" ? v6.value.map(address => ({ address, family: 6 as const })) : []),
  ];
  // Both questions failing is a name that does not resolve. One failing is not: the addresses that did come back are checked and are all the socket gets.
  if (found.length === 0 && v4.status === "rejected") throw v4.reason;
  return found;
}

const defaultDeps: SafeFetchDeps = {
  resolve: resolveAddresses,
  request: (options, onResponse) => https.request(options, onResponse),
  isForbidden: isForbiddenIp,
  // A clock that cannot be set back: a step of the system clock must not stretch a deadline or a pause.
  now: () => performance.now(),
};

type Refusal = { ok: false; reason: SafeFetchReason; detail: string };
type Target = { ok: true; url: URL; hostname: string; addresses: ResolvedAddress[] };

class DeadlineError extends Error {}

/** `promise`, or a DeadlineError once `ms` have passed. The late answer, if one comes, is dropped. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("deadline")), Math.max(0, ms));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The reason for an error from the network or the TLS or HTTP layer. Only its code is kept, never its message. */
function classify(error: unknown): Refusal {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
  const detail = (code || (error instanceof Error ? error.name : "error")).slice(0, 80);
  if (/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|HOSTNAME_MISMATCH|EPROTO|ERR_OSSL)/.test(code)) return { ok: false, reason: "tls_failed", detail };
  if (code.startsWith("HPE_") || code === "ERR_HTTP_HEADERS_SENT" || code === "ERR_HTTP_INVALID_HEADER_VALUE") return { ok: false, reason: "response_invalid", detail };
  return { ok: false, reason: "connection_failed", detail };
}

/** Checks the URL and its name before anything is resolved: https, no userinfo, no port, a name that could be public. */
function parseTarget(raw: string): { ok: true; url: URL; hostname: string } | Refusal {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return { ok: false, reason: "invalid_url", detail: "the URL is empty or too long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url", detail: "the URL does not parse" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https", detail: `the scheme is ${url.protocol.replace(":", "")}` };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials_in_url", detail: "the URL carries a user name or password" };
  if (url.port !== "") return { ok: false, reason: "port_not_allowed", detail: `the URL names port ${url.port}` };
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  // Two or more labels of letters, digits, hyphens and underscores. That leaves out a single label (a search domain can make
  // it an internal name), an IPv6 literal in brackets, an empty label and anything odd enough to surprise a resolver.
  if (hostname.length > 253 || !HOSTNAME_PATTERN.test(hostname) || isClearlyUnsafeHostname(hostname)) {
    return { ok: false, reason: "forbidden_host", detail: "the name is not one a public DNS name can have" };
  }
  // Whoever is asked about this URL (the hook, a redirect) sees the name in one spelling, without the trailing dot.
  url.hostname = hostname;
  return { ok: true, url, hostname };
}

/** Why a URL can never be fetched, judged from its text alone (no DNS), or null. For a caller that wants to refuse an address early; the fetch checks it all again. */
export function checkFetchTarget(raw: string): { reason: SafeFetchReason; detail: string } | null {
  const parsed = parseTarget(raw);
  return parsed.ok ? null : { reason: parsed.reason, detail: parsed.detail };
}

/** Resolves the name once and keeps the answers only if every one of them is public address space. */
async function resolveChecked(hostname: string, deps: SafeFetchDeps, remainingMs: number): Promise<{ ok: true; addresses: ResolvedAddress[] } | Refusal> {
  let answers: ResolvedAddress[];
  try {
    answers = await withDeadline(deps.resolve(hostname), remainingMs);
  } catch (error) {
    if (error instanceof DeadlineError) return { ok: false, reason: "timeout", detail: "the DNS lookup did not finish in time" };
    return { ok: false, reason: "unresolvable", detail: "the name did not resolve" };
  }
  const addresses = answers.filter((answer, index) => answers.findIndex(other => other.address === answer.address) === index);
  if (addresses.length === 0) return { ok: false, reason: "unresolvable", detail: "DNS returned no address" };
  const forbidden = addresses.find(answer => deps.isForbidden(answer.address));
  // The address is not named: what a resolver answers for a name can be a fact about the network it runs in.
  if (forbidden) return { ok: false, reason: "forbidden_address", detail: "the name resolves to an address that is not public address space" };
  return { ok: true, addresses };
}

type Hop =
  | { ok: true; status: number; headers: Record<string, string>; body: Buffer; truncated: boolean; bodySha256: string; address: string | null; tlsProtocol: string | null }
  | Refusal;

function pickHeaders(raw: IncomingHttpHeaders): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw).slice(0, MAX_HEADER_COUNT)) {
    const lower = name.toLowerCase();
    if (value === undefined || DROPPED_HEADERS.has(lower)) continue;
    // A Location is kept one character past what a URL may be, so one that is too long is refused and not followed cut short.
    kept[lower] = (Array.isArray(value) ? value.join(", ") : String(value)).slice(0, lower === "location" ? MAX_URL_LENGTH + 1 : MAX_HEADER_VALUE);
  }
  return kept;
}

/** One request to the addresses that were checked, under what is left of the deadline. */
function requestOnce(
  target: Target,
  settings: { method: "GET" | "HEAD" | "POST"; accept: string; maxBodyBytes: number; post: { body: Buffer; headers: Record<string, string>; userAgent: string } | null },
  remainingMs: number,
  deps: SafeFetchDeps
): Promise<Hop> {
  const { url, hostname, addresses } = target;
  return new Promise<Hop>(resolve => {
    let settled = false;
    let request: ClientRequest | null = null;
    const finish = (hop: Hop) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(hop);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", detail: "no complete answer before the deadline" });
      request?.destroy();
    }, Math.max(1, remainingMs));

    // The only addresses the socket may use are the ones that were checked. Node asks for all of them when it tries
    // addresses in turn, and for one when it does not.
    const lookup = (_name: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
      if (typeof options === "object" && options !== null && options.all) callback(null, addresses.map(answer => ({ address: answer.address, family: answer.family })));
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };

    try {
      request = deps.request(
        {
          method: settings.method,
          protocol: "https:",
          host: hostname,
          hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          headers: {
            ...(settings.post ? settings.post.headers : {}),
            "user-agent": settings.post?.userAgent ?? CHECKER_USER_AGENT,
            accept: settings.accept,
            "accept-encoding": "identity",
            connection: "close",
            ...(settings.post ? { "content-length": String(settings.post.body.length) } : {}),
          },
          // The name is what the TLS handshake names and what the certificate is checked against; the address comes from `lookup`.
          servername: hostname,
          lookup: lookup as unknown as https.RequestOptions["lookup"],
          // Stated even though it is the default: NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment switches checking off for a request that leaves it out.
          rejectUnauthorized: true,
          // A new connection every time, never one that was pooled for another address.
          agent: false,
          maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
        },
        response => {
          const status = response.statusCode ?? 0;
          const headers = pickHeaders(response.headers);
          const socket = response.socket as TLSSocket | null;
          const address = socket?.remoteAddress ?? null;
          const tlsProtocol = typeof socket?.getProtocol === "function" ? socket.getProtocol() : null;
          const chunks: Buffer[] = [];
          const hash = createHash("sha256");
          let bytes = 0;
          let truncated = false;
          const done = () => {
            // 'end' can still come after the cap was crossed (Node has queued it when the same read ended the message), and a hash can be finished once.
            if (settled) return;
            finish({ ok: true, status, headers, body: Buffer.concat(chunks), truncated, bodySha256: hash.digest("hex"), address, tlsProtocol });
          };
          // A HEAD answer has no body, and the body of a redirect is not wanted.
          if (settings.method === "HEAD" || REDIRECT_STATUSES.has(status)) {
            done();
            response.destroy();
            return;
          }
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            const room = settings.maxBodyBytes - bytes;
            if (chunk.length > room) {
              if (room > 0) {
                const part = chunk.subarray(0, room);
                chunks.push(part);
                hash.update(part);
                bytes += part.length;
              }
              truncated = true;
              done();
              response.destroy();
              return;
            }
            chunks.push(chunk);
            hash.update(chunk);
            bytes += chunk.length;
          });
          response.on("end", done);
          response.on("error", error => finish(classify(error)));
          response.on("close", () => finish({ ok: false, reason: "connection_failed", detail: "the connection closed before the answer was complete" }));
        }
      );
    } catch (error) {
      finish(classify(error));
      return;
    }
    request.on("error", error => finish(classify(error)));
    if (settings.post) request.end(settings.post.body);
    else request.end();
  });
}

/** The body and headers of a POST, or why it is not one safeFetch will make. */
function buildPost(options: SafeFetchOptions): { ok: true; value: { body: Buffer; headers: Record<string, string>; userAgent: string } } | { ok: false; detail: string } {
  if (typeof options.body !== "string" || options.body.length === 0) return { ok: false, detail: "a POST needs a body" };
  const body = Buffer.from(options.body, "utf8");
  if (body.length > SAFE_FETCH_MAX_POST_BYTES) return { ok: false, detail: "the POST body is too large" };
  const headers: Record<string, string> = {};
  const given = Object.entries(options.headers ?? {});
  if (given.length > MAX_POST_HEADERS) return { ok: false, detail: "too many headers" };
  for (const [rawName, value] of given) {
    const name = rawName.toLowerCase();
    if (!POST_HEADER_NAME.test(name) || BLOCKED_POST_HEADERS.has(name) || typeof value !== "string" || !POST_HEADER_VALUE.test(value) || name in headers) return { ok: false, detail: "a header is not one safeFetch will send" };
    headers[name] = value;
  }
  const userAgent = options.userAgent ?? CHECKER_USER_AGENT;
  if (!POST_USER_AGENT.test(userAgent)) return { ok: false, detail: "the user agent is not one safeFetch will send" };
  return { ok: true, value: { body, headers, userAgent } };
}

/** Asks one https URL one question, under the rules at the top of this file. Never throws. */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}, overrides: Partial<SafeFetchDeps> = {}): Promise<SafeFetchResult> {
  const deps: SafeFetchDeps = { ...defaultDeps, ...overrides };
  let started = deps.now();
  const timeoutMs = bounded(options.timeoutMs, SAFE_FETCH_TIMEOUT_MS, 1, SAFE_FETCH_TIMEOUT_MS);
  // A POST is never carried to another address.
  const maxRedirects = options.method === "POST" ? 0 : bounded(options.maxRedirects, SAFE_FETCH_MAX_REDIRECTS, 0, SAFE_FETCH_MAX_REDIRECTS);
  const post = options.method === "POST" ? buildPost(options) : null;
  const settings = {
    method: options.method === "HEAD" ? "HEAD" : options.method === "POST" ? "POST" : "GET",
    accept: options.accept !== undefined && ACCEPT_PATTERN.test(options.accept) ? options.accept : "*/*",
    maxBodyBytes: bounded(options.maxBodyBytes, SAFE_FETCH_MAX_BODY_BYTES, 0, SAFE_FETCH_MAX_BODY_CEILING),
    post: post && post.ok ? post.value : null,
  } as const;
  const redirects: string[] = [];
  let current = rawUrl;
  const remaining = () => timeoutMs - (deps.now() - started);
  const fail = (refusal: Refusal): SafeFetchResult => ({ ok: false, reason: refusal.reason, detail: refusal.detail, url: current, redirects, latencyMs: Math.round(deps.now() - started) });

  if (post && !post.ok) return fail({ ok: false, reason: "invalid_url", detail: post.detail });

  try {
    for (let hop = 0; ; hop += 1) {
      if (remaining() <= 0) return fail({ ok: false, reason: "timeout", detail: `no complete answer within ${timeoutMs} ms` });
      const parsed = parseTarget(current);
      if (!parsed.ok) return fail(parsed);
      const checked = await resolveChecked(parsed.hostname, deps, remaining());
      if (!checked.ok) return fail(checked);
      const target: Target = { ok: true, url: parsed.url, hostname: parsed.hostname, addresses: checked.addresses };
      if (options.beforeRequest) {
        const hookStarted = deps.now();
        const allowed = await options.beforeRequest({ url: parsed.url, hop });
        // What the hook spent is not what the host took.
        started += deps.now() - hookStarted;
        if (!allowed.ok) return fail({ ok: false, reason: allowed.reason, detail: allowed.detail ?? allowed.reason });
      }
      if (remaining() <= 0) return fail({ ok: false, reason: "timeout", detail: `no complete answer within ${timeoutMs} ms` });
      const answer = await requestOnce(target, settings, remaining(), deps);
      if (!answer.ok) return fail(answer);
      if (!REDIRECT_STATUSES.has(answer.status)) {
        return { ok: true, url: current, status: answer.status, headers: answer.headers, body: answer.body, truncated: answer.truncated, bodySha256: answer.bodySha256, address: answer.address, tlsProtocol: answer.tlsProtocol, redirects, latencyMs: Math.round(deps.now() - started) };
      }
      const location = answer.headers.location;
      if (!location) return fail({ ok: false, reason: "redirect_invalid", detail: `a ${answer.status} with no Location` });
      // Checked before it is resolved against this URL, where dot segments could bring a cut-short one back under the limit.
      if (location.length > MAX_URL_LENGTH) return fail({ ok: false, reason: "redirect_invalid", detail: "the Location is longer than a URL may be" });
      if (hop >= maxRedirects) return fail({ ok: false, reason: "too_many_redirects", detail: `more than ${maxRedirects} redirects` });
      let next: string;
      try {
        next = new URL(location, parsed.url).toString();
      } catch {
        return fail({ ok: false, reason: "redirect_invalid", detail: "the Location does not parse" });
      }
      redirects.push(next);
      current = next;
    }
  } catch (error) {
    // Nothing above is meant to throw; if something does, it is an answer and not a crash.
    return fail(classify(error));
  }
}
