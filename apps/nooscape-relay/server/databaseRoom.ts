import { sql } from "drizzle-orm";
import { getDb } from "./db";

/**
 * How much room the database has before the host stops its writes (finding R3 of the outside audit of 2026-11-05, on the owner's call of the
 * same day: an alarm now, ceilings on what the passes store after the move to a server with room). Cloud Startup allows 6 GB for one database;
 * past it the host suspends the database's write permissions until it is under the limit, and every pass fails. The registry rows and the
 * activity ledgers grow with what registrants write on chain, and nothing else in the app looks at the size.
 *
 * The answer is one word and never a number, because it is public: the API index carries it, the status page prints it and the live check
 * reads it. A figure of the plan's limit is a fact about the hosting. The size itself goes to the runtime log, once an hour, while the room
 * is low or critical.
 */
export type DatabaseRoom = "ok" | "low" | "critical";

/** The plan's limit for one database, in megabytes: 6 GB on Cloud Startup. NOOSCAPE_DATABASE_LIMIT_MB replaces it after a change of plan or host. */
export const DEFAULT_DATABASE_LIMIT_MB = 6_144;
/** From this share of the limit the room is low: time to read the biggest tables. */
export const ROOM_LOW_FROM = 0.7;
/** From this share it is critical: a month of ordinary growth, or a day of a flood, from the end. hPanel's figure runs about 180 MB above this one. */
export const ROOM_CRITICAL_FROM = 0.85;

const OK_HOLD_MS = 10 * 60_000;
const UNREAD_HOLD_MS = 60_000;
const LOG_EVERY_MS = 60 * 60_000;

export function databaseLimitBytes(env: Record<string, string | undefined> = process.env): number {
  const megabytes = Number(env.NOOSCAPE_DATABASE_LIMIT_MB);
  return (Number.isFinite(megabytes) && megabytes > 0 ? megabytes : DEFAULT_DATABASE_LIMIT_MB) * 1024 * 1024;
}

export function databaseRoomOf(usedBytes: number, limitBytes: number): DatabaseRoom {
  if (usedBytes >= limitBytes * ROOM_CRITICAL_FROM) return "critical";
  return usedBytes >= limitBytes * ROOM_LOW_FROM ? "low" : "ok";
}

export type DatabaseRoomReaderOptions = {
  /** The size of every table of the app's database, data and indexes, in bytes. Throws when it cannot be read. */
  usedBytes: () => Promise<number>;
  limitBytes: () => number;
  now?: () => number;
  log?: (line: string) => void;
};

/**
 * A reader that asks the database at most once in ten minutes, and again after a minute when the last ask failed. A failure is not an answer:
 * it reads as null, which the status page says it could not read and the live check warns about. The API index asks on every request it
 * serves, so the hold is what keeps the size query from running per visitor.
 */
export function createDatabaseRoomReader(options: DatabaseRoomReaderOptions): () => Promise<DatabaseRoom | null> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  let held: { until: number; room: DatabaseRoom | null } | null = null;
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<DatabaseRoom | null> | null = null;

  const ask = async (): Promise<DatabaseRoom | null> => {
    try {
      const used = await options.usedBytes();
      if (!Number.isFinite(used) || used < 0) throw new Error("the database size is not a number");
      const limit = options.limitBytes();
      const room = databaseRoomOf(used, limit);
      if (room !== "ok" && now() - lastLoggedAt >= LOG_EVERY_MS) {
        lastLoggedAt = now();
        log(`[Database] room is ${room}: ${Math.round(used / 1024 / 1024)} MB of ${Math.round(limit / 1024 / 1024)} MB. Past the limit the host stops every write.`);
      }
      held = { until: now() + OK_HOLD_MS, room };
      return room;
    } catch {
      held = { until: now() + UNREAD_HOLD_MS, room: null };
      return null;
    }
  };

  return async () => {
    if (held && held.until > now()) return held.room;
    inFlight ??= ask().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** The size of the app's own database (the one the connection is made to), as the information schema counts it: data and indexes of every table. */
export async function usedBytesOfThisDatabase(): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("no database");
  const result = (await db.execute(
    sql`SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE()`
  )) as unknown as [Array<{ bytes: string | number | null }>, unknown];
  return Number(result[0]?.[0]?.bytes);
}

export const readDatabaseRoom = createDatabaseRoomReader({ usedBytes: usedBytesOfThisDatabase, limitBytes: () => databaseLimitBytes() });
