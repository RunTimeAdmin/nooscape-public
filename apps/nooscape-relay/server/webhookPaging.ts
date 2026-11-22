/**
 * A page of a ledger read, oldest first. `read(size)` gives up to `size` rows from the resume point. A page that comes back full says how
 * far it got, as `through`: the position the next read resumes from, inclusive and with no overlap.
 *
 * The ledgers keep whole seconds, so a page whose rows all share one second cannot be resumed from that second: the next read would be the
 * same page, and so on until the look-back passes it (outside audit of 5 November 2026, N3 and N16). Such a page is widened, up to
 * TIE_WIDENINGS times, to take the rest of the second. Past the last widening the second is passed: the resume point is just after it, and
 * the rows of that second beyond the page are not read, which is a loss of some notices and not a stall of every webhook.
 */
export const TIE_WIDENINGS = 3;

export async function readPage<T>(read: (size: number) => PromiseLike<T[]>, limit: number, position: (row: T) => number): Promise<{ rows: T[]; through?: number }> {
  let size = limit;
  for (let widening = 0; ; widening += 1) {
    const rows = await read(size);
    if (rows.length < size) return { rows };
    const first = position(rows[0]!);
    const last = position(rows[rows.length - 1]!);
    if (last > first) return { rows, through: last };
    if (widening >= TIE_WIDENINGS) {
      console.warn(`[Webhooks] one second of a ledger holds more rows than a page can grow to (${rows.length} read); the rest of that second is not read.`);
      return { rows, through: last + 1 };
    }
    size *= 2;
  }
}
