import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";
import type { ResolvedAddress, SafeFetchDeps } from "../safeFetch";
import { fetchA2aAgentCard } from "./a2a";

const storage = vi.hoisted(() => ({ storagePut: vi.fn(async (key: string, _body: string, _type: string) => ({ key, url: "" })) }));
vi.mock("../storage", () => ({ storagePut: storage.storagePut }));

/**
 * The fetch of an approved A2A card, through the real safeFetch over a faked network (outside review of 2 November 2026, M1). It used to
 * check the host's addresses with one lookup and then fetch by name, which looks it up again, so a host could answer the check with a
 * public address and the connection with another. These tests pin what the card fetch now asks of the network and what it makes of the
 * answers. The card text itself is read in a2a.test.ts.
 */
const HOST = "card.example.org";
const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const CAP = 256 * 1024;
const CARD = { name: "Example Agent", description: "Answers questions.", skills: [{ name: "search" }], url: "https://card.example.org/api/a2a" };
const source = (overrides: Record<string, unknown> = {}) =>
  ({ id: "src-a2a", protocol: "a2a", state: "active", rootUrl: `https://${HOST}`, allowedHostname: HOST, ...overrides }) as unknown as IngestionSource;

type Script = { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; hang?: boolean };

/** A request that plays one script and records the options it was given. */
function network(script: Script = {}, table: Record<string, ResolvedAddress[]> = { [HOST]: [PUBLIC] }) {
  const seen: RequestOptions[] = [];
  const asked: string[] = [];
  const resolve: SafeFetchDeps["resolve"] = async hostname => {
    asked.push(hostname);
    const answers = table[hostname];
    if (!answers) throw new Error("ENOTFOUND");
    return answers;
  };
  const request: SafeFetchDeps["request"] = (options, onResponse) => {
    seen.push(options);
    const fake = new EventEmitter() as unknown as ClientRequest;
    Object.assign(fake, {
      destroy: () => fake,
      end: () => {
        queueMicrotask(() => {
          if (script.hang) return;
          const response = new EventEmitter() as unknown as IncomingMessage;
          response.statusCode = script.status ?? 200;
          response.headers = script.headers ?? { "content-type": "application/json" };
          response.socket = { remoteAddress: PUBLIC.address, getProtocol: () => "TLSv1.3" } as unknown as IncomingMessage["socket"];
          response.destroy = () => response;
          onResponse(response);
          queueMicrotask(() => {
            for (const chunk of script.chunks ?? []) response.emit("data", chunk);
            response.emit("end");
          });
        });
      },
    });
    return fake;
  };
  return { deps: { resolve, request } as Partial<SafeFetchDeps>, seen, asked };
}

const body = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fetches = (script: Script, table?: Record<string, ResolvedAddress[]>) => {
  const net = network(script, table);
  return { ...net, run: (overrides: Record<string, unknown> = {}) => fetchA2aAgentCard(source(overrides), net.deps) };
};

beforeEach(() => storage.storagePut.mockClear());
afterEach(() => vi.useRealTimers());

