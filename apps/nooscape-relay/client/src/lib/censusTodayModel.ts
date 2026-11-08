import { censusFigureOfLabel, type CensusFigure, type CensusToday } from "@shared/censusToday";

/**
 * What the Today block on a registry census page works out. A page hands it the counts of its own first table, each with the label the
 * page uses and the figure the report measured. Where a label is one the census pages share, the count it stands for is known from the
 * label; a page with its own words (Robinhood's "Entries the directory shows") names the count itself.
 */
export type CensusTodayFigure = readonly [label: string, measured: number, figure?: CensusFigure];

/** One line of the block: a count of the page's first table, as the report measured it and as the directory holds it now. */
export type CensusTodayRow = { figure: CensusFigure; label: string; measured: number; today: number; change: number };

/**
 * The lines of the block, in the order of the page's own table, for the counts the answer has. A line of the table that has nothing to
 * say for today (a count this registry does not have, or a label this table does not use) is left out, not shown as zero.
 */
export function censusTodayRows(figures: readonly CensusTodayFigure[], today: CensusToday): CensusTodayRow[] {
  const rows: CensusTodayRow[] = [];
  for (const [label, measured, named] of figures) {
    const figure = named ?? censusFigureOfLabel(label);
    const value = figure ? today.figures[figure] : undefined;
    if (!figure || value === undefined) continue;
    rows.push({ figure, label, measured, today: value, change: value - measured });
  }
  return rows;
}

/** A change as the block writes it: a sign and the size, or "no change". */
export function formatChange(change: number): string {
  if (change === 0) return "no change";
  return `${change > 0 ? "+" : "-"}${Math.abs(change).toLocaleString("en-US")}`;
}

/** When the registry's source last finished a pass, to the minute and in UTC, as the reports write their own times. */
export function formatAsOf(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
