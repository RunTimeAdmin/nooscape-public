import { useState, type CSSProperties } from "react";
import { Link } from "wouter";
import { CHAIN_LABEL } from "@shared/chains";
import { Term } from "@/components/Term";
import { trpc } from "@/lib/trpc";
import { chainColorVar } from "./chainTabsModel";
import {
  asOfLabel,
  newerSince,
  newestNotes,
  NOTES_LIMIT,
  registryFloor,
  robinhoodNote,
  solanaNote,
  solanaTotalsLine,
  type FeedEvent,
  type ReportChain,
  type SolanaFeedEvent,
  type SolanaTotal,
} from "./fieldNotesModel";

type ActivityTotals = { measuredThroughBlock: number | null };

const REPORT_CHAINS: readonly ReportChain[] = ["robinhood", "solana"];

/** The switch between the two chains the reports cover. The open one is outlined in the chain's own colour, which is only ever a second signal: the button carries the chain's name. */
const SWITCH_CLASS = [
  "h-10 rounded-full border-0 bg-transparent px-4 text-sm font-medium text-ns-ink-dim shadow-[inset_0_0_0_1px_rgba(255,255,255,.14)] hover:text-ns-ink",
  "aria-pressed:bg-[color-mix(in_oklab,var(--chain)_16%,transparent)] aria-pressed:text-ns-ink aria-pressed:shadow-[inset_0_0_0_1px_var(--chain)]",
].join(" ");

/**
 * The newest events the Owl has measured, on one chain at a time. Robinhood Chain's are the ERC-8004
 * identity registry's: mints, hand-outs from the minting wallet, later changes of hands and profile-link
 * edits, each as the ledger recorded it. Solana's are the three registries' (SAID, 8004 and Metaplex):
 * registrations, owner or authority changes and profile edits, each anchored to its transaction. It is a
 * rear-view record, not a ticker, and says so: Robinhood's is stamped with the ledger's high-water block,
 * Solana's by when the Owl recorded each event, neither chain's timestamps are claimed, and the list is not
 * a live region. Nothing is added to it that the feed does not contain: no invented kinds, no example
 * events. Pausing freezes what is showing so a reader can finish it, and says how many newer events are
 * waiting. The Solana feed is only asked for once the reader switches to it.
 */
