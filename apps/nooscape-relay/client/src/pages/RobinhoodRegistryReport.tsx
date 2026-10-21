import { Link } from "wouter";
import { DERIVED as d, MEASURED, PASS_TIME, REGISTRY, THRESHOLDS, formatPercent as pc } from "@/lib/robinhoodRegistryReport";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";

/**
 * A dated census of the ERC-8004 identity registry on Robinhood Chain as the directory holds it. It is a report, not a directory:
 * it lists no agent, ranks nothing, names no host or wallet and gives no score. Every number on it comes from
 * lib/robinhoodRegistryReport.ts, and pages/robinhoodRegistryReport.test.ts fails if one does not.
 */
const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;

const cellClass = "border-b border-white/[.08] py-2.5 pr-4 align-top";
const numberClass = "border-b border-white/[.08] py-2.5 pr-4 text-right align-top font-mono tabular-nums text-ns-ink";
const headClass = "border-b border-white/[.16] py-2 pr-4 text-right font-medium";
const firstHeadClass = "border-b border-white/[.16] py-2 pr-4 font-medium";
const tableClass = "w-full border-collapse text-left text-base leading-7 text-ns-ink-dim";

/** What the first table counts, in the order it shows them. */
const SURFACE: ReadonlyArray<readonly [label: string, count: number]> = [
  ["Entries the directory shows", REGISTRY.entries],
  ["Registering wallets", REGISTRY.wallets],
  ["Entries with an https link", REGISTRY.withHttpsHost],
  ["Host names of those links", REGISTRY.hosts],
];

/** The size buckets of the per-entry table, in the order they grow. A bucket the query did not return holds no entries. */
const PER_ENTRY = ["0", "1", "2-4", "5+"] as const;
const perEntry = (what: "transfers" | "edits", bucket: string) => MEASURED.q6b.find(row => row[0] === what && row[1] === bucket)?.[2] ?? 0;
const ratingRows = (side: "agents" | "wallets") => MEASURED.q9.filter(row => row[0] === side);

