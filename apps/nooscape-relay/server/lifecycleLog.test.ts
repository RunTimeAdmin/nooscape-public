import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifecycleLog,
  describeError,
  hostSettings,
  isOtherProcessAlive,
  parseLimits,
  parseProcStatus,
  parseTrail,
  readCgroupMemory,
  readShutdown,
  startLifecycleLog,
  summarizeTrail,
  trimTrail,
  type Io,
  type TrailEvent,
} from "./lifecycleLog";
import { createShutdown } from "./gracefulShutdown";

/**
 * server/lifecycleLog.ts (docs/lifecycle-logging-2026-11-01.md): what is written when the process is stopped, crashes, exits or is
 * killed, and how the next process reads it. The first part is the pure reading of the trail and of /proc; the second runs the
 * behaviour against a world of its own; the third runs real processes, because the one thing that must hold is that a signal still ends
 * the process the way it did before (killed by that signal, not exited with a code), and only a real process can show it.
 */
const MB = 1024 * 1024;
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const start = (inst: string, seconds: number, extra: Partial<TrailEvent> = {}): TrailEvent => ({ ev: "start", inst, at: at(seconds), pid: 100, rssMb: 200, ...extra });
const beat = (inst: string, seconds: number, extra: Partial<TrailEvent> = {}): TrailEvent => ({ ev: "beat", inst, at: at(seconds), rssMb: 300, hwmMb: 350, ...extra });

describe("the trail file", () => {
  it("is read line by line, skipping a line that is not an event and a last line a stop cut short", () => {
    const good = JSON.stringify(start("a1", 0));
    const text = [good, "not json", '{"ev":"mystery","inst":"a1","at":"2026-11-01T12:00:00.000Z"}', '{"ev":"beat","inst":"a1","at":"not a date"}', JSON.stringify(beat("a1", 60)), '{"ev":"beat","inst":"a1","at":"2026-11'].join("\n");
    expect(parseTrail(text).map(event => event.ev)).toEqual(["start", "beat"]);
    expect(parseTrail("")).toEqual([]);
  });

  it("keeps the event that says how a stop went", () => {
    const stop = { ev: "shutdown", inst: "a1", at: at(2), tookMs: 40, ceilingHit: false, failed: [] };
    expect(parseTrail(`${JSON.stringify(start("a1", 0))}\n${JSON.stringify(stop)}\n`).map(event => event.ev)).toEqual(["start", "shutdown"]);
  });

  it("is cut to its last part from a whole line when it has grown past the limit, and left alone when it has not", () => {
    const lines = Array.from({ length: 100 }, (_, index) => JSON.stringify(beat("a1", index)));
    const text = `${lines.join("\n")}\n`;
    expect(trimTrail(text, text.length, 1000)).toBe(text);
    const cut = trimTrail(text, text.length - 1, 1000);
    expect(cut.length).toBeLessThanOrEqual(1000);
    expect(cut.startsWith("{")).toBe(true);
    expect(text.endsWith(cut)).toBe(true);
    expect(parseTrail(cut).length).toBe(cut.split("\n").filter(Boolean).length);
    // A trail with no whole line in its last part is emptied and not left cut in the middle of one.
    expect(trimTrail("x".repeat(500), 100, 50)).toBe("");
  });
});

