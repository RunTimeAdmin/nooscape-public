import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import v8 from "node:v8";

/**
 * What happens to the process, written where the host's runtime log can be read (docs/lifecycle-logging-2026-11-01.md). On 1 November 2026
 * the app was restarted five times with no deploy, and the log held nothing before any of them: the app had no handler for a signal or a
 * crash, and a process that is killed cannot write its own last line. This writes four things:
 *
 *  - when the process is stopped by a signal or ends by a crash or an exit, one line saying which, and the process then ends exactly as it
 *    would have without it (a signal is raised again with its handler removed, a crash is only observed);
 *  - every few minutes, one line with the memory, the event loop's delay and the parent process, and at once when memory jumps or the loop
 *    stalls, so the last lines before a stop show whether the process was under strain;
 *  - a small trail file of the same events, beating every minute, so that the NEXT process can say how the last ones ended, including the
 *    one that was killed without a line: it was stopped by nothing it could see, and its last beat says when and how big it was;
 *  - at every start, one line for each of the last few earlier processes, then one for this one with what the host says about its limits.
 *
 * Nothing here writes a secret: the parent is named by its process name only, the host is described by the NAMES of a few environment
 * variables, the VALUES of the few that set how long the app may run or sit idle are written only when they are short and plain (a number,
 * a flag, a word), and an error's message is cut short and has any user and password in an address removed.
 */
const TRAIL_FILE = "nooscape-lifecycle.jsonl";
/** A trail that has grown past this many characters is cut to its last TRAIL_KEEP, from a whole line, when a process starts. */
const TRAIL_LIMIT = 200_000;
const TRAIL_KEEP = 100_000;
const BEAT_MS = 60_000;
/** The beats between two lines in the runtime log: every fifth minute. */
const HEALTH_EVERY = 5;
/** A jump in memory between two beats, or a stall of the event loop, that is written at once and not at the next scheduled line. */
const SPIKE_RSS_MB = 300;
const SPIKE_LAG_MS = 2_000;
const PREVIOUS_SHOWN = 5;
/** How many of the earlier processes in the trail are looked at to find the ones that are still running. */
const OTHERS_LOOKED_AT = 50;
/** Signals whose default is to end the process. Each is written and raised again. SIGUSR1 is left alone: Node uses it to start its inspector. */
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR2"] as const;
/** The signals that mean stop: the process waits, up to a limit, for what the app has to finish (`beforeEnd`). The others end it at once. */
const STOP_SIGNALS = new Set<string>(["SIGTERM", "SIGINT"]);
/** The longest the process waits for `beforeEnd`: more than the 15 seconds the shutdown allows itself, so its own line is written first. */
const BEFORE_END_MS = 20_000;
/** The names that say what runs the process, in the environment. Only the names are ever written. */
const HOST_HINT = /^(PASSENGER|LSAPI|LSNODE|LS_|LVE|CAGEFS|HOSTINGER|HBUILD|PM2|SUPERVISOR|S6_|KUBERNETES|DOCKER|CONTAINER)|^(INVOCATION_ID|JOURNAL_STREAM)$/i;
/**
 * The settings of the host's process manager that bound how long the app may run or sit idle: LiteSpeed's LSAPI_* variables, and two flags of
 * its Node runner. On Hostinger the app runs under lsnode, whose environment names are in the start line's `hints`. These are written with
 * their values, where the rest of the host's variables are only named.
 */
const HOST_SETTING = /^(LSAPI_[A-Z0-9_]+|LSNODE_GUARD_PPID|LSNODE_CONSOLE_LOG)$/;
/** A value is written only when it is this short and plain: a number, a flag or a word such as FOREVER. A path, a socket or a key is longer or has other characters, and only its length is written. */
const SETTING_VALUE = /^[A-Za-z0-9._-]{0,12}$/;
const LIMIT_NAMES = ["Max open files", "Max processes", "Max address space", "Max resident set"] as const;

export type TrailEvent = {
  ev: "start" | "beat" | "signal" | "crash" | "exit" | "shutdown";
  inst: string;
  at: string;
  pid?: number;
  rssMb?: number | null;
  hwmMb?: number | null;
  oomKills?: number | null;
  signal?: string;
  origin?: string;
  message?: string;
  code?: number | null;
  /** On a "shutdown" event, written after the signal: how the wait before the end went (see readShutdown). */
  tookMs?: number;
  ceilingHit?: boolean;
  failed?: string[];
};

