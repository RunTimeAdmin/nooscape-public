import { CHAIN, DERIVED as d, MEASURED, PASS_TIME, REGISTRY, RULES, THRESHOLDS, formatPercent as pc } from "@/lib/arcRegistryReport";
import { InfoPage, headingClass, listClass, textClass } from "@/components/InfoPage";

/**
 * A dated census of the ERC-8004 identity registry on Arc as the directory holds it. It is a report, not a directory: it lists no
 * agent, ranks nothing, names no host or wallet and gives no score. Every number on it comes from lib/arcRegistryReport.ts, and
 * pages/arcRegistryReport.test.ts fails if one does not.
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
];

export default function ArcRegistryReport() {
  return (
    <InfoPage title="Arc registry census, 2026-10-20" eyebrow="Field report" heading="Arc registry census">
      <dl className="mt-4 grid max-w-prose grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-sm text-ns-ink-dim">
        <dt>Date</dt>
        <dd className="text-ns-ink">{MEASURED.date}</dd>
        <dt>Counted from</dt>
        <dd className="text-ns-ink">the registry pass that finished at {PASS_TIME}</dd>
      </dl>

      <section aria-labelledby="census-method">
        <h2 id="census-method" className={headingClass}>How it was done</h2>
        <p className={textClass}>
          This census counts every registration the directory has stored for the ERC-8004 identity registry on Arc (chain id {CHAIN.id}), whether the directory lists it or holds it out. The directory is filled by a pass that reads the registry event log. A registration the directory holds out is not called fake: the listing rules hold it out because it shares a profile link, a host name or a wallet with many others, or because it has no usable profile link.
        </p>
        <p className={textClass}>
          The counts come from read-only queries that return only counts and size buckets. They were run once, after the pass named above. Arc is read only when a pass is started by hand, and query 0 shows the last one that succeeded. No name, wallet address, host name or profile link was selected, and nothing was asked of any site or address for this census. A share is given to one decimal place.
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
          Of the {n(REGISTRY.registrations)} registrations, {n(d.listing.listed)} ({pc(d.listing.listedPercent)}) are listed in the directory. {n(d.listing.noLink)} ({pc(d.listing.noLinkPercent)}) have no usable profile link. The other {n(d.listing.heldOut)} ({pc(d.listing.heldOutPercent)}) are held out as shared, not judged.
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
          Each held-out registration is counted once, under the first rule that reached it, in the order the rules run: a profile link shared by two or more registrations, then a host name shared by {THRESHOLDS.largeHost} or more, then a wallet that registered {THRESHOLDS.tenWallet} or more. A rule that reaches a registration first is not the only one that would have. These are the rules written for the BNB Chain registry, and they have not been changed for Arc. This census says what they did here. It does not say whether they are right for Arc.
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
          Of the {n(d.largeWallets.count)} wallets that registered {THRESHOLDS.largeWallet} or more, {n(d.largeWallets.onOneHost)} have every registration on one host name, and {n(d.largeWallets.withoutAHost)} have no https host name for any registration. {n(d.largeWallets.ownLinkEach)} gave every registration a profile link of its own. The other {n(d.largeWallets.oneLinkForAll)} used one profile link for every registration they made.
        </p>
        {d.largeWallets.walletIsLargestHost && (
          <p className={textClass}>
            One wallet&rsquo;s {n(d.largeWallets.walletIsLargestHostRegistrations)} registrations are all on one host name. That is the largest host name of all, and it holds no other wallet&rsquo;s registration.
          </p>
        )}
        <p className={textClass}>
          The {n(d.largeWallets.oneLinkForAll)} wallets that used one profile link made {n(d.largeWallets.oneLinkRegistrations)} registrations between them. Only one profile link in the registry is shared by {THRESHOLDS.bigLink} or more registrations, and each of these wallets has {THRESHOLDS.bigLink} or more on one link, so all of their registrations are on that one link.
        </p>
      </section>

      <section aria-labelledby="census-hosts">
        <h2 id="census-hosts" className={headingClass}>Host names</h2>
        <p className={textClass}>
          {n(d.hosts.withHttps)} of the {n(REGISTRY.registrations)} registrations ({pc(d.hosts.withHttpsPercent)}) have an https link, spread over {n(REGISTRY.hosts)} host names. One host name holds {n(d.hosts.largest)} of them ({pc(d.hosts.largestPercent)}), the next holds {n(d.hosts.second)} and the one after holds {n(d.hosts.third)}. The two largest together hold {n(d.hosts.twoLargest)} ({pc(d.hosts.twoLargestPercent)}). {n(d.hosts.atLeastThreshold)} host names hold {THRESHOLDS.largeHost} or more registrations each.
        </p>
      </section>

      <section aria-labelledby="census-links">
        <h2 id="census-links" className={headingClass}>Profile links</h2>
        <p className={textClass}>
          {n(d.links.usedOnce)} of the {n(d.links.total)} different profile links ({pc(d.links.usedOncePercent)}) are used by one registration each. {n(d.links.shared)} are used by more than one, by {n(d.links.sharedRegistrations)} registrations in all. One link is used by {n(d.links.bigRegistrations)} registrations ({pc(d.links.bigPercent)}), and {n(d.links.bigWithHost)} of them have an https host name.
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
          {n(d.names.placeholder)} of the {n(REGISTRY.registrations)} registrations ({pc(d.names.placeholderPercent)}) have no name of their own. They carry the placeholder the directory gives a registration that has none: the word Agent and its number. The other {n(d.names.named)} carry {n(d.names.distinct)} distinct names, and {n(d.names.sharing)} registrations ({pc(d.names.sharingPercent)}) share a name with at least one other. No name is shared by ten registrations or more, and the largest group is {n(d.names.largestGroup)}.
        </p>
        <p className={textClass}>
          Nooscape reads a name only from registration data written into the chain event itself. It fetches no registration link for Arc, so the placeholder count changes only as new registrations are made.
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
          {n(d.activity.handedOut)} registrations ({pc(d.activity.handedOutPercent)}) were handed out, each once. A hand-out is a transfer sent from the wallet the registration was minted to, within about an hour of the mint ({n(CHAIN.handoutBlocks)} blocks on Arc). {d.activity.laterTransfers === 0 ? "Every transfer after a mint was a hand-out." : `The other ${n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet.`} A hand-out is a timing fact. It does not say why the registration was sent on or who received it.
        </p>
        <p className={textClass}>
          {n(d.activity.edits)} edits of a profile link are recorded, on {n(d.activity.edited)} registrations ({pc(d.activity.editedPercent)}).
        </p>
        <p className={textClass}>
          The registrations were made over {n(d.days.count)} chain-days, counted from the first registration. {n(d.days.twoBusiest)} of them ({pc(d.days.twoBusiestPercent)}) were made on two of those days, one with {n(d.days.busiest)} and one with {n(d.days.second)}. No other chain-day has more than {n(d.days.otherBusiest)}. A chain-day is {n(CHAIN.dayBlocks)} blocks, about a day at the block time of Arc. It is not a calendar day, and the dates are not stored.
        </p>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Chain-days by how many registrations were made in them</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className={firstHeadClass}>Registrations in one chain-day</th>
                <th scope="col" className={headClass}>Chain-days</th>
                <th scope="col" className={headClass}>Registrations</th>
              </tr>
            </thead>
            <tbody>
              {d.days.buckets.map(row => (
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

      <section aria-labelledby="census-ratings">
        <h2 id="census-ratings" className={headingClass}>Ratings</h2>
        <p className={textClass}>
          Ratings are not measured for Arc. Nooscape reads no reputation registry for it, so this census says nothing about ratings.
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
          <li>It is one moment. Arc is read only when a pass is started by hand, so the figures move only when one is.</li>
        </ul>
      </section>

      <section aria-labelledby="census-next">
        <h2 id="census-next" className={headingClass}>What happens next</h2>
        <p className={textClass}>
          This census is a snapshot. It will be redone and dated again. Whether the listing rules should change for Arc is a decision for later, and nothing here changes them.
        </p>
      </section>
    </InfoPage>
  );
}
