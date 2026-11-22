import { CHAIN, DERIVED as d, MEASURED, PASS_TIME, PUBLIC, REGISTRY, RULES, THRESHOLDS, formatPercent as pc } from "@/lib/celoRegistryReport";
import { InfoPage, headingClass, listClass, textClass } from "@/components/InfoPage";
import { CensusToday } from "@/components/CensusToday";

/**
 * A dated census of the ERC-8004 identity registry on Celo as the directory holds it. It is a report, not a directory: it lists no
 * agent, ranks nothing, names no host or wallet and gives no score. Every number on it comes from lib/celoRegistryReport.ts, and
 * pages/celoRegistryReport.test.ts fails if one does not.
 *
 * Celo's registry is crowded and lopsided: two wallets made most of it, no host name is past the cap, most registrations had their
 * profile link edited after the mint, and the dates are exact because a block is one second. Where a sentence is written for that
 * (two wallets, six large wallets, no host past the cap, no month with none, the day of the pass the day of the newest registration),
 * the test pins the fact the words rest on.
 */
const n = (value: number) => value.toLocaleString("en-US");

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

export default function CeloRegistryReport() {
  return (
    <InfoPage title="Celo registry census, 2026-11-20" eyebrow="Field report" heading="Celo registry census">
      <dl className="mt-4 grid max-w-prose grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-sm text-ns-ink-dim">
        <dt>Date</dt>
        <dd className="text-ns-ink">{MEASURED.date}</dd>
        <dt>Counted from</dt>
        <dd className="text-ns-ink">the registry pass that finished at {PASS_TIME}</dd>
      </dl>
      <CensusToday chain="celo" measuredOn={MEASURED.date} figures={SURFACE} />

      <section aria-labelledby="census-method">
        <h2 id="census-method" className={headingClass}>How it was done</h2>
        <p className={textClass}>
          This census counts every registration the directory has stored for the ERC-8004 identity registry on Celo (chain id {CHAIN.id}), whether the directory lists it or holds it out. The directory is filled by a pass that reads the registry event log. A registration the directory holds out is not called fake: the listing rules hold it out because it shares a profile link, a host name or a wallet with many others, or because it has no usable profile link or a name that is only a number.
        </p>
        <p className={textClass}>
          The counts come from read-only queries that return only counts and size buckets. They were run once, after the pass named above, which was the first to read the registry's whole history and was started by hand. No name, wallet address, host name or profile link was selected, and nothing was asked of any site or address for this census. A share is given to one decimal place.
        </p>
        <p className={textClass}>
          The directory counts {n(REGISTRY.onChain)} registrations on the chain and has stored {n(REGISTRY.registrations)} of them. A host name that holds more than {n(CHAIN.hostRowCap)} registrations keeps its first {n(CHAIN.hostRowCap)}, in the order they were made on the chain, and the rest are counted and not stored. No host name on Celo is past that cap: {n(d.hosts.pastTheCap)} host names, {n(REGISTRY.overflow)} registrations counted and not stored. Every figure below counts all {n(REGISTRY.onChain)}.
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
          No registration is hidden, so the public count of listed entries, {n(PUBLIC.listed)}, is the same as the {n(REGISTRY.listed)} in the table. No registration was counted past a host's cap, so the public count of registrations on the chain, {n(PUBLIC.onChain)}, is the {n(REGISTRY.registrations)} stored.
        </p>
      </section>

      <section aria-labelledby="census-listing">
        <h2 id="census-listing" className={headingClass}>What the listing rules did</h2>
        <p className={textClass}>
          Of the {n(REGISTRY.registrations)} stored registrations, {n(d.listing.listed)} ({pc(d.listing.listedPercent)}) are listed in the directory. {n(d.listing.noLink)} ({pc(d.listing.noLinkPercent)}) have no usable profile link. {n(d.listing.heldOut)} ({pc(d.listing.heldOutPercent)}) are held out as shared, not judged. No registration carries a name that is only a number.
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
          Each held-out registration is counted once, under the first rule that reached it, in the order the rules run: a profile link shared by two or more registrations, then a host name shared by {THRESHOLDS.largeHost} or more, then a wallet that registered {THRESHOLDS.tenWallet} or more. A rule that reaches a registration first is not the only one that would have. The profile link rule reached {n(d.listing.byLink)} registrations first ({pc(d.listing.byLinkPercent)} of all of them), the host name rule reached {n(d.listing.byHost)} ({pc(d.listing.byHostPercent)}), and the wallet rule reached {n(d.listing.byWallet)} ({pc(d.listing.byWalletPercent)}). These are the rules written for the BNB Chain registry, and they have not been changed for Celo. This census says what they did here. It does not say whether they are right for Celo.
        </p>
      </section>

      <section aria-labelledby="census-wallets">
        <h2 id="census-wallets" className={headingClass}>Where the registrations sit</h2>
        <p className={textClass}>
          {n(d.wallets.tenOrMore)} wallets each registered {THRESHOLDS.tenWallet} or more. Together they made {n(d.wallets.tenOrMoreRegistrations)} of the {n(REGISTRY.registrations)} registrations ({pc(d.wallets.tenOrMorePercent)}). {n(d.wallets.large)} of them registered {THRESHOLDS.largeWallet} or more, and made {n(d.wallets.largeRegistrations)} of the {n(REGISTRY.registrations)} ({pc(d.wallets.largePercent)}).
        </p>
        <p className={textClass}>
          The largest bucket, {d.wallets.topBucket}, holds two wallets, which between them made {n(d.wallets.topBucketRegistrations)} ({pc(d.wallets.topBucketPercent)}). The largest made {n(d.wallets.largest)} ({pc(d.wallets.largestPercent)}), and the other {n(d.wallets.topBucketRegistrations - d.wallets.largest)}. The other {n(d.wallets.midLargeWallets)} wallets that registered {THRESHOLDS.largeWallet} or more made {n(d.wallets.midLargeRegistrations)} between them, and no wallet outside that bucket made more than {n(d.wallets.nextLargest)}.
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
          Of the {n(d.wallets.large)} wallets that registered {THRESHOLDS.largeWallet} or more, {n(d.largeWallets.withoutAHost)} made no registration with an https link, and between them they made {n(d.largeWallets.withoutAHostRegistrations)}. {n(d.largeWallets.ownLinkEach)} of the {n(d.wallets.large)} gave every registration a profile link of its own. The large wallets made {n(d.largeWallets.withHttpsHost)} registrations with an https link between them, and {n(d.largeWallets.onTheirLargestHost)} of those are on the host name that is the largest for the wallet that made them.
        </p>
      </section>

      <section aria-labelledby="census-hosts">
        <h2 id="census-hosts" className={headingClass}>Host names</h2>
        <p className={textClass}>
          {n(d.hosts.withHttps)} of the {n(REGISTRY.registrations)} registrations ({pc(d.hosts.withHttpsPercent)}) have an https link, spread over {n(REGISTRY.hosts)} host names, the ten largest of them in the table below. One host name holds {n(d.hosts.largest)} of them ({pc(d.hosts.largestPercent)}), which is {pc(d.hosts.largestOfAllPercent)} of all the registrations. The next holds {n(d.hosts.second)} ({pc(d.hosts.secondPercent)}), the third {n(d.hosts.third)} and the fourth {n(d.hosts.fourth)}.
        </p>
        <p className={textClass}>
          {n(d.hosts.atLeastThreshold)} host names hold {THRESHOLDS.largeHost} or more registrations. They hold {n(d.hosts.atLeastThresholdRegistrations)} between them, {pc(d.hosts.atLeastThresholdPercent)} of those with an https link and {pc(d.hosts.atLeastThresholdOfAllPercent)} of all of them. No host name is past the {n(CHAIN.hostRowCap)} registrations a host may keep, so each of these figures is a host name's whole size.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Registrations stored for each of the ten largest host names, by size; no host is named</caption>
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
          {n(d.names.placeholder)} of the {n(REGISTRY.registrations)} registrations ({pc(d.names.placeholderPercent)}) have no name of their own. They carry the placeholder the directory gives a registration that has none: the word Agent and its number. The other {n(d.names.named)} carry {n(d.names.distinct)} distinct names, and {n(d.names.sharing)} registrations ({pc(d.names.sharingPercent)}) share a name with at least one other. One name is shared by {n(d.names.largestGroup)} registrations, and no other name is shared by {THRESHOLDS.sharedName} or more.
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
          {n(d.activity.handouts)} hand-outs are recorded, on {n(d.activity.handedOut)} registrations ({pc(d.activity.handedOutPercent)}). A hand-out is a transfer sent from the wallet the registration was minted to, within about an hour of the mint ({n(CHAIN.handoutBlocks)} blocks on Celo). The other {n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet. A hand-out is a timing fact. It does not say why the registration was sent on or who received it.
        </p>
        <p className={textClass}>
          {n(d.activity.edits)} edits of a profile link are recorded, on {n(d.activity.edited)} registrations ({pc(d.activity.editedPercent)}). Most registrations on Celo had their profile link edited after the mint.
        </p>
      </section>

      <section aria-labelledby="census-time">
        <h2 id="census-time" className={headingClass}>When the registrations were made</h2>
        <p className={textClass}>
          The date of a registration is worked out from its mint block. Blocks on Celo are exactly {n(CHAIN.blockSeconds)} second apart, so the date is the time of the registry's first block, {n(CHAIN.firstBlock)}, at {CHAIN.firstBlockTime} UTC, plus the blocks since as seconds. The first block's time was read from a node. The rule was checked against the block times in the logs of {n(CHAIN.dateChecked)} distinct blocks, from block {n(CHAIN.checkedFirstBlock)} to block {n(CHAIN.checkedLastBlock)}, and no block's time differed from it by even a second, so a date is exact.
        </p>
        <p className={textClass}>
          {n(d.time.firstMonthRegistrations)} of the registrations ({pc(d.time.firstMonthPercent)}) were made in {d.time.firstMonth}, the registry's first month. The registry began on {CHAIN.firstBlockTime.slice(0, 10)}, so {d.time.firstMonth} is not a whole month of it. {d.time.busiestMonth} was the busiest month, with {n(d.time.busiestMonthRegistrations)} registrations ({pc(d.time.busiestMonthPercent)}). Of the {n(d.time.wholeLaterMonths)} whole months after the first, {n(d.time.laterMonths)} have a registration, between {n(d.time.laterLow)} and {n(d.time.laterHigh)} each and {n(d.time.laterMonthsRegistrations)} in all ({pc(d.time.laterMonthsPercent)}), and {n(d.time.monthsWithNoneCount)} have none. {d.time.passMonth}, the month of the pass, has {n(d.time.passMonthRegistrations)} so far.
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
          The table of days below shows the UTC days that have a registration among the {n(CHAIN.dayWindow)} days that end on {d.time.lastDay}, the day of the newest stored registration. {n(d.time.days)} days have one, between {n(d.time.dayLeast)} and {n(d.time.dayMost)} each and {n(d.time.daysRegistrations)} in all ({pc(d.time.daysPercent)} of the registrations), and the other {n(d.time.daysWithNone)} days had none. The day of the pass named in the header is {d.time.passDay}, the same day as the newest stored registration.
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
          Ratings are not measured here. The directory also reads the reputation registry for a count of ratings, which the Celo tab and the API show once it has read the registry's whole history. This census does not use it.
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
          <li>It counts the registrations the directory has stored, {n(REGISTRY.registrations)}, which are all {n(REGISTRY.onChain)} it counts on the chain. It does not compare that count with a total from the registry's own contract.</li>
          <li>An edit of a profile link is a recorded change and nothing more. The profile link a registration shows now can differ from the one it was minted with, and the figures for links and host names are for the links as the directory last read them.</li>
          <li>Names and links are written by the registrants. We have not verified them.</li>
          <li>A date is worked out from the mint block and the chain's one-second blocks, and is not a clock the chain keeps for the registration.</li>
          <li>It is one moment. The chain is still adding registrations, so the figures are as of the pass named in the header.</li>
        </ul>
      </section>

      <section aria-labelledby="census-next">
        <h2 id="census-next" className={headingClass}>What happens next</h2>
        <p className={textClass}>
          This census is a snapshot. It will be redone and dated again. Whether the listing rules should change for Celo is a decision for later, and nothing here changes them.
        </p>
      </section>
    </InfoPage>
  );
}
