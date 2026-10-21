import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { describe, expect, it } from "vitest";
import { createContext } from "./_core/context";

/**
 * The relay has one way to sign in: the operator token and the operator session cookie (operatorAuth.ts), resolved by
 * operatorProcedure. The template's own session login was removed, so a request carries no user until a procedure
 * resolves the operator.
 */
describe("the request context", () => {
  const options = (cookie: string) => ({ req: { headers: { cookie } }, res: {} }) as unknown as CreateExpressContextOptions;

  it("has no signed-in user, whatever cookie the request carries", async () => {
    for (const cookie of ["", "app_session_id=anything", "nooscape_operator=abc; __Host-nooscape_operator=def"]) {
      expect((await createContext(options(cookie))).user, cookie).toBeNull();
    }
  });

  it("hands the request and response on untouched", async () => {
    const opts = options("a=b");
    const ctx = await createContext(opts);
    expect(ctx.req).toBe(opts.req);
    expect(ctx.res).toBe(opts.res);
  });
});
