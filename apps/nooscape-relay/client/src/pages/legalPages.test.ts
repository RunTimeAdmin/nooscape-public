import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPLY_WITHIN, SECURITY_EMAIL, SUPPORT_EMAIL, TRUST_EMAIL } from "../lib/contacts";
import { KEY_PREFIX_LENGTH } from "../../../shared/apiKey";

/**
 * The pages that say how Nooscape treats people (disputes, privacy, terms, contact) make claims the code can break: an
 * address, a reply time, what the browser keeps, which third parties a page talks to. A page that says "we set no cookie"
 * after a cookie is added is worse than no page on a site whose rule is that every claim is true. So each claim that a
 * file can contradict is held to that file here, and a change that breaks one fails this test and names the page to change.
 */
const client = fileURLToPath(new URL("..", import.meta.url));
const app = join(client, "..", "..");
const read = (path: string) => readFileSync(path, "utf8");
const page = (name: string) => read(join(client, "pages", `${name}.tsx`));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const clientSources = sourceFiles(client).map(path => ({ file: relative(client, path).replaceAll("\\", "/"), text: read(path) }));
const serverSources = sourceFiles(join(app, "server")).map(path => ({ file: relative(join(app, "server"), path).replaceAll("\\", "/"), text: read(path) }));

const PAGES = ["Disputes", "Privacy", "Terms", "Contact"] as const;
const ROUTES = ["/disputes", "/privacy", "/terms", "/contact"] as const;

describe("the four pages and the places that name them", () => {
  it("are routed, listed for the server and in the sitemap", () => {
    const routes = read(join(client, "App.tsx"));
    const server = read(join(app, "server", "clientRoutes.ts"));
    const sitemap = read(join(app, "client", "public", "sitemap.xml"));
    PAGES.forEach((name, index) => {
      expect(routes, name).toContain(`<Route path="${ROUTES[index]}" component={${name}} />`);
      expect(server, name).toContain(`"${ROUTES[index]}"`);
      expect(sitemap, name).toContain(`<loc>https://nooscape.si${ROUTES[index]}</loc>`);
    });
  });

  it("are linked from the home page's footer, from each other's footer and from a record's page", () => {
    const home = read(join(client, "pages", "Home.tsx"));
    const frame = read(join(client, "components", "InfoPage.tsx"));
    for (const route of ROUTES) {
      expect(home, route).toContain(`href="${route}"`);
      expect(frame, route).toContain(`"${route}"`);
    }
    expect(read(join(client, "pages", "DirectoryAgent.tsx"))).toContain('href="/disputes"');
  });
});

describe("the addresses and the reply time", () => {
  it("are the ones the operator chose", () => {
    expect(TRUST_EMAIL).toBe("trust@nooscape.si");
    expect(SECURITY_EMAIL).toBe("security@nooscape.si");
    expect(SUPPORT_EMAIL).toBe("support@nooscape.si");
    expect(REPLY_WITHIN).toBe("one business day");
  });

  it("are read from lib/contacts.ts by every page that names one, never written out again", () => {
    for (const name of PAGES) expect(page(name), name).not.toMatch(/@nooscape\.si/);
    for (const name of ["Disputes", "Privacy", "Terms", "Contact"]) expect(page(name), name).toContain("TRUST_EMAIL");
    expect(page("Contact")).toContain("SECURITY_EMAIL");
    expect(page("Contact")).toContain("SUPPORT_EMAIL");
    expect(page("Disputes")).toContain("SECURITY_EMAIL");
  });

  it("make the reply promise on the pages that make it, and only that promise anywhere in the client", () => {
    for (const name of ["Disputes", "Privacy", "Contact"]) expect(page(name), name).toContain("{REPLY_WITHIN}");
    for (const { file, text } of clientSources) expect(text, file).not.toMatch(/24[\s-]?hours?/i);
  });

  it("agree with the address in security.txt", () => {
    expect(read(join(app, "server", "securityTxt.ts"))).toContain(`mailto:${SECURITY_EMAIL}`);
  });
});

