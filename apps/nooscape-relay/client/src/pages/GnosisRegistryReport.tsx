import { CHAIN, DERIVED as d, MEASURED, PASS_TIME, PUBLIC, REGISTRY, RULES, THRESHOLDS, formatPercent as pc } from "@/lib/gnosisRegistryReport";
import { InfoPage, headingClass, listClass, textClass } from "@/components/InfoPage";
import { CensusToday } from "@/components/CensusToday";

/**
 * A dated census of the ERC-8004 identity registry on Gnosis as the directory holds it. It is a report, not a directory: it lists no
 * agent, ranks nothing, names no host or wallet and gives no score. Every number on it comes from lib/gnosisRegistryReport.ts, and
 * pages/gnosisRegistryReport.test.ts fails if one does not.
 *
 * Gnosis's registry is small and lopsided: one host name holds most of it, one wallet made every registration stored for that host,
 * there are two days with a registration and months with none. Where a sentence is written for that (one wallet, one host past the
 * cap, one transfer, two days), the test pins the fact the words rest on.
 */
const n = (value: number) => value.toLocaleString("en-US");
/** A list of words as part of a sentence: "a", "a and b", "a, b and c". */
const and = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const cellClass = "border-b border-white/[.08] py-2.5 pr-4 align-top";
const numberClass = "border-b border-white/[.08] py-2.5 pr-4 text-right align-top font-mono tabular-nums text-ns-ink";
const headClass = "border-b border-white/[.16] py-2 pr-4 text-right font-medium";
const firstHeadClass = "border-b border-white/[.16] py-2 pr-4 font-medium";
const tableClass = "w-full border-collapse text-left text-base leading-7 text-ns-ink-dim";

/** What the first table counts, in the order it shows them. */
const SURFACE: ReadonlyArray<readonly [label: string, count: number]> = [
  ["Registrations the directory counts on the chain", REGISTRY.onChain],
  ["Registrations the directory has stored", REGISTRY.registrations],
  ["Registrations counted past a host's cap and not stored", REGISTRY.overflow],
  ["Registrations the directory lists", REGISTRY.listed],
  ["Registering wallets", REGISTRY.wallets],
  ["Registrations with an https link", REGISTRY.withHttpsHost],
  ["Host names of those links", REGISTRY.hosts],
  ["Different profile links", REGISTRY.profileLinks],
];

/** What the listing rules did, in the order the table shows it. A registration whose name is only a number is not listed, and is not held out as shared. */
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

