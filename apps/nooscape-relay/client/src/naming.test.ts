import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HERO_COPY } from "./components/home/heroModel";

/**
 * What the site calls itself, held at the source (docs/naming-2026-10-18.md). Two phrases: an open agent observatory is what
 * Nooscape is, and the evidence layer for agent trust is what it is for. Words that call it something it is not, or that imply
 * a score, a grade or a sale, stay out of the words a visitor reads. The two promises that set the limit stay word for word.
 */
const root = fileURLToPath(new URL(".", import.meta.url));
const app = join(root, "..", "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (path: string) => readFileSync(path, "utf8");

/** Every file a visitor's words come from: the client, the server's page heads, the page shell and the manifest. */
const files = [
  ...sourceFiles(root).map(path => ({ file: relative(app, path).split("\\").join("/"), text: withoutComments(read(path)) })),
  { file: "server/routeHead.ts", text: withoutComments(read(join(app, "server", "routeHead.ts"))) },
  { file: "client/index.html", text: read(join(app, "client", "index.html")).replace(/<meta[^>]*og:image:alt[^>]*>|<meta[^>]*twitter:image:alt[^>]*>/g, "") },
  { file: "client/public/site.webmanifest", text: read(join(app, "client", "public", "site.webmanifest")) },
];

/** Not what Nooscape is, or a claim it does not make. */
const NOT_OUR_NAMES: Array<[RegExp, string]> = [
  [/credit bureau/i, "credit bureau"],
  [/background check/i, "background check"],
  [/evidence-first (agent |discovery )?atlas/i, "evidence-first atlas"],
  [/\bgraded\b/i, "graded"],
];

describe("what the site calls itself", () => {
  it("never calls Nooscape a credit bureau, a background check, an evidence-first atlas or a grader", () => {
    for (const { file, text } of files) {
      for (const [pattern, name] of NOT_OUR_NAMES) expect(text, `${file}: ${name}`).not.toMatch(pattern);
    }
  });

  it("never calls it a public directory, on the legal pages or anywhere else", () => {
    const found = files.map(({ file, text }) => [file, (text.match(/public directory/gi) ?? []).length] as const).filter(([, count]) => count > 0);
    expect(Object.fromEntries(found)).toEqual({});
  });

  it("titles the page as the observatory, in the title, the card and the manifest", () => {
    const html = read(join(app, "client", "index.html"));
    expect(html).toContain("<title>Nooscape: Open Agent Observatory</title>");
    expect(html.match(/content="Nooscape: Open Agent Observatory"/g)).toHaveLength(2);
    expect(read(join(app, "client", "public", "site.webmanifest"))).toContain('"name": "Nooscape: Open Agent Observatory"');
  });

  it("names one share card in the Open Graph and Twitter tags: a 1200 by 630 picture in the public folder, with alt text that gives the words it carries", () => {
    const html = read(join(app, "client", "index.html"));
    const pictures = Array.from(html.matchAll(/<meta (?:property="og:image(?::secure_url)?"|name="twitter:image") content="https:\/\/nooscape\.si\/([^"]+)"/g), match => match[1]);
    expect(pictures).toHaveLength(3);
    expect(new Set(pictures).size).toBe(1);
    const png = readFileSync(join(app, "client", "public", pictures[0]!));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    const alts = Array.from(html.matchAll(/<meta (?:property="og:image:alt"|name="twitter:image:alt") content="([^"]+)"/g), match => match[1]!);
    expect(alts).toHaveLength(2);
    for (const alt of alts) {
      expect(alt).toContain("Open agent observatory");
      expect(alt).toContain("No scores for sale. No rankings for hire.");
    }
  });

  it("says the observatory in the header and before the page's script runs", () => {
    expect(read(join(root, "components", "home", "SiteHeader.tsx"))).toContain("Open agent observatory");
    expect(read(join(app, "client", "index.html"))).toContain("<small>Open agent observatory</small>");
  });

  it("makes the same hero promise before the script runs as after it", () => {
    const html = read(join(app, "client", "index.html"));
    expect(html).toContain(`<span>${HERO_COPY.headline[0]}</span><span>${HERO_COPY.headline[1]}</span>`);
    expect(html).toContain(`<p class="ns-boot-copy">${HERO_COPY.subcopy}</p>`);
  });
});

describe("the promises that set the limit", () => {
  it("keep the two lines word for word, in the hero and on the terms", () => {
    expect(HERO_COPY.subcopy).toContain("No scores for sale. No rankings for hire.");
    expect(read(join(root, "pages", "Terms.tsx"))).toContain("We never take money to change a record.");
  });

  it("do not promise what the data cannot: no count of agents in the hero copy, and the honest state of most records", () => {
    expect(HERO_COPY.subcopy).not.toMatch(/\d/);
    expect(HERO_COPY.subcopy).toContain("Most records are listed only. A few are reviewed.");
  });
});
