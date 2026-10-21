// Tells the CI gate whether a change is documentation only, so the gate can skip the install, the type check, the tests, the
// build and the audit for it. The secret scan still runs, and the job still reports `gate`, which the `main` ruleset
// requires. A workflow-level `paths-ignore` would not do that: it leaves `gate` unreported, and a pull request or a push to
// main that has no `gate` result cannot merge.
//
//   node scripts/ci-scope.mjs --base origin/main   the files this checkout adds to a base branch (a pull request)
//   node scripts/ci-scope.mjs --before <sha>       the files a push changed, from the commit before it (a push to main)
//   node scripts/ci-scope.mjs                      nothing to compare, so the full gate (a manual run)
//
// It prints what it found, and writes `docs_only=true` or `docs_only=false` to the file named by GITHUB_OUTPUT when that is
// set. It never fails the job: anything it cannot work out is `false`, and the full gate runs.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Markdown files that a test reads as its input. A change to one can change a test's result, so it is not documentation
 * here. server/ciScope.test.ts holds this list to the tests: a test that names another Markdown file fails until it is
 * added, and an entry that no test names fails until it is removed. Paths are from the repository root.
 */
export const READ_BY_TESTS = [
  "SECURITY.md",
  "apps/nooscape-relay/docs/arc-census-2026-10-20.md",
  "apps/nooscape-relay/docs/base-census-2026-10-21.md",
  "apps/nooscape-relay/docs/bsc-b1-measurement-2026-10-16.md",
  "apps/nooscape-relay/docs/bsc-clusters-2026-10-16.md",
  "apps/nooscape-relay/docs/bsc-rater-credibility-2026-10-16.md",
  "apps/nooscape-relay/docs/robinhood-census-2026-10-20.md",
  "apps/nooscape-relay/docs/solana-census-2026-10-18.md",
];

/**
 * A Markdown file that no test reads. Nothing else counts as documentation: not an SQL file the tests read, not a text file or
 * an image, and not a workflow, a script or a lockfile.
 */
export function isDocFile(path) {
  return /\.md$/i.test(path) && !READ_BY_TESTS.includes(path);
}

/** Whether every changed file is documentation, and why. No files to go on is not documentation only. */
export function classify(files) {
  if (!files || files.length === 0) return { docsOnly: false, reason: "no changed files to go on, so the full gate runs" };
  const other = files.filter(file => !isDocFile(file));
  if (other.length === 0) return { docsOnly: true, reason: `${files.length} documentation file${files.length === 1 ? "" : "s"} and nothing else` };
  const shown = other.slice(0, 3).join(", ");
  return { docsOnly: false, reason: `${other.length} of ${files.length} changed file${files.length === 1 ? " is" : "s are"} not documentation, for example ${shown}` };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

const paths = output => output.split("\0").filter(Boolean);

/**
 * The files the change touches, or null when they cannot be known. Renames are listed as a deletion and an addition
 * (`--no-renames`), so a code file moved to a Markdown name still shows its old path.
 */
export function changedFiles({ base, before, cwd = process.cwd() }) {
  try {
    if (base) return paths(git(["diff", "--name-only", "--no-renames", "-z", base, "HEAD"], cwd));
    if (before && !/^0+$/.test(before)) {
      git(["cat-file", "-e", `${before}^{commit}`], cwd);
      return paths(git(["diff", "--name-only", "--no-renames", "-z", before, "HEAD"], cwd));
    }
  } catch {
    // A commit this checkout does not have, or no repository: the files are not known.
  }
  return null;
}

function main(args) {
  const flag = name => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  let result;
  try {
    result = classify(changedFiles({ base: flag("--base"), before: flag("--before") }));
  } catch (error) {
    result = { docsOnly: false, reason: `could not tell (${error instanceof Error ? error.message : "an error"}), so the full gate runs` };
  }
  console.log(`[ci scope] docs_only=${result.docsOnly}: ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${result.docsOnly}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