describe("what the privacy page says about the browser and the network, held to the code", () => {
  const privacy = page("Privacy");

  it("says Nooscape sets no cookie for visitors only while the one place that sets a cookie is the operator's login", () => {
    expect(privacy).toContain("Nooscape sets none for visitors");
    // A call that sets or clears a cookie on a response. safeFetch.ts only drops Set-Cookie from the pages it fetches, which sets nothing.
    const setters = serverSources.filter(({ text }) => /\bres\.(cookie|clearCookie)\(|\.(set|setHeader|append)\(\s*["']set-cookie["']/i.test(text)).map(({ file }) => file);
    expect(setters).toEqual(["operatorAuth.ts"]);
    for (const { file, text } of clientSources) expect(text, file).not.toMatch(/document\.cookie/);
  });

  it("says the browser keeps only the owl and theme choices, which is all the client writes", () => {
    expect(privacy).toContain("switch the owl off or change the theme");
    const writers = clientSources.filter(({ text }) => /localStorage\.setItem\(/.test(text)).map(({ file }) => file).sort();
    expect(writers).toEqual(["contexts/OwlContext.tsx", "contexts/ThemeContext.tsx"]);
    for (const { file, text } of clientSources) expect(text, file).not.toMatch(/sessionStorage|indexedDB/);
  });

  it("names every third party the page loads, and the page loads no other", () => {
    const html = read(join(client, "..", "index.html"));
    const hosts = Array.from(new Set(Array.from(html.matchAll(/https:\/\/([a-z0-9.-]+)/gi), match => match[1]!.toLowerCase())))
      .filter(host => host !== "nooscape.si")
      .sort();
    expect(hosts, "a new third party in index.html needs a line on the privacy page, then an entry here").toEqual(["cloud.umami.is"]);
    expect(privacy).toContain("Umami Cloud (cloud.umami.is)");
  });

  it("says the fonts are served from the site, which is what the page and the build do, and names no font host", () => {
    expect(privacy).toContain("the two typefaces are served from nooscape.si itself");
    expect(privacy).not.toMatch(/Google|fonts\.googleapis|fonts\.gstatic/);
    for (const { file, text } of clientSources) expect(text, file).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    const main = read(join(client, "main.tsx"));
    for (const face of ["space-grotesk/400", "space-grotesk/500", "space-grotesk/600", "space-grotesk/700", "dm-mono/400", "dm-mono/500"]) {
      expect(main, face).toContain(`import "@fontsource/${face}.css";`);
    }
  });

  it("says the server logs the address of a visitor who goes over a rate limit, and that is what it logs", () => {
    expect(privacy).toContain("when a visitor goes over a rate limit");
    const limiter = read(join(app, "server", "rateLimit.ts"));
    expect(limiter).toContain("limit reached for ${clientKey}");
    expect(limiter, "an IPv6 address is cut to its first 64 bits (four 16-bit groups) before it is used").toContain("groups.slice(0, 4)");
  });
});

describe("what the privacy and terms pages say about claiming an agent, held to the code", () => {
  const privacy = page("Privacy");
  const terms = page("Terms");
  const claims = read(join(app, "server", "claims.ts"));
  const schema = read(join(app, "drizzle", "schema.ts"));
  const flow = read(join(client, "lib", "claimFlow.ts"));
  const panel = read(join(client, "components", "claim", "ClaimPanel.tsx"));

  it("says there is no account and no need to sign in to read, since the one sign-in is an owner's claim", () => {
    expect(privacy).toContain("There are no accounts. You do not need to sign in to read anything");
    expect(privacy).not.toContain("no sign-in");
    expect(privacy).toContain("see the section When you claim an agent");
    expect(privacy).toContain('id="privacy-claim"');
    expect(terms).toContain('id="terms-claim"');
    expect(terms).toContain("If you claim an agent");
  });

  it("names the two chains a claim can be made on, which are the two the claim code names", () => {
    expect(privacy).toContain("Robinhood Chain or BNB Smart Chain registry");
    const chains = read(join(app, "server", "claimsChain.ts"));
    for (const label of ["Robinhood Chain", "BNB Smart Chain"]) {
      expect(chains, label).toContain(`label: "${label}"`);
      expect(flow, label).toContain(`"${label}"`);
    }
  });

  it("says in one more sentence, only while Arc's claims are on in the build, that the owner of an agent on Arc can claim it the same way", () => {
    expect(privacy).toContain('const ARC_CLAIMS = arcClaimsOn(import.meta.env.VITE_FEATURES);');
    expect(privacy).toContain('{ARC_CLAIMS && " The owner of an agent on the Arc registry can claim it in the same way."}');
    // The sentence that has always been there is as it was, and the date on the page changes only with the new sentence.
    expect(privacy).toContain("The owner of an agent on the Robinhood Chain or BNB Smart Chain registry can claim it by signing one message with their wallet.");
    expect(privacy).toContain('ARC_CLAIMS ? "20 October 2026" : "19 October 2026"');
    const chains = read(join(app, "server", "claimsChain.ts"));
    expect(chains).toContain('label: "Arc"');
    expect(flow).toContain('"Arc"');
    // The claim code and the page ask the same question: Arc is on and its claims are on.
    expect(read(join(app, "shared", "features.ts"))).toContain('featureOn("chain_arc", list) && featureOn("claims_arc", list)');
    expect(chains).toContain("arcClaimsOn(features)");
    expect(flow).toContain("arcClaimsOn(features)");
  });

  it("says in one more sentence for each, only while that chain's claims are on in the build, that the owner of an agent on Base or on Ethereum can claim it the same way", () => {
    expect(privacy).toContain('const BASE_CLAIMS = baseClaimsOn(import.meta.env.VITE_FEATURES);');
    expect(privacy).toContain('const ETHEREUM_CLAIMS = ethereumClaimsOn(import.meta.env.VITE_FEATURES);');
    expect(privacy).toContain('{BASE_CLAIMS && " The owner of an agent on the Base registry can claim it in the same way."}');
    expect(privacy).toContain('{ETHEREUM_CLAIMS && " The owner of an agent on the Ethereum registry can claim it in the same way."}');
    // The date on the page is the day the newest sentence was written, and the older dates are kept for the older builds.
    expect(privacy).toContain('changed={BASE_CLAIMS || ETHEREUM_CLAIMS ? "28 October 2026" : ARC_CLAIMS ? "20 October 2026" : "19 October 2026"}');
    const chains = read(join(app, "server", "claimsChain.ts"));
    expect(chains).toContain('label: "Base"');
    expect(chains).toContain('label: "Ethereum"');
    expect(flow).toContain('"Base"');
    expect(flow).toContain('"Ethereum"');
    // The claim code and the page ask the same question: the chain is on and its claims are on.
    const features = read(join(app, "shared", "features.ts"));
    expect(features).toContain('featureOn("chain_base", list) && featureOn("claims_base", list)');
    expect(features).toContain('featureOn("chain_ethereum", list) && featureOn("claims_ethereum", list)');
    expect(chains).toContain("baseClaimsOn(features)");
    expect(chains).toContain("ethereumClaimsOn(features)");
    expect(flow).toContain("baseClaimsOn(features)");
    expect(flow).toContain("ethereumClaimsOn(features)");
  });

  it("keeps the one-time request for at least two days after it expires, which is when the daily step deletes it", () => {
    expect(privacy).toContain("kept for at least two days after it expires, then deleted by a daily step");
    expect(claims).toContain("NONCE_KEPT_MS = 2 * DAY_MS");
    expect(claims).toContain("lt(agentClaimNonces.expiresAt, seconds(new Date(deps.now().getTime() - NONCE_KEPT_MS)))");
  });

  it("keeps no network address and no email for a claim: no column of the three claim tables holds one, or the signature itself", () => {
    expect(privacy).toContain("keeps no network address as part of a claim");
    expect(privacy).toContain("a digest of your signature (not the signature)");
    for (const table of ["agentClaimNonces", "agentClaims", "agentClaimEdits"]) {
      const start = schema.indexOf(`export const ${table} = mysqlTable(`);
      expect(start, table).toBeGreaterThan(-1);
      const body = schema.slice(start, schema.indexOf("\n);", start));
      const columns = Array.from(body.matchAll(/(?:varchar|int|bigint|text|timestamp)\("(\w+)"/g), match => match[1]!);
      expect(columns.length, table).toBeGreaterThan(5);
      for (const column of columns) expect(column, `${table}.${column}`).not.toMatch(/^(ip|ipAddress|clientIp|clientKey|email|userAgent|signature)$/i);
    }
  });

  it("lists what a claim keeps as the tables hold it: the three states, the text of an edit, a history that is only added to", () => {
    expect(privacy).toContain("whether the claim is active, on hold or ended");
    for (const state of ['"active"', '"frozen"', '"revoked"']) expect(claims, state).toContain(state);
    expect(privacy).toContain("the text of the edit it is for");
    expect(schema).toContain('editText: varchar("editText"');
    expect(privacy).toContain("The history is only added to.");
    expect(read(join(app, "server", "claimsGuards.test.ts"))).toContain("is append-only: no code updates or deletes a row of agent_claim_edits");
  });

  it("says a hold shows on the agent's page and hides what the owner wrote, which the state read and the history both do, and that only the operator can put one", () => {
    expect(terms).toContain("A claim that is on hold shows as on hold on the agent&rsquo;s page, and nothing the owner wrote is shown while it is.");
    expect(privacy).toContain("While a claim is on hold none of it is shown.");
    expect(flow).toContain('export const HELD_LINE = "This claim is on hold.";');
    expect(panel).toContain('view === "held" ? HELD_LINE');
    expect(claims).toContain('profile: row.status === "frozen" ? NO_TEXT : profileOf(row)');
    expect(claims).toContain("row.claimId === onHold");
    expect(read(join(app, "server", "routers", "claim.ts"))).toContain("freeze: operatorProcedure");
  });

  it("says the history is public with its old and new text, only added to, and shows removed text as removed, which is what the history read and the page do", () => {
    expect(privacy).toContain("The history of changes is public: the date of each change, the field, the wallet that signed it and the start of a digest of its signature, with the old and new text. The newest 100 changes are shown.");
    expect(privacy).toContain("If something in it is removed from view, the history shows that it was removed, not what it said. While a claim is on hold, the history shows that changes were made without their text.");
    expect(privacy).toContain("A claim ends if the registry shows that the agent has a new owner, and the history says so. What you wrote is then no longer shown as the owner&rsquo;s text, but the history of the claim, including what you wrote unless it was removed, stays. You can still ask for it to be removed from view.");
    // The cap, the start of the digest, the hold clause and the removal of an ended claim's text are what the code does.
    expect(claims).toContain("export const CLAIM_HISTORY_LIMIT = 100;");
    expect(flow).toContain("signatureDigest.slice(0, 12)");
    expect(claims).toContain("row.claimId === onHold");
    expect(read(join(app, "server", "claims.integration.test.ts"))).toContain("removes the text of a claim that has ended, by its id");
    // A removal says who asked and never why.
    expect(flow).toContain("at the owner's request");
    expect(flow).toContain("by Nooscape");
    expect(claims).toContain('const REMOVAL_REASON: Record<RemovalBy, string> = { owner: "owner_request", nooscape: "nooscape" };');
    expect(flow).toContain("an entry says that a change was made, not what it said");
    expect(flow).toContain("signature digest");
    expect(flow).toContain('title: "The claim ended"');
    // A removal is a later row and the rows already written are never changed: the removal inserts a "redact" row and nothing updates the history table.
    expect(claims).toContain('kind: "redact"');
    expect(claims).toContain("row.seq < (removedAt.get(");
    expect(read(join(app, "server", "claimsGuards.test.ts"))).toContain("is append-only: no code updates or deletes a row of agent_claim_edits");
    expect(read(join(client, "components", "claim", "ClaimHistory.tsx"))).toContain("historyLine(item)");
  });

  it("says what an owner wrote is shown labelled as the owner's own words, which the panel does for a claim that is not on hold", () => {
    expect(privacy).toContain("is shown on the agent&rsquo;s page, labelled as the owner&rsquo;s own words");
    expect(flow).toContain('OWNER_TEXT_LABEL = "What the owner wrote"');
    expect(flow).toContain("Written by the claim holder. Nooscape has not checked it");
    expect(panel).toContain("<OwnerText profile={claim.profile} />");
  });

  it("tells the owner where the Terms and the Privacy page are, with a link to each, above the sign button and not inside the message", () => {
    expect(flow).toContain('before: "By claiming you agree to the "');
    expect(flow).toContain('terms: "Terms for claiming"');
    expect(flow).toContain('privacy: "Privacy page"');
    expect(panel).toContain('href="/terms" target="_blank" rel="noopener noreferrer"');
    expect(panel).toContain('href="/privacy" target="_blank" rel="noopener noreferrer"');
    expect(panel.indexOf("NOTICE.before")).toBeGreaterThan(-1);
    expect(panel.indexOf("NOTICE.before")).toBeLessThan(panel.indexOf("Sign in your wallet"));
    expect(read(join(app, "shared", "claimMessage.ts"))).not.toMatch(/\bagree|\bterms\b/i);
  });

  it("asks owners not to claim that anyone has verified, audited, certified, endorsed or approved an agent, and says a claim changes no listing", () => {
    expect(terms).toContain("verified, audited, certified, endorsed or approved it, or that it has passed a safety or security review");
    expect(terms).toContain("a claim does not change how an agent is listed, reviewed or tiered");
    expect(terms).toContain("without advance notice");
  });

  it("sends a removal request to the trust address and says what Nooscape cannot remove", () => {
    expect(privacy).toContain("Nooscape cannot change a chain or a registry, and the record that a claim was made stays.");
    for (const text of [privacy, terms]) {
      expect(text).toContain("TRUST_EMAIL");
      expect(text).toContain("{REPLY_WITHIN}");
    }
  });
});

describe("what the operator supplied for the Terms and Privacy pages, pinned as given", () => {
  const terms = page("Terms");
  const privacy = page("Privacy");

  it("names who runs the site and who is responsible for the data, RunTimeAdmin in Texas", () => {
    expect(terms).toContain("Nooscape is run by RunTimeAdmin, <a href=\"https://runtimeadmin.com\"");
    expect(terms).toContain(">runtimeadmin.com</a> (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By using the site or its API you agree to these Terms.");
    expect(privacy).toContain("RunTimeAdmin (<a href=\"https://runtimeadmin.com\"");
    expect(privacy).toContain(">runtimeadmin.com</a>), based in Texas, USA, is responsible for the personal data described on this page.");
  });

  it("sets the age at 18 on both pages", () => {
    expect(terms).toContain("You must be 18 or older to use Nooscape.");
    expect(privacy).toContain("Nooscape is not for anyone under 18, and we do not knowingly collect personal data from anyone under 18.");
  });

  it("limits liability to US$100, to the extent the law allows, and says what the limit does not cover", () => {
    expect(terms).toContain("our total liability to you for everything that arises from Nooscape is limited to US$100.");
    expect(terms).toContain("To the extent the law allows, RunTimeAdmin is not liable for any indirect, incidental or consequential loss");
    expect(terms).toContain("a decision to trade, to send a payment");
    expect(terms).toContain("Some places do not allow some of these limits.");
  });

  it("gives the warranty as is and as available, and says payment never changes a record", () => {
    expect(terms).toContain("provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, with no warranties of any kind, express or implied");
    expect(terms).toContain("Payment never changes a record, a score or an evidence level.");
    expect(terms).toContain("We never take money to change a record.");
  });

  it("is governed by Texas law with Texas courts", () => {
    expect(terms).toContain("governed by the laws of the State of Texas, USA");
    expect(terms).toContain("goes to the courts located in Texas");
  });

  it("keeps server logs for at least 30 days, which the code cannot show, next to the rate-limit line it can", () => {
    expect(privacy).toContain("We keep our copy for at least 30 days, for security and to prevent abuse, and delete it when we no longer need it for that.");
    expect(privacy).toContain("when a visitor goes over a rate limit");
  });

  it("says the basis for using the data and the rights a person has, and that on-chain data cannot be deleted by us", () => {
    expect(privacy).toContain("we rely on legitimate interests: running and securing the site and preventing abuse");
    expect(privacy).toContain("performing the service that the owner or the key holder asked for");
    expect(privacy).toContain("ask for access to the personal data we hold about you, ask for it to be corrected or deleted, and object to how we use it");
    expect(privacy).toContain("complain to the supervisory authority where you live");
    expect(privacy).toContain("Public on-chain data, and what a registry shows, cannot be deleted by us.");
  });

  it("sends legal notices, takedown requests and privacy rights to the security address, from lib/contacts.ts, and leaves the record questions on the trust address", () => {
    expect(terms).toContain("For legal notices and takedown requests, write to");
    expect(terms).toContain("SECURITY_EMAIL");
    expect(privacy).toContain("To use any of these rights, write to");
    expect(privacy).toContain("SECURITY_EMAIL");
    expect(privacy).toContain("Privacy questions and requests about a record or an address go to");
    expect(privacy).toContain("TRUST_EMAIL");
  });

  it("has every section the operator asked for, in the order a reader meets them", () => {
    const inOrder = (text: string, ids: string[]) => {
      const places = ids.map(id => text.indexOf(`id="${id}"`));
      places.forEach((place, index) => expect(place, ids[index]).toBeGreaterThan(-1));
      expect([...places].sort((a, b) => a - b), ids.join(" ")).toEqual(places);
    };
    inOrder(terms, ["terms-who", "terms-age", "terms-is", "terms-not", "terms-use", "terms-claim", "terms-content", "terms-wrong", "terms-data", "terms-sale", "terms-warranty", "terms-liability", "terms-indemnity", "terms-changes", "terms-law", "terms-general", "terms-ask"]);
    inOrder(privacy, ["privacy-controller", "privacy-visit", "privacy-publish", "privacy-claim", "privacy-basis", "privacy-rights", "privacy-children", "privacy-ask", "privacy-changes"]);
  });

  it("covers acceptable use, owner-written content that we may remove with who asked said, and the indemnity, changes and general clauses", () => {
    expect(terms).toContain("scrape Nooscape or reach it by automated means beyond the published rate limits");
    expect(terms).toContain("make a false claim, or pretend to be the owner of an agent or anyone else");
    expect(terms).toContain("put unlawful, abusive or infringing content in a field that an owner can write");
    expect(terms).toContain("We may hide or remove content, including what an owner wrote, at any time. When text is removed from view, the public history says that it was removed and who asked (the owner or Nooscape), and never why.");
    expect(terms).toContain("We are not responsible for third-party sites or for their content.");
    expect(terms).toContain("you agree to cover the claims, losses and costs that your use or your content cause us");
    expect(terms).toContain("the date at the top changes. If you keep using Nooscape after that, you accept the updated Terms.");
    expect(terms).toContain("If a part of these Terms cannot be enforced, the rest still applies.");
    expect(terms).toContain("These Terms are the whole agreement between you and us about Nooscape.");
  });

  it("says a removal names who asked, which the history does", () => {
    const flow = read(join(client, "lib", "claimFlow.ts"));
    expect(flow).toContain("at the owner's request");
    expect(flow).toContain("by Nooscape");
  });
});

describe("the words", () => {
  it("never promise a fix, a ranking or a sale", () => {
    for (const name of PAGES) {
      const text = page(name);
      expect(text, name).not.toMatch(/guarantee|we will fix|we will remove/i);
    }
    expect(page("Disputes")).toContain("The reply does not promise a fix.");
    expect(page("Disputes")).toContain("We never take money to change a record.");
    expect(page("Terms")).toContain("We never take money to change a record.");
  });
});

describe("what the privacy and terms pages say about API keys, held to the code", () => {
  const privacy = page("Privacy");
  const terms = page("Terms");
  const schema = read(join(app, "drizzle", "schema.ts"));
  const keys = read(join(app, "server", "apiKeys.ts"));
  const flow = read(join(client, "lib", "apiKeysFlow.ts"));
  const keysPage = page("DeveloperKeys");

  const columnsOf = (table: string) => {
    const start = schema.indexOf(`export const ${table} = mysqlTable(`);
    expect(start, table).toBeGreaterThan(-1);
    const body = schema.slice(start, schema.indexOf("\n);", start));
    return Array.from(body.matchAll(/(?:varchar|int|bigint|text|timestamp|date)\("(\w+)"/g), match => match[1]!);
  };

  it("names the one place an email is asked for, and keeps the line that there are no accounts", () => {
    expect(privacy).toContain('id="privacy-apikey"');
    expect(privacy).toContain("except to make an API key (see the section When you get an API key)");
    expect(privacy).toContain("That is the only place Nooscape asks for an email address.");
    expect(privacy).toContain("There are no accounts. You do not need to sign in to read anything");
    expect(terms).toContain("Nooscape collects no email address for a claim");
  });

  it("lists what a key keeps as the two tables hold it, and no network address in either", () => {
    expect(columnsOf("apiKeys")).toEqual(["id", "keyHash", "keyPrefix", "ownerEmail", "tier", "createdAt", "revokedAt", "lastUsedAt"]);
    expect(columnsOf("apiUsage")).toEqual(["keyId", "day", "endpoint", "count"]);
    for (const column of [...columnsOf("apiKeys"), ...columnsOf("apiUsage")]) expect(column, column).not.toMatch(/^(ip|ipAddress|clientIp|clientKey|userAgent|key|apiKey|secret)$/i);
    expect(privacy).toContain("your email address (trimmed and in lower case)");
    expect(privacy).toContain("a hash of the key (not the key itself, which is shown once and cannot be shown again)");
    expect(privacy).toContain("the first ten characters of the key");
    expect(privacy).toContain("a count of the requests the key made on each day (UTC) to each part of the API");
    expect(KEY_PREFIX_LENGTH).toBe(10);
    expect(keys).toContain('createHash("sha256")');
    expect(keys).toContain("normalizeEmail");
    expect(privacy).toContain("Nooscape keeps no network address and nothing you asked for with a key.");
    expect(keys).toMatch(/consumeRateLimit\(`api-key-signup:/);
  });

  it("says the email is used only to write about the key, on the page that asks for it and on Privacy, and that none is sent", () => {
    expect(privacy).toContain("We use your email address only to write to you about the key");
    expect(flow).toContain("used only to write to you about it");
    expect(privacy).toContain("No email is sent to confirm the address, and it is not checked.");
    expect(flow).toContain("No email is sent to confirm it, and it is not checked.");
    expect(keys).not.toMatch(/sendMail|nodemailer|smtp|resend|postmark|sendgrid/i);
  });

  it("keeps a revoked key's record and says so, and says what the keys page says about the cap on keys", () => {
    expect(privacy).toContain("The key&rsquo;s record, with your email address and its counts, stays so that its use can be accounted for, until you ask us to delete it.");
    expect(keys).toMatch(/set\(\{ revokedAt: new Date\(\) \}\)/);
    expect(keys).not.toMatch(/\.delete\(apiKeys\)|\.delete\(apiUsage\)/);
    expect(keys).toContain("export const LIVE_KEYS_PER_EMAIL = 3;");
    expect(keysPage).toContain("up to three live keys");
  });

  it("puts the API terms where the Terms already talk about the API, and says a key never changes what Nooscape says", () => {
    expect(terms).toContain('href="/developers/keys"');
    expect(terms).toContain("do not make keys to get around a limit");
    expect(terms).toContain("It does not change what Nooscape says about any agent, and nothing you pay buys a listing, a tier or an evidence level.");
    expect(flow).toContain("payment never changes a record, a tier or an evidence level");
  });

  it("has the keys page routed, headed and known to the server", () => {
    expect(read(join(client, "App.tsx"))).toContain('<Route path="/developers/keys" component={DeveloperKeys} />');
    expect(read(join(app, "server", "clientRoutes.ts"))).toContain('"/developers/keys"');
    expect(read(join(app, "server", "routeHead.ts"))).toContain('"/developers/keys"');
  });
});

describe("what the privacy and terms pages say about paying for an API call, held to the code", () => {
  const privacy = page("Privacy");
  const terms = page("Terms");
  const schema = read(join(app, "drizzle", "schema.ts"));
  const ledger = read(join(app, "server", "apiPayments.ts"));
  const service = read(join(app, "server", "x402Service.ts"));
  const protocol = read(join(app, "server", "x402.ts"));
  const api = read(join(app, "server", "apiV1.ts"));
  const migration = read(join(app, "drizzle", "0044_api_payments.sql"));

  const columns = () => {
    const start = schema.indexOf("export const apiPayments = mysqlTable(");
    expect(start).toBeGreaterThan(-1);
    const body = schema.slice(start, schema.indexOf("\n);", start));
    return Array.from(body.matchAll(/(?:varchar|int|bigint|tinyint|text|timestamp|date)\("(\w+)"/g), match => match[1]!);
  };

  it("lists what a payment keeps as the table holds it: no signature, no email, no network address", () => {
    expect(privacy).toContain('id="privacy-pay"');
    expect(columns()).toEqual(["id", "seq", "paymentId", "network", "endpoint", "payer", "nonce", "amount", "validBefore", "subjectHash", "status", "transaction", "reason", "sends", "serves", "createdAt", "updatedAt"]);
    for (const column of columns()) expect(column, column).not.toMatch(/sig|email|^ip|address|clientKey|userAgent|host/i);
    for (const phrase of ["your wallet address", "the amount", "the one-time number your wallet chose for the transfer", "when the authorization ends", "a hash of the request it was sent with", "the transaction that settled it", "how many times it was sent for settlement and answered"]) {
      expect(privacy, phrase).toContain(phrase);
    }
    expect(privacy).toContain("Nooscape does not keep the signature, does not ask for a name or an email address, and keeps no network address as part of a payment.");
    // The ledger and the service write nothing about the caller's address or the signature.
    expect(ledger).not.toMatch(/signature|clientKey|req\.ip|userAgent/i);
    const at = service.indexOf("ledger.begin({");
    expect(at).toBeGreaterThan(-1);
    expect(service.slice(at, service.indexOf("});", at))).not.toMatch(/signature|clientKey|ip\b/i);
    expect(migration.split(/\r?\n/).filter(line => !line.startsWith("--")).join(" ")).not.toMatch(/signature|email|ipAddress|clientKey/i);
  });

  it("says who settles a payment, and that Nooscape holds no funds: the facilitators are Circle's and Coinbase's and no key that moves money is on the server", () => {
    expect(privacy).toContain("Circle&rsquo;s x402 facilitator service");
    expect(protocol).toContain("https://api.circle.com/v1/facilitator/x402");
    // Base is settled by Coinbase's facilitator, which is named on the page and is the one address a Coinbase request is sent to.
    expect(privacy).toContain("Coinbase&rsquo;s CDP facilitator");
    expect(privacy).toContain("Coinbase also lists our API in its public catalogue of paid endpoints (the Bazaar)");
    const cdp = read(join(app, "server", "x402Cdp.ts"));
    expect(cdp).toContain('CDP_HOST = "api.cdp.coinbase.com"');
    expect(cdp).toContain('CDP_X402_PATH = "/platform/v2/x402"');
    expect(privacy).toContain("Nooscape never holds your funds");
    for (const text of [protocol, service]) expect(text).not.toMatch(/privateKey|mnemonic|signTypedData|sendTransaction|eth_send/i);
  });

  it("says the rate-limit log applies to a call with a payment, and the code logs the limit by name and address as it does elsewhere", () => {
    expect(privacy).toContain("The rate-limit log described above applies to a call with a payment as it does to the rest of the API.");
    expect(api).toContain("[RateLimit] x402 limit reached for");
    expect(`${api}${service}`).not.toMatch(/console\.(log|info|warn|error)\([^)]*payer/);
  });

  it("says a payment is charged only for a delivered answer, and for one request, held to the router", () => {
    expect(terms).toContain("It is charged only when the answer is delivered, so a request that fails costs nothing.");
    expect(terms).toContain("the payment cannot be used for a different request");
    // The only call that charges is the one that sends the answer, and it is made after the answer is built.
    expect(api.match(/\.charge\(/g) ?? []).toHaveLength(1);
    expect(api).toMatch(/const outcome = await deps\.payments!\.charge\(pay, subject\);\s+if \(!outcome\.deliver\) return sendReply/);
    expect(service).toContain("row.subjectHash !== subjectHash");
  });

  it("says this version has no refunds, and the code has none", () => {
    expect(terms).toContain("This version has no refunds.");
    for (const file of [...serverSources, ...clientSources]) {
      if (/x402|apiPayments|OperatorPayments/.test(file.file)) expect(file.text, file.file).not.toMatch(/\.refund\(|function refund|refundPayment|reverseTransfer/i);
    }
  });

  it("tells developers the numbers the code holds: the validity window, how often a paid answer is served again, and the prices", () => {
    const developers = page("DeveloperApi");
    expect(developers).toContain("It must be valid for at least 15 seconds and at most 10 minutes.");
    expect(protocol).toContain("const MIN_REMAINING_SECONDS = 15;");
    expect(protocol).toContain("const MAX_VALIDITY_SECONDS = 600;");
    expect(developers).toContain("(twice more, within its validity)");
    expect(service).toContain("export const MAX_SERVES = 3;");
    expect(developers).toContain("5000 is $0.005");
    expect(protocol).toContain('agent: "5000"');
    expect(developers).toContain("a request that carries a key is never asked to pay");
    expect(developers).toContain("This version has no refunds.");
    expect(developers).toContain("a wallet has one payment going at a time");
    // A wallet that holds less than the price is turned away first, and one wallet may start only so many a minute: held to the constant.
    expect(developers).toContain("A wallet that holds less USDC than the price is refused before the payment is sent on, and one wallet may start 60 new payments a minute.");
    expect(service).toContain("export const MAX_NEW_PER_PAYER_PER_MINUTE = 60;");
  });

  it("says a deployed smart-contract wallet is accepted where the API says so, and one not deployed yet is not, held to the code", () => {
    expect(terms).toContain("So is one from a deployed smart-contract wallet where the API says so");
    expect(terms).toContain("a wallet is held to one payment at a time");
    expect(terms).toContain("A payment from a wallet that is not deployed yet is not accepted.");
    // Without a node the code still refuses them, with the same words; an undeployed wallet's wrapped signature is always refused.
    expect(protocol).toContain("payments from smart-contract wallets are not accepted yet");
    expect(protocol).toContain("the wallet is not deployed yet (an ERC-6492 signature)");
    expect(service).toContain("MAX_CONTRACT_CHECKS_AT_ONCE");
    expect(service).toContain("openFor(cfg.network, payer)");
    // Only Arc takes such a wallet, and only with its node set: the index says so per network.
    expect(read(join(app, "server", "apiV1.ts"))).toContain('rail.network === pay.network && pay.rpc ? ["regular", "smart_contract"] : ["regular"]');
  });

  it("says the node provider is asked about a smart-contract wallet and sees only public chain data, and the code sends nothing else", () => {
    expect(privacy).toContain("our server also asks a blockchain node provider whether the wallet&rsquo;s own code accepts the signature");
    expect(privacy).toContain("all of which is public chain data");
    const chain = read(join(app, "server", "x402Chain.ts"));
    // What is sent to the node: one eth_call naming the token, the wallet and the transfer, no key, no email, no network address of the caller.
    expect(chain).toContain("eth_call");
    expect(chain).not.toMatch(/clientKey|req\.ip|email/i);
    expect(chain).toContain('headers: { "content-type": "application/json" }');
  });

  it("says the node provider may be asked what a paying wallet holds and sees only public chain data, held to the code", () => {
    expect(privacy).toContain("our server may also ask a blockchain node provider how much USDC the paying wallet holds");
    expect(privacy).toContain("That call carries only the wallet&rsquo;s address and the token&rsquo;s address, which are public chain data");
    const chain = read(join(app, "server", "x402Chain.ts"));
    // What is sent: one eth_call of balanceOf to the token, naming the wallet. Nothing of the caller's travels with it.
    expect(chain).toContain('selector("balanceOf(address)")');
    expect(chain).toContain('rpc("eth_call", [{ to: usdc, data:');
  });
});

describe("what the site says about having no token", () => {
  // Someone made tokens with the Nooscape name (19 October 2026). The site says, in the footer, on the page that says what it is not and in
  // the Terms, that it has issued none. A change that would make that false is a change to these pages first.
  it("says so on the home footer, the about page and the Terms, in the same words", () => {
    expect(page("Home")).toContain("Nooscape has issued no token on any chain and is not connected to any token that uses its name. Nothing here is an offer to sell a token or a place to buy one.");
    expect(page("WhatNooscapeIs")).toContain("Nooscape has issued no token on any chain and is not connected to any token that uses its name. Nothing on this site is an offer to sell a token or a place to buy one.");
    expect(page("Terms")).toContain("Nooscape has issued no token or coin on any chain, and is not connected to any token that uses its name. Nothing on this site is an offer to sell a token or a place to buy one.");
  });

  it("is not contradicted by the code: nothing here deploys, mints or sells a token of its own", () => {
    const own = [...clientSources, ...serverSources].filter(source => /\b(deployContract|createToken|launchToken|bondingCurve)\b/.test(source.text));
    expect(own.map(source => source.file)).toEqual([]);
  });
});

describe("what the privacy, terms and developer pages say about watchlists and webhooks, held to the code", () => {
  const privacy = page("Privacy");
  const terms = page("Terms");
  const developers = page("DeveloperApi");
  const server = (file: string) => serverSources.find(source => source.file === file)!.text;
  const webhooks = server("webhooks.ts");
  const schemaText = read(join(app, "drizzle", "schema.ts"));
  const tables = schemaText.slice(schemaText.indexOf("export const apiWatches"), schemaText.indexOf("export const bscFeedbackEvents"));

  it("says how long events are kept, how many tries a delivery gets, how many failures turn a webhook off, and the limits, as the code has them", () => {
    expect(webhooks).toContain("export const KEEP_DELIVERIES_DAYS = 30;");
    expect(privacy).toContain("Delivered and given-up events are deleted after 30 days.");
    expect(developers).toContain("Events are kept for 30 days.");
    expect(webhooks).toContain("export const RETRY_AFTER_SECONDS: readonly number[] = [60, 300, 1_800, 7_200, 43_200];");
    expect(developers).toContain("tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, and then given up");
    expect(webhooks).toContain("export const DISABLE_AFTER_FAILURES = 20;");
    expect(developers).toContain("After 20 failed tries in a row the webhook is turned off");
    expect(webhooks).toContain("export const WATCH_LIMIT = 100;");
    expect(webhooks).toContain("export const WATCH_ADD_LIMIT = 25;");
    expect(developers).toContain("Watch up to 25 listings in one call and 100 in all.");
    expect(server("apiWebhooks.ts")).toContain("export const WEBHOOK_CHANGES_PER_MINUTE = 6;");
    expect(developers).toContain("Changes are limited to 6 a minute.");
  });

  it("keeps only what the privacy page lists: the tables hold no network address, user agent or email, and the secret is derived and never stored", () => {
    expect(tables).toContain('"api_watches"');
    expect(tables).toContain('"api_webhooks"');
    expect(tables).toContain('"api_deliveries"');
    expect(tables).toContain('"api_event_cursors"');
    const columns = Array.from(tables.matchAll(/(?:varchar|int|bigint|tinyint|boolean|timestamp)\("(\w+)"/g)).map(match => match[1]);
    expect(columns).toEqual([
      ...["keyId", "entryId", "visible", "createdAt"],
      ...["keyId", "url", "secretVersion", "failures", "disabledAt", "createdAt", "updatedAt"],
      ...["id", "seq", "keyId", "eventRef", "kind", "entryId", "body", "status", "attempts", "nextAttemptAt", "lastStatus", "lastError", "createdAt", "sentAt"],
      ...["name", "position", "updatedAt"],
    ]);
    expect(privacy).toContain("The signing secret is not stored. It is worked out from a secret of ours, the key&rsquo;s id and a version number");
    expect(webhooks).toContain('createHmac("sha256", signingKey).update(`nooscape-webhook:${keyId}:${version}`)');
  });

  it("says events are sent from our server through the same guarded fetch, to an https address that is checked again each time, and that the address is the owner's to answer for", () => {
    const pass = server("webhookPass.ts");
    expect(pass).toContain('safeFetch(url, { method: "POST"');
    expect(webhooks).toContain("checkFetchTarget(raw)");
    expect(terms).toContain("Set only an address that you own or have permission to send to");
    expect(privacy).toContain("Nooscape sends each event from its server to the address you gave.");
    expect(terms).toContain("turn a webhook off after repeated failures");
  });

  it("says an event holds what the public API already shows and never an owner's words: the claim event carries the kind and the field, not the text", () => {
    expect(developers).toContain("never what an owner wrote");
    expect(privacy).toContain("A message holds facts the public API already shows");
    const pass = server("webhookPass.ts");
    expect(pass).toContain("wallet: SIGNED_KINDS.includes(fact.kind) ? fact.wallet : null");
    expect(developers).toContain("that a rating was added or taken back (Robinhood Chain only, and no more than that, because this API gives counts)");
    expect(privacy).toContain("Removing the webhook erases its address and keeps the version number");
    expect(pass).not.toMatch(/oldValue|newValue|old_value|new_value/);
    expect(server("webhookEvents.ts")).not.toMatch(/oldValue|newValue/);
  });
});
