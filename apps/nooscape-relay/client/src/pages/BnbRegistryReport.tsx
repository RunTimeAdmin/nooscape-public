import { Link } from "wouter";
import { BNB_REGISTRY_REPORT as report } from "@/lib/bnbRegistryReport";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";

/**
 * A dated census of the BNB Chain ERC-8004 registry as a whole. It is a report, not a directory: it lists no agent, ranks
 * nothing, names no host and gives no score. Every number on it comes from lib/bnbRegistryReport.ts, and
 * pages/bnbRegistryReport.test.ts fails if one does not.
 */
const n = (value: { value: number } | number) => (typeof value === "number" ? value : value.value).toLocaleString("en-US");

const cellClass = "border-b border-white/[.08] py-2.5 pr-4 align-top";
const numberClass = "border-b border-white/[.08] py-2.5 pr-4 text-right align-top font-mono tabular-nums text-ns-ink";

export default function BnbRegistryReport() {
  const r = report;
  return (
    <InfoPage title="BNB Chain registry census, 2026-10-16" eyebrow="Field report" heading="BNB Chain registry census">
      <dl className="mt-4 grid max-w-prose grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-sm text-ns-ink-dim">
        <dt>Date</dt>
        <dd className="text-ns-ink">{r.date}</dd>
        <dt>Finalized block</dt>
        <dd className="text-ns-ink">{n(r.finalizedBlock)}</dd>
      </dl>

      <section aria-labelledby="census-method">
        <h2 id="census-method" className={headingClass}>How it was done</h2>
        <p className={textClass}>
          We read the public ERC-8004 registry on BNB Chain up to the finalized block above, which holds {n(r.registrations)} registrations. The directory lists {n(r.listed)} of them under its listing rules. The rest share a link, a host or a wallet with many others, have no usable link, or are named only with a number.
        </p>
        <p className={textClass}>
          For each listed entry we read, or tried to read, its registration file, which is inside the registration itself or at the web or ipfs address the registration names. For the entries that were complete, we sent a plain GET to up to the first two https agent addresses the file lists. We passed over the registry once, over the registration files twice (the figures below are from the second pass) and over the agent addresses once. The user agent was {r.userAgent}.
        </p>
      </section>

      <section aria-labelledby="census-funnel">
        <h2 id="census-funnel" className={headingClass}>From the registry to the entries that answered</h2>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className="w-full border-collapse text-left text-base leading-7 text-ns-ink-dim">
            <caption className="sr-only">Counts at each step</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className="border-b border-white/[.16] py-2 pr-4 font-medium">Step</th>
                <th scope="col" className="border-b border-white/[.16] py-2 pr-4 text-right font-medium">Entries</th>
                <th scope="col" className="border-b border-white/[.16] py-2 font-medium">What it counts</th>
              </tr>
            </thead>
            <tbody>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>Listed</th><td className={numberClass}>{n(r.listed)}</td><td className={cellClass}>Registrations the directory lists.</td></tr>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>Independent</th><td className={numberClass}>{n(r.independent)}</td><td className={cellClass}>Listed entries that are not in a template group (see the second finding).</td></tr>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>Registration file read</th><td className={numberClass}>{n(r.filesRead)}</td><td className={cellClass}>Independent entries whose file we could read.</td></tr>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>Complete</th><td className={numberClass}>{n(r.complete)}</td><td className={cellClass}>A name, a description and at least one https agent address.</td></tr>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>Answered a request</th><td className={numberClass}>{n(r.answered)}</td><td className={cellClass}>A complete entry with at least one agent address that answered a plain GET, with any status.</td></tr>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>Answered with a 2xx or 3xx status</th><td className={numberClass}>{n(r.answeredClean)}</td><td className={cellClass}>The same, with a 2xx or 3xx status from at least one address.</td></tr>
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          Of the {n(r.complete)} complete entries, {n(r.answered)} answered, {n(r.notAnswered)} did not answer, and {n(r.notAsked)} were not asked: a rule stopped the request (a robots.txt that could not be read or that kept the checker out), or the address was a placeholder.
        </p>
        <p className={textClass}>
          <strong className="font-medium text-ns-ink">Note on the independent count.</strong> {n(r.hostNamesIndependents)} of the {n(r.independent)} independent entries sit on two host names that no rule groups together, so the independent count is probably too high.
        </p>
        <p className={textClass}>
          <strong className="font-medium text-ns-ink">Agent cards.</strong> Of the {n(r.answered)} entries that answered, {n(r.a2aAsked)} declare an A2A service. We asked each for its agent card, and {n(r.a2aValid)} returned a valid one, with a name, a description and an address. This covers only the entries that answered. It is not a registry-wide figure.
        </p>
      </section>

      <section aria-labelledby="census-findings">
        <h2 id="census-findings" className={headingClass}>Three findings</h2>
        <p className={textClass}>
          Of the {n(r.filesRead)} registration files we read, {n(r.noHttpsAddress)} ({r.noHttpsAddressPercent}%) list no https agent address. This counts what the files list. It does not say anything about whether the agents run.
        </p>
        <p className={textClass}>
          {n(r.templateGroups)} template groups hold {n(r.templateEntries)} entries. A template group is two or more listed entries with the same name, description and agent-address host, ignoring case, punctuation and the particular digits. On the day of the census, run on the same registry, the clustering step the worker uses (it builds the groups behind the home page&rsquo;s fleet lights) counted {n(r.workerTemplateGroups)} template groups holding {n(r.workerTemplateEntries)} entries, because it then read only registrations that hold their file inside themselves. This report also read the files behind web and ipfs links. The worker now reads those files too, a few at a time, so its count moves toward this report&rsquo;s.
        </p>
        <p className={textClass}>
          Two host names account for {n(r.hostNamesComplete)} of the {n(r.complete)} complete entries. No address on those two host names answered a request.
        </p>
      </section>

      <section aria-labelledby="census-limits">
        <h2 id="census-limits" className={headingClass}>What this does not show</h2>
        <ul className={listClass}>
          <li>It is not proof that an agent is alive. We sent only a plain GET, once to each address. A complete answer of any kind counts as answered, including a 404. Hosting platforms often answer 404 for an app that is gone, so a 404 is a weak sign of life, and it is not proof either way.</li>
          <li>It is not a count of independent people. The grouping looks at the registering wallet and at a shared name, description and address host. One person with many wallets and a different text for each agent is not found.</li>
          <li>{n(r.filesUnread)} registration files could not be read, so they could not be grouped and are counted as independent.</li>
          <li>Names, descriptions and addresses are written by whoever registered the agent. We have not verified them.</li>
          <li>{n(r.otherFieldAddress)} of the {n(r.noHttpsAddress)} files with no https agent address give an https address under a field the standard does not use (url or website). We counted them among the {n(r.noHttpsAddress)} and did not ask those addresses.</li>
          <li>The figures are a moment in time. {n(r.filesChanged)} of the {n(r.filesFetched)} registration files we fetched changed outcome between the two passes, with timeouts in both directions, and each agent address was asked once.</li>
        </ul>
      </section>

      <section aria-labelledby="census-next">
        <h2 id="census-next" className={headingClass}>What happens next</h2>
        <p className={textClass}>
          This census is a snapshot. It will be redone and dated again. What Nooscape-Checker asks for, how gently, and how to keep it out of a site is on the{" "}
          <Link href="/checker" className={linkClass}>Nooscape-Checker page</Link>.
        </p>
      </section>
    </InfoPage>
  );
}
