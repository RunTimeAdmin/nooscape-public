import { serverErrorMessage } from "./claimFlow";

/** What the evidence verifier page is doing, from the three things it knows: a request is out, the request failed, or it was answered. */
export type VerifyStatus = "idle" | "checking" | "valid" | "invalid" | "failed";

/** A failed request is a state of its own: the verifier did not say the packet was bad, it did not answer. */
export function verifyStatusOf(input: { pending: boolean; failed: boolean; answer: { valid: boolean } | null | undefined }): VerifyStatus {
  if (input.pending) return "checking";
  if (input.answer) return input.answer.valid ? "valid" : "invalid";
  return input.failed ? "failed" : "idle";
}

export const VERIFY_STATUS_LABEL: Record<VerifyStatus, string> = {
  idle: "Awaiting packet",
  checking: "Validating packet",
  valid: "Evidence integrity confirmed",
  invalid: "Evidence validation failed",
  failed: "The packet could not be checked",
};

/** The line under the file name when the server refused the file or did not answer. A file its input rules refuse is not a packet, and says so. */
export function verifyFailureLine(error: { message?: string; data?: { code?: string } | null } | null | undefined): string {
  if (error?.data?.code === "BAD_REQUEST") return "This file is not a Nooscape evidence packet. Export one from a record's evidence drawer.";
  return serverErrorMessage(error?.message);
}
