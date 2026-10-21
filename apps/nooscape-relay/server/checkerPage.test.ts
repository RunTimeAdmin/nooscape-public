import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_INTERVAL_MS, CHECKABLE_SOURCE_PROTOCOLS, PUBLIC_CHECKS_FAILING_AFTER } from "./agentChecks";
import { isClientRoutePath } from "./clientRoutes";
import { REGISTRATION_FETCH_MAX_BYTES, RESOLUTION_FAILED_MAX_ATTEMPTS, RESOLUTION_NO_NAME_MAX_ATTEMPTS } from "./ingestion/registrationFetch";
import { POLITE_DEFAULT_GAP_MS, POLITE_MAX_CONCURRENCY } from "./politeFetch";
import { FILES_INTERVAL_MS, FILES_MAX_PER_HOST, FILES_MAX_PER_RUN } from "./bscRegistrationFiles";
import { NAMES_INTERVAL_MS, NAMES_MAX_PER_HOST, NAMES_MAX_PER_RUN } from "./robinhoodNames";
import { SAID_NAMES_INTERVAL_MS, SAID_NAMES_MAX_PER_HOST, SAID_NAMES_MAX_PER_RUN } from "./saidNames";
import { parseRobots, robotsAllows, ROBOTS_MAX_BYTES } from "./robots";
import { CHECKER_USER_AGENT, SAFE_FETCH_MAX_BODY_BYTES, SAFE_FETCH_MAX_REDIRECTS, SAFE_FETCH_TIMEOUT_MS } from "./safeFetch";

/**
 * The /checker page is what the Nooscape-Checker user agent points at. It is read by people who run sites and want to
 * know what is asking and how to make it stop, so every number on it is a promise. These read the page and hold each
 * promise to the constant in the code that keeps it, run the opt-out it shows through the real robots.txt reader, and
 * keep the page to the rules of the site: nothing on it can fetch, save or send anything, and it ranks nothing.
 */
const read = (relative: string) => readFileSync(path.resolve(import.meta.dirname, relative), "utf8").replace(/\r\n/g, "\n");
const page = read("../client/src/pages/Checker.tsx");
const dossier = read("../client/src/pages/DirectoryAgent.tsx");
const app = read("../client/src/App.tsx");
const shell = read("../client/index.html");
const sitemap = read("../client/public/sitemap.xml");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const NUMBER_WORDS: Record<number, string> = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 16: "sixteen", 20: "twenty", 30: "thirty" };

describe("the address", () => {
  it("is a route the app draws and the server answers 200 for", () => {
    expect(app).toContain('<Route path="/checker" component={Checker} />');
    expect(isClientRoutePath("/checker")).toBe(true);
  });

  it("is in the sitemap, so a search for the name finds it", () => {
    expect(sitemap).toContain("<loc>https://nooscape.si/checker</loc>");
  });

  it("is the one the user agent names", () => {
    expect(CHECKER_USER_AGENT).toContain("(+https://nooscape.si/checker)");
    expect(page).toContain(CHECKER_USER_AGENT);
  });
});

describe("the limits it states", () => {
  it("are the ones the fetch enforces", () => {
    expect(page).toContain(`${SAFE_FETCH_TIMEOUT_MS / 1000} seconds`);
    expect(page).toContain(`first ${SAFE_FETCH_MAX_BODY_BYTES / 1024} KiB`);
    expect(page).toContain(`${ROBOTS_MAX_BYTES / 1024} KiB for robots.txt`);
    expect(page).toContain(`${SAFE_FETCH_MAX_REDIRECTS} redirects`);
    expect(page).toContain(`up to ${REGISTRATION_FETCH_MAX_BYTES / 1024} KiB of a registration file`);
  });

  it("are the tries the name reader gives a registration link, and the page says so", () => {
    expect(page).toContain(`${NUMBER_WORDS[RESOLUTION_FAILED_MAX_ATTEMPTS]} at most if the link does not answer, ${NUMBER_WORDS[RESOLUTION_NO_NAME_MAX_ATTEMPTS]} if the file has no name in it`);
  });

  it("are the pace the manners keep", () => {
    expect(page).toContain(`${NUMBER_WORDS[POLITE_DEFAULT_GAP_MS / 1000]} request a second`);
    expect(page).toContain(`${NUMBER_WORDS[POLITE_MAX_CONCURRENCY]} requests at a time`);
  });
});

