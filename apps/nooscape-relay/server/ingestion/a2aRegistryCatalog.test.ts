import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * The two A2A registry adapters: paged JSON, a selection rule each, one record per party, the oldest first up to the ceiling, and nothing
 * read but the list endpoint. The records here are made up in the shape the registries serve (checked against a full read of both on
 * 2026-11-06); the download and the storage are replaced.
 */
const mocks = vi.hoisted(() => ({
  assertPublicHostname: vi.fn(async (_hostname: string) => undefined),
  storagePut: vi.fn(async (key: string) => ({ key })),
}));

vi.mock("./a2a", async importOriginal => {
  const original = await importOriginal<typeof import("./a2a")>();
  return { ...original, assertPublicHostname: mocks.assertPublicHostname };
});
vi.mock("../storage", () => ({ storagePut: mocks.storagePut }));

import { MAX_RUN_REVIEW_OBSERVATIONS } from "../db";
import {
  A2A_REGISTRY_MAX_ACCEPTED_RECORDS,
  A2A_REGISTRY_PAUSE_MS,
  A2A_REGISTRY_SOURCE_KEYS,
  A2aRegistryValidationError,
  a2aRegistryPolicy,
  fetchA2aRegistryCatalog,
  isA2aRegistrySourceKey,
  registrableUnit,
  unitsOfUrls,
} from "./a2aRegistryCatalog";

const COMMUNITY = "a2aregistry-public-api";
const API = "a2a-registry-org-public-api";

function registrySource(key: typeof COMMUNITY | typeof API, overrides: Partial<IngestionSource> = {}): IngestionSource {
  const policy = a2aRegistryPolicy(key);
  return {
    id: `source-${key}`,
    sourceKey: key,
    label: "Registry",
    protocol: "catalog",
    rootUrl: policy.listUrl,
    allowedHostname: new URL(policy.listUrl).hostname,
    state: "active",
    executionPolicy: "manual_only",
    scheduleMinutes: 1440,
    cursor: null,
    nextRunAt: null,
    lastSuccessfulAt: null,
    failureCount: 0,
    lastError: null,
    createdByUserId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A record as a2aregistry.org serves it: it qualifies unless an override breaks it. */
const communityRecord = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `c-${n}`,
  name: `Community Agent ${n}`,
  description: `Agent ${n} does one thing.`,
  author: `Author ${n}`,
  wellKnownURI: `https://agent${n}.example/.well-known/agent-card.json`,
  url: `https://agent${n}.example/a2a`,
  provider: { organization: `Org ${n}`, url: `https://www.agent${n}.example/` },
  protocolVersion: "0.3.0",
  version: "1.0.0",
  skills: "[]",
  conformance: true,
  conformance_errors: null,
  created_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
  hidden: false,
  flag_count: 0,
  maintainer_notes: "internal note",
  category: "research",
  is_healthy: true,
  last_health_check: "2026-11-06T23:10:12Z",
  task_conformance: { category: "WORKING", passed: true },
  ...overrides,
});

/** A record as api.a2a-registry.org serves it: it qualifies unless an override breaks it. */
const apiRecord = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `a-${n}`,
  orgId: `org-id-${n}`,
  packageName: `pkg.agent${n}`,
  displayName: `Registry Agent ${n}`,
  description: `Agent ${n} does one thing.`,
  category: "Finance",
  manifestUrl: `https://agent${n}.test/.well-known/agent-card.json`,
  protocolStd: "a2a",
  visibility: "public",
  is_claimed: true,
  verification_level: "verified",
  lastCheckStatus: "changed",
  consecutiveFailures: 0,
  createdAt: 1_790_000_000 + n,
  status: "ACTIVE",
  owner_org: `Org ${n}`,
  owner_org_slug: `org-${n}`,
  owner_org_website: `https://www.agent${n}.test/`,
  is_spotlight: false,
  is_promoted_top: false,
  badge_label: null,
  source_agent_card: JSON.stringify({ name: `Registry Agent ${n}` }),
  config: "{}",
  ...overrides,
});

function jsonResponse(payload: unknown, init: { status?: number; contentType?: string; contentLength?: number } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status < 400,
    status,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === "content-type") return init.contentType ?? "application/json";
        if (key === "content-length" && init.contentLength !== undefined) return String(init.contentLength);
        return null;
      },
    },
    body: new Response(typeof payload === "string" ? payload : JSON.stringify(payload)).body,
  } as unknown as Response;
}

