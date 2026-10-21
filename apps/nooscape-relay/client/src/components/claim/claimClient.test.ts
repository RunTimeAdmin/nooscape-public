import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What "Claim this agent" promises about the browser (docs/claims-2026-10-18.md), held to the client's source: the wallet is asked
 * for an account and a signature and nothing else, the panel keeps nothing in the browser, only the panel reaches the wallet code,
 * and the panel is on a page only behind the `claims` switch.
 */
const client = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(path, "utf8");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const sources = sourceFiles(client).map(path => ({ file: relative(client, path).replaceAll("\\", "/"), text: read(path) }));
const CLAIM_FILES = [
  "components/claim/ClaimPanel.tsx",
  "components/claim/ClaimHistory.tsx",
  "components/claim/OwnerText.tsx",
  "components/claim/OperatorClaims.tsx",
  "lib/wallet.ts",
  "lib/claimFlow.ts",
];

describe("what the client asks of a wallet", () => {
  it("is an account and a signature: no source in the client names any other wallet method", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_signTypedData|eth_sign\b|wallet_\w+|eth_accounts|eth_getBalance|personal_ecRecover/);
    }
  });

  it("goes through lib/wallet.ts alone: only it reads the page's wallet or sends a request to one", () => {
    const readers = sources.filter(({ text }) => /\bwindow\.ethereum\b|\.ethereum\b|\.request\(\s*\{/.test(text)).map(({ file }) => file);
    expect(readers).toEqual(["lib/wallet.ts"]);
    const users = sources.filter(({ text }) => /from "@\/lib\/wallet"|from "\.\/wallet"/.test(text)).map(({ file }) => file);
    expect(users).toEqual(["components/claim/ClaimPanel.tsx"]);
  });

  it("keeps the list of methods to the two it needs", () => {
    expect(read(join(client, "lib", "wallet.ts"))).toContain('export const WALLET_METHODS = ["eth_requestAccounts", "personal_sign"] as const;');
  });
});

describe("what the claim code keeps in the browser", () => {
  it("is nothing: no storage, no cookie, no address in a URL or the console", () => {
    for (const file of CLAIM_FILES) {
      const text = sources.find(source => source.file === file)?.text ?? "";
      expect(text.length, file).toBeGreaterThan(0);
      expect(text, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.(clipboard|sendBeacon)|console\.|history\.(push|replace)State|location\.(hash|search|href)\s*=/);
    }
  });
});

describe("where the panel is", () => {
  it("is imported by the entry page alone, and shown there only behind the claims switch and only for an entry on a claimable registry", () => {
    const importers = sources.filter(({ text }) => /from "@\/components\/claim\/ClaimPanel"/.test(text)).map(({ file }) => file);
    expect(importers).toEqual(["pages/DirectoryAgent.tsx"]);
    const page = read(join(client, "pages", "DirectoryAgent.tsx"));
    expect(page).toContain('const CLAIMS_ON = featureOn("claims", import.meta.env.VITE_FEATURES);');
    expect(page).toContain("{CLAIMS_ON && claimChainLabel(entry.protocol) && <ClaimPanel ");
    expect(page.match(/<ClaimPanel\b/g)).toHaveLength(1);
  });

  it("shows what an owner wrote and the history only inside the panel, and the operator's tool only on the operator's page, after its sign-in check", () => {
    const importers = (name: string) => sources.filter(({ text }) => text.includes(`from "./${name}"`) || text.includes(`from "@/components/claim/${name}"`)).map(({ file }) => file);
    expect(importers("OwnerText")).toEqual(["components/claim/ClaimPanel.tsx"]);
    expect(importers("ClaimHistory")).toEqual(["components/claim/ClaimPanel.tsx"]);
    expect(importers("OperatorClaims")).toEqual(["pages/SourceOperations.tsx"]);
    const operatorPage = read(join(client, "pages", "SourceOperations.tsx"));
    expect(operatorPage.match(/<OperatorClaims \/>/g)).toHaveLength(1);
    expect(operatorPage.indexOf("<OperatorClaims />")).toBeGreaterThan(operatorPage.indexOf("if (!isOperator)"));
  });

  it("shows an owner's words as text: no HTML is built from them, and an address is a link only through the https check with the user-content rel", () => {
    for (const file of ["components/claim/OwnerText.tsx", "components/claim/ClaimHistory.tsx", "components/claim/OperatorClaims.tsx", "components/claim/ClaimPanel.tsx"]) {
      const text = sources.find(source => source.file === file)?.text ?? "";
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/);
    }
    const ownerText = sources.find(source => source.file === "components/claim/OwnerText.tsx")!.text;
    expect(ownerText).toContain("safeHttpsHref(address)");
    expect(ownerText).toContain("rel={OWNER_LINK_REL}");
    expect(ownerText.match(/href=/g)).toHaveLength(1);
    expect(sources.find(source => source.file === "lib/claimFlow.ts")!.text).toContain('export const OWNER_LINK_REL = "nofollow ugc noopener noreferrer";');
  });

  it("is off in a build that does not name it", () => {
    const features = read(join(client, "..", "..", "shared", "features.ts"));
    expect(features).toContain('export const FEATURES = ["watch", "patrols", "claims", "chain_base", "chain_ethereum", "chain_arc", "claims_arc"] as const;');
  });
});
