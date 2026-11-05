import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packetFixture } from "../test/fixture";

/**
 * What would be published is what is tested here: the package is compiled with its own tsconfig into a temporary folder that holds its
 * real package.json, and the built command and the built library are run from there, the way someone who installed it would run them.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(read("package.json")) as Record<string, any>;

let work = "";
const fixture = packetFixture({ keyId: "nooscape-evidence-test" });

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "nooscape-verify-"));
  cpSync(join(root, "package.json"), join(work, "package.json"));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const build = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json"), "--outDir", join(work, "dist")], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`the package does not build:\n${build.stdout}\n${build.stderr}`);
  writeFileSync(join(work, "packet.json"), JSON.stringify(fixture.packet));
  writeFileSync(join(work, "keys.json"), JSON.stringify(fixture.manifest));
  const tampered = fixture.copy();
  tampered.envelope.entries[0]!.detail = "Changed after signing.";
  writeFileSync(join(work, "tampered.json"), JSON.stringify(tampered));
  writeFileSync(
    join(work, "library.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'import { readKeyManifest, readPacket, verifyEvidencePacket, findKey, canonicalPem, signedAfterRetirement } from "./dist/index.js";',
      'const packet = readPacket(JSON.parse(readFileSync("packet.json", "utf8")));',
      "const { keys, ignored } = readKeyManifest(JSON.parse(readFileSync(\"keys.json\", \"utf8\")));",
      "const exported = Object.entries({ readKeyManifest, readPacket, verifyEvidencePacket, findKey, canonicalPem, signedAfterRetirement }).map(([name, value]) => [name, typeof value]);",
      "console.log(JSON.stringify({ exported, ignored, result: packet.ok ? verifyEvidencePacket(packet.packet, keys) : null }));",
    ].join("\n")
  );
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

const node = (args: string[]) => spawnSync(process.execPath, args, { cwd: work, encoding: "utf8" });

describe("the nooscape-verify package", () => {
  it("builds to the files it says it ships, and none of its tests", () => {
    for (const file of ["bin.js", "cli.js", "index.js", "index.d.ts", "verify.js", "verify.d.ts"]) expect(existsSync(join(work, "dist", file)), file).toBe(true);
    for (const file of ["verify.test.js", "cli.test.js", "package.test.js", "fixture.js"]) expect(existsSync(join(work, "dist", file)), file).toBe(false);
    expect(readFileSync(join(work, "dist", "bin.js"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("has a package.json that points at what is built, ships only that and the README, and depends on nothing", () => {
    expect(manifest.name).toBe("nooscape-verify");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.type).toBe("module");
    expect(manifest.license).toBe("MIT");
    expect(manifest.engines).toEqual({ node: ">=18" });
    for (const target of [manifest.main, manifest.types, manifest.exports["."].import, manifest.exports["."].types, manifest.bin["nooscape-verify"]]) {
      expect(existsSync(join(work, target)), target).toBe(true);
    }
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.scripts.prepublishOnly).toBe("npm run build");
    expect(existsSync(join(root, "README.md"))).toBe(true);
  });

  it("is a command that verifies a packet, refuses a changed one and says how to use it", () => {
    const good = node(["dist/bin.js", "packet.json", "--keys", "keys.json"]);
    expect(good.status, good.stdout + good.stderr).toBe(0);
    expect(good.stdout).toContain("VERIFIED: the packet is unchanged since a key in the key list signed it.");
    expect(good.stdout).toContain("key                   active (nooscape-evidence-test)");
    const bad = node(["dist/bin.js", "tampered.json", "--keys", "keys.json"]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("NOT VERIFIED");
    const none = node(["dist/bin.js"]);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("Usage: nooscape-verify");
    const json = node(["dist/bin.js", "packet.json", "--keys", "keys.json", "--json"]);
    expect(JSON.parse(json.stdout).result).toMatchObject({ valid: true, keyStatus: "active" });
  });

  it("is a library that exports the check, the readers and the key helpers", () => {
    const run = node(["library.mjs"]);
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.exported).toEqual([
      ["readKeyManifest", "function"],
      ["readPacket", "function"],
      ["verifyEvidencePacket", "function"],
      ["findKey", "function"],
      ["canonicalPem", "function"],
      ["signedAfterRetirement", "function"],
    ]);
    expect(out.ignored).toEqual([]);
    expect(out.result).toMatchObject({ valid: true, verifiedByNooscape: true, keyStatus: "active", issues: [] });
  });

  it("has a README that says how to run it, what the exit status is, and what the check does not tell you", () => {
    const readme = read("README.md");
    for (const word of ["npx nooscape-verify", "--keys", "--fetch-keys", "--json", "Exit status", "https://nooscape.si/.well-known/nooscape-keys.json", "Export signed JSON", "POST /api/v1/verify", "Nothing about the agent"]) {
      expect(readme, word).toContain(word);
    }
    expect(readme).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });
});