describe("fetching an approved A2A card", () => {
  it("asks for the one well-known path, names itself as the indexer, takes no compression, and keeps the exact bytes it was sent", async () => {
    const raw = body(CARD);
    const { run, seen, asked } = fetches({ chunks: [raw] });

    const { candidate, observation } = await run();

    expect(asked).toEqual([HOST]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", hostname: HOST, port: 443, path: "/.well-known/agent-card.json", servername: HOST, rejectUnauthorized: true });
    expect(seen[0]!.headers).toEqual({
      "user-agent": "Nooscape-Source-Indexer/0.1 (+https://nooscape.si)",
      accept: "application/json, application/*+json;q=0.9",
      "accept-encoding": "identity",
      connection: "close",
    });
    expect(candidate).toMatchObject({ displayName: "Example Agent", agentCardUrl: `https://${HOST}/.well-known/agent-card.json`, endpointUrl: "https://card.example.org/api/a2a" });
    expect(observation).toMatchObject({
      canonicalLocator: `https://${HOST}/.well-known/agent-card.json`,
      contentHash: sha256(raw),
      rawObjectKey: `nooscape/raw/a2a/src-a2a/${sha256(raw)}.json`,
      contentType: "application/json",
      httpStatus: 200,
      validationStatus: "valid",
      validationFindings: [],
    });
    expect(storage.storagePut).toHaveBeenCalledWith(`nooscape/raw/a2a/src-a2a/${sha256(raw)}.json`, raw.toString("utf8"), "application/json");
  });

  it("connects only to the addresses it checked: a host that answers differently the second time is not followed", async () => {
    let calls = 0;
    const { deps, seen } = network({ chunks: [body(CARD)] });
    deps.resolve = async () => {
      calls += 1;
      return calls === 1 ? [PUBLIC] : [{ address: "169.254.169.254", family: 4 }];
    };

    await fetchA2aAgentCard(source(), deps);

    expect(calls).toBe(1);
    const lookup = seen[0]!.lookup as unknown as (name: string, options: unknown, callback: (...args: unknown[]) => void) => void;
    const answered = vi.fn();
    lookup(HOST, { all: true }, answered);
    // The pinned lookup answers on a later tick, as dns.lookup does (lead N10 of the outside audit).
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(answered).toHaveBeenCalledWith(null, [{ address: PUBLIC.address, family: 4 }]);
  });

  it("refuses a name that resolves into private address space, and connects to nothing", async () => {
    const { run, seen } = fetches({ chunks: [body(CARD)] }, { [HOST]: [PUBLIC, { address: "10.0.0.7", family: 4 }] });
    await expect(run()).rejects.toThrow("The A2A hostname resolves to a forbidden network address.");
    expect(seen).toHaveLength(0);
    expect(storage.storagePut).not.toHaveBeenCalled();
  });

  it("refuses a name that does not resolve", async () => {
    const { run, seen } = fetches({}, {});
    await expect(run()).rejects.toThrow("The A2A hostname could not be resolved.");
    expect(seen).toHaveLength(0);
  });

  it("does not follow a redirect, even to the same host", async () => {
    const { run, seen } = fetches({ status: 302, headers: { location: `https://${HOST}/elsewhere` } });
    await expect(run()).rejects.toThrow("A2A source request failed without following redirects.");
    expect(seen).toHaveLength(1);
    expect(storage.storagePut).not.toHaveBeenCalled();
  });

  it("refuses any answer that is not a success, and stores nothing", async () => {
    for (const status of [400, 404, 500, 503]) {
      const { run } = fetches({ status, chunks: [body(CARD)] });
      await expect(run(), String(status)).rejects.toThrow(`A2A source returned HTTP ${status}.`);
    }
    expect(storage.storagePut).not.toHaveBeenCalled();
  });

  it("takes a card of exactly 256 KiB and refuses one a byte longer, without parsing what it kept", async () => {
    const padded = (bytes: number) => {
      const shell = JSON.stringify({ name: "Big Agent", description: "" });
      return Buffer.from(JSON.stringify({ name: "Big Agent", description: "a".repeat(bytes - shell.length) }), "utf8");
    };
    const atCap = padded(CAP);
    expect(atCap.length).toBe(CAP);
    const accepted = await fetches({ chunks: [atCap] }).run();
    expect(accepted.observation.contentHash).toBe(sha256(atCap));

    storage.storagePut.mockClear();
    await expect(fetches({ chunks: [padded(CAP + 1)] }).run()).rejects.toThrow("AgentCard exceeds the 256 KiB response limit.");
    expect(storage.storagePut).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, and one that is not a card", async () => {
    await expect(fetches({ chunks: [body("<html>not a card</html>")] }).run()).rejects.toThrow("AgentCard did not contain valid JSON.");
    await expect(fetches({ chunks: [body("")] }).run()).rejects.toThrow("AgentCard did not contain valid JSON.");
    await expect(fetches({ chunks: [body([1, 2])] }).run()).rejects.toThrow("The AgentCard must be a JSON object.");
    expect(storage.storagePut).not.toHaveBeenCalled();
  });

  it("notes a content type that is not JSON, and still reads the card", async () => {
    const { observation } = await fetches({ headers: { "content-type": "text/plain" }, chunks: [body(CARD)] }).run();
    expect(observation).toMatchObject({ contentType: "text/plain", validationStatus: "partial", validationFindings: ["Response content type was not a JSON media type."] });
  });

  it("gives up on a host that goes quiet at the one deadline", async () => {
    vi.useFakeTimers();
    const { run } = fetches({ hang: true });
    const pending = run().then(
      () => {
        throw new Error("expected a timeout");
      },
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(5_100);
    expect(((await pending) as Error).message).toBe("A2A source request timed out.");
  });

  it("asks nothing of the network when the source is not an active A2A source with the host its root names", async () => {
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ protocol: "catalog" }, "Source protocol is not A2A."],
      [{ state: "paused" }, "Only active sources may be fetched."],
      [{ allowedHostname: "other.example.org" }, "Stored A2A host policy does not match the source root."],
      [{ rootUrl: "http://card.example.org" }, "A2A sources must use HTTPS."],
    ];
    for (const [overrides, message] of refusals) {
      const { run, asked, seen } = fetches({ chunks: [body(CARD)] });
      await expect(run(overrides), message).rejects.toThrow(message);
      expect(asked).toHaveLength(0);
      expect(seen).toHaveLength(0);
    }
  });
});
