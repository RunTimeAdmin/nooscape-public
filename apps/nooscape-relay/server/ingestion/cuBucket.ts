/**
 * Spaces calls so that what they cost, averaged over any stretch, stays at or under `cuPerSecond`, without bursts: a call
 * takes the next free slot, which is the cost divided by the rate after the one before it. The provider counts cost in
 * compute units (docs.nodereal.io/docs/compute-units-cus: eth_getLogs 50, eth_getBlockByNumber 15, eth_chainId 5).
 */
export function createCuBucket(cuPerSecond: number, deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  if (!(cuPerSecond > 0)) throw new Error("A bucket needs a positive rate.");
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  let nextFree = 0;
  let spent = 0;
  return {
    async take(cost: number): Promise<void> {
      const at = Math.max(now(), nextFree);
      nextFree = at + (cost / cuPerSecond) * 1000;
      spent += cost;
      const wait = at - now();
      if (wait > 0) await sleep(wait);
    },
    spent: () => spent,
  };
}
