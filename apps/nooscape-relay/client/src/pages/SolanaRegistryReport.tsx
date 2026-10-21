import { Link } from "wouter";
import { DERIVED as d, MEASURED, PASS_WINDOW, REGISTRIES, REGISTRY_LABEL, SAID_REGISTRATION_MONTHS, registry } from "@/lib/solanaRegistryReport";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";

/**
 * A dated census of the three Solana registries as the directory holds them. It is a report, not a directory: it lists no
 * agent, ranks nothing, names no host or wallet and gives no score. Every number on it comes from
 * lib/solanaRegistryReport.ts, and pages/solanaRegistryReport.test.ts fails if one does not.
 */
const n = (value: number) => value.toLocaleString("en-US");

const cellClass = "border-b border-white/[.08] py-2.5 pr-4 align-top";
const numberClass = "border-b border-white/[.08] py-2.5 pr-4 text-right align-top font-mono tabular-nums text-ns-ink";
const headClass = "border-b border-white/[.16] py-2 pr-4 text-right font-medium";

const said = registry("solana_said");
const e8004 = registry("solana_8004");
const metaplex = registry("solana_registry");

/** The size buckets of the wallet table, in the order the query returned them for the 8004 registry (the Metaplex registry has the same). */
const WALLET_BUCKETS = MEASURED.q2.filter(row => row[0] === "solana_8004").map(row => row[1]);
const bucketRow = (protocol: "solana_8004" | "solana_registry", bucket: string) => MEASURED.q2.find(row => row[0] === protocol && row[1] === bucket)!;

