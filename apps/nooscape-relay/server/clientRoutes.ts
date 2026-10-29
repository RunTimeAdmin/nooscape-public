/**
 * The client route table, mirrored exactly from client/src/App.tsx (wouter).
 * The static fallback uses it to answer honest status codes: a path the
 * wouter switch can route gets the SPA with 200; everything else is the
 * territory of wouter's catch-all NotFound and earns a real HTTP 404 with
 * the same shell, so the rendered page and the status code agree.
 *
 * Keep this in lockstep with App.tsx: a route added there but missed here
 * would deep-link as a 404, and a path listed here that wouter cannot route
 * would answer 200 with the NotFound page. Matching is exact and
 * case-sensitive like wouter's, with no trailing-slash normalization.
 *
 * A route behind a feature switch (shared/features.ts) is not in the exact
 * list: it answers 404 like any address the app cannot route until its
 * feature is on, which VITE_FEATURES says here as it does in the client's build.
 */

import { featureOn, type Feature } from "@shared/features";

export const EXACT_CLIENT_ROUTES = [
  "/",
  "/field",
  "/chains/robinhood",
  "/chains/solana",
  "/chains/bnb",
  "/field/bnb-registry-2026-10-16",
  "/field/bnb-ratings-2026-10-16",
  "/field/solana-registries-2026-10-18",
  "/field/robinhood-registry-2026-10-20",
  "/catch",
  "/developers",
  "/developers/keys",
  "/verify",
  "/sources",
  "/context",
  "/about",
  "/changes",
  "/checker",
  "/disputes",
  "/privacy",
  "/terms",
  "/contact",
  "/admin/sources",
  "/404",
];

/**
 * The routes behind a switch, by the feature that turns each on. A feature that is a section of a page and not a route (`claims`) has none,
 * Arc's page and its census report are behind `chain_arc`, Base's page and its census report are behind `chain_base`, and Ethereum's page (it has no census report) is behind `chain_ethereum`.
 */
export const FLAGGED_CLIENT_ROUTES: Partial<Record<Feature, readonly string[]>> = {
  watch: ["/watch"],
  patrols: ["/patrols"],
  chain_arc: ["/chains/arc", "/field/arc-registry-2026-10-20"],
  chain_base: ["/chains/base", "/field/base-registry-2026-10-21"],
  chain_ethereum: ["/chains/ethereum", "/field/ethereum-registry-2026-10-28"],
};

export function isClientRoutePath(pathname: string, features: string | undefined = process.env.VITE_FEATURES): boolean {
  if (EXACT_CLIENT_ROUTES.indexOf(pathname) !== -1) return true;
  for (const feature of Object.keys(FLAGGED_CLIENT_ROUTES) as Feature[]) {
    if (FLAGGED_CLIENT_ROUTES[feature]?.includes(pathname) && featureOn(feature, features)) return true;
  }
  // /agents/:id and /catch/:date: a single non-empty segment, wouter's param matcher.
  return /^\/(?:agents|catch)\/[^/]+$/.test(pathname);
}
