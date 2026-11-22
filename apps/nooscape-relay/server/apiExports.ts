import { readdir } from "node:fs/promises";
import { agentsExportFiles } from "./exportRetention";

/**
 * Where the daily agents export is read from for download (stage 2 of D6; the writer is server/exportAgents.ts). A day is offered only
 * when both its manifest and its data file are there: the writer renames the data file into place and writes the manifest last, so a
 * day with a manifest is a day whose file is whole. The folder is NOOSCAPE_EXPORT_DIR; with none set, no day is offered.
 */

export const EXPORT_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MANIFEST_NAME = /^agents-(\d{4}-\d{2}-\d{2})\.manifest\.json$/;

export const NO_EXPORT_MESSAGE = "No export has been published yet.";
export const NO_EXPORT_DAY_MESSAGE = "There is no export for that day. Exports are kept for 30 days; /api/v1/exports/agents/latest names the newest.";

export const exportsDirFromEnv = () => process.env.NOOSCAPE_EXPORT_DIR?.trim() || null;

/** The days on offer, newest first. A folder that does not exist offers none. */
export async function exportDates(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const present = new Set(names);
  return names
    .map(name => MANIFEST_NAME.exec(name)?.[1])
    .filter((date): date is string => date !== undefined && present.has(agentsExportFiles(date).data))
    .sort()
    .reverse();
}
