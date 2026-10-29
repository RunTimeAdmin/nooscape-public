import { Link } from "wouter";
import { arcClaimsOn, baseClaimsOn, ethereumClaimsOn } from "@shared/features";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";
import { REPLY_WITHIN, SECURITY_EMAIL, TRUST_EMAIL } from "@/lib/contacts";

/** Arc's claims are on in this build: the page says so in one more sentence, and its date is the day that sentence was written. Base's and Ethereum's are each one more, the same way. */
const ARC_CLAIMS = arcClaimsOn(import.meta.env.VITE_FEATURES);
const BASE_CLAIMS = baseClaimsOn(import.meta.env.VITE_FEATURES);
const ETHEREUM_CLAIMS = ethereumClaimsOn(import.meta.env.VITE_FEATURES);

/**
 * What Nooscape stores about the people who visit it, and what it publishes about wallets. Every claim on it was read off the
 * running site or the code, and client/src/pages/legalPages.test.ts holds the ones the code can break: the cookies, what the
 * browser keeps, the analytics script, the fonts and the log line. If one of those changes, that test fails and says to change
 * this page in the same commit. What the operator supplied (who is responsible, the 30 days or more that logs are kept, the age of 18)
 * is not something the code can show, so the same test pins those facts as given.
 */
export default function Privacy() {
  return (
    <InfoPage title="Privacy" eyebrow="What we keep" heading="Privacy" changed={BASE_CLAIMS || ETHEREUM_CLAIMS ? "28 October 2026" : ARC_CLAIMS ? "20 October 2026" : "19 October 2026"}>
      <p className={textClass}>
        This page says what Nooscape keeps about the people who visit it, and what it publishes about wallets and registries. It describes the site as it is on the date above, and it changes when the site does.
      </p>

      <section aria-labelledby="privacy-controller">
        <h2 id="privacy-controller" className={headingClass}>Who is responsible</h2>
        {/* TODO: runtimeadmin.com stands in for the entity for now. If there is a registered entity name, swap it in here and on the Terms page. */}
        <p className={textClass}>
          RunTimeAdmin (<a href="https://runtimeadmin.com" rel="noopener noreferrer" className={linkClass}>runtimeadmin.com</a>), based in Texas, USA, is responsible for the personal data described on this page. To reach us, write to <a href={`mailto:${SECURITY_EMAIL}`} className={linkClass}>{SECURITY_EMAIL}</a>.
        </p>
      </section>

      <section aria-labelledby="privacy-visit">
        <h2 id="privacy-visit" className={headingClass}>When you visit</h2>
        <ul className={listClass}>
          <li>There are no accounts. You do not need to sign in to read anything, and Nooscape does not ask you for a name or an email address, except to make an API key (see the section When you get an API key). The owner of an agent can choose to claim it by signing a message with their wallet (see the section When you claim an agent).</li>
          <li>What you type into the search box, and any evidence packet you paste into the verifier, is sent to our server to answer you. Nooscape does not store it.</li>
          <li>Cookies: Nooscape sets none for visitors. The content delivery network of our host sets one, named hcdn, for as long as your visit lasts. Nooscape does not read it.</li>
          <li>Your browser: if you switch the owl off or change the theme, that choice is saved in your browser&rsquo;s local storage. It stays on your device and is not sent to us. Nothing else is saved there.</li>
          <li>
            Visit counts: Nooscape uses Umami Cloud (cloud.umami.is). Its script runs on every page and sends your page views to Umami, which receives your address and browser details as any server does. <a href="https://umami.is/privacy" rel="noopener noreferrer" className={linkClass}>Umami&rsquo;s privacy policy</a> says what it keeps. Nooscape reads the totals Umami reports.
          </li>
          <li>Fonts: the two typefaces are served from nooscape.si itself, so loading them sends nothing to a third party.</li>
          <li>Logs: the servers that deliver Nooscape keep request logs, which hold your IP address and request details. We keep our copy for at least 30 days, for security and to prevent abuse, and delete it when we no longer need it for that. Our server also writes the address (for IPv6, its first 64 bits) and the name of the limit to its log when a visitor goes over a rate limit. Our host and its network keep their own request logs, under their own policies, which we do not control.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-publish">
        <h2 id="privacy-publish" className={headingClass}>What Nooscape publishes</h2>
        <ul className={listClass}>
          <li>Nooscape publishes what public registries and approved sources say about agents, including the wallet address that registered each one. A wallet address is public chain data, and so is every registry entry.</li>
          <li>Nooscape adds nothing about who owns a wallet. Where several agents were registered by one wallet it says so, and says that a fleet means identities registered by one wallet and nothing more.</li>
          <li>Names, descriptions and links in a record are what the registrant wrote or, for a claimed agent, what its owner wrote.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-claim">
        <h2 id="privacy-claim" className={headingClass}>When you claim an agent</h2>
        <ul className={listClass}>
          <li>Claiming is optional. The owner of an agent on the Robinhood Chain or BNB Smart Chain registry can claim it by signing one message with their wallet. The signature proves that you control the wallet. It sends no transaction, costs no gas and gives Nooscape no access to your funds.{ARC_CLAIMS && " The owner of an agent on the Arc registry can claim it in the same way."}{BASE_CLAIMS && " The owner of an agent on the Base registry can claim it in the same way."}{ETHEREUM_CLAIMS && " The owner of an agent on the Ethereum registry can claim it in the same way."}</li>
          <li>For a claim, Nooscape keeps the agent, your wallet address, the time of the claim, whether the claim is active, on hold or ended, a digest of your signature (not the signature), what you write (a name, a website, a description and up to five links), and a history of each change with the wallet that signed it and the time. The history is only added to.</li>
          <li>The one-time request that your wallet signs is kept too: your wallet address, the agent, a hash of the one-time code, the times, and the text of the edit it is for. It is kept for at least two days after it expires, then deleted by a daily step.</li>
          <li>Nooscape does not ask for your name or email address, and keeps no network address as part of a claim. The rate-limit log described above applies to claiming as it does to the rest of the site.</li>
          <li>What you write is shown on the agent&rsquo;s page, labelled as the owner&rsquo;s own words, and is readable by anyone, including through Nooscape&rsquo;s API, from the moment you save it. While a claim is on hold none of it is shown. The fact that your wallet holds the claim, and the date the registry was last asked who owns the agent, are public too. A wallet address is public chain data.</li>
          <li>The history of changes is public: the date of each change, the field, the wallet that signed it and the start of a digest of its signature, with the old and new text. The newest 100 changes are shown. The history is only added to. If something in it is removed from view, the history shows that it was removed, not what it said. While a claim is on hold, the history shows that changes were made without their text.</li>
          <li>A claim ends if the registry shows that the agent has a new owner, and the history says so. What you wrote is then no longer shown as the owner&rsquo;s text, but the history of the claim, including what you wrote unless it was removed, stays. You can still ask for it to be removed from view.</li>
          <li>To have what you wrote removed from view, write to <a href={`mailto:${TRUST_EMAIL}`} className={linkClass}>{TRUST_EMAIL}</a>. A person replies within {REPLY_WITHIN}. Nooscape cannot change a chain or a registry, and the record that a claim was made stays.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-apikey">
        <h2 id="privacy-apikey" className={headingClass}>When you get an API key</h2>
        <ul className={listClass}>
          <li>An API key is optional. The public API works without one. To get a free key you give an email address on the <Link href="/developers/keys" className={linkClass}>API keys page</Link>. That is the only place Nooscape asks for an email address.</li>
          <li>For each key Nooscape keeps your email address (trimmed and in lower case), a hash of the key (not the key itself, which is shown once and cannot be shown again), the first ten characters of the key, its tier, the times it was made, last used and, if it was ended, ended, and a count of the requests the key made on each day (UTC) to each part of the API. No email is sent to confirm the address, and it is not checked.</li>
          <li>Nooscape keeps no network address and nothing you asked for with a key. The rate-limit log described above applies to requests with a key as it does to everything else, and a request with a key that is not valid counts against the address it came from.</li>
          <li>We use your email address only to write to you about the key, for example about a change to its limits or a paid tier you asked for. We do not sell it or use it for anything else.</li>
          <li>Ending a key stops it at once. The key&rsquo;s record, with your email address and its counts, stays so that its use can be accounted for, until you ask us to delete it. To ask, write to <a href={`mailto:${SECURITY_EMAIL}`} className={linkClass}>{SECURITY_EMAIL}</a>.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-pay">
        <h2 id="privacy-pay" className={headingClass}>When you pay for an API call</h2>
        <ul className={listClass}>
          <li>Paying is optional and is only for the API. Where pay per call is switched on, a call with no key can be paid for in USDC on the Arc network or, where the API offers it, on Base (see the <Link href="/developers" className={linkClass}>developer page</Link>). You pay by signing a transfer from your wallet to Nooscape&rsquo;s receiving address. Nooscape never holds your funds, and the signature lets one transfer of that amount to that address happen and nothing else.</li>
          <li>For each payment Nooscape keeps your wallet address, the amount, the one-time number your wallet chose for the transfer, when the authorization ends, which kind of call it was for with a hash of the request it was sent with, the transaction that settled it, how the payment stands (settled, refused or not yet confirmed, with the payment service&rsquo;s short reason), how many times it was sent for settlement and answered, and the times. Nooscape does not keep the signature, does not ask for a name or an email address, and keeps no network address as part of a payment.</li>
          <li>Payments are settled by a facilitator service: Circle&rsquo;s x402 facilitator service for a payment on Arc, and Coinbase&rsquo;s CDP facilitator for a payment on Base. Our server sends it the signed transfer, which holds your wallet address, the amount and your signature, so that it can submit the transfer. Circle&rsquo;s and Coinbase&rsquo;s own terms and privacy policies say what each keeps. Coinbase also lists our API in its public catalogue of paid endpoints (the Bazaar), which shows how many payments and how many different payers the API had. A settled transfer is public chain data: anyone can see your wallet address, the amount and the transaction, and Nooscape cannot delete it.</li>
          <li>For a payment from a smart-contract wallet, our server also asks a blockchain node provider whether the wallet&rsquo;s own code accepts the signature. That call carries the wallet&rsquo;s address and the details of the transfer, all of which is public chain data, and the provider&rsquo;s own policy says what it keeps.</li>
          <li>Before a new payment is sent to the payment service, our server may also ask a blockchain node provider how much USDC the paying wallet holds, so that a wallet with too little is turned away without being sent on. That call carries only the wallet&rsquo;s address and the token&rsquo;s address, which are public chain data, and the provider&rsquo;s own policy says what it keeps.</li>
          <li>The rate-limit log described above applies to a call with a payment as it does to the rest of the API.</li>
          <li>We keep the record of a payment for as long as we need it to account for payments and to deal with one that went wrong. To ask about a payment, write to <a href={`mailto:${SECURITY_EMAIL}`} className={linkClass}>{SECURITY_EMAIL}</a> and quote the payment id the API gave you.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-webhook">
        <h2 id="privacy-webhook" className={headingClass}>When you set a webhook</h2>
        <ul className={listClass}>
          <li>Watchlists and webhooks are optional and are for Builder and Pro keys. For a key that has them, Nooscape keeps the listings it watches (and whether each was last in the public view), the https address you gave and how many deliveries to it failed in a row, and, for each event written for the key, a copy of the message sent, its type, the listing it is about, how many tries were made, the HTTP status the address answered with, a short word for why a try failed, and the times. The address is stored as you typed it, so do not put anything private in it.</li>
          <li>The signing secret is not stored. It is worked out from a secret of ours, the key&rsquo;s id and a version number, and it is shown to the key. Removing the webhook erases its address and keeps the version number, so that a secret you rotated away does not come back.</li>
          <li>Nooscape sends each event from its server to the address you gave. Whoever runs that address sees the message and our server&rsquo;s network address. A message holds facts the public API already shows: a listing, the kind of change, dates, and wallet addresses and transaction ids that are public chain data. It holds nothing about you.</li>
          <li>Delivered and given-up events are deleted after 30 days. The watchlist and the address stay until you remove them, or ask us to delete them by writing to <a href={`mailto:${SECURITY_EMAIL}`} className={linkClass}>{SECURITY_EMAIL}</a>. Ending a key stops its deliveries at once.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-basis">
        <h2 id="privacy-basis" className={headingClass}>Why we may use this data</h2>
        <p className={textClass}>
          Where the EU or UK GDPR applies to you, we rely on legitimate interests: running and securing the site and preventing abuse. For a claim or an API key, we rely on performing the service that the owner or the key holder asked for.
        </p>
      </section>

      <section aria-labelledby="privacy-rights">
        <h2 id="privacy-rights" className={headingClass}>Your rights</h2>
        <p className={textClass}>
          You may ask for access to the personal data we hold about you, ask for it to be corrected or deleted, and object to how we use it. You may also complain to the supervisory authority where you live. To use any of these rights, write to <a href={`mailto:${SECURITY_EMAIL}`} className={linkClass}>{SECURITY_EMAIL}</a>.
        </p>
        <p className={textClass}>
          Public on-chain data, and what a registry shows, cannot be deleted by us.
        </p>
      </section>

      <section aria-labelledby="privacy-children">
        <h2 id="privacy-children" className={headingClass}>Children</h2>
        <p className={textClass}>
          Nooscape is not for anyone under 18, and we do not knowingly collect personal data from anyone under 18.
        </p>
      </section>

      <section aria-labelledby="privacy-ask">
        <h2 id="privacy-ask" className={headingClass}>Questions and requests</h2>
        <p className={textClass}>
          Privacy questions and requests about a record or an address go to <a href={`mailto:${TRUST_EMAIL}`} className={linkClass}>{TRUST_EMAIL}</a>, the same address as disputes. A person replies within {REPLY_WITHIN}.
        </p>
        <p className={textClass}>
          Nooscape cannot change a chain or a registry. It can tell you what it shows about an address, and it will tell you what it can and cannot remove from Nooscape. See also <Link href="/disputes" className={linkClass}>Disputes</Link>.
        </p>
      </section>

      <section aria-labelledby="privacy-changes">
        <h2 id="privacy-changes" className={headingClass}>Changes to this page</h2>
        <p className={textClass}>
          We update this page when what we keep changes. The date at the top says when it last changed.
        </p>
      </section>
    </InfoPage>
  );
}
