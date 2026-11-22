import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isChainPassProtocol } from "@shared/chains";
import { ERC8004_CHAINS, erc8004ChainOfProtocol } from "./erc8004Chains";
import { INGESTION_PROTOCOLS } from "./types";
import { extraChainsToStage, protocolLabel } from "../../client/src/lib/sourceOperationsModel";
import { agentDirectoryEntries, ingestionSources, sourceObservations } from "../../drizzle/schema";

/**
 * Where each chain's source goes when the scheduled worker picks it up, and that every chain of the pass is a protocol the
 * database and the rest of the code know. The worker's dispatch is not exported, so it is read at the source: the three chains
 * added after BNB Chain go to the one chain pass as a scheduled trigger, BNB Chain keeps its own entry point, and the pass itself
 * (runErc8004Chain.ts) is what refuses an unscheduled source or a chain that is switched off.
 */
const read = (...parts: string[]) => readFileSync(path.resolve(process.cwd(), ...parts), "utf8");

describe("the scheduled worker and the operator's runs", () => {
  // Where each protocol goes, with which trigger and mode, and what is refused, is runSource.test.ts's: here, that both callers use it.
  it("send every source through the one dispatch, the worker as a scheduled trigger and the router with the operator's mode", () => {
    expect(read("server", "ingestion", "worker.ts")).toContain('return runSource(source, "scheduled");');
    const router = read("server", "routers", "liveData.ts");
    expect(router).toContain('return await runSource(source, "manual", input.mode);');
    // A refused mode and a protocol with no adapter are the operator's request, answered as such, not as a fault of live data.
    expect(router).toContain('if (error instanceof SourceModeRefusedError || error instanceof NoSourceAdapterError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });');
  });
});

describe("the operator's page", () => {
  it("has, for every chain of the pass, a label, a Run chain pass button for its source and, for each chain with a switch, a Stage button behind that switch", () => {
    const page = read("client", "src", "pages", "SourceOperations.tsx");
    const runLine = page.split(String.fromCharCode(10)).find(line => line.includes("Run chain pass"))!;
    expect(runLine).toBeDefined();
    for (const chain of ERC8004_CHAINS) {
      expect(protocolLabel(chain.protocol), chain.protocol).toBe(`${chain.label === "BNB Smart Chain" ? "BNB Chain" : chain.label} ERC-8004 registry`);
      expect(isChainPassProtocol(chain.protocol), chain.protocol).toBe(true);
      if (chain.feature === null) continue;
      // The console offers the chain's staging button exactly while its switch is on, and the button stages the chain by its key.
      expect(extraChainsToStage(chain.feature).map(spec => [spec.key, spec.label]), chain.protocol).toEqual([[chain.chainKey, chain.chainLabel]]);
      expect(extraChainsToStage(undefined).some(spec => spec.key === chain.chainKey), chain.protocol).toBe(false);
    }
    // One button for each chain the list offers: its words name the chain and its call stages that chain's key.
    expect(page).toContain("const EXTRA_CHAINS_ON = extraChainsToStage(import.meta.env.VITE_FEATURES);");
    expect(page).toContain("onClick={() => registerApprovedMutation.mutate({ source: spec.key })}");
    expect(page).toContain("Stage {spec.label} ERC-8004 registry · manual only");
    // The button's condition is the shared list, not a copy of it, so a chain added to the pass needs no edit here.
    expect(runLine).toContain('source.state === "active" && isChainPassProtocol(source.protocol) ? <Button');
  });
});

describe("the chains of the pass, on the operator's page and in the router", () => {
  it("are one list: the shared predicate holds for exactly the protocols the server's pass reads", () => {
    for (const protocol of INGESTION_PROTOCOLS) expect(isChainPassProtocol(protocol), protocol).toBe(erc8004ChainOfProtocol(protocol) !== null);
    expect(isChainPassProtocol("constructor")).toBe(false);
  });

  it("offer no plain run: a source of the pass has the Run chain pass button, and the router refuses a run in any other mode", () => {
    // The plain "Run once" sends no mode, and the router answers it for a chain of the pass with a refusal. It used to be shown for
    // Ethereum, Base, Arc, Monad, Gnosis and Celo, because the list of exclusions named BNB Chain alone.
    const page = read("client", "src", "pages", "SourceOperations.tsx");
    const runLine = page.split(String.fromCharCode(10)).find(line => line.includes("Run chain pass"))!;
    expect(runLine).toContain('source.protocol !== "solana_agenc" && !isChainPassProtocol(source.protocol) ? <Button');
    expect(read("server", "ingestion", "runSource.ts")).toContain("identity registry`)(mode);");
  });
});

describe("every chain of the pass is a protocol the database knows", () => {
  it("is in the list of ingestion protocols, in the schema's enum on every table that carries it, and in the migration that added it if it is a later one (0046, 0053 for Monad, 0057 for Gnosis or 0060 for Celo)", () => {
    const columns = [ingestionSources.protocol, agentDirectoryEntries.protocol, sourceObservations.protocol];
    const addedBy: Record<string, string> = { erc8004_monad: "0053_monad_erc8004_protocol.sql", erc8004_gnosis: "0057_gnosis_erc8004_protocol.sql", erc8004_celo: "0060_celo_erc8004_protocol.sql" };
    for (const chain of ERC8004_CHAINS) {
      expect(INGESTION_PROTOCOLS as readonly string[], chain.protocol).toContain(chain.protocol);
      for (const column of columns) expect(column.enumValues as readonly string[], `${column.name} ${chain.protocol}`).toContain(chain.protocol);
      const migration = read("drizzle", addedBy[chain.protocol] ?? "0046_multichain_erc8004_protocols.sql");
      if (chain.protocol !== "erc8004_bsc") expect(migration.split(`'${chain.protocol}'`).length - 1, chain.protocol).toBe(4);
    }
  });

  it("is the same list in the schema as in the code, on all three places the schema holds it", () => {
    // The three columns are declared with the code's own list (drizzle/schema.ts imports it), so their values are that list, in its order.
    for (const column of [ingestionSources.protocol, agentDirectoryEntries.protocol, sourceObservations.protocol]) expect(column.enumValues, column.name).toEqual([...INGESTION_PROTOCOLS]);
    expect(read("drizzle", "schema.ts").split('mysqlEnum("protocol", INGESTION_PROTOCOLS)').length - 1).toBe(3);
  });
});
