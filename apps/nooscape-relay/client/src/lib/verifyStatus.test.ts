import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENERIC_ERROR_LINE } from "./claimFlow";
import { VERIFY_STATUS_LABEL, verifyFailureLine, verifyStatusOf } from "./verifyStatus";

describe("what the evidence verifier page is doing", () => {
  it("says a request is out before anything else", () => {
    expect(verifyStatusOf({ pending: true, failed: true, answer: { valid: true } })).toBe("checking");
  });

  it("reads an answer as valid or invalid, and an answer wins over a failure", () => {
    expect(verifyStatusOf({ pending: false, failed: false, answer: { valid: true } })).toBe("valid");
    expect(verifyStatusOf({ pending: false, failed: false, answer: { valid: false } })).toBe("invalid");
    expect(verifyStatusOf({ pending: false, failed: true, answer: { valid: true } })).toBe("valid");
  });

  it("says the packet could not be checked when the request failed and nothing answered, and waits otherwise", () => {
    // A file the server refused used to read "Awaiting packet", as if nothing had been chosen.
    expect(verifyStatusOf({ pending: false, failed: true, answer: undefined })).toBe("failed");
    expect(verifyStatusOf({ pending: false, failed: false, answer: undefined })).toBe("idle");
    expect(verifyStatusOf({ pending: false, failed: false, answer: null })).toBe("idle");
  });

  it("keeps the four words the page always used, and adds one for a failure", () => {
    expect(VERIFY_STATUS_LABEL).toEqual({
      idle: "Awaiting packet",
      checking: "Validating packet",
      valid: "Evidence integrity confirmed",
      invalid: "Evidence validation failed",
      failed: "The packet could not be checked",
    });
  });
});

describe("the line under the file name after a failed request", () => {
  it("says a file the server's input rules refused is not a packet, without showing the rule's own text", () => {
    const line = verifyFailureLine({ message: '[{"code":"invalid_type","path":["packet","envelope"]}]', data: { code: "BAD_REQUEST" } });
    expect(line).toBe("This file is not a Nooscape evidence packet. Export one from a record's evidence drawer.");
    expect(line).not.toContain("invalid_type");
  });

  it("passes a short plain sentence from the server through, and hides anything shaped like data", () => {
    expect(verifyFailureLine({ message: "Too many requests. Try again later.", data: { code: "TOO_MANY_REQUESTS" } })).toBe("Too many requests. Try again later.");
    expect(verifyFailureLine({ message: '[{"code":"invalid_type"}]', data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(GENERIC_ERROR_LINE);
    expect(verifyFailureLine({ message: "fetch failed" })).toBe("fetch failed");
    expect(verifyFailureLine(undefined)).toBe(GENERIC_ERROR_LINE);
    expect(verifyFailureLine(null)).toBe(GENERIC_ERROR_LINE);
  });
});

describe("the evidence verifier page", () => {
  const page = readFileSync(new URL("../pages/VerifyEvidence.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

  it("shows a failed request instead of reading as if no file was chosen", () => {
    expect(page).toContain("verifyStatusOf({ pending: verifyEvidence.isPending, failed: verifyEvidence.isError, answer: result })");
    expect(page).toContain("verifyEvidence.isError && ");
    expect(page).toContain("verifyFailureLine(verifyEvidence.error)");
  });

  it("clears the file input once the file is read, so that the same file can be chosen again", () => {
    expect(page).toContain('event.target.value = "";');
  });
});
