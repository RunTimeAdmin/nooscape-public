/**
 * The public records as the home page takes them from the read. The server sends each `lastObservedAt` as a Date, and TanStack
 * Query's structural sharing does not count one Date as equal to another, so a poll that brought nothing new still came back as
 * new objects all the way down, and everything built from them was built again, the effect that reads the address bar included.
 * As ISO text the dates compare, and an answer that has not changed is the very same object as the last one.
 */
type WithIsoDate<T> = Omit<T, "lastObservedAt"> & { lastObservedAt: string };

export function recordsWithIsoDates<T extends { lastObservedAt: Date | string }>(answer: { records: T[] }): { records: WithIsoDate<T>[] } {
  return { records: answer.records.map(record => ({ ...record, lastObservedAt: isoText(record.lastObservedAt) })) };
}

/** A time that does not read becomes empty text: the select runs inside the query, and a throw there would fail the whole read. */
function isoText(value: Date | string): string {
  if (!(value instanceof Date)) return value;
  return Number.isNaN(value.getTime()) ? "" : value.toISOString();
}
