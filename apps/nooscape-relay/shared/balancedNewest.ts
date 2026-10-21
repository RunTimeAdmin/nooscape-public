/**
 * The newest items, newest first, with every group's own newest ones kept. A feed that is only the newest N overall is
 * emptied of a quiet group by one busy one: a single pass that records a hundred SAID registrations leaves no room for
 * the 8004 or Metaplex event from the day before. Here each group keeps its newest `floor` items whatever else is newer,
 * and the rest of the limit is filled with the newest of what is left, so the list is still sorted newest first.
 * Pure and shared, so the server that reads the ledger and the page that picks six lines from it use one rule.
 */
export type BalancedNewestOptions<T> = {
  /** How many items to return at most. */
  limit: number;
  /** How many of each group's newest items are kept first. At most `limit` of them are returned, the newest ones. */
  floor: number;
  group: (item: T) => string;
  /** Sorts newest first: negative when `a` is newer than `b`. */
  compare: (a: T, b: T) => number;
};

export function balancedNewest<T>(items: readonly T[], options: BalancedNewestOptions<T>): T[] {
  const { limit, floor, group, compare } = options;
  if (limit <= 0) return [];
  const sorted = [...items].sort(compare);
  const taken = new Map<string, number>();
  const kept = new Set<T>();
  for (const item of sorted) {
    const key = group(item);
    const count = taken.get(key) ?? 0;
    taken.set(key, count + 1);
    if (count < floor) kept.add(item);
  }
  for (const item of sorted) {
    if (kept.size >= limit) break;
    kept.add(item);
  }
  return sorted.filter(item => kept.has(item)).slice(0, limit);
}
