import { createPoliteFetcher } from "../politeFetch";
import { SAFE_FETCH_MAX_BODY_CEILING, SAFE_FETCH_MAX_REDIRECTS, type SafeFetchResult } from "../safeFetch";

/**
 * The registration-name reader for the 8004 Solana chain pass. The pass itself never dereferences a URI: its chain-facts
 * event spine is decodes only. But about 755 of the live registration links are ipfs:// files whose inline JSON carries the
 * display name, and another 410 or so are https links. This module is the only place the pass reaches off-chain content,
 * and it is built so a fetch can fail without ever failing the pass: every outcome is a recorded status (`resolved` with the
 * self-asserted name, terminal `no_name` for content that carries no usable name, retryable `failed` for everything else).
 *
 * Every request goes through the safe fetch, behind the same manners as the checks (docs/safe-fetch-2026-10-15.md): https
 * only, no userinfo or port, the name resolved first and every address checked, the connection made to an address that was
 * checked (so a name cannot be pointed somewhere else between the check and the connect), redirects followed by hand (three
 * at most) with the same checks at each hop, one 5 second deadline, a 256 KiB cap, the host's robots.txt read first and
 * obeyed, a second between two requests to one host, and the Nooscape-Checker user agent that names the /checker page.
 * `ipfs://<cid>` maps through the configured gateway (`NOOSCAPE_IPFS_GATEWAY`: in production the Rainbow gateway Nooscape
 * runs, docs/ipfs-gateway-2026-10-16.md, and the public ipfs.io gateway when nothing is set) and is then treated like any
 * other https link. A link with no CID in it is asked of no one. Before 2026-10-16 this module had its own fetch, with a 10 second deadline and a
 * 1 MiB cap, a connection that was not pinned to the checked address, no robots.txt and Node's default user agent.
 *
 * Trust posture: a fetched `name` is a self-asserted locator-class fact, exactly as trustworthy as an inline-decoded one and
 * no more. It is trimmed, capped at 200 characters, and only ever applied downstream to a directory row whose chain-decoded
 * name is still the synthetic placeholder.
 */

/** The most body bytes read from a registration file. A longer one is a failed attempt, and not a guess at its name. */
export const REGISTRATION_FETCH_MAX_BYTES = SAFE_FETCH_MAX_BODY_CEILING;
/** Fetched names are trimmed and capped here before anything stores them. */
export const REGISTRATION_NAME_MAX_CHARS = 200;
/** Redirect hops are followed by the safe fetch, each with its full checks. */
export const REGISTRATION_FETCH_MAX_REDIRECTS = SAFE_FETCH_MAX_REDIRECTS;
/**
 * Retry policy, evaluated by the adapter per pass: `failed` re-attempts up to this many total attempts, `no_name` confirms
 * once (two attempts) before it goes terminal: a placeholder may be permanent, but one bad response should not decide that
 * forever.
 */
export const RESOLUTION_FAILED_MAX_ATTEMPTS = 5;
export const RESOLUTION_NO_NAME_MAX_ATTEMPTS = 2;
/**
 * The most requests one name can use: a page and a robots.txt at each of four hops, and a robots.txt that moves once, with
 * room to spare. A pass's budget is this for each name it may read, so it cannot run dry in the middle of a list and turn
 * a name into a failed attempt that was never made.
 */
const REQUESTS_PER_NAME = 12;
const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs/";
/** What the first part of an ipfs link has to look like to be a CID: letters and digits, and at least 44 of them (the shortest real one, a v0 hash, has 46). */
const CID_SHAPE = /^[A-Za-z0-9]{44,}$/;

export type RegistrationUriKind = "web" | "ipfs";

export type RegistrationNameResult =
  | { status: "resolved"; name: string }
  | { status: "no_name" }
  | { status: "failed"; reason: string };

/** What a name read leans on: the polite fetcher of its pass. Tests replace it. */
export type RegistrationFetcher = Pick<ReturnType<typeof createPoliteFetcher>, "fetch">;

/** Classifies a registration URI into a fetchable kind, or null when the pass must not fetch it. */
export function classifyRegistrationUri(uri: string): RegistrationUriKind | null {
  if (uri.startsWith("ipfs://")) return "ipfs";
  if (uri.startsWith("https://") || uri.startsWith("http://")) return "web";
  return null;
}

/** Maps `ipfs://<cid>[<path>]` onto the configured gateway; null when the URI carries no CID. */
export function ipfsGatewayUrl(uri: string): string | null {
  const cidAndPath = uri.slice("ipfs://".length);
  if (cidAndPath.length === 0) return null;
  const configured = (process.env.NOOSCAPE_IPFS_GATEWAY || DEFAULT_IPFS_GATEWAY).trim();
  const base = configured.endsWith("/") ? configured : `${configured}/`;
  return `${base}${cidAndPath}`;
}