describe("how the earlier processes ended", () => {
  const now = T0 + 1000 * 1000;

  it("says a process that was stopped by a signal was stopped by that signal, with the time it ran and the gap before the next start", () => {
    const events = [start("a1", 0), beat("a1", 60), { ev: "signal", inst: "a1", at: at(100), signal: "SIGTERM" } as TrailEvent, start("b2", 130)];
    const [first] = summarizeTrail(events, "c3", now, null);
    expect(first).toMatchObject({ id: "a1", pid: 100, startedAt: at(0), ended: "signal", detail: "SIGTERM", lastEventAt: at(100), ranSeconds: 100, silentSeconds: 30, lastRssMb: 300, peakRssMb: 350 });
  });

  it("says a process with no end record is unknown, with its last beat, and how long the app was without a process", () => {
    const events = [start("a1", 0), beat("a1", 60), beat("a1", 120)];
    const [only] = summarizeTrail(events, "b2", T0 + 200 * 1000, null);
    expect(only).toMatchObject({ ended: "unknown", detail: null, lastEventAt: at(120), ranSeconds: 120, silentSeconds: 80, lastRssMb: 300, peakRssMb: 350 });
  });

  it("reads a crash with its origin and message, and an exit with its code, and takes the first end record when a crash is followed by an exit", () => {
    const crashed = [start("a1", 0), { ev: "crash", inst: "a1", at: at(10), origin: "uncaughtException", message: "Error: boom" } as TrailEvent, { ev: "exit", inst: "a1", at: at(10), code: 1 } as TrailEvent];
    const exited = [start("b2", 20), { ev: "exit", inst: "b2", at: at(30), code: 3 } as TrailEvent];
    const result = summarizeTrail([...crashed, ...exited], "c3", now, null);
    expect(result[0]).toMatchObject({ id: "a1", ended: "crash", detail: "uncaughtException: Error: boom" });
    expect(result[1]).toMatchObject({ id: "b2", ended: "exit", detail: 3 });
  });

  it("leaves this process out, tells two that overlap apart (a deploy starts the app twice), and shows only the last few", () => {
    const events = [start("a1", 0), start("b2", 5), beat("a1", 60), beat("b2", 65), start("self", 70), beat("self", 80)];
    const result = summarizeTrail(events, "self", now, null);
    expect(result.map(each => each.id)).toEqual(["a1", "b2"]);
    const many = Array.from({ length: 9 }, (_, index) => start(`p${index}`, index * 10));
    expect(summarizeTrail(many, "self", now, null, 5).map(each => each.id)).toEqual(["p4", "p5", "p6", "p7", "p8"]);
  });

  it("says whether the host's count of memory kills rose between a process's last beat and the next start", () => {
    const events = [start("a1", 0, { oomKills: 2 }), beat("a1", 60, { oomKills: 2 }), start("b2", 90, { oomKills: 3 }), beat("b2", 150, { oomKills: 3 })];
    const result = summarizeTrail(events, "c3", now, 3);
    expect(result[0]!.oomKillsRose).toBe(true);
    expect(result[1]!.oomKillsRose).toBe(false);
    // No count on the host, or no count in the trail: no claim either way.
    expect(summarizeTrail(events, "c3", now, null)[1]!.oomKillsRose).toBeNull();
    expect(summarizeTrail([start("a1", 0), beat("a1", 60)], "c3", now, 3)[0]!.oomKillsRose).toBeNull();
  });

  it("shows how a stop went when the process wrote it after its signal, and counts the wait in the time it ran and not in the gap", () => {
    const stop = { ev: "shutdown", inst: "a1", at: at(102), tookMs: 1550, ceilingHit: false, failed: [] } as TrailEvent;
    const events = [start("a1", 0), beat("a1", 60), { ev: "signal", inst: "a1", at: at(100), signal: "SIGTERM" } as TrailEvent, stop, start("b2", 130)];
    const [first] = summarizeTrail(events, "c3", now, null);
    expect(first).toMatchObject({ ended: "signal", detail: "SIGTERM", lastEventAt: at(102), ranSeconds: 102, silentSeconds: 28, shutdown: { tookMs: 1550, ceilingHit: false, failed: [] } });
  });

  it("shows a stop that hit the ceiling with the tasks that did not finish, and none for a process that wrote no stop", () => {
    const hit = { ev: "shutdown", inst: "a1", at: at(115), tookMs: 15_001, ceilingHit: true, failed: ["http"] } as TrailEvent;
    const events = [start("a1", 0), { ev: "signal", inst: "a1", at: at(100), signal: "SIGTERM" } as TrailEvent, hit, start("b2", 130), { ev: "signal", inst: "b2", at: at(140), signal: "SIGTERM" } as TrailEvent];
    const result = summarizeTrail(events, "c3", now, null);
    expect(result[0]!.shutdown).toEqual({ tookMs: 15_001, ceilingHit: true, failed: ["http"] });
    expect(result[1]).toMatchObject({ ended: "signal", shutdown: null });
  });

  it("is empty for an empty trail", () => {
    expect(summarizeTrail([], "self", now, null)).toEqual([]);
  });

  it("says a process with no end record whose pid is still there is running, with how long since it last wrote, and not lost", () => {
    // A deploy starts the app twice: the second starts while the first is alive and has written only its start.
    const events = [start("a1", 0, { pid: 111 })];
    const [only] = summarizeTrail(events, "b2", T0 + 32 * 1000, null, 5, pid => pid === 111);
    expect(only).toMatchObject({ id: "a1", pid: 111, ended: "running", detail: null, ranSeconds: 0, silentSeconds: 32 });
    // The same process with its pid gone is unknown, and so is one with no pid recorded, whatever answers.
    expect(summarizeTrail(events, "b2", T0 + 32 * 1000, null, 5, () => false)[0]).toMatchObject({ ended: "unknown" });
    expect(summarizeTrail([{ ev: "beat", inst: "z9", at: at(0) }], "b2", T0 + 10_000, null, 5, () => true)[0]).toMatchObject({ ended: "unknown", pid: null });
    // A process that wrote its end is never running, even if its pid answers: the pid can be used again by something else.
    const ended = [start("a1", 0, { pid: 111 }), { ev: "exit", inst: "a1", at: at(5), code: 0 } as TrailEvent];
    expect(summarizeTrail(ended, "b2", now, null, 5, () => true)[0]).toMatchObject({ ended: "exit", detail: 0 });
  });

  it("never takes this process's own pid for an earlier one still running: a container restarted in place gives the new process the old pid", () => {
    // The container was killed with no end record and started again, so the new process has the pid, 7, that the trail holds.
    const alive = (pid: number) => isOtherProcessAlive(pid, 7, () => undefined);
    expect(summarizeTrail([start("a1", 0, { pid: 7 })], "b2", T0 + 60_000, null, 5, alive)[0]).toMatchObject({ id: "a1", pid: 7, ended: "unknown" });
    // Another pid that answers is still another process running.
    expect(summarizeTrail([start("a1", 0, { pid: 8 })], "b2", T0 + 60_000, null, 5, alive)[0]).toMatchObject({ ended: "running" });
  });

  it("asks the system whether another pid is there, and counts a process it may not signal as there", () => {
    const probe = (code?: string) => () => {
      if (code) throw Object.assign(new Error(code), { code });
    };
    expect(isOtherProcessAlive(8, 7, probe())).toBe(true);
    expect(isOtherProcessAlive(8, 7, probe("EPERM"))).toBe(true);
    expect(isOtherProcessAlive(8, 7, probe("ESRCH"))).toBe(false);
    expect(isOtherProcessAlive(7, 7, probe())).toBe(false);
  });

  it("measures how long a running process has been silent from now, and a lost one from the next start", () => {
    const events = [start("a1", 0, { pid: 111 }), beat("a1", 60), start("b2", 100, { pid: 222 })];
    const running = summarizeTrail(events, "c3", T0 + 400 * 1000, null, 5, () => true);
    expect(running.map(each => [each.id, each.ended, each.silentSeconds])).toEqual([
      ["a1", "running", 340],
      ["b2", "running", 300],
    ]);
    const lost = summarizeTrail(events, "c3", T0 + 400 * 1000, null, 5, () => false);
    expect(lost.map(each => [each.id, each.ended, each.silentSeconds])).toEqual([
      ["a1", "unknown", 40],
      ["b2", "unknown", 300],
    ]);
  });
});

