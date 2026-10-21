import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The CI gate skips its install, type check, tests, build and audit for a change to Markdown files only (scripts/ci-scope.mjs),
 * and keeps the secret scan. This holds the three parts of that: what counts as documentation, how the changed files are found,
 * and the workflow that uses it. The point of the last two guards is that a test must never depend on a file that a docs-only
 * run does not test: a Markdown file a test reads is not documentation, and no step but the checkout, the secret scan and the
 * scope step may run on a docs-only change without a condition.
 */
const scriptUrl = new URL("../scripts/ci-scope.mjs", import.meta.url);
const script = fileURLToPath(scriptUrl);
const scope = (await import(scriptUrl.href)) as {
  READ_BY_TESTS: readonly string[];
  isDocFile: (path: string) => boolean;
  classify: (files: string[] | null) => { docsOnly: boolean; reason: string };
  changedFiles: (input: { base?: string; before?: string; cwd?: string }) => string[] | null;
};

const app = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(app, "..", "..");

describe("what counts as documentation", () => {
  it("is a Markdown file that no test reads, wherever it is", () => {
    for (const path of [
      "README.md",
      "apps/nooscape-relay/docs/automation-2026-10-13.md",
      "apps/nooscape-relay/docs/approvals/2026-10-20-multichain-erc8004.md",
      "apps/nooscape-relay/todo.md",
      "apps/nooscape-relay/scripts/loadtest/README.md",
      ".github/pull_request_template.md",
      "NOTES.MD",
    ]) {
      expect(scope.isDocFile(path), path).toBe(true);
    }
  });

  it("is not a Markdown file a test reads as its input", () => {
    expect(scope.READ_BY_TESTS.length).toBeGreaterThan(0);
    for (const path of scope.READ_BY_TESTS) expect(scope.isDocFile(path), path).toBe(false);
  });

  it("is nothing but Markdown: not the SQL the tests read beside the reports, text, images, workflows, scripts or lockfiles", () => {
    for (const path of [
      "apps/nooscape-relay/docs/solana-census-queries-2026-10-18.sql",
      "apps/nooscape-relay/docs/robinhood-census-queries-2026-10-20.sql",
      "apps/nooscape-relay/client/public/.well-known/security.txt",
      "apps/nooscape-relay/docs/picture.png",
      "apps/nooscape-relay/server/db.ts",
      "apps/nooscape-relay/client/src/pages/Home.tsx",
      "apps/nooscape-relay/drizzle/0046_multichain_erc8004_protocols.sql",
      "apps/nooscape-relay/package.json",
      "apps/nooscape-relay/pnpm-lock.yaml",
      ".github/workflows/ci.yml",
      ".github/dependabot.yml",
      "apps/nooscape-relay/scripts/ci-scope.mjs",
      "LICENSE",
      "notes.mdx",
      "docs.md.ts",
      "md",
    ]) {
      expect(scope.isDocFile(path), path).toBe(false);
    }
  });

  it("makes a change documentation only when every file is, and names the first files that are not when one is not", () => {
    expect(scope.classify(["README.md"])).toEqual({ docsOnly: true, reason: "1 documentation file and nothing else" });
    expect(scope.classify(["README.md", "apps/nooscape-relay/todo.md"]).docsOnly).toBe(true);
    const mixed = scope.classify(["README.md", "server/a.ts", "server/b.ts", "server/c.ts", "server/d.ts"]);
    expect(mixed.docsOnly).toBe(false);
    expect(mixed.reason).toBe("4 of 5 changed files are not documentation, for example server/a.ts, server/b.ts, server/c.ts");
    // A reader of the reports and SECURITY.md in a test: a change to one runs the gate.
    expect(scope.classify(["README.md", "SECURITY.md"]).docsOnly).toBe(false);
  });

  it("does not skip the gate when there are no files to go on", () => {
    for (const files of [null, [] as string[]]) expect(scope.classify(files).docsOnly, String(files)).toBe(false);
  });
});

