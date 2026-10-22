import { Link } from "wouter";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";
import { REPLY_WITHIN, SECURITY_EMAIL, TRUST_EMAIL } from "@/lib/contacts";

/**
 * The plain terms of using the site. The first part is what the site already promises elsewhere (it holds no funds, sells no
 * placement and ranks nothing) and the rules for someone who claims an agent. The rest (who runs it, the age, acceptable use, the
 * warranty, the limit on liability, the indemnity, the governing law) was supplied by the operator, RunTimeAdmin, and is for a
 * lawyer to read before it merges. client/src/pages/legalPages.test.ts holds the facts the operator gave and the sentences the
 * code can break.
 */
export default function Terms() {
  return (
    <InfoPage title="Terms" eyebrow="Using Nooscape" heading="Terms" changed="19 October 2026">
      <section aria-labelledby="terms-who">
        <h2 id="terms-who" className={headingClass}>Who we are, and what you agree to</h2>
        {/* TODO: runtimeadmin.com stands in for the entity for now. If there is a registered entity name, swap it in here and in the liability section. */}
        <p className={textClass}>
          Nooscape is run by RunTimeAdmin, <a href="https://runtimeadmin.com" rel="noopener noreferrer" className={linkClass}>runtimeadmin.com</a> (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By using the site or its API you agree to these Terms. If you do not agree, do not use Nooscape.
        </p>
      </section>

      <section aria-labelledby="terms-age">
        <h2 id="terms-age" className={headingClass}>Who may use it</h2>
        <p className={textClass}>You must be 18 or older to use Nooscape.</p>
      </section>

      <section aria-labelledby="terms-is">
        <h2 id="terms-is" className={headingClass}>What Nooscape is</h2>
        <p className={textClass}>
          Nooscape is an open agent observatory. It reads records from approved sources, including public agent registries, and keeps a signed copy of what was observed. It labels each record by the level of evidence on record for it. A tier is a level of evidence, not a score, a ranking or an endorsement.
        </p>
        <p className={textClass}>
          You can read it, link to it and use its public API within the rate limits it applies.
        </p>
      </section>

      <section aria-labelledby="terms-not">
        <h2 id="terms-not" className={headingClass}>What it is not</h2>
        <ul className={listClass}>
          <li>Nooscape does not hold funds, sell placement or rank agents, and it does not certify them.</li>
          <li>Nooscape has issued no token or coin on any chain, and is not connected to any token that uses its name. Nothing on this site is an offer to sell a token or a place to buy one.</li>
          <li>Nooscape is information only. Nothing on it is financial, investment, legal or security advice.</li>
          <li>Being listed, or having an evidence level, is not an endorsement.</li>
          <li>Evidence means a source published something and Nooscape retained a signed copy. It does not mean the agent works, is safe or is what it says it is.</li>
          <li>A fleet means identities registered by one wallet, and nothing more.</li>
        </ul>
      </section>

      <section aria-labelledby="terms-use">
        <h2 id="terms-use" className={headingClass}>Acceptable use</h2>
        <p className={textClass}>You may not:</p>
        <ul className={listClass}>
          <li>scrape Nooscape or reach it by automated means beyond the published rate limits;</li>
          <li>try to get around a rate limit or any other limit or security measure, or to get into any part of the site that is not public (to report a security problem, see <Link href="/contact" className={linkClass}>Contact</Link>);</li>
          <li>make a false claim, or pretend to be the owner of an agent or anyone else;</li>
          <li>put unlawful, abusive or infringing content in a field that an owner can write.</li>
        </ul>
        <p className={textClass}>If you do, we may limit or block your access without notice.</p>
      </section>

      <section aria-labelledby="terms-claim">
        <h2 id="terms-claim" className={headingClass}>If you claim an agent</h2>
        <ul className={listClass}>
          <li>A claim is optional. It lets the owner of an agent in a public registry write a name, a website, a description and a few links that Nooscape may show beside what it observed.</li>
          <li>What you write is your own statement. Nooscape does not check it. It is not a review, a tier or an endorsement by Nooscape, and a claim does not change how an agent is listed, reviewed or tiered.</li>
          <li>Write only about your own agent. Do not impersonate a person, a company or another agent. Do not say or suggest that Nooscape or anyone else has verified, audited, certified, endorsed or approved it, or that it has passed a safety or security review. Do not suggest that you or the agent are connected with Nooscape beyond holding a claim. Do not link to anything harmful or deceptive.</li>
          <li>Signing is proof that you control a wallet and nothing else. It is not a transaction, and Nooscape never has access to your funds.</li>
          <li>Nooscape may put a claim on hold, remove what an owner wrote or end a claim, without advance notice, for example after a dispute or a report. A claim also ends when the registry shows a new owner.</li>
          <li>A claim that is on hold shows as on hold on the agent&rsquo;s page, and nothing the owner wrote is shown while it is. Nooscape collects no email address for a claim, so that page is where a hold is shown. To ask about a hold, a removal or the end of a claim, write to <a href={`mailto:${TRUST_EMAIL}`} className={linkClass}>{TRUST_EMAIL}</a>. A person replies within {REPLY_WITHIN}.</li>
          <li>What Nooscape keeps for a claim is on the <Link href="/privacy" className={linkClass}>Privacy</Link> page.</li>
        </ul>
      </section>

      <section aria-labelledby="terms-content">
        <h2 id="terms-content" className={headingClass}>Owner-written and third-party content</h2>
        <ul className={listClass}>
          <li>Names, descriptions, links and other text in a record are supplied by the registrant or the source. Text that the owner of a claimed agent writes is the owner&rsquo;s word. We show it as given and have not verified it.</li>
          <li>Links in a record or a claim lead to sites we do not run. We are not responsible for third-party sites or for their content.</li>
          <li>We may hide or remove content, including what an owner wrote, at any time. When text is removed from view, the public history says that it was removed and who asked (the owner or Nooscape), and never why.</li>
        </ul>
      </section>

      <section aria-labelledby="terms-wrong">
        <h2 id="terms-wrong" className={headingClass}>Records can be wrong or out of date</h2>
        <p className={textClass}>
          Records reflect public on-chain and registry data, and they can be wrong or out of date. Each record shows its source and the date it was observed. Check the source before you rely on a record. If a record is wrong, see <Link href="/disputes" className={linkClass}>Disputes</Link>.
        </p>
      </section>

      <section aria-labelledby="terms-data">
        <h2 id="terms-data" className={headingClass}>The data and the API</h2>
        <p className={textClass}>
          The records republish what public sources published, and those sources keep their own terms. We may change, limit or stop the API or any page at any time.
        </p>
        <ul className={listClass}>
          <li>An API key (see <Link href="/developers/keys" className={linkClass}>API keys</Link>) is for the person it was made for. Keep it private, do not share it or sell access to it, and do not make keys to get around a limit.</li>
          <li>You are responsible for what is done with your key. We may end a key, change what a tier allows or refuse to make a key, at any time and without notice. Paid tiers are agreed with us by email.</li>
          <li>A key changes how much you can ask. It does not change what Nooscape says about any agent, and nothing you pay buys a listing, a tier or an evidence level.</li>
          <li>A Builder or Pro key can watch listings and have events sent to one https address that you name (a webhook). Set only an address that you own or have permission to send to: you are responsible for it and for what you do with what is sent to it. We call it from our server, may refuse an address, and turn a webhook off after repeated failures. An event states what Nooscape recorded, with its date. It can arrive late, more than once or out of order, and it is not a promise that nothing else changed.</li>
          <li>Where pay per call is switched on, a call with no key can be paid for in USDC on the Arc network or, where the API offers it, on Base, at the price the API states when it asks. You pay by signing a transfer from your wallet to our receiving address, and a payment service submits it. A payment is for one request. It is charged only when the answer is delivered, so a request that fails costs nothing. Sending the same request again with the same payment is answered again without a second charge, and the payment cannot be used for a different request. A payment from a regular wallet is accepted. So is one from a deployed smart-contract wallet where the API says so (the wallets listed in its index): before anything is charged we ask a blockchain node whether the wallet&rsquo;s own code accepts the signature, and a wallet is held to one payment at a time. A payment from a wallet that is not deployed yet is not accepted.</li>
          <li>This version has no refunds. If a payment settled and you were not given the answer, write to <a href={`mailto:${SECURITY_EMAIL}`} className={linkClass}>{SECURITY_EMAIL}</a> and quote the payment id. We will look at what happened and tell you what we found.</li>
        </ul>
      </section>

      <section aria-labelledby="terms-sale">
        <h2 id="terms-sale" className={headingClass}>Not for sale</h2>
        <p className={textClass}>
          We do not sell placement, ranks, badges or changes to records. We never take money to change a record. Payment never changes a record, a score or an evidence level.
        </p>
      </section>

      <section aria-labelledby="terms-warranty">
        <h2 id="terms-warranty" className={headingClass}>No warranty</h2>
        <p className={textClass}>
          Nooscape is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, with no warranties of any kind, express or implied. That includes any warranty that it is accurate, complete, current, uninterrupted or fit for a purpose.
        </p>
      </section>

      <section aria-labelledby="terms-liability">
        <h2 id="terms-liability" className={headingClass}>Limits on our liability</h2>
        <p className={textClass}>
          To the extent the law allows, RunTimeAdmin is not liable for any indirect, incidental or consequential loss, or for any loss that comes from relying on Nooscape. That includes a decision to trade, to send a payment, or to deal with a wallet or an agent because of what a record showed or did not show.
        </p>
        <p className={textClass}>
          To the extent the law allows, our total liability to you for everything that arises from Nooscape is limited to US$100.
        </p>
        <p className={textClass}>Some places do not allow some of these limits. Where that is so, they apply as far as the law lets them.</p>
      </section>

      <section aria-labelledby="terms-indemnity">
        <h2 id="terms-indemnity" className={headingClass}>Your own use</h2>
        <p className={textClass}>
          You are responsible for your own use of Nooscape and for anything you submit to it. To the extent the law allows, you agree to cover the claims, losses and costs that your use or your content cause us.
        </p>
      </section>

      <section aria-labelledby="terms-changes">
        <h2 id="terms-changes" className={headingClass}>Changes to these Terms</h2>
        <p className={textClass}>
          We may update these Terms. When we do, the date at the top changes. If you keep using Nooscape after that, you accept the updated Terms.
        </p>
      </section>

      <section aria-labelledby="terms-law">
        <h2 id="terms-law" className={headingClass}>Governing law</h2>
        <p className={textClass}>
          These Terms are governed by the laws of the State of Texas, USA, without regard to its conflict-of-law rules. A dispute about these Terms or about Nooscape goes to the courts located in Texas, and you agree to those courts.
        </p>
      </section>

      <section aria-labelledby="terms-general">
        <h2 id="terms-general" className={headingClass}>The rest</h2>
        <ul className={listClass}>
          <li>If a part of these Terms cannot be enforced, the rest still applies.</li>
          <li>If we do not enforce a part of these Terms, we have not given it up.</li>
          <li>These Terms are the whole agreement between you and us about Nooscape.</li>
        </ul>
      </section>

      <section aria-labelledby="terms-ask">
        <h2 id="terms-ask" className={headingClass}>Questions and contact</h2>
        <p className={textClass}>
          Write to <a href={`mailto:${TRUST_EMAIL}`} className={linkClass}>{TRUST_EMAIL}</a>. For legal notices and takedown requests, write to <a href={`mailto:${SECURITY_EMAIL}`} className={linkClass}>{SECURITY_EMAIL}</a>. See also <Link href="/privacy" className={linkClass}>Privacy</Link> and <Link href="/contact" className={linkClass}>Contact</Link>.
        </p>
      </section>
    </InfoPage>
  );
}