/** How an earlier process ended, as its successor reads it from the trail. */
export type PreviousInstance = {
  id: string;
  pid: number | null;
  startedAt: string | null;
  /**
   * "running" is a process with no end record whose pid is still there: another process of the app beside this one (the host can run
   * more than one at a time), or one that has stopped writing. "unknown" is a process with no end record and no pid: it was killed, or the
   * host lost it, and its last beat is all there is.
   */
  ended: "signal" | "crash" | "exit" | "running" | "unknown";
  detail: string | number | null;
  lastEventAt: string;
  ranSeconds: number | null;
  /** From the last thing it wrote to the start of the next process: how long the app was without a process, at least. For a running process, how long since it last wrote. */
  silentSeconds: number | null;
  lastRssMb: number | null;
  peakRssMb: number | null;
  /** The host's own count of memory kills rose between its last beat and the next start. Null where the host shows no count. */
  oomKillsRose: boolean | null;
  /**
   * How its stop went, for a process that waited for something between a stop signal and its end (a deploy's SIGTERM): the answer of
   * `beforeEnd`. The process's own `nooscape_shutdown` line goes to the runtime log of the deployment it ran in, which the deploy that
   * stopped it replaces, so this is where a stop is read. Null where it wrote none: it was killed, it crashed, the signal was not a
   * stop, the wait was given up before it answered, or the process ran code from before this was written.
   */
  shutdown: { tookMs: number | null; ceilingHit: boolean; failed: string[] } | null;
};

const EVENTS = new Set(["start", "beat", "signal", "crash", "exit", "shutdown"]);

/** The events of a trail file, oldest first. A line that is not an event, or that a stop cut short in the middle of a write, is skipped. */
export function parseTrail(text: string): TrailEvent[] {
  const events: TrailEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Partial<TrailEvent>;
      if (typeof event.ev === "string" && EVENTS.has(event.ev) && typeof event.inst === "string" && typeof event.at === "string" && Number.isFinite(Date.parse(event.at))) {
        events.push(event as TrailEvent);
      }
    } catch {
      // A line cut short.
    }
  }
  return events;
}

/**
 * What a stop's wait answered, read from the value `beforeEnd` ended with: how long it took, whether the ceiling ended it, and the
 * names (only the names) of the tasks that did not finish well. Null for a value of another shape, so a `beforeEnd` that answers
 * nothing writes nothing.
 */
export function readShutdown(result: unknown): { tookMs: number; ceilingHit: boolean; failed: string[] } | null {
  if (typeof result !== "object" || result === null) return null;
  const { tookMs, ceilingHit, tasks } = result as { tookMs?: unknown; ceilingHit?: unknown; tasks?: unknown };
  if (typeof tookMs !== "number" || !Number.isFinite(tookMs) || typeof ceilingHit !== "boolean" || !Array.isArray(tasks)) return null;
  const failed: string[] = [];
  for (const task of tasks) {
    const { name, ok } = (typeof task === "object" && task !== null ? task : {}) as { name?: unknown; ok?: unknown };
    if (ok === false && typeof name === "string" && failed.length < 10) failed.push(name.slice(0, 40));
  }
  return { tookMs: Math.round(tookMs), ceilingHit, failed };
}

/** A trail longer than `limit` characters cut to its last `keep`, from the start of a whole line. */
export function trimTrail(text: string, limit: number, keep: number): string {
  if (text.length <= limit) return text;
  const tail = text.slice(text.length - keep);
  const newline = tail.indexOf("\n");
  return newline === -1 ? "" : tail.slice(newline + 1);
}

/**
 * How each of the last few earlier processes ended, oldest first. `self` is this process's id and is left out, `nowMs` is when it
 * started, and `oomKillsNow` is the host's count of memory kills now, read by this process. A process is the events that carry its id.
 * `alive` says whether a pid is still a process: one with no end record is `running` if so, and `unknown` if not. A process that is
 * started beside a running one (a deploy starts the app twice) has no end record either, so without this it would be called lost.
 */
