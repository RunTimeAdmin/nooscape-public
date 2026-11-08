import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Every catalog source runs through one dispatcher: the two A2A registries by their own source keys, and the Agenstry feed otherwise.
 * A source key that is nobody's goes to the Agenstry adapter, which refuses it, and is never read as a registry.
 */
const mocks = vi.hoisted(() => ({
  runApprovedAgenstrySource: vi.fn(async (_source: unknown, _trigger: string) => ({ via: "agenstry" })),
  runApprovedA2aRegistrySource: vi.fn(async (_source: unknown, _trigger: string) => ({ via: "registry" })),
}));
vi.mock("./runAgenstry", () => ({ runApprovedAgenstrySource: mocks.runApprovedAgenstrySource }));
vi.mock("./runA2aRegistry", () => ({ runApprovedA2aRegistrySource: mocks.runApprovedA2aRegistrySource }));

import { runApprovedCatalogSource } from "./runCatalog";

const withKey = (sourceKey: string) => ({ id: "s", sourceKey, protocol: "catalog" }) as unknown as IngestionSource;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("running a catalog source", () => {
  it.each(["a2aregistry-public-api", "a2a-registry-org-public-api"])("sends %s to the registry runner, with the trigger it was given", async key => {
    const source = withKey(key);
    expect(await runApprovedCatalogSource(source, "manual")).toEqual({ via: "registry" });
    expect(mocks.runApprovedA2aRegistrySource).toHaveBeenCalledWith(source, "manual");
    expect(mocks.runApprovedAgenstrySource).not.toHaveBeenCalled();
  });

  it.each(["agenstry-public-catalog", "somebody-else"])("sends %s to the Agenstry runner", async key => {
    const source = withKey(key);
    expect(await runApprovedCatalogSource(source, "scheduled")).toEqual({ via: "agenstry" });
    expect(mocks.runApprovedAgenstrySource).toHaveBeenCalledWith(source, "scheduled");
    expect(mocks.runApprovedA2aRegistrySource).not.toHaveBeenCalled();
  });
});
