// Restores the execute permission on esbuild's native binary before the build runs it.
//
// On 2026-10-14 every build on the host failed in `vite build` with
// "spawn .../@esbuild/linux-x64/bin/esbuild EACCES", for a commit that had built
// fine half an hour earlier. pnpm hard-links packages out of one store, so a binary
// whose execute bit is lost there is handed to every later install without it.
// Nothing in the repository changed, and esbuild's own install script (which pnpm 10
// skips) does not repair this: it runs the binary and fails if it cannot.
//
// A binary that is already executable is left alone, so this does nothing on a
// healthy host. It never fails the build itself: if it cannot help, the build that
// follows reports the original error.
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const EXECUTE = 0o111;

/** Adds `bits` to the path's permissions when they are missing, and says whether it changed anything. */
function ensureMode(path, bits, repaired) {
  const mode = statSync(path).mode & 0o7777;
  if ((mode & bits) === bits) return;
  chmodSync(path, mode | bits);
  repaired.push(path);
}

/**
 * Makes the esbuild platform binaries under `root`/node_modules/.pnpm executable
 * (and the directories on the way searchable). Returns the paths it changed.
 */
export function ensureEsbuildExecutable(root = process.cwd()) {
  // Windows has no execute bit.
  if (process.platform === "win32") return [];
  const store = join(root, "node_modules", ".pnpm");
  if (!existsSync(store)) return [];

  const repaired = [];
  for (const entry of readdirSync(store)) {
    // pnpm names each package directory after the package and version: @esbuild+linux-x64@0.28.2
    const platform = /^@esbuild\+([^@]+)@/.exec(entry)?.[1];
    if (!platform) continue;
    const packageDir = join(store, entry, "node_modules", "@esbuild", platform);
    const binary = join(packageDir, "bin", "esbuild");
    // Directories first: a binary inside one that cannot be searched cannot even be found.
    for (const directory of [packageDir, dirname(binary)]) {
      if (existsSync(directory)) ensureMode(directory, EXECUTE, repaired);
    }
    if (existsSync(binary)) ensureMode(binary, EXECUTE, repaired);
  }
  return repaired;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const repaired = ensureEsbuildExecutable();
    if (repaired.length > 0) console.log(`[build] restored the execute permission on ${repaired.length} esbuild path${repaired.length === 1 ? "" : "s"}`);
  } catch (error) {
    console.warn(`[build] could not check esbuild's permissions: ${error instanceof Error ? error.message : String(error)}`);
  }
}
