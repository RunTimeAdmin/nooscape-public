import { beginIngestionRun, finishIngestionRun } from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import type { A2aIngestionResult } from "./types";

type IngestionTrigger = "manual" | "scheduled" | "replay";

/**
 * The run lifecycle every approved-source orchestrator shares: open a run,
 * execute the source-specific body, and close the run exactly once. The body
 * returns its own counts; closing the run as `completed` stays inside the
 * try block, so a database failure while recording success is itself recorded
 * as a failed run and rethrown, as each orchestrator did before this helper.
 *
 * `failureRequestCount` is the honest minimum number of upstream calls a
 * failed run made (the failure path cannot know the real count); it differs
 * per source, so each caller states its own. A failed run keeps the source's
 * prior cursor so the next pass retries the same work.
 */
export async function withIngestionRun<TResult extends A2aIngestionResult>(
  source: IngestionSource,
  trigger: IngestionTrigger,
  failureRequestCount: number,
  body: (runId: string) => Promise<TResult>
): Promise<TResult> {
  const runId = await beginIngestionRun(source, trigger);
  try {
    const result = await body(runId);
    await finishIngestionRun({ runId, source, status: "completed", counts: result, nextCursor: result.nextCursor });
    return result;
  } catch (error) {
    const result: A2aIngestionResult = {
      requestCount: failureRequestCount,
      discoveredCount: 0,
      acceptedCount: 0,
      rejectedCount: 1,
      nextCursor: source.cursor,
    };
    await finishIngestionRun({ runId, source, status: "failed", counts: result, nextCursor: result.nextCursor, error });
    throw error;
  }
}
