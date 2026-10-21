import { describe, expect, it } from "vitest";
import { effectivePublisherKeyState } from "./db";

describe("publisher-key expiry resolution", () => {
  const now = new Date("2026-10-08T12:00:00.000Z");

  it("treats an allowlisted key past its configured expiry as expired", () => {
    expect(effectivePublisherKeyState("allowlisted", new Date("2026-10-08T11:59:59.000Z"), now)).toBe("expired");
    // Matches the SQL `<=` boundary used by expireDuePublisherKeys.
    expect(effectivePublisherKeyState("allowlisted", now, now)).toBe("expired");
  });

  it("keeps an allowlisted key allowlisted while its window is open or absent", () => {
    expect(effectivePublisherKeyState("allowlisted", new Date("2026-10-08T12:00:01.000Z"), now)).toBe("allowlisted");
    expect(effectivePublisherKeyState("allowlisted", null, now)).toBe("allowlisted");
  });

  it("passes non-allowlisted states through unchanged", () => {
    expect(effectivePublisherKeyState("pending", new Date("2026-01-01T00:00:00.000Z"), now)).toBe("pending");
    expect(effectivePublisherKeyState("revoked", new Date("2026-01-01T00:00:00.000Z"), now)).toBe("revoked");
    expect(effectivePublisherKeyState("expired", null, now)).toBe("expired");
  });
});
