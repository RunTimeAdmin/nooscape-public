import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SafeFetchOptions, SafeFetchReason, SafeFetchResult } from "../safeFetch";
import {
  classifyRegistrationUri,
  createRegistrationNameResolver,
  ipfsGatewayUrl,
  ipfsLinkHasCid,
  REGISTRATION_FETCH_MAX_BYTES,
  REGISTRATION_NAME_MAX_CHARS,
  resolveRegistrationName,
  type RegistrationFetcher,
} from "./registrationFetch";

/**
 * The name reader goes through the safe fetch, so these drive it with the safe fetch's own answers (a fetcher that
 * returns what the real one would), and run the three refusals that happen before any DNS or connection through the
 * real one. Nothing here touches a network. The fetch itself is tested in safeFetch.test.ts and politeFetch.test.ts.
 */
const nameJson = (name: unknown) => JSON.stringify({ name });
/** Real shapes: a v1 CID (base32, 59 characters) and a v0 CID (base58, 46 characters), as the 8004 registrations carry them. */
const CID_V1 = "bafkreig7zddhseoj47nzdoclad644agf5x4ygozr6rqnpo332fxewi5cdi";
const CID_V0 = "QmYbqSeXjAEJD9tDEoXtrJTAPwok98csiFRv32uCj6QU9S";

const answer = (status: number, body: string | Buffer = "", over: Partial<Extract<SafeFetchResult, { ok: true }>> = {}): SafeFetchResult => ({
  ok: true,
  url: "https://agent.example.org/x",
  status,
  headers: {},
  body: Buffer.from(body),
  truncated: false,
  bodySha256: "ab".repeat(32),
  address: "93.184.216.34",
  tlsProtocol: "TLSv1.3",
  redirects: [],
  latencyMs: 5,
  ...over,
});
const refused = (reason: SafeFetchReason): SafeFetchResult => ({ ok: false, reason, detail: `detail of ${reason}`, url: "https://agent.example.org/x", redirects: [], latencyMs: 1 });

/** A fetcher that gives back the results in turn (the last one for every call after), and keeps what it was asked. */
function fetcherGiving(...results: SafeFetchResult[]) {
  const calls: Array<{ url: string; options: Omit<SafeFetchOptions, "beforeRequest"> | undefined }> = [];
  const fetcher: RegistrationFetcher = {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return results[Math.min(calls.length - 1, results.length - 1)]!;
    },
  };
  return { fetcher, calls };
}

describe("classifyRegistrationUri", () => {
  it("accepts ipfs and web links and refuses everything else", () => {
    expect(classifyRegistrationUri("ipfs://bafyexample/card.json")).toBe("ipfs");
    expect(classifyRegistrationUri("https://agent.example.org/card.json")).toBe("web");
    expect(classifyRegistrationUri("http://agent.example.org/card.json")).toBe("web");
    expect(classifyRegistrationUri('data:application/json,{"name":"x"}')).toBeNull();
    expect(classifyRegistrationUri("")).toBeNull();
    expect(classifyRegistrationUri("ftp://agent.example.org/card.json")).toBeNull();
  });
});

describe("ipfsGatewayUrl", () => {
  const ENV_KEY = "NOOSCAPE_IPFS_GATEWAY";

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("maps ipfs links through the default public gateway", () => {
    expect(ipfsGatewayUrl("ipfs://bafyexample/card.json")).toBe("https://ipfs.io/ipfs/bafyexample/card.json");
  });

  it("honors and normalizes a configured gateway", () => {
    process.env[ENV_KEY] = "https://gw.example.org/ipfs";
    expect(ipfsGatewayUrl("ipfs://bafyexample")).toBe("https://gw.example.org/ipfs/bafyexample");
    process.env[ENV_KEY] = "  https://gw2.example.org/ipfs/  ";
    expect(ipfsGatewayUrl("ipfs://bafyexample")).toBe("https://gw2.example.org/ipfs/bafyexample");
  });

  it("refuses a CID-less ipfs link", () => {
    expect(ipfsGatewayUrl("ipfs://")).toBeNull();
  });
});

describe("ipfsLinkHasCid", () => {
  it("accepts the first part of the link when it can be a CID, whatever follows it", () => {
    for (const uri of [`ipfs://${CID_V0}`, `ipfs://${CID_V1}`, `ipfs://${CID_V1}/card.json`, `ipfs://${CID_V0}?x=1`, `ipfs://${CID_V1}#top`]) expect(ipfsLinkHasCid(uri), uri).toBe(true);
    expect(CID_V0).toHaveLength(46);
    expect(CID_V1).toHaveLength(59);
  });

  it("refuses what cannot be a CID: nothing, a word, a short string, or characters a CID does not use", () => {
    for (const uri of ["ipfs://", "ipfs:///x", "ipfs://placeholder/12", "ipfs://ipfs/" + CID_V1, `ipfs://${CID_V1.slice(0, 43)}`, `ipfs://${CID_V1.slice(0, 40)}%20${CID_V1.slice(0, 10)}`, `ipfs://${CID_V1.slice(0, 20)}.${CID_V1.slice(0, 30)}`, `ipfs://${CID_V1}.json`, `ipfs://${CID_V1}%20`]) {
      expect(ipfsLinkHasCid(uri), uri).toBe(false);
    }
  });
});

