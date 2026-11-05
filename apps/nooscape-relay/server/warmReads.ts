import type { TrpcContext } from "./_core/context";
import { setDirectoryReadsWarmer } from "./readCache";
import { appRouter } from "./routers";

/**
 * How many of the reads below run at once. Each is a full-table count that takes the shared database to several cores for
 * seconds, and a deploy starts two processes that each warm, so all eleven at once put up to twenty-two counts on it together.
 */
const WARM_AT_ONCE = 2;

/**
 * Builds the cached directory aggregates before a visitor asks for them. A cold
 * cache costs the first visitors the whole build (about 7 seconds on the
 * production-scale test data, longer when many arrive at once), and Hostinger
 * boots the app twice on every deploy. The warm-up calls the same public
 * procedures the homepage and the changes page read, so it fills exactly the
 * keys they use. Each procedure already fails closed, so a database that is not
 * up yet costs nothing here: the warm-up simply has nothing to store.
 */
export async function warmPublicReads() {
  // The public procedures read nothing from the context.
  const caller = appRouter.createCaller({ req: {}, res: {}, user: null } as unknown as TrpcContext);
  const reads: Array<() => Promise<unknown>> = [
    () => caller.liveData.directoryBreakdown(),
    () => caller.liveData.directoryWalletCensus(),
    () => caller.liveData.directoryBscRegistry(),
    () => caller.liveData.directoryFunnel(),
    () => caller.liveData.directoryUsdgSettlements(),
    () => caller.liveData.directoryActivityFeed(),
    () => caller.liveData.directorySolanaActivity(),
    () => caller.liveData.chainActivityFeed({ chain: "arc" }),
    () => caller.liveData.noosphereSample(),
    () => caller.liveData.mapAcknowledged(),
    () => caller.liveData.mapFleets(),
  ];
  // A small pool that takes the reads in the order above. A read that fails stores nothing and stops no other.
  let next = 0;
  const lane = async () => {
    while (next < reads.length) {
      const read = reads[next++]!;
      try {
        await read();
      } catch {
        // Each procedure already fails closed, so there is nothing more to do here.
      }
    }
  };
  await Promise.all(Array.from({ length: WARM_AT_ONCE }, lane));
}

/** Warms once now and again after each burst of writes, while someone is reading. */
export function startReadWarming() {
  setDirectoryReadsWarmer(warmPublicReads);
  void warmPublicReads();
}