/** The list a registry would serve, in pages of 100, for the page the URL asks for. */
function listFetch(key: typeof COMMUNITY | typeof API, records: unknown[], reportedTotal = records.length) {
  return vi.fn(async (url: string) => {
    const query = new URL(url).searchParams;
    const index = key === COMMUNITY ? Number(query.get("offset")) / 100 : Number(query.get("page")) - 1;
    const agents = records.slice(index * 100, index * 100 + 100);
    return jsonResponse(key === COMMUNITY ? { agents, total: reportedTotal, limit: 100, offset: index * 100 } : { success: true, agents, total: reportedTotal });
  });
}

async function takenIds(key: typeof COMMUNITY | typeof API, records: unknown[], skipUnits?: ReadonlySet<string>) {
  vi.stubGlobal("fetch", listFetch(key, records));
  const snapshot = await fetchA2aRegistryCatalog(registrySource(key), { pause: async () => {}, skipUnits });
  return snapshot.observations.map(entry => entry.candidate.externalRecordId);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the party a host stands for", () => {
  it("is the registrable domain, without www and trailing dots", () => {
    expect(registrableUnit("www.Example.com.")).toBe("example.com");
    expect(registrableUnit("a.b.example.org")).toBe("example.org");
    expect(registrableUnit("agent.example.co.uk")).toBe("example.co.uk");
    expect(registrableUnit("example.co.uk")).toBe("example.co.uk");
  });

  it("is the whole host on a hosting platform, so one tenant is one party and another tenant is another", () => {
    expect(registrableUnit("beggar-bot.beggarbot.workers.dev")).toBe("beggar-bot.beggarbot.workers.dev");
    expect(registrableUnit("other-worker.beggarbot.workers.dev")).toBe("other-worker.beggarbot.workers.dev");
    expect(registrableUnit("my-app.vercel.app")).toBe("my-app.vercel.app");
    // The same tenant with and without www is one party.
    expect(registrableUnit("www.my-app.vercel.app")).toBe("my-app.vercel.app");
    expect(registrableUnit("user.github.io")).toBe("user.github.io");
    expect(registrableUnit("svc-abc-uc.a.run.app")).toBe("svc-abc-uc.a.run.app");
    expect(registrableUnit("tenant.tcloudbaseapp.com")).toBe("tenant.tcloudbaseapp.com");
  });

  it("is nothing for an address that is not a DNS name", () => {
    expect(registrableUnit("203.0.113.5")).toBeNull();
    expect(registrableUnit("[::1]")).toBeNull();
    expect(registrableUnit("localhost")).toBeNull();
  });

  it("collects the units of the addresses a reviewed record already holds and skips what is not an address", () => {
    expect(Array.from(unitsOfUrls(["https://www.one.example.org/x", "https://a.two.example.com/", "not a url", "https://t.workers.dev/"])).sort()).toEqual(
      ["example.com", "example.org", "t.workers.dev"].sort()
    );
  });
});

