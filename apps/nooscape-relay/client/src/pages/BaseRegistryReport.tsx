import { CHAIN, DERIVED as d, MEASURED, PASS_TIME, REGISTRY, RULES, THRESHOLDS, formatPercent as pc } from "@/lib/baseRegistryReport";
import { InfoPage, headingClass, listClass, textClass } from "@/components/InfoPage";

/**
 * A dated census of the ERC-8004 identity registry on Base as the directory holds it. It is a report, not a directory: it lists no
 * agent, ranks nothing, names no host or wallet and gives no score. Every number on it comes from lib/baseRegistryReport.ts, and
 * pages/baseRegistryReport.test.ts fails if one does not.
 */
const n = (value: number) => value.toLocaleString("en-US");

const cellClass = "border-b border-white/[.08] py-2.5 pr-4 align-top";
const numberClass = "border-b border-white/[.08] py-2.5 pr-4 text-right align-top font-mono tabular-nums text-ns-ink";
const headClass = "border-b border-white/[.16] py-2 pr-4 text-right font-medium";
const firstHeadClass = "border-b border-white/[.16] py-2 pr-4 font-medium";
const tableClass = "w-full border-collapse text-left text-base leading-7 text-ns-ink-dim";

/** What the first table counts, in the order it shows them. */
const SURFACE: ReadonlyArray<readonly [label: string, count: number]> = [
  ["Registrations the directory has stored", REGISTRY.registrations],
  ["Registrations the directory lists", REGISTRY.listed],
  ["Registering wallets", REGISTRY.wallets],
  ["Registrations with an https link", REGISTRY.withHttpsHost],
  ["Host names of those links", REGISTRY.hosts],
  ["Different profile links", REGISTRY.profileLinks],
];

/** What the listing rules did, in the order the table shows it. */
const LISTING: ReadonlyArray<readonly [label: string, count: number]> = [
  ["Listed in the directory", d.listing.listed],
  ["No usable profile link", d.listing.noLink],
  [`Held out first: ${RULES.link}`, d.listing.byLink],
  [`Held out first: ${RULES.host}`, d.listing.byHost],
  [`Held out first: ${RULES.wallet}`, d.listing.byWallet],
  ["A name that is only a number", d.listing.numberOnly],
];

