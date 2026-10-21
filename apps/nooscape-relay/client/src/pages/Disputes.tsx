import { Link } from "wouter";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";
import { REPLY_WITHIN, SECURITY_EMAIL, TRUST_EMAIL } from "@/lib/contacts";

/**
 * How to say a record is wrong. The reply time is the one in lib/contacts.ts. What happens after the reply is limited to
 * what the operator can do today: withdraw a reviewed record, or retain a new observation of it.
 */
export default function Disputes() {
  return (
    <InfoPage title="Disputes" eyebrow="Corrections" heading="Think we got something wrong?">
      <p className={textClass}>
        Nooscape publishes records about registered agents and the wallets that registered them. A record says what a source published and that Nooscape retained it on a date. It does not say what anyone meant, and it is not a finding about a person. If a record is wrong, or you think it should not be shown, tell us.
      </p>

      <section aria-labelledby="disputes-how">
        <h2 id="disputes-how" className={headingClass}>How to tell us</h2>
        <p className={textClass}>
          Email <a href={`mailto:${TRUST_EMAIL}`} className={linkClass}>{TRUST_EMAIL}</a>. Send:
        </p>
        <ul className={listClass}>
          <li>The address of the record or page: the link in your browser.</li>
          <li>What is wrong.</li>
          <li>A source we can check: a public page, a registry entry or a transaction.</li>
        </ul>
      </section>

      <section aria-labelledby="disputes-next">
        <h2 id="disputes-next" className={headingClass}>What happens next</h2>
        <ul className={listClass}>
          <li>A person replies within {REPLY_WITHIN}. The reply says what we will check next.</li>
          <li>The reply does not promise a fix.</li>
          <li>If the source backs you and it is a reviewed record, we withdraw the record or retain a new observation of it. If the source does not back you, we tell you why.</li>
          <li>If it is about a fleet or a count, we check how it was worked out and tell you what we found.</li>
          <li>We never take money to change a record.</li>
        </ul>
      </section>

      <section aria-labelledby="disputes-other">
        <h2 id="disputes-other" className={headingClass}>Other questions</h2>
        <p className={textClass}>
          Privacy questions and requests go to the same address. See <Link href="/privacy" className={linkClass}>Privacy</Link>. A security problem with the site goes to <a href={`mailto:${SECURITY_EMAIL}`} className={linkClass}>{SECURITY_EMAIL}</a>, which is also published at <a href="/.well-known/security.txt" className={linkClass}>/.well-known/security.txt</a>.
        </p>
      </section>
    </InfoPage>
  );
}
