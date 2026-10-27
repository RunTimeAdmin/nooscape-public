import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOTES_LIMIT } from "@/components/home/fieldNotesModel";
import { directoryFunnelStepCopy } from "@/lib/glossary";

/**
 * The home page's shape: which sections it has, in what order, and what each says. There is no browser test
 * runner in the repo, so these read the source for the parts the briefs make rules of; a run in a real browser
 * checked the heights, the order on the screen, the equal rows and the rest.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const home = read("./Home.tsx");
const model = read("./home/atlasModel.ts");
const evidence = read("./home/LandingEvidence.tsx");
const hero = read("./home/LandingHero.tsx");
const app = read("../App.tsx");
const css = read("../index.css");
const funnel = read("../components/home/NoiseFunnel.tsx");
const fleets = read("../components/home/FleetCards.tsx");
const chains = read("../components/home/ChainTabs.tsx");
const notes = read("../components/home/FieldNotes.tsx");
const catchCard = read("../components/home/OwlsCatch.tsx");
const how = read("../components/home/HowItWorks.tsx");

const order = (source: string, markers: string[]) => markers.map(marker => source.indexOf(marker));
const ascending = (indexes: number[]) => indexes.every((index, i) => index > -1 && (i === 0 || index > indexes[i - 1]!));
/** The words of a JSX string without its tags and braces, and how many sentences it has. */
const sentences = (jsx: string) => (jsx.replace(/<[^>]+>/g, "").replace(/[{}]/g, "").match(/[.!?](\s|$)/g) ?? []).length;

const homeBranch = home.slice(home.indexOf('{view === "home" ? ('), home.indexOf(") : ("));
const fieldBranch = read("./home/FieldView.tsx");

