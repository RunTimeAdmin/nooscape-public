import { describe, expect, it } from "vitest";
import { servedChains } from "./apiChains";
import { AGENTS_EXPORT_FIELDS, agentsExportFiles, exportRowOf, type ExportSourceRow } from "./exportAgents";

/** One line of the daily export, worked out from one directory row by the rules the agent's own API answer uses. */
const ALL_ON = "chain_ethereum,chain_base,chain_arc,chain_monad,chain_gnosis,chain_celo";
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const row = (overrides: Partial<ExportSourceRow> = {}): ExportSourceRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  externalKey: `eip155:42220:${REGISTRY}:1312`,
  protocol: "erc8004_celo",
  displayName: "Loops Business Agent",
  registrant: "0xabcdef0123456789abcdef0123456789abcdef01",
  locatorHost: "agent.example",
  profileUriHash: "a".repeat(64),
  feedbackCount: 3,
  firstSeenAt: new Date("2026-11-20T00:21:00Z"),
  lastSeenAt: new Date("2026-11-21T22:00:00Z"),
  pinnedAt: null,
  evidence: null,
  ...overrides,
});

describe("a line of the agents export", () => {
  it("gives the fields in the order the export names them, with the agent's id on its chain and its page", () => {
    const line = exportRowOf(row(), servedChains(ALL_ON))!;
    expect(Object.keys(line)).toEqual([...AGENTS_EXPORT_FIELDS]);
    expect(line).toEqual({
      chain: "celo",
      agent_id: "1312",
      registry: "erc8004_celo",
      nooscape_id: "11111111-1111-1111-1111-111111111111",
      page_url: "https://nooscape.si/agents/11111111-1111-1111-1111-111111111111",
      name: "Loops Business Agent",
      registrant: "0xabcdef0123456789abcdef0123456789abcdef01",
      locator_host: "agent.example",
      first_seen_at: "2026-11-20T00:21:00.000Z",
      last_seen_at: "2026-11-21T22:00:00.000Z",
      listed_because: "rules",
      evidence_level: null,
      feedback_count: 3,
    });
  });

  it("leaves out a row on a chain the API does not serve under these switches, and a protocol on no chain", () => {
    expect(exportRowOf(row(), servedChains("chain_arc"))).toBeNull();
    expect(exportRowOf(row({ protocol: "catalog", externalKey: "cat-1" }), servedChains(ALL_ON))).toBeNull();
    expect(exportRowOf(row({ protocol: "a2a", externalKey: "https://a.example" }), servedChains(ALL_ON))).toBeNull();
  });

  it("gives a Solana agent its address as its id, and names the registry", () => {
    const line = exportRowOf(row({ protocol: "solana_said", externalKey: "So11111111111111111111111111111111111111112" }), servedChains(undefined))!;
    expect(line).toMatchObject({ chain: "solana", agent_id: "So11111111111111111111111111111111111111112", registry: "solana_said" });
  });

  it("says an operator pinned it when one did", () => {
    expect(exportRowOf(row({ pinnedAt: new Date("2026-11-01T00:00:00Z") }), servedChains(ALL_ON))!.listed_because).toBe("operator_pin");
  });

  it("gives a BNB agent the evidence level of its page, read from the link it carries now, and every other chain none", () => {
    const bnb = (evidence: ExportSourceRow["evidence"], profileUriHash = "b".repeat(64)) =>
      exportRowOf(row({ protocol: "erc8004_bsc", externalKey: `eip155:56:${REGISTRY}:7`, profileUriHash, evidence }), servedChains(undefined))!.evidence_level;
    expect(bnb({ readStatus: "inline", readAt: new Date("2026-11-01T00:00:00Z"), profileUriHash: "b".repeat(64) })).toBe("checked_unproven");
    // A read of an older link, a link the step does not read, or no row at all is not checked.
    expect(bnb({ readStatus: "inline", readAt: new Date("2026-11-01T00:00:00Z"), profileUriHash: "c".repeat(64) })).toBe("not_checked");
    expect(bnb({ readStatus: "link_not_read", readAt: new Date("2026-11-01T00:00:00Z"), profileUriHash: "b".repeat(64) })).toBe("not_checked");
    expect(bnb(null)).toBe("not_checked");
    expect(exportRowOf(row({ evidence: { readStatus: "inline", readAt: new Date(), profileUriHash: "a".repeat(64) } }), servedChains(ALL_ON))!.evidence_level).toBeNull();
  });

  it("shows the name as the site does: a blank name is the registries' placeholder", () => {
    const line = exportRowOf(row({ displayName: "   " }), servedChains(ALL_ON))!;
    expect(line.name.trim()).not.toBe("");
  });

  it("names a day's two files by the dataset and the date", () => {
    expect(agentsExportFiles("2026-11-22")).toEqual({ data: "agents-2026-11-22.jsonl.gz", manifest: "agents-2026-11-22.manifest.json" });
  });
});