export function summarizeTrail(
  events: readonly TrailEvent[],
  self: string,
  nowMs: number,
  oomKillsNow: number | null,
  limit = PREVIOUS_SHOWN,
  alive: (pid: number) => boolean = () => false,
): PreviousInstance[] {
  const order: string[] = [];
  const byId = new Map<string, TrailEvent[]>();
  for (const event of events) {
    if (event.inst === self) continue;
    let list = byId.get(event.inst);
    if (!list) {
      list = [];
      byId.set(event.inst, list);
      order.push(event.inst);
    }
    list.push(event);
  }
  const ms = (event: TrailEvent) => Date.parse(event.at);
  const startOf = (id: string) => byId.get(id)?.find(event => event.ev === "start") ?? null;
  const summaries = order.map((id, index): PreviousInstance => {
    const list = byId.get(id)!;
    const start = startOf(id);
    const end = list.find(event => event.ev === "signal" || event.ev === "crash" || event.ev === "exit") ?? null;
    const last = list[list.length - 1]!;
    const nextStart = index + 1 < order.length ? startOf(order[index + 1]!) : null;
    const nextMs = nextStart ? ms(nextStart) : nowMs;
    const sizes = list.flatMap(event => [event.hwmMb, event.rssMb]).filter((value): value is number => typeof value === "number");
    const rss = [...list].reverse().find(event => typeof event.rssMb === "number")?.rssMb ?? null;
    const lastKills = [...list].reverse().find(event => typeof event.oomKills === "number")?.oomKills ?? null;
    const nextKills = nextStart ? nextStart.oomKills : oomKillsNow;
    const pid = start?.pid ?? null;
    const stop = list.find(event => event.ev === "shutdown") ?? null;
    const ended: PreviousInstance["ended"] = end ? (end.ev as "signal" | "crash" | "exit") : pid !== null && alive(pid) ? "running" : "unknown";
    return {
      id,
      pid,
      startedAt: start?.at ?? null,
      ended,
      detail: end ? (end.ev === "signal" ? end.signal ?? null : end.ev === "crash" ? `${end.origin ?? ""}: ${end.message ?? ""}`.trim() : end.code ?? null) : null,
      lastEventAt: last.at,
      ranSeconds: start ? Math.max(0, Math.round((ms(last) - ms(start)) / 1000)) : null,
      silentSeconds: Math.max(0, Math.round(((ended === "running" ? nowMs : nextMs) - ms(last)) / 1000)),
      lastRssMb: typeof rss === "number" ? rss : null,
      peakRssMb: sizes.length > 0 ? Math.max(...sizes) : null,
      oomKillsRose: typeof lastKills === "number" && typeof nextKills === "number" ? nextKills > lastKills : null,
      shutdown: stop ? { tookMs: stop.tookMs ?? null, ceilingHit: stop.ceilingHit === true, failed: stop.failed ?? [] } : null,
    };
  });
  return summaries.slice(-limit);
}

/** VmRSS, VmHWM (the process's peak) and Threads, from the text of /proc/self/status. */
export function parseProcStatus(text: string | null): { rssMb: number | null; hwmMb: number | null; threads: number | null } {
  const kb = (key: string) => {
    const match = text?.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return match ? Math.round(Number(match[1]) / 1024) : null;
  };
  const threads = text?.match(/^Threads:\s+(\d+)/m);
  return { rssMb: kb("VmRSS"), hwmMb: kb("VmHWM"), threads: threads ? Number(threads[1]) : null };
}

/** The soft and hard limits the host sets on the process, from the text of /proc/self/limits, for the few that decide whether it can run. */
export function parseLimits(text: string | null): Record<string, string> {
  const limits: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    for (const name of LIMIT_NAMES) {
      if (!line.startsWith(name)) continue;
      const [soft, hard] = line.slice(name.length).trim().split(/\s+/);
      limits[name.replace("Max ", "")] = `${soft}/${hard}`;
    }
  }
  return limits;
}

export type CgroupMemory = { limitMb: number | null; usedMb: number | null; oomKills: number | null };