describe("the way to make it stop", () => {
  const rule = (name: string) => {
    const match = new RegExp(`const ${name} = "([^"]+)"`).exec(page);
    expect(match, `${name} is a string in the page`).not.toBeNull();
    return JSON.parse(`"${match![1]}"`) as string;
  };

  it("works: the rule the page shows keeps the checker out of every path, read by the same reader the checker uses", () => {
    const rules = parseRobots(rule("ROBOTS_RULE"));
    expect(rules.map(group => group.agents)).toEqual([["nooscape-checker"]]);
    for (const requestPath of ["/", "/agent.json", "/.well-known/agent-card.json", "/a/b?c=d"]) {
      expect(robotsAllows(rules, requestPath), requestPath).toBe(false);
    }
  });

  it("works for a part of a site too: the narrower rule keeps out of that path and nothing else", () => {
    const rules = parseRobots(rule("ROBOTS_NARROW_RULE"));
    expect(robotsAllows(rules, "/private/x")).toBe(false);
    expect(robotsAllows(rules, "/open")).toBe(true);
  });

  it("is explained as the code reads it", () => {
    expect(page).toContain("a group for Nooscape-Checker or Nooscape, and the group for * when there is none");
    expect(page).toContain("a 429");
    expect(page).toContain("A missing robots.txt (a 404, for example) means no restriction");
  });
});

