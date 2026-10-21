import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * An answer from the router is typed by the router. A cast on it (`query.data as X`) stops the compiler checking it, so
 * when the server's shape changes the page goes on believing the old one. That is how the home page went blank on
 * 15 Oct 2026: the hero read the answer `{ sample }` as if it were the sample. Give the value a type with an annotation
 * instead (`const x: X | undefined = query.data`), which the compiler does check, and say in code what the page does
 * with a value it does not know (see `toPublisherState`). So no file casts a read of `.data`, and none casts through
 * `unknown`. The code is parsed, not searched, so words in a string or in JSX text are not mistaken for a cast.
 */

const root = fileURLToPath(new URL(".", import.meta.url));
const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** The casts in `text` that have a read of `.data` inside them, or that go through `unknown`, each with its line. */
export function answerCasts(text: string) {
  const file = ts.createSourceFile("source.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const readsData = (node: ts.Node): boolean => (ts.isPropertyAccessExpression(node) && node.name.text === "data") || ts.forEachChild(node, readsData) === true;
  const visit = (node: ts.Node) => {
    if (ts.isAsExpression(node) && !ts.isConstTypeReference(node.type)) {
      const throughUnknown = ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword;
      if (throughUnknown || readsData(node.expression)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        found.push(`line ${line + 1}: ${node.getText(file).replace(/\s+/g, " ").slice(0, 110)}`);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the matcher", () => {
  it("finds a cast on a read of .data, and a cast through unknown", () => {
    expect(answerCasts("const rows = (query.data?.chains ?? []) as ChainStat[];")).toHaveLength(1);
    expect(answerCasts("const facts = evidenceQuery.data as unknown as EnvelopeFacts;")).toHaveLength(1);
    expect(answerCasts("const thing = value as unknown as Thing;")).toHaveLength(1);
    expect(answerCasts("const view = <p>{query.data as Shown}</p>;")).toHaveLength(1);
  });

  it("leaves an annotation, as const, a cast of something else, a comment and plain words alone", () => {
    expect(answerCasts("const rows: readonly ChainStat[] = query.data?.chains ?? [];")).toEqual([]);
    expect(answerCasts('const modes = ["a", "b"] as const;')).toEqual([]);
    expect(answerCasts("const input = event.target as HTMLInputElement;")).toEqual([]);
    expect(answerCasts("// it used to say query.data as X\nconst a = 1;")).toEqual([]);
    expect(answerCasts("/* query.data as X */ const a = 1;")).toEqual([]);
    expect(answerCasts('const a = query.data; const note = "never presented as verified";')).toEqual([]);
    expect(answerCasts("const a = <p>{query.data?.mode} is not presented as verified</p>;")).toEqual([]);
  });
});

describe("answers from the router", () => {
  it("are not cast in any page or component, so the compiler keeps checking them", () => {
    const files = sourceFiles(root);
    expect(files.length, "the scan found no source to read").toBeGreaterThan(50);
    const found = files.flatMap(path => answerCasts(readFileSync(path, "utf8")).map(cast => `${relative(root, path).replaceAll("\\", "/")} ${cast}`));
    expect(found, "Annotate the value (`const x: X | undefined = query.data`) instead of casting it.").toEqual([]);
  });
});

describe("a record's publisher state", () => {
  it("is checked on its way in, not assumed: the router types it as a string", () => {
    const home = read("./pages/Home.tsx");
    expect(home).toContain("  publisherState: string;");
    expect(home).toContain("status: toPublisherState(record.publisherState),");
    expect(home).not.toContain("publisherState: PublisherState;");
  });
});
