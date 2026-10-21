import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAIM_MESSAGES } from "./claims";

/**
 * What the claim flow must never do, held at the source (docs/claims-2026-10-18.md): rewrite its public history, reach the listing or a
 * tier, or put an address or a key in an answer. A claim is the owner's word beside what Nooscape observed, and nothing else.
 */
const server = fileURLToPath(new URL(".", import.meta.url));
const app = join(server, "..");
const read = (path: string) => readFileSync(path, "utf8");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = [...sourceFiles(server), ...sourceFiles(join(app, "client", "src")), ...sourceFiles(join(app, "shared"))].map(path => ({ file: relative(app, path).replaceAll("\\", "/"), text: withoutComments(read(path)) }));

describe("the claim history", () => {
  it("is append-only: no code updates or deletes a row of agent_claim_edits", () => {
    for (const { file, text } of files) {
      expect(text, file).not.toMatch(/\.(update|delete)\(\s*agentClaimEdits\b/);
      expect(text, file).not.toMatch(/agent_claim_edits[\s\S]{0,40}(UPDATE|DELETE)|(UPDATE|DELETE)[\s\S]{0,40}agent_claim_edits/i);
    }
  });

  it("is written only by the claim module, which is the only code that writes the other two claim tables", () => {
    for (const table of ["agentClaimEdits", "agentClaims", "agentClaimNonces"]) {
      const writers = files.filter(({ text }) => new RegExp(`\\.(insert|update|delete)\\(\\s*${table}\\b`).test(text)).map(({ file }) => file);
      expect(writers, table).toEqual(["server/claims.ts"]);
    }
  });
});

describe("what a claim can reach", () => {
  it("is imported by the router, the worker and nothing else: no read of the listing, a tier or the map knows about claims", () => {
    const importers = files.filter(({ text }) => /from "(\.\/|\.\.\/)claims"/.test(text)).map(({ file }) => file).sort();
    expect(importers).toEqual(["server/ingestion/worker.ts", "server/routers/claim.ts"]);
  });

  it("never names a tier, a publisher state, a rating, a listing flag or a score in the claim code", () => {
    const claimFiles = files.filter(({ file }) => /^(server\/claims(Chain|Crypto|Arc)?\.ts|server\/routers\/claim\.ts|shared\/claim(Profile|Message)\.ts)$/.test(file));
    expect(claimFiles.map(({ file }) => file).sort()).toEqual(["server/claims.ts", "server/claimsArc.ts", "server/claimsChain.ts", "server/claimsCrypto.ts", "server/routers/claim.ts", "shared/claimMessage.ts", "shared/claimProfile.ts"]);
    for (const { file, text } of claimFiles) {
      expect(text, file).not.toMatch(/evidenceTier|publisherState|hidden\b|listing\b|\bscore\b|\brank\b|\btier_[0-9]/i);
    }
  });
});

describe("what a visitor is told", () => {
  it("is fixed text: no address, no key, no query, no long dash", () => {
    for (const [code, message] of Object.entries(CLAIM_MESSAGES)) {
      expect(message, code).not.toMatch(/0x[0-9a-fA-F]{4}|https?:|select |insert |SECRET|[–—]/i);
      expect(message.length, code).toBeLessThan(200);
    }
  });

  it("is never logged with the address of the visitor: the claim code keeps the limiter's own line as the only one that does", () => {
    for (const { file, text } of files.filter(({ file }) => /^server\/claims|^server\/routers\/claim/.test(file))) {
      expect(text, file).not.toMatch(/console\.(log|warn|info|error)\([^)]*(\bip\b|clientKey|wallet|address)/i);
    }
  });
});
