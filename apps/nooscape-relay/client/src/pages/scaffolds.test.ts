import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { glossary } from "@/lib/glossary";

/**
 * The Your Watch and Patrols scaffolds are pages behind switches (shared/features.ts) that say what they are for and
 * that nothing works yet. The repo has no browser test runner, so these read the source for what the brief makes
 * rules of: the words it gives, no reward of any kind in them, no way to save or send anything, and no way in until a
 * switch is on. What they draw, and that they are off by default, was checked in a real browser against the built
 * server.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const watch = read("./Watch.tsx");
const patrols = read("./Patrols.tsx");
const shell = read("../components/ScaffoldPage.tsx");
const app = read("../App.tsx");

describe("the words", () => {
  it("are the brief's, for Your Watch", () => {
    expect(watch).toContain('lead="Keep an eye on the agents you care about. The Owl tells you when their record changes."');
    expect(watch).toContain('<Term k="yourWatch">Your Watch</Term>');
    expect(watch).toContain('title="Your Watch"');
  });

  it("are the brief's, for Patrols", () => {
    expect(patrols).toContain('lead="Spot a fleet the Owl missed? File a patrol report. Confirmed reports go into Field Reports."');
    expect(patrols).toContain('<Term k="patrols">Patrols</Term>');
    expect(patrols).toContain('title="Patrols"');
  });

  it("say plainly that the page is not open yet", () => {
    expect(watch).toContain("Your Watch is not open yet. Nothing on this page saves or sends anything.");
    expect(patrols).toContain("Patrols are not open yet, so there is nothing to file.");
  });

  it("offer no reward, payout, token, points or price of any kind", () => {
    const words = [watch, patrols, shell, glossary.yourWatch.sentence, glossary.patrols.sentence].map(stripComments).join("\n");
    expect(words).not.toMatch(/\b(rewards?|bount(?:y|ies)|payouts?|pays?|paid|earn(?:s|ed|ing)?|airdrops?|points?|prizes?|tokens?|stak(?:e|es|ed|ing)|yield|tips?|free|win|wins)\b/i);
    // A currency sign or an amount; the `${...}` of a template string is code, not an amount.
    expect(words).not.toMatch(/[€£]|\$\s?\d/);
  });

  it("claim no score, and carry the line that nothing is ranked or sold", () => {
    const words = [watch, patrols, shell].map(stripComments).join("\n");
    expect(words).not.toMatch(/\bscores?\b/i);
    expect(words).not.toMatch(/\d+\s*\/\s*100/);
    expect(shell).toContain("Nooscape doesn&rsquo;t hold funds, sell placement, or rank agents.");
  });
});

describe("what the pages can do", () => {
  it("is nothing: no form, no input, no wallet, no read of the server and no write", () => {
    const code = [watch, patrols, shell].map(stripComments).join("\n");
    expect(code).not.toMatch(/<form\b|<input\b|<textarea\b|<button\b|<select\b/i);
    expect(code).not.toMatch(/trpc|fetch\(|localStorage|sessionStorage|XMLHttpRequest|navigator\.|window\.ethereum|useMutation|useQuery/);
    expect(code).not.toMatch(/\bwallet\b|\bsign(?:ature|ed|ing)?\b/i);
  });
});

describe("the way in", () => {
  it("is a route behind its own switch, and nothing else links to the pages", () => {
    expect(app).toContain('{featureOn("watch", FEATURES) && <Route path="/watch" component={Watch} />}');
    expect(app).toContain('{featureOn("patrols", FEATURES) && <Route path="/patrols" component={Patrols} />}');
    expect(app).toContain("const FEATURES: string | undefined = import.meta.env.VITE_FEATURES;");
    for (const file of ["../components/home/SiteHeader.tsx", "../components/home/headerModel.ts", "../pages/Home.tsx", "../pages/DirectoryAgent.tsx", "../pages/Catch.tsx"]) {
      expect(read(file), file).not.toMatch(/["'`]\/(watch|patrols)["'`/]/);
    }
  });

  it("is lazy, so a visitor who never turns them on never loads them", () => {
    expect(app).toContain('const Watch = lazy(() => import("./pages/Watch"));');
    expect(app).toContain('const Patrols = lazy(() => import("./pages/Patrols"));');
  });

  it("does not put the pages in the sitemap while they are scaffolds", () => {
    const sitemap = readFileSync(new URL("../../public/sitemap.xml", import.meta.url), "utf8");
    expect(sitemap).not.toMatch(/\/(watch|patrols)\b/);
  });
});
