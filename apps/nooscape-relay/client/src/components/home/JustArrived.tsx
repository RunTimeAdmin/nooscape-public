import type { CSSProperties } from "react";
import { Link } from "wouter";
import { listedChainLabel, type ListedChainKey } from "@shared/chains";
import { ownRequest, trpc } from "@/lib/trpc";
import { chainColorVar, registrySplitText } from "./chainTabsModel";
import { CountUp } from "./CountUp";
import { arrivedCountedAt, arrivedCountText, arrivedGridClass, arrivedRegions, firstSeenText } from "./justArrivedModel";

/**
 * What the Owl saw for the first time in the last day, per chain: the number of new directory entries and the
 * newest few by name. It is the part of the page that moves with the chains, so it is read again every minute and says
 * when it was counted. A chain with no approved source is not counted, and a read that fails draws nothing in its place.
 * A new entry is acknowledged, never reviewed.
 */
export function JustArrived() {
  const query = trpc.liveData.arrivals.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true, ...ownRequest });
  const arrivals = query.data?.arrivals ?? null;
  const regions = arrivedRegions(arrivals, import.meta.env.VITE_FEATURES);
  const byChain = (chain: ListedChainKey) => arrivals?.chains.find(row => row.chain === chain);

  return (
    <section aria-labelledby="arrived-heading" className="regions mb-5 rounded-2xl p-5">
      <div data-owl-avoid="" className="max-w-2xl">
        <p className="eyebrow">In the last {arrivals?.windowHours ?? 24} hours</p>
        <h2 id="arrived-heading" className="mt-2 text-xl tracking-[-.04em] text-[#F1FFF3]">New to the Owl</h2>
        <p className="mt-2 text-sm leading-6 text-ns-ink-dim">Entries the directory saw for the first time, by chain. A new entry is acknowledged, never reviewed or endorsed.</p>
      </div>

      {query.isLoading ? (
        <p data-owl-avoid="" className="mt-4 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs text-[#8FA196]">Counting what is new…</p>
      ) : !arrivals ? (
        <p data-owl-avoid="" className="mt-4 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs leading-5 text-[#8FA196]">
          What is new cannot be read right now. Nothing is drawn in its place.
        </p>
      ) : (
        <>
          <div data-owl-avoid="" className={`mt-4 grid gap-3 ${arrivedGridClass(regions.length)}`}>
            {regions.map(chain => {
              const row = byChain(chain);
              const text = row ? arrivedCountText(row) : null;
              return (
                <div key={chain} style={{ "--chain": `var(${chainColorVar(chain)})` } as CSSProperties} className="chain-figure rounded-xl p-4">
                  <p className="font-mono text-xs uppercase tracking-[.14em] text-[#819588]">{listedChainLabel(chain)}</p>
                  {row && text !== null && row.added !== null ? (
                    <>
                      <p className="mt-2 font-mono text-3xl leading-none tracking-[-.04em] text-[#F2FFF5]">
                        {row.added === 0 ? "0" : <CountUp value={row.added} />}
                        <span className="ml-2 text-sm tracking-normal text-[#8FA196]">{text}</span>
                      </p>
                      {registrySplitText(row.registries) && <p className="mt-2 text-xs leading-5 text-[#A9B8AE]">{registrySplitText(row.registries)}</p>}
                      {row.newest.length > 0 && (
                        <ul className="mt-3 space-y-2">
                          {row.newest.map(entry => (
                            <li key={entry.id} className="min-w-0 text-sm leading-5">
                              <Link href={`/agents/${encodeURIComponent(entry.id)}`} className="block truncate text-[#BFFF76] underline underline-offset-4 hover:text-ns-ink">{entry.displayName}</Link>
                              <span className="text-xs text-ns-ink-dim">{firstSeenText(entry.firstSeenAt)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="mt-2 text-xs leading-5 text-[#8FA196]">Not indexed yet. Nothing is counted for this chain.</p>
                  )}
                </div>
              );
            })}
          </div>
          {arrivedCountedAt(arrivals) && <p data-owl-avoid="" className="mt-3 font-mono text-xs text-[#71857A]">{arrivedCountedAt(arrivals)}</p>}
        </>
      )}
    </section>
  );
}
