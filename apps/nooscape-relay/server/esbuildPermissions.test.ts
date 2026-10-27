import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * On 2026-10-14 every build on the host failed in `vite build` with
 * "spawn .../@esbuild/linux-x64/bin/esbuild EACCES", for a commit that had built
 * half an hour earlier: the host's package store had lost the execute bit on
 * esbuild's binary. The build now restores it first. A file's execute bit means
 * nothing on Windows, so these run on Linux and macOS only.
 */
const script = new URL("../scripts/ensure-esbuild-executable.mjs", import.meta.url);
const { ensureEsbuildExecutable } = (await import(script.href)) as { ensureEsbuildExecutable: (root: string) => string[] };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project directory with pnpm's layout for esbuild's platform packages. */
function project(platforms: Array<{ platform: string; mode?: number; binDirMode?: number } | string> = ["linux-x64"]) {
  const root = mkdtempSync(join(tmpdir(), "esbuild-perms-"));
  roots.push(root);
  const binaries: string[] = [];
  for (const entry of platforms) {
    const { platform, mode = 0o644, binDirMode } = typeof entry === "string" ? { platform: entry } : entry;
    const packageDir = join(root, "node_modules", ".pnpm", `@esbuild+${platform}@0.28.2`, "node_modules", "@esbuild", platform);
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    const binary = join(packageDir, "bin", "esbuild");
    writeFileSync(binary, "#!/bin/sh\necho 0.28.2\n");
    chmodSync(binary, mode);
    if (binDirMode !== undefined) chmodSync(join(packageDir, "bin"), binDirMode);
    binaries.push(binary);
  }
  return { root, binaries };
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(process.platform === "win32")("the esbuild binary the build is about to run", () => {
  it("is made executable when it has lost the execute bit", () => {
    const { root, binaries } = project(["linux-x64"]);
    const repaired = ensureEsbuildExecutable(root);
    expect(repaired).toEqual([binaries[0]]);
    expect(modeOf(binaries[0]!) & 0o111).toBe(0o111);
  });

  it("keeps the permissions it already had", () => {
    const { root, binaries } = project([{ platform: "linux-x64", mode: 0o640 }]);
    ensureEsbuildExecutable(root);
    expect(modeOf(binaries[0]!)).toBe(0o751);
  });

  it("is made executable when it is read-only", () => {
    const { root, binaries } = project([{ platform: "linux-x64", mode: 0o444 }]);
    ensureEsbuildExecutable(root);
    expect(modeOf(binaries[0]!) & 0o111).toBe(0o111);
  });

  it("can then be run", () => {
    const { root, binaries } = project(["linux-x64"]);
    expect(() => execFileSync(binaries[0]!, ["--version"])).toThrow(/EACCES/);
    ensureEsbuildExecutable(root);
    expect(execFileSync(binaries[0]!, ["--version"]).toString().trim()).toBe("0.28.2");
  });

  it("is left alone when it is already executable", () => {
    const { root, binaries } = project([{ platform: "linux-x64", mode: 0o755 }]);
    expect(ensureEsbuildExecutable(root)).toEqual([]);
    expect(modeOf(binaries[0]!)).toBe(0o755);
  });

  it("has the directories on the way made searchable first, so a binary inside them can be found", () => {
    const { root, binaries } = project([{ platform: "linux-x64", mode: 0o644, binDirMode: 0o600 }]);
    const repaired = ensureEsbuildExecutable(root);
    expect(repaired).toContain(join(binaries[0]!, ".."));
    expect(repaired).toContain(binaries[0]!);
    expect(modeOf(join(binaries[0]!, "..")) & 0o111).toBe(0o111);
    expect(modeOf(binaries[0]!) & 0o111).toBe(0o111);
  });

  it("repairs the binary of every platform package the store holds, and nothing else", () => {
    const { root, binaries } = project(["linux-x64", "darwin-arm64"]);
    const other = join(root, "node_modules", ".pnpm", "rollup@4.0.0", "node_modules", "rollup", "bin");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "rollup"), "x");
    chmodSync(join(other, "rollup"), 0o644);
    const repaired = ensureEsbuildExecutable(root);
    expect(repaired).toEqual(expect.arrayContaining(binaries));
    expect(modeOf(join(other, "rollup"))).toBe(0o644);
  });

  it("does nothing, and does not fail, without a pnpm store or without the binary", () => {
    const empty = mkdtempSync(join(tmpdir(), "esbuild-perms-"));
    roots.push(empty);
    expect(ensureEsbuildExecutable(empty)).toEqual([]);
    mkdirSync(join(empty, "node_modules", ".pnpm", "@esbuild+linux-x64@0.28.2", "node_modules", "@esbuild", "linux-x64"), { recursive: true });
    expect(ensureEsbuildExecutable(empty)).toEqual([]);
  });

  it("reports what it did when run as the build step, and says nothing when there was nothing to do", () => {
    const { root } = project(["linux-x64"]);
    const run = () => execFileSync(process.execPath, [fileURLToPath(script)], { cwd: root }).toString();
    expect(run()).toContain("restored the execute permission on 1 esbuild path");
    expect(run()).toBe("");
  });
});

describe("the build script", () => {
  it("restores esbuild's permissions before anything runs esbuild", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.build).toMatch(/^node scripts\/ensure-esbuild-executable\.mjs && vite build && esbuild /);
  });

  it("ends by printing the Node version, because the host's own line says only `Node.js: 22`", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.build).toMatch(/ && node -v$/);
  });
});
