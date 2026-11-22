import type { QueryClient } from "@tanstack/react-query";

/**
 * What the browser keeps of the operator's session. The operator page's reads (owners' emails, claims, payments, sources) stay in the
 * query cache after a sign-out unless something removes them, and came back on screen at the next sign-in before the fresh read
 * landed. A sign-out removes them now, and so does a read refused as unauthorized (the session ended in another tab, or expired):
 * the page then asks who is signed in again and shows the sign-in.
 */

/** The procedure paths only an operator reads. A tRPC query key starts with the procedure's path as an array. */
export const OPERATOR_READS: ReadonlyArray<readonly string[]> = [
  ["liveData", "admin"],
  ["apiKeys", "list"],
  ["apiPayments", "status"],
  ["claim", "operatorClaims"],
  ["operator", "clientAddress"],
];

const OPERATOR_STATUS = ["operator", "status"] as const;

const startsWith = (path: unknown, prefix: readonly string[]) => Array.isArray(path) && prefix.every((part, index) => path[index] === part);

/** True for a query whose key belongs to one of the operator's reads. */
export function isOperatorRead(queryKey: readonly unknown[]): boolean {
  return OPERATOR_READS.some(prefix => startsWith(queryKey[0], prefix));
}

/** True for an error the server sent as UNAUTHORIZED. */
export function isUnauthorized(error: unknown): boolean {
  const data = typeof error === "object" && error !== null ? (error as { data?: { code?: unknown } }).data : undefined;
  return data?.code === "UNAUTHORIZED";
}

/** Drops the operator's reads from the cache and asks again who is signed in. */
export function endOperatorView(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: query => isOperatorRead(query.queryKey) });
  void queryClient.invalidateQueries({ predicate: query => startsWith(query.queryKey[0], OPERATOR_STATUS) });
}
