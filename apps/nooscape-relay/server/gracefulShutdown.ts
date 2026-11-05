import type { Server } from "node:http";
import { describeError } from "./lifecycleLog";

/**
 * What the app does between a stop signal and the end of the process (docs/graceful-shutdown-2026-11-04.md). A deploy stops the old
 * processes with SIGTERM. Until now the lifecycle log wrote the signal and let the process die at once, so a request in flight was cut
 * (a paid one included) and whatever the meter had counted since its last write was lost. Each part of the app that has something to
 * finish says so with `onShutdown`; all of them run at once when the signal comes; and the wait has a ceiling, because a stop must
 * never hang a deploy.
 */
export const SHUTDOWN_CEILING_MS = 15_000;
const STILL_RUNNING = "still running at the ceiling";

export type ShutdownTaskResult = { name: string; ok: boolean; ms: number; error?: string };
export type ShutdownResult = { tookMs: number; ceilingHit: boolean; tasks: ShutdownTaskResult[] };

/** A set of tasks of their own: the app uses the one below, and the tests make theirs. */
export function createShutdown(options: { ceilingMs?: number; log?: (line: string) => void } = {}) {
  const ceilingMs = options.ceilingMs ?? SHUTDOWN_CEILING_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  const tasks: Array<{ name: string; run: () => unknown }> = [];
  let running: Promise<ShutdownResult> | null = null;

  return {
    /** Adds something to finish. It may be async; one that throws or never ends stops no other. */
    onShutdown(name: string, run: () => unknown) {
      tasks.push({ name, run });
    },
    /** Runs every task at once and answers when all have ended or the ceiling has passed. It happens once: a second call gets the first answer. */
    run(): Promise<ShutdownResult> {
      if (running) return running;
      const started = Date.now();
      const results: ShutdownTaskResult[] = tasks.map(task => ({ name: task.name, ok: false, ms: 0, error: STILL_RUNNING }));
      running = new Promise<ShutdownResult>(resolve => {
        let finished = false;
        const finish = (ceilingHit: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          const now = Date.now();
          for (const result of results) if (result.error === STILL_RUNNING) result.ms = now - started;
          const answer = { tookMs: now - started, ceilingHit, tasks: results };
          log(JSON.stringify({ event: "nooscape_shutdown", ...answer }));
          resolve(answer);
        };
        const timer = setTimeout(() => finish(true), ceilingMs);
        const work = tasks.map(async (task, index) => {
          const at = Date.now();
          let result: ShutdownTaskResult;
          try {
            await task.run();
            result = { name: task.name, ok: true, ms: Date.now() - at };
          } catch (error) {
            result = { name: task.name, ok: false, ms: Date.now() - at, error: describeError(error).message };
          }
          if (!finished) results[index] = result;
        });
        void Promise.all(work).then(() => finish(false));
      });
      return running;
    },
  };
}

const shared = createShutdown();
export const onShutdown = shared.onShutdown;
export const runShutdown = shared.run;

/**
 * Ends an HTTP server the way a deploy needs: no new connection, a request in flight finishes (a paid one among them), and a keep-alive
 * connection ends as soon as it is idle. The server's own timeout for an idle connection is 5 seconds, so the sweep does not wait for it.
 */
export function drainHttpServer(server: Pick<Server, "close" | "closeIdleConnections">) {
  return () =>
    new Promise<void>(resolve => {
      const sweep = setInterval(() => server.closeIdleConnections(), 250);
      server.close(() => {
        clearInterval(sweep);
        resolve();
      });
    });
}
