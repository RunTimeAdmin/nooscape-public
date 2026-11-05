import { createHash } from "node:crypto";

/**
 * The order a pass takes its pending changes in when it can serve only some of them.
 *
 * The Solana passes cap the events they take in one run and defer the rest, whole, to the next run. A registry key is the
 * registrant's own choice, so serving in key order lets whoever grinds keys that sort first fill the cap on every run and keep
 * every later key's change deferred for as long as they keep paying the fees (outside audit of 2026-11-05, finding R11). Here a
 * key's place is the hash of the pass's slot and the key: in any one run every pending change is as likely to come first as any
 * other, and no key can be made to come first in a run that has not happened yet.
 */
export function inPassOrder<T>(items: readonly T[], keyOf: (item: T) => string, passSlot: number): T[] {
  return items
    .map(item => ({ item, rank: createHash("sha256").update(`${passSlot}:${keyOf(item)}`).digest("hex") }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map(entry => entry.item);
}

/**
 * The items a pass serves under a cap: walked in the pass's order, each one whose weight fits in what is left of the cap, whole or
 * not at all. An item that does not fit is skipped and a lighter one after it can still fit. An item of no weight is not a pending
 * change and is never in the set.
 */
export function admitUnderCap<T>(items: readonly T[], keyOf: (item: T) => string, weightOf: (item: T) => number, cap: number, passSlot: number): Set<T> {
  const admitted = new Set<T>();
  let used = 0;
  for (const item of inPassOrder(items.filter(candidate => weightOf(candidate) > 0), keyOf, passSlot)) {
    const weight = weightOf(item);
    if (used + weight > cap) continue;
    used += weight;
    admitted.add(item);
  }
  return admitted;
}
