# Lifecycle logging: how the app's process starts, stops and dies

The app now writes down what happens to its own process: a line when it is stopped by a signal, crashes or exits, a line every few minutes with its memory and the delay of its event loop, and a small trail file that lets the next process say how the last ones ended, including one that was killed and could write nothing. Production only. No migration, no setting, no table, and the process ends exactly as it did before.

**Status.** Live since 2026-11-01 20:32 UTC (PR 244, `main` 088de91). The same evening a follow-up added the values of the host's process-manager settings to the start line (see "The host's settings").

**Decided:** 2026-11-01, by the operator, in chat: "add ways to capture the correct logs to see whats happening", after the five restarts with no deploy that the same day's log could not explain. The offer to log signals, exits and memory was mine; the shape of the answer is mine too, so the operator can say no to any of it.

## What was known

- On 2026-11-01 the app was started five times by itself, at 08:30:08, 08:30:56, 09:18:13, 09:49:54 and 11:06:45 UTC, each of the same build and 0.8 to 15 minutes after a tick had finished. There was no error line before any of them, and three warnings in the whole day.
- The app had no handler for a signal or a crash, and no `process.exit` at run time (the one at start-up, for a failed migration, logs first). A stop therefore left no line, and a crash would have printed a trace. None was there, so the stops came from outside the process: the platform sent a signal, or killed it.
- The order's limits are 6 GiB of memory, 4 cores and 200 processes. The usage figures for the plan come back empty from the API, so nothing showed how much memory the process was using when it went.
- The runtime log starts again at each deploy and holds what the process printed. A process that is killed prints nothing, so its last minutes were never in it.

## What it writes

Every line is one JSON object with `event: "nooscape_lifecycle"`, a `kind` and `inst`, a random id of eight hex digits for the process that wrote it. A deploy starts the app twice a few seconds apart, and the id is what tells the two apart (a process id can be used again).

| kind | when | what it says |
|---|---|---|
| `start` | once, as the process starts | its pid and its parent's pid and process name, the Node version and flags, how long the host has been up, its memory, the heap limit, the host's memory, the cgroup's limit, use and count of memory kills where the host shows them, the limits on open files, processes and address space, the NAMES of the environment variables that say what runs it (`hints`), the VALUES of the few that set how long the app may run or idle (`hostSettings`, see below), and how many other processes of the app are running (`othersRunning`), and whether the trail was found |
| `previous` | at a start, one for each of the last five earlier processes, oldest first | how that process ended: `signal` (and which), `crash` (and the error), `exit` (and the code), `running` (no end record and its pid is still there: another process of the app, or one that has stopped writing) or `unknown` (no end record and no pid); when it started and when it last wrote; how long it ran; how long the app was without a process after it; its last memory and its peak; whether the host's count of memory kills rose before the next start. The field `previous` is that process's id |
| `health` | every fifth minute, and at once when memory jumps by 300 MB between two beats or the event loop is held up for 2 seconds (`note` says which) | memory (resident, peak, heap, external), threads, open files, load, the parent pid (it changes to 1 if the parent dies first), the event loop's delay at the 99th percentile and its longest since the last beat, the cgroup's use and kill count, seconds up, and `others`: the other processes of the app that are running, each with its pid and how long since it last wrote |
| `signal` | when the process is stopped by SIGTERM, SIGINT, SIGHUP, SIGQUIT or SIGUSR2 | which, how long it had run, its memory |
| `crash` | when an error is not caught, or a promise is rejected and not handled | where it came from, the error's name and its message cut to 200 characters with any user and password in an address removed. It goes to the error stream, and Node still prints the whole trace as before |
| `exit` | when the process exits by itself | the code, how long it had run |
| `trail_error` | once, if the trail file cannot be written | why |

## How a process that was killed is found out

A process killed by SIGKILL, or lost with its host, cannot write a line. So each process also appends to a trail file, `nooscape-lifecycle.jsonl` in the operating system's temporary directory (mode 0600): one `start`, a `beat` every minute with its memory, and then, if it gets to write one, a `signal`, `crash` or `exit`. The next process reads the file at its start and prints a `previous` line for each earlier process. One with no end record is `running` if its pid is still a process, which is another process of the app beside this one (the host can run more than one, and a process that starts beside one that is running has not been replaced), and `unknown` if it is not: then its last beat says when it was last alive, how big it was and, where the host shows a count of memory kills, whether that count rose. A pid can be used again by an unrelated process, so a `running` that is not another process of the app is possible, and an end record always wins over it. The file is cut to its last 100 KB when it passes 200 KB.

