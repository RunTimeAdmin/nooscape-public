import { Link } from "wouter";
import { BNB_RATINGS_REPORT as report } from "@/lib/bnbRatingsReport";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";

/**
 * A dated read of the ratings on the BNB Chain ERC-8004 reputation registry as a whole. It is a report, not a directory: it
 * lists no agent, names no wallet and no host, ranks nothing and gives no score. Every number on it comes from
 * lib/bnbRatingsReport.ts, and pages/bnbRatingsReport.test.ts fails if one does not.
 */
const n = (value: { value: number } | number) => (typeof value === "number" ? value : value.value).toLocaleString("en-US");

const cellClass = "border-b border-white/[.08] py-2.5 pr-4 align-top";
const numberClass = "border-b border-white/[.08] py-2.5 pr-4 text-right align-top font-mono tabular-nums text-ns-ink";

export default function BnbRatingsReport() {
  const r = report;
  const rules = r.rules;
  return (
    <InfoPage title="BNB Chain rating census, 2026-10-16" eyebrow="Field report" heading="BNB Chain rating census">
      <dl className="mt-4 grid max-w-prose grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-sm text-ns-ink-dim">
        <dt>Date</dt>
        <dd className="text-ns-ink">{r.date}</dd>
        <dt>Finalized block</dt>
        <dd className="text-ns-ink">{n(r.finalizedBlock)}</dd>
      </dl>

      <section aria-labelledby="ratings-method">
        <h2 id="ratings-method" className={headingClass}>How it was done</h2>
        <p className={textClass}>
          We read every event of the public ERC-8004 reputation registry on BNB Chain, from its first rating up to the finalized block above. That is {n(r.events)} events: {n(r.ratingsSent)} ratings and {n(r.revocations)} revocation. A revocation removes one rating, so {n(r.ratingsStand)} ratings stand. {n(r.senders)} wallets sent a rating and {n(r.raters)} of them still have one that stands. The ratings are about {n(r.agentsRated)} different agents.
        </p>
        <p className={textClass}>
          This read used the chain and nothing else, passed over it once, and asked no agent and no website anything. No agent, wallet or host is named on this page.
        </p>
      </section>

      <section aria-labelledby="ratings-findings">
        <h2 id="ratings-findings" className={headingClass}>Four findings</h2>
        <p className={textClass}>
          {n(r.concentratedWallets)} wallets sent almost every rating. Each of them rated {n(rules.concentratedMinAgents)} or more different agents, from {n(r.concentratedAgentsFewest)} to {n(r.concentratedAgentsMost)} agents each, and together they sent {n(r.concentratedRatings)} of the {n(r.ratingsStand)} ratings that stand. The next busiest wallet rated {n(r.nextBusiestAgents)} agents. We call these the concentrated wallets.
        </p>
        <p className={textClass}>
          {n(r.ratedValueRatings)} ratings ({n(r.ratedValuePercent)}%) carry the value {n(r.ratedValue)}, and {n(r.ratedValueFromConcentrated)} of them were sent by the concentrated wallets. The value is whatever the sender chose. We do not read it as a measure of anything.
        </p>
        <p className={textClass}>
          No wallet rated an agent that it registered itself: {n(r.selfRatings)} of the {n(r.ratingsStand)} ratings. {n(r.sendersAlsoRegistered)} of the {n(r.senders)} wallets that sent a rating also registered at least one agent.
        </p>
        <p className={textClass}>
          The agents registered by one wallet received {n(r.largestOwnerPercent)}% of all the ratings.
        </p>
      </section>

      <section aria-labelledby="ratings-agents">
        <h2 id="ratings-agents" className={headingClass}>How many agents are rated by several wallets</h2>
        <div className="mt-4 max-w-prose overflow-x-auto">
          <table className="w-full border-collapse text-left text-base leading-7 text-ns-ink-dim">
            <caption className="sr-only">Agents at each step</caption>
            <thead>
              <tr className="text-sm text-ns-ink">
                <th scope="col" className="border-b border-white/[.16] py-2 pr-4 font-medium">Step</th>
                <th scope="col" className="border-b border-white/[.16] py-2 pr-4 text-right font-medium">Agents</th>
                <th scope="col" className="border-b border-white/[.16] py-2 font-medium">What it counts</th>
              </tr>
            </thead>
            <tbody>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>Rated</th><td className={numberClass}>{n(r.agentsRated)}</td><td className={cellClass}>Agents with a rating that stands.</td></tr>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>Rated by {n(rules.minWallets)} wallets or more</th><td className={numberClass}>{n(r.threeOrMoreWallets)}</td><td className={cellClass}>Counting every wallet that rated the agent.</td></tr>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>Not counting the concentrated wallets</th><td className={numberClass}>{n(r.threeOrMoreOutsideConcentrated)}</td><td className={cellClass}>Still rated by {n(rules.minWallets)} wallets or more once the concentrated wallets are left out.</td></tr>
              <tr><th scope="row" className={`${cellClass} font-normal text-ns-ink`}>After every rule below</th><td className={numberClass}>{n(r.afterEveryRule)}</td><td className={cellClass}>The same, leaving out the other wallets set aside below, and the agents whose registering wallet registered {n(rules.fleetWalletMin)} agents or more.</td></tr>
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          Of the {n(r.threeOrMoreWallets)} agents rated by {n(rules.minWallets)} wallets or more, {n(r.registeredByFewerThanFleetWallets)} were registered by a wallet that registered fewer than {n(rules.fleetWalletMin)} agents.
        </p>
        <p className={textClass}>
          The {n(r.afterEveryRule)} are not {n(r.afterEveryRule)} separate cases. {n(r.sharedSetAgents)} of them are consecutive agents that were rated by the same {n(r.sharedSetWallets)} wallets, so the {n(r.afterEveryRule)} come from {n(r.groupsOfRaters)} groups of raters. This page counts agents and does not merge those groups.
        </p>
      </section>

      <section aria-labelledby="ratings-rules">
        <h2 id="ratings-rules" className={headingClass}>How wallets were set aside</h2>
        <p className={textClass}>
          A wallet is counted once for an agent, under the first of these that applies. Each is a fact about wallets and their ratings. None looks at what an agent is called, what it says or what it costs.
        </p>
        <ul className={listClass}>
          <li>A concentrated wallet: it rated {n(rules.concentratedMinAgents)} or more different agents.</li>
          <li>A scripted batch: not concentrated, with at least {n(rules.uniformMinRatings)} ratings, {n(rules.uniformMinSharePercent)}% or more of them carrying one identical value.</li>
          <li>Tied to the agent&rsquo;s registering wallet: the registering wallet itself, a wallet that registered {n(rules.fleetWalletMin)} agents or more, or a wallet that registered an agent with the same profile link or the same host as the rated agent.</li>
        </ul>
      </section>

      <section aria-labelledby="ratings-limits">
        <h2 id="ratings-limits" className={headingClass}>What this does not show</h2>
        <ul className={listClass}>
          <li>It is not a verdict on any agent. Being rated by {n(rules.minWallets)} wallets or more outside the concentrated wallets says nothing about whether an agent works or is any good, and being rated by fewer says nothing either. No agent is listed here.</li>
          <li>It counts wallets, not people. One person with many wallets, each rating a few agents, is not found.</li>
          <li>The ties are approximations. Unrelated people can share a host, and a link between a rating wallet and an owner through funding or a shared contract is not read. Setting a wallet aside only lowers the count.</li>
          <li>The value of a rating is whatever the sender chose. We have not checked it and never use it as a measure of quality.</li>
          <li>The figures are a moment in time. When we read it, the registry was receiving a few ratings a day. A wallet that later rates many agents becomes concentrated, and the counts change with it.</li>
          <li>It covers the ratings on this one registry. Other places where agents are rated are not read.</li>
        </ul>
      </section>

      <section aria-labelledby="ratings-next">
        <h2 id="ratings-next" className={headingClass}>What happens next</h2>
        <p className={textClass}>
          This report is a snapshot of one date. The registry itself, and what it lists, is described in the{" "}
          <Link href="/field/bnb-registry-2026-10-16" className={linkClass}>BNB Chain registry census</Link>.
        </p>
      </section>
    </InfoPage>
  );
}
