import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NooscapeClient } from "../src/client.js";
import { isLoopback, startHttp } from "../src/http.js";
import { createNooscapeServer } from "../src/server.js";
import { AGENT } from "./fixtures.js";

const KEY = "nsk_" + "k".repeat(40);

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(close => close()));
});

async function start(host = "127.0.0.1") {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(AGENT), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const api = new NooscapeClient({ userAgent: "nooscape-mcp/test", fetch: fetchImpl, apiKey: KEY });
  const http = await startHttp({ port: 0, host, makeServer: () => createNooscapeServer(api) });
  running.push(http.close);
  return { http, url: `http://127.0.0.1:${http.port}/mcp`, fetchImpl };
}

/** A raw request, so the Host header can be chosen. */
function raw(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: options.method ?? "POST", path: options.path ?? "/mcp", headers: options.headers }, res => {
      let body = "";
      res.on("data", chunk => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const jsonHeaders = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });

describe("the Streamable HTTP mode", () => {
  it("serves the four tools to a real MCP client, and a tool call reaches the API", async () => {
    const { url, fetchImpl } = await start();
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(["check", "get_agent", "get_agent_history", "search_agents"]);
    const result = (await client.callTool({ name: "get_agent", arguments: { chain: "robinhood", id: "8865" } })) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("Agent #8865");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("keeps no session between requests", async () => {
    const { http } = await start();
    const a = await raw(http.port, { headers: jsonHeaders({ host: `127.0.0.1:${http.port}` }), body: rpc });
    const b = await raw(http.port, { headers: jsonHeaders({ host: `127.0.0.1:${http.port}` }), body: rpc });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(JSON.parse(a.body).result.tools).toHaveLength(4);
  });

  it("answers only POST to /mcp: a GET is 405 with what is allowed, anything else is 404", async () => {
    const { http } = await start();
    const get = await raw(http.port, { method: "GET", headers: { host: `127.0.0.1:${http.port}` } });
    expect(get.status).toBe(405);
    const other = await raw(http.port, { path: "/", headers: jsonHeaders({ host: `127.0.0.1:${http.port}` }), body: rpc });
    expect(other.status).toBe(404);
    const deep = await raw(http.port, { path: "/mcp/extra", headers: jsonHeaders({ host: `127.0.0.1:${http.port}` }), body: rpc });
    expect(deep.status).toBe(404);
  });

  it("refuses a request that carries an Origin header, which is what a web page sends", async () => {
    const { http } = await start();
    const result = await raw(http.port, { headers: jsonHeaders({ host: `127.0.0.1:${http.port}`, origin: "https://evil.example" }), body: rpc });
    expect(result.status).toBe(403);
    expect(result.body).toContain("Origin");
  });

  it("refuses a Host header that is not its own address (DNS rebinding)", async () => {
    const { http } = await start();
    for (const host of ["evil.example", `evil.example:${http.port}`, "127.0.0.1:1", "localhost"]) {
      const result = await raw(http.port, { headers: jsonHeaders({ host }), body: rpc });
      expect(result.status, host).toBe(403);
    }
    const local = await raw(http.port, { headers: jsonHeaders({ host: `localhost:${http.port}` }), body: rpc });
    expect(local.status).toBe(200);
  });

  it("refuses a body that is not JSON, and one that is too large", async () => {
    const { http } = await start();
    const headers = jsonHeaders({ host: `127.0.0.1:${http.port}` });
    const broken = await raw(http.port, { headers, body: "{ nope" });
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body).error.code).toBe(-32700);
    const huge = await raw(http.port, { headers, body: JSON.stringify({ pad: "x".repeat(1_100_000) }) });
    expect(huge.status).toBe(413);
  });

  it("does not put the key in anything it answers", async () => {
    const { http } = await start();
    const headers = jsonHeaders({ host: `127.0.0.1:${http.port}` });
    const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_agent", arguments: { chain: "robinhood", id: "8865" } } });
    const answers = [await raw(http.port, { headers, body: call }), await raw(http.port, { headers, body: rpc }), await raw(http.port, { method: "GET", headers })];
    for (const answer of answers) expect(answer.body).not.toContain(KEY);
  });

  it("listens on this machine only unless it is told otherwise", async () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.5")).toBe(false);
    const { http } = await start();
    expect((http.server.address() as { address: string }).address).toBe("127.0.0.1");
  });
});
