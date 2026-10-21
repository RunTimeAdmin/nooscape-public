/**
 * What a page shows while its code loads: the brand and the place the page will fill, never a blank
 * dark screen. The first load of the site has its own static version of this in index.html, painted
 * before any script runs.
 */
export function PageShell() {
  return (
    <div className="min-h-screen bg-ns-void" role="status" aria-label="Loading page">
      <div className="mx-auto flex max-w-[1540px] items-center gap-3 px-5 py-5 lg:px-8">
        <span className="grid h-10 w-10 place-items-center rounded-full border border-[#BFFF76]/50 bg-[#BFFF76]/[0.08]">
          <img src="/favicon.svg" alt="" width="32" height="32" className="h-8 w-8 rounded-xl" />
        </span>
        <span className="text-sm font-semibold uppercase tracking-[0.29em] text-ns-ink">Nooscape</span>
      </div>
      <div className="mx-auto grid max-w-[1540px] gap-3 px-5 pt-6 lg:px-8" aria-hidden="true">
        <div className="h-9 w-2/5 animate-pulse rounded-lg bg-white/[0.07] motion-reduce:animate-none" />
        <div className="h-4 w-3/5 animate-pulse rounded-lg bg-white/[0.07] motion-reduce:animate-none" />
        <div className="h-64 animate-pulse rounded-2xl bg-white/[0.05] motion-reduce:animate-none" />
      </div>
    </div>
  );
}