describe("the files a change touches", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

  /** A repository with a code file and a document on main, and a branch to change them on. */
  function repository() {
    const dir = mkdtempSync(join(tmpdir(), "ci-scope-"));
    dirs.push(dir);
    run(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "docs", "a.md"), "# A\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "base");
    run(dir, "switch", "-q", "-c", "change");
    return dir;
  }
  const commit = (dir: string, message = "change") => {
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", message);
    return run(dir, "rev-parse", "HEAD");
  };

  it("are the files a pull request adds to its base, and a change to a document alone is documentation only", () => {
    const dir = repository();
    writeFileSync(join(dir, "docs", "a.md"), "# A, changed\n");
    writeFileSync(join(dir, "docs", "b.md"), "# B\n");
    commit(dir);
    const files = scope.changedFiles({ base: "main", cwd: dir });
    expect(files?.sort()).toEqual(["docs/a.md", "docs/b.md"]);
    expect(scope.classify(files).docsOnly).toBe(true);
  });

  it("include a code file beside a document, and a code file that is deleted", () => {
    const dir = repository();
    writeFileSync(join(dir, "docs", "a.md"), "# A, changed\n");
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
    commit(dir);
    expect(scope.classify(scope.changedFiles({ base: "main", cwd: dir })).docsOnly).toBe(false);

    const second = repository();
    rmSync(join(second, "src", "a.ts"));
    commit(second);
    const files = scope.changedFiles({ base: "main", cwd: second });
    expect(files).toEqual(["src/a.ts"]);
    expect(scope.classify(files).docsOnly).toBe(false);
  });

  it("list a code file renamed to a Markdown name as both paths, so the move is not taken for documentation", () => {
    const dir = repository();
    run(dir, "mv", "src/a.ts", "docs/moved.md");
    commit(dir);
    const files = scope.changedFiles({ base: "main", cwd: dir });
    expect(files?.sort()).toEqual(["docs/moved.md", "src/a.ts"]);
    expect(scope.classify(files).docsOnly).toBe(false);
  });

  it("are, for a push, the files between the commit before it and the tip", () => {
    const dir = repository();
    const before = run(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "docs", "a.md"), "# A, again\n");
    commit(dir, "first");
    writeFileSync(join(dir, "docs", "c.md"), "# C\n");
    commit(dir, "second");
    expect(scope.changedFiles({ before, cwd: dir })?.sort()).toEqual(["docs/a.md", "docs/c.md"]);
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
    commit(dir, "third");
    expect(scope.classify(scope.changedFiles({ before, cwd: dir })).docsOnly).toBe(false);
  });

  it("are not known for a push with no commit before it, a commit this checkout lacks, or no comparison at all", () => {
    const dir = repository();
    expect(scope.changedFiles({ before: "0".repeat(40), cwd: dir })).toBeNull();
    expect(scope.changedFiles({ before: "1".repeat(40), cwd: dir })).toBeNull();
    expect(scope.changedFiles({ cwd: dir })).toBeNull();
    expect(scope.changedFiles({ base: "no-such-branch", cwd: dir })).toBeNull();
    const notARepository = mkdtempSync(join(tmpdir(), "ci-scope-none-"));
    dirs.push(notARepository);
    expect(scope.changedFiles({ base: "main", cwd: notARepository })).toBeNull();
  });

  it("are reported by the script to the job as docs_only, and the script never fails the job", () => {
    const docsOnly = repository();
    writeFileSync(join(docsOnly, "docs", "a.md"), "# A, changed\n");
    commit(docsOnly);
    const code = repository();
    writeFileSync(join(code, "src", "a.ts"), "export const a = 9;\n");
    commit(code);

    const invoke = (cwd: string, args: string[]) => {
      const output = join(mkdtempSync(join(tmpdir(), "ci-scope-out-")), "github-output");
      dirs.push(join(output, ".."));
      const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
      let written = "";
      try {
        written = readFileSync(output, "utf8");
      } catch {
        written = "";
      }
      return { status: result.status, stdout: result.stdout, written };
    };

    const documentation = invoke(docsOnly, ["--base", "main"]);
    expect(documentation).toMatchObject({ status: 0, written: "docs_only=true\n" });
    expect(documentation.stdout).toContain("docs_only=true: 1 documentation file and nothing else");
    expect(invoke(code, ["--base", "main"])).toMatchObject({ status: 0, written: "docs_only=false\n" });
    expect(invoke(code, [])).toMatchObject({ status: 0, written: "docs_only=false\n" });
    expect(invoke(code, ["--before", "2".repeat(40)])).toMatchObject({ status: 0, written: "docs_only=false\n" });
    const nowhere = mkdtempSync(join(tmpdir(), "ci-scope-nowhere-"));
    dirs.push(nowhere);
    expect(invoke(nowhere, ["--base", "main"])).toMatchObject({ status: 0, written: "docs_only=false\n" });
  });
});