The file lives outside the deployment's folder, so where the host keeps its temporary files it survives a deploy: the runtime log starts again at a deploy, but the first start after one still prints how each of the last five processes ended, and a restart that happened before the deploy is not lost with the log.

If the file is not there (`trail.found` is false in the start line) the host's disk was new or its temporary files were cleared, and the earlier processes cannot be read. That is itself a finding for a start that follows no deploy.

## What the first start said on the host (2026-11-01)

The first lines from production, from the deploy of PR 244 at 20:32 UTC:

- **What runs the app.** The environment names are `LSAPI_MAX_PROCESS_TIME`, `LSAPI_PGRP_MAX_IDLE`, `LSAPI_PPID_NO_CHECK`, `LSNODE_CONSOLE_LOG`, `LSNODE_GUARD_PPID`, `LSNODE_ROOT`, `LSNODE_SOCKET` and `LSNODE_STARTUP_FILE`: the app runs under LiteSpeed's `lsnode`, the Node runner of LiteSpeed Web Server. Node is v22.23.4.
- **What the app cannot see.** The parent's process name and the cgroup's files are not readable from the app (`parent` and `cgroup` are null), so there is no memory kill count on this host and `oomKillsRose` is always null. The limits are 1,400 soft and 1,500 hard processes, 262,144 open files, and no limit on resident set or address space. The host has been up about 207 days and shows about 503 GB, which is the machine's memory and not the account's.
- **The trail works.** The second process of the deploy pair, 32 seconds after the first, found the file in `/tmp`, so the trail passes from one process to the next on this host.
- **Two processes of the app run at once.** The second process's `previous` line called the first `unknown`, after 0 seconds, with 32 seconds of silence. That was a mistake in this log, not a finding: the first process had not ended. It was running beside the second and had written only its start, because its first beat was not due for 60 seconds. Both processes then wrote a `health` line every fifth minute for more than an hour, with the same parent pid, and the host's own cron ticks reached only one of them (the memory peak of the second rose from 189 to 373 MB when the Monad ratings run took place at 21:00 UTC, and the first stayed at 177 MB). So the host runs more than one process of the app at a time, which the app's own boot line says it must not ("run one instance only": its operator sessions, rate limits and read caches are in each process's memory). A process with no end record is now `running` when its pid is still there, and `unknown` only when it is not (see "How a process that was killed is found out").
- **What that does to the five restarts.** A start with no deploy may be another process joining the first and not a restart. The earlier log could not tell the two apart, and this one now can: the start line says how many other processes are running, and each `health` line lists them.

## The host's settings

The start line also carries `hostSettings`: the values of every `LSAPI_*` variable and of the two flags `LSNODE_GUARD_PPID` and `LSNODE_CONSOLE_LOG`. LiteSpeed's PHP documentation says `LSAPI_MAX_PROCESS_TIME` (default 3600 seconds) lets the parent process kill a worker that spends longer than that on one request, and `LSAPI_PGRP_MAX_IDLE` (default forever) is how long a parent with no workers waits before exiting. Whether `lsnode` applies them in the same way is not in what was found, and the values on this host were unknown until this line was added, so what they are is the first thing to read from it.

A value is written only when it is up to 12 characters of letters, digits, dot, underscore and hyphen: a number, a flag or a word such as `FOREVER`. Anything longer, or with other characters, is written as its length (`(31 characters)`), so a path, a socket or a key is never written. The paths `LSNODE_ROOT`, `LSNODE_SOCKET` and `LSNODE_STARTUP_FILE` are not in the list at all and stay names in `hints`.

## Reading it

| what the next start says | what it means |
|---|---|
| `previous` ended `signal`, `SIGTERM` | The host asked the process to stop. The app did not fail. Ask the host why, with the times. |
| `previous` ended `running` | Another process of the app is running beside this one. The host runs more than one. If its `silentSeconds` grows past about two minutes, it is hung, because a running process writes every minute. |
| `health` with `others` that is not empty | The same: the pids listed are other processes of the app. A `previous` that is `unknown` and then appears as `others` was running all the time. |
| `previous` ended `unknown`, with a peak near the cgroup's limit, or `oomKillsRose` true | It was killed for memory. |
| `previous` ended `unknown`, with a small peak and no rise | Its pid is gone and it left no end record: it was killed with the app nowhere near a limit it can see. That is the host's doing: give the host the `startedAt` and `lastEventAt` and ask what it did at that time. |
| `previous` ended `crash` | The app's own error. The message is in the line, and the trace is in the runtime log just before. |
| `previous` ended `exit` | The process ended itself with that code. |
| `health` lines whose `rssMb` or `hwmMb` climb from one tick to the next | Memory is held and not given back, which would make a memory kill likely. |
| `health` with `note: "event loop stalled"` | Something held the process up for 2 seconds or more. A host that checks the app is alive may treat that as dead. |
| `health` with `ppid` changing to 1 | The process that started the app is gone and the app was left behind. |
| a `start` with `trail.found` false and no deploy | The file system is new: the app is being moved or its disk cleared when it is restarted. |

