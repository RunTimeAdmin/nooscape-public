import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { verifyEvidencePacket as verifyPacket } from "../verifier/src/verify";
import { createPersistedEvidenceEnvelope, listRelayKeys } from "./evidence";
import { evidencePacketSchema } from "./evidencePacketSchema";
import { getPublisherValidationForAgent, isAgentPubliclyVisible } from "./db";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { apiKeysRouter } from "./routers/apiKeys";
import { apiPaymentsRouter } from "./routers/apiPayments";
import { claimRouter } from "./routers/claim";
import { liveDataRouter } from "./routers/liveData";
import { operatorRouter } from "./routers/operator";

/** A visible record's signed evidence, or not-found when none is retained for it. */
async function getEvidenceEnvelope(agentId: string) {
  const publisherValidation = await getPublisherValidationForAgent(agentId);
  const envelope = await createPersistedEvidenceEnvelope(agentId, publisherValidation);
  if (!envelope) throw new TRPCError({ code: "NOT_FOUND", message: "No evidence is retained for this agent." });
  return envelope;
}

/**
 * The relay's answer to a signed packet: the shared check (verifier/src/verify.ts) against the relay's own key list. The list is read only
 * for a packet that names a key, as the lookup always was: a packet with no key id has nothing to look up.
 */
function verifyEvidencePacket(packet: z.infer<typeof evidencePacketSchema>) {
  return verifyPacket(packet, packet.envelope.relayKeyId ? listRelayKeys() : []);
}

/** The id of a reviewed record: a UUID in lower case, as the database made it. */
const REVIEWED_RECORD_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export const appRouter = router({
  system: systemRouter,
  atlas: router({
    evidence: publicProcedure.input(z.object({ agentId: z.string() })).query(async ({ input }) => {
      // The database finds a record under its column's collation, where case and a trailing space do not matter, and the list of withdrawn
      // records was matched in code, so another spelling of a withdrawn record's id found the record and missed the withdrawal (outside
      // audit of 2026-11-05, lead N6). The id is read in its one canonical form, and anything that is not an id gets the answer an unknown id gets.
      const agentId = input.agentId.toLowerCase();
      if (!REVIEWED_RECORD_ID.test(agentId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found." });
      }
      const visible = await isAgentPubliclyVisible(agentId);
      if (!visible) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found." });
      }
      return getEvidenceEnvelope(agentId);
    }),
    verifyEvidence: publicProcedure.input(z.object({ packet: evidencePacketSchema })).mutation(({ input }) => verifyEvidencePacket(input.packet)),
  }),
  liveData: liveDataRouter,
  operator: operatorRouter,
  claim: claimRouter,
  apiKeys: apiKeysRouter,
  apiPayments: apiPaymentsRouter,
});

export type AppRouter = typeof appRouter;