describe("a2aregistry.org: which records qualify", () => {
  it("takes a record that is visible, unflagged, conformant, healthy and passing the task probe, and maps it", async () => {
    vi.stubGlobal("fetch", listFetch(COMMUNITY, [communityRecord(1)]));

    const snapshot = await fetchA2aRegistryCatalog(registrySource(COMMUNITY), { pause: async () => {} });

    expect(snapshot.discoveredCount).toBe(1);
    expect(snapshot.rejectedCount).toBe(0);
    expect(snapshot.observations).toHaveLength(1);
    const { candidate } = snapshot.observations[0]!;
    expect(candidate).toMatchObject({
      displayName: "Community Agent 1",
      summary: "Agent 1 does one thing.",
      primaryCapability: "research",
      specialties: ["research"],
      agentCardUrl: "https://agent1.example/.well-known/agent-card.json",
      // The provider's own site when the record names one, not the service address.
      endpointUrl: "https://www.agent1.example/",
      authentication: null,
      externalRecordId: "c-1",
      catalogSignals: [
        "registry-reported conformance check: passed",
        "registry-reported health check: healthy",
        "registry-reported task probe: working",
      ],
    });
    expect(candidate.handle).toMatch(/^community-agent-1-[0-9a-f]{10}$/);
  });

  it("uses the card address as the endpoint when the record names no provider site", async () => {
    vi.stubGlobal("fetch", listFetch(COMMUNITY, [communityRecord(1, { provider: null })]));

    const snapshot = await fetchA2aRegistryCatalog(registrySource(COMMUNITY), { pause: async () => {} });

    expect(snapshot.observations[0]!.candidate.endpointUrl).toBe("https://agent1.example/.well-known/agent-card.json");
  });

  it.each([
    ["hidden", { hidden: true }],
    ["flagged", { flag_count: 1 }],
    ["flag count missing", { flag_count: undefined }],
    ["failed the conformance check", { conformance: false }],
    ["not healthy", { is_healthy: false }],
    ["task probe not working", { task_conformance: { category: "FAILED", passed: false } }],
    ["no task probe", { task_conformance: null }],
    ["card address not https", { wellKnownURI: "http://agent1.example/.well-known/agent-card.json" }],
    ["service address with a port", { url: "https://agent1.example:8443/a2a" }],
    ["service address with credentials", { url: "https://user:pw@agent1.example/a2a" }],
    ["service address missing", { url: null }],
    ["no name", { name: "  " }],
    ["card served by the registry itself", { wellKnownURI: "https://a2aregistry.org/agents/1/agent-card.json" }],
    ["card on an address, not a name", { wellKnownURI: "https://203.0.113.5/.well-known/agent-card.json" }],
  ])("leaves out a record that is %s", async (_label, overrides) => {
    expect(await takenIds(COMMUNITY, [communityRecord(1, overrides as Record<string, unknown>), communityRecord(2)])).toEqual(["c-2"]);
  });
});

describe("api.a2a-registry.org: which records qualify", () => {
  it("takes a public, active, verified A2A record with no failed check, and maps it", async () => {
    vi.stubGlobal("fetch", listFetch(API, [apiRecord(1)]));

    const snapshot = await fetchA2aRegistryCatalog(registrySource(API), { pause: async () => {} });

    expect(snapshot.observations).toHaveLength(1);
    const { candidate } = snapshot.observations[0]!;
    expect(candidate).toMatchObject({
      displayName: "Registry Agent 1",
      summary: "Agent 1 does one thing.",
      primaryCapability: "Finance",
      agentCardUrl: "https://agent1.test/.well-known/agent-card.json",
      endpointUrl: "https://www.agent1.test/",
      authentication: null,
      externalRecordId: "a-1",
      catalogSignals: ["registry-reported verification level: verified", "registry-reported check status: no failed check since"],
    });
  });

  it("uses the manifest address as the endpoint when the owner names no website", async () => {
    vi.stubGlobal("fetch", listFetch(API, [apiRecord(1, { owner_org_website: null })]));

    const snapshot = await fetchA2aRegistryCatalog(registrySource(API), { pause: async () => {} });

    expect(snapshot.observations[0]!.candidate.endpointUrl).toBe("https://agent1.test/.well-known/agent-card.json");
  });

  it.each([
    ["not public", { visibility: "private" }],
    ["not active", { status: "INACTIVE" }],
    ["not an A2A record", { protocolStd: "mcp" }],
    ["verified only through GitHub", { verification_level: "github_verified" }],
    ["unverified", { verification_level: "unverified" }],
    ["failing its checks", { consecutiveFailures: 1 }],
    ["an import with no owner", { owner_org_slug: "system-unclaimed" }],
    ["a spotlight placement", { is_spotlight: true }],
    ["a promoted placement", { is_promoted_top: true }],
    ["carrying a badge", { badge_label: "Featured" }],
    ["a manifest address that is not https", { manifestUrl: "http://agent1.test/.well-known/agent-card.json" }],
    ["served by the registry itself", { manifestUrl: "https://www.a2a-registry.org/agents/1/agent-card.json" }],
  ])("leaves out a record that is %s", async (_label, overrides) => {
    expect(await takenIds(API, [apiRecord(1, overrides as Record<string, unknown>), apiRecord(2)])).toEqual(["a-2"]);
  });
});

