import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { operatorProcedure, publicProcedure, router } from "../_core/trpc";
import { ApiKeyError, createApiKey, KEY_PATTERN, listKeysForOperator, revokeApiKey, revokeKeyById, setKeyTier, type ApiKeyErrorCode } from "../apiKeys";
import { clientKeyFrom } from "../rateLimit";

/**
 * API keys over tRPC (docs/data-access-2026-10-19.md, stage D2). The REST API itself stays read only, so making and ending a key is
 * done here and not there. `create` makes a free key for an email and shows it once; `revoke` ends a key for whoever holds it. The
 * operator lists keys, sets a tier by hand (the paid ones are only ever set here) and ends a key.
 *
 * Every answer the visitor is meant to read is an ApiKeyError with a fixed text. A key is never returned again after `create`, and
 * nothing here takes or stores a network address: the limit on sign-ups from one address is held in the server's memory.
 */

const CODES: Record<ApiKeyErrorCode, TRPCError["code"]> = {
  UNAVAILABLE: "PRECONDITION_FAILED",
  BAD_EMAIL: "BAD_REQUEST",
  TOO_MANY_SIGNUPS: "TOO_MANY_REQUESTS",
  TOO_MANY_KEYS: "CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  BAD_TIER: "BAD_REQUEST",
};

async function answering<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiKeyError) throw new TRPCError({ code: CODES[error.code], message: error.message });
    throw error;
  }
}

const email = z.string().trim().min(3).max(254);
const keyText = z.string().trim().regex(KEY_PATTERN, "That is not an API key.");
const keyId = z.string().min(1).max(36);

export const apiKeysRouter = router({
  /** A free key for an email, shown once. */
  create: publicProcedure.input(z.object({ email }).strict()).mutation(({ input, ctx }) => answering(() => createApiKey({ email: input.email, clientKey: clientKeyFrom(ctx.req) }))),

  /** Ends the key the caller holds. */
  revoke: publicProcedure.input(z.object({ key: keyText }).strict()).mutation(({ input }) => answering(() => revokeApiKey(input.key))),

  /** The operator's list: keys for one email, or the newest 50. Never the key, only its first characters. */
  list: operatorProcedure.input(z.object({ email: email.optional() }).strict()).query(({ input }) => answering(() => listKeysForOperator(input.email))),

  /** The operator sets a tier by hand. */
  setTier: operatorProcedure.input(z.object({ id: keyId, tier: z.string().min(1).max(12) }).strict()).mutation(({ input }) => answering(() => setKeyTier(input.id, input.tier))),

  /** The operator ends a key. */
  revokeById: operatorProcedure.input(z.object({ id: keyId }).strict()).mutation(({ input }) => answering(() => revokeKeyById(input.id))),
});
