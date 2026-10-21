#!/usr/bin/env node
/**
 * Profiles a running server's CPU through its inspector for a few seconds and
 * prints where the time went. Start the server with --inspect=9230, then:
 *
 *   node scripts/loadtest/cpuprofile.mjs --seconds 30
 */
import { flag, num, option, sleep } from "./lib.mjs";

const port = num("port", 9230);
const seconds = num("seconds", 30);
const top = num("top", 25);

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const wsUrl = list[0].webSocketDebuggerUrl;
const socket = new WebSocket(wsUrl);
await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) pending.get(message.id)(message);
});
const send = (method, params = {}) =>
  new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 500 });
await send("Profiler.start");
console.log(`profiling for ${seconds} s...`);
await sleep(seconds * 1000);
const { result } = await send("Profiler.stop");
const profile = result.profile;

const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const selfTime = new Map();
const deltas = profile.timeDeltas;
profile.samples.forEach((id, index) => selfTime.set(id, (selfTime.get(id) ?? 0) + (deltas[index] ?? 0)));
const total = [...selfTime.values()].reduce((a, b) => a + b, 0);

const byFunction = new Map();
for (const [id, micros] of selfTime) {
  const frame = nodes.get(id).callFrame;
  const shortUrl = frame.url.replace(/^.*[\\/]node_modules[\\/]/, "node_modules/").replace(/^file:\/\/\/.*[\\/](dist|server)[\\/]/, "$1/");
  const key = `${frame.functionName || "(anonymous)"}  ${shortUrl}:${frame.lineNumber + 1}`;
  byFunction.set(key, (byFunction.get(key) ?? 0) + micros);
}
console.log(`sampled ${(total / 1e6).toFixed(1)} s of CPU in a ${seconds} s window (${((total / 1e6 / seconds) * 100).toFixed(0)}% of one core)`);
console.log("self time, top functions:");
[...byFunction.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, top)
  .forEach(([key, micros]) => console.log(`${((micros / total) * 100).toFixed(1).padStart(5)}%  ${(micros / 1000).toFixed(0).padStart(7)} ms  ${key}`));

// Longest unbroken run of non-idle samples approximates the longest event-loop block.
let longest = 0;
let run = 0;
profile.samples.forEach((id, index) => {
  const idle = nodes.get(id).callFrame.functionName === "(idle)";
  if (idle) {
    longest = Math.max(longest, run);
    run = 0;
  } else run += deltas[index] ?? 0;
});
longest = Math.max(longest, run);
console.log(`longest stretch without an idle sample: ${(longest / 1000).toFixed(0)} ms`);
socket.close();
process.exit(0);
