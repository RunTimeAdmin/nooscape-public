import { Agent, createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdown, drainHttpServer, SHUTDOWN_CEILING_MS } from "./gracefulShutdown";

/**
 * What the app does between a stop signal and the end of the process (docs/graceful-shutdown-2026-11-04.md): every task runs at once,
 * one that fails or never ends stops no other, the wait has a ceiling, and it happens once. The second part runs a real HTTP server,
 * because a request in flight is the thing a deploy must not cut. A signal itself is tested in lifecycleLog.test.ts, on real processes.
 */
afterEach(() => vi.useRealTimers());

const lines: string[] = [];
const make = (ceilingMs = 1000) => {
  lines.length = 0;
  return createShutdown({ ceilingMs, log: line => void lines.push(line) });
};

describe("the tasks of a stop", () => {
  it("run at once, and one line says how each went", async () => {
    vi.useFakeTimers();
    const shutdown = make();
    const order: string[] = [];
    shutdown.onShutdown("slow", async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      order.push("slow");
    });
    shutdown.onShutdown("quick", async () => void order.push("quick"));
    const done = shutdown.run();
    await vi.advanceTimersByTimeAsync(300);
    const result = await done;
    expect(order).toEqual(["quick", "slow"]);
    expect(result).toMatchObject({ ceilingHit: false, tasks: [{ name: "slow", ok: true }, { name: "quick", ok: true }] });
    expect(result.tasks[0]!.ms).toBeGreaterThanOrEqual(300);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "nooscape_shutdown", ceilingHit: false });
  });

  it("report a task that throws, with no password in what it says, and stop no other", async () => {
    const shutdown = make();
    shutdown.onShutdown("meter", async () => {
      throw new Error("cannot write mysql://admin:hunter2@db.example/app");
    });
    shutdown.onShutdown("http", async () => undefined);
    const result = await shutdown.run();
    expect(result.tasks[0]).toMatchObject({ name: "meter", ok: false });
    expect(result.tasks[1]).toMatchObject({ name: "http", ok: true });
    expect(JSON.stringify(result) + lines.join("")).not.toContain("hunter2");
  });

  it("are waited for no longer than the ceiling, and the line says which was still running", async () => {
    vi.useFakeTimers();
    const shutdown = make(1000);
    shutdown.onShutdown("stuck", () => new Promise(() => undefined));
    shutdown.onShutdown("quick", async () => undefined);
    const done = shutdown.run();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;
    expect(result.ceilingHit).toBe(true);
    expect(result.tookMs).toBe(1000);
    expect(result.tasks).toEqual([expect.objectContaining({ name: "stuck", ok: false, error: "still running at the ceiling" }), expect.objectContaining({ name: "quick", ok: true })]);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ceilingHit: true });
  });

  it("run once: a second call gets the first answer and starts nothing again", async () => {
    const shutdown = make();
    const task = vi.fn(async () => undefined);
    shutdown.onShutdown("once", task);
    const first = shutdown.run();
    const second = shutdown.run();
    expect(second).toBe(first);
    await first;
    expect(task).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
  });

  it("wait 15 seconds at most, which is under the 20 the lifecycle log allows", () => {
    expect(SHUTDOWN_CEILING_MS).toBe(15_000);
  });
});

describe("draining an HTTP server", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => cleanup.splice(0).forEach(close => close()));

  async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => server.closeAllConnections());
    return { server, port: (server.address() as AddressInfo).port };
  }

  const get = (port: number, agent?: Agent) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, agent, path: "/" }, res => {
        let body = "";
        res.on("data", chunk => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      req.end();
    });

  it("lets a request in flight finish and refuses a new one", async () => {
    const { server, port } = await serve((_req, res) => void setTimeout(() => res.end("done"), 200));
    const inFlight = get(port);
    await new Promise(resolve => setTimeout(resolve, 50));
    const drained = drainHttpServer(server)();
    await expect(get(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(await inFlight).toEqual({ status: 200, body: "done" });
    await drained;
  });

  it("ends a keep-alive connection that is idle, without waiting for the server's own timeout of 5 seconds", async () => {
    const { server, port } = await serve((_req, res) => void res.end("ok"));
    const agent = new Agent({ keepAlive: true });
    cleanup.push(() => agent.destroy());
    expect((await get(port, agent)).status).toBe(200);
    const started = Date.now();
    await drainHttpServer(server)();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ends a connection that goes idle after the close, when the response it was waiting for is written", async () => {
    const { server, port } = await serve((_req, res) => void setTimeout(() => res.end("late"), 200));
    const agent = new Agent({ keepAlive: true });
    cleanup.push(() => agent.destroy());
    const inFlight = get(port, agent);
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = Date.now();
    const drained = drainHttpServer(server)();
    expect(await inFlight).toEqual({ status: 200, body: "late" });
    await drained;
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("says it is done when the server was not listening", async () => {
    const server = createServer();
    await expect(drainHttpServer(server)()).resolves.toBeUndefined();
  });
});
