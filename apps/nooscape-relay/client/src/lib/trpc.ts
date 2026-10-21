import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../server/routers";

export const trpc = createTRPCReact<AppRouter>();

/**
 * Spread into a query's options to send that query in a request of its own. The client batches the calls made in the same
 * moment into one request, and a batch answers only when its slowest call has: the page's first batch held the hero's figures
 * behind a read that took 11 seconds. A query that can be slow, or that the page can do without, takes this, so it holds
 * back only its own section (`main.tsx` sends a query with this context unbatched).
 */
export const ownRequest = { trpc: { context: { ownRequest: true } } } as const;
