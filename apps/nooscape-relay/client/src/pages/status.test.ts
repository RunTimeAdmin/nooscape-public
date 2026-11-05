import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INCIDENTS } from "../lib/incidents";

/**
 * The status page makes claims the code and the records can break: where it reads from, how often the outside check runs, what it says
 * it cannot show, and the incidents it lists. Each is held to the file that decides it, so a change there fails this test and names the page
 * to change. Guarded at the source because the repo has no browser test runner.
 */
const client = fileURLToPath(new URL("..", import.meta.url));
const app = join(client, "..", "..");
const read = (path: string) => readFileSync(path, "utf8");
const page = read(join(client, "pages", "Status.tsx"));
const copy = page.replace(/\/\*[\s\S]*?\*\//g, " ");
/** The records the incidents rest on, newest first. A test that reads a document names it, and the CI scope list holds it (scripts/ci-scope.mjs). */
const RECORDS = ["incident-2026-11-01-outage.md", "incident-2026-10-14-outage.md"] as const;

describe("the status page", () => {
  it("is routed, listed for the server, given a head, listed in the sitemap and linked from the home page's footer", () => {
    expect(read(join(client, "App.tsx"))).toContain('<Route path="/status" component={Status} />');
    expect(read(join(app, "server", "clientRoutes.ts"))).toContain('"/status"');
    expect(read(join(app, "server", "routeHead.ts"))).toContain('"/status"');
    expect(read(join(app, "client", "public", "sitemap.xml"))).toContain("<loc>https://nooscape.si/status</loc>");
    expect(read(join(client, "pages", "Home.tsx"))).toContain('href="/status"');
  });

  it("reads the source statuses and the API index and nothing else", () => {
    expect(copy.match(/trpc\./g)).toHaveLength(1);
    expect(copy).toContain("trpc.liveData.sourceStatuses.useQuery");
    expect(copy.match(/\bfetch\(/g)).toHaveLength(1);
    expect(copy).toContain('fetch("/api/v1"');
  });

  it("says every six hours, as the workflow's schedule does, and links the history of that workflow in the public repository", () => {
    const workflow = read(join(app, "..", "..", ".github", "workflows", "health.yml"));
    expect(workflow).toContain('cron: "17 */6 * * *"');
    expect(workflow).toContain("name: Live health");
    expect(copy).toContain("Every six hours a workflow on GitHub");
    expect(copy).toContain("https://github.com/RunTimeAdmin/nooscape-public/actions/workflows/health.yml");
    expect(workflow).toContain("issues: write");
    expect(copy).toContain("A failed");
    expect(copy).toContain("check opens an issue");
  });

  it("derives the limits it names from the table the live check shares, and does not type them", () => {
    expect(copy).toContain("Object.values(FRESHNESS_HOURS)");
    expect(copy).not.toMatch(/\b(3|12|36) hours\b/);
  });

  it("says what it cannot show and that it has no uptime figure, and prints no percentage", () => {
    expect(copy).toContain("It is served by the app it describes");
    expect(copy).toContain("An uptime percentage");
    expect(copy).toContain("Nothing outside the host measures the site every minute yet");
    expect(copy).not.toMatch(/\d\s*%/);
  });

  it("uses no long dash, no reply-time promise and no score", () => {
    expect(page).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
    expect(copy).not.toMatch(/24[\s-]?hours?/i);
    expect(copy).not.toMatch(/\bscores?\b/i);
  });
});

describe("the incidents", () => {
  it("are listed newest first, each on a day in UTC, with its words filled in", () => {
    const dates = INCIDENTS.map(incident => incident.date);
    expect(dates.length).toBeGreaterThanOrEqual(2);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const incident of INCIDENTS) {
      expect(incident.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(incident.window.length).toBeGreaterThan(10);
      expect(incident.title.length).toBeGreaterThan(10);
      expect(incident.summary.length).toBeGreaterThan(80);
      expect(`${incident.window} ${incident.title} ${incident.summary}`).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
    }
  });

  it("each have a written record in docs, which the CI scope list knows a test reads, and the times they name are in that record", () => {
    expect(INCIDENTS.map(incident => incident.record)).toEqual([...RECORDS]);
    const scope = read(join(app, "scripts", "ci-scope.mjs"));
    for (const incident of INCIDENTS) {
      expect(scope, `${incident.record} belongs on READ_BY_TESTS in scripts/ci-scope.mjs`).toContain(`apps/nooscape-relay/docs/${incident.record}`);
      const path = join(app, "docs", incident.record);
      expect(existsSync(path), incident.record).toBe(true);
      const record = read(path);
      expect(record, incident.record).toContain(incident.date.slice(0, 4));
      for (const clock of `${incident.window} ${incident.summary}`.match(/\b\d{2}:\d{2}\b/g) ?? []) expect(record, `${incident.record} names ${clock}`).toContain(clock);
    }
  });
});
