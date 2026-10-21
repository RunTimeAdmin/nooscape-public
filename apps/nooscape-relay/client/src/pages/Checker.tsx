import { useEffect } from "react";
import { Link } from "wouter";

/**
 * The page the Nooscape-Checker user agent names (server/safeFetch.ts). It is for the people who run the sites the checker
 * asks: what is asking, what it asks for, how gently, and how to make it stop. Every number on it is held to the constant
 * that enforces it by server/checkerPage.test.ts, and the opt-out it shows is run through the real robots.txt reader.
 *
 * It has no read of its own, no form and no script, so there is nothing on it to fail while the server is busy.
 */
const USER_AGENT = "Nooscape-Checker/1.0 (+https://nooscape.si/checker)";
const ROBOTS_RULE = "User-agent: Nooscape-Checker\nDisallow: /";
const ROBOTS_NARROW_RULE = "User-agent: Nooscape-Checker\nDisallow: /private/";

const linkClass = "text-ns-radar underline underline-offset-4 hover:text-ns-ink";
const headingClass = "mt-12 text-xl font-medium tracking-[-.03em] text-[#F2FFF5]";
const textClass = "mt-3 max-w-prose text-base leading-7 text-ns-ink-dim";
const listClass = "mt-3 max-w-prose list-disc space-y-2 pl-5 text-base leading-7 text-ns-ink-dim";
const codeClass = "mt-3 max-w-full overflow-x-auto whitespace-pre-wrap rounded-xl border border-white/[.08] bg-black/30 p-4 font-mono text-sm leading-6 text-ns-ink [overflow-wrap:anywhere]";