describe("resolveRegistrationName", () => {
  afterEach(() => {
    delete process.env.NOOSCAPE_IPFS_GATEWAY;
  });

  it("resolves a JSON name, trims it and caps it, asking for JSON and for no more than the byte cap", async () => {
    const padded = `  ${"x".repeat(REGISTRATION_NAME_MAX_CHARS + 50)}  `;
    const { fetcher, calls } = fetcherGiving(answer(200, nameJson(padded)));
    const result = await resolveRegistrationName("https://agent.example.org/card.json", "web", { fetcher });
    expect(result).toEqual({ status: "resolved", name: "x".repeat(REGISTRATION_NAME_MAX_CHARS) });
    expect(calls).toEqual([{ url: "https://agent.example.org/card.json", options: { accept: "application/json", maxBodyBytes: REGISTRATION_FETCH_MAX_BYTES } }]);
  });

  it("maps an ipfs link through the configured gateway before asking", async () => {
    process.env.NOOSCAPE_IPFS_GATEWAY = "https://gw.example.org/ipfs/";
    const { fetcher, calls } = fetcherGiving(answer(200, nameJson("Gateway Name")));
    expect(await resolveRegistrationName(`ipfs://${CID_V1}/card.json`, "ipfs", { fetcher })).toEqual({ status: "resolved", name: "Gateway Name" });
    expect(calls.map(call => call.url)).toEqual([`https://gw.example.org/ipfs/${CID_V1}/card.json`]);
  });

  it("asks for a v0 CID and a v1 CID alike, and a path or query after the CID does not stop it", async () => {
    process.env.NOOSCAPE_IPFS_GATEWAY = "https://gw.example.org/ipfs/";
    const { fetcher, calls } = fetcherGiving(answer(200, nameJson("Some Name")));
    for (const uri of [`ipfs://${CID_V0}`, `ipfs://${CID_V1}`, `ipfs://${CID_V0}/meta/1.json`, `ipfs://${CID_V1}?filename=a.json`]) {
      expect(await resolveRegistrationName(uri, "ipfs", { fetcher }), uri).toEqual({ status: "resolved", name: "Some Name" });
    }
    expect(calls).toHaveLength(4);
  });

  it("settles an ipfs link with no CID in it as no_name, without asking anyone and without a failed try", async () => {
    const { fetcher, calls } = fetcherGiving(answer(200, nameJson("never read")));
    for (const uri of ["ipfs://", "ipfs:///", "ipfs://placeholder/12", "ipfs://placeholder", `ipfs://${CID_V1.slice(0, 43)}`, "ipfs://bafy-example/card.json"]) {
      expect(await resolveRegistrationName(uri, "ipfs", { fetcher }), uri).toEqual({ status: "no_name" });
    }
    expect(calls).toEqual([]);
  });

  it("reads a file that starts with a byte order mark, which JSON.parse alone refuses", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(nameJson("With A Mark"))]);
    const { fetcher } = fetcherGiving(answer(200, bytes));
    expect(await resolveRegistrationName("https://agent.example.org/bom.json", "web", { fetcher })).toEqual({ status: "resolved", name: "With A Mark" });
  });

  it("records no_name for content that is gone for good and for content without a usable name", async () => {
    const cases = [answer(404), answer(410), answer(200, "not json at all"), answer(200, JSON.stringify({ title: "no name field" })), answer(200, JSON.stringify(["not", "an", "object"])), answer(200, JSON.stringify({ name: "   " })), answer(200, JSON.stringify({ name: 7 }))];
    for (const result of cases) {
      const { fetcher } = fetcherGiving(result);
      expect((await resolveRegistrationName("https://agent.example.org/x", "web", { fetcher })).status, result.ok ? String(result.body) : "").toBe("no_name");
    }
  });

  it("records a 404 from a gateway as a failed try, not as a settled answer, and a 410 from it as no_name", async () => {
    process.env.NOOSCAPE_IPFS_GATEWAY = "https://gw.example.org/ipfs/";
    const asked = [404, 410].map(status => fetcherGiving(answer(status)));
    expect(await resolveRegistrationName(`ipfs://${CID_V1}`, "ipfs", { fetcher: asked[0]!.fetcher })).toEqual({ status: "failed", reason: "HTTP 404" });
    expect(await resolveRegistrationName(`ipfs://${CID_V1}`, "ipfs", { fetcher: asked[1]!.fetcher })).toEqual({ status: "no_name" });
  });

  it("records failed for any other HTTP status, with the status in the reason", async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const { fetcher } = fetcherGiving(answer(status));
      expect(await resolveRegistrationName("https://agent.example.org/oops", "web", { fetcher })).toEqual({ status: "failed", reason: `HTTP ${status}` });
    }
  });

  it("fails the attempt, never the pass, when the file is longer than the byte cap, and does not guess at a name in the part it read", async () => {
    const { fetcher } = fetcherGiving(answer(200, nameJson("Looks Fine"), { truncated: true }));
    expect(await resolveRegistrationName("https://agent.example.org/huge.json", "web", { fetcher })).toEqual({ status: "failed", reason: `response body exceeds the ${REGISTRATION_FETCH_MAX_BYTES}-byte cap` });
  });

  // Typed on every reason, so a reason added to the fetch has to be decided here before this compiles.
  const EXPECTED: Record<SafeFetchReason, true> = {
    invalid_url: true,
    not_https: true,
    credentials_in_url: true,
    port_not_allowed: true,
    forbidden_host: true,
    unresolvable: true,
    forbidden_address: true,
    redirect_invalid: true,
    too_many_redirects: true,
    timeout: true,
    connection_failed: true,
    tls_failed: true,
    response_invalid: true,
    robots_disallowed: true,
    robots_unavailable: true,
    budget_exhausted: true,
  };

  it("records failed, with the fetch's reason and detail, for every way the fetch can refuse or get no answer", async () => {
    for (const reason of Object.keys(EXPECTED) as SafeFetchReason[]) {
      const { fetcher } = fetcherGiving(refused(reason));
      expect(await resolveRegistrationName("https://agent.example.org/x", "web", { fetcher }), reason).toEqual({ status: "failed", reason: `${reason}: detail of ${reason}` });
    }
  });

  it("cuts a long reason at 200 characters", async () => {
    const { fetcher } = fetcherGiving({ ...refused("timeout"), detail: "d".repeat(500) } as SafeFetchResult);
    const result = await resolveRegistrationName("https://agent.example.org/x", "web", { fetcher });
    expect(result.status === "failed" && result.reason.length).toBe(200);
  });

  it("never throws, even when the fetcher does", async () => {
    const fetcher: RegistrationFetcher = {
      fetch: async () => {
        throw new Error("the fetcher fell over");
      },
    };
    expect(await resolveRegistrationName("https://agent.example.org/x", "web", { fetcher })).toEqual({ status: "failed", reason: "the fetcher fell over" });
  });

  // These three are refused by the real safe fetch before it resolves a name or opens a connection, so no network is needed.
  it("refuses plain http, a link with a password and a local name through the real fetch, before anything is sent", async () => {
    const refusals: Array<[string, string]> = [
      ["http://agent.example.org/card.json", "not_https"],
      ["https://user:pass@agent.example.org/card.json", "credentials_in_url"],
      ["https://localhost/card.json", "forbidden_host"],
    ];
    for (const [uri, reason] of refusals) {
      const result = await resolveRegistrationName(uri, "web");
      expect(result.status === "failed" && result.reason.startsWith(`${reason}: `), uri).toBe(true);
    }
  });
});