describe("the tests against the documents", () => {
  const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const testFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(path);
      return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
  // Every test but this one, whose own fixtures name Markdown files and a docs directory without reading the real ones.
  const tests = [...testFiles(join(app, "server")), ...testFiles(join(app, "client", "src")), ...testFiles(join(app, "shared"))]
    .map(path => ({ file: relative(app, path).replaceAll("\\", "/"), code: withoutComments(readFileSync(path, "utf8")) }))
    .filter(({ file }) => file !== "server/ciScope.test.ts");

  /** The Markdown names that tests mention as strings, with the tests that mention them: their reads, and any fixture text. */
  const named = new Map<string, string[]>();
  for (const { file, code } of tests) {
    for (const match of code.matchAll(/["'`]([^"'`\r\n]*\.md)["'`]/gi)) {
      const name = basename(match[1]!);
      named.set(name, [...new Set([...(named.get(name) ?? []), file])]);
    }
  }
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

  it("never read a Markdown file that counts as documentation: a change to it would be merged without the test that reads it", () => {
    const reads = tracked.filter(path => named.has(basename(path)) && scope.isDocFile(path)).map(path => `${path}, named by ${named.get(basename(path))!.join(", ")}`);
    expect(reads, "add each to READ_BY_TESTS in scripts/ci-scope.mjs").toEqual([]);
  });

  it("are named by every entry on the list of documents they read, which is a file that exists", () => {
    for (const path of scope.READ_BY_TESTS) {
      expect(named.has(basename(path)), `${path} is on the list but no test names it: remove it`).toBe(true);
      expect(tracked, `${path} is on the list but is not a tracked file: remove it`).toContain(path);
    }
  });

  it("read the docs directory by name only in the six reports' tests, which name each document they read", () => {
    const readers = tests.filter(({ code }) => /["'`]docs["'`]/.test(code)).map(({ file }) => file);
    expect(readers.sort()).toEqual([
      "client/src/pages/arcRegistryReport.test.ts",
      "client/src/pages/baseRegistryReport.test.ts",
      "client/src/pages/bnbRatingsReport.test.ts",
      "client/src/pages/bnbRegistryReport.test.ts",
      "client/src/pages/robinhoodRegistryReport.test.ts",
      "client/src/pages/solanaRegistryReport.test.ts",
    ]);
  });
});

describe("the workflow", () => {
  const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
  /** The steps of the one job, each as its lines, from the line that starts it to the line before the next. */
  const steps = ci
    .slice(ci.indexOf("\n    steps:\n") + "\n    steps:\n".length)
    .split(/\n(?=      - )/)
    .map(block => block.trim())
    .filter(block => block.startsWith("- "));
  const label = (block: string) => /^- name: (.+)$/m.exec(block)?.[1] ?? /^- uses: (\S+)/m.exec(block)?.[1] ?? block.slice(0, 40);
  const conditionOf = (block: string) => /^ {8}if: (.+)$/m.exec(block)?.[1] ?? null;

  it("runs the secret scan on every change, before it decides anything", () => {
    const names = steps.map(label);
    const secretScan = steps.find(block => label(block) === "Secret scan")!;
    expect(secretScan).toBeDefined();
    expect(conditionOf(secretScan)).toBeNull();
    expect(names.indexOf("Secret scan")).toBeLessThan(names.indexOf("Scope"));
  });

  it("decides in a step named Scope, from the pull request's base or the commit before a push, with the script", () => {
    const scopeStep = steps.find(block => label(block) === "Scope")!;
    expect(scopeStep).toContain("id: scope");
    expect(scopeStep).toContain('node scripts/ci-scope.mjs --base "origin/$BASE_REF"');
    expect(scopeStep).toContain('node scripts/ci-scope.mjs --before "$BEFORE"');
    expect(conditionOf(scopeStep)).toBeNull();
  });

  const NOT_DOCS = "steps.scope.outputs.docs_only != 'true'";
  /** The condition each step after the scope step must carry: the one for a change that is not documentation, and these three. */
  const CONDITIONS: Record<string, string> = {
    "Documentation only": "steps.scope.outputs.docs_only == 'true'",
    "Tests ran on the pull request": `${NOT_DOCS} && github.event_name == 'push'`,
    Test: `${NOT_DOCS} && github.event_name != 'push'`,
  };

  it("puts a condition on every step after the scope step: not documentation, and for the tests and the two notes, what they say", () => {
    const names = steps.map(label);
    const after = steps.slice(names.indexOf("Scope") + 1);
    expect(after.length).toBeGreaterThan(5);
    for (const block of after) expect(conditionOf(block), label(block)).toBe(CONDITIONS[label(block)] ?? NOT_DOCS);
  });

  it("skips the tests on a push to main and nothing else on one: the type check and the build still run", () => {
    const names = steps.map(label);
    const byName = (name: string) => steps[names.indexOf(name)]!;
    expect(conditionOf(byName("Test"))).toContain("github.event_name != 'push'");
    for (const name of ["Install", "Typecheck", "Build", "No Manus tooling in the build", "Dependency audit (advisory)"]) {
      expect(conditionOf(byName(name)), name).toBe(NOT_DOCS);
    }
    // Only the test step and its note look at the event: nothing else is left out of a push.
    const lookAtEvent = steps.filter(block => (conditionOf(block) ?? "").includes("github.event_name")).map(label);
    expect(lookAtEvent.sort()).toEqual(["Test", "Tests ran on the pull request"]);
  });

  it("can still be started by hand, which runs the whole gate on main", () => {
    const triggers = ci.slice(ci.indexOf("\non:\n"), ci.indexOf("\nconcurrency:"));
    expect(triggers).toContain("  workflow_dispatch:");
    expect(triggers).toContain("  pull_request:");
    expect(triggers).toMatch(/push:\n {4}branches: \[main\]/);
  });

  it("has no step that runs without a condition apart from the checkout, the secret scan and the scope step", () => {
    const unconditional = steps.filter(block => conditionOf(block) === null).map(label);
    expect(unconditional).toEqual([expect.stringMatching(/^actions\/checkout@/), "Secret scan", "Scope"]);
  });

  it("writes each single-line `run` and `if` so that YAML reads it as text: no colon and space, and no space and hash, in a value that is not quoted", () => {
    // A note that said "the tests: they ran" made the whole file unreadable as YAML, which fails the workflow before it starts.
    const risky = ci.split("\n").filter(line => {
      const match = /^ {8}(run|if): (.+)$/.exec(line);
      if (!match) return false;
      const value = match[2]!;
      if (/^[|>"'[{]/.test(value)) return false;
      return /: |\s#/.test(value);
    });
    expect(risky).toEqual([]);
  });

  it("does not filter the workflow by path: a skipped workflow leaves `gate` unreported, and the main ruleset requires it", () => {
    const keys = ci
      .split("\n")
      .filter(line => !/^\s*#/.test(line))
      .filter(line => /^\s*(paths|paths-ignore):/.test(line));
    expect(keys).toEqual([]);
    expect(ci).toMatch(/^  gate:$/m);
  });
});
