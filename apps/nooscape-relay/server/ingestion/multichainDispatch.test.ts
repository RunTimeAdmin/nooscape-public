import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ERC8004_CHAINS } from "./erc8004Chains";
import { INGESTION_PROTOCOLS } from "./types";

/**
 * Where each chain's source goes when the scheduled worker picks it up, and that every chain of the pass is a protocol the
 * database and the rest of the code know. The worker's dispatch is not exported, so it is read at the source: the three chains
 * added after BNB Chain go to the one chain pass as a scheduled trigger, BNB Chain keeps its own entry point, and the pass itself
 * (runErc8004Chain.ts) is what refuses an unscheduled source or a chain that is switched off.
 */
const read = (...parts: string[]) => readFileSync(path.resolve(process.cwd(), ...parts), "utf8");

describe("the scheduled worker", () => {
  const worker = read("server", "ingestion", "worker.ts");

  it("sends Ethereum, Base and Arc to the one chain pass, looked up by the source's protocol, as a scheduled trigger", () => {
    const block = worker.slice(worker.indexOf('case "erc8004_eth":'), worker.indexOf('case "solana_said":'));
    for (const protocol of ["erc8004_eth", "erc8004_base", "erc8004_arc", "erc8004_monad", "erc8004_gnosis"]) expect(block).toContain(`case "${protocol}":`);
    expect(block).toContain("erc8004ChainOfProtocol(source.protocol)");
    expect(block).toContain('runApprovedErc8004ChainSource(chain, source, "scheduled")');
    expect(block).not.toContain("runApprovedBscRegistrySource");
  });

  it("keeps BNB Chain on its own entry point", () => {
    const bnb = worker.slice(worker.indexOf('case "erc8004_bsc":'), worker.indexOf('case "erc8004_eth":'));
    expect(bnb).toContain('return runApprovedBscRegistrySource(source, "scheduled");');
  });

  it("falls through to the error for a protocol it has no adapter for, so a new value is never run by accident", () => {
    expect(worker).toContain("No scheduled adapter is available for protocol");
  });
});

describe("the operator's page", () => {
  it("has, for every chain of the pass, a label, a Run chain pass button for its source and, for each chain with a switch, a Stage button behind that switch", () => {
    const page = read("client", "src", "pages", "SourceOperations.tsx");
    const runLine = page.split(String.fromCharCode(10)).find(line => line.includes("Run chain pass"))!;
    expect(runLine).toBeDefined();
    for (const chain of ERC8004_CHAINS) {
      expect(page, chain.protocol).toContain(`if (protocol === "${chain.protocol}") return "${chain.label === "BNB Smart Chain" ? "BNB Chain" : chain.label} ERC-8004 registry";`);
      expect(runLine, chain.protocol).toContain(`source.protocol === "${chain.protocol}"`);
      if (chain.feature === null) continue;
      expect(page, chain.protocol).toContain(`featureOn("${chain.feature}", import.meta.env.VITE_FEATURES)`);
      expect(page, chain.protocol).toContain(`Stage ${chain.label} ERC-8004 registry`);
    }
  });
});

describe("every chain of the pass is a protocol the database knows", () => {
  it("is in the list of ingestion protocols, in the schema's enum on every table that carries it, and in the migration that added it if it is a later one (0046, 0053 for Monad or 0057 for Gnosis)", () => {
    const schema = read("drizzle", "schema.ts");
    const addedBy: Record<string, string> = { erc8004_monad: "0053_monad_erc8004_protocol.sql", erc8004_gnosis: "0057_gnosis_erc8004_protocol.sql" };
    for (const chain of ERC8004_CHAINS) {
      expect(INGESTION_PROTOCOLS as readonly string[], chain.protocol).toContain(chain.protocol);
      expect(schema.split(`"${chain.protocol}"`).length - 1, chain.protocol).toBeGreaterThanOrEqual(3);
      const migration = read("drizzle", addedBy[chain.protocol] ?? "0046_multichain_erc8004_protocols.sql");
      if (chain.protocol !== "erc8004_bsc") expect(migration.split(`'${chain.protocol}'`).length - 1, chain.protocol).toBe(4);
    }
  });

  it("is the same list in the schema as in the code, on all three places the schema holds it", () => {
    const schema = read("drizzle", "schema.ts");
    const lists = [...schema.matchAll(/mysqlEnum\("protocol", \[([^\]]*)\]\)/g)].map(match => match[1]!).filter(list => list.includes("erc8004_bsc"));
    expect(lists).toHaveLength(3);
    const expected = INGESTION_PROTOCOLS.map(protocol => `"${protocol}"`).join(", ");
    for (const list of lists) expect(list).toBe(expected);
  });
});
