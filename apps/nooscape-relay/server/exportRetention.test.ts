import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPORT_KEEP_DAYS, expiredExportFiles, oldestKeptDay, utcDay } from "./exportRetention";

/** The daily export is kept 30 days: the day written and the 29 before it. */
describe("the export's retention", () => {
  it("keeps today and the 29 days before it, across a month and a year end", () => {
    expect(EXPORT_KEEP_DAYS).toBe(30);
    expect(oldestKeptDay("2026-11-30")).toBe("2026-11-01");
    expect(oldestKeptDay("2026-12-15")).toBe("2026-11-16");
    expect(oldestKeptDay("2027-01-10")).toBe("2026-12-12");
    // 2028 is a leap year: February has 29 days.
    expect(oldestKeptDay("2028-03-01")).toBe("2028-02-01");
    expect(oldestKeptDay("2027-03-01")).toBe("2027-01-31");
  });

  it("names the UTC day of a moment", () => {
    expect(utcDay(new Date("2026-11-22T23:59:59Z"))).toBe("2026-11-22");
    expect(utcDay(new Date("2026-11-22T18:30:00-06:00"))).toBe("2026-11-23");
  });

  it("removes the days older than that, manifest first, and a part file of any day but today, and nothing else", () => {
    const names = [
      "agents-2026-10-31.jsonl.gz",
      "agents-2026-10-31.manifest.json",
      "agents-2026-10-30.manifest.json",
      "agents-2026-10-30.jsonl.gz",
      "agents-2026-11-01.jsonl.gz",
      "agents-2026-11-01.manifest.json",
      "agents-2026-11-15.jsonl.gz.part",
      "agents-2026-11-30.jsonl.gz.part",
      "agents-2026-11-30.jsonl.gz",
      "README.txt",
      "agents-2026-10-01.csv",
      "other-2026-10-01.jsonl.gz",
    ];
    expect(expiredExportFiles(names, "2026-11-30")).toEqual([
      "agents-2026-10-30.manifest.json",
      "agents-2026-10-30.jsonl.gz",
      "agents-2026-10-31.manifest.json",
      "agents-2026-10-31.jsonl.gz",
      "agents-2026-11-15.jsonl.gz.part",
    ]);
  });

  it("removes nothing from a folder of kept days", () => {
    expect(expiredExportFiles(["agents-2026-11-29.jsonl.gz", "agents-2026-11-29.manifest.json"], "2026-11-30")).toEqual([]);
    expect(expiredExportFiles([], "2026-11-30")).toEqual([]);
  });
});

const kit = join(fileURLToPath(new URL("..", import.meta.url)), "deploy", "vps");

// Read only where the tree has the deploy kit.
describe.skipIf(!existsSync(kit))("the wiring from the image to the schedule", () => {
  const read = (name: string) => readFileSync(join(kit, name), "utf8");

  it("bundles the job into the image, with a folder the app's user owns, on a volume the app is told about", () => {
    expect(read("Dockerfile")).toMatch(/^RUN pnpm exec esbuild server\/exportAgentsDaily\.ts .*--outdir=dist$/m);
    expect(read("Dockerfile")).toContain("RUN mkdir -p /app/exports && chown node:node /app/exports");
    // The folder is made before the image drops to the app's user, so a new volume mounted there takes that owner.
    expect(read("Dockerfile").indexOf("chown node:node /app/exports")).toBeLessThan(read("Dockerfile").indexOf("USER node"));
    const compose = read("compose.yaml");
    expect(compose).toContain("      NOOSCAPE_EXPORT_DIR: /app/exports\n    volumes:\n      - exports:/app/exports\n");
    expect(compose).toMatch(/^volumes:\n( {2}[a-z-]+:\n)* {2}exports:\n/m);
  });

  it("runs the job in the app container once a day through run.sh, and is installed by host-setup.sh", () => {
    expect(read("export.sh")).toContain("docker compose exec -T app node dist/exportAgentsDaily.js");
    const schedule = read("export.cron")
      .split("\n")
      .filter(line => line.trim() !== "" && !line.startsWith("#") && !/^[A-Z]+=/.test(line));
    expect(schedule).toEqual(["43 2 * * * root bash $KIT/run.sh export bash $KIT/export.sh"]);
    expect(read("host-setup.sh")).toContain('install -m 0644 "$here/export.cron" /etc/cron.d/nooscape-export');
  });
});
