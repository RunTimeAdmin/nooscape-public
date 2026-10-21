import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { NooscapeClient } from "../src/client.js";
import { createNooscapeServer } from "../src/server.js";
import { VERSION } from "../src/version.js";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const serverJson = JSON.parse(read("server.json"));
const manifest = JSON.parse(read("manifest.json"));
const readme = read("README.md");

describe("the files a registry reads", () => {
  it("agree on the name and the version", () => {
    expect(pkg.version).toBe(VERSION);
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages[0].version).toBe(pkg.version);
    expect(serverJson.packages[0].identifier).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.name).toBe(pkg.name);
    expect(serverJson.name).toBe(pkg.mcpName);
    expect(manifest.license).toBe(pkg.license);
  });

  it("fit the registry's limits and say the key is optional and secret", () => {
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
    const key = serverJson.packages[0].environmentVariables.find((item: { name: string }) => item.name === "NOOSCAPE_API_KEY");
    expect(key).toMatchObject({ isRequired: false, isSecret: true });
    expect(serverJson.packages[0].transport.type).toBe("stdio");
    expect(manifest.user_config.api_key).toMatchObject({ sensitive: true, required: false });
    expect(manifest.server.mcp_config.env.NOOSCAPE_API_KEY).toBe("${user_config.api_key}");
  });

  it("list the tools the server really has", async () => {
    const server = createNooscapeServer(new NooscapeClient({ userAgent: "test" }));
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const real = (await client.listTools()).tools.map(tool => tool.name).sort();
    await client.close();
    expect(manifest.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(real);
    for (const name of real) expect(readme).toContain(name);
  });

  it("build with LF line endings, so the shebang line of the program works on Linux and macOS when it is built on Windows", () => {
    expect(read("tsconfig.json")).toContain('"newLine": "lf"');
  });

  it("publish only what they should: the build, the manifests, the readme and the license", () => {
    expect(pkg.files.slice().sort()).toEqual(["LICENSE", "README.md", "dist", "manifest.json", "server.json"]);
    expect(pkg.bin["nooscape-mcp"]).toBe("dist/cli.js");
    expect(manifest.server.entry_point).toBe("dist/cli.js");
  });
});

describe("what the readme promises", () => {
  it("says there is no wallet, no payment made, and where a key comes from", () => {
    expect(readme).toContain("holds no wallet and does not sign or send payments");
    expect(readme).toContain("NOOSCAPE_API_KEY");
    expect(readme).toContain("nooscape.si/developers/keys");
  });

  it("carries the no paid influence line and the data attribution", () => {
    expect(readme).toContain("Nothing a caller pays buys a listing, a tier or an evidence level.");
    expect(readme).toContain("Data from Nooscape (https://nooscape.si).");
    expect(readme).toContain("nooscape.si/terms");
  });

  it("gives install snippets for Claude Desktop and Cursor with npx", () => {
    expect(readme).toContain("### Claude Desktop");
    expect(readme).toContain("### Cursor");
    expect(readme.match(/"args": \["-y", "nooscape-mcp"\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("says the package has not been published and the registries have not been submitted", () => {
    expect(readme).toContain("Neither has been submitted and the package has not been published.");
  });

  it("uses no long dashes", () => {
    for (const text of [readme, JSON.stringify(serverJson), JSON.stringify(manifest)]) expect(text).not.toMatch(/[–—]/);
  });
});
