import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  assertOperatorLoginAllowed,
  clearOperatorLoginFailures,
  clearOperatorSession,
  establishOperatorSession,
  getAuthenticatedOperator,
  isOperatorAuthConfigured,
  isValidOperatorToken,
  recordOperatorLoginFailure,
} from "../operatorAuth";
import { describeClientAddress } from "../clientAddress";
import { ensureProductionOperator } from "../db";
import { operatorProcedure, publicProcedure, router } from "../_core/trpc";

const tokenInput = z.object({ token: z.string().min(32).max(256) });

export const operatorRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    if (!isOperatorAuthConfigured()) return { configured: false, authenticated: false, operatorName: null } as const;
    try {
      const operator = await getAuthenticatedOperator(ctx.req);
      return {
        configured: true,
        authenticated: Boolean(operator),
        operatorName: operator?.name ?? null,
      } as const;
    } catch {
      // Do not surface database topology or token configuration details publicly.
      return { configured: true, authenticated: false, operatorName: null } as const;
    }
  }),
  login: publicProcedure.input(tokenInput).mutation(async ({ ctx, input }) => {
    if (!isOperatorAuthConfigured()) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Production operator authentication is not configured." });
    }
    try {
      assertOperatorLoginAllowed(ctx.req, input.token);
    } catch (error) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: error instanceof Error ? error.message : "Operator login is temporarily rate limited.",
      });
    }
    if (!isValidOperatorToken(input.token)) {
      recordOperatorLoginFailure(ctx.req);
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid operator token." });
    }

    establishOperatorSession(ctx.req, ctx.res);
    clearOperatorLoginFailures(ctx.req);
    const operator = await ensureProductionOperator();
    return { authenticated: true, operatorName: operator.name } as const;
  }),
  logout: publicProcedure.mutation(({ ctx }) => {
    clearOperatorSession(ctx.req, ctx.res);
    return { success: true } as const;
  }),
  // The address the per-address limits see for the operator's own request, and
  // how many proxies added to it. Operator-only: it shows the proxy chain.
  clientAddress: operatorProcedure.query(({ ctx }) => describeClientAddress(ctx.req)),
});
