import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_PROTOCOLS, DEFAULT_FILTERS, filtersFromSearch, liveFramework, searchWith, searchWithFilters, searchWithout, type HomeFilters } from "./homeFilters";

/** The home page's filters in the address: a refresh, a shared link and Back keep them. */
const set: HomeFilters = { query: "weather bot", framework: "A2A", evidence: "owner", sort: "evidence", trustedOnly: true, publisherState: "allowlisted" };

describe("the home page's filters in the address", () => {
  it("come back as they were written", () => {
    expect(filtersFromSearch(searchWithFilters("", set))).toEqual(set);
    expect(searchWithFilters("", set)).toBe("?q=weather+bot&protocol=A2A&evidence=owner&sort=evidence&trusted=1&state=allowlisted");
  });

  it("leave a plain address plain: a filter at its default is not written, and one set back to it is taken out", () => {
    expect(searchWithFilters("", DEFAULT_FILTERS)).toBe("");
    expect(searchWithFilters("?q=x&sort=name", DEFAULT_FILTERS)).toBe("");
    expect(filtersFromSearch("")).toEqual(DEFAULT_FILTERS);
  });

  it("keep the rest of the address: the agent and a comparison stay", () => {
    expect(searchWithFilters("?agent=abc&compare=a~b", { ...DEFAULT_FILTERS, sort: "name" })).toBe("?agent=abc&compare=a~b&sort=name");
    expect(searchWithFilters("?agent=abc&sort=name", DEFAULT_FILTERS)).toBe("?agent=abc");
    // A malformed part neither breaks the page nor is lost.
    expect(searchWithFilters("?%E0=1&q=old", { ...DEFAULT_FILTERS, query: "new" })).toBe("?%E0=1&q=new");
  });

  it("read a value the page does not offer as the default, and cut long text", () => {
    const odd = filtersFromSearch("?evidence=everyone&sort=random&trusted=yes&state=hacked&protocol=%20%20&q=" + "x".repeat(500));
    expect(odd.evidence).toBe("all");
    expect(odd.sort).toBe("network");
    expect(odd.trustedOnly).toBe(false);
    expect(odd.publisherState).toBe("all");
    expect(odd.framework).toBe(ALL_PROTOCOLS);
    expect(odd.query).toHaveLength(80);
  });

  it("fall back to all protocols when the records no longer carry the one asked for, once they are loaded", () => {
    const frameworks = [ALL_PROTOCOLS, "A2A", "MCP"];
    expect(liveFramework("A2A", frameworks, true)).toBe("A2A");
    expect(liveFramework("Gone", frameworks, true)).toBe(ALL_PROTOCOLS);
    // Before the records arrive, a protocol from a link is kept.
    expect(liveFramework("Gone", [ALL_PROTOCOLS], false)).toBe("Gone");
  });

  it("are read by the page when it starts and written back in place, with no history entry per keystroke", () => {
    const page = readFileSync(new URL("../Home.tsx", import.meta.url), "utf8");
    expect(page).toContain("filtersFromSearch(window.location.search)");
    expect(page).toContain("const search = searchWithFilters(window.location.search,");
    expect(page).toContain('window.history.replaceState(window.history.state, "", url);');
    // The one history entry the page adds is Deep Space's, never one per filter change.
    expect(page.match(/history\.pushState/g)).toHaveLength(1);
    expect(page).toContain('window.history.pushState({ nooscapeDeepSpace: true }, "", url);');
  });

  it("can set one key and leave the rest exactly as written, a comparison's ~ included", () => {
    expect(searchWith("?compare=a~b&q=x", "agent", "abc")).toBe("?compare=a~b&q=x&agent=abc");
    expect(searchWith("?agent=old&compare=a~b", "agent", "new")).toBe("?compare=a~b&agent=new");
    expect(searchWith("", "compare", "a~b")).toBe("?compare=a~b");
    const page = readFileSync(new URL("../Home.tsx", import.meta.url), "utf8");
    // Nothing on the page rewrites the address through searchParams, which turns "~" into "%7E".
    expect(page).not.toContain("searchParams.set(");
  });

  it("can take one key out and leave the rest exactly as written", () => {
    expect(searchWithout("?agent=abc&compare=a~b&q=x", "agent")).toBe("?compare=a~b&q=x");
    expect(searchWithout("?agent=abc", "agent")).toBe("");
    expect(searchWithout("", "agent")).toBe("");
    expect(searchWithout("?%E0=1&agent=a", "agent")).toBe("?%E0=1");
  });
});

describe("Deep Space in the browser's history", () => {
  const page = readFileSync(new URL("../Home.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

  it("adds an entry when it opens in the page, so Back closes it, and adds none when a link opened it", () => {
    const open = page.slice(page.indexOf("const pushedDeepSpace = useRef(false);"), page.indexOf("const closeDeepSpace"));
    expect(open).toContain('if (!deepSpace || window.location.hash === "#deep-space") return;');
    expect(open).toContain('window.addEventListener("popstate", onPop);');
    expect(open).toContain('const open = window.location.hash === "#deep-space";');
    // The entry is added before the agent is written into it.
    expect(page.indexOf("window.history.pushState(")).toBeLessThan(page.indexOf('url.search = searchWith(url.search, "agent", selected.id);'));
  });

  it("closes by going back over its own entry, or else takes the hash and the agent out in place", () => {
    const close = page.slice(page.indexOf("const closeDeepSpace = () => {"), page.indexOf("useEffect(", page.indexOf("const closeDeepSpace = () => {")));
    expect(close).toContain("if (pushedDeepSpace.current) {\n      window.history.back();");
    expect(close).toContain('url.search = searchWithout(url.search, "agent");');
    expect(page).toContain("onClose={closeDeepSpace}");
  });
});
