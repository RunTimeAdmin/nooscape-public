import { useState, type CSSProperties } from "react";
import { Link } from "wouter";
import { CHAIN_LABEL, listedChainLabel, type ChainStat, type ExtraChainStat, type ListedChainKey } from "@shared/chains";
import { Term } from "@/components/Term";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { asOfSentence, bnbSentence, chainColorVar, ratingsNote, REGION_ORDER, regionIcon, regionsHeading, regionsShown, registrySentence, registrySplitText, tabState } from "./chainTabsModel";
import { CountUp } from "./CountUp";

/**
 * A chain tab. The open one is a filled pill in the chain's own colour with the primary ink; the
 * others are outlined with the secondary ink, which still clears AA. The outline is an inset
 * shadow because index.css sets a border colour on every element outside any layer, which beats
 * Tailwind's border colour utilities. The `dark:` entries repeat the plain ones because the shared
 * tab styles set their own for the dark theme, which the page always uses.
 */
const PAGE_LINK_CLASS = "inline-flex min-h-11 items-center gap-2 rounded-full px-3 py-2 text-xs font-medium text-ns-ink-dim underline underline-offset-4 transition-colors hover:text-ns-ink";
const TAB_CLASS = [
  "group h-10 flex-none gap-2.5 rounded-full border-0 bg-transparent px-4 text-sm font-medium shadow-[inset_0_0_0_1px_rgba(255,255,255,.14)]",
  "text-ns-ink-dim hover:text-ns-ink dark:text-ns-ink-dim dark:hover:text-ns-ink",
  "data-[state=active]:bg-[color-mix(in_oklab,var(--chain)_16%,transparent)] data-[state=active]:text-ns-ink data-[state=active]:shadow-[inset_0_0_0_1px_var(--chain)]",
  "dark:data-[state=active]:bg-[color-mix(in_oklab,var(--chain)_16%,transparent)] dark:data-[state=active]:text-ns-ink",
].join(" ");

// Ethereum, Base and Arc get a tab only while their switch is on when the client is built (shared/features.ts). The server reads the same list when it runs.
const FEATURES: string | undefined = import.meta.env.VITE_FEATURES;

type Props = {
  /** The BNB Chain registry's recorded facts, when Home has them (null until a pass has published). */
  bnbProfile: { recorded: number; listed: number } | null;
};

function Figure({ label, note, value }: { label: React.ReactNode; note: string; value: number | null }) {
  return (
    <div className="chain-figure rounded-xl p-4">
      <p className="font-mono text-xs uppercase tracking-[.14em] text-[#819588]">{label}</p>
      <p className="mt-2 font-mono text-3xl leading-none tracking-[-.04em] text-[#F2FFF5]">
        {value === null ? (
          <span className="text-base text-[#819588]">not measured here</span>
        ) : (
          <CountUp value={value} />
        )}
      </p>
      <p className="mt-2 text-xs leading-4 text-[#8FA196]">{note}</p>
    </div>
  );
}

/**
 * One tab per chain with the figures the server reports for it. A chain with no
 * approved source is "not indexed", disabled, and shows nothing in place of figures; a
 * figure the server does not measure for a chain says "not measured here". Nothing
 * here is computed in the browser, so every number is the server's.
 */
