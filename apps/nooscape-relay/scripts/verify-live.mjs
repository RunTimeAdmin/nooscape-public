#!/usr/bin/env node
/**
 * Read-only health check of the live Atlas. Public endpoints only: no
 * credential is read or sent, and the one POST (to an operator procedure)
 * carries no token and is expected to be refused before it does anything.
 *
 * Exits 1 when any `fail` check fails. `warn` checks are reported but never
 * fail the run (for example a manual-only source with a recorded failure, which
 * is an operator decision and not an outage). Used by the scheduled
 * `.github/workflows/health.yml` and runnable by hand:
 *
 *   node scripts/verify-live.mjs [https://nooscape.si]
 *
 * Probe paths use the full dotted procedure names. A bare name such as
 * `publicRecords` is not a route and 404s deterministically, which would
 * imitate a broken deploy (see docs/AI_HANDOFF_2026-10-12.md).
 */
import { appendFileSync } from "node:fs";
import { createLiveGet, statusDetail, why } from "./liveGet.mjs";

const BASE = (process.argv[2] ?? process.env.NOOSCAPE_URL ?? "https://nooscape.si").replace(/\/$/, "");
const HOUR = 3_600_000;

/** How stale a scheduled source's last success may be before it counts as stuck. */
const FRESHNESS_HOURS = {
  erc8004: 3,
  solana_registry: 3,
  solana_8004: 3,
  solana_said: 3,
  erc8004_bsc: 3,
  erc8004_base: 3,
  // Daily metadata sources: allow a full day plus slack for a slow worker.
  catalog: 36,
  census: 36,
  a2a: 36,
  // The Arc identity pass runs once a day (migration 0050), so it gets the same allowance.
  erc8004_arc: 36,
};

const results = [];
function check(name, ok, detail, severity = "fail") {
  results.push({ name, ok: Boolean(ok), detail, severity });
}

// A request the site's CDN turns away from this runner is asked again (scripts/liveGet.mjs); the site was up each time that happened.
const { get } = createLiveGet({ base: BASE });

async function trpc(procedure) {
  const response = await get(`/api/trpc/${procedure}`);
  if (!response.ok) throw new Error(`${procedure} answered ${statusDetail(response)}`);
  const body = await response.json();
  return body.result.data.json;
}

