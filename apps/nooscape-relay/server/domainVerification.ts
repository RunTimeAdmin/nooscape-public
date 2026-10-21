import { createHash, randomBytes } from "node:crypto";
import { isClearlyUnsafeHostname } from "./netGuard";
import { safeFetch, SAFE_FETCH_TIMEOUT_MS } from "./safeFetch";

const TOKEN_BYTES = 32;
const MAX_PROOF_BYTES = 4 * 1024;

export function hashDomainVerificationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createDomainVerificationToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function normalizeHttpsDomain(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Domain verification requires an HTTPS domain root without path, port, credentials, query, or fragment.");
  }
  const domain = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!domain || isClearlyUnsafeHostname(domain)) {
    throw new Error("Domain verification requires a public DNS hostname.");
  }
  return domain;
}

export function buildDomainProofUrl(domain: string, challengeId: string) {
  return `https://${domain}/.well-known/nooscape-domain-verification/${challengeId}.txt`;
}

/**
 * Verifies a static, one-time proof file. It never calls an agent endpoint or follows a redirect. A matching file demonstrates
 * domain control only.
 *
 * The request goes through the shared outbound fetch (server/safeFetch.ts), like every other request to a host a registrant
 * chose: the name is resolved once, every answer must be public address space, and the connection is made to those answers
 * and to nothing else, so a host that answers differently the second time (DNS rebinding) cannot steer it to a private
 * address. `fetcher` is for tests.
 */
export async function fetchDomainControlProof(domain: string, challengeId: string, expectedTokenHash: string, fetcher: typeof safeFetch = safeFetch) {
  const proofUrl = buildDomainProofUrl(domain, challengeId);
  const result = await fetcher(proofUrl, { method: "GET", accept: "text/plain", maxRedirects: 0, maxBodyBytes: MAX_PROOF_BYTES, timeoutMs: SAFE_FETCH_TIMEOUT_MS });
  if (!result.ok) {
    if (result.reason === "forbidden_address" || result.reason === "forbidden_host") {
      throw new Error("Verification domain does not resolve exclusively to public network addresses.");
    }
    if (result.reason === "too_many_redirects" || result.reason === "redirect_invalid") throw new Error("Domain proof must be served without a redirect.");
    throw new Error(`Domain proof could not be fetched (${result.reason}).`);
  }
  if (result.status < 200 || result.status >= 300) throw new Error(`Domain proof returned HTTP ${result.status}.`);
  if (result.truncated) throw new Error("Domain proof response exceeds 4 KiB.");
  const body = result.body.toString("utf8");
  const normalized = body.trim();
  if (hashDomainVerificationToken(normalized) !== expectedTokenHash) {
    throw new Error("Domain proof content did not match the issued token.");
  }
  return {
    proofUrl,
    proofBody: body,
    proofHash: createHash("sha256").update(body).digest("hex"),
    contentType: result.headers["content-type"] ?? "text/plain",
  };
}
