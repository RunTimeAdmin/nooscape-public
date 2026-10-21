import { Link } from "wouter";
import { Term } from "@/components/Term";
import { OwlLineArt } from "./OwlLineArt";

/**
 * Three plain steps, in the words the rest of the site already uses (the glossary and the tier sentences).
 * It makes no claim about a check the backend does not do and carries no figure, so it cannot go stale:
 * where a number belongs, the sections above show the server's.
 */
export function HowItWorks() {
  const steps = [
    {
      title: "Read the registries",
      body: "Only sources Nooscape has approved, each named and bounded before anything is read from it.",
    },
    {
      title: "Group the fleets",
      body: (
        <>
          Identities recorded against one <Term k="registrant">registering wallet</Term> are counted together, so a fleet shows as a fleet.
        </>
      ),
    },
    {
      title: "Show the evidence",
      body: (
        <>
          A reviewed record keeps what was seen as signed evidence, with a <Term k="tier">tier</Term>. A tier is a level of evidence, not a score.
        </>
      ),
    },
  ];
  return (
    <section aria-labelledby="how-it-works-heading" className="how-sees rounded-2xl p-5">
      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <div>
          <div data-owl-avoid="" className="max-w-3xl">
            <p className="eyebrow"><Term k="howTheOwlSees">How the Owl sees</Term></p>
            <h2 id="how-it-works-heading" className="mt-2 text-xl tracking-[-.04em] text-[#F1FFF3]">Read the registries. Group the fleets. Show the evidence.</h2>
          </div>
          <ol className="mt-4 grid gap-4 md:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.title} data-owl-avoid="" className="how-step">
                <span className="how-numeral" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <h3 className="mt-1 text-base font-medium text-[#F2FFF5]">{step.title}</h3>
                <p className="mt-1 text-sm leading-6 text-ns-ink-dim">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
        <OwlLineArt className="how-owl hidden md:block" />
      </div>
      <p data-owl-avoid="" className="mt-4 text-sm font-medium text-ns-ink">No one can pay to glow brighter. Not even us.</p>
      <p data-owl-avoid="" className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs uppercase tracking-[.12em]">
        <Link href="/about" className="inline-flex min-h-6 items-center text-ns-radar hover:underline">What Nooscape is and is not</Link>
        <Link href="/verify" className="inline-flex min-h-6 items-center text-ns-radar hover:underline">Verify an evidence packet</Link>
      </p>
    </section>
  );
}
