/**
 * The most procedure calls one HTTP batch may carry. The client batches up to this many and the server refuses more.
 * The rate limiter counts HTTP requests, so a batch with no cap is a way around it: one request, hundreds of calls
 * against endpoints that scan the whole directory. One constant, so the two sides cannot drift apart.
 */
export const TRPC_MAX_BATCH_SIZE = 10;
