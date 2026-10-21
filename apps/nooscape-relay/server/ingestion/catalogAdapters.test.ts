import { describe, expect, it, vi } from "vitest";
import { AGENSTRY_MAX_ACCEPTED_RECORDS, AGENSTRY_MAX_DIRECTORY_ENTRIES, agenstryDirectoryDraft, fetchAgenstryCatalog } from "./agenstry";
import { METAPLEX_MAX_ACCEPTED_RECORDS, METAPLEX_MAX_PAGES, metaplexPageUrl } from "./metaplex";
import { fetchAgentEconomyCensus } from "./agenteconomy";
import type { IngestionSource } from "../../drizzle/schema";

function source(overrides: Partial<IngestionSource>): IngestionSource {
  return {
    id: "source-id",
    sourceKey: "source-key",
    label: "Source",
    protocol: "a2a",
    rootUrl: "https://example.com/.well-known/agent-card.json",
    allowedHostname: "example.com",
    state: "active",
    scheduleMinutes: 1440, executionPolicy: "scheduled",
    cursor: null,
    lastSuccessfulAt: null,
    nextRunAt: null,
    failureCount: 0,
    lastError: null,
    createdByUserId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("bounded public-feed adapters", () => {
  it("keeps the reviewed catalog intake ceiling explicit and bounded", () => {
    expect(AGENSTRY_MAX_ACCEPTED_RECORDS).toBe(96);
    expect(AGENSTRY_MAX_ACCEPTED_RECORDS).toBeLessThan(100);
  });

  it("keeps the full-feed directory harvest ceiling explicit and bounded", () => {
    // The 2026-10-09 feed held ~213.7k acknowledged-kind records; the ceiling
    // must admit them all without admitting unbounded growth.
    expect(AGENSTRY_MAX_DIRECTORY_ENTRIES).toBe(240_000);
  });

  it("acknowledges MCP and paid API records with kind-prefixed directory keys", () => {
    const mcp = agenstryDirectoryDraft({
      kind: "mcp",
      id: "0oeaaeo420/raw-discord-mcp",
      name: "raw-discord-mcp",
      url: "https://smithery.ai/servers/0oeaaeo420/raw-discord-mcp",
    });
    expect(mcp?.externalKey).toBe("mcp:0oeaaeo420/raw-discord-mcp");
    expect(mcp?.displayName).toBe("raw-discord-mcp");
    expect(mcp?.locatorHost).toBe("smithery.ai");
    expect(mcp?.sourceSignalNote).toContain("MCP server listing");

    const paid = agenstryDirectoryDraft({
      kind: "paid_api",
      id: "01a046b2-7104-74c2-8a02-04715d7235e1-1aw0hwejp-xai-org.vercel.app",
      name: "01A046B2-7104-74C2-8A02-04715D7235E1-1Aw0Hwejp-Xai-Org",
      url: "https://01a046b2-7104-74c2-8a02-04715d7235e1-1aw0hwejp-xai-org.vercel.app/",
    });
    expect(paid?.externalKey).toBe("paid_api:01a046b2-7104-74c2-8a02-04715d7235e1-1aw0hwejp-xai-org.vercel.app");
    expect(paid?.sourceSignalNote).toContain("Paid API endpoint");

    // a2a_agent keys stay unprefixed so previously acknowledged entries keep
    // their (sourceId, externalKey) identity across this expansion.
    const a2a = agenstryDirectoryDraft({
      kind: "a2a_agent",
      id: "0xarchive-e895b8e7.main-kill-isr.mintlify.me",
      name: "0xArchive",
      url: "https://0xarchive-e895b8e7.main-kill-isr.mintlify.me/.well-known/agent-card.json",
      signed: true,
    });
    expect(a2a?.externalKey).toBe("0xarchive-e895b8e7.main-kill-isr.mintlify.me");
    expect(a2a?.sourceSignalNote).toContain("upstream verification signals");
  });

  it("keeps authored content and catalog self-listings out of the directory", () => {
    expect(agenstryDirectoryDraft({ kind: "skill", id: "00susu00/wiki-idea-llm-harness:.claude/skills/wikillm/skill.md", name: "wikillm", url: "https://github.com/00susu00/wiki-idea-llm-harness" })).toBeNull();
    expect(agenstryDirectoryDraft({ kind: "workflow", id: "n8n-workflow-10000.n8n.io", name: "TikTok Video Machine", url: "https://n8n.io/workflows/10000" })).toBeNull();
    expect(agenstryDirectoryDraft({ kind: "mcp", id: "agenstry-self", name: "Agenstry", url: "https://agenstry.com/servers/agenstry-self" })).toBeNull();
    expect(agenstryDirectoryDraft({ kind: "mcp", id: "", name: "No id", url: "https://smithery.ai/servers/x" })).toBeNull();
    expect(agenstryDirectoryDraft({ kind: "mcp", id: "s", name: "Sanctioned", url: "https://smithery.ai/servers/s", sanction_flag: true })).toBeNull();
  });

  it("keeps the Metaplex multi-page scan within reviewed bounds", () => {
    expect(METAPLEX_MAX_PAGES).toBe(10);
    expect(METAPLEX_MAX_ACCEPTED_RECORDS).toBe(192);
    expect(METAPLEX_MAX_ACCEPTED_RECORDS).toBeLessThanOrEqual(METAPLEX_MAX_PAGES * 24);
  });

  it("derives Metaplex page URLs on the approved registry origin only", () => {
    const rootUrl = "https://api.metaplex.com/v1/agents?page=1&pageSize=24&sort=latest&activeOnly=true";
    expect(metaplexPageUrl(rootUrl, 1)).toBe(rootUrl);
    expect(metaplexPageUrl(rootUrl, 4)).toBe("https://api.metaplex.com/v1/agents?page=4&pageSize=24&sort=latest&activeOnly=true");
    expect(() => metaplexPageUrl("https://evil.example/v1/agents?page=1", 2)).toThrow(/approved Metaplex API origin/);
  });

  it("refuses a non-catalog source before requesting Agenstry", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(fetchAgenstryCatalog(source({ protocol: "a2a" }))).rejects.toThrow("approved Agenstry catalog");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("refuses a non-census source before requesting Agent Economy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(fetchAgentEconomyCensus(source({ protocol: "a2a" }))).rejects.toThrow("approved Agent Economy census");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