describe("what it says about itself", () => {
  it("says what it asks for, as the checks do it: the endpoints a reviewed agent's card declares, each at most once a day", () => {
    expect(page).toContain("an endpoint that the published card of a reviewed agent declares");
    expect(page).toContain("at most once a day");
    expect(page).toContain("reads robots.txt each time it visits a site");
    expect(CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect([...CHECKABLE_SOURCE_PROTOCOLS]).toEqual(["a2a"]);
  });

  it("lists what it records, the reason included, and says the status is the last answer's after any redirects", () => {
    expect(page).toContain("whether the address answered after any redirects");
    expect(page).toContain("it records the reason");
    expect(page).toContain("The reason and the fingerprint are not shown.");
  });

  it("claims no request that is not made: not that none has been, and no path that no check asks", () => {
    expect(page).not.toContain("has not made a request");
    expect(page).not.toMatch(/well-known|profile link/i);
  });

  it("promises only what the agent's page does: it shows the latest check with its date, and links back here", () => {
    expect(page).toContain("shows the latest check on the agent&rsquo;s page, with its date");
    expect(dossier).toContain('id="dossier-checks"');
    expect(dossier).toContain('href="/checker"');
  });

  it("says it reads a registration link to find a name, as the 8004 pass does, through the same checker", () => {
    expect(page).toContain("Nooscape-Checker does three things");
    expect(page).not.toContain("does two things");
    expect(page).not.toContain("checks one thing");
    expect(page).toContain("the registration link of an agent in the 8004 registry or the SAID registry on Solana");
    expect(page).toContain("one registration link that a registration in the 8004 registry or the SAID registry on Solana, or a registration in the ERC-8004 registry on Robinhood Chain, names");
    expect(page).toContain("A registration link on a site that keeps it out is not read");
  });

  it("says it reads the registration file of a listed BNB Chain agent, what it keeps, and what it never asks, and the step does what the page says", () => {
    expect(page).toContain("And it reads the registration file of a listed agent in the ERC-8004 registry on BNB Chain, to group registrations that look alike.");
    expect(page).toContain("It reads the whole file, up to 256 KiB, to find its name, its description and the host of its first agent address.");
    expect(page).toContain("it asks for none of the agent addresses the file lists");
    expect(page).toContain("The file is not kept and none of it is shown.");
    expect(page).toContain("Reading a file does not change an entry&rsquo;s tier, whether it is listed, its order or its place on the map.");
    // The size is the registration reader's cap, the same one the page states for the names.
    expect(REGISTRATION_FETCH_MAX_BYTES).toBe(256 * 1024);
    const step = read("./bscRegistrationFiles.ts");
    // Listed entries only, through the shared reader, and what is written to an entry is a status, the key, the host and the date.
    expect(step).toContain("createRegistrationFileReader");
    expect(step).toContain("evidenceFromFile");
    const kept = /\.set\(\{ readStatus, templateKey, endpointHost, readAt: new Date\(\) \}\)/.test(step);
    expect(kept, "the step writes the status, the key, the host and the date, and nothing of the file").toBe(true);
    // The tries are the name reader's, and the file step counts them in the evidence's status.
    expect(read("./bscRegistrationFilesCore.ts")).toContain("RESOLUTION_FAILED_MAX_ATTEMPTS");
    expect(read("./bscRegistrationFilesCore.ts")).toContain("RESOLUTION_NO_NAME_MAX_ATTEMPTS");
  });

  it("says it also reads the registration link of an agent on Robinhood Chain for its name, and the step does what the page says", () => {
    expect(page).toContain("or of an agent in the ERC-8004 registry on Robinhood Chain, to find the agent&rsquo;s name");
    expect(page).toContain("or a registration in the ERC-8004 registry on Robinhood Chain, names");
    expect(page).toContain("For a registration on Robinhood Chain it first finds the link by reading the registry on the chain, which asks nothing of your site.");
    expect(page).toContain("The 8004 and SAID registries on Solana and the ERC-8004 registry on Robinhood Chain are public too, and so is the ERC-8004 registry on BNB Chain.");
    expect(page).toContain("Nooscape shows the name it read in place of the number on the agent&rsquo;s page, on the map and in the directory, says on the agent&rsquo;s page when it read it");
    // The agent's page does say when, and the explanation of what a record shows names the exception.
    expect(read("../client/src/pages/DirectoryAgent.tsx")).toContain("This name was read from the agent&rsquo;s registration link on {formatWhen(record.nameReadAt)}");
    expect(read("../client/src/lib/evidenceExplain.ts")).toContain("apart from a name Nooscape read from a registration link");
    expect(page).toContain("the signed evidence of a reviewed record is not changed");
    // The pace the page promises is the pace the step keeps.
    expect(page).toContain(`reads at most ${NUMBER_WORDS[NAMES_MAX_PER_RUN]} registration files in one run, at most ${NUMBER_WORDS[NAMES_MAX_PER_HOST]} of them from one host name, and runs at most every ${NUMBER_WORDS[NAMES_INTERVAL_MS / 60_000]} minutes.`);
    // The BNB Chain file step keeps the same pace.
    expect(FILES_MAX_PER_RUN).toBe(NAMES_MAX_PER_RUN);
    expect(FILES_MAX_PER_HOST).toBe(NAMES_MAX_PER_HOST);
    expect(FILES_INTERVAL_MS).toBe(NAMES_INTERVAL_MS);
    // The same reader and manners as the Solana pass, and only records that are served, which are the reviewed ones.
    const step = read("./robinhoodNames.ts");
    expect(step).toContain("createRegistrationNameResolver");
    expect(step).toContain("listLiveAtlasRecords");
    // The link of an entry is found on the chain in one attempt, and the entry's note says when its name was read.
    expect(step).toContain("callRobinhoodRpcOnce");
    expect(read("./robinhoodNamesCore.ts")).toContain("Its name was read from its registration link on");
    // Only https and ipfs links, as the page says, and only the display name is laid over the placeholder.
    expect(read("./robinhoodNamesCore.ts")).toContain('if (kind === "web" && !uri.startsWith("https://")) return null;');
    expect(read("./db.ts")).toContain("Only the display name changes: the retained observation, the evidence packet");
  });

  it("says it reads the card behind a SAID identity's link for its name, how many and how often, and the step does what the page says", () => {
    expect(page).toContain("registration in the 8004 registry or the SAID registry on Solana");
    expect(page).toContain("A registration in the SAID registry records its link on the chain too, and Nooscape reads it from there.");
    expect(page).toContain("Most of those links name a small card (about 300 bytes) on SAID&rsquo;s own host, api.saidprotocol.com.");
    // The pace the page promises is the pace the step keeps.
    expect(page).toContain(`The SAID names read at most ${NUMBER_WORDS[SAID_NAMES_MAX_PER_RUN]} cards in one run and run at most every ${NUMBER_WORDS[SAID_NAMES_INTERVAL_MS / 60_000]} minutes.`);
    expect(page).toContain(`so up to ${NUMBER_WORDS[SAID_NAMES_MAX_PER_HOST]} of a run can come from one host name, at one request a second.`);
    // The card is small: far under the reader's cap, so the page's 256 KiB is a ceiling and not the usual size.
    expect(REGISTRATION_FETCH_MAX_BYTES).toBe(256 * 1024);
    // The same reader and manners as the other name reads, one attempt per card with the same tries, and only https and ipfs links.
    const step = read("./saidNames.ts");
    expect(step).toContain("createRegistrationNameResolver");
    expect(step).toContain("RESOLUTION_FAILED_MAX_ATTEMPTS");
    expect(step).toContain("RESOLUTION_NO_NAME_MAX_ATTEMPTS");
    expect(read("./saidNamesCore.ts")).toContain('return uri.startsWith("https://") ? "web" : null;');
    // Nothing of the card is kept but its name, and the entry's note says when the name was read.
    expect(step).toContain("resolvedName: result.status === \"resolved\" ? result.name : null");
    expect(read("./robinhoodNamesCore.ts")).toContain("Its name was read from its registration link on");
    // It asks only the addresses the registrations themselves name, so it has no address of its own to ask.
    expect(step).not.toContain("api.saidprotocol.com");
    expect(read("./saidNamesCore.ts")).not.toMatch(/https:\/\/api\.saidprotocol\.com\/api\/(agents|screen|verify)/);
  });

  it("does not call the IPFS gateway a public one: the gateway the name reader asks is configured, and in production it is one Nooscape runs", () => {
    expect(page).not.toMatch(/public (IPFS )?gateway/i);
    expect(page).toContain("An ipfs address is asked of an IPFS gateway and not of your site");
    expect(page).toContain("an ipfs address that it asks an IPFS gateway for");
  });

  it("gives the site's own mailbox and its account on X as the ways to reach someone", () => {
    expect(shell).toContain('<meta name="twitter:site" content="@Nooscape" />');
    expect(page).toContain("https://x.com/Nooscape");
    expect(page).toContain('href="mailto:support@nooscape.si"');
  });

  it("claims no score, no ranking by what it finds, and no verdict from a failure", () => {
    const words = stripComments(page);
    expect(words).not.toMatch(/\bscores?\b/i);
    expect(words).toContain("never changes an agent&rsquo;s tier, whether it is listed, its order or its place on the map");
    expect(words).toContain("A check that fails says nothing by itself");
  });

  it("says when the agent's page says failing, and that a 404 or a 405 to a plain GET is shown as that, as the page does it", () => {
    expect(page).toContain(`It says an address is failing only when the last ${NUMBER_WORDS[PUBLIC_CHECKS_FAILING_AFTER]} asks in a row got no answer, and that says nothing about why.`);
    expect(page).toContain("A 404 or a 405 to a plain GET is shown as that: Nooscape sends only GET or HEAD, so it does not know whether the address takes POST.");
  });

  it("uses no long dash", () => {
    expect(page).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });
});

describe("what the page can do", () => {
  it("is nothing: no read of the server, no form, no storage, no script of its own", () => {
    const code = stripComments(page);
    expect(code).not.toMatch(/<form\b|<input\b|<textarea\b|<button\b|<select\b/i);
    expect(code).not.toMatch(/trpc|fetch\(|localStorage|sessionStorage|XMLHttpRequest|navigator\.|window\.ethereum|useMutation|useQuery|dangerouslySetInnerHTML/);
  });
});

describe("the rest of the site, on what Nooscape fetches", () => {
  it("does not say it fetches no arbitrary URL, which the 8004 name fetch and the checks make untrue, and says what it asks instead", () => {
    const about = read("../client/src/pages/WhatNooscapeIs.tsx");
    expect(about).not.toContain("does not fetch arbitrary URLs");
    expect(about).toContain("It reads approved sources and asks the addresses their records name, such as the endpoints reviewed agents declare (once a day at most), within limits on time and size.");
  });

  it("does not say an active source authorizes only a card fetch, that sources run by hand only, or that every source is A2A", () => {
    const sources = read("../client/src/pages/SourceStatus.tsx");
    expect(sources).not.toContain("authorizes only");
    expect(sources).not.toMatch(/Manual runs only|bounded manual observations/);
    expect(sources).not.toContain("<span>A2A</span>");
    expect(sources).toContain("{directoryProtocolLabel(source.protocol)}");
    expect(sources).toContain("For an A2A source it also allows a check once a day");
    expect(sources).toContain("For the 8004 registries on Solana, Robinhood Chain and BNB Chain, and the SAID registry on Solana, it also allows reading the registration link of an entry, a few at a time, to find its name or to group look-alike entries (Nooscape-Checker).");
  });

  it("does not say the Solana 8004 pass fetches nothing, which its name fetch makes untrue, or that an entry is reachable because it has a locator", () => {
    const pass = read("./ingestion/solana8004.ts");
    expect(pass).not.toContain("no off-chain content is fetched");
    expect(pass).toContain("the pass may fetch the registration link to read one");
    expect(read("../client/src/lib/glossary.ts")).not.toContain("Reachable at a locator");
  });

  // The BNB card says the directory pass reads the registration file behind a listed entry's https or ipfs link and names the
  // one-off census of 2026-10-16 that read some earlier, the BNB note says the same through BNB_FETCH_SENTENCE, the Robinhood pass
  // records that the registered address was not fetched at its observation, and the Metaplex pass that its route was not invoked.
  // The agent checks are not asked of those sources, so putting one of them on the list has to change the words first.
  it("keeps the claims about what is read true: the checks are not asked of those sources", () => {
    for (const protocol of ["erc8004_bsc", "erc8004", "solana_registry"]) expect(CHECKABLE_SOURCE_PROTOCOLS as readonly string[], protocol).not.toContain(protocol);
    expect(read("../client/src/pages/Home.tsx")).toContain("the directory pass reads the registration file behind the https or ipfs link of a listed entry, to group look-alike entries, and a one-off census on 2026-10-16 read some earlier");
    expect(read("../client/src/pages/Home.tsx")).not.toContain("the directory pass fetched no profile link");
    expect(read("../client/src/pages/Home.tsx")).not.toContain("Nooscape did not fetch any profile link");
    // The BNB note is built by the shared pass from the chain's own sentence, and BNB's entry takes it from BNB_FETCH_SENTENCE.
    expect(read("./ingestion/erc8004Chains.ts")).toContain("fetchSentence: BNB_FETCH_SENTENCE");
    expect(read("./ingestion/erc8004Chain.ts")).toContain("chain.fetchSentence");
    for (const file of ["bscChain", "erc8004Chain"]) expect(read(`./ingestion/${file}.ts`), file).not.toContain("Nooscape did not fetch it");
    expect(read("./ingestion/robinhood.ts")).toContain("Nooscape did not fetch it");
    expect(read("./ingestion/metaplex.ts")).toContain("Nooscape did not invoke it");
  });
});

describe("the census of 2026-10-16, described as it was run", () => {
  const measure = read("./bscB1Measure.ts");
  const kibOf = (name: string) => Number(new RegExp(`const ${name} = (\\d+) \\* 1024`).exec(measure)?.[1]);
  const census = page.slice(page.indexOf('aria-labelledby="checker-census"'), page.indexOf('aria-labelledby="checker-stop"'));

  it("has a section of its own, dated, that says it was one run and asked more than the regular BNB read, which asks no agent address", () => {
    expect(census.length).toBeGreaterThan(0);
    expect(census).toContain("The census of 16 October 2026");
    expect(census).toContain("It was a one-off, dated run, and it asked more than the regular BNB Chain read does: it also asked the agent addresses that a file lists, which the regular read never does.");
    expect(CHECKABLE_SOURCE_PROTOCOLS as readonly string[]).not.toContain("erc8004_bsc");
    expect(page).toContain("which asked more than it does regularly; that run is described below");
    // The regular read: the step reads a registration file and nothing else of a host, and never an agent address.
    const step = stripComments(read("./bscRegistrationFiles.ts"));
    expect(step).toContain("createRegistrationFileReader");
    expect(step).not.toMatch(/agentEndpoints|a2aEndpoints|probe/i);
  });

  it("states the sizes the run read, which are the constants in the tool, and says they are more than the regular checks read", () => {
    expect(kibOf("REGISTRATION_MAX_BODY_BYTES")).toBe(256);
    expect(kibOf("PROBE_MAX_BODY_BYTES")).toBe(64);
    expect(census).toContain(`up to ${kibOf("REGISTRATION_MAX_BODY_BYTES")} KiB of a registration file`);
    expect(census).toContain(`up to ${kibOf("PROBE_MAX_BODY_BYTES")} KiB of the answer from an agent address`);
    expect(census).toContain(`more than the ${SAFE_FETCH_MAX_BODY_BYTES / 1024} KiB of the regular checks`);
  });

  it("keeps the pace and the manners the run kept: robots.txt first, one request a second to a host, five at a time", () => {
    expect(census).toContain("your robots.txt first");
    expect(census).toContain(`at most ${NUMBER_WORDS[POLITE_DEFAULT_GAP_MS / 1000]} request a second to a host name and ${NUMBER_WORDS[POLITE_MAX_CONCURRENCY]} at a time`);
    expect(census).toContain(`${SAFE_FETCH_TIMEOUT_MS / 1000} seconds a request`);
    expect(census).toContain(`at most ${SAFE_FETCH_MAX_REDIRECTS} redirects`);
    expect(measure).toContain("createPoliteFetcher({ concurrency: 5");
  });

  it("names the gateway the ipfs files were read through, and the hours a site would see it in its logs", () => {
    expect(census).toContain("an IPFS gateway (ipfs.filebase.io) and not your site");
    expect(census).toContain("between 18:02 and 18:18 UTC");
  });

  it("says the results are not shown against any entry and changed none, and that a failed request says nothing", () => {
    expect(census).toContain("The results are not shown against any entry");
    expect(census).toContain("changed no entry&rsquo;s tier, whether it is listed, its order or its place on the map");
    expect(census).toContain("A request that got no answer says nothing by itself about the agent");
  });

  it("links the report that holds the counts, and the report links back", () => {
    expect(census).toContain('href="/field/bnb-registry-2026-10-16"');
    expect(read("../client/src/pages/BnbRegistryReport.tsx")).toContain('href="/checker"');
  });

  it("claims no score, no verdict, and no path it did not ask", () => {
    expect(census).not.toMatch(/\bscores?\b|well-known|profile link/i);
  });
});
