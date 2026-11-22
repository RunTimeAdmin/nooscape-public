import { describe, expect, it, vi } from "vitest";
import { readPage, TIE_WIDENINGS } from "./webhookPaging";

/** A ledger in memory: the positions from the resume point, oldest first, as many as a read asks for. */
const rowsAt = (...positions: number[]) => positions.map(position => ({ position }));
const position = (row: { position: number }) => row.position;
const ledger = (all: number[]) => async (size: number) => rowsAt(...all.slice(0, size));

describe("a page of a ledger", () => {
  it("is not full when the ledger has fewer rows than a page, and says nothing of how far it got", async () => {
    expect(await readPage(ledger([1, 2]), 3, position)).toEqual({ rows: rowsAt(1, 2) });
  });

  it("says how far it got when it is full and spans more than one position", async () => {
    expect(await readPage(ledger([1, 2, 3, 4]), 3, position)).toEqual({ rows: rowsAt(1, 2, 3), through: 3 });
  });

  it("is widened to take the rest of a second that fills the page", async () => {
    // Five rows in one second and a page of three: the widened page holds them all, and it is not full.
    expect(await readPage(ledger([5, 5, 5, 5, 5]), 3, position)).toEqual({ rows: rowsAt(5, 5, 5, 5, 5) });
    // The widened page reaches the next second, and says how far it got.
    expect(await readPage(ledger([5, 5, 5, 5, 5, 7, 8]), 3, position)).toEqual({ rows: rowsAt(5, 5, 5, 5, 5, 7), through: 7 });
  });

  it("passes a second that is wider than a page can grow to, and says so, instead of resuming from it for ever", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const page = await readPage(ledger(Array.from({ length: 100 }, () => 5)), 2, position);
      expect(page.rows).toHaveLength(2 * 2 ** TIE_WIDENINGS);
      expect(page.through).toBe(6);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("makes progress with a page of one row: the resume point is always past the position it was resumed from", async () => {
    const page = await readPage(ledger([4, 4, 9, 10]), 1, position);
    expect(page.through).toBe(10);
    expect(page.through!).toBeGreaterThan(4);
  });
});
