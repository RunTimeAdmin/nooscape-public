import "dotenv/config";
import { runRateLimitedIngestionTick } from "./ingestion/worker";

// Intended for a trusted host scheduler. The database control plane is paused by
// default, so executing this entrypoint cannot fetch external sources until an
// operator explicitly enables the worker configuration.
async function main() {
  try {
    const result = await runRateLimitedIngestionTick();
    console.log(JSON.stringify({ event: "nooscape_worker_tick", ...result }));
    // Drizzle may retain a connection-pool handle after a one-shot cron run.
    // Explicitly exit so host schedulers do not overlap or time out this tick.
    process.exit(result.state === "failed" ? 1 : 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    console.error(JSON.stringify({ event: "nooscape_worker_tick_failed", message }));
    process.exit(1);
  }
}

void main();
