import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * The full-feed download must fail loudly on every early end — a truncated
 * gzip, our own byte-cap cut, or the armed download timer's abort — and never
 * surface a cut stream as a complete snapshot. The stream teardown paths were
 * verified against Node's real pipeline semantics: a bare pipe parks the line
 * iterator forever on a transport error, so the reader uses pipeline plus an
 * abort-driven destroy. These tests pin each verdict.
 */
const mocks = vi.hoisted(() => ({
  assertPublicHostname: vi.fn(async (_hostname: string) => undefined),
  storagePut: vi.fn(async (key: string) => ({ key })),
}));

vi.mock("./a2a", async importOriginal => {
  const original = await importOriginal<typeof import("./a2a")>();
  return { ...original, assertPublicHostname: mocks.assertPublicHostname };
});

vi.mock("../storage", () => ({
  storagePut: mocks.storagePut,
}));

import { fetchAgenstryCatalog, AgenstryValidationError } from "./agenstry";

function catalogSource(): IngestionSource {
  return {
    id: "source-agenstry",
    sourceKey: "agenstry-public-catalog",
    label: "Agenstry",
    protocol: "catalog",
    rootUrl: "https://agenstry.com/api/feed/all.jsonl.gz",
    allowedHostname: "agenstry.com",
    state: "active",
    executionPolicy: "scheduled",
    scheduleMinutes: 1440,
    cursor: null,
    nextRunAt: null,
    lastSuccessfulAt: null,
    failureCount: 0,
    lastError: null,
    createdByUserId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const A2A_LINE = JSON.stringify({
  kind: "a2a_agent",
  id: "rec-1",
  name: "Test Agent",
  description: "A catalog agent with an upstream signal.",
  url: "https://agent.example.org/.well-known/agent-card.json",
  provider_url: "https://provider.example.org/",
  signed: true,
  category: "research",
});
const MCP_LINE = JSON.stringify({
  kind: "mcp",
  id: "mcp-1",
  name: "Mcp One",
  url: "https://smithery.ai/servers/mcp-1",
});
const FEED = gzipSync(Buffer.from(`${A2A_LINE}\n${MCP_LINE}\n`));

function gzipResponse(body: Buffer) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/gzip" : null) },
    body: Readable.toWeb(Readable.from([body])),
  } as unknown as Response;
}

