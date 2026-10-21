import { createCuBucket } from "./cuBucket";

/**
 * The compute-unit budget the worker's own BNB Chain reads share (the clustering step's tokenURI reads and the rater step's log
 * reads): half of the 150 CU/s the NodeReal plan allows, so they cannot starve the identity pass (AUTO_REVIEW_PLAN.md). One
 * bucket for all of them, so the steps cannot add up to more than the half whatever order a tick runs them in.
 */
export const BSC_READ_CU_PER_SECOND = 75;
export const bscReadBucket = createCuBucket(BSC_READ_CU_PER_SECOND);

/** NodeReal's published prices in compute units (docs.nodereal.io/docs/compute-units-cus). */
export const BSC_CU = { eth_call: 20, eth_getLogs: 50, eth_getBlockByNumber: 15, eth_getStorageAt: 15 } as const;
