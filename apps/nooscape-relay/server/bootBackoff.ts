import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A start that cannot reach or migrate the database ends the process (server/_core/index.ts), the host starts it again at once, and every
 * attempt opens database connections against the host's allowance of 500 new ones an hour (docs/incident-2026-11-01-outage.md: ten starts a
 * minute would have spent it by 03:50, and the site could not have returned until the hour turned over, even with the grant restored).
 *
 * This module spaces the attempts. A start that failed on the database leaves a note in the temporary directory, next to the lifecycle trail;
 * the next start reads it and waits out a delay that doubles with each failure in a row, before it opens any connection. A start that gets
 * through removes the note, so a normal boot finds none and never waits. The note is on the machine and not in the process, so it holds
 * however many processes the host starts and however fast it restarts them.
 */
export const BOOT_FAILURE_FILE = "nooscape-boot-failure.json";
/** The wait after the first failure; each failure in a row doubles it. */
export const FIRST_DELAY_MS = 15_000;
/** The longest wait, so a database that comes back is tried again within five minutes. */
export const MAX_DELAY_MS = 300_000;
/** A failure this old no longer counts as one in a row: the next failure starts the count again. */
export const RESET_AFTER_MS = 30 * 60 * 1000;

type Note = { count: number; lastAt: number };

export type BootBackoffIo = {
  /** The directory that holds the note. Default: the temporary directory. */
  dir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

const fileOf = (io: BootBackoffIo) => path.join(io.dir ?? os.tmpdir(), BOOT_FAILURE_FILE);

/** How long the start after `count` failures in a row waits. */
export function delayAfterFailures(count: number) {
  if (!Number.isFinite(count) || count < 1) return 0;
  return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (Math.floor(count) - 1));
}

function readNote(file: string): Note | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Note> | null;
    if (parsed && Number.isFinite(parsed.count) && Number.isFinite(parsed.lastAt) && (parsed.count as number) >= 1) {
      return { count: Math.floor(parsed.count as number), lastAt: parsed.lastAt as number };
    }
  } catch {
    // No note, or one that cannot be read: nothing to wait for.
  }
  return null;
}

/** For a start that has just failed on the database, before the process ends. Never throws. */
export function recordBootFailure(io: BootBackoffIo = {}): Note {
  const file = fileOf(io);
  const at = (io.now ?? Date.now)();
  const before = readNote(file);
  const inARow = before !== null && at - before.lastAt < RESET_AFTER_MS ? before.count : 0;
  const note = { count: inARow + 1, lastAt: at };
  try {
    fs.writeFileSync(file, JSON.stringify(note));
  } catch {
    // Without a note the next start does not wait, which is how it was before this module.
  }
  return note;
}

/**
 * For the top of a start, before any database connection. Waits until the delay after the last failure has passed and returns how long it
 * waited in milliseconds (0 when there was no note or the delay was over). Never throws.
 */
export async function waitOutBootFailure(io: BootBackoffIo = {}): Promise<number> {
  const note = readNote(fileOf(io));
  if (!note) return 0;
  const at = (io.now ?? Date.now)();
  // A clock that moved backwards must not hold a start for longer than the longest delay.
  const waitMs = Math.min(Math.max(note.lastAt + delayAfterFailures(note.count) - at, 0), MAX_DELAY_MS);
  if (waitMs <= 0) return 0;
  (io.log ?? console.log)(
    `[Boot] ${note.count} start${note.count === 1 ? "" : "s"} in a row failed on the database; waiting ${Math.ceil(waitMs / 1000)} s before the next try, so a crash loop cannot spend the host's allowance of new connections`
  );
  await (io.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))))(waitMs);
  return waitMs;
}

/** For a start that got through to a current schema. Never throws. */
export function clearBootFailure(io: BootBackoffIo = {}) {
  try {
    fs.rmSync(fileOf(io), { force: true });
  } catch {
    // A note that cannot be removed ages out by itself (RESET_AFTER_MS).
  }
}
