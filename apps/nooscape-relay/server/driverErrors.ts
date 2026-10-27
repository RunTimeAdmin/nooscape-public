import { isCircuitOpenError } from "./dbBreaker";

/** How many errors deep a driver code is looked for: Drizzle wraps the driver's error as the `cause` of its own, so it sits one or two levels down. */
const MAX_CAUSE_DEPTH = 4;

/** True when the error, or one of its `cause`s, carries this MySQL driver code (for example "ER_NO_SUCH_TABLE"). */
export function driverErrorHas(error: unknown, code: string): boolean {
  for (let depth = 0, cause: unknown = error; cause && typeof cause === "object" && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if ((cause as { code?: unknown }).code === code) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/** True when the driver says a table is not there: its migration has not been run on this database. */
export function isMissingTable(error: unknown): boolean {
  return driverErrorHas(error, "ER_NO_SUCH_TABLE");
}

/** True when the driver says a table or a column is not there: the migration that adds it has not been run on this database. */
export function isMissingSchema(error: unknown): boolean {
  return isMissingTable(error) || driverErrorHas(error, "ER_BAD_FIELD_ERROR");
}

/** One log line for a failed query: the message and code of the error and of each cause, on one line, without the parameters Drizzle appends. */
export function describeFailure(error: unknown): string {
  const parts: string[] = [];
  for (let depth = 0, cause: unknown = error; cause && typeof cause === "object" && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const { message, code } = cause as { message?: unknown; code?: unknown };
    if (typeof message === "string") parts.push(`${message.split("\nparams:")[0]!.replace(/[\r\n]+/g, " ").slice(0, 200)}${typeof code === "string" ? ` (${code})` : ""}`);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(" :: ") : String(error).slice(0, 200);
}

/**
 * Said when a part of a page that is allowed to come back empty could not be read. A table or column that is not there yet (a migration
 * not run on this database) is the expected case and stays quiet. Any other failure, such as a timeout, a refused connection or a
 * deadlock, goes to the log, so that it does not pass for missing data; the breaker has said a paused database once, so that is not
 * said again here.
 */
export function noteSectionFailure(section: string, error: unknown): void {
  if (isMissingSchema(error) || isCircuitOpenError(error)) return;
  console.warn(`[LiveData] ${section} could not be read:`, describeFailure(error));
}
