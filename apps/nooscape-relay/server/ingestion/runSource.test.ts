import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const runner = (name: string) => vi.fn(async (..._args: unknown[]) => ({ ran: name }));
  return {
    a2a: runner("a2a"),
    catalog: runner("catalog"),
    census: runner("census"),
    metaplex: runner("metaplex"),
    s8004: runner("s8004"),
    said: runner("said"),
    agenc: runner("agenc"),
    bsc: runner("bsc"),
    chain: runner("chain"),
    robinhood: runner("robinhood"),
    reputation: runner("reputation"),
    usdg: runner("usdg"),
  };
});
vi.mock("./runA2a", () => ({ runApprovedA2aSource: mocks.a2a }));
vi.mock("./runCatalog", () => ({ runApprovedCatalogSource: mocks.catalog }));
vi.mock("./runAgentEconomy", () => ({ runApprovedAgentEconomySource: mocks.census }));
vi.mock("./runMetaplex", () => ({ runApprovedMetaplexRegistrySource: mocks.metaplex }));
vi.mock("./run8004Solana", () => ({ runApproved8004SolanaSource: mocks.s8004 }));
vi.mock("./runSaid", () => ({ runApprovedSaidSource: mocks.said }));
vi.mock("./runAgenc", () => ({ runApprovedAgencSource: mocks.agenc }));
vi.mock("./runBsc", () => ({ runApprovedBscRegistrySource: mocks.bsc }));
vi.mock("./runErc8004Chain", () => ({ runApprovedErc8004ChainSource: mocks.chain }));
vi.mock("./runRobinhood", () => ({ runApprovedRobinhoodRegistrySource: mocks.robinhood }));
vi.mock("./runRobinhoodReputation", () => ({ runApprovedRobinhoodReputationSource: mocks.reputation }));
vi.mock("./runUsdg", () => ({ runApprovedUsdgSettlementSource: mocks.usdg }));

import type { IngestionSource } from "../../drizzle/schema";
import { EXTRA_CHAIN_SPECS } from "@shared/chains";
import { erc8004ChainOfProtocol } from "./erc8004Chains";
import { ManualOnlySourceError, NoSourceAdapterError, runSource, SourceModeRefusedError, type RunMode } from "./runSource";

/**
 * The one dispatch the scheduled worker and an operator's run share (runSource.ts): which adapter a source goes to, with which trigger
 * and mode, and what is refused before any adapter runs. The adapters are stand-ins that record their calls.
 */
const source = (protocol: string) => ({ id: "s-1", protocol }) as unknown as IngestionSource;
const MODES: RunMode[] = ["observe", "backfill", "registrants", "activity"];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
});

describe("where a source goes", () => {
  it("sends each protocol to its own adapter with the trigger, and runs nothing else", async () => {
    const cases: Array<[string, keyof typeof mocks]> = [
      ["a2a", "a2a"],
      ["catalog", "catalog"],
      ["census", "census"],
      ["solana_registry", "metaplex"],
      ["solana_8004", "s8004"],
      ["solana_said", "said"],
      ["solana_agenc", "agenc"],
      ["erc8004_bsc", "bsc"],
      ["erc8004", "robinhood"],
    ];
    for (const [protocol, adapter] of cases) {
      for (const trigger of ["scheduled", "manual"] as const) {
        for (const mock of Object.values(mocks)) mock.mockClear();
        expect(await runSource(source(protocol), trigger), `${protocol} ${trigger}`).toEqual({ ran: adapter });
        expect(mocks[adapter], `${protocol} ${trigger}`).toHaveBeenCalledTimes(1);
        expect(mocks[adapter].mock.calls[0]![1], `${protocol} ${trigger}`).toBe(trigger);
        expect(Object.values(mocks).filter(mock => mock.mock.calls.length > 0)).toHaveLength(1);
      }
    }
  });

  it("sends every extra chain to the one chain pass with its own chain entry, and BNB Smart Chain to its own entry point", async () => {
    for (const spec of EXTRA_CHAIN_SPECS) {
      mocks.chain.mockClear();
      await runSource(source(spec.protocol), "scheduled");
      expect(mocks.chain, spec.key).toHaveBeenCalledWith(erc8004ChainOfProtocol(spec.protocol), source(spec.protocol), "scheduled");
    }
    await runSource(source("erc8004_bsc"), "scheduled");
    expect(mocks.bsc).toHaveBeenCalledTimes(1);
    expect(mocks.chain).toHaveBeenCalledTimes(1);
  });

  it("runs a scheduled source in the activity mode, the one unattended-safe mode of the adapters that have modes", async () => {
    await runSource(source("solana_registry"), "scheduled");
    expect(mocks.metaplex).toHaveBeenCalledWith(source("solana_registry"), "scheduled", "activity");
    await runSource(source("erc8004"), "scheduled");
    expect(mocks.robinhood).toHaveBeenCalledWith(source("erc8004"), "scheduled", "activity");
  });

  it("passes an operator's mode on to the adapters that have modes, as each understands it", async () => {
    for (const mode of MODES) {
      await runSource(source("erc8004"), "manual", mode);
      expect(mocks.robinhood).toHaveBeenLastCalledWith(source("erc8004"), "manual", mode);
      await runSource(source("erc8004_reputation"), "manual", mode);
      expect(mocks.reputation).toHaveBeenLastCalledWith(source("erc8004_reputation"), "manual", mode === "activity" ? "activity" : "backfill");
    }
    await runSource(source("solana_registry"), "manual", "observe");
    expect(mocks.metaplex).toHaveBeenLastCalledWith(source("solana_registry"), "manual", "observe");
  });
});