describe("one party, oldest first, up to the ceiling", () => {
  it("keeps the ceiling inside what the review tooling lists in one run", () => {
    expect(A2A_REGISTRY_MAX_ACCEPTED_RECORDS).toBe(96);
    expect(A2A_REGISTRY_MAX_ACCEPTED_RECORDS).toBeLessThanOrEqual(MAX_RUN_REVIEW_OBSERVATIONS);
  });

  it("takes the oldest records up to the ceiling whatever order the registry lists them in, and counts the rest as rejected", async () => {
    const records = Array.from({ length: 130 }, (_, index) => communityRecord(index + 1)).reverse();

    vi.stubGlobal("fetch", listFetch(COMMUNITY, records));
    const snapshot = await fetchA2aRegistryCatalog(registrySource(COMMUNITY), { pause: async () => {} });

    const ids = snapshot.observations.map(entry => entry.candidate.externalRecordId);
    expect(ids).toHaveLength(96);
    expect(ids[0]).toBe("c-1");
    expect(ids.at(-1)).toBe("c-96");
    expect(snapshot.discoveredCount).toBe(130);
    expect(snapshot.qualifiedCount).toBe(130);
    expect(snapshot.rejectedCount).toBe(34);
    expect(mocks.storagePut).toHaveBeenCalledTimes(96);
  });

  it("takes one record for a party that lists several, the oldest, and counts a platform's tenants apart", async () => {
    const records = [
      communityRecord(3, { wellKnownURI: "https://x.shared.example.org/.well-known/agent-card.json" }),
      communityRecord(1, { wellKnownURI: "https://y.shared.example.org/.well-known/agent-card.json" }),
      communityRecord(2, { wellKnownURI: "https://www.shared.example.org/.well-known/agent-card.json" }),
      communityRecord(4, { wellKnownURI: "https://one.workers.dev/.well-known/agent-card.json" }),
      communityRecord(5, { wellKnownURI: "https://two.workers.dev/.well-known/agent-card.json" }),
    ];

    expect(await takenIds(COMMUNITY, records)).toEqual(["c-1", "c-4", "c-5"]);
  });

  it("leaves out a party that already holds a reviewed record from another source, before the ceiling counts", async () => {
    // Ten of the oldest records stand on parties another source already holds. The ceiling is filled from the others, so 96 are taken
    // and not 86.
    const skippedUnits = Array.from({ length: 10 }, (_, index) => `skipped${index}.example`);
    const skipped = skippedUnits.map((unit, index) =>
      communityRecord(index, { wellKnownURI: `https://${unit}/.well-known/agent-card.json`, url: `https://${unit}/a2a` })
    );
    const others = Array.from({ length: 100 }, (_, index) => communityRecord(index + 11));

    const ids = await takenIds(COMMUNITY, [...skipped, ...others], new Set(skippedUnits));

    expect(ids).toHaveLength(96);
    expect(ids[0]).toBe("c-11");
    expect(ids.at(-1)).toBe("c-106");
    expect(ids.some(id => Number(id.slice(2)) < 10)).toBe(false);
  });

  it("sorts a record that does not say when it was created last", async () => {
    const records = [communityRecord(1, { created_at: null }), communityRecord(2), communityRecord(3, { created_at: "later" })];

    expect(await takenIds(COMMUNITY, records)).toEqual(["c-2", "c-1", "c-3"]);
  });

  it("leaves out a record over the record cap and takes one just under it", async () => {
    const { maxRecordBytes } = a2aRegistryPolicy(COMMUNITY);
    const padded = (n: number, size: number) => communityRecord(n, { maintainer_notes: "x".repeat(size) });
    const base = Buffer.byteLength(JSON.stringify(padded(1, 0)));

    expect(await takenIds(COMMUNITY, [padded(1, maxRecordBytes - base), padded(2, maxRecordBytes - base + 1)])).toEqual(["c-1"]);
  });

  it("counts a record with no id as read and rejected, and a record seen twice as one", async () => {
    vi.stubGlobal("fetch", listFetch(COMMUNITY, [communityRecord(1), { name: "no id" }, communityRecord(1)]));

    const snapshot = await fetchA2aRegistryCatalog(registrySource(COMMUNITY), { pause: async () => {} });

    expect(snapshot.discoveredCount).toBe(2);
    expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.rejectedCount).toBe(1);
  });
});