export default function GnosisRegistryReport() {
  return (
    <InfoPage title="Gnosis registry census, 2026-11-06" eyebrow="Field report" heading="Gnosis registry census">
      <dl className="mt-4 grid max-w-prose grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-sm text-ns-ink-dim">
        <dt>Date</dt>
        <dd className="text-ns-ink">{MEASURED.date}</dd>
        <dt>Counted from</dt>
        <dd className="text-ns-ink">the registry pass that finished at {PASS_TIME}</dd>
      </dl>
      <CensusToday chain="gnosis" measuredOn={MEASURED.date} figures={SURFACE} />

      <section aria-labelledby="census-method">
        <h2 id="census-method" className={headingClass}>How it was done</h2>
        <p className={textClass}>
          This census counts every registration the directory has stored for the ERC-8004 identity registry on Gnosis (chain id {CHAIN.id}), whether the directory lists it or holds it out. The directory is filled by a pass that reads the registry event log. A registration the directory holds out is not called fake: the listing rules hold it out because it shares a profile link, a host name or a wallet with many others, or because it has no usable profile link or a name that is only a number.
        </p>
        <p className={textClass}>
          The counts come from read-only queries that return only counts and size buckets. They were run once, after the pass named above. Gnosis is read by a scheduled pass once a day. Query 0 shows the last pass that succeeded, and when the queries were run that was a pass started by hand, because the first scheduled pass had not finished. No name, wallet address, host name or profile link was selected, and nothing was asked of any site or address for this census. A share is given to one decimal place.
        </p>
        <p className={textClass}>
          The directory counts {n(REGISTRY.onChain)} registrations on the chain and has stored {n(REGISTRY.registrations)} of them. A host name that holds more than {n(CHAIN.hostRowCap)} registrations keeps its first {n(CHAIN.hostRowCap)}, in the order they were made on the chain, and the rest are counted and not stored: {n(REGISTRY.overflow)} registrations, for {n(d.hosts.pastTheCap)} host name. Every figure below counts the stored registrations, so those {n(REGISTRY.overflow)} are in none of them.
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
        <p className={textClass}>
          No registration is hidden, so the public count of listed entries, {n(PUBLIC.listed)}, is the same as the {n(REGISTRY.listed)} in the table. The public count of registrations on the chain, {n(PUBLIC.onChain)}, is the {n(REGISTRY.registrations)} stored plus the {n(REGISTRY.overflow)} counted and not stored.
        </p>
      </section>

      <section aria-labelledby="census-listing">
        <h2 id="census-listing" className={headingClass}>What the listing rules did</h2>
        <p className={textClass}>
          Of the {n(REGISTRY.registrations)} stored registrations, {n(d.listing.listed)} ({pc(d.listing.listedPercent)}) are listed in the directory, which is {pc(d.listing.listedOfChainPercent)} of the {n(REGISTRY.onChain)} the directory counts on the chain. {n(d.listing.noLink)} ({pc(d.listing.noLinkPercent)}) have no usable profile link. {n(d.listing.heldOut)} ({pc(d.listing.heldOutPercent)}) are held out as shared, not judged. {n(d.listing.numberOnly)} carries a name that is only a number, and is not listed.
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
          Each held-out registration is counted once, under the first rule that reached it, in the order the rules run: a profile link shared by two or more registrations, then a host name shared by {THRESHOLDS.largeHost} or more, then a wallet that registered {THRESHOLDS.tenWallet} or more. A rule that reaches a registration first is not the only one that would have. The profile link rule reached {n(d.listing.byLink)} registrations first, {pc(d.listing.byLinkPercent)} of all of them, and the host name rule reached {n(d.listing.byHost)}, {pc(d.listing.byHostPercent)}. These are the rules written for the BNB Chain registry, and they have not been changed for Gnosis. This census says what they did here. It does not say whether they are right for Gnosis.
        </p>
      </section>

      <section aria-labelledby="census-wallets">
        <h2 id="census-wallets" className={headingClass}>Where the registrations sit</h2>
        <p className={textClass}>
          {n(d.wallets.tenOrMore)} wallets each registered {THRESHOLDS.tenWallet} or more. Together they made {n(d.wallets.tenOrMoreRegistrations)} of the {n(REGISTRY.registrations)} registrations ({pc(d.wallets.tenOrMorePercent)}). Only one of them registered {THRESHOLDS.largeWallet} or more, and it made {n(d.wallets.largeRegistrations)} of the {n(REGISTRY.registrations)} ({pc(d.wallets.largePercent)}).
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
          The largest bucket, {d.wallets.topBucket}, holds that one wallet, and no other wallet made more than {n(d.wallets.nextLargest)}. All {n(d.largeWallets.registrations)} of its stored registrations are on one host name, and it gave each of them a profile link of its own.
        </p>
      </section>

      <section aria-labelledby="census-hosts">
        <h2 id="census-hosts" className={headingClass}>Host names</h2>
        <p className={textClass}>
          {n(d.hosts.withHttps)} of the {n(REGISTRY.registrations)} registrations ({pc(d.hosts.withHttpsPercent)}) have an https link, spread over {n(REGISTRY.hosts)} host names, all of them in the table below. One host name holds {n(d.hosts.largest)} of them ({pc(d.hosts.largestPercent)}), which is {pc(d.hosts.largestOfAllPercent)} of all the registrations. The next holds {n(d.hosts.second)} ({pc(d.hosts.secondPercent)}) and the one after holds {n(d.hosts.third)}. The two largest together hold {n(d.hosts.twoLargest)} ({pc(d.hosts.twoLargestPercent)}).
        </p>
        <p className={textClass}>
          The largest host name is at the {n(CHAIN.hostRowCap)} registrations a host may keep, and the one wallet in the largest bucket of the wallet table made all of them. The directory counted {n(d.hosts.overflowLargest)} more for it, with no wallet recorded, so it holds {n(d.hosts.largestHeld)} in all, {pc(d.hosts.largestHeldPercent)} of the {n(REGISTRY.onChain)} the directory counts on the chain. The {n(REGISTRY.overflow)} registrations counted and not stored are {pc(d.hosts.overflowPercent)} of the {n(REGISTRY.onChain)}, and none of them is listed.
        </p>
        <p className={textClass}>
          Only one host name holds {THRESHOLDS.largeHost} or more registrations. It holds {n(d.hosts.atLeastThresholdRegistrations)}, {pc(d.hosts.atLeastThresholdPercent)} of those with an https link and {pc(d.hosts.atLeastThresholdOfAllPercent)} of all of them.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Registrations stored for each host name, by size; no host is named</caption>
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
          {n(d.links.usedOnce)} of the {n(d.links.total)} different profile links ({pc(d.links.usedOncePercent)}) are used by one registration each. {n(d.links.shared)} are used by more than one, by {n(d.links.sharedRegistrations)} registrations in all ({pc(d.links.sharedRegistrationsPercent)}). No profile link is used by {THRESHOLDS.bigLink} or more registrations. The most any one link has is {n(d.links.largest)} ({pc(d.links.largestPercent)} of all the registrations).
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
          {n(d.names.placeholder)} of the {n(REGISTRY.registrations)} registrations ({pc(d.names.placeholderPercent)}) have no name of their own. They carry the placeholder the directory gives a registration that has none: the word Agent and its number. The other {n(d.names.named)} carry {n(d.names.distinct)} distinct names, and {n(d.names.sharing)} registrations ({pc(d.names.sharingPercent)}) share a name with at least one other. No name is shared by {THRESHOLDS.sharedName} or more, and the largest group is {n(d.names.largestGroup)}.
        </p>
        <p className={textClass}>
          A registry row takes a name only from registration data written into the chain event itself. The directory also reads a name for some listed entries from the file their registration link names. That name is written to the entry and not to the registry row, so it is not counted here.
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
          {n(d.activity.handouts)} hand-outs are recorded, on {n(d.activity.handedOut)} registrations ({pc(d.activity.handedOutPercent)}). A hand-out is a transfer sent from the wallet the registration was minted to, within about an hour of the mint ({n(CHAIN.handoutBlocks)} blocks on Gnosis). The other transfer came later than the first hour or from another wallet. A hand-out is a timing fact. It does not say why the registration was sent on or who received it.
        </p>
        <p className={textClass}>
          {n(d.activity.edits)} edits of a profile link are recorded, on {n(d.activity.edited)} registrations ({pc(d.activity.editedPercent)}).
        </p>
      </section>

      <section aria-labelledby="census-time">
        <h2 id="census-time" className={headingClass}>When the registrations were made</h2>
        <p className={textClass}>
          The date of a registration is worked out from its mint block and the time of a block that is known. A day and a month are dated through the same {n(CHAIN.stretches)} stretches of {n(CHAIN.stretchBlocks)} blocks, the last one shorter, from the registry's first block, {n(CHAIN.firstBlock)}, at {CHAIN.firstBlockTime} UTC, to the finalized block, {n(CHAIN.recentBlock)}, at {CHAIN.recentBlockTime} UTC. Each stretch has the time of its first block and the seconds a block took in it, read from the chain. A block on Gnosis takes about {CHAIN.blockSecondsLow} to {CHAIN.blockSecondsHigh} seconds, with a slot missed now and then. A date is within about {CHAIN.dateErrorMinutes} minutes of the real time at the worst and {CHAIN.dateMedianErrorMinutes} minutes at the median, checked against the block times in the logs of all {n(CHAIN.dateChecked)} registrations.
        </p>
        <p className={textClass}>
          {n(d.time.firstMonthRegistrations)} of the registrations ({pc(d.time.firstMonthPercent)}) were made in {d.time.firstMonth}, the registry's first month. Of the {n(d.time.wholeLaterMonths)} whole months after it, {n(d.time.laterMonths)} have a registration, between {n(d.time.laterLow)} and {n(d.time.laterHigh)} each and {n(d.time.laterMonthsRegistrations)} in all ({pc(d.time.laterMonthsPercent)}), and {n(d.time.monthsWithNoneCount)} have none: {and(d.time.monthsWithNone)}. {d.time.passMonth}, the month of the pass, has none so far.
        </p>
        <p className={textClass}>
          A host name past the cap keeps its first registrations in chain order, so the {n(REGISTRY.overflow)} registrations counted and not stored have no month and no day here. They were made after the {n(CHAIN.hostRowCap)} their host kept. The months and days below therefore show fewer registrations than the chain had: the months after the first look thinner here than they were on the chain, and the registry's own history is longer than this table shows.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Registrations in each UTC month that has one</caption>
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
          The table of days below shows the UTC days that have a registration among the {n(CHAIN.dayWindow)} days that end on {d.time.lastDay}, the day of the newest stored registration. {n(d.time.days)} days have one, {d.time.firstDay} and {d.time.lastDay}, with one registration each ({n(d.time.daysRegistrations)} in all, {pc(d.time.daysPercent)} of the registrations), and the other {n(d.time.daysWithNone)} days had none. The day of the pass named in the header is {d.time.passDay}, {n(d.time.daysBeforeThePass)} days after the day of the newest stored registration, and no stored registration is dated later.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Registrations in each UTC day that has one, among the {n(CHAIN.dayWindow)} days that end on {d.time.lastDay}</caption>
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
          Ratings are not measured here. The directory also reads the reputation registry for a count of ratings, which the Gnosis tab and the API show once it has read the registry's whole history. This census does not use it.
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
          <li>It counts the registrations the directory has stored, {n(REGISTRY.registrations)} of the {n(REGISTRY.onChain)} it counts on the chain. The other {n(REGISTRY.overflow)} were counted past a host's cap and are in no figure here but their count. It does not compare either count with a total from the registry itself.</li>
          <li>The stored registrations are not a sample of the chain. A host name past the cap keeps its first registrations in chain order, so the figures for hosts, wallets, links, months and days describe the stored rows and not all {n(REGISTRY.onChain)}. Most of the stored rows are the first {n(CHAIN.hostRowCap)} of one host name.</li>
          <li>The months and days are the most affected. The registrations counted and not stored were made after the {n(CHAIN.hostRowCap)} their host kept, so the registry's own history is longer than the table shows, and the months after the first look thinner here than they were on the chain.</li>
          <li>Names and links are written by the registrants. We have not verified them.</li>
          <li>A date is worked out from a block time, within the margins given above, and is not a clock the chain keeps for the registration.</li>
          <li>It is one moment. Gnosis is read by a scheduled pass once a day and the chain is still adding registrations, so the figures are as of the pass named in the header.</li>
        </ul>
      </section>

      <section aria-labelledby="census-next">
        <h2 id="census-next" className={headingClass}>What happens next</h2>
        <p className={textClass}>
          This census is a snapshot. It will be redone and dated again. Whether the listing rules should change for Gnosis is a decision for later, and nothing here changes them.
        </p>
      </section>
    </InfoPage>
  );
}