export function ChainTabs({ bnbProfile }: Props) {
  const query = trpc.liveData.chainStats.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true });
  const [active, setActive] = useState<ListedChainKey>("robinhood");
  const rows: readonly ChainStat[] = query.data?.chains ?? [];
  // The server sends these only while an extra chain is on.
  const extraRows: readonly ExtraChainStat[] = query.data?.extras ?? [];
  const regions = regionsShown(query.data ? extraRows : null, FEATURES);
  const byChain = (chain: ListedChainKey): ChainStat | ExtraChainStat | undefined => rows.find(row => row.chain === chain) ?? extraRows.find(row => row.chain === chain);
  // Start on the first chain that has figures: a disabled tab cannot be the open one.
  const shown = tabState(byChain(active)) === "ready" ? active : (regions.find(chain => tabState(byChain(chain)) === "ready") ?? active);

  return (
    <section aria-labelledby="chains-heading" className="regions rounded-2xl p-5">
      <div data-owl-avoid="" className="max-w-2xl">
        <p className="eyebrow"><Term k="regions">Regions</Term></p>
        <h2 id="chains-heading" className="mt-2 text-xl tracking-[-.04em] text-[#F1FFF3]">{regionsHeading(regions)}</h2>
        <p className="mt-2 text-sm leading-6 text-ns-ink-dim">The same public rules for every region: nothing hidden, withdrawn or unapproved is counted.</p>
        <nav aria-label="Explore a chain" className="mt-3 flex flex-wrap gap-2">
          {REGION_ORDER.map(chain => (
            <Link key={chain} href={`/chains/${chain}`} className={PAGE_LINK_CLASS}>
              Open the {CHAIN_LABEL[chain]} page <span aria-hidden="true">&rarr;</span>
            </Link>
          ))}
          {regions.includes("arc") && (
            <Link href="/chains/arc" className={PAGE_LINK_CLASS}>
              Open the Arc page <span aria-hidden="true">&rarr;</span>
            </Link>
          )}
          {regions.includes("base") && (
            <Link href="/chains/base" className={PAGE_LINK_CLASS}>
              Open the Base page <span aria-hidden="true">&rarr;</span>
            </Link>
          )}
          {regions.includes("ethereum") && (
            <Link href="/chains/ethereum" className={PAGE_LINK_CLASS}>
              Open the Ethereum page <span aria-hidden="true">&rarr;</span>
            </Link>
          )}
        </nav>
      </div>

      {query.isLoading ? (
        <p data-owl-avoid="" className="mt-4 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs text-[#8FA196]">Reading the chain figures…</p>
      ) : rows.length === 0 ? (
        <p data-owl-avoid="" className="mt-4 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs leading-5 text-[#8FA196]">
          The chain figures cannot be read right now. Nothing is drawn in their place.
        </p>
      ) : (
        <Tabs value={shown} onValueChange={value => setActive(value as ListedChainKey)} data-owl-avoid="" className="mt-4">
          <TabsList aria-label="Regions" className="h-auto w-full flex-wrap justify-start gap-2 rounded-none bg-transparent p-0">
            {regions.map(chain => (
              <TabsTrigger key={chain} value={chain} disabled={tabState(byChain(chain)) !== "ready"} className={TAB_CLASS} style={{ "--chain": `var(${chainColorVar(chain)})` } as CSSProperties}>
                <svg aria-hidden="true" viewBox="-1.5 -1.5 3 3" className="size-3.5 shrink-0 fill-transparent stroke-[var(--chain)] [stroke-width:.4] group-data-[state=active]:fill-[var(--chain)] group-data-[state=active]:drop-shadow-[0_0_5px_var(--chain)]">
                  <path d={regionIcon(chain).path} />
                </svg>
                {listedChainLabel(chain)}{" "}
                {tabState(byChain(chain)) === "not-indexed" && <span className="ml-0.5 font-mono text-xs uppercase tracking-[.1em] text-[#819588]">not indexed yet</span>}
              </TabsTrigger>
            ))}
          </TabsList>
          {regions.map(chain => {
            const row = byChain(chain);
            return (
              <TabsContent key={chain} value={chain} style={{ "--chain": `var(${chainColorVar(chain)})` } as CSSProperties} className="mt-4">
                {row && tabState(row) === "ready" ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Figure label={<Term k="acknowledgement">Acknowledged</Term>} value={row.acknowledged} note="Entries a source saw on this chain. Never an endorsement." />
                      <Figure label="Reviewed records" value={row.reviewed} note="Records reviewed, with their evidence kept." />
                      <Figure label="Ratings recorded" value={row.feedbackEvents} note={ratingsNote(chain)} />
                    </div>
                    {registrySplitText(row.registries) && <p className="mt-3 text-xs leading-5 text-[#A9B8AE]">{registrySplitText(row.registries)}</p>}
                    {chain === "solana" && (
                      <p className="mt-3 text-xs leading-5 text-[#A9B8AE]">
                        A dated count of what the three registries hold: the{" "}
                        <Link href="/field/solana-registries-2026-10-18" className="underline underline-offset-4 hover:text-ns-ink">Solana registry census, 18 October 2026</Link>.
                      </p>
                    )}
                    {chain === "robinhood" && (
                      <p className="mt-3 text-xs leading-5 text-[#A9B8AE]">
                        A dated count of what the registry holds: the{" "}
                        <Link href="/field/robinhood-registry-2026-10-20" className="underline underline-offset-4 hover:text-ns-ink">Robinhood Chain registry census, 20 October 2026</Link>.
                      </p>
                    )}
                    {chain === "arc" && (
                      <p className="mt-3 text-xs leading-5 text-[#A9B8AE]">
                        A dated count of what the registry holds: the{" "}
                        <Link href="/field/arc-registry-2026-10-20" className="underline underline-offset-4 hover:text-ns-ink">Arc registry census, 20 October 2026</Link>.
                      </p>
                    )}
                    {chain === "base" && (
                      <p className="mt-3 text-xs leading-5 text-[#A9B8AE]">
                        A dated count of what the registry holds: the{" "}
                        <Link href="/field/base-registry-2026-10-21" className="underline underline-offset-4 hover:text-ns-ink">Base registry census, 21 October 2026</Link>.
                      </p>
                    )}
                    {chain === "bnb" && bnbSentence(bnbProfile) && <p className="mt-3 text-xs leading-5 text-[#A9B8AE]">{bnbSentence(bnbProfile)}</p>}
                    {"registry" in row && registrySentence(row.registry) && <p className="mt-3 text-xs leading-5 text-[#A9B8AE]">{registrySentence(row.registry)}</p>}
                    <p className="mt-3 font-mono text-xs text-[#71857A]">{asOfSentence(row.asOf)}</p>
                  </>
                ) : (
                  <p className="rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs leading-5 text-[#8FA196]">
                    {listedChainLabel(chain)} is not indexed yet: no source for it has been approved. Nothing is shown in place of figures.
                  </p>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </section>
  );
}