describe("how a stop is read", () => {
  it("takes the length, the ceiling and the names of the tasks that failed from the answer of the real shutdown, and nothing else", async () => {
    const stop = createShutdown({ log: () => undefined });
    stop.onShutdown("http", () => undefined);
    stop.onShutdown("api meter", () => {
      throw new Error("connect failed to mysql://admin:hunter2@db.example/app");
    });
    const answer = await stop.run();
    const read = readShutdown(answer);
    expect(read).toEqual({ tookMs: answer.tookMs, ceilingHit: false, failed: ["api meter"] });
    expect(JSON.stringify(read)).not.toContain("hunter2");
  });

  it("reads a task that was still running at the ceiling as one that failed", async () => {
    const stop = createShutdown({ ceilingMs: 30, log: () => undefined });
    stop.onShutdown("http", () => new Promise(() => undefined));
    stop.onShutdown("api meter", () => undefined);
    expect(readShutdown(await stop.run())).toMatchObject({ ceilingHit: true, failed: ["http"] });
  });

  it("is null for anything that is not a shutdown answer, so a wait that answers nothing writes nothing", () => {
    const notAnswers = [undefined, null, 5, "done", {}, { tookMs: 5 }, { tookMs: "5", ceilingHit: false, tasks: [] }, { tookMs: Number.NaN, ceilingHit: false, tasks: [] }, { tookMs: 5, ceilingHit: false, tasks: "none" }];
    for (const value of notAnswers) expect(readShutdown(value), JSON.stringify(value)).toBeNull();
  });

  it("keeps the names short and few, and rounds the time", () => {
    const tasks = Array.from({ length: 14 }, (_, index) => ({ name: `task-${index}-${"x".repeat(80)}`, ok: false, ms: 1 }));
    const read = readShutdown({ tookMs: 12.6, ceilingHit: false, tasks })!;
    expect(read.tookMs).toBe(13);
    expect(read.failed).toHaveLength(10);
    expect(read.failed.every(name => name.length <= 40)).toBe(true);
  });
});

describe("what the host says about the process", () => {
  it("reads the resident size, its peak and the threads from /proc/self/status", () => {
    const status = "Name:\tnode\nVmPeak:\t 9999999 kB\nVmHWM:\t  524288 kB\nVmRSS:\t  409600 kB\nThreads:\t11\n";
    expect(parseProcStatus(status)).toEqual({ rssMb: 400, hwmMb: 512, threads: 11 });
    expect(parseProcStatus(null)).toEqual({ rssMb: null, hwmMb: null, threads: null });
    expect(parseProcStatus("Name:\tnode\n")).toEqual({ rssMb: null, hwmMb: null, threads: null });
  });

  it("reads the few limits that decide whether the process can run", () => {
    const text = [
      "Limit                     Soft Limit           Hard Limit           Units     ",
      "Max cpu time              unlimited            unlimited            seconds   ",
      "Max open files            1024                 524288               files     ",
      "Max processes             200                  200                  processes ",
      "Max address space         unlimited            unlimited            bytes     ",
    ].join("\n");
    expect(parseLimits(text)).toEqual({ "open files": "1024/524288", processes: "200/200", "address space": "unlimited/unlimited" });
    expect(parseLimits(null)).toEqual({});
  });

  it("reads the memory limit, use and kill count of the cgroup, from v2 or else v1, and none where there are neither", () => {
    const v2 = new Map([
      ["/sys/fs/cgroup/memory.max", "6442450944\n"],
      ["/sys/fs/cgroup/memory.current", "412876800\n"],
      ["/sys/fs/cgroup/memory.events", "low 0\nhigh 0\nmax 4\noom 2\noom_kill 1\n"],
    ]);
    expect(readCgroupMemory(file => v2.get(file) ?? null)).toEqual({ limitMb: 6144, usedMb: 394, oomKills: 1 });
    const v1 = new Map([
      ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "1073741824\n"],
      ["/sys/fs/cgroup/memory/memory.usage_in_bytes", "104857600\n"],
      ["/sys/fs/cgroup/memory/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 5\n"],
    ]);
    expect(readCgroupMemory(file => v1.get(file) ?? null)).toEqual({ limitMb: 1024, usedMb: 100, oomKills: 5 });
    expect(readCgroupMemory(() => null)).toBeNull();
    // "max" is no limit, and neither is the figure v1 shows for none.
    const none = new Map([
      ["/sys/fs/cgroup/memory.max", "max\n"],
      ["/sys/fs/cgroup/memory.current", "1048576\n"],
    ]);
    expect(readCgroupMemory(file => none.get(file) ?? null)).toEqual({ limitMb: null, usedMb: 1, oomKills: null });
    expect(readCgroupMemory(file => (file.endsWith("memory.limit_in_bytes") ? "9223372036854771712\n" : null))).toBeNull();
  });

  it("writes an error as one short line with no user or password from an address", () => {
    const error = new Error("connect failed to mysql://admin:hunter2@db.example:3306/app\nsecond line " + "x".repeat(400));
    const described = describeError(error);
    expect(described.name).toBe("Error");
    expect(described.message).not.toContain("hunter2");
    expect(described.message).not.toContain("admin");
    expect(described.message).toContain("//[redacted]@db.example");
    expect(described.message).not.toContain("\n");
    expect(described.message.length).toBeLessThanOrEqual(200);
    expect(describeError("plain text")).toEqual({ name: "string", message: "plain text" });
  });

  it("writes the values of the host's process-manager settings, LSAPI_* and two flags of lsnode, when each is short and plain", () => {
    const env = {
      LSAPI_PGRP_MAX_IDLE: "FOREVER",
      LSAPI_MAX_PROCESS_TIME: "3600",
      LSAPI_PPID_NO_CHECK: "1",
      LSNODE_GUARD_PPID: "1",
      LSNODE_CONSOLE_LOG: "0",
      LSAPI_AVOID_FORK: "",
      LSAPI_SLOW_REQ_MSECS: "1.5e3",
    };
    expect(hostSettings(env)).toEqual({
      LSAPI_AVOID_FORK: "",
      LSAPI_MAX_PROCESS_TIME: "3600",
      LSAPI_PGRP_MAX_IDLE: "FOREVER",
      LSAPI_PPID_NO_CHECK: "1",
      LSAPI_SLOW_REQ_MSECS: "1.5e3",
      LSNODE_CONSOLE_LOG: "0",
      LSNODE_GUARD_PPID: "1",
    });
    // In name order, whatever order the environment holds them.
    expect(Object.keys(hostSettings(env))).toEqual([...Object.keys(env)].sort());
  });

  it("writes only the length of a value that is not short and plain, so a path, a socket or a key is never written", () => {
    const settings = hostSettings({
      LSAPI_SOCKET: "/tmp/lsapi_nooscape_12345.sock",
      LSAPI_TOKEN: "abcdefghijklmnopqrstuvwxyz012345",
      LSAPI_PATH: "a/b",
      LSAPI_SPACED: "one two",
      LSAPI_TWELVE: "123456789012",
      LSAPI_THIRTEEN: "1234567890123",
    });
    expect(settings).toEqual({
      LSAPI_PATH: "(3 characters)",
      LSAPI_SOCKET: "(30 characters)",
      LSAPI_SPACED: "(7 characters)",
      LSAPI_THIRTEEN: "(13 characters)",
      LSAPI_TOKEN: "(32 characters)",
      LSAPI_TWELVE: "123456789012",
    });
    expect(JSON.stringify(settings)).not.toMatch(/tmp|abcdefghijkl|one two|nooscape/);
  });

  it("writes no value for any other variable, whatever its name looks like, so lsnode's paths and every other secret stay out", () => {
    const settings = hostSettings({
      LSNODE_ROOT: "/home/someone/domains/nooscape.si",
      LSNODE_SOCKET: "/tmp/lsnode.sock",
      LSNODE_STARTUP_FILE: "app.js",
      PASSENGER_APP_ENV: "production",
      DATABASE_URL: "mysql://u:p@h/db",
      lsapi_lowercase: "1",
      MY_LSAPI_X: "1",
      LSAPI: "1",
      LSNODE_GUARD_PPID_EXTRA: "1",
    });
    expect(settings).toEqual({});
  });
});

