import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { exportsDirFromEnv } from "./apiExports";
import { writeAgentsExport } from "./exportAgents";
import { agentsExportFiles, expiredExportFiles, utcDay } from "./exportRetention";

/**
 * The daily run of the agents export (stage 3 of D6), bundled into the image as dist/exportAgentsDaily.js and run once a day by
 * deploy/vps/export.sh. It writes today's export (the UTC day) to NOOSCAPE_EXPORT_DIR, then removes the days older than 30 and any
 * part file a stopped run left. An export with no rows is not published: the directory always lists agents, so none means a read went
 * wrong, and the newest good day stays the latest. It prints one JSON line and exits 0, or 1 when nothing was published.
 */
async function main() {
  try {
    const dir = exportsDirFromEnv();
    if (!dir) throw new Error("NOOSCAPE_EXPORT_DIR is not set.");
    const date = utcDay(new Date());
    const manifest = await writeAgentsExport({ dir, date });
    if (manifest.payload.rows === 0) {
      const names = agentsExportFiles(date);
      await rm(join(dir, names.manifest), { force: true });
      await rm(join(dir, names.data), { force: true });
      throw new Error("The export read no rows, so it was not published.");
    }
    const removed = expiredExportFiles(await readdir(dir), date);
    for (const name of removed) await rm(join(dir, name), { force: true });
    console.log(
      JSON.stringify({
        event: "nooscape_agents_export",
        date,
        rows: manifest.payload.rows,
        rows_by_chain: manifest.payload.rows_by_chain,
        bytes: manifest.payload.file.bytes,
        removed,
      })
    );
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ event: "nooscape_agents_export_failed", message: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
}

void main();
