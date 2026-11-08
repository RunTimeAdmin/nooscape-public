import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Where the server calls `fetch` itself (outside review of 2 November 2026, M1). Every request to an address that a publisher or a
 * registrant supplied (registration files, endpoint checks, domain proofs, SAID cards, webhooks, robots.txt) goes through safeFetch,
 * which resolves the name once and connects only to the addresses it checked. A plain `fetch` resolves the name for itself, so a host
 * that answers differently the second time (DNS rebinding) is not stopped by a check made before it. Nooscape can leave that gap only
 * where the host is one it picked: a URL fixed in the adapter, or the RPC the operator sets. This test lists those places, so that a
 * new plain `fetch` is a decision somebody makes (add the file here, with the reason) and not something nobody notices.
 *
 * It reads the source, so it is a tripwire and not a proof: a fetch reached by another name (`const get = fetch`) is not seen. The
 * payment modules take the global `fetch` as an injectable default for the facilitator and the node, both set by the operator, and are
 * read in their own tests.
 */
const app = fileURLToPath(new URL("..", import.meta.url));

/** Files with a direct `fetch(` call, how many, and why each host is one Nooscape picked. */
const DIRECT: Record<string, { calls: number; why: string }> = {
  "server/bscB1Measure.ts": { calls: 1, why: "a measurement tool that reads Nooscape's own public count" },
  "server/ingestion/agenstry.ts": { calls: 1, why: "the Agenstry catalog feed, the one URL fixed in the adapter" },
  "server/ingestion/deadlineFetch.ts": { calls: 1, why: "the wrapper whose callers are listed below" },
  "server/ingestion/metaplex.ts": { calls: 1, why: "the Metaplex registry's pages: the root must be the fixed URL on api.metaplex.com" },
  "server/ingestion/robinhood.ts": { calls: 1, why: "the Robinhood Chain RPC, fixed in the adapter" },
  "server/ingestion/solanaRpc.ts": { calls: 1, why: "the Solana RPC the operator sets in the environment" },
  "server/politeFetch.ts": { calls: 1, why: "not a call: the method called fetch on the polite client, which goes through safeFetch" },
};

/** Files that call the deadline wrapper, which is a plain `fetch`, and how many times. */
const WRAPPED: Record<string, { calls: number; why: string }> = {
  "server/ingestion/a2aRegistryCatalog.ts": { calls: 1, why: "the two A2A registries' list endpoints, the one URL fixed in the adapter for each registry, with no address taken from a record" },
  "server/ingestion/agenteconomy.ts": { calls: 1, why: "the Agent Economy census feed, the one URL fixed in the adapter" },
  "server/ingestion/erc8004Rpc.ts": { calls: 1, why: "the chains' RPC: a host pinned in the chain table, or the operator's own node" },
};

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const code = sources(join(app, "server")).map(path => ({ file: relative(app, path).replaceAll("\\", "/"), text: withoutComments(readFileSync(path, "utf8")) }));
/** Each file and how many times `pattern` matches in it, for the files where it matches at all. */
const countBy = (pattern: RegExp) =>
  Object.fromEntries(code.map(({ file, text }) => [file, [...text.matchAll(pattern)].length] as const).filter(([, calls]) => calls > 0));
const expected = (list: Record<string, { calls: number }>) => Object.fromEntries(Object.entries(list).map(([file, { calls }]) => [file, calls]));

describe("the places the server calls fetch itself", () => {
  it("are the ones listed, each on a host Nooscape picked", () => {
    expect(countBy(/(^|[^\w.$])fetch\(/g), "a new direct fetch: use safeFetch for any address a publisher or registrant supplied, or list the file in DIRECT with the reason").toEqual(expected(DIRECT));
  });

  it("include the callers of the deadline wrapper, which is a plain fetch", () => {
    // Its own declaration (`function fetchUnderDeadline<T>(`) is not a call.
    const call = /(?<![\w.$])(?<!function )fetchUnderDeadline(?:<[^>]*>)?\(/g;
    expect(countBy(call), "a new caller of fetchUnderDeadline: list it in WRAPPED with the reason, or use safeFetch").toEqual(expected(WRAPPED));
  });

  it("have a reason each", () => {
    for (const [file, { why }] of [...Object.entries(DIRECT), ...Object.entries(WRAPPED)]) expect(why.length, file).toBeGreaterThan(20);
  });
});
