import { createTRPCUntypedClient } from "@trpc/client";
import { readFileSync } from "node:fs";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import { apiLinks } from "./trpcLinks";
import { ownRequest } from "./trpc";

/**
 * A batch answers only when its slowest call has, so the first batch of the home page held the hero's figures behind a read
 * that took 11 seconds. A query marked `ownRequest` goes in a request of its own. Tested on the real links with a fetch that
 * records what it is asked, and then on the queries the page marks.
 */
const answer = (value: unknown) => ({ result: { data: superjson.serialize(value) } });

function recordingClient() {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async input => {
    const url = new URL(String(input), "http://localhost");
    requests.push(decodeURIComponent(url.pathname.replace("/api/trpc/", "")));
    const names = decodeURIComponent(url.pathname.replace("/api/trpc/", "")).split(",");
    const body = url.searchParams.get("batch") ? names.map(() => answer("ok")) : answer("ok");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requests, client: createTRPCUntypedClient({ links: apiLinks(fetch) }) };
}

describe("the client's links", () => {
  it("batches the calls made in the same moment into one request", async () => {
    const { requests, client } = recordingClient();
    await Promise.all([client.query("liveData.chainStats"), client.query("liveData.publicRecords"), client.query("liveData.publicCoverage")]);
    expect(requests).toEqual(["liveData.chainStats,liveData.publicRecords,liveData.publicCoverage"]);
  });

  it("sends a call marked ownRequest in a request of its own, and still batches the rest", async () => {
    const { requests, client } = recordingClient();
    await Promise.all([
      client.query("liveData.chainStats"),
      client.query("liveData.noosphereSample", undefined, { context: ownRequest.trpc.context }),
      client.query("liveData.publicRecords"),
      client.query("liveData.arrivals", undefined, { context: ownRequest.trpc.context }),
    ]);
    expect([...requests].sort()).toEqual(["liveData.arrivals", "liveData.chainStats,liveData.publicRecords", "liveData.noosphereSample"]);
  });
});

describe("the queries the page sends alone", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("are the hero's sample, which is the heaviest read when its cache is cold, and the new-entries read, which the hero can do without", () => {
    const hero = source("../components/home/HeroScene.tsx");
    expect(hero).toMatch(/noosphereSample\.useQuery\([^)]*\.\.\.ownRequest/);
    expect(hero).toMatch(/arrivals\.useQuery\([^)]*\.\.\.ownRequest/);
    expect(source("../components/home/JustArrived.tsx")).toMatch(/arrivals\.useQuery\([^)]*\.\.\.ownRequest/);
  });

  it("are not the hero's other reads, so the sweep line and the map are not each a request of their own", () => {
    const hero = source("../components/home/HeroScene.tsx");
    expect(hero).not.toMatch(/chainStats\.useQuery\([^)]*ownRequest/);
  });
});
