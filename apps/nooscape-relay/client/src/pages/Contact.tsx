import { Link } from "wouter";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";
import { REPLY_WITHIN, SECURITY_EMAIL, SUPPORT_EMAIL, TRUST_EMAIL } from "@/lib/contacts";

/** The three mailboxes and what each is for. The reply time is promised only where a person has agreed to keep it. */
export default function Contact() {
  return (
    <InfoPage title="Contact" eyebrow="Write to us" heading="Contact">
      <section aria-labelledby="contact-trust">
        <h2 id="contact-trust" className={headingClass}>A record is wrong, or a privacy question</h2>
        <p className={textClass}>
          <a href={`mailto:${TRUST_EMAIL}`} className={linkClass}>{TRUST_EMAIL}</a>. A person replies within {REPLY_WITHIN}. See <Link href="/disputes" className={linkClass}>Disputes</Link> and <Link href="/privacy" className={linkClass}>Privacy</Link>.
        </p>
      </section>

      <section aria-labelledby="contact-security">
        <h2 id="contact-security" className={headingClass}>A security problem</h2>
        <p className={textClass}>
          <a href={`mailto:${SECURITY_EMAIL}`} className={linkClass}>{SECURITY_EMAIL}</a>. It is also published at <a href="/.well-known/security.txt" className={linkClass}>/.well-known/security.txt</a>.
        </p>
      </section>

      <section aria-labelledby="contact-support">
        <h2 id="contact-support" className={headingClass}>Anything else</h2>
        <ul className={listClass}>
          <li>
            <a href={`mailto:${SUPPORT_EMAIL}`} className={linkClass}>{SUPPORT_EMAIL}</a>, for the API, the verifier and the <Link href="/checker" className={linkClass}>checker</Link>.
          </li>
          <li>
            <a href="https://x.com/Nooscape" rel="noopener noreferrer" className={linkClass}>@Nooscape on X</a>.
          </li>
        </ul>
      </section>
    </InfoPage>
  );
}