export default function RobinhoodRegistryReport() {
  return (
    <InfoPage title="Robinhood Chain registry census, 2026-10-20" eyebrow="Field report" heading="Robinhood Chain registry census">
      <dl className="mt-4 grid max-w-prose grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-sm text-ns-ink-dim">
        <dt>Date</dt>
        <dd className="text-ns-ink">{MEASURED.date}</dd>
        <dt>Counted from</dt>
        <dd className="text-ns-ink">the registry pass that finished at {PASS_TIME}</dd>
      </dl>

      <section aria-labelledby="census-method">
        <h2 id="census-method" className={headingClass}>How it was done</h2>
        <p className={textClass}>
          This census counts what the directory holds for the ERC-8004 identity registry on Robinhood Chain. The directory is filled by passes that read the registry&rsquo;s event log, and we counted the entries it shows publicly. An entry that is hidden, whose asset the chain has closed, or whose source is not active is not counted.
        </p>
        <p className={textClass}>
          The counts come from read-only queries that return only counts and size buckets. They were run once, between the pass named above and the next one. No name, wallet address or host name was selected, and no link or address was asked of any site for this census. A share is given to one decimal place.
        </p>
      </section>

      <section aria-labelledby="census-registry">
        <h2 id="census-registry" className={headingClass}>The registry</h2>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Size and surface of the registry</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>What was counted</th>
                <th scope="col" className={headClass}>Count</th>
              </tr>
            </thead>
            <tbody>
              {SURFACE.map(([label, count]) => (
                <tr key={label}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{label}</th>
                  <td className={numberClass}>{n(count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          A wallet here is the registering wallet: the address named in the registration event. The directory does not change it when an entry is transferred, so it says who registered an entry and not who holds it now. A link is the registration link recorded on the chain, and a host name is the host of an https link. {n(d.hosts.withoutHost)} entries ({pc(d.hosts.withoutHostPercent)}) have no https host name recorded.
        </p>
      </section>

      <section aria-labelledby="census-wallets">
        <h2 id="census-wallets" className={headingClass}>Where the entries sit</h2>
        <p className={textClass}>
          {n(d.wallets.large)} wallets are each recorded against {THRESHOLDS.largeWallet} or more entries. Together they hold {n(d.wallets.largeEntries)} of the {n(REGISTRY.entries)} entries ({pc(d.wallets.largePercent)}), and the {n(d.wallets.tenOrMore)} wallets with ten or more hold {n(d.wallets.tenOrMoreEntries)} ({pc(d.wallets.tenOrMorePercent)}). The largest single wallet holds {n(d.wallets.largest)} ({pc(d.wallets.largestPercent)}).
        </p>
        <p className={textClass}>
          At the other end, {n(d.wallets.withOne)} of the {n(REGISTRY.wallets)} wallets ({pc(d.wallets.withOnePercent)}) hold one entry each. Together they hold {n(d.wallets.withOneEntries)} entries ({pc(d.wallets.withOneEntriesPercent)}).
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Entries held by one wallet, in size buckets</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>Entries held by one wallet</th>
                <th scope="col" className={headClass}>Wallets</th>
                <th scope="col" className={headClass}>Entries</th>
              </tr>
            </thead>
            <tbody>
              {MEASURED.q2.map(row => (
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
          The {n(d.wallets.large)} wallets with {THRESHOLDS.largeWallet} or more entries use few host names. {n(d.largeWallets.onOneHost)} of them have every entry on one host name. The other uses {n(d.largeWallets.severalHosts)} host names, and {n(d.largeWallets.severalOnLargest)} of its {n(d.largeWallets.severalWithHttps)} entries that have an https link are on the largest.
        </p>
        {d.largeWallets.largestWalletIsLargestHost && (
          <p className={textClass}>
            The largest wallet&rsquo;s {n(d.largeWallets.largestWalletEntries)} entries are all on one host name. That is the largest host name of all, and it holds no other wallet&rsquo;s entry.
          </p>
        )}
      </section>

      <section aria-labelledby="census-hosts">
        <h2 id="census-hosts" className={headingClass}>Host names</h2>
        <p className={textClass}>
          {n(d.hosts.withHttps)} of the {n(REGISTRY.entries)} entries ({pc(d.hosts.withHttpsPercent)}) have an https link, spread over {n(REGISTRY.hosts)} host names. One host name holds {n(d.hosts.largest)} of them ({pc(d.hosts.largestPercent)}), the next holds {n(d.hosts.second)}, and the two together hold {n(d.hosts.twoLargest)} ({pc(d.hosts.twoLargestPercent)}). {n(d.hosts.atLeastThreshold)} host names hold {THRESHOLDS.largeHost} or more entries each.
        </p>
      </section>

      <section aria-labelledby="census-names">
        <h2 id="census-names" className={headingClass}>Names</h2>
        <p className={textClass}>
          {n(d.names.placeholder)} of the {n(REGISTRY.entries)} entries ({pc(d.names.placeholderPercent)}) have no name of their own. They carry the placeholder the directory gives an entry that has none: the word Agent and the entry&rsquo;s number. The other {n(d.names.named)} carry {n(d.names.distinct)} distinct names, and {n(d.names.sharing)} entries ({pc(d.names.sharingPercent)}) share a name with at least one other. No name is shared by ten entries or more, and the largest group is {n(d.names.largestGroup)}.
        </p>
        <p className={textClass}>
          Nooscape finds the registration link of an entry by reading the registry, and then reads the file the link names, a few at a time. The placeholder count falls every day, so it is a snapshot of a figure that moves.
        </p>
        <p className={textClass}>
          A name is written by whoever registered the agent and has not been verified. Two entries with the same name are not necessarily the same agent or the same person.
        </p>
      </section>

      <section aria-labelledby="census-activity">
        <h2 id="census-activity" className={headingClass}>What the chain records for each entry</h2>
        <p className={textClass}>
          The directory reads the registry&rsquo;s event log for each entry: the mint, every transfer of the entry after it, and every edit of its registration link. It keeps a total for each entry, and all {n(d.activity.measured)} entries have been measured.
        </p>
        <p className={textClass}>
          {n(d.activity.transfers)} transfers after the mint are recorded, on {n(d.activity.changedHands)} entries ({pc(d.activity.changedHandsPercent)}). {n(d.activity.noTransfer)} entries ({pc(d.activity.noTransferPercent)}) have had none.
        </p>
        <p className={textClass}>
          {n(d.activity.handedOut)} entries ({pc(d.activity.handedOutPercent)}) were handed out, each once. A hand-out is a transfer sent from the wallet the entry was minted to, within about an hour of the mint. The other {n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet. A hand-out is a timing fact. It does not say why the entry was sent on or who received it.
        </p>
        <p className={textClass}>
          {n(d.activity.edits)} edits of a registration link are recorded, on {n(d.activity.edited)} entries ({pc(d.activity.editedPercent)}).
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Entries by how many transfers after the mint and how many link edits they have had</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>Per entry</th>
                <th scope="col" className={headClass}>Entries by transfers after the mint</th>
                <th scope="col" className={headClass}>Entries by link edits</th>
              </tr>
            </thead>
            <tbody>
              {PER_ENTRY.map(bucket => (
                <tr key={bucket}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{bucket}</th>
                  <td className={numberClass}>{n(perEntry("transfers", bucket))}</td>
                  <td className={numberClass}>{n(perEntry("edits", bucket))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="census-ratings">
        <h2 id="census-ratings" className={headingClass}>Ratings</h2>
        <p className={textClass}>
          The identity registry has a reputation registry beside it. A wallet writes a record to the reputation registry when it rates an agent and another when it takes a rating back, and the directory reads those records into a ledger. A rating here is a count of records. Nooscape does not weigh or endorse them, and this census does not read what any of them says.
        </p>
        <p className={textClass}>
          {n(d.ratings.written)} ratings were written, about {n(d.ratings.agentsRated)} agents, by {n(d.ratings.raters)} wallets. {n(d.ratings.revoked)} revocations were recorded, about {n(d.ratings.revokedAgents)} agents, by {plural(d.ratings.revokers, "wallet")}.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Agents by the ratings they hold</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>Ratings per agent</th>
                <th scope="col" className={headClass}>Agents</th>
                <th scope="col" className={headClass}>Ratings</th>
              </tr>
            </thead>
            <tbody>
              {ratingRows("agents").map(row => (
                <tr key={row[1]}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{row[1]}</th>
                  <td className={numberClass}>{n(row[2])}</td>
                  <td className={numberClass}>{n(row[3])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Wallets by the ratings they wrote</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>Ratings written per wallet</th>
                <th scope="col" className={headClass}>Wallets</th>
                <th scope="col" className={headClass}>Ratings</th>
              </tr>
            </thead>
            <tbody>
              {ratingRows("wallets").map(row => (
                <tr key={row[1]}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{row[1]}</th>
                  <td className={numberClass}>{n(row[2])}</td>
                  <td className={numberClass}>{n(row[3])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          The {n(d.ratings.biggestRaters)} wallets in the largest bucket wrote {n(d.ratings.biggestRatersRatings)} of the {n(d.ratings.written)} ratings ({pc(d.ratings.biggestRatersPercent)}), and the largest wrote {n(d.ratings.largestRater)} ({pc(d.ratings.largestRaterPercent)}). No agent holds more than {n(d.ratings.mostPerAgent)} ratings.
        </p>
      </section>

      <section aria-labelledby="census-limits">
        <h2 id="census-limits" className={headingClass}>What this does not show</h2>
        <ul className={listClass}>
          <li>It is not a count of people. A platform can register many agents under one wallet, and one person can use many wallets.</li>
          <li>The registering wallet says who registered an entry and not who holds it. Most entries were handed out to another wallet soon after they were minted.</li>
          <li>It does not say whether an agent runs. Nothing was asked of any address.</li>
          <li>A hand-out is a timing fact. It does not say why an entry was sent on or who received it.</li>
          <li>A shared link, host name, wallet or name is a recorded fact. It does not say that one person is behind the entries, or that anything is wrong.</li>
          <li>It counts the registrations the directory holds. It does not compare that count with a total from the registry itself.</li>
          <li>The ratings are every rating event the directory has recorded, including a rating of an entry the directory does not show. The rating figure on the home page counts only ratings of the entries it shows, so the two can differ.</li>
          <li>Names, links and ratings are written by the registrants or by the wallets that used the registry. We have not verified them.</li>
          <li>It is one moment. The registry is read again about every half hour, and the figures move with it.</li>
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