describe("createRegistrationNameResolver", () => {
  it("gives the names of a pass one fetcher, so robots.txt is read once for a host and a host is paced across the names", async () => {
    const { fetcher, calls } = fetcherGiving(answer(200, nameJson("One")), answer(200, nameJson("Two")));
    const resolve = createRegistrationNameResolver(30, { fetcher });
    expect(await resolve("https://a.example.org/1", "web")).toEqual({ status: "resolved", name: "One" });
    expect(await resolve("https://a.example.org/2", "web")).toEqual({ status: "resolved", name: "Two" });
    expect(calls.map(call => call.url)).toEqual(["https://a.example.org/1", "https://a.example.org/2"]);
  });
});

/** The rules the page at /checker makes promises about, read from the code: this module has no way to reach a network but the safe fetch. */
describe("what the name reader can reach", () => {
  const read = (relative: string) => readFileSync(path.resolve(import.meta.dirname, relative), "utf8").replace(/\r\n/g, "\n");
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("has no fetch of its own, no name lookup and no http client: every request is the polite fetcher's", () => {
    const code = strip(read("./registrationFetch.ts"));
    // A call to the global fetch, not the polite fetcher's own `.fetch(`.
    expect(code).not.toMatch(/node:dns|\blookup\(|(?<![.\w])fetch\(|node:https|node:http|node:net|node:tls|undici|axios/);
    expect(code).toContain("fetcher.fetch(");
    expect(code).toContain('from "../politeFetch"');
  });

  it("is what the 8004 pass uses unless a test gives it another: a resolver made for the pass's budget, not the bare function", () => {
    const pass = strip(read("./solana8004.ts"));
    expect(pass).toContain("input.fetchName ?? createRegistrationNameResolver(SOLANA_8004_FETCH_BUDGET_PER_PASS)");
    expect(pass).not.toMatch(/input\.fetchName \?\? resolveRegistrationName/);
  });
});
