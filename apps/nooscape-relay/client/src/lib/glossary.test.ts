import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { directoryFunnelStepCopy, glossary, notYetMeasurable, type GlossaryKey } from "./glossary";

/**
 * The glossary: that every name of a place on the site says literally what it is, that none of it is a score or a
 * ranking, that it carries no long dash, and that each name carries its definition where it is shown. The repo has no
 * browser test runner, so placement is checked in the source.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LONG_DASH = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");
/** The apostrophe a page may draw as a typographic one, so a name can be compared with its text. */
const plain = (text: string) => text.replace(/&rsquo;|’/g, "'");

const NAMES: Array<[GlossaryKey, string]> = [
  ["noosphere", "The Noosphere"],
  ["steadyLight", "Steady light"],
  ["dimCluster", "Dim cluster"],
  ["regions", "Regions"],
  ["askTheOwl", "Ask the Owl"],
  ["dossier", "Dossier"],
  ["clearTheFog", "Clear the Fog"],
  ["fleetSightings", "Fleet sightings"],
  ["fieldReports", "Field Reports"],
  ["owlsCatch", "Owl's Catch"],
  ["yourWatch", "Your Watch"],
  ["patrols", "Patrols"],
  ["howTheOwlSees", "How the Owl sees"],
  ["owlsLastSweep", "Owl's last sweep"],
];