export function FieldNotes() {
  const [chain, setChain] = useState<ReportChain>("robinhood");
  const robinhood = trpc.liveData.directoryActivityFeed.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true });
  const solana = trpc.liveData.directorySolanaActivity.useQuery(undefined, { enabled: chain === "solana", refetchInterval: 60_000, refetchOnWindowFocus: true });
  const query = chain === "robinhood" ? robinhood : solana;
  const robinhoodPayload: { totals: ActivityTotals | null; feed: readonly FeedEvent[] } | undefined = robinhood.data;
  const solanaPayload: { totals: readonly SolanaTotal[]; feed: readonly SolanaFeedEvent[] } | undefined = solana.data;
  const feed = chain === "robinhood" ? (robinhoodPayload?.feed ?? []).map(robinhoodNote) : (solanaPayload?.feed ?? []).map(solanaNote);
  const live = newestNotes(feed, NOTES_LIMIT, registryFloor(chain));
  const [frozen, setFrozen] = useState<typeof live | null>(null);
  const shown = frozen ?? live;
  const waiting = frozen ? newerSince(frozen, feed) : 0;
  const stamp = asOfLabel(robinhoodPayload?.totals?.measuredThroughBlock ?? null);
  const totalsLine = chain === "solana" ? solanaTotalsLine(solanaPayload?.totals) : null;

  return (
    <section aria-labelledby="field-notes-heading" className="field-log rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div data-owl-avoid="">
          <p className="eyebrow"><Term k="fieldReports">Field Reports</Term></p>
          <h2 id="field-notes-heading" className="mt-2 text-xl tracking-[-.04em] text-[#F1FFF3]">Notes from the Owl&rsquo;s rounds</h2>
        </div>
        {live.length > 0 && (
          <button
            type="button"
            data-owl-avoid=""
            aria-pressed={frozen !== null}
            onClick={() => setFrozen(frozen ? null : live)}
            className="shrink-0 rounded-full border border-[#BFFF76]/35 bg-[#BFFF76]/[0.08] px-3 py-1.5 font-mono text-xs uppercase tracking-[.14em] text-[#CFFFA6] hover:bg-[#BFFF76] hover:text-[#071006]"
          >
            {frozen ? "Resume" : "Pause"}
          </button>
        )}
      </div>
      <div data-owl-avoid="" role="group" aria-label="Chain" className="mt-3 flex flex-wrap gap-2">
        {REPORT_CHAINS.map(key => (
          <button
            key={key}
            type="button"
            aria-pressed={chain === key}
            onClick={() => {
              setChain(key);
              setFrozen(null);
            }}
            style={{ "--chain": `var(${chainColorVar(key)})` } as CSSProperties}
            className={SWITCH_CLASS}
          >
            {CHAIN_LABEL[key]}
          </button>
        ))}
      </div>
      {chain === "robinhood" ? (
        <p data-owl-avoid="" className="mt-2 max-w-2xl text-sm leading-6 text-ns-ink-dim">
          The newest events measured on the ERC-8004 registry, {stamp}; the chain keeps no timestamps, so each is stamped by block.
        </p>
      ) : (
        <p data-owl-avoid="" className="mt-2 max-w-2xl text-sm leading-6 text-ns-ink-dim">
          The latest events from each of the SAID, 8004 and Metaplex registries, newest first; each is stamped by when the Owl recorded it, which bounds when it happened.
        </p>
      )}
      {totalsLine && <p data-owl-avoid="" className="mt-2 font-mono text-xs text-[#71857A]">{totalsLine}</p>}

      {query.isLoading ? (
        <p data-owl-avoid="" className="mt-4 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs text-[#8FA196]">Reading the measured events…</p>
      ) : query.isError || shown.length === 0 ? (
        <p data-owl-avoid="" className="mt-4 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs leading-5 text-[#8FA196]">
          {query.isError ? "The activity feed cannot be read right now." : "No measured registry activity is available yet."} Nothing is drawn in its place.
        </p>
      ) : (
        <>
          {frozen && (
            <p data-owl-avoid="" className="mt-3 font-mono text-xs text-[#BFFF76]">
              Paused. {waiting === 0 ? "Nothing newer has arrived." : `${waiting.toLocaleString()} newer ${waiting === 1 ? "event is" : "events are"} waiting.`}
            </p>
          )}
          <ol data-owl-avoid="" className="mt-4 space-y-2" aria-live="off" aria-label={`Newest ${shown.length} measured events, newest first`}>
            {shown.map(note => (
              <li key={note.key} className="field-note-in field-log-row flex items-start gap-3">
                <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: note.tone, boxShadow: `0 0 10px ${note.tone}` }} />
                <div className="min-w-0">
                  <p className="text-sm leading-5 text-ns-ink">
                    {note.label}
                    {": "}
                    <Link href={`/agents/${encodeURIComponent(note.entryId)}`} className="text-[#BFFF76] underline underline-offset-4 hover:text-ns-ink">{note.displayName}</Link>
                  </p>
                  <p className="text-xs text-ns-ink-dim">{note.meta}</p>
                </div>
              </li>
            ))}
          </ol>
          <p data-owl-avoid="" className="mt-3 text-xs leading-5 text-ns-ink-dim">
            {chain === "robinhood" ? (
              <>Newest first. A <Term k="handout">hand-out</Term> is a change of hands from the minting wallet within about an hour of minting. </>
            ) : (
              <>Newest first. A change of owner is never read as a sale, and nothing here says whether an agent works. </>
            )}
            <Link href="/changes" className="text-ns-radar underline underline-offset-4 hover:text-ns-ink">The full record is on the What changed page.</Link>
          </p>
        </>
      )}
    </section>
  );
}