async function run() {
  // 1. The shell page: served, small, and free of the dev bridge.
  try {
    const home = await get("/");
    const html = await home.text();
    check("home page serves", home.status === 200, statusDetail(home));
    check("home page is the small production shell", html.length < 100_000, `${html.length} bytes`);
    check("no dev runtime in production HTML", !html.includes("manus-runtime"), html.includes("manus-runtime") ? "manus-runtime present" : "absent");
    const h = (name) => home.headers.get(name) ?? "";
    check("HSTS with includeSubDomains", /includeSubDomains/i.test(h("strict-transport-security")), h("strict-transport-security") || "missing");
    check("CSP present", h("content-security-policy").includes("default-src"), h("content-security-policy") ? "present" : "missing");
    check("nosniff and frame protection", /nosniff/i.test(h("x-content-type-options")) && /deny/i.test(h("x-frame-options")), `${h("x-content-type-options")} / ${h("x-frame-options")}`);
  } catch (error) {
    check("home page serves", false, why(error));
  }

  // 2. Removed surfaces stay removed and unknown paths 404 honestly.
  for (const path of ["/admin", "/manus-storage/x", "/api/oauth/callback", "/__manus__/debug-collector.js"]) {
    try {
      const response = await get(path);
      check(`${path} answers 404`, response.status === 404, statusDetail(response));
    } catch (error) {
      check(`${path} answers 404`, false, why(error));
    }
  }

  // 2b. The security contact is published where RFC 9116 says to look.
  try {
    const response = await get("/.well-known/security.txt");
    const text = await response.text();
    check(
      "security.txt publishes the security contact",
      response.status === 200 && /^Contact: mailto:security@nooscape\.si$/m.test(text) && /^Expires: \d{4}-\d{2}-\d{2}T/m.test(text),
      statusDetail(response)
    );
  } catch (error) {
    check("security.txt publishes the security contact", false, why(error));
  }

  // 3. Operator procedures refuse an unauthenticated caller before doing anything.
  try {
    const response = await get("/api/trpc/liveData.admin.runSource", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
    });
    check("operator procedure refuses unauthenticated calls", response.status === 401, statusDetail(response));
  } catch (error) {
    check("operator procedure refuses unauthenticated calls", false, why(error));
  }

  // 4. Storage, the reviewed census, and the directory.
  try {
    const availability = await trpc("liveData.availability");
    check("persistent storage configured", availability.persistentStorageConfigured === true, JSON.stringify(availability.persistentStorageConfigured));
  } catch (error) {
    check("persistent storage configured", false, why(error));
  }
  try {
    const coverage = await trpc("liveData.publicCoverage");
    check("reviewed census is served", coverage.publicRecordCount >= 1, `${coverage.publicRecordCount} records`);
    check("every reviewed record has retained evidence", coverage.coveragePercent === 100, `${coverage.provenanceReadyCount}/${coverage.publicRecordCount} (${coverage.coveragePercent}%)`);
  } catch (error) {
    check("reviewed census is served", false, why(error));
  }
  try {
    const breakdown = await trpc("liveData.directoryBreakdown");
    check("directory is served", breakdown.total >= 1_000, `${breakdown.total} acknowledged entries`);
  } catch (error) {
    check("directory is served", false, why(error));
  }

  // 5. Source health. Scheduled sources must be active, failure-free, and fresh;
  //    manual-only sources are operator-paced, so their problems are warnings.
  try {
    const { sources } = await trpc("liveData.sourceStatuses");
    const now = Date.now();
    for (const source of sources) {
      const label = source.sourceKey;
      const scheduled = source.executionPolicy === "scheduled";
      const severity = scheduled ? "fail" : "warn";
      if (source.state !== "active") {
        check(`${label} is active`, false, `state ${source.state}`, "warn");
        continue;
      }
      check(`${label} has no recorded failures`, source.failureCount === 0, `${source.failureCount} failed run(s)`, severity);
      const limit = FRESHNESS_HOURS[source.protocol];
      if (scheduled && limit !== undefined) {
        const last = source.lastSuccessfulAt ? Date.parse(source.lastSuccessfulAt) : NaN;
        const ageHours = (now - last) / HOUR;
        check(`${label} ran recently`, Number.isFinite(ageHours) && ageHours <= limit, Number.isFinite(ageHours) ? `${ageHours.toFixed(1)}h ago (limit ${limit}h)` : "never succeeded");
      }
    }
  } catch (error) {
    check("source statuses are served", false, why(error));
  }

  // 6. Pay per call. A payment the facilitator never decided stays open for the operator to look at, with no refund and no timeout, so a
  //    count of the ones left for over an hour is read from the public index, and a failure here opens the health issue.
  try {
    const index = await (await get("/api/v1")).json();
    const stuck = index.payments_unresolved_over_hour;
    if (stuck === undefined) check("no payment is stuck", true, "pay per call is off");
    else if (stuck === null) check("no payment is stuck", false, "the count could not be read", "warn");
    else check("no payment is stuck", stuck === 0, stuck === 0 ? "none unresolved for over an hour" : `${stuck} payment(s) unresolved for over an hour: open Pay per call on /admin/sources`);
  } catch (error) {
    check("the API index is served", false, why(error), "warn");
  }
}

await run();

const failed = results.filter(r => !r.ok && r.severity === "fail");
const warned = results.filter(r => !r.ok && r.severity === "warn");
const lines = results.map(r => `${r.ok ? "PASS" : r.severity === "warn" ? "WARN" : "FAIL"}  ${r.name}: ${r.detail}`);
console.log(`Live check of ${BASE}\n${lines.join("\n")}\n\n${results.length - failed.length - warned.length} passed, ${warned.length} warning(s), ${failed.length} failed`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map(r => `| ${r.ok ? "pass" : r.severity === "warn" ? "warn" : "**FAIL**"} | ${r.name} | ${r.detail} |`).join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live check of ${BASE}\n\n| Result | Check | Detail |\n|---|---|---|\n${rows}\n`);
}

process.exit(failed.length > 0 ? 1 : 0);
