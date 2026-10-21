// Fails the build when the repository, or the commits a pull request adds, hold something shaped
// like a credential: a private key block, a GitHub, AWS, Slack or API token, or a URL with a real
// password in it.
//
// It reports the rule, the file and the line (and the commit for a range scan). It never prints
// the value it matched, so a failing run does not copy the secret into the CI log.
//
//   node scripts/scan-secrets.mjs                  the tracked files at HEAD
//   node scripts/scan-secrets.mjs --range A..B     also every line the commits in A..B added,
//                                                  so a secret added and removed inside one pull
//                                                  request is still found
//
// A line that carries `secret-scan: allow` is skipped. The rules favour precision over reach: a
// failure here blocks a merge, so each rule matches a shape that real credentials have and
// examples do not.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOW_MARKER = "secret-scan: allow";
const MAX_FILE_BYTES = 1_000_000;
const SKIPPED_FILES = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|zip|gz|pdf)$|(^|\/)pnpm-lock\.yaml$/i;

/** Hosts a password in a URL is fine for: the machine's own, and the reserved test names. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|[^/]*\.(localhost|test|invalid|example))$/i;
/** A password that is plainly a stand-in. */
const PLACEHOLDER_PASSWORD = /^(<[^>]*>|\$\{?[^}]*\}?|%[sd]|\*+|x{3,}|\.{3,}|changeme|change-me|password|passwd|secret|example|your[-_a-z]*|redacted|dummy|test|pass)$/i;

const URL_WITH_PASSWORD = /\b[a-z][a-z0-9+.-]{1,12}:\/\/[^\s:/@'"`<>]{1,64}:([^\s@'"`/<>]{3,})@([^\s'"`/:<>]+)/gi;

/** Each rule says whether a line has a hit. None of them returns the matched text. */
export const RULES = [
  { name: "private key block", test: line => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line) },
  { name: "GitHub token", test: line => /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(line) },
  { name: "AWS access key id", test: line => /\bAKIA[0-9A-Z]{16}\b/.test(line) },
  { name: "Slack token", test: line => /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/.test(line) },
  { name: "API secret key", test: line => /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/.test(line) },
  {
    name: "URL with an embedded password",
    test: line => {
      for (const match of line.matchAll(URL_WITH_PASSWORD)) {
        const [, password, host] = match;
        if (!LOCAL_HOST.test(host) && !PLACEHOLDER_PASSWORD.test(password)) return true;
      }
      return false;
    },
  },
];

/** The rule names that hit each line of `text`, as { rule, line } with 1-based line numbers. */
export function findInText(text, firstLine = 1) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.length > 4000 || line.includes(ALLOW_MARKER)) return;
    for (const rule of RULES) {
      if (rule.test(line)) hits.push({ rule: rule.name, line: firstLine + index });
    }
  });
  return hits;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Every tracked file at HEAD. */
export function scanTree(root) {
  const hits = [];
  for (const path of git(root, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
    if (SKIPPED_FILES.test(path)) continue;
    let text;
    try {
      const buffer = readFileSync(join(root, path));
      if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) continue;
      text = buffer.toString("utf8");
    } catch {
      continue;
    }
    for (const hit of findInText(text)) hits.push({ ...hit, path });
  }
  return hits;
}

/** Every line the commits in `range` added, including lines a later commit in the range removed. */
export function scanRange(root, range) {
  const hits = [];
  const log = git(root, ["log", "-p", "--no-color", "--unified=0", "--format=commit %H", range]);
  let commit = "";
  let path = "";
  let line = 0;
  for (const row of log.split("\n")) {
    if (row.startsWith("commit ")) commit = row.slice(7, 14);
    else if (row.startsWith("+++ ")) path = row.startsWith("+++ b/") ? row.slice(6) : "";
    else if (row.startsWith("@@")) line = Number(/\+(\d+)/.exec(row)?.[1] ?? 0);
    else if (row.startsWith("+") && path && !SKIPPED_FILES.test(path)) {
      for (const hit of findInText(row.slice(1), line)) hits.push({ ...hit, path, commit });
      line += 1;
    }
  }
  return hits;
}

function main(args) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const rangeAt = args.indexOf("--range");
  const hits = scanTree(root);
  if (rangeAt >= 0) hits.push(...scanRange(root, args[rangeAt + 1]));
  if (hits.length === 0) {
    console.log("[secret scan] nothing credential-shaped found");
    return 0;
  }
  const seen = new Set();
  console.error("[secret scan] credential-shaped text found (values are not printed):");
  for (const hit of hits) {
    const row = `  ${hit.rule}: ${hit.path}:${hit.line}${hit.commit ? ` (commit ${hit.commit})` : ""}`;
    if (!seen.has(row)) {
      seen.add(row);
      console.error(row);
    }
  }
  console.error(`If a hit is not a credential, put "${ALLOW_MARKER}" on that line. If it is one, rotate it: removing it from the code does not remove it from history.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
