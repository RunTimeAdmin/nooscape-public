import { useEffect, type ReactNode } from "react";
import { Link } from "wouter";

/**
 * The frame of the plain pages that say how Nooscape treats people: disputes, privacy, terms and contact. A header with the
 * way back, one article, and a footer that links the four of them, so a reader on any of them can reach the others. The
 * pages have no read of their own, no form and no script, so there is nothing on them to fail while the server is busy.
 */
export const linkClass = "text-ns-radar underline underline-offset-4 hover:text-ns-ink";
export const headingClass = "mt-12 text-xl font-medium tracking-[-.03em] text-[#F2FFF5]";
export const textClass = "mt-3 max-w-prose text-base leading-7 text-ns-ink-dim";
export const listClass = "mt-3 max-w-prose list-disc space-y-2 pl-5 text-base leading-7 text-ns-ink-dim";

/** The pages this frame links in its footer. */
export const INFO_LINKS = [
  { href: "/disputes", label: "Disputes" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

export function InfoPage({ title, eyebrow, heading, changed, children }: { title: string; eyebrow: string; heading: string; changed?: string; children: ReactNode }) {
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

      <article className="mx-auto max-w-3xl px-5 pb-16 pt-6">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-medium tracking-[-.04em] text-[#F2FFF5] sm:text-4xl">{heading}</h1>
        {changed && <p className="mt-3 font-mono text-xs uppercase tracking-[.14em] text-ns-ink-dim">Last changed {changed}</p>}
        {children}

        <footer className="mt-12 border-t border-white/[.08] pt-6">
          <nav aria-label="Disputes, privacy, terms and contact">
            <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-ns-ink-dim">
              {INFO_LINKS.map(link => (
                <li key={link.href}>
                  <Link href={link.href} className={`${linkClass} inline-flex min-h-6 items-center`}>{link.label}</Link>
                </li>
              ))}
              <li>
                <Link href="/about" className={`${linkClass} inline-flex min-h-6 items-center`}>What Nooscape is and is not</Link>
              </li>
            </ul>
          </nav>
        </footer>
      </article>
    </main>
  );
}
