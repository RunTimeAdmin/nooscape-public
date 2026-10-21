/**
 * How long a step waits between runs, for the best-effort steps that run after the worker's sources (the Robinhood names and
 * the BNB registration files). Each runs at most once in its interval, which is 30 minutes.
 *
 * The worker claims a tick at most once in 30 minutes, so two ticks are never closer than that. But a step does not start at
 * the tick's start: it starts after the sources and the other steps, which take a different time each tick (about half a
 * second for the rater step once its ledger is filled, 25 to 70 seconds for the sources). The gap between two runs of a step
 * is therefore sometimes a minute or so under 30, and a gate of exactly 30 minutes skipped every other tick: each step ran
 * about once an hour, half the approved pace (seen live on 2026-10-18, when the rater fill ended and the steps moved
 * earlier in the tick).
 *
 * The gate is the interval less a slack of two minutes (a tenth of the interval where that is shorter, so a test with a one
 * minute interval still gates). Ticks stay 30 minutes apart, so the step still runs at most once every 30 minutes.
 */
export const STEP_INTERVAL_SLACK_MS = 2 * 60 * 1000;

/** The least time between the starts of two runs of a step whose interval is `intervalMs`. */
export function stepIntervalGateMs(intervalMs: number): number {
  return intervalMs - Math.min(STEP_INTERVAL_SLACK_MS, intervalMs / 10);
}
