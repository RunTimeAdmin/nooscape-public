/**
 * The daily agents export's file names, and how long its days are kept (stage 3 of D6; the operator's choice of 2026-11-21: 30 days).
 * Pure and with no imports, so the writer, the download routes and the daily job all read it without importing one another.
 */

export const AGENTS_DATASET = "agents";

/** The file names of a day's export. */
export const agentsExportFiles = (date: string) => ({ data: `${AGENTS_DATASET}-${date}.jsonl.gz`, manifest: `${AGENTS_DATASET}-${date}.manifest.json` });

export const EXPORT_KEEP_DAYS = 30;

const EXPORT_FILE = /^agents-(\d{4}-\d{2}-\d{2})\.(jsonl\.gz|manifest\.json|jsonl\.gz\.part)$/;

/** The UTC day of a moment, as YYYY-MM-DD. */
export const utcDay = (when: Date) => when.toISOString().slice(0, 10);

/** The oldest day kept when `today` is written: today and the 29 days before it. */
export function oldestKeptDay(today: string, keepDays = EXPORT_KEEP_DAYS): string {
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (keepDays - 1));
  return utcDay(day);
}

/**
 * The files in the export folder to remove on the run for `today`: every export file of a day older than the oldest kept, and a part file
 * of any day but today (left by a run that stopped before it finished). A manifest is listed before its day's data file, so a reader never
 * finds a manifest whose file is gone. Names that are not export files are never listed.
 */
export function expiredExportFiles(names: readonly string[], today: string, keepDays = EXPORT_KEEP_DAYS): string[] {
  const oldest = oldestKeptDay(today, keepDays);
  const expired = names.filter(name => {
    const match = EXPORT_FILE.exec(name);
    if (!match) return false;
    const [, day, kind] = match;
    return day! < oldest || (kind === "jsonl.gz.part" && day !== today);
  });
  // "agents-YYYY-MM-DD" is the first 17 characters; within a day the manifest goes first.
  const order = (name: string) => `${name.slice(0, 17)} ${name.endsWith(".manifest.json") ? 0 : 1} ${name}`;
  return expired.sort((a, b) => order(a).localeCompare(order(b)));
}
