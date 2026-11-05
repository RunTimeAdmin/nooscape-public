import { Link } from "wouter";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";
import { SUPPORT_EMAIL } from "@/lib/contacts";

const orderedListClass = "mt-3 max-w-prose list-decimal space-y-2 pl-5 text-base leading-7 text-ns-ink-dim";

/**
 * How an operator asks for Tier 3. The flow is the operator-run one in docs/domain-control-verification.md: Nooscape issues a
 * challenge, the operator of the domain publishes its token, Nooscape reads that one file. There is no form and no automatic
 * step on this page on purpose: every tier change stays operator-gated (docs/tier3-self-serve-options-2026-11-05.md, option A).
 * The numbers and the path below are held to the code by client/src/pages/domainControl.test.ts.
 */
export default function DomainControl() {
  return (
    <InfoPage title="Domain control" eyebrow="Evidence level" heading="Show that you run the domain your agent uses">
      <p className={textClass}>
        A reviewed record starts at Tier 2: an approved source observed the agent and Nooscape kept the evidence. Tier 3 adds one fact. The
        domain the record points to served a one-time file that Nooscape issued. It says the operator of that domain took part. It is
        not a score and not an endorsement.
      </p>

      <section aria-labelledby="domain-who">
        <h2 id="domain-who" className={headingClass}>Who can ask</h2>
        <p className={textClass}>
          The operator of the domain a reviewed record names, on a public HTTPS address with no port. Only reviewed records can reach Tier 3:
          an entry that is only listed has no tier. The tier scale is published on the <Link href="/developers" className={linkClass}>Developers page</Link>.
        </p>
      </section>

      <section aria-labelledby="domain-how">
        <h2 id="domain-how" className={headingClass}>How it works</h2>
        <ol className={orderedListClass}>
          <li>
            Write to <a href={`mailto:${SUPPORT_EMAIL}`} className={linkClass}>{SUPPORT_EMAIL}</a>. Send the address of the record&apos;s page and the
            domain it names, and say how you can show that you run it.
          </li>
          <li>
            We reply with a challenge: a one-time token and the exact address to publish it at. It is good for 48 hours.
          </li>
          <li>
            Publish the token as plain text at <code className="font-mono text-sm text-ns-ink">https://your-domain/.well-known/nooscape-domain-verification/&lt;challenge-id&gt;.txt</code>.
            The file holds the token and nothing else.
          </li>
          <li>
            Tell us it is up. We read that one file, once. If it matches, the record shows Tier 3.
          </li>
        </ol>
        <p className={textClass}>
          A person at Nooscape decides each request. We may ask how you can show that you run the domain, and we may say no.
        </p>
      </section>

      <section aria-labelledby="domain-read">
        <h2 id="domain-read" className={headingClass}>What we read</h2>
        <p className={textClass}>
          One HTTPS request to that address for each challenge and each recheck. We follow no redirect, send no cookie or credential,
          accept at most 4 KiB, and never call your agent or any of its tools.
        </p>
      </section>

      <section aria-labelledby="domain-lasts">
        <h2 id="domain-lasts" className={headingClass}>How long it lasts</h2>
        <p className={textClass}>
          Tier 3 lasts 90 days and is tied to the agent&apos;s public card as it was when you were verified. Nooscape rechecks the file to
          renew it. If the file is gone, or the card changes, the record goes back to Tier 2. You can take the file down at any time.
        </p>
      </section>

      <section aria-labelledby="domain-not">
        <h2 id="domain-not" className={headingClass}>What Tier 3 does not mean</h2>
        <ul className={listClass}>
          <li>It does not verify a legal entity, or that you may speak for an organization.</li>
          <li>It does not verify a publisher key. The publisher state stays unverified.</li>
          <li>It does not say that the service is safe or available, how it handles payments, or that it does what its card claims.</li>
        </ul>
      </section>

      <section aria-labelledby="domain-cost">
        <h2 id="domain-cost" className={headingClass}>What it costs</h2>
        <p className={textClass}>
          Nothing. We never take money to change a record or its level.
        </p>
      </section>
    </InfoPage>
  );
}
