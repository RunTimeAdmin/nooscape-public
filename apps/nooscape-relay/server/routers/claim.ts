import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CLAIM_MESSAGE_MAX } from "@shared/claimMessage";
import { operatorProcedure, publicProcedure, router } from "../_core/trpc";
import { CLAIM_FIELDS } from "@shared/claimProfile";
import { ClaimError, issueClaimRequest, limitClient, listClaimsForOperator, readClaimHistory, readClaimState, removeClaimText, setClaimHeld, verifyAndClaim, verifyAndEdit, type ClaimErrorCode } from "../claims";
import { clientKeyFrom } from "../rateLimit";

/**
 * "Claim this agent" over tRPC (docs/claims-2026-10-18.md): `claim.nonce` issues the message a wallet signs, `claim.verify` makes the
 * claim from the signed message, and `claim.edit` applies one signed edit to what a claim shows. Each counts against the caller's
 * ten-minute limit before it does any work. The operator can put a claim on hold and take it off.
 *
 * The edit is a strict object, so a field this flow does not own (a tier, a state, a rating, whether the entry is listed) is refused
 * by the schema and never reaches the claim code. Every answer the visitor is meant to read is a ClaimError with a fixed text.
 */
const CODES: Record<ClaimErrorCode, TRPCError["code"]> = {
  UNAVAILABLE: "PRECONDITION_FAILED",
  CHAIN_UNAVAILABLE: "PRECONDITION_FAILED",
  NOT_CLAIMABLE: "NOT_FOUND",
  FLEET: "FORBIDDEN",
  BAD_REQUEST: "BAD_REQUEST",
  NONCE: "BAD_REQUEST",
  BAD_SIGNATURE: "BAD_REQUEST",
  COUNTERFACTUAL: "BAD_REQUEST",
  NOT_OWNER: "FORBIDDEN",
  ALREADY_CLAIMED: "CONFLICT",
  FROZEN: "FORBIDDEN",
  NO_CLAIM: "NOT_FOUND",
  OWNER_CHANGED: "FORBIDDEN",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  INVALID_EDIT: "BAD_REQUEST",
  TOO_MANY_EDITS: "TOO_MANY_REQUESTS",
};

/** A ClaimError becomes the tRPC error with the same fixed text; anything else is left for the server's own error log. */
async function answering<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ClaimError) throw new TRPCError({ code: CODES[error.code], message: error.message });
    throw error;
  }
}

const entryId = z.string().min(1).max(36);
const nonce = z.string().min(8).max(64);
const message = z.string().min(1).max(CLAIM_MESSAGE_MAX);
// Hex text of whole bytes: a plain signature is 65, a contract wallet's can be longer (the claim code holds it to 4,096).
const signature = z.string().min(4).max(8_200);
const text = z.string().max(2_000);

/** What an edit may name. Strict: any other key is an error, so this flow can never be made to write a field it does not own. */
const editInput = z
  .object({
    name: text.nullable().optional(),
    website: text.nullable().optional(),
    description: text.nullable().optional(),
    links: z.array(text).max(20).optional(),
  })
  .strict();

export const claimRouter = router({
  /** What an entry's page asks first: can it be claimed, and is there a claim in force. A cheap read that asks no chain. */
  state: publicProcedure.input(z.object({ entryId }).strict()).query(({ input }) => answering(() => readClaimState(input.entryId))),

  nonce: publicProcedure
    .input(z.object({ entryId, wallet: z.string().min(1).max(64), action: z.enum(["claim", "edit"]), edit: editInput.optional() }).strict())
    .mutation(({ input, ctx }) =>
      answering(async () => {
        const clientKey = clientKeyFrom(ctx.req);
        limitClient(clientKey);
        const issued = await issueClaimRequest({ ...input, clientKey });
        return { nonce: issued.nonce, message: issued.message, expiresAt: issued.expiresAt };
      })
    ),

  verify: publicProcedure
    .input(z.object({ nonce, message, signature }).strict())
    .mutation(({ input, ctx }) =>
      answering(async () => {
        limitClient(clientKeyFrom(ctx.req));
        return verifyAndClaim(input);
      })
    ),

  edit: publicProcedure
    .input(z.object({ nonce, message, signature, edit: editInput }).strict())
    .mutation(({ input, ctx }) =>
      answering(async () => {
        limitClient(clientKeyFrom(ctx.req));
        return verifyAndEdit(input);
      })
    ),

  /** The public history of an entry's claims: every claim, edit, hold, end and removal, newest first, without the text that was removed. */
  history: publicProcedure.input(z.object({ entryId }).strict()).query(({ input }) => answering(() => readClaimHistory(input.entryId))),

  /** Operator only: the claims ever made for an entry, with their ids, for a hold or a removal. */
  operatorClaims: operatorProcedure.input(z.object({ entryId }).strict()).query(({ input }) => answering(() => listClaimsForOperator(input.entryId))),

  /**
   * Operator only: removes what an owner wrote from view, for the fields named. `by` says who asked, the owner or Nooscape, and the
   * public history shows it; it never shows why. The history keeps the full record.
   */
  removeText: operatorProcedure
    .input(z.object({ claimId: z.string().min(1).max(36), fields: z.array(z.enum(CLAIM_FIELDS)).min(1).max(4), by: z.enum(["owner", "nooscape"]) }).strict())
    .mutation(({ input }) => answering(() => removeClaimText(input.claimId, input.fields, input.by))),

  /** Operator only: puts a claim on hold. Its owner cannot edit while it is held, and nobody else can claim the agent. */
  freeze: operatorProcedure.input(z.object({ claimId: z.string().min(1).max(36) }).strict()).mutation(({ input }) => answering(() => setClaimHeld(input.claimId, true))),

  /** Operator only: takes a claim off hold. */
  unfreeze: operatorProcedure.input(z.object({ claimId: z.string().min(1).max(36) }).strict()).mutation(({ input }) => answering(() => setClaimHeld(input.claimId, false))),
});