## Where to read it

The runtime log through the Hostinger connector (`hosting_nodejs_runtime-logs`, `from_line` 1 with a `limit` at or above `total_lines`), keeping the lines that hold `nooscape_lifecycle`. The log starts again at each deploy, so a restart is read from the log of the deployment it happened in. The operator can also read the same log in hPanel, and the site's resource graphs there, where the plan shows them, for the times of a restart. The host's own support is the only one that can say what the platform did, and a `previous` line gives them the times to look at.

## What it does not do

- It does not stop a restart, keep memory down or change what the process does. It says what happened.
- It cannot say why the host sent a signal, and it cannot see a stop that leaves the trail file behind with it.
- It writes no request, user, address, token or other environment value. The parent is named by its process name only, the environment by the names of a few variables (and the values of the few process-manager settings, when each is short and plain), and an error by its name and a cleaned, cut message.

## Cost

One small write a minute to the trail, and one line to the runtime log every fifth minute: about 290 lines and 80 KB a day, more only when memory jumps or the loop stalls. Each start adds up to five `previous` lines and one `start` line, so a deploy, which starts the app twice, adds up to twelve.

## What was checked

- `server/lifecycleLog.test.ts`: the trail is read and cut as described; an earlier process is summarised as ended by a signal, a crash, an exit or nothing, with two that overlap told apart and only the last five shown; the host's memory kill count is compared across a start; `/proc/self/status`, `/proc/self/limits` and the cgroup's v2 and v1 files are read; the behaviour against a world of its own (a start with and without a trail, a cut trail, a beat, a health line every fifth beat and at once on a jump or a stall, a signal, a crash and an exit, a trail that cannot be written, and no call throws whatever the world does); the call in `server/_core/index.ts` is made once, only in production, before the server is built; and the handlers are added to the process and all taken away again when it is stopped.
- Real processes (not run on Windows, which cannot send signals): SIGTERM ends the child by that signal with no exit code, as it would have without this, and the next process reads it; SIGKILL leaves nothing and the next process says `unknown` with the last beat; an uncaught error exits with code 1 and prints the stack as before, and the line carries no password; an exit code is kept; a process with nothing else to do ends by itself, so the timer does not keep it alive; only the names of the host's variables are written; the host's memory is a number.
- Run on Linux in Node 22 (a container) as well as on the operator's Windows machine: all 29 tests, and a real pair of processes, the first stopped by SIGTERM (exit status 143, the status of a process killed by it) and the second reading it.
- The settings (the follow-up): `hostSettings` writes the values of `LSAPI_*` and the two flags when short and plain, in name order, writes only the length of a path, a socket, a key-like value or one of 13 characters, and writes nothing for any other variable (the other `LSNODE_*`, `PASSENGER_*`, `DATABASE_URL`, lower case or longer names); the start line carries it; a real child process with a mix of them writes the short ones with their values and neither path. All 33 tests pass on Linux and Windows. Planted bugs, each caught: 8 (a key-like value written, a limit of 40 characters, every value written, all `LSNODE_*` taken as settings, names matched in any case, the field left out of the start line, the real process passing none, and the names out of order).
- The running-process fix: a process with no end record whose pid is alive is `running` and measured from now, one whose pid is gone is `unknown` and measured to the next start, one with no pid recorded is `unknown`, and one that wrote its end is never `running`; the start line counts the others and each health line lists them, and none once they have gone; and two real processes together: the first is read as `running` by the second, and as ended by its signal by the third once it has gone. 38 tests, all pass on Linux, 29 on Windows with 9 skipped. Planted bugs, each caught: 6 (a live pid called unknown, a running process measured to the next start, an end record overridden by a live pid, the health line without the others, the start line without the count, and the real pid check always saying no).

## Turning it off

Remove the one call in `server/_core/index.ts`. The trail file can be deleted at any time and is made again.