describe("the order of the home page", () => {
  it("is the hero, the scan map, then the evidence, and nothing else in between", () => {
    expect(ascending(order(homeBranch, ["<HeroScene", "<LandingHero", "<LandingEvidence"]))).toBe(true);
    expect(home.match(/<HeroScene/g)).toHaveLength(1);
  });

  it("goes funnel and fleet sightings, regions, field reports with the Owl's Catch beside them, how the Owl sees", () => {
    expect(ascending(order(evidence, ["<NoiseFunnel", "<FleetCards", "<ChainTabs", "<FieldNotes", "<OwlsCatch", "<HowItWorks"]))).toBe(true);
  });

  it("holds the funnel and the fleet sightings in one row, which stretches them to the same height", () => {
    expect(evidence).toContain('<div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.1fr_.9fr]">');
    expect(css).toContain(".noise-funnel { container-type: inline-size; display: flex; flex-direction: column; height: 100%;");
    expect(fleets).toContain('className="flex h-full flex-col rounded-2xl');
    expect(fleets).toContain('className="mt-auto pt-3 ');
    expect(css).toMatch(/\.fog-how \{ margin-top: auto;/);
  });
});

describe("the full field", () => {
  const OLDER = ['className="protocol-ribbon', 'aria-label="What we can prove"', "observatory-frame", 'aria-label="What nobody can measure yet"', 'aria-label="Money moving on Robinhood"', "command-panel"];

  it("keeps the older sections, none of them on the home page", () => {
    for (const marker of OLDER) {
      expect(homeBranch, `${marker} on the home page`).not.toContain(marker);
      expect(fieldBranch, `${marker} on the full field`).toContain(marker);
    }
  });

  it("says what the evidence filter can prove, in plain names that sort every agent once, at a readable size", () => {
    expect(fieldBranch).toContain('<p className="eyebrow text-[#BFFF76]">What we can prove</p>');
    expect(fieldBranch).toContain("Filter agents by the evidence on record.");
    const names = ["All agents", "Owner-verified", "Website-verified", "No proof yet"];
    expect([...fieldBranch.matchAll(/label: "([^"]+)", Icon:/g)].map(match => match[1])).toEqual(names);
    for (const old of ["Evidence boundary", "Publisher verified", "Domain verified", "Unverified Tier 2", "All records"]) expect(fieldBranch, old).not.toContain(old);
    // The counts come from one pass that puts each agent in one group, so the three add up to the total.
    expect(fieldBranch).toContain("const trustPopulation = useMemo(() => countByEvidenceGroup(agents), [agents]);");
    expect(home).toContain('const matchesTrust = trustFilter === "all" || evidenceGroup(agent) === trustFilter;');
    const panel = fieldBranch.slice(fieldBranch.indexOf('aria-label="What we can prove"'), fieldBranch.indexOf("</section>", fieldBranch.indexOf('aria-label="What we can prove"')));
    expect(panel).toContain("font-mono text-xs uppercase");
    expect(panel).not.toMatch(/text-\[\d+(\.\d+)?px\]/);
  });

  it("is the home page unless it is asked for the field", () => {
    expect(home).toContain('export default function Home({ view = "home" }: { view?: "home" | "field" }) {');
  });

  it("is a page at /field with a heading, a way back, and a link in the menu", () => {
    expect(app).toContain('<Route path="/">{() => <Home key="home" />}</Route>');
    expect(app).toContain('<Route path="/field">{() => <Home key="field" view="field" />}</Route>');
    expect(fieldBranch).toContain('<h1 className="mt-2 text-3xl font-medium tracking-[-.04em] text-[#F2FFF5]">The field, in full</h1>');
    expect(fieldBranch).toContain("Back to the Noosphere");
    expect(read("../components/home/headerModel.ts")).toContain('{ label: "The full field", href: "/field" },');
  });

  it("takes a link to a home section from there back to the home page, and an arriving link lands on its section", () => {
    const header = read("../components/home/SiteHeader.tsx");
    expect(header).toContain("if (!document.getElementById(id) && goHome) {");
    expect(header).toContain("goHome(`/${href}`);");
    expect(header).toContain("scrollToAnchor(event, link.href, undefined, navigate)");
    expect(home).toContain("const id = window.location.hash.slice(1);");
    expect(home).toContain('if (view !== "home" || !id || id === "deep-space") return;');
    // It keeps the section in place while the page grows above it, and gives up the moment the reader scrolls or presses a key.
    expect(home).toContain("if (Math.abs(target.getBoundingClientRect().top - offset) > 4) {");
    expect(home).toContain("if (steady >= 8 || ticks > 60) stop();");
    expect(home).toContain('const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;');
  });

  it("underlines the links in the field reports, which are in running text and would otherwise differ from it by colour alone", () => {
    expect(notes).toContain('className="text-[#BFFF76] underline underline-offset-4 hover:text-ns-ink">{note.displayName}</Link>');
    expect(notes).toContain('className="text-ns-radar underline underline-offset-4 hover:text-ns-ink">The full record is on the What changed page.</Link>');
  });
});

describe("the footer", () => {
  const footer = home.slice(home.indexOf("<footer"), home.indexOf("</footer>"));

  it("holds How we count, on the home page only, and says what Nooscape does not do", () => {
    expect(footer).toContain('{view === "home" && (');
    expect(footer).toContain('<details data-owl-avoid="" className="how-we-count');
    expect(home.match(/how-we-count/g)).toHaveLength(1);
    expect(footer).toContain("Nooscape doesn&rsquo;t hold funds, sell placement, or rank agents.");
    expect(footer).not.toMatch(/text-\[9px\]/);
  });
});

describe("what each section is called, and how much it says", () => {
  it("uses the Noosphere brief's names for the places", () => {
    // Each name is a glossary term, so its meaning is one hover away (lib/glossary.test.ts checks the definitions).
    expect(hero).toContain('<p className="eyebrow"><Term k="noosphere">The Noosphere</Term></p>');
    expect(funnel).toContain('<p className="eyebrow"><Term k="clearTheFog">Clear the Fog</Term></p>');
    expect(fleets).toContain('<p className="eyebrow"><Term k="fleetSightings">Fleet sightings</Term></p>');
    expect(chains).toContain('<p className="eyebrow"><Term k="regions">Regions</Term></p>');
    expect(chains).toContain('<TabsList aria-label="Regions"');
    expect(notes).toContain('<p className="eyebrow"><Term k="fieldReports">Field Reports</Term></p>');
    expect(catchCard).toContain('<p className="eyebrow"><Term k="owlsCatch">Owl&rsquo;s Catch</Term></p>');
    expect(how).toContain('<p className="eyebrow"><Term k="howTheOwlSees">How the Owl sees</Term></p>');
  });

  it("gives each section one sentence of lead-in, and its method elsewhere", () => {
    const leads = [
      "Hover or tap a light to read what its evidence says; nothing here is a score.",
      "Most of what registries list has never been checked by anyone; Clear the Fog dims the steps that only count listings.",
      'Grouped by <Term k="registrant">registering wallet</Term> today, with more signals to come; a long list is worth a look, not a verdict.',
      "The same public rules for every region: nothing hidden, withdrawn or unapproved is counted.",
      "The newest events measured on the ERC-8004 registry, {stamp}; the chain keeps no timestamps, so each is stamped by block.",
      "One find a day, picked by a fixed rule and not by hand; a count, never a score.",
    ];
    const sources = [hero, funnel, fleets, chains, notes, catchCard];
    leads.forEach((lead, index) => {
      expect(sources[index], lead).toContain(lead);
      expect(sentences(lead), lead).toBe(1);
    });
  });

  it("gives the Solana field reports their own one sentence of lead-in, in words the data supports", () => {
    const lead = "The latest events from each of the SAID, 8004 and Metaplex registries, newest first; each is stamped by when the Owl recorded it, which bounds when it happened.";
    expect(notes).toContain(lead);
    expect(sentences(lead)).toBe(1);
  });

  it("shows six field reports, not twelve", () => {
    expect(NOTES_LIMIT).toBe(6);
  });

  it("says how the Owl sees in the brief's three steps and its closing line, with no figure", () => {
    for (const title of ["Read the registries", "Group the fleets", "Show the evidence"]) expect(how).toContain(`title: "${title}"`);
    expect(how).not.toContain('title: "You decide"');
    expect(how).toContain("No one can pay to glow brighter. Not even us.");
    expect(how.match(/title: "/g)).toHaveLength(3);
  });

  it("keeps the funnel's notes short and free of long dashes", () => {
    for (const [key, copy] of Object.entries(directoryFunnelStepCopy)) {
      expect(copy.note, key).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
      expect(copy.note.split(/\s+/).length, key).toBeLessThanOrEqual(16);
    }
  });
});

describe("a look of its own for each section", () => {
  it("draws the scan map as radar on the night, the funnel as noise on the void, the regions on the dusk, the reports as a mono log", () => {
    expect(hero).toContain('className="radar-grid relative mb-5 rounded-[1.5rem] p-4 sm:p-6"');
    expect(css).toMatch(/\.radar-grid \{[^}]*background-color: var\(--ns-night\);[^}]*repeating-radial-gradient/);
    expect(css).toMatch(/\.noise-funnel \{[^}]*background: var\(--ns-void\);/);
    expect(chains).toContain('className="regions rounded-2xl p-5"');
    expect(css).toMatch(/\.regions \{[^}]*background: var\(--ns-dusk\);/);
    expect(notes).toContain('className="field-log rounded-2xl p-5"');
    expect(css).toMatch(/\.field-log-row \{[^}]*font-family: "DM Mono"/);
  });

  it("gives each region's figures a top border in that region's own colour, and sets the colour on the panel as well as the tab", () => {
    expect(css).toMatch(/\.chain-figure \{[^}]*border-top: 3px solid var\(--chain\);/);
    expect(chains).toContain('<div className="chain-figure rounded-xl p-4">');
    expect(chains).toContain('<TabsContent key={chain} value={chain} style={{ "--chain": `var(${chainColorVar(chain)})` } as CSSProperties}');
    expect(chains.match(/\{ "--chain": `var\(\$\{chainColorVar\(chain\)\}\)` \}/g) ?? chains.match(/"--chain": `var\(\$\{chainColorVar\(chain\)\}\)`/g)).toHaveLength(2);
  });

  it("keeps the room the owl's perch needs above the scan map, however short its words are", () => {
    expect(hero).toContain('<div data-owl-avoid="" className="max-w-3xl xl:min-h-[7rem]">');
    expect(hero).toContain('data-owl-perch="top-right" data-owl-topic="records"');
  });

  it("sets how the Owl sees in big numerals beside a line drawing that holds no words", () => {
    expect(css).toMatch(/\.how-numeral \{[^}]*font-size: clamp\(2\.5rem, 5vw, 3\.5rem\);/);
    expect(how).toContain('<OwlLineArt className="how-owl hidden md:block" />');
    const art = read("../components/home/OwlLineArt.tsx");
    expect(art).toContain('aria-hidden="true"');
    expect(art).not.toMatch(/<text|<title|aria-label/);
  });
});

describe("what the home page asks the server for", () => {
  it("reads the selected record's evidence when it opens and then every minute, only on the field view or with Deep Space open", () => {
    // The answer feeds the field aside and Deep Space and nothing on the home view; on the home view the call was half of the page's requests.
    const call = home.slice(home.indexOf("trpc.atlas.evidence.useQuery({ agentId: selected?.id"), home.indexOf("const activeEvidence"));
    expect(call).toContain('enabled: Boolean(selected) && (view === "field" || deepSpace)');
    expect(call).toContain("...EVIDENCE_POLL");
    expect(model).toContain("export const EVIDENCE_POLL = { refetchInterval: 60_000, refetchOnWindowFocus: true } as const;");
    expect(home).not.toContain("refetchInterval: 8_000");
  });

  it("formats no time for a record it does not show", () => {
    const mapRecord = model.slice(model.indexOf("export function mapLiveRecord"), model.indexOf("export function isDomainVerifiedAgent"));
    // The slice is the function, not an empty string left by a name that moved.
    expect(mapRecord).toContain("toPublisherState(record.publisherState)");
    expect(mapRecord).not.toContain("toLocaleTimeString");
  });
});
