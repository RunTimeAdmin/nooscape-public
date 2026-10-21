import { describe, expect, it } from "vitest";
import { collapseVisibleSnapshots, resolveWithdrawnAgentIds, snapshotCardFingerprint, type PublicSnapshotRow } from "./db";

const observedAt = new Date("2026-10-08T12:00:00.000Z");

function row(
  overrides: Partial<PublicSnapshotRow> & { agentId: string }
): PublicSnapshotRow {
  return {
    displayName: "Agent",
    handle: "agent-handle",
    primaryCapability: null,
    summary: null,
    protocols: "[]",
    snapshotPublisherState: "unverified",
    snapshotEvidenceTier: "tier_2",
    readModelPublisherState: null,
    readModelEvidenceTier: null,
    readModelVerificationExpiresAt: null,
    readModelVerifiedCardHash: null,
    readModelPublisherExpiresAt: null,
    sourceCount: 1,
    lastObservedAt: observedAt,
    ...overrides,
  };
}

describe("reviewed-run gate visibility collapse", () => {
  it("keeps only the newest visible snapshot per agent", () => {
    const newer = row({ agentId: "a1", handle: "a1-new" });
    const older = row({
      agentId: "a1",
      handle: "a1-old",
      lastObservedAt: new Date("2026-10-07T00:00:00.000Z"),
    });
    const other = row({ agentId: "a2", handle: "a2" });

    // Rows arrive ordered by observedAt descending.
    const collapsed = collapseVisibleSnapshots([newer, older, other]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toMatchObject({ agentId: "a1", handle: "a1-new" });
    expect(collapsed[1]).toMatchObject({ agentId: "a2" });
  });

  it("overlays per-agent evidence governance from the read model", () => {
    const collapsed = collapseVisibleSnapshots([
      row({
        agentId: "a1",
        snapshotPublisherState: "unverified",
        snapshotEvidenceTier: "tier_2",
        readModelPublisherState: "allowlisted",
        readModelEvidenceTier: "tier_3",
      }),
    ]);

    expect(collapsed).toEqual([
      expect.objectContaining({
        publisherState: "allowlisted",
        evidenceTier: "tier_3",
      }),
    ]);
  });

  it("falls back to snapshot governance when the read model has no row", () => {
    const collapsed = collapseVisibleSnapshots([
      row({
        agentId: "a1",
        snapshotPublisherState: "unverified",
        snapshotEvidenceTier: "tier_2",
      }),
    ]);

    expect(collapsed).toEqual([
      expect.objectContaining({
        publisherState: "unverified",
        evidenceTier: "tier_2",
      }),
    ]);
  });

  const pinnedCard = { displayName: "Agent", primaryCapability: null, summary: null, protocols: "[]" };
  const evaluationTime = new Date("2026-10-08T12:00:00.000Z");

  it("keeps a domain-control upgrade while its window is open and the card is unchanged", () => {
    const collapsed = collapseVisibleSnapshots(
      [
        row({
          agentId: "a1",
          readModelEvidenceTier: "tier_3",
          readModelVerificationExpiresAt: new Date("2027-01-06T00:00:00.000Z"),
          readModelVerifiedCardHash: snapshotCardFingerprint(pinnedCard),
        }),
      ],
      evaluationTime
    );

    expect(collapsed).toEqual([expect.objectContaining({ evidenceTier: "tier_3" })]);
  });

  it("falls back to tier_2 evidence when the verification window has lapsed", () => {
    const collapsed = collapseVisibleSnapshots(
      [
        row({
          agentId: "a1",
          readModelEvidenceTier: "tier_3",
          readModelVerificationExpiresAt: new Date("2026-10-08T11:59:59.000Z"),
          readModelVerifiedCardHash: snapshotCardFingerprint(pinnedCard),
        }),
      ],
      evaluationTime
    );

    expect(collapsed).toEqual([expect.objectContaining({ evidenceTier: "tier_2" })]);
  });

  it("falls back to tier_2 evidence when the pinned public card changed", () => {
    const collapsed = collapseVisibleSnapshots(
      [
        row({
          agentId: "a1",
          displayName: "Agent (renamed)",
          readModelEvidenceTier: "tier_3",
          readModelVerificationExpiresAt: new Date("2027-01-06T00:00:00.000Z"),
          readModelVerifiedCardHash: snapshotCardFingerprint(pinnedCard),
        }),
      ],
      evaluationTime
    );

    expect(collapsed).toEqual([expect.objectContaining({ evidenceTier: "tier_2" })]);
  });

  it("keeps a tier_4 publisher upgrade whose key has no configured expiry", () => {
    const collapsed = collapseVisibleSnapshots(
      [
        row({
          agentId: "a1",
          readModelPublisherState: "allowlisted",
          readModelEvidenceTier: "tier_4",
        }),
      ],
      evaluationTime
    );

    expect(collapsed).toEqual([
      expect.objectContaining({ publisherState: "allowlisted", evidenceTier: "tier_4" }),
    ]);
  });

  it("keeps a tier_4 publisher upgrade while the copied key expiry is still open", () => {
    const collapsed = collapseVisibleSnapshots(
      [
        row({
          agentId: "a1",
          readModelPublisherState: "allowlisted",
          readModelEvidenceTier: "tier_4",
          readModelPublisherExpiresAt: new Date("2026-10-08T12:00:01.000Z"),
        }),
      ],
      evaluationTime
    );

    expect(collapsed).toEqual([
      expect.objectContaining({ publisherState: "allowlisted", evidenceTier: "tier_4" }),
    ]);
  });

  it("fails closed on the list path when the copied key expiry has elapsed", () => {
    const collapsed = collapseVisibleSnapshots(
      [
        row({
          agentId: "a1",
          readModelPublisherState: "allowlisted",
          readModelEvidenceTier: "tier_4",
          readModelPublisherExpiresAt: new Date("2026-10-08T11:59:59.000Z"),
        }),
      ],
      evaluationTime
    );

    expect(collapsed).toEqual([
      expect.objectContaining({ publisherState: "expired", evidenceTier: "tier_2" }),
    ]);
  });

  it("returns an empty set when a reviewed run retains nothing", () => {
    expect(collapseVisibleSnapshots([])).toEqual([]);
  });

  it("sanitizes source-served fields and drops version-like capabilities", () => {
    const collapsed = collapseVisibleSnapshots([
      row({
        agentId: "a1",
        displayName: "Agent\u202EName",
        primaryCapability: "0.3.0",
        summary: "Self\u200Bdescription\nwith  spaces",
      }),
    ]);
    expect(collapsed[0]).toEqual(
      expect.objectContaining({
        displayName: "AgentName",
        primaryCapability: null,
        untrustedSummary: "Selfdescription with spaces",
      })
    );
  });

  it("serves clean text unchanged and keeps real capabilities", () => {
    const collapsed = collapseVisibleSnapshots([
      row({ agentId: "a1", primaryCapability: "verification", summary: "A clean description." }),
    ]);
    expect(collapsed[0]).toEqual(
      expect.objectContaining({ primaryCapability: "verification", untrustedSummary: "A clean description." })
    );
  });
});

describe("record withdrawal resolution", () => {
  const event = (agentId: string, action: "withdraw" | "reinstate") => ({ agentId, action });

  it("withholds a record after a withdraw event", () => {
    expect(resolveWithdrawnAgentIds([event("a1", "withdraw")])).toEqual(["a1"]);
  });

  it("restores a record after a reinstate event", () => {
    expect(resolveWithdrawnAgentIds([event("a1", "withdraw"), event("a1", "reinstate")])).toEqual([]);
  });

  it("honors the newest event in ledger order (withdraw, reinstate, withdraw)", () => {
    expect(
      resolveWithdrawnAgentIds([event("a1", "withdraw"), event("a1", "reinstate"), event("a1", "withdraw")])
    ).toEqual(["a1"]);
  });

  it("resolves agents independently and returns sorted ids", () => {
    expect(
      resolveWithdrawnAgentIds([
        event("b2", "withdraw"),
        event("a1", "withdraw"),
        event("b2", "reinstate"),
        event("c3", "withdraw"),
      ])
    ).toEqual(["a1", "c3"]);
  });

  it("returns no withdrawn ids for an empty ledger", () => {
    expect(resolveWithdrawnAgentIds([])).toEqual([]);
  });
});