/** A world of its own for the behaviour: files in a map, a clock that is set, memory and delay that are set, and the lines written. */
function world() {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const errors: string[] = [];
  const state = { now: T0, rss: 400 * MB, lag: { p99: 3, max: 9 }, appendFails: false, memoryFails: false, alive: new Set<number>() };
  const started = T0;
  const proc: Record<string, string> = {
    "/proc/self/status": "VmHWM:\t 524288 kB\nVmRSS:\t 409600 kB\nThreads:\t9\n",
    "/proc/self/limits": "Max open files            1024                 524288               files     \nMax processes             200                  200                  processes \n",
    "/proc/7/comm": "lsnode\n",
    "/sys/fs/cgroup/memory.max": "6442450944\n",
    "/sys/fs/cgroup/memory.current": "412876800\n",
    "/sys/fs/cgroup/memory.events": "oom_kill 0\n",
  };
  const io: Io = {
    now: () => state.now,
    read: file => files.get(file) ?? proc[file] ?? null,
    append: (file, text) => {
      if (state.appendFails) throw new Error("EACCES: permission denied");
      files.set(file, (files.get(file) ?? "") + text);
    },
    write: (file, text) => void files.set(file, text),
    count: () => 14,
    alive: pid => state.alive.has(pid),
    lag: () => state.lag,
    memory: () => {
      if (state.memoryFails) throw new Error("memory unavailable");
      return { rss: state.rss, heapUsed: 120 * MB, external: 10 * MB };
    },
    load1: () => 0.456,
    log: line => void logs.push(line),
    error: line => void errors.push(line),
    facts: {
      id: "self0001",
      pid: 4242,
      ppid: () => 7,
      node: "v22.0.0",
      execArgv: ["--max-old-space-size=2048"],
      hints: ["PASSENGER_APP_ENV"],
      settings: { LSAPI_MAX_PROCESS_TIME: "3600", LSAPI_PGRP_MAX_IDLE: "FOREVER" },
      hostUptimeMinutes: 90,
      heapLimitMb: 4096,
      totalMemMb: 8192,
      upSeconds: () => (state.now - started) / 1000,
      tmp: "/tmp",
    },
  };
  const parsed = (lines: string[]) => lines.map(line => JSON.parse(line) as Record<string, unknown>);
  return { io, files, state, logs: () => parsed(logs), errors: () => parsed(errors), trail: () => parseTrail(files.get(`${path.join("/tmp", "nooscape-lifecycle.jsonl")}`) ?? "") };
}