describe("what is retained", () => {
  it("stores the record as the registry served it under its content hash, with the registry's own words kept as findings", async () => {
    const record = communityRecord(7);
    vi.stubGlobal("fetch", listFetch(COMMUNITY, [record]));
    const source = registrySource(COMMUNITY);

    const snapshot = await fetchA2aRegistryCatalog(source, { pause: async () => {} });

    const rawText = JSON.stringify(record);
    const hash = createHash("sha256").update(rawText).digest("hex");
    expect(mocks.storagePut).toHaveBeenCalledWith(`nooscape/raw/catalog/${source.id}/${hash}.json`, rawText, "application/json");
    expect(snapshot.observations[0]!.observation).toMatchObject({
      canonicalLocator: "https://a2aregistry.org/api/agents#c-7",
      contentHash: hash,
      rawObjectKey: `nooscape/raw/catalog/${source.id}/${hash}.json`,
      contentType: "application/json",
      httpStatus: 200,
      validationStatus: "valid",
      validationFindings: [
        "Retained from a2aregistry.org community A2A registry.",
        "registry-reported conformance check: passed; not independently verified by Nooscape.",
        "registry-reported health check: healthy; not independently verified by Nooscape.",
        "registry-reported task probe: working; not independently verified by Nooscape.",
      ],
    });
  });
});

describe("what is read", () => {
  it("asks a2aregistry.org for pages by offset, 100 at a time, and waits between requests", async () => {
    const fetchMock = listFetch(COMMUNITY, Array.from({ length: 150 }, (_, index) => communityRecord(index + 1)));
    vi.stubGlobal("fetch", fetchMock);
    const pause = vi.fn(async (_ms: number) => {});

    const snapshot = await fetchA2aRegistryCatalog(registrySource(COMMUNITY), { pause });

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://a2aregistry.org/api/agents?limit=100&offset=0",
      "https://a2aregistry.org/api/agents?limit=100&offset=100",
    ]);
    expect(snapshot.requestCount).toBe(2);
    expect(pause.mock.calls).toEqual([[A2A_REGISTRY_PAUSE_MS]]);
    expect(A2A_REGISTRY_PAUSE_MS).toBe(1_200);
  });

  it("asks api.a2a-registry.org for pages by page number from 1, which is the parameter it honours", async () => {
    const fetchMock = listFetch(API, Array.from({ length: 150 }, (_, index) => apiRecord(index + 1)));
    vi.stubGlobal("fetch", fetchMock);

    await fetchA2aRegistryCatalog(registrySource(API), { pause: async () => {} });

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://api.a2a-registry.org/public/agents?limit=100&page=1",
      "https://api.a2a-registry.org/public/agents?limit=100&page=2",
    ]);
  });

  it("reads only the list: a GET with no redirect followed, and no address a record names", async () => {
    const fetchMock = listFetch(COMMUNITY, Array.from({ length: 120 }, (_, index) => communityRecord(index + 1)));
    vi.stubGlobal("fetch", fetchMock);

    await fetchA2aRegistryCatalog(registrySource(COMMUNITY), { pause: async () => {} });

    for (const [url, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url.startsWith("https://a2aregistry.org/api/agents?")).toBe(true);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({ Accept: "application/json" });
    }
  });

  it("stops at the reported total and makes no request past it", async () => {
    const fetchMock = listFetch(API, Array.from({ length: 100 }, (_, index) => apiRecord(index + 1)));
    vi.stubGlobal("fetch", fetchMock);

    await fetchA2aRegistryCatalog(registrySource(API), { pause: async () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks the registry's host is public before the first request", async () => {
    vi.stubGlobal("fetch", listFetch(API, [apiRecord(1)]));

    await fetchA2aRegistryCatalog(registrySource(API), { pause: async () => {} });

    expect(mocks.assertPublicHostname).toHaveBeenCalledWith("api.a2a-registry.org");
  });
});

