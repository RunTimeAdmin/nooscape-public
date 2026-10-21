import { httpBatchLink, httpLink, splitLink } from "@trpc/client";
import superjson from "superjson";
import { TRPC_MAX_BATCH_SIZE } from "@shared/trpcBatch";

const URL = "/api/trpc";

const fetchWithCookies: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, { ...(init ?? {}), credentials: "include" });

/**
 * How the client reaches the API. The calls made in the same moment are batched into one request, which answers only when its
 * slowest call has. A query marked `ownRequest` (lib/trpc.ts) goes alone, so a read that can be slow holds back only its own
 * section. The server rate limiter counts HTTP requests, not procedure calls, so the server refuses a batch larger than
 * `maxItems` too (shared/trpcBatch.ts): ten covers the page's per-tick fan-out.
 */
export function apiLinks(fetch: typeof globalThis.fetch = fetchWithCookies) {
  return [
    splitLink({
      condition: operation => operation.context.ownRequest === true,
      true: httpLink({ url: URL, transformer: superjson, fetch }),
      false: httpBatchLink({ url: URL, transformer: superjson, maxItems: TRPC_MAX_BATCH_SIZE, fetch }),
    }),
  ];
}
