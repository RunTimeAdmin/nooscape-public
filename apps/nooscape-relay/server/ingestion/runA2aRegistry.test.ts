import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Runner wiring for the A2A registries: a host that already holds a reviewed record from another source is left out before the records
 * are picked, every record taken is stored under the registry's own parser version (and not the Agenstry feed's), and the run is
 * closed once with the counts the adapter gave, or as failed with the error. The database and the adapter are replaced.
 */
const mocks = vi.hoisted(() => ({
  beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
  finishIngestionRun: vi.fn(async (_input: unknown) => {}),
  persistCatalogObservation: vi.fn(async (_input: unknown) => {}),
  listReviewedAddressesOfOtherSources: vi.fn(async (_sourceId: string) => [] as string[]),
  fetchA2aRegistryCatalog: vi.fn(async (_source: unknown, _options: unknown) => ({}) as unknown),
}));

vi.mock("../db", () => ({
  beginIngestionRun: mocks.beginIngestionRun,
  finishIngestionRun: mocks.finishIngestionRun,
  persistCatalogObservation: mocks.persistCatalogObservation,
  listReviewedAddressesOfOtherSources: mocks.listReviewedAddressesOfOtherSources,
}));
vi.mock("./a2aRegistryCatalog", async importOriginal => ({
  ...(await importOriginal<typeof import("./a2aRegistryCatalog")>()),
  fetchA2aRegistryCatalog: mocks.fetchA2aRegistryCatalog,
}));

import { A2A_REGISTRY_PARSER_VERSION } from "./a2aRegistryCatalog";
import { runApprovedA2aRegistrySource } from "./runA2aRegistry";

const source = { id: "source-1", sourceKey: "a2aregistry-public-api", state: "active", cursor: null } as unknown as IngestionSource;
const observation = (id: string) => ({ candidate: { externalRecordId: id }, observation: { contentHash: `hash-${id}` } });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("running an A2A registry", () => {
  it("passes the parties other sources' reviewed records hold to the adapter, stores each record taken under the registry's parser version, and closes the run with the adapter's counts", async () => {
    mocks.listReviewedAddressesOfOtherSources.mockResolvedValueOnce(["https://www.held.example/page", "https://a.two.example.org/", "not a url"]);
    mocks.fetchA2aRegistryCatalog.mockResolvedValueOnce({
      observations: [observation("a"), observation("b")],
      discoveredCount: 10,
      qualifiedCount: 4,
      rejectedCount: 8,
      requestCount: 2,
    });

    const result = await runApprovedA2aRegistrySource(source, "manual");

    expect(mocks.listReviewedAddressesOfOtherSources).toHaveBeenCalledWith("source-1");
    const [, options] = mocks.fetchA2aRegistryCatalog.mock.calls[0] as [unknown, { skipUnits: Set<string> }];
    expect(Array.from(options.skipUnits).sort()).toEqual(["example.org", "held.example"]);
    expect(mocks.persistCatalogObservation).toHaveBeenCalledTimes(2);
    expect(mocks.persistCatalogObservation).toHaveBeenNthCalledWith(1, expect.objectContaining({ source, runId: "run-1", parserVersion: A2A_REGISTRY_PARSER_VERSION }));
    expect(A2A_REGISTRY_PARSER_VERSION).not.toContain("agenstry");
    expect(result).toEqual({ requestCount: 2, discoveredCount: 10, acceptedCount: 2, rejectedCount: 8, nextCursor: null });
    expect(mocks.finishIngestionRun).toHaveBeenCalledTimes(1);
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", status: "completed", counts: result }));
  });

  it("says in the log how many parties qualified, since the run page counts everything not taken as rejected", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.fetchA2aRegistryCatalog.mockResolvedValueOnce({
      observations: [observation("a")],
      discoveredCount: 649,
      qualifiedCount: 285,
      rejectedCount: 648,
      requestCount: 7,
    });

    await runApprovedA2aRegistrySource(source, "manual");

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      event: "nooscape_a2a_registry_run",
      sourceKey: "a2aregistry-public-api",
      discovered: 649,
      qualified: 285,
      accepted: 1,
      rejected: 648,
    });
  });

  it("closes the run as failed with the error, stores nothing and rethrows when the read fails", async () => {
    const failure = new Error("registry list ended early");
    mocks.fetchA2aRegistryCatalog.mockRejectedValueOnce(failure);

    await expect(runApprovedA2aRegistrySource(source, "scheduled")).rejects.toBe(failure);

    expect(mocks.persistCatalogObservation).not.toHaveBeenCalled();
    expect(mocks.finishIngestionRun).toHaveBeenCalledTimes(1);
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", status: "failed", error: failure }));
    expect(mocks.beginIngestionRun).toHaveBeenCalledWith(source, "scheduled");
  });
});
