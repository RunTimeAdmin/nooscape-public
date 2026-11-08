import { describe, expect, it } from "vitest";
import type { CensusToday } from "@shared/censusToday";
import { censusTodayRows, formatAsOf, formatChange } from "./censusTodayModel";

const today = (overrides: Partial<CensusToday> = {}): CensusToday => ({
  chain: "monad",
  asOf: "2026-11-07T18:47:03.000Z",
  figures: { onChain: 10_500, stored: 4_400, overflow: 6_100, listed: 150, wallets: 70, withHttpsHost: 1_900, hosts: 40, profileLinks: 400 },
  heldOut: { noLink: 5, grouped: 4_200, numericName: 0, pending: 0 },
  ratings: null,
  ...overrides,
});

describe("the lines of the Today block", () => {
  it("are the page's own table lines, in its order, matched to the directory's counts by the label the pages share", () => {
    const rows = censusTodayRows(
      [
        ["Registrations the directory has stored", 4_327],
        ["Registrations the directory lists", 144],
        ["Registering wallets", 69],
      ],
      today()
    );

    expect(rows).toEqual([
      { figure: "stored", label: "Registrations the directory has stored", measured: 4_327, today: 4_400, change: 73 },
      { figure: "listed", label: "Registrations the directory lists", measured: 144, today: 150, change: 6 },
      { figure: "wallets", label: "Registering wallets", measured: 69, today: 70, change: 1 },
    ]);
  });

  it("take the count from the page when the page has its own words for it", () => {
    const rows = censusTodayRows([["Entries the directory shows", 700, "listed"]], today());

    expect(rows).toEqual([{ figure: "listed", label: "Entries the directory shows", measured: 700, today: 150, change: -550 }]);
  });

  it("leave out a line the directory has no count for today, and a label no count stands for, and never show either as zero", () => {
    const rows = censusTodayRows(
      [
        ["Registrations the directory counts on the chain", 10_421],
        ["Entries the directory shows", 144],
        ["Registering wallets", 69],
      ],
      today({ figures: { wallets: 71 } })
    );

    expect(rows.map(row => row.figure)).toEqual(["wallets"]);
  });

  it("keep a count of zero", () => {
    const rows = censusTodayRows([["Registrations counted past a host's cap and not stored", 0]], today({ figures: { overflow: 0 } }));

    expect(rows).toEqual([{ figure: "overflow", label: "Registrations counted past a host's cap and not stored", measured: 0, today: 0, change: 0 }]);
  });
});

describe("how a change and a time are written", () => {
  it("gives a sign and the size, with thousands separated, or no change", () => {
    expect(formatChange(73)).toBe("+73");
    expect(formatChange(-1_851)).toBe("-1,851");
    expect(formatChange(0)).toBe("no change");
  });

  it("never writes a long dash", () => {
    for (const change of [-5, -1, 0, 1, 5, -1_000_000]) expect(formatChange(change)).not.toMatch(/[\u2013\u2014\u2212]/);
  });

  it("gives a time to the minute, in UTC", () => {
    expect(formatAsOf("2026-11-07T18:47:03.000Z")).toBe("2026-11-07 18:47 UTC");
    expect(formatAsOf("2026-02-03T00:05:59.999Z")).toBe("2026-02-03 00:05 UTC");
  });
});