/** True when `ipfs://<x>[/path]` starts with something that can be a CID, so a link like `ipfs://placeholder/7` is never asked of a gateway. */
export function ipfsLinkHasCid(uri: string): boolean {
  const first = uri.slice("ipfs://".length).split(/[/?#]/, 1)[0] ?? "";
  return CID_SHAPE.test(first);
}

function capReason(message: string): string {
  return message.length > 200 ? message.slice(0, 200) : message;
}

/** Pulls the self-asserted `name` out of fetched JSON; anything else is no_name, never an error. */
function extractJsonName(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const name = (parsed as Record<string, unknown>).name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, REGISTRATION_NAME_MAX_CHARS) : null;
}

/** What reading one registration file gave: its text, a settled absence, or a failed try. */
export type RegistrationFileResult = { status: "ok"; text: string } | { status: "gone" } | { status: "failed"; reason: string };

/** What one answer from the safe fetch says about the file. */
function fileResultOf(result: SafeFetchResult, kind: RegistrationUriKind): RegistrationFileResult {
  if (!result.ok) return { status: "failed", reason: capReason(`${result.reason}: ${result.detail}`) };
  // The content is deterministically gone: no retry can bring it back. A 404 from a gateway is the exception: the
  // gateway's own front door answers 404 to a path it does not serve (a prefix that differs from the one it expects), and
  // that must be a failed try that shows up as HTTP 404, not a settled answer for every ipfs link it is asked about.
  if (result.status === 410 || (result.status === 404 && kind === "web")) return { status: "gone" };
  if (result.status < 200 || result.status >= 300) return { status: "failed", reason: `HTTP ${result.status}` };
  if (result.truncated) return { status: "failed", reason: `response body exceeds the ${REGISTRATION_FETCH_MAX_BYTES}-byte cap` };
  // A decoder that is not strict, and that drops a leading byte order mark, which JSON.parse refuses.
  return { status: "ok", text: new TextDecoder("utf-8", { fatal: false }).decode(result.body) };
}

/** What one answer from the safe fetch says about the name. */
function nameResultOf(result: SafeFetchResult, kind: RegistrationUriKind): RegistrationNameResult {
  const file = fileResultOf(result, kind);
  if (file.status === "failed") return file;
  if (file.status === "gone") return { status: "no_name" };
  const name = extractJsonName(file.text);
  return name === null ? { status: "no_name" } : { status: "resolved", name };
}

/** The address to ask for a registration link: the link itself, or its ipfs path on the configured gateway. Null when it has no CID. */
function addressOf(uri: string, kind: RegistrationUriKind): string | null {
  return kind === "ipfs" ? (ipfsLinkHasCid(uri) ? ipfsGatewayUrl(uri) : null) : uri;
}

/**
 * Resolves one registration URI to a display name, or to a recorded status. Never throws: every failure mode (a refused
 * address, a host that does not answer, robots.txt, an HTTP error, the size cap, unparseable content) is an honest
 * `failed` or `no_name` result the caller stores. Give it the fetcher of the pass (`createRegistrationNameResolver`) so
 * robots.txt is read once for a host and a host is not asked twice in a second; alone it makes a fetcher of its own.
 */
export async function resolveRegistrationName(
  uri: string,
  kind: RegistrationUriKind,
  options: { fetcher?: RegistrationFetcher } = {}
): Promise<RegistrationNameResult> {
  const fetchUrl = addressOf(uri, kind);
  // A link with no CID in it has nothing to read and no gateway could answer it: that settles it, it is not a failed try.
  if (fetchUrl === null) return { status: "no_name" };
  try {
    const fetcher = options.fetcher ?? createPoliteFetcher({ concurrency: 1, budget: REQUESTS_PER_NAME });
    return nameResultOf(await fetcher.fetch(fetchUrl, { accept: "application/json", maxBodyBytes: REGISTRATION_FETCH_MAX_BYTES }), kind);
  } catch (error) {
    return { status: "failed", reason: capReason(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Reads one registration file whole, through the same safe fetch, the same limits and the same fetcher as the name reader, and
 * returns its text for the caller to parse. Never throws. A link with no CID in it, or an `http` address, has nothing to read and
 * is `gone`. `createRegistrationFileReader` makes the reader for a pass.
 */
export async function readRegistrationFile(uri: string, kind: RegistrationUriKind, options: { fetcher?: RegistrationFetcher } = {}): Promise<RegistrationFileResult> {
  const fetchUrl = addressOf(uri, kind);
  if (fetchUrl === null || !fetchUrl.startsWith("https://")) return { status: "gone" };
  try {
    const fetcher = options.fetcher ?? createPoliteFetcher({ concurrency: 1, budget: REQUESTS_PER_NAME });
    return fileResultOf(await fetcher.fetch(fetchUrl, { accept: "application/json", maxBodyBytes: REGISTRATION_FETCH_MAX_BYTES }), kind);
  } catch (error) {
    return { status: "failed", reason: capReason(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * The resolver for one pass that may read `names` registration links: one polite fetcher shared by all of them, with a
 * budget of requests that cannot run out before the last name.
 */
export function createRegistrationNameResolver(names: number, options: { fetcher?: RegistrationFetcher } = {}) {
  const fetcher = options.fetcher ?? createPoliteFetcher({ concurrency: 1, budget: Math.max(1, Math.floor(names)) * REQUESTS_PER_NAME });
  return (uri: string, kind: RegistrationUriKind) => resolveRegistrationName(uri, kind, { fetcher });
}

/** The file reader for one pass that may read `files` registration files: one polite fetcher shared by all of them, with a budget that cannot run out before the last one. */
export function createRegistrationFileReader(files: number, options: { fetcher?: RegistrationFetcher } = {}) {
  const fetcher = options.fetcher ?? createPoliteFetcher({ concurrency: 1, budget: Math.max(1, Math.floor(files)) * REQUESTS_PER_NAME });
  return (uri: string, kind: RegistrationUriKind) => readRegistrationFile(uri, kind, { fetcher });
}
