import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CENSUS_CHAINS } from "@shared/censusToday";
import { EXTRA_CHAIN_SPECS, EXTRA_CHAINS, extraProtocolOf } from "@shared/chains";
import { FEATURES } from "@shared/features";
import { API_CHAINS } from "./apiChains";
import { NAME_CHAINS } from "./chainNamesCore";
import { CLAIM_CHAINS } from "./claimsChain";
import { PINNED_CLAIM_CHAIN_IDS } from "./claimsPinned";
import { FLAGGED_CLIENT_ROUTES } from "./clientRoutes";
import { ERC8004_CHAINS, erc8004ChainOfKey, validateErc8004Chains } from "./ingestion/erc8004Chains";
import { INGESTION_PROTOCOLS } from "./ingestion/types";
import { flaggedSitemapUrls } from "./sitemap";
import { FRESHNESS_HOURS } from "../client/src/lib/statusModel";
import { worldsOn } from "../client/src/lib/chainExplorerModel";
import { EXTRA_CHAIN_LIGHTS } from "@shared/mapFleets";

/**
 * A chain is described in two tables: shared/chains.ts (`EXTRA_CHAIN_SPECS`: its key, name, protocol and switches, which the client reads
 * too) and server/ingestion/erc8004Chains.ts (`ERC8004_CHAINS`: its node, registry, budgets and rules). Most lists are built from them.
 * These tests hold the two tables to each other, and every list that is still written out by hand (because its order is behaviour, or
 * its entries are a chain's own pages) to both, so a chain added to one place and forgotten in another fails here and not on the site.
 */
const APP = fileURLToPath(new URL("..", import.meta.url));
const extraEntries = ERC8004_CHAINS.filter(chain => chain.feature !== null);

describe("the two chain tables", () => {
  it("are sound on their own", () => {
    expect(validateErc8004Chains(ERC8004_CHAINS)).toEqual([]);
  });

  it("describe the same extra chains, in the same order, with the same protocol, name and switch", () => {
    expect(extraEntries.map(chain => chain.chainKey).sort()).toEqual([...EXTRA_CHAINS].sort());
    for (const spec of EXTRA_CHAIN_SPECS) {
      const entry = erc8004ChainOfKey(spec.key);
      expect(entry, spec.key).not.toBeNull();
      expect(entry!.protocol, spec.key).toBe(spec.protocol);
      expect(entry!.chainLabel, spec.key).toBe(spec.label);
      expect(entry!.feature, spec.key).toBe(spec.feature);
      expect(extraProtocolOf(spec.key), spec.key).toBe(spec.protocol);
    }
  });

  it("leave BNB Smart Chain the one chain-pass chain that needs no switch", () => {
    expect(ERC8004_CHAINS.filter(chain => chain.feature === null).map(chain => chain.chainKey)).toEqual(["bnb"]);
  });

  it("name only protocol values and switches that exist", () => {
    for (const chain of ERC8004_CHAINS) expect(INGESTION_PROTOCOLS as readonly string[], chain.protocol).toContain(chain.protocol);
    for (const spec of EXTRA_CHAIN_SPECS) {
      expect(FEATURES as readonly string[], spec.key).toContain(spec.feature);
      expect(FEATURES as readonly string[], spec.key).toContain(spec.claimsFeature);
      expect(spec.claimsFeature, spec.key).toBe(`claims_${spec.key}`);
    }
  });

  it("point a migration run by hand at a migration file and a record that exist", () => {
    const migrations = readdirSync(`${APP}drizzle`);
    for (const chain of ERC8004_CHAINS) {
      if (!chain.protocolMigration) continue;
      expect(migrations.some(file => file.startsWith(`${chain.protocolMigration!.version}_`)), chain.chainKey).toBe(true);
      expect(existsSync(`${APP}${chain.protocolMigration.record}`), chain.protocolMigration.record).toBe(true);
    }
  });
});

describe("the lists built from them", () => {
  it("give every chain-pass chain a claims entry, and every extra chain but Arc a pinned claims node", () => {
    for (const chain of ERC8004_CHAINS) expect(CLAIM_CHAINS[chain.protocol], chain.protocol).toMatchObject({ chainId: chain.chainId, registry: chain.identityRegistry, label: chain.label });
    const pinned = extraEntries.filter(chain => chain.provider.kind === "pinned").map(chain => chain.chainId);
    expect([...PINNED_CLAIM_CHAIN_IDS].sort()).toEqual(pinned.sort());
  });

  it("give every extra chain its place in the API", () => {
    for (const chain of extraEntries) expect(API_CHAINS[chain.chainKey as (typeof EXTRA_CHAINS)[number]], chain.chainKey).toMatchObject({ protocols: [chain.protocol], chainId: chain.chainId });
  });
});

describe("the lists still written out by hand", () => {
  it("name every extra chain in the name step (its order is the order the step runs them in)", () => {
    expect(NAME_CHAINS.map(chain => chain.chainKey).sort()).toEqual([...EXTRA_CHAINS].sort());
  });

  it("give every chain-pass chain a freshness limit on the status page", () => {
    for (const chain of ERC8004_CHAINS) expect(FRESHNESS_HOURS[chain.protocol], chain.protocol).toBeGreaterThan(0);
  });

  it("give every extra chain its lights on the home map, in the order its world is numbered, each with an outline of its own", () => {
    const allOn = EXTRA_CHAIN_SPECS.map(spec => spec.feature).join(",");
    expect(EXTRA_CHAIN_LIGHTS.map(lights => lights.chain)).toEqual(worldsOn(allOn).filter(world => (EXTRA_CHAINS as readonly string[]).includes(world)));
    expect(new Set(EXTRA_CHAIN_LIGHTS.map(lights => lights.shape)).size).toBe(EXTRA_CHAIN_LIGHTS.length);
  });

  it("give every extra chain a Today block", () => {
    for (const key of EXTRA_CHAINS) expect(CENSUS_CHAINS as readonly string[], key).toContain(key);
  });

  it("give every extra chain's switch its page among the routes and in the sitemap", () => {
    for (const spec of EXTRA_CHAIN_SPECS) {
      expect(FLAGGED_CLIENT_ROUTES[spec.feature], spec.key).toContain(`/chains/${spec.key}`);
      expect(flaggedSitemapUrls(spec.feature).some(url => url.endsWith(`/chains/${spec.key}`)), spec.key).toBe(true);
    }
  });
});