/** The words for the place of a host name among the ten largest. */
const PLACE = ["Largest", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"] as const;

export default function BaseRegistryReport() {
  return (
    <InfoPage title="Base registry census, 2026-10-21" eyebrow="Field report" heading="Base registry census">
      <dl className="mt-4 grid max-w-prose grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-sm text-ns-ink-dim">
        <dt>Date</dt>
        <dd className="text-ns-ink">{MEASURED.date}</dd>
        <dt>Counted from</dt>
        <dd className="text-ns-ink">the registry pass that finished at {PASS_TIME}</dd>
      </dl>

      <section aria-labelledby="census-method">
        <h2 id="census-method" className={headingClass}>How it was done</h2>
        <p className={textClass}>
          This census counts every registration the directory has stored for the ERC-8004 identity registry on Base (chain id {CHAIN.id}), whether the directory lists it or holds it out. The directory is filled by a pass that reads the registry event log. A registration the directory holds out is not called fake: the listing rules hold it out because it shares a profile link, a host name or a wallet with many others, or because it has no usable profile link.
        </p>
        <p className={textClass}>
          The counts come from read-only queries that return only counts and size buckets. They were run once, after the pass named above, the first to read the registry up to the finalized head of the chain. Base is read by a scheduled pass, and query 0 shows the last one that succeeded. No name, wallet address, host name or profile link was selected, and nothing was asked of any site or address for this census. A share is given to one decimal place.
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
          A wallet here is the registering wallet: the address named in the registration event. The directory does not change it when a registration is transferred, so it says who registered and not who holds it now. A profile link is the link recorded on the chain, and a host name is the host of an https link. {n(d.hosts.withoutHost)} registrations ({pc(d.hosts.withoutHostPercent)}) have no https host name recorded, and {n(REGISTRY.noUriSet)} set no profile link at all.
        </p>
      </section>

      <section aria-labelledby="census-listing">
        <h2 id="census-listing" className={headingClass}>What the listing rules did</h2>
        <p className={textClass}>
          Of the {n(REGISTRY.registrations)} registrations, {n(d.listing.listed)} ({pc(d.listing.listedPercent)}) are listed in the directory. {n(d.listing.noLink)} ({pc(d.listing.noLinkPercent)}) have no usable profile link. {n(d.listing.heldOut)} ({pc(d.listing.heldOutPercent)}) are held out as shared, not judged. {n(d.listing.numberOnly)} carry a name that is only a number, and are not listed.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Registrations by what the listing rules did with them</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>What happened</th>
                <th scope="col" className={headClass}>Registrations</th>
              </tr>
            </thead>
            <tbody>
              {LISTING.map(([label, count]) => (
                <tr key={label}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{label}</th>
                  <td className={numberClass}>{n(count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          Each held-out registration is counted once, under the first rule that reached it, in the order the rules run: a profile link shared by two or more registrations, then a host name shared by {THRESHOLDS.largeHost} or more, then a wallet that registered {THRESHOLDS.tenWallet} or more. A rule that reaches a registration first is not the only one that would have. The host name rule reached {n(d.listing.byHost)} registrations first, {pc(d.listing.byHostPercent)} of all of them. These are the rules written for the BNB Chain registry, and they have not been changed for Base. This census says what they did here. It does not say whether they are right for Base.
        </p>
      </section>

      <section aria-labelledby="census-wallets">
        <h2 id="census-wallets" className={headingClass}>Where the registrations sit</h2>
        <p className={textClass}>
          {n(d.wallets.tenOrMore)} wallets each registered {THRESHOLDS.tenWallet} or more. Together they made {n(d.wallets.tenOrMoreRegistrations)} of the {n(REGISTRY.registrations)} registrations ({pc(d.wallets.tenOrMorePercent)}), and the {n(d.wallets.large)} wallets that registered {THRESHOLDS.largeWallet} or more made {n(d.wallets.largeRegistrations)} ({pc(d.wallets.largePercent)}). The largest single wallet made {n(d.wallets.largest)} ({pc(d.wallets.largestPercent)}).
        </p>
        <p className={textClass}>
          At the other end, {n(d.wallets.withOne)} of the {n(REGISTRY.wallets)} wallets ({pc(d.wallets.withOnePercent)}) registered one each. Together they made {n(d.wallets.withOneRegistrations)} registrations ({pc(d.wallets.withOneRegistrationsPercent)}).
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Registrations made by one wallet, in size buckets</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>Registrations made by one wallet</th>
                <th scope="col" className={headClass}>Wallets</th>
                <th scope="col" className={headClass}>Registrations</th>
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
          The {n(d.wallets.thousandOrMore)} wallets in the largest bucket made {n(d.wallets.thousandOrMoreRegistrations)} registrations ({pc(d.wallets.thousandOrMorePercent)}).
        </p>
        <p className={textClass}>
          The {n(d.largeWallets.shown)} largest wallets made {n(d.largeWallets.registrations)} registrations between them ({pc(d.largeWallets.registrationsPercent)}). {n(d.largeWallets.onOneHost)} of them have every registration on one host name, and {n(d.largeWallets.withoutAHost)} have no https host name for any registration. {n(d.largeWallets.ownLinkEach)} gave every registration a profile link of its own. {n(d.largeWallets.oneLinkForAll)} used one profile link for every registration they made, {n(d.largeWallets.oneLinkRegistrations)} registrations between them. The other {n(d.largeWallets.between)} are in between.
        </p>
      </section>

      <section aria-labelledby="census-hosts">
        <h2 id="census-hosts" className={headingClass}>Host names</h2>
        <p className={textClass}>
          {n(d.hosts.withHttps)} of the {n(REGISTRY.registrations)} registrations ({pc(d.hosts.withHttpsPercent)}) have an https link, spread over {n(REGISTRY.hosts)} host names. One host name holds {n(d.hosts.largest)} of them ({pc(d.hosts.largestPercent)}), which is {pc(d.hosts.largestOfAllPercent)} of all the registrations. The next holds {n(d.hosts.second)} ({pc(d.hosts.secondPercent)}) and the one after holds {n(d.hosts.third)}. The two largest together hold {n(d.hosts.twoLargest)} ({pc(d.hosts.twoLargestPercent)}).
        </p>
        <p className={textClass}>
          {n(d.hosts.atLeastThreshold)} host names hold {THRESHOLDS.largeHost} or more registrations each. Together they hold {n(d.hosts.atLeastThresholdRegistrations)} registrations, {pc(d.hosts.atLeastThresholdPercent)} of those with an https link and {pc(d.hosts.atLeastThresholdOfAllPercent)} of all of them.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Registrations on each of the ten largest host names; no host is named</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>Host name, by size</th>
                <th scope="col" className={headClass}>Registrations</th>
              </tr>
            </thead>
            <tbody>
              {MEASURED.q4.map(row => (
                <tr key={row[0]}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{PLACE[row[0] - 1]}</th>
                  <td className={numberClass}>{n(row[1])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="census-links">
        <h2 id="census-links" className={headingClass}>Profile links</h2>
        <p className={textClass}>
          {n(d.links.usedOnce)} of the {n(d.links.total)} different profile links ({pc(d.links.usedOncePercent)}) are used by one registration each. {n(d.links.shared)} are used by more than one, by {n(d.links.sharedRegistrations)} registrations in all ({pc(d.links.sharedRegistrationsPercent)}). {n(d.links.big)} links are used by {THRESHOLDS.bigLink} or more registrations each, {n(d.links.bigRegistrations)} registrations in all ({pc(d.links.bigPercent)}). The largest is used by {n(d.links.largest)} ({pc(d.links.largestPercent)}), and all of them have an https host name.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Profile links by how many registrations use one</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>Registrations using one link</th>
                <th scope="col" className={headClass}>Links</th>
                <th scope="col" className={headClass}>Registrations</th>
              </tr>
            </thead>
            <tbody>
              {MEASURED.q5.map(row => (
                <tr key={row[0]}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{row[0]}</th>
                  <td className={numberClass}>{n(row[1])}</td>
                  <td className={numberClass}>{n(row[2])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="census-names">
        <h2 id="census-names" className={headingClass}>Names</h2>
        <p className={textClass}>
          {n(d.names.placeholder)} of the {n(REGISTRY.registrations)} registrations ({pc(d.names.placeholderPercent)}) have no name of their own. They carry the placeholder the directory gives a registration that has none: the word Agent and its number. The other {n(d.names.named)} carry {n(d.names.distinct)} distinct names, and {n(d.names.sharing)} registrations ({pc(d.names.sharingPercent)}) share a name with at least one other. {n(d.names.sharedByTenOrMore)} registrations are in names shared by {THRESHOLDS.sharedName} or more, and the largest group is {n(d.names.largestGroup)}.
        </p>
        <p className={textClass}>
          Nooscape reads a name only from registration data written into the chain event itself. It fetches no registration link for Base, so the placeholder count changes only as new registrations are made.
        </p>
        <p className={textClass}>
          A name is written by whoever registered the agent and has not been verified. Two registrations with the same name are not necessarily the same agent or the same person.
        </p>
      </section>

      <section aria-labelledby="census-activity">
        <h2 id="census-activity" className={headingClass}>What the chain records for each registration</h2>
        <p className={textClass}>
          The directory reads the registry event log for each registration: the mint, every transfer of it after the mint, and every edit of its profile link. It keeps a total for each, and all {n(d.activity.measured)} registrations have been measured.
        </p>
        <p className={textClass}>
          {n(d.activity.transfers)} transfers after the mint are recorded, on {n(d.activity.changedHands)} registrations ({pc(d.activity.changedHandsPercent)}). {n(d.activity.noTransfer)} registrations ({pc(d.activity.noTransferPercent)}) have had none.
        </p>
        <p className={textClass}>
          {n(d.activity.handouts)} hand-outs are recorded, on {n(d.activity.handedOut)} registrations ({pc(d.activity.handedOutPercent)}). A hand-out is a transfer sent from the wallet the registration was minted to, within about an hour of the mint ({n(CHAIN.handoutBlocks)} blocks on Base). The other {n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet. A hand-out is a timing fact. It does not say why the registration was sent on or who received it.
        </p>
        <p className={textClass}>
          {n(d.activity.edits)} edits of a profile link are recorded, on {n(d.activity.edited)} registrations ({pc(d.activity.editedPercent)}).
        </p>
      </section>

      <section aria-labelledby="census-time">
        <h2 id="census-time" className={headingClass}>When the registrations were made</h2>
        <p className={textClass}>
          The date of a registration is worked out from its mint block. The first block of the registry is {CHAIN.firstBlockTime} UTC, and a block on Base takes {CHAIN.blockSeconds} seconds. {n(d.time.busiestMonthRegistrations)} of the registrations ({pc(d.time.busiestMonthPercent)}) were made in {d.time.busiestMonth}, the month of this census, more than in all the {n(d.time.earlierMonths)} months before it together.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Registrations in each UTC month</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>UTC month</th>
                <th scope="col" className={headClass}>Registrations</th>
              </tr>
            </thead>
            <tbody>
              {MEASURED.q10b.map(row => (
                <tr key={row[0]}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{row[0]}</th>
                  <td className={numberClass}>{n(row[1])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          The table of days below starts at {d.time.firstDay}. In the {n(d.time.beforeDays)} days before {d.time.riseFrom}, a UTC day had between {n(d.time.beforeLow)} and {n(d.time.beforeHigh)} registrations, {n(d.time.beforeRegistrations)} in all. From {d.time.riseFrom} every day has had more than any day before it: {n(d.time.riseFromRegistrations)} on {d.time.riseFrom}, rising to {n(d.time.busiestDayRegistrations)} on {d.time.busiestDay}, which is {pc(d.time.busiestDayPercent)} of all the registrations in one UTC day. The {n(d.time.sinceDays)} days from {d.time.riseFrom} to {d.time.lastDay} hold {n(d.time.sinceRegistrations)} registrations ({pc(d.time.sincePercent)}). {d.time.lastDay} is part of a day: the pass ran at {PASS_TIME}, and it has {n(d.time.lastDayRegistrations)}.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Registrations in each of the last {d.time.days} UTC days</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>UTC day</th>
                <th scope="col" className={headClass}>Registrations</th>
              </tr>
            </thead>
            <tbody>
              {MEASURED.q10a.map(row => (
                <tr key={row[0]}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{row[0]}</th>
                  <td className={numberClass}>{n(row[1])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="census-ratings">
        <h2 id="census-ratings" className={headingClass}>Ratings</h2>
        <p className={textClass}>
          Ratings are not measured for Base. Nooscape reads no reputation registry for it, so this census says nothing about ratings.
        </p>
      </section>

      <section aria-labelledby="census-limits">
        <h2 id="census-limits" className={headingClass}>What this does not show</h2>
        <ul className={listClass}>
          <li>It is not a count of people. A platform can register many agents under one wallet, and one person can use many wallets.</li>
          <li>The registering wallet says who registered a registration and not who holds it. {n(d.activity.handedOut)} registrations were handed out within about an hour of the mint, so for those the wallet is not the holder.</li>
          <li>It does not say whether an agent runs. Nothing was asked of any address.</li>
          <li>A hand-out is a timing fact. It does not say why a registration was sent on or who received it.</li>
          <li>A shared link, host name, wallet or name is a recorded fact. It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.</li>
          <li>It counts the registrations the directory holds. It does not compare that count with a total from the registry itself.</li>
          <li>Names and links are written by the registrants. We have not verified them.</li>
          <li>It is one moment. Base is read by a scheduled pass and the chain is still adding registrations, so the figures are as of the pass named in the header.</li>
        </ul>
      </section>

      <section aria-labelledby="census-next">
        <h2 id="census-next" className={headingClass}>What happens next</h2>
        <p className={textClass}>
          This census is a snapshot. It will be redone and dated again. Whether the listing rules should change for Base is a decision for later, and nothing here changes them.
        </p>
      </section>
    </InfoPage>
  );
}