describe("the lifecycle log, against a world of its own", () => {
  it("writes one line for this process at its start, with what the host says, and records the start", () => {
    const w = world();
    createLifecycleLog(w.io).start();
    const lines = w.logs();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "nooscape_lifecycle",
      kind: "start",
      inst: "self0001",
      pid: 4242,
      ppid: 7,
      parent: "lsnode",
      node: "v22.0.0",
      execArgv: ["--max-old-space-size=2048"],
      rssMb: 400,
      heapLimitMb: 4096,
      totalMemMb: 8192,
      cgroup: { limitMb: 6144, usedMb: 394, oomKills: 0 },
      limits: { "open files": "1024/524288", processes: "200/200" },
      hints: ["PASSENGER_APP_ENV"],
      hostSettings: { LSAPI_MAX_PROCESS_TIME: "3600", LSAPI_PGRP_MAX_IDLE: "FOREVER" },
      trail: { found: false, events: 0 },
    });
    expect(w.trail()).toEqual([expect.objectContaining({ ev: "start", inst: "self0001", pid: 4242, rssMb: 400, oomKills: 0 })]);
  });

  it("says first how each earlier process ended, from the trail the last ones left, then writes its own start", () => {
    const w = world();
    const file = path.join("/tmp", "nooscape-lifecycle.jsonl");
    const events = [start("a1", -300), beat("a1", -240), { ev: "signal", inst: "a1", at: at(-200), signal: "SIGTERM" } as TrailEvent, start("b2", -150), beat("b2", -90, { rssMb: 910, hwmMb: 950 })];
    w.files.set(file, `${events.map(event => JSON.stringify(event)).join("\n")}\n`);
    createLifecycleLog(w.io).start();
    const lines = w.logs();
    expect(lines.map(line => line.kind)).toEqual(["previous", "previous", "start"]);
    expect(lines[0]).toMatchObject({ kind: "previous", inst: "self0001", previous: "a1", ended: "signal", detail: "SIGTERM" });
    expect(lines[0]).not.toHaveProperty("id");
    expect(lines[1]).toMatchObject({ previous: "b2", ended: "unknown", detail: null, lastRssMb: 910, peakRssMb: 950, silentSeconds: 90 });
    expect(lines[2]).toMatchObject({ kind: "start", trail: { found: true, events: 5 } });
  });

  it("says how an earlier process's stop went on its previous line, and null for one that wrote none", () => {
    const w = world();
    const file = path.join("/tmp", "nooscape-lifecycle.jsonl");
    const stop = { ev: "shutdown", inst: "a1", at: at(-198), tookMs: 1550, ceilingHit: false, failed: ["api meter"] } as TrailEvent;
    const events = [start("a1", -300), { ev: "signal", inst: "a1", at: at(-200), signal: "SIGTERM" } as TrailEvent, stop, start("b2", -150), { ev: "signal", inst: "b2", at: at(-100), signal: "SIGTERM" } as TrailEvent];
    w.files.set(file, `${events.map(event => JSON.stringify(event)).join("\n")}\n`);
    createLifecycleLog(w.io).start();
    const [first, second] = w.logs();
    expect(first).toMatchObject({ previous: "a1", ended: "signal", detail: "SIGTERM", lastEventAt: at(-198), shutdown: { tookMs: 1550, ceilingHit: false, failed: ["api meter"] } });
    expect(second).toMatchObject({ previous: "b2", ended: "signal", shutdown: null });
  });

  it("says another process of the app that is running is running, and counts it in the start line, and does not call it lost", () => {
    const w = world();
    const file = path.join("/tmp", "nooscape-lifecycle.jsonl");
    w.files.set(file, `${JSON.stringify(start("a1", -40, { pid: 111 }))}\n`);
    w.state.alive.add(111);
    createLifecycleLog(w.io).start();
    const lines = w.logs();
    expect(lines.map(line => line.kind)).toEqual(["previous", "start"]);
    expect(lines[0]).toMatchObject({ previous: "a1", pid: 111, ended: "running", detail: null, silentSeconds: 40 });
    expect(lines[1]).toMatchObject({ othersRunning: 1 });
    // With nothing running beside it, the start line says none, and the same process is lost.
    const alone = world();
    alone.files.set(file, `${JSON.stringify(start("a1", -40, { pid: 111 }))}\n`);
    createLifecycleLog(alone.io).start();
    expect(alone.logs().map(line => line.ended ?? line.othersRunning)).toEqual(["unknown", 0]);
  });

  it("lists the other processes that are running in each health line, and none once they have gone", () => {
    const w = world();
    const file = path.join("/tmp", "nooscape-lifecycle.jsonl");
    w.files.set(file, `${JSON.stringify(start("a1", -40, { pid: 111 }))}\n`);
    w.state.alive.add(111);
    const log = createLifecycleLog(w.io);
    log.start();
    const run5 = () => {
      for (let index = 0; index < 5; index += 1) {
        w.state.now += 60_000;
        log.beat();
      }
    };
    run5();
    expect(w.logs().filter(line => line.kind === "health").at(-1)).toMatchObject({ others: [{ pid: 111, silentSeconds: 340 }] });
    w.state.alive.clear();
    run5();
    expect(w.logs().filter(line => line.kind === "health").at(-1)).toMatchObject({ others: [] });
  });

  it("cuts a trail that has grown past the limit before it adds to it", () => {
    const w = world();
    const file = path.join("/tmp", "nooscape-lifecycle.jsonl");
    const line = `${JSON.stringify(beat("a1", 1))}\n`;
    w.files.set(file, line.repeat(Math.ceil(250_000 / line.length)));
    createLifecycleLog(w.io).start();
    const text = w.files.get(file)!;
    expect(text.length).toBeLessThan(110_000);
    expect(parseTrail(text).at(-1)).toMatchObject({ ev: "start", inst: "self0001" });
  });

  it("beats every call into the trail, and writes a line to the runtime log at every fifth beat", () => {
    const w = world();
    const log = createLifecycleLog(w.io);
    log.start();
    for (let index = 1; index <= 5; index += 1) {
      w.state.now += 60_000;
      log.beat();
      expect(w.logs().filter(line => line.kind === "health")).toHaveLength(index === 5 ? 1 : 0);
    }
    expect(w.trail().filter(event => event.ev === "beat")).toHaveLength(5);
    const health = w.logs().find(line => line.kind === "health")!;
    expect(health).toMatchObject({ inst: "self0001", rssMb: 400, hwmMb: 512, heapMb: 120, externalMb: 10, threads: 9, fds: 14, load1: 0.46, ppid: 7, lagP99Ms: 3, lagMaxMs: 9, oomKills: 0, cgroupUsedMb: 394, upSeconds: 300 });
    expect(health).not.toHaveProperty("note");
  });

  it("writes a line at once when memory jumps by 300 MB between beats, or the event loop stalls for 2 seconds", () => {
    const w = world();
    const log = createLifecycleLog(w.io);
    log.start();
    log.beat();
    expect(w.logs().filter(line => line.kind === "health")).toHaveLength(0);
    w.state.rss += 299 * MB;
    log.beat();
    expect(w.logs().filter(line => line.kind === "health")).toHaveLength(0);
    w.state.rss += 300 * MB;
    log.beat();
    expect(w.logs().filter(line => line.kind === "health")).toEqual([expect.objectContaining({ note: "memory jumped", rssMb: 999 })]);
    w.state.lag = { p99: 50, max: 2400 };
    log.beat();
    expect(w.logs().filter(line => line.kind === "health").at(-1)).toMatchObject({ note: "event loop stalled", lagMaxMs: 2400 });
  });

  it("writes a signal, a crash and an exit, each to the runtime log and the trail", () => {
    const w = world();
    const log = createLifecycleLog(w.io);
    w.state.now = T0 + 125_000;
    log.signal("SIGTERM");
    log.exit(0);
    log.crash(new Error("connect failed to mysql://admin:hunter2@db.example/app"), "uncaughtException");
    expect(w.logs().find(line => line.kind === "signal")).toMatchObject({ signal: "SIGTERM", upSeconds: 125, rssMb: 400, inst: "self0001" });
    expect(w.logs().find(line => line.kind === "exit")).toMatchObject({ code: 0, upSeconds: 125 });
    // A crash is an error, so it goes where the host puts errors, and the address has lost its user and password.
    const [crash] = w.errors();
    expect(crash).toMatchObject({ kind: "crash", origin: "uncaughtException", name: "Error", inst: "self0001" });
    expect(JSON.stringify(crash)).not.toContain("hunter2");
    expect(w.trail().map(event => event.ev)).toEqual(["signal", "exit", "crash"]);
    expect(w.trail()[2]!.message).toContain("//[redacted]@db.example");
  });

  it("records how a stop went after its signal, and writes nothing for an answer that is not one, or when the trail cannot be written", () => {
    const w = world();
    const log = createLifecycleLog(w.io);
    log.signal("SIGTERM");
    log.shutdown({ tookMs: 1550, ceilingHit: false, tasks: [{ name: "http", ok: true, ms: 1500 }, { name: "api meter", ok: false, ms: 30, error: "boom" }] });
    log.shutdown("not an answer");
    log.shutdown(undefined);
    expect(w.trail().map(event => event.ev)).toEqual(["signal", "shutdown"]);
    expect(w.trail()[1]).toMatchObject({ tookMs: 1550, ceilingHit: false, failed: ["api meter"] });
    // The runtime log is not told again: the stop's own line says it, in the log of the deployment the process ran in.
    expect(w.logs().filter(line => line.kind === "shutdown")).toHaveLength(0);
    w.state.appendFails = true;
    expect(() => log.shutdown({ tookMs: 1, ceilingHit: false, tasks: [] })).not.toThrow();
  });

  it("says once that the trail cannot be written, and goes on writing to the runtime log", () => {
    const w = world();
    w.state.appendFails = true;
    const log = createLifecycleLog(w.io);
    log.start();
    log.beat();
    log.signal("SIGTERM");
    expect(w.logs().filter(line => line.kind === "trail_error")).toHaveLength(1);
    expect(w.logs().find(line => line.kind === "trail_error")).toMatchObject({ message: "EACCES: permission denied" });
    expect(w.logs().filter(line => line.kind === "signal")).toHaveLength(1);
    expect(w.trail()).toEqual([]);
  });

  it("never throws, whatever the world does", () => {
    const w = world();
    w.state.memoryFails = true;
    const log = createLifecycleLog(w.io);
    expect(() => {
      log.start();
      log.beat();
      log.signal("SIGTERM");
      log.crash(undefined, "uncaughtException");
      log.exit(null);
    }).not.toThrow();
    const broken = createLifecycleLog({ ...w.io, read: () => { throw new Error("read failed"); }, log: () => { throw new Error("console closed"); } });
    expect(() => {
      broken.start();
      broken.beat();
      broken.exit(1);
    }).not.toThrow();
  });
});

