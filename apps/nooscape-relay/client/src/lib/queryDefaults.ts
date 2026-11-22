/**
 * The query cache's defaults. Left at the library's own, every read was stale at once (so the slow directory search ran again on each
 * return to the tab), and a failed read was tried three more times, about 7 s before the page showed the error, a refused one (400,
 * 401, 404, 429) as well. A page or query that sets its own keeps it.
 */
export const DEFAULT_STALE_MS = 30_000;

/** The HTTP status tRPC gave an error, when it gave one. */
function httpStatusOf(error: unknown): number | undefined {
  const data = typeof error === "object" && error !== null ? (error as { data?: { httpStatus?: unknown } }).data : undefined;
  return typeof data?.httpStatus === "number" ? data.httpStatus : undefined;
}

/** One more try for a read that failed on the way or on the server, none for one the server refused (4xx): asking again gets the same answer, and a 429 asked again only adds to the count. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < 1;
}

export const QUERY_DEFAULTS = { queries: { staleTime: DEFAULT_STALE_MS, retry: shouldRetry } } as const;