describe("fetchAgenstryCatalog stream guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns the bounded snapshot with one observation per retained candidate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gzipResponse(FEED)));

    const snapshot = await fetchAgenstryCatalog(catalogSource());

    expect(snapshot.discoveredCount).toBe(2);
    // The mcp line is evidence-rejected (only a2a_agent records carry the
    // reviewed-intake shape) while still being acknowledged into the
    // master directory below — one count, two different verdicts.
    expect(snapshot.rejectedCount).toBe(1);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]!.candidate.displayName).toBe("Test Agent");
    expect(snapshot.candidates[0]!.candidate.externalRecordId).toBe("rec-1");
    expect(snapshot.directory.map(entry => entry.externalKey).sort()).toEqual(["mcp:mcp-1", "rec-1"]);
    expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.observations[0]!.observation.rawObjectKey).toMatch(
      /^nooscape\/raw\/catalog\/source-agenstry\/[0-9a-f]{64}\.json$/
    );
    expect(mocks.storagePut).toHaveBeenCalledTimes(1);
  });

  it("fails loudly on a truncated gzip body instead of trusting a partial snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gzipResponse(FEED.subarray(0, Math.floor(FEED.length / 2)))));

    await expect(fetchAgenstryCatalog(catalogSource())).rejects.toThrow("Agenstry catalog download ended early.");
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("cuts the connection at the compressed cap and reports the violation", async () => {
    // Incompressible payload above the 24 MiB ceiling: the data handler
    // destroys the source the moment the cap is crossed, and the verdict is
    // the cap violation — never a truncated success.
    const oversized = gzipSync(randomBytes(25 * 1024 * 1024));
    vi.stubGlobal("fetch", vi.fn(async () => gzipResponse(oversized)));

    await expect(fetchAgenstryCatalog(catalogSource())).rejects.toThrow(
      "Agenstry catalog exceeded the compressed response limit."
    );
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("cuts the connection at the decompressed cap and reports the violation", async () => {
    // The gzip bomb: the wire body stays far under the 24 MiB compressed
    // cap while the expanded stream sails past the decompressed ceiling —
    // only a bound on the gunzip output can see this. The wire body is 513
    // concatenated single-line gzip members (RFC 1952 multi-member gzip),
    // every line exactly 1 MiB: no single line crosses the 1 MiB line
    // bound, so the verdict can only be the body cap. Member-wise
    // construction keeps the fixture itself near zero peak memory, though
    // the read side must still inflate 512 MiB before the cap trips — the
    // honest cost of pinning the shipped constant instead of an injected
    // one, and the reason for the explicit timeout.
    const member = gzipSync(Buffer.concat([Buffer.alloc(1024 * 1024 - 1, 0x61), Buffer.from("\n")]), { level: 1 });
    const bombWire = Buffer.concat(Array.from({ length: 513 }, () => member));
    vi.stubGlobal("fetch", vi.fn(async () => gzipResponse(bombWire)));

    await expect(fetchAgenstryCatalog(catalogSource())).rejects.toThrow(
      "Agenstry catalog exceeded the decompressed response limit."
    );
    expect(mocks.storagePut).not.toHaveBeenCalled();
  }, 60_000);

  it("cuts the connection while a single line crosses the decompressed line limit", async () => {
    // The reproduced crash shape: one line whose assembly would run far
    // past V8's maximum string length inside readline. The wire cap never
    // sees it (the gzip is tiny) and the post-hoc MAX_RECORD_BYTES check
    // only runs after the whole line is buffered — the pre-buffer bound
    // must tear the download down mid-assembly instead.
    const hostile = gzipSync(Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0x61), Buffer.from("\n")]));
    vi.stubGlobal("fetch", vi.fn(async () => gzipResponse(hostile)));

    await expect(fetchAgenstryCatalog(catalogSource())).rejects.toThrow(
      "Agenstry catalog exceeded the decompressed line limit."
    );
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("aborts a stalled body under the armed download timer", async () => {
    // Headers arrive; the body never does. Only the armed timer's abort —
    // forwarded as a source destroy — can end this read.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = Readable.toWeb(
          Readable.from(
            (async function* () {
              await new Promise(() => {});
              yield FEED;
            })()
          )
        );
        return {
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/gzip" : null) },
          body,
        } as unknown as Response;
      })
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const call = fetchAgenstryCatalog(catalogSource());
    // Handle the rejection the moment it fires: the verdict lands during the
    // timer advance, and a promise rejected before its handler attaches
    // surfaces as an unhandled rejection.
    const verdict = call.then(
      () => {
        throw new Error("expected the stalled body to time out");
      },
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(120_000);

    const error = await verdict;
    expect(error).toBeInstanceOf(AgenstryValidationError);
    expect((error as Error).message).toBe("Agenstry catalog download timed out.");
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("times the request out when the header phase itself stalls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted", "AbortError"))
            );
          })
      )
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const call = fetchAgenstryCatalog(catalogSource());
    const verdict = call.then(
      () => {
        throw new Error("expected the stalled headers to time out");
      },
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(120_000);

    const error = await verdict;
    expect(error).toBeInstanceOf(AgenstryValidationError);
    expect((error as Error).message).toBe("Agenstry catalog request timed out.");
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("still refuses a non-gzip content type under the armed window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
        body: Readable.toWeb(Readable.from([FEED])),
      }) as unknown as Response)
    );

    await expect(fetchAgenstryCatalog(catalogSource())).rejects.toThrow("Agenstry catalog did not declare a gzip payload.");
  });
});
