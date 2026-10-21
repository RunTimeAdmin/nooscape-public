// Runs the server over stdio the way a client does, and calls all four tools against the LIVE Nooscape API.
//
//   node scripts/live-check.mjs                       the built server (run `pnpm run build` first)
//   node scripts/live-check.mjs --npx <package spec>  through npx, e.g. ./nooscape-mcp-0.1.0.tgz or nooscape-mcp
//
// It reads NOOSCAPE_API_KEY from the environment if it is set (it is passed on and never printed). Without a key it expects the
// history to say a key is needed and the check to say what a Pro key or a payment is, which is what a keyless user sees.
// It makes about a dozen requests, well inside the public limit of 30 a minute. Nothing is paid, signed or changed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const npxAt = args.indexOf("--npx");
const hasKey = Boolean(process.env.NOOSCAPE_API_KEY && !process.env.NOOSCAPE_API_KEY.startsWith("${"));

const transport =
  npxAt >= 0
    ? new StdioClientTransport({ command: "npx", args: ["-y", `--package=${args[npxAt + 1]}`, "nooscape-mcp"], env: { ...process.env } })
    : new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/cli.js", import.meta.url).pathname.replace(/^[/]([A-Za-z]:)/, "$1")], env: { ...process.env } });

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};
const text = result => (result.content ?? []).map(part => part.text ?? "").join("\n");
const first = result => (result.content?.[0]?.text ?? "").split("\n")[0];

const client = new Client({ name: "live-check", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
check("four tools are offered, all read-only", tools.length === 4 && tools.every(tool => tool.annotations?.readOnlyHint === true), tools.map(tool => tool.name).join(", "));

const search = await client.callTool({ name: "search_agents", arguments: { query: "agent", chain: "robinhood" } });
check("search_agents answers with a summary and the JSON", !search.isError && search.content.length === 2 && JSON.parse(search.content[1].text).data.results.length > 0, first(search));
const hit = JSON.parse(search.content[1].text).data.results[0];

const agent = await client.callTool({ name: "get_agent", arguments: { chain: hit.chain, id: hit.agent_id } });
const agentJson = agent.isError ? null : JSON.parse(agent.content[1].text);
check("get_agent answers with the date, the source and the evidence level", !agent.isError && /Data as of /.test(text(agent)) && /Source: /.test(text(agent)) && /Evidence: layer /.test(text(agent)) && agentJson?.as_of && agentJson?.source && agentJson?.data?.evidence, first(agent));

const missing = await client.callTool({ name: "get_agent", arguments: { chain: "robinhood", id: "99999999" } });
check("an id that is not listed is a clear error", missing.isError === true && /never listed/.test(text(missing)), first(missing));

const history = await client.callTool({ name: "get_agent_history", arguments: { chain: hit.chain, id: hit.agent_id } });
if (hasKey) check("get_agent_history answers with a key", !history.isError && /Registry events:/.test(text(history)), first(history));
else check("get_agent_history without a key says a key is needed", history.isError === true && /NOOSCAPE_API_KEY/.test(text(history)), first(history));

const checked = await client.callTool({ name: "check", arguments: { agent: { chain: hit.chain, id: hit.agent_id } } });
if (!checked.isError) check("check answers (the key in use is a Pro key)", /Pre-flight facts/.test(text(checked)), first(checked));
else if (hasKey) check("check with a key that is not Pro explains what is needed", /Pro key/.test(text(checked)), first(checked));
else check("check without a key shows the 402 as a message with the price", /x402 payment of \$[0-9.]+ per call/.test(text(checked)) && /does not sign or send payments/.test(text(checked)) && /Nothing was charged/.test(text(checked)), first(checked));

const both = await client.callTool({ name: "check", arguments: { wallet: "0x0000000000000000000000000000000000000001", agent: { chain: "robinhood", id: "1" } } });
check("check needs exactly one subject", both.isError === true && /exactly one/.test(text(both)), first(both));

await client.close();
console.log(failures === 0 ? "ALL OK" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
