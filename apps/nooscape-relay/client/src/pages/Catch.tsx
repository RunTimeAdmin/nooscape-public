import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { isCatchDate, type PublicCatch } from "@shared/owlsCatch";
import { CatchActions, CatchFind } from "@/components/home/OwlsCatch";
import { ARCHIVE_PATH, ARCHIVE_TITLE, catchPath, dateLabel, dayTitle } from "@/components/home/owlsCatchModel";
import { trpc } from "@/lib/trpc";

/** How many catches the archive lists to begin with, and the most it will list. */
const FIRST_PAGE = 30;
const MOST = 100;

/** Sets the browser tab's title while a page is open, and puts the old one back when it closes. */
function usePageTitle(title: string) {
  useEffect(() => {
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}

/** The page around a catch or the list of them: a way back, a heading, and room for the words. */
function CatchShell({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <main className="relative min-h-screen bg-ns-void text-ns-ink">
      <header data-owl-avoid="" className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/" className="inline-flex min-h-11 items-center gap-3 text-sm font-semibold uppercase tracking-[.29em] text-[#F1FFF3]">
          <img src="/favicon.svg" alt="" width="32" height="32" className="h-8 w-8 rounded-xl" />
          Nooscape
        </Link>
        <Link href="/" className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">
          Back to the Noosphere
        </Link>
      </header>
      <div className="mx-auto max-w-3xl px-5 pb-16 pt-6">
        <p data-owl-avoid="" className="eyebrow">Owl&rsquo;s Catch</p>
        <h1 data-owl-avoid="" className="mt-2 text-3xl font-medium tracking-[-.04em] text-[#F2FFF5] sm:text-4xl">{title}</h1>
        <p data-owl-avoid="" className="mt-3 max-w-prose text-sm leading-6 text-ns-ink-dim">{lead}</p>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

const quietBox = "rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-sm leading-6 text-ns-ink-dim";

/** Every catch that was found, newest first. A day with none is not listed. */
function CatchArchive() {
  usePageTitle(ARCHIVE_TITLE);
  const [limit, setLimit] = useState(FIRST_PAGE);
  const query = trpc.liveData.owlsCatchArchive.useQuery({ limit }, { staleTime: 60_000, refetchOnWindowFocus: true });
  const catches: readonly PublicCatch[] = query.data?.catches ?? [];

  return (
    <CatchShell title="The Owl’s Catch" lead="One thing the Owl found in the record each day it finds one, picked by a fixed rule from the record’s own counts and not by hand; a count, never a score.">
      {query.isLoading ? (
        <p data-owl-avoid="" className={quietBox}>Reading the catches…</p>
      ) : query.isError ? (
        <p data-owl-avoid="" className={quietBox}>The catches cannot be read right now. Nothing is shown in their place.</p>
      ) : catches.length === 0 ? (
        <p data-owl-avoid="" className={quietBox}>No catch has been chosen yet. A day with no catch is not listed.</p>
      ) : (
        <>
          <ol data-owl-avoid="" className="space-y-3" aria-label="Catches, newest first">
            {catches.map(view => (
              <li key={view.date} className="catch-card rounded-2xl p-4">
                <Link href={catchPath(view.date)} className="font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">{dateLabel(view.date)}</Link>
                <p className="mt-2 text-lg leading-snug tracking-[-.02em] text-ns-ink">{view.headline}</p>
                <p className="mt-2 text-sm leading-6 text-ns-ink-dim">{view.detail}</p>
              </li>
            ))}
          </ol>
          <p data-owl-avoid="" className="mt-4 text-sm leading-6 text-ns-ink-dim">
            {catches.length < limit ? (catches.length === 1 ? "The only catch so far." : `All ${catches.length} catches so far.`) : `The newest ${catches.length} catches.`} A day with no catch is not listed.
          </p>
          {limit < MOST && catches.length >= limit && (
            <button
              type="button"
              data-owl-avoid=""
              onClick={() => setLimit(MOST)}
              className="mt-3 inline-flex min-h-11 items-center rounded-full border border-ns-radar/40 bg-ns-radar/[.08] px-4 font-mono text-xs uppercase tracking-[.14em] text-ns-ink hover:bg-ns-radar hover:text-ns-void"
            >
              Show up to {MOST}
            </button>
          )}
        </>
      )}
    </CatchShell>
  );
}

/** One day's catch, or the plain statement that the day has none. */
function CatchDay({ date }: { date: string }) {
  const valid = isCatchDate(date);
  usePageTitle(valid ? dayTitle(date) : ARCHIVE_TITLE);
  const query = trpc.liveData.owlsCatchByDate.useQuery({ date }, { enabled: valid, staleTime: 60_000, refetchOnWindowFocus: true });
  const view = query.data?.catch ?? null;
  const title = valid ? `The Owl’s Catch, ${dateLabel(date)}` : "That is not a date";

  return (
    <CatchShell title={title} lead={valid ? "One thing the Owl found in the record that day, picked by a fixed rule and not by hand; a count, never a score." : "A catch is found by its day, written year, month, day, like 2026-10-15."}>
      {!valid ? (
        <Link href={ARCHIVE_PATH} data-owl-avoid="" className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">All catches</Link>
      ) : query.isLoading ? (
        <p data-owl-avoid="" className={quietBox}>Reading the catch…</p>
      ) : query.isError ? (
        <p data-owl-avoid="" className={quietBox}>The catch cannot be read right now. Nothing is shown in its place.</p>
      ) : view ? (
        <section aria-label={`The catch of ${dateLabel(date)}`} className="catch-card flex flex-col rounded-2xl p-5">
          <CatchFind view={view} />
          <CatchActions view={view} />
        </section>
      ) : (
        <>
          <p data-owl-avoid="" className={quietBox}>There is no catch on {dateLabel(date)}. Either no count passed the Owl&rsquo;s rules that day, or the day has not been chosen.</p>
          <Link href={ARCHIVE_PATH} data-owl-avoid="" className="mt-4 inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">All catches</Link>
        </>
      )}
    </CatchShell>
  );
}

/**
 * The archive at /catch, or one day at /catch/:date. Both routes use this one lazy page, so going from the list to a day
 * (or back) does not wait for another piece of code, and the skeleton does not flash in between.
 */
export default function CatchPage({ date }: { date?: string }) {
  return date === undefined ? <CatchArchive /> : <CatchDay key={date} date={date} />;
}
