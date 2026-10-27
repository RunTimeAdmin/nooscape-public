/**
 * Which mode of the Robinhood reputation walk can run from a persisted cursor.
 * This mirrors the server's rules (`assertReputationModeFitsCursor`) so the
 * operator console offers only the button that can work: a backward position
 * (no cursor, or `rb:<block>`) runs only the backfill, and a forward position
 * (`rb:done`, `fw:<block>#<hash>`) runs only the ratings fill. A cursor this
 * does not recognize returns "unknown" and shows both buttons, leaving the
 * server to decide. The server refuses a wrong-mode run before it records
 * anything, so a stale console can never create a failed run.
 */
type ReputationWalkMode = "backfill" | "activity" | "unknown";

export function reputationWalkMode(cursor: string | null | undefined): ReputationWalkMode {
  const trimmed = (cursor ?? "").trim();
  if (trimmed === "" || /^rb:\d+$/.test(trimmed)) return "backfill";
  if (trimmed === "rb:done" || /^fw:\d+#0x[0-9a-fA-F]{64}$/.test(trimmed)) return "activity";
  return "unknown";
}

/**
 * Which walks of the Robinhood identity registry can run from a persisted
 * cursor. This mirrors the server's rules (`robinhoodWalkModesForCursor`, kept
 * in step by a parity test) so the console offers only the buttons that can
 * work. The four walks share one position that moves strictly forward through
 * `bf:` (backfill), `rb:` (registrants), `ac:` (activity), then `fw:`, so one
 * walk runs from any recognized position, and a fresh source may start either
 * backward walk. A cursor this does not recognize returns "unknown" and shows
 * every button, leaving the server to decide. Observe ("Run once") fits every
 * position and is not gated.
 */
type IdentityWalkMode = "backfill" | "registrants" | "activity";

export function identityWalkModes(cursor: string | null | undefined): IdentityWalkMode[] | "unknown" {
  const trimmed = (cursor ?? "").trim();
  if (trimmed === "") return ["backfill", "registrants"];
  if (/^bf:[1-9]\d*$/.test(trimmed)) return ["backfill"];
  if (trimmed === "bf:done" || /^rb:[1-9]\d*$/.test(trimmed)) return ["registrants"];
  if (trimmed === "rb:done" || /^ac:[1-9]\d*$/.test(trimmed) || trimmed === "ac:done" || /^fw:[1-9]\d*#0x[0-9a-fA-F]{64}$/.test(trimmed)) return ["activity"];
  return "unknown";
}

/** Whether the console should offer one identity-registry walk button for this cursor. */
export function identityWalkOffered(cursor: string | null | undefined, mode: IdentityWalkMode): boolean {
  const modes = identityWalkModes(cursor);
  return modes === "unknown" || modes.includes(mode);
}
