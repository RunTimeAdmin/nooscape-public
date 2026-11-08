import { QueryClientContext } from "@tanstack/react-query";
import { useContext } from "react";
import type { CensusChain } from "@shared/censusToday";
import { censusTodayRows, formatAsOf, formatChange, type CensusTodayFigure } from "@/lib/censusTodayModel";
import { ownRequest, trpc } from "@/lib/trpc";
import { headingClass, textClass } from "@/components/InfoPage";

/**
 * The part of a registry census page that is not dated: the counts of the page's first table as the directory holds them now, beside
 * the figures the report measured, and the change between. The report below it is a measurement of its own date and does not change.
 * Counts only; it fails closed to nothing, so a page whose read fails is the report alone. With no query client around it (the tests
 * that render a report by itself) it renders nothing, which leaves those pages as they were.
 */
type Props = {
  chain: CensusChain;
  /** The date the report was measured, as the report writes it. */
  measuredOn: string;
  /** The counts of the report's first table. */
  figures: readonly CensusTodayFigure[];
  /** What a reader needs to compare today's counts with the report's, when the way the directory keeps them changed in between. */
  note?: string;
};

const cellClass = "border-b border-white/[.08] py-2.5 pr-4 align-top";
const numberClass = "border-b border-white/[.08] py-2.5 pr-4 text-right align-top font-mono tabular-nums text-ns-ink";
const headClass = "border-b border-white/[.16] py-2 pr-4 text-right font-medium";
const firstHeadClass = "border-b border-white/[.16] py-2 pr-4 font-medium";
const tableClass = "w-full border-collapse text-left text-base leading-7 text-ns-ink-dim";
const n = (value: number) => value.toLocaleString("en-US");

export function CensusToday(props: Props) {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) return null;
  return <CensusTodayBlock {...props} />;
}

function CensusTodayBlock({ chain, measuredOn, figures, note }: Props) {
  const query = trpc.liveData.censusToday.useQuery({ chain }, { ...ownRequest, staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false });
  const today = query.data?.today;
  if (!today) return null;
  const rows = censusTodayRows(figures, today);
  if (rows.length === 0) return null;
  const held = today.heldOut;

  return (
    <section aria-labelledby="census-today" data-census-today={chain}>
      <h2 id="census-today" className={headingClass}>Today</h2>
      <p className={textClass}>
        The report below is a measurement of {measuredOn} and does not change. This table is the same count, taken from the directory as it stands now
        {today.asOf ? `, after the registry pass that finished at ${formatAsOf(today.asOf)}` : ""}.
      </p>
      <div className="mt-4 max-w-prose overflow-x-auto">
        <table className={tableClass}>
          <caption className="sr-only">The counts of the first table of the report, measured and today</caption>
          <thead>
            <tr className="text-sm text-ns-ink">
              <th scope="col" className={firstHeadClass}>What was counted</th>
              <th scope="col" className={headClass}>{measuredOn}</th>
              <th scope="col" className={headClass}>Today</th>
              <th scope="col" className={headClass}>Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.figure}>
                <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{row.label}</th>
                <td className={numberClass}>{n(row.measured)}</td>
                <td className={numberClass}>{n(row.today)}</td>
                <td className={numberClass}>{formatChange(row.change)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note ? <p className={textClass}>{note}</p> : null}
      {held ? (
        <p className={textClass}>
          Held out of the directory today: {n(held.noLink)} with no usable profile link, {n(held.grouped)} that share a profile link, a host name or a wallet with many others,
          {" "}{n(held.numericName)} with a name that is only a number, and {n(held.pending)} not yet sorted.
        </p>
      ) : null}
      {today.ratings !== null ? (
        <p className={textClass}>The chain&rsquo;s reputation registry holds {n(today.ratings)} ratings, counted from its first block.</p>
      ) : null}
    </section>
  );
}
