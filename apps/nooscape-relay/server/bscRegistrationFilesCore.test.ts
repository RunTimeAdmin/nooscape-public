import { describe, expect, it } from "vitest";
import { FETCHED, FILE_FAILED_MAX_TRIES, FILE_RETRY_AFTER_MS, FILE_UNPARSED_MAX_TRIES, isSettledLink, LINK_NOT_READ, NOT_FETCHABLE, statusAfterFailedTry, statusAfterUnparsedTry, UNREADABLE, WAITING_STATUSES } from "./bscRegistrationFilesCore";
import { RESOLUTION_FAILED_MAX_ATTEMPTS, RESOLUTION_NO_NAME_MAX_ATTEMPTS } from "./ingestion/registrationFetch";

/** The pure rules of the BNB registration-file step. The database, chain and fetch parts are in bscRegistrationFiles.integration.test.ts. */
describe("the tries", () => {
  it("are the Solana name reader's: five for a link that does not answer, two for a file that is not a registration, six hours apart", () => {
    expect(FILE_FAILED_MAX_TRIES).toBe(RESOLUTION_FAILED_MAX_ATTEMPTS);
    expect(FILE_UNPARSED_MAX_TRIES).toBe(RESOLUTION_NO_NAME_MAX_ATTEMPTS);
    expect(FILE_RETRY_AFTER_MS).toBe(6 * 3_600_000);
  });

  it("are counted in the status, since the evidence has no column for them", () => {
    expect(statusAfterFailedTry(LINK_NOT_READ)).toBe("link_failed_1");
    expect(statusAfterFailedTry("link_failed_1")).toBe("link_failed_2");
    expect(statusAfterFailedTry("link_failed_4")).toBe("link_failed_5");
    expect(statusAfterUnparsedTry(LINK_NOT_READ)).toBe("link_unparsed_1");
    expect(statusAfterUnparsedTry("link_unparsed_1")).toBe("link_unparsed_2");
    // A file that answers after tries that did not starts its own count, and so does the other way round.
    expect(statusAfterUnparsedTry("link_failed_3")).toBe("link_unparsed_1");
    expect(statusAfterFailedTry("link_unparsed_1")).toBe("link_failed_1");
  });

  it("wait for another try while they are under their limits, and not after", () => {
    expect([...WAITING_STATUSES]).toEqual([LINK_NOT_READ, "link_failed_1", "link_failed_2", "link_failed_3", "link_failed_4", "link_unparsed_1"]);
    for (const status of ["link_failed_5", "link_unparsed_2", NOT_FETCHABLE, UNREADABLE, FETCHED, "inline"]) expect(WAITING_STATUSES, status).not.toContain(status);
  });

  it("settle a link that has used its tries, and a link that is not one to read, and no other", () => {
    for (const status of ["link_failed_5", "link_unparsed_2", NOT_FETCHABLE]) expect(isSettledLink(status), status).toBe(true);
    for (const status of [LINK_NOT_READ, "link_failed_1", "link_failed_4", "link_unparsed_1", FETCHED]) expect(isSettledLink(status), status).toBe(false);
  });

  it("fit the evidence column", () => {
    for (const status of [...WAITING_STATUSES, "link_failed_5", "link_unparsed_2", NOT_FETCHABLE, UNREADABLE, FETCHED]) expect(status.length, status).toBeLessThanOrEqual(24);
  });
});
