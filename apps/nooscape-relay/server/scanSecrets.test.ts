import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * CI scans the tree, and the commits a pull request adds, for credential-shaped text. The
 * samples here are assembled at run time so this file does not itself look like a leak to the
 * scanner it tests.
 */
const script = new URL("../scripts/scan-secrets.mjs", import.meta.url);
const { findInText } = (await import(script.href)) as {
  findInText: (text: string, firstLine?: number) => Array<{ rule: string; line: number }>;
};

const samples = {
  "private key block": "-----BEGIN " + "RSA PRIVATE KEY" + "-----",
  "GitHub token": "gh" + "p_" + "a1B2c3D4".repeat(5),
  "AWS access key id": "AKIA" + "ABCDEFGHIJKLMNOP",
  "Slack token": "xox" + "b-" + "1234567890-abcdefghij",
  "API secret key": "sk" + "-" + "Ab1".repeat(14),
  "URL with an embedded password": "mysql://app:" + "s3cr3tValue9" + "@db.prod-host.net:3306/app",
} as const;

describe("what counts as credential-shaped", () => {
  for (const [rule, sample] of Object.entries(samples)) {
    it(`flags a ${rule}`, () => {
      expect(findInText(`const value = "${sample}";`).map(hit => hit.rule)).toContain(rule);
    });
  }

  it("reports line numbers and never the matched text", () => {
    const secret = samples["GitHub token"];
    const hits = findInText(`one\ntwo\ntoken: ${secret}\n`, 10);
    expect(hits).toEqual([{ rule: "GitHub token", line: 12 }]);
    expect(JSON.stringify(hits)).not.toContain(secret);
  });

  it("lets a URL password through for this machine, reserved test hosts and plain stand-ins", () => {
    const urls = [
      "mysql://root:" + "nooscape" + "@127.0.0.1:3307",
      "mysql://root:" + "nooscape" + "@localhost:3306/db",
      "postgres://app:" + "hunter22xx" + "@db.test/app",
      "mysql://user:" + "<password>" + "@host/db",
      "mysql://user:" + "${DB_PASSWORD}" + "@host/db",
      "mysql://user:" + "password" + "@host/db",
      "mysql://user:" + "changeme" + "@host/db",
      "mysql://user@host.example.net/db",
      "https://nooscape.si/path?next=/a:b@c",
    ];
    for (const url of urls) expect(findInText(url), url).toEqual([]);
  });

  it("flags a URL password on a real host whatever the scheme", () => {
    for (const scheme of ["mysql", "postgres", "redis", "https", "amqp"]) {
      const url = `${scheme}://svc:` + "Zq81xKd02m" + "@internal.prod-host.net/app";
      expect(findInText(url).map(hit => hit.rule), url).toContain("URL with an embedded password");
    }
  });

  it("skips a line that carries the allow marker", () => {
    expect(findInText(`${samples["GitHub token"]} // secret-scan: allow`)).toEqual([]);
  });

  it("leaves ordinary long strings alone", () => {
    const ordinary = [
      "0x" + "ab12".repeat(16),
      "sha256-" + "Zm9vYmFy".repeat(8),
      "const risk-adjusted-score-for-the-agent-directory-entry = 1;",
      "the task-queue-for-the-hourly-ingestion-worker-pass runs at :00",
      "AKIA is the prefix, not a key",
      "see ghp_ and xoxb- for the shapes this scan looks for",
    ];
    for (const text of ordinary) expect(findInText(text), text).toEqual([]);
  });
});

// Each test builds a repository and runs git a dozen times, which takes seconds on a slow disk.
describe("the scan as CI runs it", { timeout: 60_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "scan-secrets-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
    git("init", "-q");
    return { dir, git };
  }

  function scan(dir: string, ...args: string[]) {
    return spawnSync(process.execPath, [fileURLToPath(script), ...args], { cwd: dir, encoding: "utf8" });
  }

  it("passes a clean repository", () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, "a.txt"), "nothing to see\n");
    git("add", "-A");
    git("commit", "-q", "-m", "clean");
    const result = scan(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing credential-shaped");
  });

  it("fails a tracked file with a secret, names the rule, file and line, and prints nothing of the value", () => {
    const { dir, git } = repo();
    const secret = samples["GitHub token"];
    writeFileSync(join(dir, "config.ts"), `// header\nexport const token = "${secret}";\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "leak");
    const result = scan(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub token: config.ts:2");
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(secret.slice(4, 20));
  });

  it("finds a secret a pull request added and then removed, but only when asked to scan the range", () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, "a.txt"), "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("branch", "base");

    const secret = samples["AWS access key id"];
    writeFileSync(join(dir, "a.txt"), `base\nkey=${secret}\n`);
    git("commit", "-q", "-am", "adds a key");
    const leakedIn = git("rev-parse", "--short=7", "HEAD").trim();
    writeFileSync(join(dir, "a.txt"), "base\n");
    git("commit", "-q", "-am", "removes it again");

    // The tree is clean, so a tree-only scan passes.
    expect(scan(dir).status).toBe(0);
    const ranged = scan(dir, "--range", "base..HEAD");
    expect(ranged.status).toBe(1);
    expect(ranged.stderr).toContain(`AWS access key id: a.txt:2 (commit ${leakedIn})`);
    expect(ranged.stderr).not.toContain(secret);
  });

  it("passes a range that adds nothing credential-shaped", () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, "a.txt"), "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("branch", "base");
    writeFileSync(join(dir, "a.txt"), "base\nmore\n");
    git("commit", "-q", "-am", "more");
    expect(scan(dir, "--range", "base..HEAD").status).toBe(0);
  });
});
