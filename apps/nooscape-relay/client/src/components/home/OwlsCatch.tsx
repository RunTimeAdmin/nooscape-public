import { ArrowUpRight } from "lucide-react";
import { Link } from "wouter";
import type { PublicCatch } from "@shared/owlsCatch";
import { Term } from "@/components/Term";
import { trpc } from "@/lib/trpc";
import { agentPath, ARCHIVE_PATH, cardState, catchPath, dateLabel, isToday, linkedAgents, QUIET_COPY, shareHref, type TodaysCatchPayload } from "./owlsCatchModel";

/**
 * The find itself, as the card, the day's page and the archive show it: the headline, what it says about it, the
 * entries it links to by name, how it was known, and the link that starts a post. Every word of the headline, the
 * detail and the how-we-know text comes from the server, which builds them from the facts stored with the catch;
 * nothing is added here. Static: nothing moves.
 */
export function CatchFind({ view }: { view: PublicCatch }) {
  const links = linkedAgents(view);
  return (
    <>
      <p data-owl-avoid="" className="mt-4 text-xl leading-snug tracking-[-.03em] text-ns-ink sm:text-2xl">{view.headline}</p>
      <p data-owl-avoid="" className="mt-3 max-w-prose text-sm leading-6 text-ns-ink-dim">{view.detail}</p>
      {links.length > 0 && (
        <div data-owl-avoid="" className="mt-4">
          <p className="font-mono text-xs uppercase tracking-[.14em] text-ns-ink-dim">Some of its identities</p>
          <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {links.map(agent => (
              <li key={agent.id} className="min-w-0">
                <Link href={agentPath(agent.id)} className="block truncate text-sm text-ns-radar underline underline-offset-4 hover:text-ns-ink">{agent.name}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details data-owl-avoid="" className="catch-know mt-4 rounded-xl border border-white/[.1] bg-black/20 px-3.5 py-2">
        <summary className="cursor-pointer py-1 font-mono text-xs uppercase tracking-[.14em] text-ns-ink">How we know</summary>
        <p className="pb-2 pt-1 text-sm leading-6 text-ns-ink-dim">{view.howWeKnow}</p>
      </details>
    </>
  );
}

/** The two links under a catch: the post to X, and the list of every catch. */
export function CatchActions({ view, archive = true }: { view: PublicCatch; archive?: boolean }) {
  return (
    <div data-owl-avoid="" className="mt-auto flex flex-wrap items-center gap-3 pt-5">
      <a
        href={shareHref(view)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-ns-radar/40 bg-ns-radar/[.08] px-4 font-mono text-xs uppercase tracking-[.14em] text-ns-ink hover:bg-ns-radar hover:text-ns-void"
      >
        Share on X<span className="sr-only"> (opens in a new tab)</span>
        <ArrowUpRight size={14} aria-hidden="true" />
      </a>
      {archive && (
        <Link href={ARCHIVE_PATH} className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">
          All catches
        </Link>
      )}
    </div>
  );
}

/** The newest catch that was found, for a day that has none: its day, its headline, and a link to it. */
function Newest({ view }: { view: PublicCatch }) {
  return (
    <div data-owl-avoid="" className="mt-4 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3">
      <p className="font-mono text-xs uppercase tracking-[.14em] text-ns-ink-dim">Newest catch, {dateLabel(view.date)}</p>
      <Link href={catchPath(view.date)} className="mt-1.5 block text-sm leading-6 text-ns-radar underline underline-offset-4 hover:text-ns-ink">{view.headline}</Link>
    </div>
  );
}

/**
 * The Owl's Catch: one factual finding a day, chosen by a fixed rule from the record's own counts. When the day has
 * none it says "No catch today" and shows nothing in its place; when the read fails it says so. It never shows an
 * example.
 */
export function OwlsCatch() {
  const query = trpc.liveData.owlsCatch.useQuery(undefined, { refetchInterval: 10 * 60_000, refetchOnWindowFocus: true, staleTime: 60_000 });
  const payload: TodaysCatchPayload | undefined = query.data;
  const state = cardState({ isLoading: query.isLoading, isError: query.isError, data: payload });

  return (
    <section aria-labelledby="owls-catch-heading" className="catch-card flex h-full flex-col rounded-2xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div data-owl-avoid="">
          <p className="eyebrow"><Term k="owlsCatch">Owl&rsquo;s Catch</Term></p>
          <h2 id="owls-catch-heading" className="mt-2 text-xl tracking-[-.04em] text-[#F1FFF3]">Catch of the day</h2>
        </div>
        {state.kind === "catch" && payload && (
          <p data-owl-avoid="" className="shrink-0 rounded-full border border-white/[.14] px-3 py-1.5 font-mono text-xs uppercase tracking-[.14em] text-ns-ink">
            {isToday(state.view, payload.date) ? "Today, " : ""}{dateLabel(state.view.date)}
          </p>
        )}
      </div>
      <p data-owl-avoid="" className="mt-2 max-w-2xl text-sm leading-6 text-ns-ink-dim">One find a day, picked by a fixed rule and not by hand; a count, never a score.</p>

      {state.kind === "loading" && (
        <p data-owl-avoid="" className="mt-4 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs text-[#8FA196]">Reading today&rsquo;s catch…</p>
      )}

      {state.kind === "catch" && (
        <>
          <CatchFind view={state.view} />
          <CatchActions view={state.view} />
        </>
      )}

      {state.kind === "quiet" && (
        <>
          <p data-owl-avoid="" className="mt-4 text-xl leading-snug tracking-[-.03em] text-ns-ink sm:text-2xl">{QUIET_COPY[state.reason].title}</p>
          <p data-owl-avoid="" className="mt-3 max-w-prose text-sm leading-6 text-ns-ink-dim">{QUIET_COPY[state.reason].detail}</p>
          {state.latest && <Newest view={state.latest} />}
          <div data-owl-avoid="" className="mt-auto pt-5">
            <Link href={ARCHIVE_PATH} className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">
              All catches
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
