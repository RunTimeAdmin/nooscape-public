import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * The live check (scripts/verify-live.mjs, run every six hours by .github/workflows/health.yml) failed five times in two days while the
 * site was up: the CDN turned the GitHub runner away with a 403, a 307, or a connection that failed at once. It now asks again for about
 * four minutes before an answer counts, and says what the edge answered. This holds the asking, the report lines and the job's time limit.
 */
const scriptUrl = new URL("../scripts/liveGet.mjs", import.meta.url);
const live = (await import(scriptUrl.href)) as {
  RETRY_STATUSES: readonly number[];
  RETRY_WAITS_MS: readonly number[];
  createLiveGet: (options: {
    base: string;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    sleep?: (ms: number) => Promise<void>;
    waits?: number[];
    timeoutMs?: number;
  }) => { get: (path: string, init?: RequestInit) => Promise<Response>; wasTurnedAway: () => boolean };
  why: (error: unknown) => string;
  statusDetail: (response: Response) => string;
};
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** A fetch that answers with the given statuses in turn; an Error in the list is thrown instead. */
function answers(...items: Array<number | Error>) {
  const queue = [...items];
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("asked more often than the test allowed");
    if (next instanceof Error) throw next;
    return new Response(next === 200 ? "ok" : "no", { status: next });
  });
}

function asker(fetchImpl: ReturnType<typeof answers>) {
  const slept: number[] = [];
  const { get, wasTurnedAway } = live.createLiveGet({
    base: "https://site.example",
    fetchImpl,
    sleep: async ms => {
      slept.push(ms);
    },
  });
  return { get, wasTurnedAway, slept };
}

describe("asking the site", () => {
  it("returns an answer at once when the site gave one, without a wait", async () => {
    const fetchImpl = answers(200);
    const { get, slept } = asker(fetchImpl);
    expect((await get("/")).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://site.example/");
  });

  it("asks again after a 403 or a 307, waiting longer each time, and returns the answer that follows", async () => {
    const fetchImpl = answers(403, 307, 200);
    const { get, slept } = asker(fetchImpl);
    expect((await get("/")).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([10_000, 30_000]);
  });

  it("asks again after a connection that fails, which is what `fetch failed` is", async () => {
    const fetchImpl = answers(new TypeError("fetch failed"), 200);
    const { get, slept } = asker(fetchImpl);
    expect((await get("/api/v1")).status).toBe(200);
    expect(slept).toEqual([10_000]);
  });

  it("gives up after the last wait and returns the edge's last answer, so the check fails as before", async () => {
    const fetchImpl = answers(403, 403, 403, 403, 403);
    const { get, slept, wasTurnedAway } = asker(fetchImpl);
    expect((await get("/")).status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(slept).toEqual([10_000, 30_000, 60_000, 120_000]);
    expect(wasTurnedAway()).toBe(true);
  });

  it("throws the last error when no try is answered, with its cause kept for the report", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    const fetchImpl = answers(reset, reset, reset, reset, reset);
    const { get } = asker(fetchImpl);
    const error = await get("/").catch(thrown => thrown);
    expect(error).toBe(reset);
    expect(live.why(error)).toBe("TypeError: fetch failed (cause: ECONNRESET read ECONNRESET)");
  });

  it("gives the next request one try only once a request has used up its tries, and the retries back once the site answers", async () => {
    const fetchImpl = answers(403, 403, 403, 403, 403, 403, 200, 403, 200);
    const { get, slept, wasTurnedAway } = asker(fetchImpl);
    expect((await get("/a")).status).toBe(403);
    expect(wasTurnedAway()).toBe(true);
    const waitsSoFar = slept.length;
    // A site that is really down: the second request is asked once and does not wait.
    expect((await get("/b")).status).toBe(403);
    expect(slept.length).toBe(waitsSoFar);
    // The site answers: the retries are back for the request after it.
    expect((await get("/c")).status).toBe(200);
    expect(wasTurnedAway()).toBe(false);
    expect((await get("/d")).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });

  it("does not ask again about an answer a check expects, or an error of the app's own", async () => {
    for (const status of [200, 401, 404, 500]) {
      const fetchImpl = answers(status);
      const { get, slept } = asker(fetchImpl);
      expect((await get("/")).status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(slept).toEqual([]);
    }
    expect([...live.RETRY_STATUSES].sort()).toEqual([307, 403, 429, 502, 503, 504]);
  });

  it("sends the same request each time: the method and body of a POST, and no redirect followed", async () => {
    const fetchImpl = answers(403, 401);
    const { get } = asker(fetchImpl);
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: '{"json":{}}' };
    expect((await get("/api/trpc/x", init)).status).toBe(401);
    for (const [, sent] of fetchImpl.mock.calls) {
      expect(sent).toMatchObject({ method: "POST", body: '{"json":{}}', redirect: "manual" });
    }
  });
});

describe("what the report says", () => {
  it("names the cause behind `fetch failed`, and leaves an error without one as it was", () => {
    expect(live.why(new Error("boom"))).toBe("Error: boom");
    expect(live.why("plain text")).toBe("Error: plain text");
    expect(live.why(Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } }))).toBe("TypeError: fetch failed (cause: EAI_AGAIN)");
  });

  it("gives the status alone for an answer a check expects, and what the edge said for one it does not", () => {
    for (const status of [200, 401, 404]) expect(live.statusDetail(new Response(null, { status, headers: { server: "hcdn" } }))).toBe(`HTTP ${status}`);
    expect(live.statusDetail(new Response(null, { status: 403, headers: { server: "hcdn", "cf-ray": "abc-DFW" } }))).toBe("HTTP 403 (server: hcdn, cf-ray: abc-DFW)");
    expect(live.statusDetail(new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }))).toBe("HTTP 307 (location: https://elsewhere.example/)");
    expect(live.statusDetail(new Response(null, { status: 503 }))).toBe("HTTP 503");
  });
});

describe("the live check and its workflow", () => {
  const script = read("../scripts/verify-live.mjs");
  const workflow = read("../../../.github/workflows/health.yml");

  it("asks the site only through the helper and reports errors with their cause", () => {
    expect(script).toContain('import { createLiveGet, statusDetail, why } from "./liveGet.mjs";');
    expect(script).toContain("const { get } = createLiveGet({ base: BASE });");
    expect(script).not.toContain("await fetch(");
    expect(script).not.toContain("String(error)");
    expect(script).not.toMatch(/`HTTP \$\{/);
  });

  it("leaves the job time for a site that is really down: every wait, a first request that times out on every try, and the others once", () => {
    const limit = Number(/timeout-minutes: (\d+)/.exec(workflow)![1]) * 60_000;
    const timeout = 30_000;
    const requests = 13;
    const waits = live.RETRY_WAITS_MS.reduce((sum, wait) => sum + wait, 0);
    const worst = waits + (live.RETRY_WAITS_MS.length + 1) * timeout + (requests - 1) * timeout;
    expect(worst).toBeLessThan(limit);
    expect(waits).toBeLessThanOrEqual(4 * 60_000);
  });
});
