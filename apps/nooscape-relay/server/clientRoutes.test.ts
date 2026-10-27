import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXACT_CLIENT_ROUTES, FLAGGED_CLIENT_ROUTES, isClientRoutePath } from "./clientRoutes";

/**
 * The static fallback's status honesty rides on this matcher mirroring the
 * wouter switch in client/src/App.tsx exactly: a listed real route must keep
 * its 200 deep link, and anything wouter's catch-all NotFound would render
 * must answer 404. Matching is exact and case-sensitive with no trailing
 * slash normalization — a mismatch either way mislabels real pages.
 */
describe("isClientRoutePath", () => {
  it("accepts every static route and the single-segment agent detail route", () => {
    expect(isClientRoutePath("/")).toBe(true);
    for (const route of ["/field", "/catch", "/developers", "/verify", "/sources", "/context", "/about", "/changes", "/checker", "/disputes", "/privacy", "/terms", "/contact", "/admin/sources", "/404"]) {
      expect(isClientRoutePath(route)).toBe(true);
    }
    expect(isClientRoutePath("/agents/3d1f49bd-2d41-47d8-bf12-65d299fde22d")).toBe(true);
    expect(isClientRoutePath("/catch/2026-10-15")).toBe(true);
  });

  it("serves the three chain pages and refuses any other chain address", () => {
    for (const chain of ["robinhood", "solana", "bnb"]) expect(isClientRoutePath(`/chains/${chain}`)).toBe(true);
    for (const path of ["/chains", "/chains/", "/chains/ethereum", "/chains/BNB", "/chains/bnb/", "/chains/bnb/a"]) expect(isClientRoutePath(path), path).toBe(false);
  });

  it("serves Arc's page only while its switch is on", () => {
    expect(isClientRoutePath("/chains/arc", undefined)).toBe(false);
    expect(isClientRoutePath("/chains/arc", "chain_base,chain_ethereum")).toBe(false);
    expect(isClientRoutePath("/chains/arc", "chain_arc")).toBe(true);
    // Arc's census report goes with it.
    expect(isClientRoutePath("/field/arc-registry-2026-10-20", undefined)).toBe(false);
    expect(isClientRoutePath("/field/arc-registry-2026-10-20", "chain_arc")).toBe(true);
    expect(isClientRoutePath("/field/arc-registry-2026-10-20/", "chain_arc")).toBe(false);
    expect(isClientRoutePath("/chains/arc/", "chain_arc")).toBe(false);
    expect(isClientRoutePath("/chains/Arc", "chain_arc")).toBe(false);
  });

  it("serves Ethereum's page only while its own switch is on, and it has no census report to serve", () => {
    expect(isClientRoutePath("/chains/ethereum", undefined)).toBe(false);
    expect(isClientRoutePath("/chains/ethereum", "chain_arc,chain_base")).toBe(false);
    expect(isClientRoutePath("/chains/ethereum", "chain_ethereum")).toBe(true);
    expect(isClientRoutePath("/chains/ethereum", "chain_base,chain_ethereum,chain_arc")).toBe(true);
    expect(isClientRoutePath("/chains/ethereum/", "chain_ethereum")).toBe(false);
    expect(isClientRoutePath("/chains/Ethereum", "chain_ethereum")).toBe(false);
    // Its switch opens no other chain's page, and no other chain's switch opens its.
    expect(isClientRoutePath("/chains/arc", "chain_ethereum")).toBe(false);
    expect(isClientRoutePath("/chains/base", "chain_ethereum")).toBe(false);
    expect(isClientRoutePath("/field/ethereum-registry-2026-10-27", "chain_ethereum")).toBe(false);
  });

  it("serves Base's page and its census report only while its switch is on", () => {
    expect(isClientRoutePath("/chains/base", undefined)).toBe(false);
    expect(isClientRoutePath("/chains/base", "chain_arc,chain_ethereum")).toBe(false);
    expect(isClientRoutePath("/chains/base", "chain_base")).toBe(true);
    expect(isClientRoutePath("/chains/base/", "chain_base")).toBe(false);
    expect(isClientRoutePath("/chains/Base", "chain_base")).toBe(false);
    expect(isClientRoutePath("/field/base-registry-2026-10-21", undefined)).toBe(false);
    expect(isClientRoutePath("/field/base-registry-2026-10-21", "chain_arc,chain_ethereum")).toBe(false);
    expect(isClientRoutePath("/field/base-registry-2026-10-21", "chain_base")).toBe(true);
    expect(isClientRoutePath("/field/base-registry-2026-10-21/", "chain_base")).toBe(false);
  });

  it("mirrors the routes declared in client/src/App.tsx, no more and no fewer", () => {
    const app = readFileSync(path.resolve(import.meta.dirname, "../client/src/App.tsx"), "utf8");
    // A route behind a feature switch is written `{featureOn("name", FEATURES) && <Route path="/x" ... />}`.
    const flagged = [...app.matchAll(/featureOn\("(\w+)",[^)]*\)\s*&&\s*<Route\s+path="([^"]+)"/g)].map(match => [match[1]!, match[2]!] as const);
    const declared: string[] = [];
    const pattern = /<Route\s+path="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(app)) !== null) declared.push(match[1]!);
    const always = declared.filter(route => !flagged.some(([, flaggedRoute]) => flaggedRoute === route));
    expect(always.length).toBeGreaterThan(5);
    expect(EXACT_CLIENT_ROUTES.slice().sort()).toEqual(always.filter(route => route.indexOf(":") === -1).sort());
    for (const route of always.filter(route => route.indexOf(":") !== -1)) {
      expect(isClientRoutePath(route.replace(/:[^/]+/g, "some-id")), route).toBe(true);
    }
    // And the flagged ones are exactly the server's flagged table.
    const byFeature: Record<string, string[]> = {};
    for (const [feature, route] of flagged) (byFeature[feature] ??= []).push(route);
    expect(byFeature).toEqual(FLAGGED_CLIENT_ROUTES);
  });

  it("answers 404 for a route behind a switch until its feature is on, and 200 once it is", () => {
    for (const [feature, routes] of Object.entries(FLAGGED_CLIENT_ROUTES)) {
      for (const route of routes!) {
        expect(isClientRoutePath(route, undefined), `${route} with nothing on`).toBe(false);
        expect(isClientRoutePath(route, ""), `${route} with an empty list`).toBe(false);
        expect(isClientRoutePath(route, feature), `${route} with ${feature} on`).toBe(true);
        expect(isClientRoutePath(route, ` Other , ${feature.toUpperCase()} `), `${route} with the name in capitals among others`).toBe(true);
        expect(isClientRoutePath(route, "nothing-like-it"), `${route} with an unknown name`).toBe(false);
      }
    }
    // One feature does not open the other's route.
    expect(isClientRoutePath("/patrols", "watch")).toBe(false);
    expect(isClientRoutePath("/watch", "patrols")).toBe(false);
    // Matching stays exact: no trailing slash, no other case.
    expect(isClientRoutePath("/watch/", "watch")).toBe(false);
    expect(isClientRoutePath("/Watch", "watch")).toBe(false);
  });

  it("refuses everything wouter's catch-all NotFound would render", () => {
    expect(isClientRoutePath("/agents/")).toBe(false);
    expect(isClientRoutePath("/agents/a/b")).toBe(false);
    expect(isClientRoutePath("/AGENTS/some-id")).toBe(false);
    expect(isClientRoutePath("/catch/")).toBe(false);
    expect(isClientRoutePath("/catch/2026-10-15/")).toBe(false);
    expect(isClientRoutePath("/catch/a/b")).toBe(false);
    expect(isClientRoutePath("/Catch")).toBe(false);
    expect(isClientRoutePath("/about/")).toBe(false);
    expect(isClientRoutePath("/checker/")).toBe(false);
    expect(isClientRoutePath("/Checker")).toBe(false);
    expect(isClientRoutePath("/totally-bogus-path")).toBe(false);
    expect(isClientRoutePath("/api/trpc/liveData.directorySearch")).toBe(false);
    expect(isClientRoutePath("")).toBe(false);
  });
});
