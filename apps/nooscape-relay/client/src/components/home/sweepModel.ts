import { CHAIN_LABEL, CHAINS, type ChainStat } from "@shared/chains";
import { latestSweepAt, type ReadStatus } from "./heroModel";

/**
 * The Owl's last sweep as the scan status line says it: the day of the newest successful read, when each chain was last
 * read, and how far the Robinhood activity ledger has been measured. Pure, so the wording is tested without a browser.
 * Every time is a stored time of a read (never the time the page loaded), in UTC, and a chain that is not indexed is
 * left out rather than shown with a figure it does not have.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number) => String(value).padStart(2, "0");
const readable = (iso: string | null): Date | null => {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};
const shortDay = (date: Date) => `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
const dayOf = (date: Date) => `${shortDay(date)} ${date.getUTCFullYear()}`;
const clockOf = (date: Date) => `${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;

export type SweepInput = {
  status: ReadStatus;
  rows: ReadonlyArray<Pick<ChainStat, "chain" | "indexed" | "asOf">>;
  /** The block the Robinhood activity ledger has been measured through, or null when it has not been measured. */
  robinhoodBlock: number | null;
};

/** The line under the scan map, or null while the read is out (the hero's own line says it is reading). */
export function sweepLine({ status, rows, robinhoodBlock }: SweepInput): string | null {
  if (status === "loading") return null;
  if (status === "unavailable") return "The Owl's last sweep: unavailable right now.";
  const newest = readable(latestSweepAt(rows));
  if (!newest) return "The Owl has not finished a sweep yet.";
  const day = dayOf(newest);
  const segments = CHAINS.flatMap(chain => {
    const row = rows.find(candidate => candidate.chain === chain);
    if (!row || !row.indexed) return [];
    const read = readable(row.asOf);
    const when = read ? (dayOf(read) === day ? clockOf(read) : `${shortDay(read)}, ${clockOf(read)}`) : "not read yet";
    const block = chain === "robinhood" && robinhoodBlock !== null ? `, activity measured to block ${robinhoodBlock.toLocaleString("en-US")}` : "";
    return [`${CHAIN_LABEL[chain]} ${when}${block}`];
  });
  return segments.length === 0 ? `The Owl's last sweep: ${day}.` : `The Owl's last sweep: ${day}. ${segments.join(" · ")}.`;
}
