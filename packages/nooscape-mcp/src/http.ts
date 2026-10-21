import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * The Streamable HTTP mode, behind a flag. It is stateless: each POST to /mcp gets its own server and answers with JSON, so nothing is kept
 * between requests and there is no session to steal. It is for trying the server locally and for hosting later, and it is NOT deployed
 * anywhere by this package.
 *
 * It has no sign-in of its own. By default it listens on 127.0.0.1 only, accepts only a Host header for that address and refuses any request
 * that carries an Origin header (a browser page on another site), which is what stops a web page from reaching a local server. Anyone who can
 * reach it uses the server's one API key, so it must not be put on a public address as it is.
 */

const MAX_BODY_BYTES = 1_000_000;

export type HttpOptions = {
  port: number;
  host: string;
  /** A new server for every request. */
  makeServer: () => McpServer;
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
export const isLoopback = (host: string) => LOOPBACK.has(host);

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

async function readJson(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, message: "The request body is too large." };
    chunks.push(chunk as Buffer);
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, message: "The request body is not valid JSON." };
  }
}

export function startHttp(options: HttpOptions): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const guarded = isLoopback(options.host);
  const server = createServer(async (req, res) => {
    try {
      if (guarded) {
        // A browser page on another site could reach a local server through the user's browser. A local MCP client sends no Origin; a browser always does.
        if (req.headers.origin !== undefined) return send(res, 403, rpcError(-32000, "Requests with an Origin header are refused."));
        const port = (server.address() as AddressInfo).port;
        const hostHeader = (req.headers.host ?? "").toLowerCase();
        if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader)) return send(res, 403, rpcError(-32000, "The Host header is not this server's address."));
      }
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== "/mcp") return send(res, 404, rpcError(-32000, "Not found. The MCP endpoint is /mcp."));
      if (req.method !== "POST") return send(res, 405, rpcError(-32000, "Method not allowed. This server is stateless: POST JSON-RPC to /mcp."), { allow: "POST" });

      const parsed = await readJson(req);
      if (!parsed.ok) return send(res, parsed.status, rpcError(-32700, parsed.message));

      const mcp = options.makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed.body);
    } catch {
      if (!res.headersSent) send(res, 500, rpcError(-32603, "Internal error."));
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, close: () => new Promise<void>(done => server.close(() => done())) });
    });
  });
}
