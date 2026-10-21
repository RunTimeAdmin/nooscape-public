import type { TrpcContext } from "./_core/context";
import { setDirectoryReadsWarmer } from "./readCache";
import { appRouter } from "./routers";

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
  await Promise.allSettled([
    caller.liveData.directoryBreakdown(),
    caller.liveData.directoryWalletCensus(),
    caller.liveData.directoryBscRegistry(),
    caller.liveData.directoryFunnel(),
    caller.liveData.directoryUsdgSettlements(),
    caller.liveData.directoryActivityFeed(),
    caller.liveData.directorySolanaActivity(),
    caller.liveData.noosphereSample(),
    caller.liveData.mapAcknowledged(),
    caller.liveData.mapFleets(),
  ]);
}

/** Warms once now and again after each burst of writes, while someone is reading. */
export function startReadWarming() {
  setDirectoryReadsWarmer(warmPublicReads);
  void warmPublicReads();
}
