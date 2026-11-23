import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The smaller follow-ups of the frontend audit of 22 November 2026, held by the shape of the code (the client's tests run without a DOM). */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("the claim panel", () => {
  const panel = read("../components/claim/ClaimPanel.tsx");

  it("lets a wallet that switched accounts go, says why, and stops any wait on it", () => {
    const watch = panel.slice(panel.indexOf("return watchAccount("), panel.indexOf("}, [connected]);"));
    expect(watch).toContain("attempt.current += 1;");
    expect(watch).toContain("disconnect();");
    expect(watch).toContain("setError(ACCOUNT_CHANGED_LINE);");
  });

  it("says the claim could not be read, with a retry, instead of leaving the panel out", () => {
    const unavailable = panel.slice(panel.indexOf('if (view === "unavailable") {'), panel.indexOf("async function connect()"));
    expect(unavailable).toContain("{CLAIM_UNAVAILABLE_LINE}");
    expect(unavailable).toContain("onClick={() => void stateQuery.refetch()}");
  });
});

describe("the operator page", () => {
  it("reads the open evidence check again after a run, which makes a new batch", () => {
    const page = read("./SourceOperations.tsx");
    const refresh = page.slice(page.indexOf("const refresh = () => {"), page.indexOf("};", page.indexOf("const refresh = () => {")));
    expect(refresh).toContain("void utils.liveData.admin.verifySourceEvidenceBatch.invalidate();");
  });
});

describe("the Owl's Catch archive", () => {
  it("keeps the list on screen while 'show more' reads the longer one, and says it is reading", () => {
    const page = read("./Catch.tsx");
    expect(page).toContain("placeholderData: keepPreviousData");
    expect(page).toContain('query.isPlaceholderData ? "Reading the older catches…"');
  });
});

describe("the operator's payments alert", () => {
  it("says when it could not read the payments, with a retry, instead of looking like nothing is unsettled", () => {
    const panel = read("../components/apikeys/OperatorPayments.tsx");
    const alert = panel.slice(panel.indexOf("export function PaymentsAlert()"), panel.indexOf("export function OperatorPayments()"));
    expect(alert).toContain("if (status.isError && !data) {");
    expect(alert).toContain("{PAYMENTS_UNREAD_LINE}");
    expect(alert).toContain("onClick={() => void status.refetch()}");
  });
});

describe("the last low items of the audit", () => {
  it("empties the claim form when the claim it was editing is removed", () => {
    expect(read("../components/claim/ClaimPanel.tsx")).toContain("setForm(claim ? formFromProfile(claim.profile) : EMPTY_FORM);");
  });

  it("shows the directory's search results only for the words in the box, not the last ones answered", () => {
    const page = read("./Home.tsx");
    expect(page).toContain("const directoryHits = settledSearch === agentSearch.trim() ? (directorySearchQuery.data ?? undefined) : undefined;");
    expect(page).toContain("directoryHits={directoryHits}");
  });

  it("takes the owl choice made in another tab", () => {
    const owl = read("../contexts/OwlContext.tsx");
    expect(owl).toContain('window.addEventListener("storage", onStorage);');
    expect(owl).toContain('if (event.key === STORAGE_KEY) setEnabledState(event.newValue !== "off");');
  });
});
