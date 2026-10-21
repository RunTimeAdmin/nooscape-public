import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chainSourcePreset } from "./chainPresets";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./erc8004Chains";
import { resolveRpcUrl } from "./erc8004Rpc";

/**
 * The words of the extra chains. Say what was recorded and when; never write that anything is verified, safe, trusted or
 * guaranteed. Guarded at the source: every string the new code can put in front of an operator or a reader is read here, because
 * the repo has no browser test runner. One sentence is shared with BNB Chain and Robinhood Chain and is allowed by name below: a
 * registration note ends "current ownership is not verified". It is the house wording for every chain, it says the opposite of a
 * claim, and BNB Chain's notes must stay as they are.
 */
const FORBIDDEN = /\b(verified|safe|trusted|guaranteed)\b/i;
const root = process.cwd();
const read = (...parts: string[]) => readFileSync(path.resolve(root, ...parts), "utf8");
const BACKSLASH = String.fromCharCode(92);

/** The text of every string literal in a TypeScript source, comments left out. Templates are taken whole, `${...}` included. */
function stringLiterals(source: string): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < source.length) {
    const here = source[index]!;
    const next = source[index + 1];
    if (here === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (here === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (here === '"' || here === "'" || here === "`") {
      let literal = "";
      index += 1;
      while (index < source.length && source[index] !== here) {
        if (source[index] === BACKSLASH) {
          literal += source[index]! + (source[index + 1] ?? "");
          index += 2;
        } else {
          literal += source[index];
          index += 1;
        }
      }
      found.push(literal);
      index += 1;
    } else {
      index += 1;
    }
  }
  return found;
}

afterEach(() => vi.unstubAllEnvs());

describe("the strings of the new code", () => {
  const FILES: Array<[string, string[]]> = [
    ["the RPC client", ["server", "ingestion", "erc8004Rpc.ts"]],
    ["the runner", ["server", "ingestion", "runErc8004Chain.ts"]],
    ["the staging module", ["server", "ingestion", "chainPresets.ts"]],
    ["the chain list", ["server", "ingestion", "erc8004Chains.ts"]],
    ["the Arc node helper", ["server", "arcRpc.ts"]],
  ];
  for (const [label, parts] of FILES) {
    it(`say none of the four words in ${label}`, () => {
      const literals = stringLiterals(read(...parts));
      expect(literals.length).toBeGreaterThan(5);
      for (const literal of literals) expect(literal).not.toMatch(FORBIDDEN);
    });
  }

  it("say none of the four words in the shared decoding, but for the one sentence every chain's note ends with", () => {
    const literals = stringLiterals(read("server", "ingestion", "erc8004Chain.ts"));
    const flagged = literals.filter(literal => FORBIDDEN.test(literal));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain("current ownership is not verified.");
    // It negates the word: it never says an owner is verified.
    expect(flagged[0]).not.toMatch(/(?<!not )verified/i);
  });

  it("say none of the four words in the buttons and labels of the operator's page for the new chains", () => {
    const page = read("client", "src", "pages", "SourceOperations.tsx");
    const lines = page.split("\n").filter(line => /Stage (Ethereum|Base|Arc) ERC-8004|erc8004_(eth|base|arc)"\) return/.test(line));
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) expect(line).not.toMatch(FORBIDDEN);
  });

  const chains: readonly Erc8004Chain[] = [ETHEREUM_CHAIN, BASE_CHAIN, ARC_CHAIN];

  it("say none of the four words in what a chain is called, what its notes say about a link, or what its source is called", () => {
    vi.stubEnv("X402_RPC", "https://arc-node.example/v1/x");
    for (const chain of chains) {
      const preset = chainSourcePreset(chain, "chain_ethereum,chain_base,chain_arc");
      for (const text of [chain.label, chain.chainLabel, chain.fetchSentence, preset.label, preset.sourceKey]) expect(text, chain.protocol).not.toMatch(FORBIDDEN);
    }
  });

  it("say none of the four words when a chain is switched off or its endpoint is not set", () => {
    for (const chain of chains) {
      let off = "";
      try {
        chainSourcePreset(chain, "");
      } catch (error) {
        off = (error as Error).message;
      }
      expect(off, chain.protocol).toContain("switched off");
      expect(off, chain.protocol).not.toMatch(FORBIDDEN);
      let missing = "";
      try {
        resolveRpcUrl(chain, chain.provider.kind === "pinned" ? chain.provider.allowedHostname : "node.example", "");
      } catch (error) {
        missing = (error as Error).message;
      }
      expect(missing, chain.protocol).toContain("is not configured");
      expect(missing, chain.protocol).not.toMatch(FORBIDDEN);
    }
  });

  it("find a forbidden word when one is there, so the guard can fail", () => {
    expect(stringLiterals('const a = "this is verified"; // safe')).toEqual(["this is verified"]);
    expect(FORBIDDEN.test("this is verified")).toBe(true);
    expect(FORBIDDEN.test("a guaranteed result")).toBe(true);
    expect(FORBIDDEN.test("safely")).toBe(false);
    expect(stringLiterals("const a = `trusted ${x} source`;")).toEqual(["trusted ${x} source"]);
  });
});
