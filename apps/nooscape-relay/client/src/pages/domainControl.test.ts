import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUPPORT_EMAIL } from "../lib/contacts";

/**
 * The page that tells an operator how to ask for Tier 3 makes claims the code can break: the address the proof is published at,
 * how long a challenge lasts, how long Tier 3 lasts, how much of the file is read, and who may start it. Each is held to the file
 * that decides it, so a change there fails this test and names the page to change. Guarded at the source because the repo has no
 * browser test runner.
 */
const client = fileURLToPath(new URL("..", import.meta.url));
const app = join(client, "..", "..");
const read = (path: string) => readFileSync(path, "utf8");
const page = read(join(client, "pages", "DomainControl.tsx"));
const text = page.replace(/\/\*[\s\S]*?\*\//g, " ");

describe("the domain control page", () => {
  it("is routed, listed for the server, given a head and listed in the sitemap", () => {
    expect(read(join(client, "App.tsx"))).toContain('<Route path="/domain-control" component={DomainControl} />');
    expect(read(join(app, "server", "clientRoutes.ts"))).toContain('"/domain-control"');
    expect(read(join(app, "server", "routeHead.ts"))).toContain('"/domain-control"');
    expect(read(join(app, "client", "public", "sitemap.xml"))).toContain("<loc>https://nooscape.si/domain-control</loc>");
  });

  it("names the address the proof is published at that the server fetches", () => {
    const server = read(join(app, "server", "domainVerification.ts"));
    expect(server).toContain("/.well-known/nooscape-domain-verification/${challengeId}.txt");
    expect(text).toContain("/.well-known/nooscape-domain-verification/&lt;challenge-id&gt;.txt");
  });

  it("says a challenge lasts 48 hours, Tier 3 lasts 90 days and at most 4 KiB is read, as the code does", () => {
    expect(read(join(app, "server", "routers", "liveData.ts"))).toContain("new Date(Date.now() + 48 * 60 * 60 * 1_000)");
    expect(text).toContain("good for 48 hours");
    expect(read(join(app, "server", "db.ts"))).toContain("export const DOMAIN_VERIFICATION_VALIDITY_DAYS = 90;");
    expect(text).toContain("Tier 3 lasts 90 days");
    expect(read(join(app, "server", "domainVerification.ts"))).toContain("const MAX_PROOF_BYTES = 4 * 1024;");
    expect(text).toContain("at most 4 KiB");
  });

  it("says the fetch follows no redirect and never calls the agent, as the verifier does", () => {
    const server = read(join(app, "server", "domainVerification.ts"));
    expect(server).toMatch(/never calls an agent endpoint or follows a redirect/);
    expect(text).toContain("follow no redirect");
    expect(text).toContain("never call your agent");
  });

  it("keeps the decision with a person and promises no automatic upgrade, no price and no reply time", () => {
    expect(text).toContain("A person at Nooscape decides each request");
    expect(text).toContain("we may say no");
    expect(text).toContain("We never take money to change a record or its level");
    expect(text).not.toMatch(/REPLY_WITHIN|business day|24[\s-]?hours?/i);
    expect(text).not.toMatch(/\bautomatic(ally)?\b|\binstant(ly)?\b/i);
  });

  it("reads the address from lib/contacts.ts and never writes one out", () => {
    expect(SUPPORT_EMAIL).toBe("support@nooscape.si");
    expect(page).toContain("SUPPORT_EMAIL");
    expect(page).not.toMatch(/@nooscape\.si/);
  });

  it("lists the steps in the order they happen: write, receive the challenge, publish the file, say it is up", () => {
    const steps = ["Write to", "We reply with a challenge", "Publish the token as plain text", "Tell us it is up"].map(step => text.indexOf(step));
    expect(steps.every(index => index >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it("says what Tier 3 does not mean: no entity, no publisher key, no safety, and the publisher state stays unverified", () => {
    for (const phrase of ["legal entity", "publisher key", "publisher state stays unverified", "safe or available"]) expect(text, phrase).toContain(phrase);
  });

  it("has no long dash", () => {
    expect(page).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
  });
});

describe("the link from a record", () => {
  const record = read(join(client, "pages", "DirectoryAgent.tsx"));

  it("is shown for a Tier 2 record only, in the block that explains its labels", () => {
    expect(record).toContain('{record.evidenceTier === "tier_2" && (');
    const link = record.indexOf('href="/domain-control"');
    expect(link).toBeGreaterThan(record.indexOf("What these labels mean"));
    expect(record.lastIndexOf('{record.evidenceTier === "tier_2" && (', link)).toBeGreaterThan(record.indexOf("What these labels mean"));
    expect(record.slice(record.lastIndexOf('{record.evidenceTier === "tier_2" && (', link), link)).not.toContain("tier_3");
  });
});
