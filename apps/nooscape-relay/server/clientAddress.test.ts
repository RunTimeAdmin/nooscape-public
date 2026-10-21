import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { describeClientAddress } from "./clientAddress";

/** A request as Express sees it behind proxies: req.ip already resolved, the forwarded-for header as received, and the app's proxy setting. */
function request(ip: string | undefined, forwardedFor?: string | string[], trustProxy: unknown = 1) {
  return {
    ip,
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    app: { get: (setting: string) => (setting === "trust proxy" ? trustProxy : undefined) },
  };
}

const VISITOR = "203.0.113.9";
const PROXY = "198.51.100.7";

describe("the address the per-address limits see", () => {
  it("looks right when one proxy added the visitor's address and the app trusts one hop", () => {
    const check = describeClientAddress(request(VISITOR, VISITOR));
    expect(check).toMatchObject({ address: VISITOR, trustedHops: 1, forwardedForEntries: 1, addressIsInternal: false, looksRight: true });
    expect(check.note).toContain("1 forwarded-for entry, 1 proxy trusted");
    expect(check.note).toContain("another network");
  });

  it("flags two proxies adding addresses when the app trusts one, and says what the setting should be", () => {
    const check = describeClientAddress(request(PROXY, `${VISITOR}, ${PROXY}`));
    expect(check).toMatchObject({ address: PROXY, trustedHops: 1, forwardedForEntries: 2, looksRight: false });
    expect(check.note).toContain("2 forwarded-for entries but the app trusts 1 proxy");
    expect(check.note).toContain("should be 2");
  });

  it("flags a trusted proxy that forwards no address at all", () => {
    const check = describeClientAddress(request(PROXY));
    expect(check).toMatchObject({ forwardedForEntries: 0, trustedHops: 1, looksRight: false });
    expect(check.note).toContain("does not pass the visitor's address on");
  });

  it("flags fewer entries than trusted proxies when there is still one", () => {
    const check = describeClientAddress(request(VISITOR, VISITOR, 2));
    expect(check).toMatchObject({ forwardedForEntries: 1, trustedHops: 2, looksRight: false });
    expect(check.note).toContain("trusts 2 proxies but the request carries 1 forwarded-for entry");
  });

  it("treats a private address as a proxy's whatever the counts say", () => {
    const check = describeClientAddress(request("10.0.0.7", "10.0.0.7"));
    expect(check).toMatchObject({ addressIsInternal: true, looksRight: false });
    expect(check.note).toContain("private address");
  });

  it("recognises internal addresses in the forms Node reports them", () => {
    for (const internal of ["127.0.0.1", "172.16.4.2", "192.168.1.5", "100.64.0.9", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.7"]) {
      expect(describeClientAddress(request(internal, internal)).addressIsInternal, internal).toBe(true);
    }
  });

  it("does not take an IPv4-mapped public address for a proxy's", () => {
    expect(describeClientAddress(request(`::ffff:${VISITOR}`, VISITOR))).toMatchObject({ addressIsInternal: false, looksRight: true });
  });

  it("counts entries across a header received as an array and ignores blank ones", () => {
    expect(describeClientAddress(request(PROXY, [VISITOR, PROXY])).forwardedForEntries).toBe(2);
    expect(describeClientAddress(request(VISITOR, `${VISITOR}, ,`)).forwardedForEntries).toBe(1);
    expect(describeClientAddress(request(VISITOR, "")).forwardedForEntries).toBe(0);
  });

  it("cannot compare counts when the proxy setting is not a hop count", () => {
    const check = describeClientAddress(request(VISITOR, VISITOR, true));
    expect(check).toMatchObject({ trustedHops: null, looksRight: false });
    expect(check.note).toContain("not a hop count");
  });

  it("accepts a direct connection when no proxy is trusted and none added an entry", () => {
    expect(describeClientAddress(request(VISITOR, undefined, 0))).toMatchObject({ trustedHops: 0, forwardedForEntries: 0, looksRight: true });
  });
});

/**
 * Through the real router: the check shows the proxy chain, so it is for the
 * operator only. Only the operator lookup is replaced.
 */
const mocks = vi.hoisted(() => ({ getAuthenticatedOperator: vi.fn() }));
const OPERATOR = { id: 1, name: "Test Operator", role: "admin" as const, openId: "test-operator" };

async function caller(req: unknown) {
  vi.doMock("./operatorAuth", async importOriginal => {
    const actual = await importOriginal<typeof import("./operatorAuth")>();
    return { ...actual, getAuthenticatedOperator: mocks.getAuthenticatedOperator };
  });
  const { appRouter } = await import("./routers");
  return appRouter.createCaller({ user: null, req, res: {} } as unknown as TrpcContext);
}

describe("operator.clientAddress", { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.doUnmock("./operatorAuth");
  });

  it("refuses a caller who is not signed in as the operator", async () => {
    mocks.getAuthenticatedOperator.mockResolvedValue(null);
    const trpc = await caller({ ...request(VISITOR, VISITOR), protocol: "https" });
    const error = await trpc.operator.clientAddress().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("UNAUTHORIZED");
  });

  it("describes the operator's own request", async () => {
    mocks.getAuthenticatedOperator.mockResolvedValue(OPERATOR);
    const trpc = await caller({ ...request(PROXY, `${VISITOR}, ${PROXY}`), protocol: "https" });
    expect(await trpc.operator.clientAddress()).toMatchObject({ address: PROXY, forwardedForEntries: 2, trustedHops: 1, looksRight: false });
  });
});