/** The memory limit, use and kill count of the process's cgroup, from the cgroup v2 files or else v1's. Null where the host shows neither. A limit of "max", or of more than a terabyte, is none. */
export function readCgroupMemory(read: (file: string) => string | null): CgroupMemory | null {
  const megabytes = (text: string | null) => {
    const bytes = Number(text?.trim());
    return Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 40 ? Math.round(bytes / (1024 * 1024)) : null;
  };
  const kills = (text: string | null) => {
    const match = text?.match(/^oom_kill\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  };
  const v2: CgroupMemory = { limitMb: megabytes(read("/sys/fs/cgroup/memory.max")), usedMb: megabytes(read("/sys/fs/cgroup/memory.current")), oomKills: kills(read("/sys/fs/cgroup/memory.events")) };
  const v1: CgroupMemory = {
    limitMb: megabytes(read("/sys/fs/cgroup/memory/memory.limit_in_bytes")),
    usedMb: megabytes(read("/sys/fs/cgroup/memory/memory.usage_in_bytes")),
    oomKills: kills(read("/sys/fs/cgroup/memory/memory.oom_control")),
  };
  const any = (memory: CgroupMemory) => memory.limitMb !== null || memory.usedMb !== null || memory.oomKills !== null;
  return any(v2) ? v2 : any(v1) ? v1 : null;
}

/** An error's name and message for the log: cut short, on one line, and with any user and password in an address removed. */
export function describeError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  return { name, message: raw.replace(/\/\/[^\s/@]+@/g, "//[redacted]@").replace(/[\r\n]+/g, " ").slice(0, 200) };
}

/** The values of the host's process-manager settings in the environment, in name order. A value that is not short and plain is written as its length, so a path, a socket or a key is never written. */
export function hostSettings(env: NodeJS.ProcessEnv): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    if (!HOST_SETTING.test(name)) continue;
    const value = env[name] ?? "";
    settings[name] = SETTING_VALUE.test(value) ? value : `(${value.length} characters)`;
  }
  return settings;
}

export type Sample = {
  rssMb: number;
  hwmMb: number | null;
  heapMb: number;
  externalMb: number;
  threads: number | null;
  fds: number | null;
  load1: number;
  ppid: number;
  lagP99Ms: number;
  lagMaxMs: number;
  oomKills: number | null;
  cgroupUsedMb: number | null;
  upSeconds: number;
};

/** What the lifecycle log reads from the world, so that a test can give it a world of its own. */
export type Io = {
  now: () => number;
  /** A file's text, or null when it cannot be read. */
  read: (file: string) => string | null;
  /** Both throw when the file cannot be written. */
  append: (file: string, text: string) => void;
  write: (file: string, text: string) => void;
  count: (dir: string) => number | null;
  /** Whether a pid is still a process, so that one that has no end record in the trail but is running is not taken for one that was lost. */
  alive: (pid: number) => boolean;
  /** The event loop's delay in milliseconds since the last call: the 99th percentile and the longest. */
  lag: () => { p99: number; max: number };
  memory: () => { rss: number; heapUsed: number; external: number };
  load1: () => number;
  log: (line: string) => void;
  error: (line: string) => void;
  facts: {
    id: string;
    pid: number;
    ppid: () => number;
    node: string;
    execArgv: readonly string[];
    hints: readonly string[];
    settings: Readonly<Record<string, string>>;
    hostUptimeMinutes: number;
    heapLimitMb: number;
    totalMemMb: number;
    upSeconds: () => number;
    tmp: string;
  };
};

export type LifecycleOptions = {
  /** Where the trail file lives. The operating system's temporary directory when not given. */
  dir?: string;
  beatMs?: number;
  healthEvery?: number;
  /**
   * Run when SIGTERM or SIGINT stops the process, and awaited before the signal is raised again, so the process still ends by that
   * signal. A second signal while it runs ends the process at once, and so does `beforeEndMs`. Another signal never waits. When it
   * ends with a shutdown result (see readShutdown), the trail records it, and the next process shows it on this one's `previous` line.
   */
  beforeEnd?: (signal: string) => unknown;
  beforeEndMs?: number;
};

export type Lifecycle = {
  start: () => void;
  beat: () => void;
  signal: (name: string) => void;
  crash: (error: unknown, origin: string) => void;
  exit: (code: number | null) => void;
  /** Records how the wait before the end went; a value that is not a shutdown result writes nothing. */
  shutdown: (result: unknown) => void;
};

