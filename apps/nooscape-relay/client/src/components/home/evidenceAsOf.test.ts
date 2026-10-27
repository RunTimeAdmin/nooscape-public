import { readFileSync } from "node:fs";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { asOfSentence, EvidenceAsOf, staleSince } from "./EvidenceAsOf";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const home = read("../../pages/Home.tsx");
const model = read("../../pages/home/atlasModel.ts");
const parts = read("../../pages/home/atlasParts.tsx");
const deep = read("../../pages/home/DeepSpace.tsx");
const field = read("../../pages/home/FieldView.tsx");

describe("when the evidence on the page is from an earlier read", () => {
  it("is only after a read that failed on top of a read that worked", () => {
    expect(staleSince({ isRefetchError: false, dataUpdatedAt: 1_700_000_000_000 })).toBeNull();
    expect(staleSince({ isRefetchError: true, dataUpdatedAt: 0 })).toBeNull();
    expect(staleSince({ isRefetchError: true, dataUpdatedAt: 1_700_000_000_000 })).toBe(1_700_000_000_000);
  });

  it("is what TanStack Query reports for a poll that fails after a good read, with the last data kept", async () => {
    const client = new QueryClient();
    let calls = 0;
    const observer = new QueryObserver<{ sequence: number }>(client, {
      queryKey: ["evidence"],
      retry: false,
      queryFn: async () => {
        calls += 1;
        if (calls > 1) throw new Error("relay unavailable");
        return { sequence: 7 };
      },
    });
    const first = await observer.refetch();
    expect(staleSince(first)).toBeNull();
    const failed = await observer.refetch();
    expect(failed.data).toEqual({ sequence: 7 });
    expect(failed.isRefetchError).toBe(true);
    expect(staleSince(failed)).toBe(first.dataUpdatedAt);
    client.clear();
  });

  it("says when it was read and why the page shows it", () => {
    const sentence = asOfSentence(Date.UTC(2026, 9, 23, 14, 32), () => "14:32");
    expect(sentence).toBe("As of 14:32. The latest read failed, so this is the last envelope that was read.");
  });

  it("draws nothing while the reads work and a status note after one fails", () => {
    expect(renderToStaticMarkup(createElement(EvidenceAsOf, { at: null }))).toBe("");
    const at = Date.UTC(2026, 9, 23, 14, 32);
    const markup = renderToStaticMarkup(createElement(EvidenceAsOf, { at }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain(asOfSentence(at));
  });
});

describe("where the page says it", () => {
  it("reads the evidence once a minute, in the page's query and in the comparison cards", () => {
    expect(model).toContain("export const EVIDENCE_POLL = { refetchInterval: 60_000, refetchOnWindowFocus: true } as const;");
    expect(deep).toContain("trpc.atlas.evidence.useQuery({ agentId: agent.id }, EVIDENCE_POLL)");
    for (const source of [home, model, parts, deep]) expect(source).not.toContain("refetchInterval: 8_000");
  });

  it("puts the note on the field aside, the Deep Space feed, the record drawer and each comparison card", () => {
    expect(home).toContain("const evidenceStaleSince = staleSince(evidenceQuery);");
    expect(field).toContain("<LiveEvidenceFeed evidence={activeEvidence} loading={evidenceQuery.isLoading} asOf={evidenceStaleSince} />");
    expect(home).toContain("evidenceAsOf={evidenceStaleSince}");
    expect(home).toContain("evidenceStaleSince={evidenceStaleSince}");
    expect(deep).toContain("<LiveEvidenceFeed evidence={evidence} loading={evidenceLoading} asOf={evidenceAsOf} />");
    expect(deep).toContain("<AgentActivityDrawer agent={selected} evidence={evidence} loading={evidenceLoading} asOf={evidenceAsOf}");
    // The record drawer and the evidence feed both draw the note from the time they are given.
    expect(deep).toContain("<EvidenceAsOf at={asOf} />");
    expect(parts).toContain("<EvidenceAsOf at={asOf} />");
    expect(deep).toContain("<EvidenceAsOf at={staleSince(evidenceRead)} />");
  });
});
