import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  // A test that renders a page (client/src/pages/bnbRegistryReport.test.ts) needs JSX compiled the way the app's build does.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    // The database-backed suites build a throwaway MySQL schema in beforeAll by
    // replaying the baseline and applying the whole migration chain, which takes
    // 7 to 9 seconds alone and more when several suites run in parallel. The 10
    // second default made them flake under a full run.
    hookTimeout: 60_000,
    // A test that imports server/db.ts (or the routers on top of it) inside its own body, to get a fresh module and an empty
    // read cache, pays for evaluating a very large module graph there: several seconds on a loaded machine. The 5 second
    // default timed out the first of them, and its late finish then fed the next test's fake database. These tests assert
    // on what the code returns, never on how long it took, so the timeout only has to be longer than a slow machine.
    testTimeout: 30_000,
    // The client suite is node-safe pure logic (topology) — it runs in the
    // same pass so a client-side regression cannot hide behind the default
    // server-only include. The shared suite is the same kind of pure logic, used by both sides; it was left out of
    // the include, so shared/arrivals.test.ts never ran in `pnpm test` or in CI.
    include: ["server/**/*.test.ts", "server/**/*.spec.ts", "client/src/**/*.test.ts", "shared/**/*.test.ts"],
  },
});