export default function Checker() {
  useEffect(() => {
    const before = document.title;
    document.title = "Nooscape-Checker | Nooscape";
    return () => {
      document.title = before;
    };
  }, []);

  return (
    <main className="relative min-h-screen bg-ns-void text-ns-ink">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/" className="inline-flex min-h-11 items-center gap-3 text-sm font-semibold uppercase tracking-[.29em] text-[#F1FFF3]">
          <img src="/favicon.svg" alt="" width="32" height="32" className="h-8 w-8 rounded-xl" />
          Nooscape
        </Link>
        <Link href="/" className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">
          Back to the Noosphere
        </Link>
      </header>

      <article className="mx-auto max-w-3xl px-5 pb-16 pt-6">
        <p className="eyebrow">For the people who run the sites it asks</p>
        <h1 className="mt-2 text-3xl font-medium tracking-[-.04em] text-[#F2FFF5] sm:text-4xl">Nooscape-Checker</h1>
        <p className={textClass}>
          If you found this name in your server logs: it is the user agent of Nooscape (nooscape.si), an open observatory of AI agents, read from on-chain registries and published agent cards. This page says what the checker asks for, how it behaves and how to make it stop.
        </p>
        <p role="note" className="mt-6 max-w-prose rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-sm leading-6 text-ns-ink-dim">
          Nooscape-Checker does three things. It checks whether an endpoint that the published card of a reviewed agent declares answers, at most once a day, and the agent&rsquo;s page shows the latest check with its date. It reads the registration link of an agent in the 8004 registry or the SAID registry on Solana, or of an agent in the ERC-8004 registry on Robinhood Chain, to find the agent&rsquo;s name. And it reads the registration file of a listed agent in the ERC-8004 registry on BNB Chain, to group registrations that look alike. In every case it reads your robots.txt first. It also ran once, on 16 October 2026, as a census of the BNB Chain registry, which asked more than it does regularly; that run is described below.
        </p>

        <section aria-labelledby="checker-agent">
          <h2 id="checker-agent" className={headingClass}>Its user agent</h2>
          <p className={textClass}>Every request it sends carries this header, and no other header that identifies it:</p>
          <pre className={codeClass}><code>User-Agent: {USER_AGENT}</code></pre>
        </section>

        <section aria-labelledby="checker-why">
          <h2 id="checker-why" className={headingClass}>Why it may ask your site</h2>
          <p className={textClass}>
            Agent cards are public files, and a card can name any web address as its endpoint. If the card of an agent in Nooscape&rsquo;s reviewed records names an endpoint on your site, Nooscape may check that the address answers. That does not mean you run an agent or that you did anything: the address was written by whoever published the card.
          </p>
          <p className={textClass}>
            The 8004 and SAID registries on Solana and the ERC-8004 registry on Robinhood Chain are public too, and so is the ERC-8004 registry on BNB Chain. Anyone can write any web address, or an ipfs address, into a registration. If a registration points at a file on your site, Nooscape may read that file to find the agent&rsquo;s name, or, for BNB Chain, to compare it with other registrations. An ipfs address is asked of an IPFS gateway and not of your site. That does not mean you run an agent or that you did anything: the address was written by whoever made the registration.
          </p>
        </section>

        <section aria-labelledby="checker-asks">
          <h2 id="checker-asks" className={headingClass}>What it asks for</h2>
          <ul className={listClass}>
            <li>For a check: one endpoint address that the card of a reviewed agent declares, and where it redirects to if it does.</li>
            <li>For a name: one registration link that a registration in the 8004 registry or the SAID registry on Solana, or a registration in the ERC-8004 registry on Robinhood Chain, names (an https address, or an ipfs address that it asks an IPFS gateway for), and where it redirects to if it does. It reads the file to find its name field. For a registration on Robinhood Chain it first finds the link by reading the registry on the chain, which asks nothing of your site. A registration in the SAID registry records its link on the chain too, and Nooscape reads it from there. Most of those links name a small card (about 300 bytes) on SAID&rsquo;s own host, api.saidprotocol.com.</li>
            <li>For a BNB Chain registration: one registration link that a listed registration in the ERC-8004 registry on BNB Chain names (an https address, or an ipfs address that it asks an IPFS gateway for), and where it redirects to if it does. It reads the whole file, up to 256 KiB, to find its name, its description and the host of its first agent address. It first finds the link by reading the registry on the chain, which asks nothing of your site, and it asks for none of the agent addresses the file lists.</li>
            <li>Apart from your /robots.txt and those addresses, nothing else on your site is asked for.</li>
            <li>GET or HEAD over https on port 443, and nothing else. It does not log in, submit forms, run scripts or follow links in what it reads.</li>
            <li>Your /robots.txt first, before anything else on the site.</li>
          </ul>
        </section>

        <section aria-labelledby="checker-gently">
          <h2 id="checker-gently" className={headingClass}>How gently</h2>
          <ul className={listClass}>
            <li>It asks each endpoint address at most once a day, and reads robots.txt each time it visits a site.</li>
            <li>It reads a registration link until it finds a name (for a BNB Chain registration, until it has read the file) and then stops, and it stops after a few tries: five at most if the link does not answer, two if the file has no name in it or is not a registration.</li>
            <li>At most one request a second to a host name, and five requests at a time in all.</li>
            <li>Each of the two registration reads, the Robinhood names and the BNB Chain files, reads at most sixteen registration files in one run, at most six of them from one host name, and runs at most every thirty minutes.</li>
            <li>The SAID names read at most twenty cards in one run and run at most every thirty minutes. Nearly all of the cards are on one host, so up to twenty of a run can come from one host name, at one request a second.</li>
            <li>It gives up on a request after 5 seconds, counting the name lookup, the connection, redirects and the body.</li>
            <li>It reads the first 4 KiB of an endpoint&rsquo;s answer, up to 256 KiB of a registration file and 64 KiB for robots.txt, and then closes the connection.</li>
            <li>It follows at most 3 redirects, and checks each new address again: https only, a public address, and that host&rsquo;s own robots.txt.</li>
            <li>It asks for no compression and keeps no connection open afterwards.</li>
            <li>It sends no cookie and no credential, and it never connects to a private, loopback or link-local address, even when a name resolves to one.</li>
          </ul>
        </section>

        <section aria-labelledby="checker-records">
          <h2 id="checker-records" className={headingClass}>What it records</h2>
          <p className={textClass}>
            A check records a fact with its date: whether the address answered after any redirects, with which status code, and how long that took. When there was no answer, or a rule such as robots.txt stopped the ask, it records the reason. It also keeps a fingerprint of the first 4 KiB of the answer. The reason and the fingerprint are not shown. Nooscape shows the latest check on the agent&rsquo;s page, with its date.
          </p>
          <p className={textClass}>
            For a registration link it records whether it found a name, the name itself and the reason when a read failed. The name is the registrant&rsquo;s own claim: Nooscape uses it as the entry&rsquo;s name only when the registry gives none, and reading it does not change the entry&rsquo;s tier. For an agent on Robinhood Chain that is shown only as a number, Nooscape shows the name it read in place of the number on the agent&rsquo;s page, on the map and in the directory, says on the agent&rsquo;s page when it read it, and the signed evidence of a reviewed record is not changed.
          </p>
          <p className={textClass}>
            For a BNB Chain registration file it records whether it could be read as a registration and, when it could, a short key made from the registration&rsquo;s name, description and first agent-address host, with the host itself and the date. The file is not kept and none of it is shown. Registrations with one key are counted together as a group of look-alike registrations, and the map can draw one of the ten largest groups as a single circle with its count, never as an agent. Reading a file does not change an entry&rsquo;s tier, whether it is listed, its order or its place on the map.
          </p>
          <p className={textClass}>
            A check never changes an agent&rsquo;s tier, whether it is listed, its order or its place on the map. A check that fails says nothing by itself: the page shows it as a fact with its date, never as a verdict. It says an address is failing only when the last three asks in a row got no answer, and that says nothing about why. A 404 or a 405 to a plain GET is shown as that: Nooscape sends only GET or HEAD, so it does not know whether the address takes POST.
          </p>
        </section>

        <section aria-labelledby="checker-census">
          <h2 id="checker-census" className={headingClass}>The census of 16 October 2026</h2>
          <p className={textClass}>
            On 16 October 2026 Nooscape ran Nooscape-Checker once over the BNB Chain registry of ERC-8004 registrations, to count what the registry holds. It was a one-off, dated run, and it asked more than the regular BNB Chain read does: it also asked the agent addresses that a file lists, which the regular read never does. If you found the user agent in your logs on that day between 18:02 and 18:18 UTC, this is probably where it came from.
          </p>
          <p className={textClass}>
            The BNB Chain registry is public too, and anyone can write any web address, or an ipfs address, into a registration. That does not mean you run an agent or that you did anything: the address was written by whoever made the registration.
          </p>
          <ul className={listClass}>
            <li>Registration files: when a registration names an https address, it asked that address for the file, up to twice that day. When it names an ipfs address, it asked an IPFS gateway (ipfs.filebase.io) and not your site. A registration can also hold its file inside itself, which needs no request.</li>
            <li>Agent addresses: for a registration whose file was complete, it sent one plain GET to each of the first two https agent addresses the file lists. If the file declares an A2A service, it also read the agent card that address returned.</li>
            <li>Limits: it read up to 256 KiB of a registration file and up to 64 KiB of the answer from an agent address. That is more than the 4 KiB of the regular checks, so that an agent card could be read whole. The other limits above held: your robots.txt first, GET over https on port 443, at most one request a second to a host name and five at a time, 5 seconds a request, and at most 3 redirects.</li>
            <li>Apart from your robots.txt and the addresses above, nothing else on your site was asked for.</li>
          </ul>
          <p className={textClass}>
            It recorded whether each address answered, with which status and how long it took, and whether each registration file could be read and held a name, a description and an https agent address. The results are not shown against any entry, and they changed no entry&rsquo;s tier, whether it is listed, its order or its place on the map. The counts are in the <Link href="/field/bnb-registry-2026-10-16" className={linkClass}>census report</Link>. A request that got no answer says nothing by itself about the agent. To keep it out, use the robots.txt rule below.
          </p>
        </section>

        <section aria-labelledby="checker-stop">
          <h2 id="checker-stop" className={headingClass}>How to make it stop</h2>
          <p className={textClass}>Put this in your robots.txt (https://your-site/robots.txt):</p>
          <pre className={codeClass}><code>{ROBOTS_RULE}</code></pre>
          <p className={textClass}>
            Nooscape-Checker reads that file before it asks for anything else on the site, and obeys a group for Nooscape-Checker or Nooscape, and the group for * when there is none. A narrower rule works too. This one keeps it out of one path only:
          </p>
          <pre className={codeClass}><code>{ROBOTS_NARROW_RULE}</code></pre>
          <p className={textClass}>
            If robots.txt cannot be read (a server error, a 429, a timeout, or a file over 64 KiB) it asks nothing of that site until it can. A missing robots.txt (a 404, for example) means no restriction. A change is picked up the next time it would ask your site. When robots.txt keeps it out, it records that, and the agent&rsquo;s page stops showing the earlier check. A registration link on a site that keeps it out is not read. Crawl-delay is not read; it already waits at least a second between requests to a site.
          </p>
        </section>

        <section aria-labelledby="checker-contact">
          <h2 id="checker-contact" className={headingClass}>Questions or problems</h2>
          <p className={textClass}>
            Write to <a href="mailto:support@nooscape.si" className={linkClass}>support@nooscape.si</a>, or to <a href="https://x.com/Nooscape" rel="noopener noreferrer" className={linkClass}>@Nooscape on X</a>. If a request from Nooscape-Checker caused you a problem, say which site and roughly when.
          </p>
        </section>

        <footer className="mt-12 border-t border-white/[.08] pt-6">
          <p className="text-sm text-ns-ink-dim">
            <Link href="/about" className={`${linkClass} inline-flex min-h-6 items-center`}>What Nooscape is and is not</Link>
          </p>
        </footer>
      </article>
    </main>
  );
}