describe("what is refused before any adapter runs", () => {
  it("refuses an operator's mode the adapter does not have, in fixed words that name the kind of source", async () => {
    const activityOnly: Array<[string, string]> = [
      ["solana_8004", "The 8004 Solana registry supports the chain activity pass only."],
      ["solana_said", "The SAID Solana registry supports the chain activity pass only."],
      ["solana_agenc", "The AgenC Solana registry supports the chain activity pass only."],
      ["erc8004_bsc", "The BNB Chain identity registry supports the chain activity pass only."],
      ...EXTRA_CHAIN_SPECS.map(spec => [spec.protocol, `The ${spec.label} identity registry supports the chain activity pass only.`] as [string, string]),
    ];
    for (const [protocol, words] of activityOnly) {
      for (const mode of ["observe", "backfill", "registrants"] as const) {
        await expect(runSource(source(protocol), "manual", mode), `${protocol} ${mode}`).rejects.toEqual(new SourceModeRefusedError(words));
      }
      await expect(runSource(source(protocol), "manual", "activity")).resolves.toBeDefined();
    }
    for (const mode of ["backfill", "registrants"] as const) {
      await expect(runSource(source("solana_registry"), "manual", mode)).rejects.toEqual(new SourceModeRefusedError("The Metaplex Solana registry supports the observe and activity modes only."));
    }
    expect(mocks.s8004).toHaveBeenCalledTimes(1);
    expect(mocks.metaplex).not.toHaveBeenCalled();
  });

  it("never lets the scheduled worker run the two operator-paced adapters, and lets an operator run them", async () => {
    await expect(runSource(source("erc8004_reputation"), "scheduled")).rejects.toEqual(new ManualOnlySourceError("Robinhood ERC-8004 reputation sources are manual-only and cannot run in the scheduled worker."));
    await expect(runSource(source("usdg_settlement"), "scheduled")).rejects.toEqual(new ManualOnlySourceError("USDG settlement sources are manual-only and cannot run in the scheduled worker."));
    expect(mocks.reputation).not.toHaveBeenCalled();
    expect(mocks.usdg).not.toHaveBeenCalled();
    await runSource(source("usdg_settlement"), "manual", "observe");
    expect(mocks.usdg).toHaveBeenCalledWith(source("usdg_settlement"), "manual");
  });

  it("runs no protocol it has no adapter for, so a new value is never run by accident, with the words each caller has always given", async () => {
    for (const protocol of ["anp", "agntcy", "erc8004_demo", "something_new"]) {
      await expect(runSource(source(protocol), "scheduled")).rejects.toEqual(new NoSourceAdapterError(protocol, "scheduled"));
      await expect(runSource(source(protocol), "manual", "observe")).rejects.toEqual(new NoSourceAdapterError(protocol, "manual"));
    }
    expect(new NoSourceAdapterError("anp", "scheduled").message).toBe("No scheduled adapter is available for protocol anp.");
    expect(new NoSourceAdapterError("anp", "manual").message).toBe("No bounded adapter is available for anp.");
    expect(Object.values(mocks).every(mock => mock.mock.calls.length === 0)).toBe(true);
  });
});