describe("starting it on a process", () => {
  it("is called only in production, once, before the server is built", () => {
    const index = readFileSync(path.join(appRoot, "server", "_core", "index.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(index).toContain('import { startLifecycleLog } from "../lifecycleLog";');
    expect(index).toContain('if (process.env.NODE_ENV === "production") startLifecycleLog({ beforeEnd: () => runShutdown() });');
    expect(index.indexOf("startLifecycleLog({")).toBeLessThan(index.indexOf("async function startServer"));
    expect(index.match(/startLifecycleLog\(/g)).toHaveLength(1);
  });

  it("is told what a stop waits for once the server exists: the HTTP server and the meter", () => {
    const index = readFileSync(path.join(appRoot, "server", "_core", "index.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(index).toContain('import { drainHttpServer, onShutdown, runShutdown } from "../gracefulShutdown";');
    expect(index).toContain('import { apiMeter } from "../apiKeys";');
    expect(index).toContain('onShutdown("http", drainHttpServer(server));');
    expect(index).toContain('onShutdown("api meter", () => apiMeter.flush());');
    expect(index.indexOf('onShutdown("http"')).toBeGreaterThan(index.indexOf("const server = createServer(app);"));
    expect(index.match(/onShutdown\(/g)).toHaveLength(2);
  });

  it("adds its handlers to the process and takes every one away again when it is stopped", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nooscape-lifecycle-"));
    const events = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR2", "uncaughtExceptionMonitor", "exit"] as const;
    const before = events.map(name => process.listenerCount(name));
    const original = console.log;
    const lines: string[] = [];
    console.log = (line: unknown) => void lines.push(String(line));
    let stop: () => void;
    try {
      stop = startLifecycleLog({ dir, beatMs: 60_000 });
    } finally {
      console.log = original;
    }
    try {
      expect(events.map(name => process.listenerCount(name))).toEqual(before.map(count => count + 1));
      expect(lines.map(line => JSON.parse(line).kind)).toContain("start");
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(events.map(name => process.listenerCount(name))).toEqual(before);
  });
});

/**
 * Real processes. The module is bundled with esbuild into a folder of its own and run by a small script in a child, so that a signal,
 * a kill, a crash and an exit are the real ones. Windows has no signals to send, so these do not run there.
 */
describe.skipIf(process.platform === "win32")("a real process", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "nooscape-lifecycle-real-"));
    buildSync({ entryPoints: [path.join(appRoot, "server", "lifecycleLog.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(dir, "lifecycle.mjs"), logLevel: "silent" });
    writeFileSync(
      path.join(dir, "child.mjs"),
      `import { startLifecycleLog } from "./lifecycle.mjs";
const drainMs = Number(process.env.DRAIN_MS || 0);
startLifecycleLog({ dir: process.env.TRAIL_DIR, beatMs: 100, ...(drainMs ? { beforeEnd: async () => { await new Promise(resolve => setTimeout(resolve, drainMs)); console.log("DRAINED"); return { tookMs: drainMs, ceilingHit: false, tasks: [{ name: "drain", ok: true, ms: drainMs }] }; }, beforeEndMs: Number(process.env.GUARD_MS || 20000) } : {}) });
const mode = process.env.MODE;
if (mode === "serve") { setInterval(() => {}, 1000); console.log("READY"); }
if (mode === "crash") { setInterval(() => {}, 1000); console.log("READY"); setTimeout(() => { throw new Error("boom at mysql://admin:hunter2@db.example/app"); }, 350); }
if (mode === "exit") { setInterval(() => {}, 1000); console.log("READY"); setTimeout(() => process.exit(3), 350); }
`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  type Outcome = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; lines: Array<Record<string, unknown>> };

  /** Starts the child in `mode` with a trail in `trailDir`: `ready` is when it has printed READY, and `done` is when it has ended. */
  function launch(mode: string, trailDir: string, env: Record<string, string> = {}) {
    const child = spawn(process.execPath, [path.join(dir, "child.mjs")], { env: { ...process.env, ...env, TRAIL_DIR: trailDir, MODE: mode }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let up: () => void = () => undefined;
    const ready = new Promise<void>(resolve => (up = resolve));
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.includes("READY")) up();
    });
    child.stderr.on("data", chunk => (stderr += chunk));
    const done = new Promise<Outcome>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        const lines = `${stdout}\n${stderr}`.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
        resolve({ code, signal, stdout, stderr, lines });
      });
    });
    return { child, ready, done };
  }

  /** Runs the child in `mode` with a trail in `trailDir`, waits for it to be up and have beaten a few times, then does `then` to it. */
  function run(mode: string, trailDir: string, then?: (child: ReturnType<typeof spawn>) => void, env: Record<string, string> = {}): Promise<Outcome> {
    const { child, ready, done } = launch(mode, trailDir, env);
    if (then) void ready.then(() => setTimeout(() => then(child), 350));
    return done;
  }
  const lifecycle = (outcome: Outcome, kind: string) => outcome.lines.filter(line => line.event === "nooscape_lifecycle" && line.kind === kind);
  const fresh = () => mkdtempSync(path.join(dir, "trail-"));

  it("is stopped by SIGTERM as it would have been, by the signal and with no exit code, and says so, and the next process reads it", async () => {
    const trailDir = fresh();
    const stopped = await run("serve", trailDir, child => child.kill("SIGTERM"));
    expect(stopped.signal).toBe("SIGTERM");
    expect(stopped.code).toBeNull();
    expect(lifecycle(stopped, "start")).toHaveLength(1);
    expect(lifecycle(stopped, "signal")).toEqual([expect.objectContaining({ signal: "SIGTERM" })]);
    const next = await run("serve", trailDir, child => child.kill("SIGINT"));
    expect(next.signal).toBe("SIGINT");
    expect(lifecycle(next, "previous")).toEqual([expect.objectContaining({ ended: "signal", detail: "SIGTERM" })]);
    expect(lifecycle(next, "start")[0]).toMatchObject({ trail: { found: true } });
  });

  it("tells a process that is running beside it from one that was lost: the first of two that run together is read as running, and as ended by the signal once it has gone", async () => {
    const trailDir = fresh();
    const first = launch("serve", trailDir);
    await first.ready;
    // The second starts while the first is alive, as the host does at a deploy, and ends by itself.
    await new Promise(resolve => setTimeout(resolve, 350));
    const second = await run("exit", trailDir);
    expect(lifecycle(second, "previous")).toEqual([expect.objectContaining({ ended: "running", detail: null, pid: first.child.pid })]);
    expect(lifecycle(second, "start")[0]).toMatchObject({ othersRunning: 1 });
    first.child.kill("SIGTERM");
    expect((await first.done).signal).toBe("SIGTERM");
    // With the first gone it is read from its own record, and nothing is running beside the third.
    const third = await run("exit", trailDir);
    expect(lifecycle(third, "previous").map(line => line.ended)).toEqual(["signal", "exit"]);
    expect(lifecycle(third, "start")[0]).toMatchObject({ othersRunning: 0 });
  });

  it("waits for what a stop must finish before it ends by SIGTERM or SIGINT, and is still ended by that signal", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const stopped = await run("serve", fresh(), child => child.kill(signal), { DRAIN_MS: "400" });
      expect(stopped.stdout, signal).toContain("DRAINED");
      expect(stopped.signal, signal).toBe(signal);
      expect(stopped.code, signal).toBeNull();
      expect(lifecycle(stopped, "signal"), signal).toEqual([expect.objectContaining({ signal })]);
    }
  });

  it("writes how the wait went after the signal, and the next process says it on the previous line", async () => {
    const trailDir = fresh();
    const stopped = await run("serve", trailDir, child => child.kill("SIGTERM"), { DRAIN_MS: "300" });
    expect(stopped.signal).toBe("SIGTERM");
    const next = await run("serve", trailDir, child => child.kill("SIGINT"));
    expect(lifecycle(next, "previous")).toEqual([expect.objectContaining({ ended: "signal", detail: "SIGTERM", shutdown: { tookMs: 300, ceilingHit: false, failed: [] } })]);
  });

  it("writes no answer for a wait given up before it ended, for a second signal, or for a signal that was never a stop", async () => {
    const trailDir = fresh();
    await run("serve", trailDir, child => child.kill("SIGTERM"), { DRAIN_MS: "30000", GUARD_MS: "400" });
    await run("serve", trailDir, child => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGTERM"), 150);
    }, { DRAIN_MS: "30000" });
    await run("serve", trailDir, child => child.kill("SIGHUP"), { DRAIN_MS: "30000" });
    const next = await run("serve", trailDir, child => child.kill("SIGINT"));
    const previous = lifecycle(next, "previous");
    expect(previous.map(line => line.ended)).toEqual(["signal", "signal", "signal"]);
    expect(previous.map(line => line.shutdown)).toEqual([null, null, null]);
  });

  it("ends at once on a second signal, and gives up on a wait that does not end", async () => {
    let sentAt = 0;
    const second = await run("serve", fresh(), child => {
      sentAt = Date.now();
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGTERM"), 150);
    }, { DRAIN_MS: "30000" });
    const secondTook = Date.now() - sentAt;
    expect(second.signal).toBe("SIGTERM");
    expect(second.stdout).not.toContain("DRAINED");
    // It waited until the second signal, and no longer.
    expect(secondTook).toBeGreaterThanOrEqual(140);
    expect(secondTook).toBeLessThan(2500);
    const stuck = await run("serve", fresh(), child => {
      sentAt = Date.now();
      child.kill("SIGTERM");
    }, { DRAIN_MS: "30000", GUARD_MS: "400" });
    const stuckTook = Date.now() - sentAt;
    expect(stuck.signal).toBe("SIGTERM");
    expect(stuck.stdout).not.toContain("DRAINED");
    expect(stuckTook).toBeGreaterThanOrEqual(380);
    expect(stuckTook).toBeLessThan(2500);
  });

  it("does not wait for the signals that were never a stop", async () => {
    let sentAt = 0;
    const hangup = await run("serve", fresh(), child => {
      sentAt = Date.now();
      child.kill("SIGHUP");
    }, { DRAIN_MS: "30000" });
    expect(hangup.signal).toBe("SIGHUP");
    expect(hangup.stdout).not.toContain("DRAINED");
    expect(Date.now() - sentAt).toBeLessThan(1500);
  });

  it("is killed by SIGKILL with nothing written, and the next process says it ended unknown, with its last beat", async () => {
    const trailDir = fresh();
    const killed = await run("serve", trailDir, child => child.kill("SIGKILL"));
    expect(killed.signal).toBe("SIGKILL");
    expect(lifecycle(killed, "signal")).toEqual([]);
    expect(lifecycle(killed, "exit")).toEqual([]);
    const next = await run("exit", trailDir);
    const [previous] = lifecycle(next, "previous");
    expect(previous).toMatchObject({ ended: "unknown", detail: null });
    expect(typeof previous!.lastRssMb).toBe("number");
    expect(previous!.ranSeconds as number).toBeGreaterThanOrEqual(0);
  });

  it("crashes as it would have, exit code 1 and the stack on stderr, and writes the crash with no password in it", async () => {
    const trailDir = fresh();
    const crashed = await run("crash", trailDir);
    expect(crashed.code).toBe(1);
    expect(crashed.stderr).toContain("Error: boom at");
    const [crash] = lifecycle(crashed, "crash");
    expect(crash).toMatchObject({ origin: "uncaughtException", name: "Error" });
    expect(JSON.stringify(crash)).not.toContain("hunter2");
    const next = await run("exit", trailDir);
    expect(lifecycle(next, "previous")[0]).toMatchObject({ ended: "crash" });
    expect(JSON.stringify(lifecycle(next, "previous"))).not.toContain("hunter2");
  });

  it("exits with the code it was given, and writes the exit", async () => {
    const trailDir = fresh();
    const exited = await run("exit", trailDir);
    expect(exited.code).toBe(3);
    expect(lifecycle(exited, "exit")).toEqual([expect.objectContaining({ code: 3 })]);
    const next = await run("exit", trailDir);
    expect(lifecycle(next, "previous")[0]).toMatchObject({ ended: "exit", detail: 3 });
  });

  it("does not keep a process alive that has nothing else to do, and ends it cleanly", async () => {
    const idle = await run("idle", fresh());
    expect(idle.code).toBe(0);
    expect(idle.signal).toBeNull();
    expect(lifecycle(idle, "exit")).toEqual([expect.objectContaining({ code: 0 })]);
  });

  it("writes the names of the host's environment variables and never their values", async () => {
    const outcome = await run("idle", fresh(), undefined, { PASSENGER_APP_ENV: "hunter2", LSNODE_THING: "also-secret", UNRELATED_SECRET: "nope" });
    const [started] = lifecycle(outcome, "start");
    expect(started!.hints).toEqual(expect.arrayContaining(["LSNODE_THING", "PASSENGER_APP_ENV"]));
    expect(started!.hints).not.toContain("UNRELATED_SECRET");
    expect(outcome.stdout + outcome.stderr).not.toMatch(/hunter2|also-secret|nope/);
  });

  it("writes the values of the host's process-manager settings when they are short and plain, and never a path or a socket", async () => {
    const outcome = await run("idle", fresh(), undefined, {
      LSAPI_MAX_PROCESS_TIME: "3600",
      LSAPI_PGRP_MAX_IDLE: "FOREVER",
      LSNODE_GUARD_PPID: "1",
      LSNODE_CONSOLE_LOG: "0",
      LSAPI_SOCKET_PATH: "/tmp/some-long-socket-path.sock",
      LSNODE_ROOT: "/home/someone/secret-path",
    });
    const [started] = lifecycle(outcome, "start");
    expect(started!.hostSettings).toEqual({
      LSAPI_MAX_PROCESS_TIME: "3600",
      LSAPI_PGRP_MAX_IDLE: "FOREVER",
      LSAPI_SOCKET_PATH: "(31 characters)",
      LSNODE_CONSOLE_LOG: "0",
      LSNODE_GUARD_PPID: "1",
    });
    // The path variable of lsnode is named in `hints`, and its value is nowhere.
    expect(started!.hints).toContain("LSNODE_ROOT");
    expect(outcome.stdout + outcome.stderr).not.toMatch(/secret-path|some-long-socket/);
  });

  it("reads this machine's /proc, so a figure the log writes is a number and not a guess", async () => {
    const outcome = await run("serve", fresh(), child => child.kill("SIGTERM"));
    const [started] = lifecycle(outcome, "start");
    expect(typeof started!.rssMb).toBe("number");
    expect(started!.rssMb as number).toBeGreaterThan(10);
    expect(typeof started!.parent === "string" || started!.parent === null).toBe(true);
    expect(typeof started!.heapLimitMb).toBe("number");
    expect(typeof started!.totalMemMb).toBe("number");
  });
});