/** The behaviour, apart from the process it watches: each call writes what it saw and none of them throws. */
export function createLifecycleLog(io: Io, options: LifecycleOptions = {}): Lifecycle {
  const id = io.facts.id;
  const file = path.join(options.dir ?? io.facts.tmp, TRAIL_FILE);
  const healthEvery = options.healthEvery ?? HEALTH_EVERY;
  let trailWorks = true;
  let beats = 0;
  let lastRss: number | null = null;

  const say = (kind: string, fields: Record<string, unknown>) => io.log(JSON.stringify({ event: "nooscape_lifecycle", kind, inst: id, ...fields }));

  const record = (event: Omit<TrailEvent, "inst" | "at">) => {
    if (!trailWorks) return;
    try {
      io.append(file, `${JSON.stringify({ ...event, inst: id, at: new Date(io.now()).toISOString() })}\n`);
    } catch (error) {
      trailWorks = false;
      say("trail_error", { file, ...describeError(error) });
    }
  };

  const sample = (cgroup: CgroupMemory | null = readCgroupMemory(io.read)): Sample => {
    const memory = io.memory();
    const status = parseProcStatus(io.read("/proc/self/status"));
    const lag = io.lag();
    return {
      rssMb: Math.round(memory.rss / (1024 * 1024)),
      hwmMb: status.hwmMb,
      heapMb: Math.round(memory.heapUsed / (1024 * 1024)),
      externalMb: Math.round(memory.external / (1024 * 1024)),
      threads: status.threads,
      fds: io.count("/proc/self/fd"),
      load1: Math.round(io.load1() * 100) / 100,
      ppid: io.facts.ppid(),
      lagP99Ms: Math.round(lag.p99),
      lagMaxMs: Math.round(lag.max),
      oomKills: cgroup?.oomKills ?? null,
      cgroupUsedMb: cgroup?.usedMb ?? null,
      upSeconds: Math.round(io.facts.upSeconds()),
    };
  };

  /** A call that cannot be allowed to bring the process down, because it is the thing that watches it. */
  const safely = <Args extends unknown[]>(work: (...args: Args) => void) => (...args: Args) => {
    try {
      work(...args);
    } catch {
      // Nothing here may stop the app.
    }
  };

  return {
    start: safely(() => {
      const text = io.read(file);
      const events = text === null ? [] : parseTrail(text);
      if (text !== null && text.length > TRAIL_LIMIT) {
        try {
          io.write(file, trimTrail(text, TRAIL_LIMIT, TRAIL_KEEP));
        } catch {
          trailWorks = false;
        }
      }
      const cgroup = readCgroupMemory(io.read);
      const first = sample(cgroup);
      const earlier = summarizeTrail(events, id, io.now(), first.oomKills, OTHERS_LOOKED_AT, io.alive);
      for (const previous of earlier.slice(-PREVIOUS_SHOWN)) say("previous", { ...previous, previous: previous.id, id: undefined });
      say("start", {
        othersRunning: earlier.filter(previous => previous.ended === "running").length,
        pid: io.facts.pid,
        ppid: first.ppid,
        parent: io.read(`/proc/${first.ppid}/comm`)?.trim() || null,
        node: io.facts.node,
        execArgv: io.facts.execArgv,
        hostUptimeMinutes: io.facts.hostUptimeMinutes,
        rssMb: first.rssMb,
        heapLimitMb: io.facts.heapLimitMb,
        totalMemMb: io.facts.totalMemMb,
        cgroup,
        limits: parseLimits(io.read("/proc/self/limits")),
        hints: io.facts.hints,
        hostSettings: io.facts.settings,
        trail: { file, found: text !== null, events: events.length },
      });
      record({ ev: "start", pid: io.facts.pid, rssMb: first.rssMb, oomKills: first.oomKills });
    }),
    beat: safely(() => {
      const now = sample();
      beats += 1;
      record({ ev: "beat", rssMb: now.rssMb, hwmMb: now.hwmMb, oomKills: now.oomKills });
      const jumped = lastRss !== null && now.rssMb - lastRss >= SPIKE_RSS_MB;
      const stalled = now.lagMaxMs >= SPIKE_LAG_MS;
      if (beats % healthEvery === 0 || jumped || stalled) {
        // The other processes of the app that are running now, read from the trail: the host can run more than one beside this one.
        const others = summarizeTrail(parseTrail(io.read(file) ?? ""), id, io.now(), null, OTHERS_LOOKED_AT, io.alive)
          .filter(other => other.ended === "running")
          .map(other => ({ pid: other.pid, silentSeconds: other.silentSeconds }));
        say("health", { ...now, others, note: jumped ? "memory jumped" : stalled ? "event loop stalled" : undefined });
      }
      lastRss = now.rssMb;
    }),
    signal: safely((name: string) => {
      say("signal", { signal: name, upSeconds: Math.round(io.facts.upSeconds()), rssMb: Math.round(io.memory().rss / (1024 * 1024)) });
      record({ ev: "signal", signal: name });
    }),
    crash: safely((error: unknown, origin: string) => {
      const described = describeError(error);
      io.error(JSON.stringify({ event: "nooscape_lifecycle", kind: "crash", inst: id, origin, upSeconds: Math.round(io.facts.upSeconds()), ...described }));
      record({ ev: "crash", origin, message: `${described.name}: ${described.message}` });
    }),
    exit: safely((code: number | null) => {
      say("exit", { code, upSeconds: Math.round(io.facts.upSeconds()) });
      record({ ev: "exit", code });
    }),
    shutdown: safely((result: unknown) => {
      const stop = readShutdown(result);
      if (stop) record({ ev: "shutdown", ...stop });
    }),
  };
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The real world: the files, the clock, the console and the process. */
function realIo(): { io: Io; stop: () => void } {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const started = Date.now();
  const io: Io = {
    now: Date.now,
    read: readText,
    append: (file, text) => appendFileSync(file, text, { mode: 0o600 }),
    write: (file, text) => writeFileSync(file, text, { mode: 0o600 }),
    count: dir => {
      try {
        return readdirSync(dir).length;
      } catch {
        return null;
      }
    },
    alive: pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM is a process that exists and is not ours to signal.
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    lag: () => {
      const reading = { p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 };
      histogram.reset();
      return reading;
    },
    memory: () => process.memoryUsage(),
    load1: () => os.loadavg()[0] ?? 0,
    log: line => console.log(line),
    error: line => console.error(line),
    facts: {
      id: randomBytes(4).toString("hex"),
      pid: process.pid,
      ppid: () => process.ppid,
      node: process.version,
      execArgv: process.execArgv,
      hints: Object.keys(process.env).filter(name => HOST_HINT.test(name)).sort().slice(0, 20),
      settings: hostSettings(process.env),
      hostUptimeMinutes: Math.round(os.uptime() / 60),
      heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024)),
      totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
      upSeconds: () => (Date.now() - started) / 1000,
      tmp: os.tmpdir(),
    },
  };
  return { io, stop: () => histogram.disable() };
}

