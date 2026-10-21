import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChainKey } from "@shared/chains";
import { sweepLine } from "./sweepModel";

/**
 * The Owl's last sweep under the scan map: when each chain was last read, and how far the Robinhood ledger has been
 * measured. Every time is a stored time of a read, in UTC; nothing here is the time the page loaded.
 */
const row = (chain: ChainKey, asOf: string | null, indexed = true) => ({ chain, indexed, asOf });
const READY = "ready" as const;
const ROWS = [row("robinhood", "2026-10-15T10:30:00.000Z"), row("solana", "2026-10-15T10:29:00.000Z"), row("bnb", "2026-10-15T07:15:17.000Z")];

describe("the sweep line", () => {
  it("says nothing while the read is out, and says so when it failed", () => {
    expect(sweepLine({ status: "loading", rows: ROWS, robinhoodBlock: 1 })).toBeNull();
    expect(sweepLine({ status: "unavailable", rows: ROWS, robinhoodBlock: 1 })).toBe("The Owl's last sweep: unavailable right now.");
  });

  it("gives the day of the newest read, each chain's own time, and how far the Robinhood ledger is measured", () => {
    expect(sweepLine({ status: READY, rows: ROWS, robinhoodBlock: 88_985_100 })).toBe(
      "The Owl's last sweep: 15 Oct 2026. Robinhood Chain 10:30 UTC, activity measured to block 88,985,100 · Solana 10:29 UTC · BNB Chain 07:15 UTC.",
    );
  });

  it("puts the chains in the site's order whatever order the rows come in", () => {
    const shuffled = [ROWS[2]!, ROWS[0]!, ROWS[1]!];
    expect(sweepLine({ status: READY, rows: shuffled, robinhoodBlock: null })).toBe("The Owl's last sweep: 15 Oct 2026. Robinhood Chain 10:30 UTC · Solana 10:29 UTC · BNB Chain 07:15 UTC.");
  });

  it("gives a chain that was last read on another day its date", () => {
    const rows = [row("robinhood", "2026-10-15T00:05:00.000Z"), row("solana", "2026-10-15T00:04:00.000Z"), row("bnb", "2026-10-14T23:10:00.000Z")];
    expect(sweepLine({ status: READY, rows, robinhoodBlock: null })).toBe("The Owl's last sweep: 15 Oct 2026. Robinhood Chain 00:05 UTC · Solana 00:04 UTC · BNB Chain 14 Oct, 23:10 UTC.");
  });

  it("leaves out a chain that is not indexed, and says an indexed chain that was never read has not been", () => {
    const rows = [row("robinhood", "2026-10-15T10:30:00.000Z"), row("solana", null), row("bnb", "2026-10-14T01:00:00.000Z", false)];
    expect(sweepLine({ status: READY, rows, robinhoodBlock: null })).toBe("The Owl's last sweep: 15 Oct 2026. Robinhood Chain 10:30 UTC · Solana not read yet.");
  });

  it("names a block only for the chain whose ledger it is, and only when one has been measured", () => {
    const only = [row("solana", "2026-10-15T10:29:00.000Z")];
    expect(sweepLine({ status: READY, rows: only, robinhoodBlock: 88_985_100 })).toBe("The Owl's last sweep: 15 Oct 2026. Solana 10:29 UTC.");
    expect(sweepLine({ status: READY, rows: ROWS, robinhoodBlock: null })).not.toContain("block");
    expect(sweepLine({ status: READY, rows: ROWS, robinhoodBlock: 0 })).toContain("to block 0");
  });

  it("says the Owl has not finished a sweep when no read is recorded or none can be read", () => {
    expect(sweepLine({ status: READY, rows: [], robinhoodBlock: 5 })).toBe("The Owl has not finished a sweep yet.");
    expect(sweepLine({ status: READY, rows: [row("robinhood", null), row("solana", "not a time")], robinhoodBlock: 5 })).toBe("The Owl has not finished a sweep yet.");
  });

  it("is a sentence with no list when the only read is of a chain that is not indexed", () => {
    expect(sweepLine({ status: READY, rows: [row("bnb", "2026-10-15T07:15:00.000Z", false)], robinhoodBlock: null })).toBe("The Owl's last sweep: 15 Oct 2026.");
  });

  it("reads every time in UTC, whatever zone the time was written in", () => {
    const rows = [row("robinhood", "2026-10-15T23:30:00-05:00")];
    expect(sweepLine({ status: READY, rows, robinhoodBlock: null })).toBe("The Owl's last sweep: 16 Oct 2026. Robinhood Chain 04:30 UTC.");
  });

  it("has no long dash", () => {
    expect(sweepLine({ status: READY, rows: ROWS, robinhoodBlock: 88_985_100 })).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
  });
});

describe("where the sweep line is", () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const line = read("./ScanStatusLine.tsx");
  const hero = read("../../pages/home/LandingHero.tsx");

  it("is the third line of the scan status box, under the two about the record, and only when there is a line to show", () => {
    expect(line).toContain("export function ScanStatusLine({ lines, sweep = null }: { lines: [string, string]; sweep?: string | null }) {");
    expect(line.indexOf('role="status"')).toBeLessThan(line.indexOf("{sweep && ("));
    expect(hero).toContain("sweep={sweep}");
  });

  it("is plain text inside the box the owl keeps clear of, and is never announced as it changes", () => {
    const sweep = line.slice(line.indexOf("{sweep && ("));
    expect(line).toContain('<div data-owl-avoid=""');
    expect(sweep).not.toMatch(/aria-live|role=/);
    // What is announced is the two lines about the record, which the throttle looks after.
    expect(line).toContain('const announcement = useThrottledText(lines.join(". "), ANNOUNCE_GAP_MS);');
  });

  it("is made from the same two reads the hero's heading and the regions use, and the ledger's own block", () => {
    expect(hero).toContain("trpc.liveData.chainStats.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true })");
    expect(hero).toContain("trpc.liveData.directoryActivityFeed.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true })");
    expect(hero).toContain("totals?.measuredThroughBlock ?? null");
    expect(hero).toContain('status: statsQuery.isError ? "unavailable" : statsQuery.data ? "ready" : "loading",');
  });
});
