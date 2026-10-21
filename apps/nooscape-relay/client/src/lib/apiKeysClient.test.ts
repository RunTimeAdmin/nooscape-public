import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_TIERS } from "../../../shared/apiKey";
import { curlFor, endpointsLine, fetchUsage, KeyLookupError, looksLikeKey, tierLines } from "./apiKeysFlow";
import { GENERIC_ERROR_LINE } from "./claimFlow";

/**
 * The API keys page's words and its one read (docs/data-access-2026-10-19.md, stage D2): the usage lookup against the answers the
 * API gives, the refusals in plain words with no key in them, and the page held to its rule of saving nothing in the browser and
 * sending the key nowhere but the header and the call that ends it.
 */
const KEY = `nsk_${"k".repeat(40)}`;
const here = fileURLToPath(new URL(".", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, ...parts), "utf8");

const usageBody = {
  api_version: "v1",
  as_of: "2026-10-19T03:00:00.000Z",
  license: {},
  data: {
    key: { prefix: "nsk_kkkkkk", tier: "free" },
    limits: { per_minute: 60, per_day: 1000 },
    today: { date: "2026-10-19", used: 12, remaining: 988, limit: 1000, resets_at: "2026-10-20T00:00:00.000Z" },
    days: [
      { date: "2026-10-19", total: 12, by_endpoint: { agent: 9, search: 2, usage: 1 } },
      { date: "2026-10-18", total: 5, by_endpoint: { batch: 5 } },
    ],
  },
};

const answering = (status: number, body: unknown): typeof fetch => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("the tiers on the page", () => {
  it("are the tiers the server enforces, in order, with the numbers written out", () => {
    const lines = tierLines();
    expect(lines.map(line => line.tier)).toEqual(["free", "builder", "pro"]);
    expect(lines[0]).toEqual({ tier: "free", label: "Free", line: "60 a minute, 1,000 a day" });
    for (const line of lines) {
      expect(line.line).toContain(API_TIERS[line.tier].perMinute.toLocaleString("en-US"));
      expect(line.line).toContain(API_TIERS[line.tier].perDay.toLocaleString("en-US"));
    }
  });
});

describe("a key as typed", () => {
  it("is taken when it is nsk_ and 40 characters, trimmed, and refused otherwise", () => {
    expect(looksLikeKey(KEY)).toBe(true);
    expect(looksLikeKey(`  ${KEY}\n`)).toBe(true);
    for (const text of ["", "nsk_", KEY.slice(1), `${KEY}x`, KEY.replace("nsk_", "sk_"), `${KEY.slice(0, 43)}!`]) expect(looksLikeKey(text), JSON.stringify(text)).toBe(false);
  });

  it("is shown in the curl example as the caller will send it, to the batch call", () => {
    const line = curlFor(KEY, "https://nooscape.si");
    expect(line).toContain(`Authorization: Bearer ${KEY}`);
    expect(line).toContain("https://nooscape.si/api/v1/agents/batch");
  });
});

describe("looking a key's use up", () => {
  it("reads the answer the API gives into what the page shows, sending the key in the header and not in the address", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const view = await fetchUsage(`  ${KEY} `, async (input, init) => {
      seen = { url: String(input), headers: init?.headers as Record<string, string> };
      return new Response(JSON.stringify(usageBody), { status: 200 });
    });
    expect(seen).toEqual({ url: "/api/v1/usage", headers: { Authorization: `Bearer ${KEY}` } });
    expect(view.prefix).toBe("nsk_kkkkkk");
    expect(view.tier).toBe("free");
    expect(view.perMinute).toBe(60);
    expect(view.today).toEqual({ date: "2026-10-19", used: 12, remaining: 988, limit: 1000, resetsAt: "2026-10-20T00:00:00.000Z" });
    expect(view.days).toEqual([
      { date: "2026-10-19", total: 12, byEndpoint: { agent: 9, search: 2, usage: 1 } },
      { date: "2026-10-18", total: 5, byEndpoint: { batch: 5 } },
    ]);
  });

  it("says a key that is wrong or ended is not valid, and tells a day's total from a minute's", async () => {
    await expect(fetchUsage(KEY, answering(401, { error: { code: "invalid_key", message: "x" } }))).rejects.toThrow("That key is not valid, or it has been ended.");
    await expect(fetchUsage(KEY, answering(429, { error: { code: "quota_exceeded", message: "x" } }))).rejects.toThrow("The count restarts at 00:00 UTC.");
    await expect(fetchUsage(KEY, answering(429, { error: { code: "rate_limited", message: "x" } }))).rejects.toThrow("Wait a minute and try again.");
    await expect(fetchUsage(KEY, answering(503, { error: { code: "unavailable", message: "x" } }))).rejects.toThrow("Keys are not available right now.");
  });

  it("gives a plain line when the call fails, the body is not the answer, or the network is down, and never puts the key in a message", async () => {
    const failures: Array<typeof fetch> = [
      answering(500, "boom"),
      answering(200, "not json"),
      answering(200, { data: null }),
      answering(404, { error: { code: "not_found", message: "x" } }),
      async () => {
        throw new TypeError(`failed to fetch with ${KEY}`);
      },
      answering(401, { error: { code: "invalid_key", message: KEY } }),
      answering(429, { error: { code: "rate_limited", message: KEY } }),
    ];
    for (const failing of failures) {
      const error = await fetchUsage(KEY, failing).catch(caught => caught);
      expect(error).toBeInstanceOf(KeyLookupError);
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message.length).toBeGreaterThan(10);
    }
    await expect(fetchUsage(KEY, answering(500, "boom"))).rejects.toThrow(GENERIC_ERROR_LINE);
  });

  it("copes with a body missing fields by showing zeros and an empty list, not by throwing", async () => {
    const view = await fetchUsage(KEY, answering(200, { data: { key: { prefix: "nsk_kkkkkk" } } }));
    expect(view).toMatchObject({ prefix: "nsk_kkkkkk", tier: "", perDay: 0, days: [] });
    expect(view.today.used).toBe(0);
  });

  it("lists a day's endpoints most used first, ties by name", () => {
    expect(endpointsLine({ usage: 1, agent: 9, search: 2 })).toBe("agent 9, search 2, usage 1");
    expect(endpointsLine({ b: 2, a: 2 })).toBe("a 2, b 2");
    expect(endpointsLine({ agent: 12345 })).toBe("agent 12,345");
    expect(endpointsLine({})).toBe("");
  });
});

describe("the page", () => {
  const page = read("..", "pages", "DeveloperKeys.tsx");
  const flow = read("apiKeysFlow.ts");

  it("saves nothing in the browser and puts the key in no address", () => {
    expect(page).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State/);
    expect(flow).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(flow).not.toMatch(/\?key=|\?apiKey=|searchParams|encodeURIComponent\(key/);
    expect(page).toContain("NOTHING_SAVED_LINE");
  });

  it("sends the key to two places only: the API in a header, and the call that ends it", () => {
    expect(page.match(/revoke\.mutateAsync\(/g)).toHaveLength(1);
    expect(page.match(/fetchUsage\(/g)?.length).toBeGreaterThan(0);
    expect(page).not.toMatch(/console\.(log|info|debug)/);
    expect(page).not.toMatch(/navigator\.sendBeacon|XMLHttpRequest/);
  });

  it("shows the key once: it is held in the page's memory, cleared when it is ended, and the lookup field hides it", () => {
    expect(page).toContain('type="password"');
    expect(page).toContain('autoComplete="off"');
    expect(page).toContain("SHOWN_ONCE_LINE");
    expect(page).toContain("setMade(null)");
  });
});
