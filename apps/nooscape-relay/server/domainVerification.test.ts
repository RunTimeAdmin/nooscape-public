import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildDomainProofUrl,
  createDomainVerificationToken,
  fetchDomainControlProof,
  hashDomainVerificationToken,
  normalizeHttpsDomain,
} from "./domainVerification";
import { safeFetch, SAFE_FETCH_TIMEOUT_MS, type SafeFetchResult } from "./safeFetch";

describe("domain verification safeguards", () => {
  it("uses an opaque challenge path while keeping the bearer token out of the stored URL", () => {
    const token = createDomainVerificationToken();
    const challengeId = "79d9a1f9-21a4-4b48-bcd8-0f582d7f0b0e";
    const proofUrl = buildDomainProofUrl("www.example.com", challengeId);

    expect(token).toHaveLength(43);
    expect(hashDomainVerificationToken(token)).toHaveLength(64);
    expect(proofUrl).toBe(`https://www.example.com/.well-known/nooscape-domain-verification/${challengeId}.txt`);
    expect(proofUrl).not.toContain(token);
  });

  it("accepts only an HTTPS public domain root", () => {
    expect(normalizeHttpsDomain("https://www.example.com")).toBe("www.example.com");
    expect(() => normalizeHttpsDomain("http://www.example.com")).toThrow(/HTTPS/);
    expect(() => normalizeHttpsDomain("https://www.example.com/path")).toThrow(/root/);
    expect(() => normalizeHttpsDomain("https://127.0.0.1")).toThrow(/public DNS/);
  });
});

describe("fetching the proof file", () => {
  const challengeId = "79d9a1f9-21a4-4b48-bcd8-0f582d7f0b0e";
  const token = "a-one-time-token";
  const tokenHash = hashDomainVerificationToken(token);

  const answer = (overrides: Partial<Extract<SafeFetchResult, { ok: true }>> = {}): SafeFetchResult => ({
    ok: true,
    url: buildDomainProofUrl("www.example.com", challengeId),
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: Buffer.from(`${token}\n`),
    truncated: false,
    bodySha256: "0".repeat(64),
    address: "93.184.216.34",
    tlsProtocol: "TLSv1.3",
    redirects: [],
    latencyMs: 12,
    ...overrides,
  });
  const refused = (reason: Extract<SafeFetchResult, { ok: false }>["reason"]): SafeFetchResult => ({ ok: false, reason, detail: "x", url: "https://www.example.com/", redirects: [], latencyMs: 1 });
  const fetching = (result: SafeFetchResult) => vi.fn(async () => result) as unknown as typeof safeFetch & ReturnType<typeof vi.fn>;

  it("asks the shared outbound fetch for the one proof URL, with no redirect, a 4 KiB body and the shortest deadline it allows", async () => {
    const fetcher = fetching(answer());
    await fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(buildDomainProofUrl("www.example.com", challengeId), { method: "GET", accept: "text/plain", maxRedirects: 0, maxBodyBytes: 4096, timeoutMs: SAFE_FETCH_TIMEOUT_MS });
  });

  it("gives back the proof, its hash and its content type when the file holds the token", async () => {
    const proof = await fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(answer()));
    expect(proof.proofUrl).toBe(buildDomainProofUrl("www.example.com", challengeId));
    expect(proof.proofBody).toBe(`${token}\n`);
    expect(proof.proofHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.contentType).toBe("text/plain; charset=utf-8");
    expect((await fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(answer({ headers: {} })))).contentType).toBe("text/plain");
  });

  it("refuses a file that does not hold the token, a status that is not a success, a body that was cut, and a redirect", async () => {
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(answer({ body: Buffer.from("another token") })))).rejects.toThrow("Domain proof content did not match the issued token.");
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(answer({ status: 404 })))).rejects.toThrow("Domain proof returned HTTP 404.");
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(answer({ status: 500 })))).rejects.toThrow("Domain proof returned HTTP 500.");
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(answer({ truncated: true })))).rejects.toThrow("Domain proof response exceeds 4 KiB.");
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(refused("too_many_redirects")))).rejects.toThrow("Domain proof must be served without a redirect.");
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(refused("redirect_invalid")))).rejects.toThrow("Domain proof must be served without a redirect.");
  });

  it("says a name that does not resolve to public addresses alone is refused, and names any other failure by its reason", async () => {
    for (const reason of ["forbidden_address", "forbidden_host"] as const) {
      await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(refused(reason)))).rejects.toThrow("Verification domain does not resolve exclusively to public network addresses.");
    }
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(refused("timeout")))).rejects.toThrow("Domain proof could not be fetched (timeout).");
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, fetching(refused("unresolvable")))).rejects.toThrow("Domain proof could not be fetched (unresolvable).");
  });

  it("never connects to a name that resolves to a private address, through the real outbound fetch", async () => {
    const request = vi.fn(() => {
      throw new Error("a connection was made");
    });
    const viaPrivate: typeof safeFetch = (url, options) => safeFetch(url, options, { resolve: async () => [{ address: "10.0.0.5", family: 4 }], request: request as never });
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, viaPrivate)).rejects.toThrow("Verification domain does not resolve exclusively to public network addresses.");
    const mixed: typeof safeFetch = (url, options) =>
      safeFetch(url, options, {
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
        request: request as never,
      });
    await expect(fetchDomainControlProof("www.example.com", challengeId, tokenHash, mixed)).rejects.toThrow("Verification domain does not resolve exclusively to public network addresses.");
    expect(request).not.toHaveBeenCalled();
  });

  it("makes its request through the shared outbound fetch only: no global fetch and no system resolver of its own", () => {
    const source = readFileSync(fileURLToPath(new URL("./domainVerification.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/(^|[^\w.])fetch\(/m);
    expect(source).not.toMatch(/node:dns/);
    expect(source).toMatch(/from "\.\/safeFetch"/);
  });
});