describe("every entry", () => {
  it("has a title and a sentence, and no two share a title", () => {
    const titles = Object.values(glossary).map(entry => entry.title);
    for (const [key, entry] of Object.entries(glossary)) {
      expect(entry.title.trim().length, key).toBeGreaterThan(1);
      expect(entry.sentence.trim().length, key).toBeGreaterThan(20);
    }
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("carries no long dash, in the entries or in the funnel's and the unknowns' words", () => {
    const words = [
      ...Object.values(glossary).flatMap(entry => [entry.title, entry.sentence]),
      ...Object.values(directoryFunnelStepCopy).flatMap(copy => [copy.label, copy.note]),
      ...notYetMeasurable.flatMap(item => [item.title, item.sentence]),
    ];
    for (const text of words) expect(text).not.toMatch(LONG_DASH);
  });
});

describe("the names of the places", () => {
  it("are all in the glossary, under the names the places go by", () => {
    for (const [key, title] of NAMES) expect(glossary[key]?.title, key).toBe(title);
  });

  it("each say literally what the place is, in one sentence that fits a tooltip", () => {
    for (const [key] of NAMES) {
      const { sentence } = glossary[key];
      expect(sentence.length, key).toBeLessThanOrEqual(200);
      expect((sentence.match(/[.!?](\s|$)/g) ?? []).length, key).toBeLessThanOrEqual(2);
    }
    expect(glossary.noosphere.sentence).toMatch(/map of agents/);
    expect(glossary.noosphere.sentence).toMatch(/coloured by its chain/);
    expect(glossary.steadyLight.sentence).toMatch(/evidence on record/);
    expect(glossary.steadyLight.sentence).toMatch(/not that the agent is good/);
    expect(glossary.dimCluster.sentence).toMatch(/many agents recorded against one registering wallet/);
    expect(glossary.dimCluster.sentence).toMatch(/not who runs them or whether anything is wrong/);
    expect(glossary.regions.sentence).toMatch(/Robinhood Chain, BNB Chain and Solana/);
    expect(glossary.askTheOwl.sentence).toMatch(/agent search in the Deep map/);
    expect(glossary.dossier.sentence).toMatch(/all the evidence Nooscape has on record/);
    expect(glossary.clearTheFog.sentence).toMatch(/Nothing is deleted/);
    expect(glossary.fleetSightings.sentence).toMatch(/only signal so far/);
    expect(glossary.fieldReports.sentence).toMatch(/stamped by the block/);
    expect(glossary.owlsCatch.sentence).toMatch(/not by hand/);
    expect(glossary.yourWatch.sentence).toMatch(/agents you follow/);
    expect(glossary.patrols.sentence).toMatch(/reviewed before anything is published/);
    expect(glossary.howTheOwlSees.sentence).toMatch(/read the registries, group the fleets, show the evidence/);
    expect(glossary.owlsLastSweep.sentence).toMatch(/last read a chain successfully/);
  });

  it("claim no score, rank, verdict or grade, and say 'score' only to deny it", () => {
    for (const [key] of NAMES) {
      const { sentence } = glossary[key];
      expect(sentence, key).not.toMatch(/\b(rank|ranked|ranking|verdict|grade|rating|top|best|trusted|safe|verified)\b/i);
      for (const match of sentence.matchAll(/\bscores?\b/gi)) {
        const before = sentence.slice(Math.max(0, match.index - 30), match.index);
        expect(before, `${key}: ${before}`).toMatch(/\b(not|never|no)\b/i);
      }
    }
  });

  it("do not promise what is not there: no payment, listing or placement can change a light", () => {
    expect(glossary.noosphere.sentence).toMatch(/never from a score or a payment/);
  });
});

describe("where the names carry their definitions", () => {
  // [file, key, the text as the page writes it]. A name on a section is a Term; a name on a button is a TermTip around the button, so it adds no stop of its own.
  const PLACES: Array<[string, GlossaryKey, string]> = [
    ["../pages/home/LandingHero.tsx", "noosphere", "The Noosphere"],
    ["../components/home/ChainTabs.tsx", "regions", "Regions"],
    ["../pages/DirectoryAgent.tsx", "dossier", "Dossier"],
    ["../components/home/NoiseFunnel.tsx", "clearTheFog", "Clear the Fog"],
    ["../components/home/FleetCards.tsx", "fleetSightings", "Fleet sightings"],
    ["../components/home/FieldNotes.tsx", "fieldReports", "Field Reports"],
    ["../components/home/OwlsCatch.tsx", "owlsCatch", "Owl&rsquo;s Catch"],
    ["../components/home/HowItWorks.tsx", "howTheOwlSees", "How the Owl sees"],
  ];

  it("are Terms on the eyebrow of each section, named exactly as the glossary names them", () => {
    for (const [file, key, text] of PLACES) {
      expect(read(file), file).toContain(`<p className="eyebrow"><Term k="${key}">${text}</Term></p>`);
      expect(plain(text), key).toBe(glossary[key].title);
    }
  });

  it("are on the legend's steady light and dim cluster and the sweep heading, through the one helper that splits a line at its label", () => {
    const scene = read("../components/home/HeroScene.tsx");
    expect(scene).toContain('<Defined k="steadyLight" text={LEGEND.steady} />');
    expect(scene).toContain('<Defined k="dimCluster" text={LEGEND.fleet} />');
    expect(scene).toContain('<Defined k="owlsLastSweep" text={sweepHeading(latestSweepAt(rows), statsStatus)} />');
    const defined = read("../components/home/Defined.tsx");
    expect(defined).toContain("export function Defined({ k, text }: { k: GlossaryKey; text: string }) {");
    expect(defined).toContain("const { label, rest } = splitLabel(text);");
    expect(scene).toContain('import { Defined } from "./Defined";');
    // The status line under the scan map says the sweep through the same helper.
    expect(read("../components/home/ScanStatusLine.tsx")).toContain('<Defined k="owlsLastSweep" text={sweep} />');
  });

  it("are on both Ask the Owl buttons as a tip around the button, never a focusable term inside it", () => {
    const scene = read("../components/home/HeroScene.tsx");
    const header = read("../components/home/SiteHeader.tsx");
    expect(scene).toContain('<TermTip k="askTheOwl">');
    expect(header).toContain('<TermTip k="askTheOwl">');
    for (const [file, source] of [["HeroScene", scene], ["SiteHeader", header]] as const) {
      const button = source.slice(source.indexOf('<TermTip k="askTheOwl">'), source.indexOf("</TermTip>"));
      expect(button, file).toContain("<Button");
      expect(button, file).not.toContain("<Term ");
    }
    const component = read("../components/Term.tsx");
    expect(component).toContain("export function TermTip(");
    expect(component).toMatch(/export function Term\(\{ k, children \}[^)]*\)[\s\S]*?tabIndex=\{0\}/);
    expect(component.slice(component.indexOf("export function TermTip("))).not.toContain("tabIndex");
  });

  it("fall back to the plain words when a name has no entry, so copy can ship before its definition", () => {
    const component = read("../components/Term.tsx");
    expect(component).toContain("if (!glossary[k]) return <>{children}</>;");
    expect(component).toContain("if (!glossary[k]) return children;");
  });
});

describe("the regions sentence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("names the extra chains whose switch is on in the build, as the Home tabs do, and counts them", async () => {
    vi.stubEnv("VITE_FEATURES", "chain_base,chain_arc");
    vi.resetModules();
    const { glossary: switched } = await import("./glossary");
    expect(switched.regions.sentence).toBe("Robinhood Chain, BNB Chain, Solana, Base and Arc: the five places Nooscape reads agent registries. Pick one to see only its counts.");
  });

  it("is the sentence it has always been while no extra chain is on", async () => {
    vi.stubEnv("VITE_FEATURES", "");
    vi.resetModules();
    const { glossary: plain } = await import("./glossary");
    expect(plain.regions.sentence).toBe("Robinhood Chain, BNB Chain and Solana: the three places Nooscape reads agent registries. Pick one to see only its counts.");
  });
});
