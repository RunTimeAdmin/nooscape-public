import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Deep Space and the full field page are files of their own that Home fetches when they are first wanted (a click or a #deep-space
 * link, and the /field address), so the page everyone lands on does not carry them. The saving is real only while nothing in the
 * first bundle imports them, so this holds the import rules; the sizes themselves were read from a production build (each is a chunk
 * of its own, listed apart from the main one).
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const home = read("../Home.tsx");
const model = read("./atlasModel.ts");
const parts = read("./atlasParts.tsx");
const firstBundle = [["Home.tsx", home], ["atlasModel.ts", model], ["atlasParts.tsx", parts]] as const;

describe("Deep Space", () => {
  it("is loaded by Home through lazy(), for the map and for the comparison panel", () => {
    expect(home).toContain('const DeepSpaceMap = lazy(() => import("./home/DeepSpace"));');
    expect(home).toContain('const AgentComparisonPanel = lazy(() => import("./home/DeepSpace").then(module => ({ default: module.AgentComparisonPanel })));');
  });

  it("is imported statically by nothing the first bundle holds", () => {
    for (const [name, source] of firstBundle) expect(source, name).not.toMatch(/^import [^\n]*from "\.\/(home\/)?DeepSpace";/m);
  });

  it("focuses its own search field when it opens with the search asked for, because the opener's focus call comes before the file arrives", () => {
    const deep = read("./DeepSpace.tsx");
    expect(deep).toMatch(/useEffect\(\(\) => \{\n\s+if \(searchOpen\) searchRef\.current\?\.focus\(\);\n\s+\}, \[\]\);/);
    expect(home).toContain("window.requestAnimationFrame(() => agentSearchRef.current?.focus());");
  });

  it("is covered by a fallback that is the same opaque overlay, so the page is hidden from the click", () => {
    expect(home).toContain("<Suspense fallback={<DeepSpaceOpening />}>");
    expect(home).toContain('<div className="deep-space-overlay" role="status" aria-label="Opening Deep Space">');
  });
});

describe("the full field", () => {
  it("is loaded by Home through lazy(), and imported statically by nothing the first bundle holds", () => {
    expect(home).toContain('const FieldView = lazy(() => import("./home/FieldView"));');
    for (const [name, source] of firstBundle) expect(source, name).not.toMatch(/^import [^\n]*from "\.\/(home\/)?FieldView";/m);
  });

  it("is given the page's data and handlers and keeps its own state, so the home page computes nothing for it", () => {
    expect(home).toContain("<FieldView agents={agents}");
    expect(home).not.toMatch(/\buseElementSize\(/);
    expect(home).not.toContain("pickFeaturedAgents(");
    expect(read("./FieldView.tsx")).toContain('const [lens, setLens] = useState<Lens>("field");');
  });
});

describe("the parts both of them draw", () => {
  it("are not imported by Home, so they travel with whichever of the two is fetched first", () => {
    expect(home).not.toMatch(/from "\.\/home\/atlasParts"/);
  });
});

describe("the model Home and the on-demand parts share", () => {
  it("imports no component and draws nothing, so any of them can import it", () => {
    expect(model).not.toMatch(/^import [^\n]*from "\.\//m);
    expect(model).not.toMatch(/<[A-Z][A-Za-z]*[ />]/);
    expect(model).not.toMatch(/\buse[A-Z][A-Za-z]*\(/);
  });
});