describe("what fails the run, loudly", () => {
  const run = (key: typeof COMMUNITY | typeof API = COMMUNITY) => fetchA2aRegistryCatalog(registrySource(key), { pause: async () => {} });

  it("fails when the registry reports more records than the approved scan limit, and takes nothing", async () => {
    const { maxRecords } = a2aRegistryPolicy(COMMUNITY);
    vi.stubGlobal("fetch", listFetch(COMMUNITY, [communityRecord(1)], maxRecords + 1));

    await expect(run()).rejects.toThrow(`reports ${maxRecords + 1} records, over the approved scan limit of ${maxRecords}.`);
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("accepts a registry at exactly the scan limit's total as far as the check goes", async () => {
    const { maxRecords } = a2aRegistryPolicy(COMMUNITY);
    // Reports exactly the limit but the list runs dry after one page: that is the other failure, not the limit.
    vi.stubGlobal("fetch", listFetch(COMMUNITY, [communityRecord(1)], maxRecords));

    await expect(run()).rejects.toThrow(`list ended after 1 of the ${maxRecords} records it reported.`);
  });

  it("fails when the list ends before the records it reported", async () => {
    vi.stubGlobal("fetch", listFetch(COMMUNITY, Array.from({ length: 100 }, (_, index) => communityRecord(index + 1)), 150));

    await expect(run()).rejects.toThrow("list ended after 100 of the 150 records it reported.");
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("fails on a status that is not a success, a body that is not JSON and a type that does not say JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { status: 503 })));
    await expect(run()).rejects.toThrow("returned HTTP 503.");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse("<html>not json</html>")));
    await expect(run()).rejects.toThrow("page was not valid JSON.");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ agents: [], total: 0 }, { contentType: "text/html" })));
    await expect(run()).rejects.toThrow("did not declare a JSON payload.");
  });

  it("fails on an answer without the documented shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ total: 1 })));
    await expect(run()).rejects.toThrow("page did not have the documented shape.");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ agents: [], total: "many" })));
    await expect(run()).rejects.toThrow("did not report a record total.");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ agents: [], total: -1 })));
    await expect(run()).rejects.toThrow("did not report a record total.");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: false, agents: [], total: 0 })));
    await expect(run(API)).rejects.toThrow("page did not have the documented shape.");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ agents: Array.from({ length: 101 }, (_, index) => communityRecord(index)), total: 101 })));
    await expect(run()).rejects.toThrow("page held more records than the page size.");
  });

  it("fails on a page over the size limit, by its declared length and by the bytes that arrive, and stops reading", async () => {
    const { maxPageBytes } = a2aRegistryPolicy(COMMUNITY);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ agents: [], total: 0 }, { contentLength: maxPageBytes + 1 })));
    await expect(run()).rejects.toThrow("page exceeds the response limit.");

    const piece = 1024 * 1024;
    let served = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(piece).fill(0x20));
        served += piece;
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) }, body }) as unknown as Response)
    );
    await expect(run()).rejects.toThrow("page exceeds the response limit.");
    expect(cancelled).toBe(true);
    expect(served).toBeLessThanOrEqual(maxPageBytes + 4 * piece);
  });

  it("fails on a request that stalls, under the armed timer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
          })
      )
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const verdict = run().then(
      () => {
        throw new Error("expected the stalled request to time out");
      },
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(20_000);

    const error = await verdict;
    expect(error).toBeInstanceOf(A2aRegistryValidationError);
    expect((error as Error).message).toBe("a2aregistry.org community A2A registry request timed out.");
  });

  it("fails on a request that errors, and never says why in the registry's words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("redirect mode is set to error"); }));

    await expect(run()).rejects.toThrow("request failed without following redirects.");
  });
});

describe("which sources may be read", () => {
  it("knows two source keys", () => {
    expect([...A2A_REGISTRY_SOURCE_KEYS]).toEqual([COMMUNITY, API]);
    expect(isA2aRegistrySourceKey(COMMUNITY)).toBe(true);
    expect(isA2aRegistrySourceKey("agenstry-public-catalog")).toBe(false);
  });

  it.each([
    ["a protocol that is not catalog", { protocol: "a2a" as const }],
    ["a source key that is nobody's", { sourceKey: "somebody-else" }],
    ["a source that is not active", { state: "review" as const }],
    ["a stored address that is not the approved one", { rootUrl: "https://a2aregistry.org/api/agents?limit=1" }],
    ["a stored host that is not the approved one", { allowedHostname: "example.org" }],
  ])("refuses %s, before any request", async (_label, overrides) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchA2aRegistryCatalog(registrySource(COMMUNITY, overrides as Partial<IngestionSource>), { pause: async () => {} })).rejects.toThrow(A2aRegistryValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("holds the approved bounds of each registry", () => {
    expect(a2aRegistryPolicy(COMMUNITY)).toEqual({ listUrl: "https://a2aregistry.org/api/agents", maxRecords: 2_000, maxPageBytes: 2 * 1024 * 1024, maxRecordBytes: 128 * 1024, pageSize: 100 });
    expect(a2aRegistryPolicy(API)).toEqual({ listUrl: "https://api.a2a-registry.org/public/agents", maxRecords: 5_000, maxPageBytes: 1.5 * 1024 * 1024, maxRecordBytes: 256 * 1024, pageSize: 100 });
  });
});
