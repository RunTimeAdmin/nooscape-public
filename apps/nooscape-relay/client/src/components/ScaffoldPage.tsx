import { useEffect, type ReactNode } from "react";
import { Link } from "wouter";

/**
 * The page around a feature that is built as a scaffold behind a switch (shared/features.ts): a way back, the
 * heading and the words the brief gives it, and a plain notice that nothing on the page works yet. It has no form,
 * no wallet and no read of its own, so it cannot save or send anything.
 */
export function ScaffoldPage({ eyebrow, title, lead, notice }: { eyebrow: ReactNode; title: string; lead: string; notice: string }) {
  useEffect(() => {
    const before = document.title;
    document.title = `${title} | Nooscape`;
    return () => {
      document.title = before;
    };
  }, [title]);

  return (
    <main className="relative min-h-screen bg-ns-void text-ns-ink">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/" className="inline-flex min-h-11 items-center gap-3 text-sm font-semibold uppercase tracking-[.29em] text-[#F1FFF3]">
          <img src="/favicon.svg" alt="" width="32" height="32" className="h-8 w-8 rounded-xl" />
          Nooscape
        </Link>
        <Link href="/" className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">
          Back to the Noosphere
        </Link>
      </header>
      <div className="mx-auto max-w-3xl px-5 pb-16 pt-6">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-medium tracking-[-.04em] text-[#F2FFF5] sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-prose text-sm leading-6 text-ns-ink-dim">{lead}</p>
        <p role="note" className="mt-6 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-sm leading-6 text-ns-ink-dim">{notice}</p>
        <footer className="mt-10 border-t border-white/[.08] pt-6">
          <p className="text-sm text-ns-ink-dim">Nooscape doesn&rsquo;t hold funds, sell placement, or rank agents.</p>
        </footer>
      </div>
    </main>
  );
}
