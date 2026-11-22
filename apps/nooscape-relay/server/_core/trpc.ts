import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { isCircuitOpenError } from "../dbBreaker";
import { getAuthenticatedOperator } from "../operatorAuth";
import type { TrpcContext } from "./context";

/** What a caller is told when an unexpected exception (a driver error, a bug) escapes a procedure. */
export const UNEXPECTED_ERROR_MESSAGE = "Something went wrong.";

/** What a caller is told when its input fails a procedure's schema. */
export const INVALID_INPUT_MESSAGE = "Invalid input.";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // The router's default unknown-procedure answer echoes the requested path
  // back ("No procedure found on path ..."), handing reconnaissance a free
  // route map. Answer a bare not-found instead; errors thrown by real
  // procedures — including deliberate NOT_FOUNDs — keep their own messages.
  //
  // An unexpected exception is different: it carries its own text, and a driver
  // error is the SQL statement with its parameter values. A failed operator
  // sign-in lookup showed the operator account's name and the table layout to
  // whoever made the call. Deliberate TRPCErrors choose their messages; anything
  // else is answered with a fixed one, and logUnexpectedTrpcError keeps the cause.
  errorFormatter({ shape, error }) {
    if (shape.data.code === "NOT_FOUND" && shape.message.startsWith("No procedure found on path")) {
      return { ...shape, message: "Not found.", data: { ...shape.data, path: undefined } };
    }
    if (error.code === "INTERNAL_SERVER_ERROR") {
      return { ...shape, message: UNEXPECTED_ERROR_MESSAGE, data: { ...shape.data, stack: undefined } };
    }
    // Input that fails a procedure's schema: the schema's own report names each field and the type it wanted. Say only that the input
    // was wrong. The public pages already show a fixed line for it (serverErrorMessage in client/src/lib/claimFlow.ts).
    if (error.code === "BAD_REQUEST" && error.cause instanceof ZodError) {
      return { ...shape, message: INVALID_INPUT_MESSAGE, data: { ...shape.data, stack: undefined } };
    }
    return shape;
  },
});

/** A driver error's message ends with the statement's parameter values; the log keeps the statement, not the values. */
const withoutParameters = (message: string) => message.split("\nparams:")[0]!;

/**
 * Records an unexpected exception on the server, where the caller no longer sees
 * it: the failing statement and each cause down the chain with its error code
 * (the one that says ER_USER_LIMIT_REACHED), never the parameter values. The
 * lockout of 2026-10-14 broke operator sign-in without a single log line,
 * because nothing logged an exception that escaped a procedure.
 */
export function logUnexpectedTrpcError({ error, path }: { error: TRPCError; path: string | undefined }) {
  if (error.code !== "INTERNAL_SERVER_ERROR") return;
  // While the breaker is open every request that needs a connection fails the same way; it logs the pause once itself.
  if (isCircuitOpenError(error)) return;
  const parts = [withoutParameters(error.message)];
  let cause: unknown = error.cause;
  for (let depth = 0; cause instanceof Error && depth < 3; depth += 1) {
    const code = "code" in cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
    const part = `${withoutParameters(cause.message)}${code}`;
    if (part !== parts[parts.length - 1]) parts.push(part);
    cause = cause.cause;
  }
  console.error(`[tRPC] unexpected error${path ? ` on ${path}` : ""}: ${parts.join(" :: ")}`);
}

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Production operator routes. The session cookie is issued only after a server-side token
 * comparison and maps to a database audit actor.
 */
export const operatorProcedure = t.procedure.use(
  t.middleware(async opts => {
    const operator = await getAuthenticatedOperator(opts.ctx.req);
    if (!operator) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Production operator authentication is required." });
    }
    return opts.next({ ctx: { ...opts.ctx, user: operator } });
  })
);
