import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callRobinhoodRpc, RobinhoodRegistryHttpError, SCHEDULED_RPC_RETRY_BACKOFF_MS } from "./robinhood";

/**
 * The retry ladder of the Robinhood RPC wrapper, with the network and the clock replaced. The Cloudflare-fronted edge throttles bursts
 * with 403 and 429; an operator's run waits that out (1.5, 3.5, 10, 30 and 60 seconds), the scheduled walk waits 5 seconds in all and
 * leaves the rest to the next tick, which starts from the same cursor.
 */
const ANSWER = { jsonrpc: "2.0", id: 1, result: "0x1" };
const json = () => new Response(JSON.stringify(ANSWER), { status: 200, headers: { "content-type": "application/json" } });
const refused = (status: number) => new Response("", { status });

let calls = 0;
let answers: Array<() => Response> = [];

beforeEach(() => {
  calls = 0;
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => {
    calls += 1;
    return (answers[Math.min(calls, answers.length) - 1] ?? json)();
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Runs a call to its end, moving the clock only as far as the call waits, and says how long it waited in all. */
async function waited(run: () => Promise<unknown>) {
  const started = Date.now();
  const outcome = run().then(
    value => ({ value }),
    (error: unknown) => ({ error })
  );
  await vi.runAllTimersAsync();
  return { ...(await outcome), waitedMs: Date.now() - started };
}

describe("the long ladder", () => {
  it("waits out a throttle for 105 seconds in six tries, and then gives the edge's refusal", async () => {
    answers = [() => refused(429)];
    const attempts = vi.fn();
    const result = await waited(() => callRobinhoodRpc({ method: "eth_chainId", params: [] }, attempts));
    expect((result as { error: unknown }).error).toBeInstanceOf(RobinhoodRegistryHttpError);
    expect(calls).toBe(6);
    expect(attempts).toHaveBeenCalledTimes(6);
    expect(result.waitedMs).toBe(1_500 + 3_500 + 10_000 + 30_000 + 60_000);
  });

  it("answers from the try after a throttle clears", async () => {
    answers = [() => refused(403), () => refused(429), json];
    const result = await waited(() => callRobinhoodRpc({ method: "eth_chainId", params: [] }));
    expect((result as { value: { result: string } }).value.result).toBe("0x1");
    expect(calls).toBe(3);
    expect(result.waitedMs).toBe(1_500 + 3_500);
  });

  it("does not wait on a refusal that will not clear", async () => {
    answers = [() => refused(400)];
    const result = await waited(() => callRobinhoodRpc({ method: "eth_chainId", params: [] }));
    expect((result as { error: RobinhoodRegistryHttpError }).error.status).toBe(400);
    expect(calls).toBe(1);
    expect(result.waitedMs).toBe(0);
  });
});

describe("the short ladder of the scheduled walk", () => {
  it("is 5 seconds in all", () => {
    expect(SCHEDULED_RPC_RETRY_BACKOFF_MS).toEqual([1_500, 3_500]);
  });

  it("gives up after 5 seconds and three tries, so a throttle does not hold a tick", async () => {
    answers = [() => refused(429)];
    const attempts = vi.fn();
    const result = await waited(() => callRobinhoodRpc({ method: "eth_chainId", params: [] }, attempts, SCHEDULED_RPC_RETRY_BACKOFF_MS));
    expect((result as { error: RobinhoodRegistryHttpError }).error.status).toBe(429);
    expect(calls).toBe(3);
    expect(attempts).toHaveBeenCalledTimes(3);
    expect(result.waitedMs).toBe(5_000);
  });

  it("still answers from the try after a short throttle", async () => {
    answers = [() => refused(502), json];
    const result = await waited(() => callRobinhoodRpc({ method: "eth_chainId", params: [] }, undefined, SCHEDULED_RPC_RETRY_BACKOFF_MS));
    expect((result as { value: { result: string } }).value.result).toBe("0x1");
    expect(result.waitedMs).toBe(1_500);
  });
});