export default function SolanaRegistryReport() {
  return (
    <InfoPage title="Solana registry census, 2026-10-18" eyebrow="Field report" heading="Solana registry census">
      <dl className="mt-4 grid max-w-prose grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-sm text-ns-ink-dim">
        <dt>Date</dt>
        <dd className="text-ns-ink">{MEASURED.date}</dd>
        <dt>Counted from</dt>
        <dd className="text-ns-ink">the passes that finished between {PASS_WINDOW}</dd>
      </dl>

      <section aria-labelledby="census-method">
        <h2 id="census-method" className={headingClass}>How it was done</h2>
        <p className={textClass}>
          This census counts what the directory holds for the three Solana registries: SAID, the 8004 registry and the Metaplex agent registry. Each registry is read in full by a pass of its own, and the directory is filled from it. We counted the entries the directory shows publicly. An entry that is hidden, whose asset the chain has closed, or whose source is not active is not counted.
        </p>
        <p className={textClass}>
          The counts come from read-only queries that return only counts and size buckets. They were run once, on the passes named above. No name, wallet address or host name was selected, and no link or address was asked of any site for this census.
        </p>
      </section>

      <section aria-labelledby="census-registries">
        <h2 id="census-registries" className={headingClass}>The three registries</h2>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className="w-full border-collapse text-left text-base leading-7 text-ns-ink-dim">
            <caption className="sr-only">Size and surface of each registry</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className="border-b border-white/[.16] py-2 pr-4 font-medium">Registry</th>
                <th scope="col" className={headClass}>Entries</th>
                <th scope="col" className={headClass}>Wallets</th>
                <th scope="col" className={headClass}>Distinct links</th>
                <th scope="col" className={headClass}>With an https link</th>
                <th scope="col" className={headClass}>Host names</th>
              </tr>
            </thead>
            <tbody>
              {REGISTRIES.map(key => {
                const r = registry(key);
                return (
                  <tr key={key}>
                    <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{REGISTRY_LABEL[key]}</th>
                    <td className={numberClass}>{n(r.entries)}</td>
                    <td className={numberClass}>{n(r.wallets)}</td>
                    <td className={numberClass}>{key === "solana_registry" ? "not recorded" : n(r.distinctLinks)}</td>
                    <td className={numberClass}>{n(r.withHttpsHost)}</td>
                    <td className={numberClass}>{n(r.hosts)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          Together they hold {n(d.totalEntries)} entries. A wallet here is the owner the registry records (for SAID, its authority). A link is the registration link recorded on the chain, and a host name is the host of an https link. A link that is not an https address, such as an ipfs link, has no host name.
        </p>
      </section>

      <section aria-labelledby="census-wallets">
        <h2 id="census-wallets" className={headingClass}>Where the entries sit</h2>
        <p className={textClass}>
          In the 8004 registry, {n(d.wallets8004.holdingMost)} wallets hold {n(d.wallets8004.holdingMostEntries)} of the {n(e8004.entries)} entries ({d.wallets8004.holdingMostPercent}%), and {n(d.wallets8004.holdingTenOrMore)} wallets hold {n(d.wallets8004.holdingTenOrMoreEntries)} ({d.wallets8004.holdingTenOrMorePercent}%). The largest single wallet holds {n(d.wallets8004.largest)} entries ({d.wallets8004.largestPercent}%).
        </p>
        <p className={textClass}>
          In the Metaplex registry, {n(d.walletsMetaplex.holdingMost)} wallets hold {n(d.walletsMetaplex.holdingMostEntries)} of the {n(metaplex.entries)} entries ({d.walletsMetaplex.holdingMostPercent}%). The largest single wallet holds {n(d.walletsMetaplex.largest)} entries ({d.walletsMetaplex.largestPercent}%).
        </p>
        <p className={textClass}>
          In SAID, each of the {n(said.entries)} identities has a wallet of its own, because an identity is keyed to its owner. There is no concentration of this kind to count.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className="w-full border-collapse text-left text-base leading-7 text-ns-ink-dim">
            <caption className="sr-only">Entries held by one wallet, in size buckets</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className="border-b border-white/[.16] py-2 pr-4 font-medium">Entries held by one wallet</th>
                <th scope="col" className={headClass}>8004 wallets</th>
                <th scope="col" className={headClass}>8004 entries</th>
                <th scope="col" className={headClass}>Metaplex wallets</th>
                <th scope="col" className={headClass}>Metaplex entries</th>
              </tr>
            </thead>
            <tbody>
              {WALLET_BUCKETS.map(bucket => {
                const a = bucketRow("solana_8004", bucket);
                const m = bucketRow("solana_registry", bucket);
                return (
                  <tr key={bucket}>
                    <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{bucket}</th>
                    <td className={numberClass}>{n(a[2])}</td>
                    <td className={numberClass}>{n(a[3])}</td>
                    <td className={numberClass}>{n(m[2])}</td>
                    <td className={numberClass}>{n(m[3])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="census-links">
        <h2 id="census-links" className={headingClass}>Shared links and host names</h2>
        <p className={textClass}>
          In the 8004 registry, {n(d.links8004.entriesSharingALink)} of the {n(e8004.entries)} entries ({d.links8004.entriesSharingALinkPercent}%) share their link with at least one other entry. {n(d.links8004.linksSharedByTenOrMore)} links are each shared by ten or more entries, and together they hold {n(d.links8004.entriesInThoseLinks)} entries ({d.links8004.entriesInThoseLinksPercent}%). The largest group is {n(d.links8004.largestGroup)} entries. {n(d.links8004.notHttps)} of the 8004 links are not https addresses.
        </p>
        <p className={textClass}>
          In SAID, {n(said.distinctLinks)} distinct links serve {n(said.entries)} identities. {n(d.saidSharedLinks)} links are each used by two identities ({n(d.saidSharedLinksEntries)} identities), and every other identity has a link of its own. The Metaplex registry records no link, so there are no link figures for it.
        </p>
        <p className={textClass}>
          One host name holds {n(d.hosts.saidLargest)} of the {n(said.withHttpsHost)} SAID entries that have an https link ({d.hosts.saidLargestPercent}%), and the next holds {n(d.hosts.saidSecond)}. In the 8004 registry, two host names hold {n(d.hosts.e8004First)} and {n(d.hosts.e8004Second)} of the {n(e8004.withHttpsHost)} entries that have an https link ({d.hosts.e8004TwoLargestPercent}% together), among {n(e8004.hosts)} host names in all. In the Metaplex registry, the largest of {n(metaplex.hosts)} host names holds {n(d.hosts.metaplexLargest)} of the {n(metaplex.withHttpsHost)} entries that have one ({d.hosts.metaplexLargestPercent}%), and the other {n(d.hosts.metaplexWithoutHost)} entries have no https host recorded.
        </p>
      </section>

      <section aria-labelledby="census-records">
        <h2 id="census-records" className={headingClass}>What each registry records</h2>
        <h3 className="mt-6 text-lg font-medium text-ns-ink">SAID</h3>
        <p className={textClass}>
          A SAID account records the month it was created, a badge, and, in its newest layout, a stake and a slash count. The identities by the month they were registered:
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className="w-full border-collapse text-left text-base leading-7 text-ns-ink-dim">
            <caption className="sr-only">SAID identities by registration month</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className="border-b border-white/[.16] py-2 pr-4 font-medium">Month</th>
                <th scope="col" className={headClass}>Identities</th>
              </tr>
            </thead>
            <tbody>
              {SAID_REGISTRATION_MONTHS.map(row => (
                <tr key={row.month}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{row.month}</th>
                  <td className={numberClass}>{n(row.entries)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          The badge is bought, or granted by a sponsor. It is not an identity check. {n(d.said.badgeYes)} of the {n(said.entries)} identities ({d.said.badgePercent}%) carry it. The newest of the account&rsquo;s three layouts holds {n(d.said.layoutNewest)} identities and records a stake: {n(d.said.stakeNone)} record none and {n(d.said.stakeSome)} record some. None of them records a slash. The two older layouts hold {n(d.said.olderLayouts)} identities and record neither.
        </p>

        <h3 className="mt-6 text-lg font-medium text-ns-ink">8004</h3>
        <p className={textClass}>
          The registry keeps a feedback counter for each agent. A rating here is a count of records. Nooscape does not weigh or endorse them, and the counter does not say who wrote them.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className="w-full border-collapse text-left text-base leading-7 text-ns-ink-dim">
            <caption className="sr-only">8004 agents by the ratings they hold</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className="border-b border-white/[.16] py-2 pr-4 font-medium">Ratings per agent</th>
                <th scope="col" className={headClass}>Agents</th>
                <th scope="col" className={headClass}>Ratings</th>
              </tr>
            </thead>
            <tbody>
              {MEASURED.q6.map(row => (
                <tr key={row[0]}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{row[0]}</th>
                  <td className={numberClass}>{n(row[1])}</td>
                  <td className={numberClass}>{n(row[2])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          {n(d.ratings.agentsWithNone)} agents hold no rating. The {n(d.ratings.agentsWith100OrMore)} agents in the largest bucket hold {n(d.ratings.ratingsOfThose)} of the {n(d.ratings.all)} ratings ({d.ratings.ratingsOfThosePercent}%), and the ten agents with the most hold {n(d.ratings.tenMost)} ({d.ratings.tenMostPercent}%).
        </p>

        <h3 className="mt-6 text-lg font-medium text-ns-ink">Metaplex</h3>
        <p className={textClass}>
          All {n(MEASURED.q7[0][1])} Metaplex entries were written by the chain pass, which reads each identity account and the owner and name of its asset from the chain.
        </p>
      </section>

      <section aria-labelledby="census-names">
        <h2 id="census-names" className={headingClass}>Names</h2>
        <p className={textClass}>
          Every Metaplex entry has a name of its own. They are {n(d.names.metaplexDistinct)} distinct names, and {n(d.names.metaplexSharing)} entries ({d.names.metaplexSharingPercent}%) share a name with at least one other.
        </p>
        <p className={textClass}>
          In the 8004 registry, {n(d.names.e8004Placeholder)} entries ({d.names.e8004PlaceholderPercent}%) have no name of their own. The other {n(d.names.e8004Named)} carry {n(d.names.e8004Distinct)} distinct names, and {n(d.names.e8004Sharing)} entries share a name with at least one other.
        </p>
        <p className={textClass}>
          A SAID account holds no name, only a link. Nooscape reads the card each link names, a few at a time. When this census was counted, {n(d.names.saidPlaceholder)} of the {n(said.entries)} identities still had the placeholder, and that figure changes every day.
        </p>
        <p className={textClass}>
          A name is written by whoever registered the agent and has not been verified. Two entries with the same name are not necessarily the same agent or the same person.
        </p>
      </section>

      <section aria-labelledby="census-overlap">
        <h2 id="census-overlap" className={headingClass}>Wallets in more than one registry</h2>
        <p className={textClass}>
          {n(d.crossRegistry.one[1])} wallets are recorded in one registry, {n(d.crossRegistry.two[1])} in two (holding {n(d.crossRegistry.two[2])} entries) and {n(d.crossRegistry.three[1])} in all three (holding {n(d.crossRegistry.three[2])} entries). A wallet recorded in two registries is a recorded fact. It does not say that one person runs both.
        </p>
      </section>

      <section aria-labelledby="census-limits">
        <h2 id="census-limits" className={headingClass}>What this does not show</h2>
        <ul className={listClass}>
          <li>It is not a count of people. A platform can register many agents under one wallet, and one person can use many wallets.</li>
          <li>It does not say whether an agent runs. Nothing was asked of any address.</li>
          <li>Only SAID accounts record a registration date. The other two registries are counted as they stood on the date above.</li>
          <li>The directory records no link for Metaplex entries, so its link figures are not recorded. That is not the same as none.</li>
          <li>A shared link, host name, wallet or name is a recorded fact. It does not say that one person is behind the entries, or that anything is wrong.</li>
          <li>Names, links and counters are written by the registrants or by the registries. We have not verified them.</li>
          <li>It is one moment. The registries are read again every hour, and the figures move with them.</li>
        </ul>
      </section>

      <section aria-labelledby="census-next">
        <h2 id="census-next" className={headingClass}>What happens next</h2>
        <p className={textClass}>
          This census is a snapshot. It will be redone and dated again. When Nooscape reads a registration link to find a name, it does so as Nooscape-Checker, and what it asks for, how gently, and how to keep it out of a site is on the{" "}
          <Link href="/checker" className={linkClass}>Nooscape-Checker page</Link>.
        </p>
      </section>
    </InfoPage>
  );
}