/**
 * Starts the lifecycle log on this process and returns a function that stops it (the tests use it; the app never does). It changes no
 * behaviour: a signal is written and then raised again with this handler removed, so the process ends as it would have, by that signal;
 * a crash is only observed; and the timer does not keep the process alive. The one thing it may do is wait: when `beforeEnd` is given,
 * a stop signal (SIGTERM or SIGINT) is raised again only once that has ended, or the limit has passed, or a second signal has come.
 */
export function startLifecycleLog(options: LifecycleOptions = {}): () => void {
  const { io, stop: stopLag } = realIo();
  const lifecycle = createLifecycleLog(io, options);
  lifecycle.start();
  const timer = setInterval(lifecycle.beat, options.beatMs ?? BEAT_MS);
  timer.unref();

  const handlers = new Map<string, () => void>();
  const removeSignalHandlers = () => {
    handlers.forEach((handler, name) => process.removeListener(name, handler));
    handlers.clear();
  };
  let ended = false;
  let waiting = false;
  const end = (name: string) => {
    if (ended) return;
    ended = true;
    removeSignalHandlers();
    process.kill(process.pid, name);
  };
  for (const name of SIGNALS) {
    const handler = () => {
      try {
        lifecycle.signal(name);
      } finally {
        if (options.beforeEnd && STOP_SIGNALS.has(name) && !waiting) {
          waiting = true;
          const guard = setTimeout(() => end(name), options.beforeEndMs ?? BEFORE_END_MS);
          void Promise.resolve()
            .then(() => options.beforeEnd!(name))
            .then(result => lifecycle.shutdown(result))
            .catch(() => undefined)
            .finally(() => {
              clearTimeout(guard);
              end(name);
            });
        } else {
          end(name);
        }
      }
    };
    handlers.set(name, handler);
    process.on(name, handler);
  }
  const onCrash = (error: unknown, origin: string) => lifecycle.crash(error, origin);
  const onExit = (code: number) => lifecycle.exit(code);
  process.on("uncaughtExceptionMonitor", onCrash);
  process.on("exit", onExit);

  return () => {
    clearInterval(timer);
    removeSignalHandlers();
    process.removeListener("uncaughtExceptionMonitor", onCrash);
    process.removeListener("exit", onExit);
    stopLag();
  };
}
