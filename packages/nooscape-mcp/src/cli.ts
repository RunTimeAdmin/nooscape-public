#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NooscapeClient } from "./client.js";
import { isLoopback, startHttp } from "./http.js";
import { createNooscapeServer } from "./server.js";
import { VERSION } from "./version.js";

export const USAGE = `nooscape-mcp ${VERSION}

An MCP server for Nooscape: what is on record about an AI agent, a wallet or an endpoint, with dates.
It reads the public Nooscape API (https://nooscape.si/api/v1) and nothing else.

Usage:
  nooscape-mcp                      Serve over stdio (Claude Desktop, Cursor, and other MCP clients).
  nooscape-mcp --http [options]     Serve over Streamable HTTP at /mcp instead (stateless, no sign-in).

Options for --http:
  --port <number>    Port to listen on. Default 8787.
  --host <address>   Address to bind. Default 127.0.0.1 (this machine only).

Environment:
  NOOSCAPE_API_KEY   Optional. An API key, sent as a bearer token. A free key unlocks get_agent_history;
                     the check needs a Pro key. Never logged or echoed.

Other:
  --help, -h         Show this help.
  --version, -v      Show the version.
`;

export type Parsed = { mode: "stdio" } | { mode: "http"; port: number; host: string } | { mode: "help" } | { mode: "version" } | { mode: "error"; message: string };

export function parseArgs(argv: string[]): Parsed {
  let http = false;
  let port = 8787;
  let host = "127.0.0.1";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") return { mode: "help" };
    if (arg === "--version" || arg === "-v") return { mode: "version" };
    if (arg === "--http") {
      http = true;
    } else if (arg === "--port" || arg === "--host") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { mode: "error", message: `${arg} needs a value.` };
      index += 1;
      if (arg === "--host") {
        host = value;
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return { mode: "error", message: "--port must be a whole number from 0 to 65535." };
        port = parsed;
      }
    } else {
      return { mode: "error", message: `Unknown option ${arg}.` };
    }
  }
  if (!http && (argv.includes("--port") || argv.includes("--host"))) return { mode: "error", message: "--port and --host belong with --http." };
  return http ? { mode: "http", port, host } : { mode: "stdio" };
}

/**
 * The API key from the environment, or undefined. An empty value is no key, and so is a placeholder that a host passed through unfilled
 * (a bundle's `${user_config.api_key}` for a setting the user left blank).
 */
export function keyFrom(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.NOOSCAPE_API_KEY?.trim();
  return raw && !raw.startsWith("${") ? raw : undefined;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.mode === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.mode === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.mode === "error") {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    return 2;
  }

  const client = new NooscapeClient({ apiKey: keyFrom(env), userAgent: `nooscape-mcp/${VERSION}` });

  if (parsed.mode === "http") {
    if (!isLoopback(parsed.host)) {
      process.stderr.write("Warning: this address is not local. The HTTP mode has no sign-in, and everyone who can reach it uses this server's API key.\n");
    }
    const running = await startHttp({ port: parsed.port, host: parsed.host, makeServer: () => createNooscapeServer(client) });
    process.stderr.write(`nooscape-mcp ${VERSION} listening on http://${parsed.host}:${running.port}/mcp\n`);
    await new Promise<void>(done => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
    await running.close();
    return 0;
  }

  // stdout belongs to the protocol in this mode: everything else goes to stderr.
  const server = createNooscapeServer(client);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`nooscape-mcp ${VERSION} running on stdio${client.hasKey ? " (with an API key)" : ""}\n`);
  await new Promise<void>(done => {
    process.stdin.once("end", done);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await server.close();
  return 0;
}

/** True when this file is the program being run (also through the symlink npx makes), and not when a test imports it. */
function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2), process.env).then(
    code => process.exit(code),
    () => {
      process.stderr.write("nooscape-mcp stopped because of an unexpected error.\n");
      process.exit(1);
    },
  );
}
