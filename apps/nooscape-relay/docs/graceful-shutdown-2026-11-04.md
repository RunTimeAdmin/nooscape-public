# A stop signal waits for what the app has to finish (4 November 2026)

**Status.** Live since 2026-11-04 20:49 UTC (PR 263). Its first real stop has not been read. The stop's own `nooscape_shutdown` line goes to the runtime log of the deployment the process ran in, and the deploy that stops the process replaces that log, so a follow-up of 2026-11-05 (built, not yet live) also writes the result to the lifecycle trail, and the next start shows it on the `previous` line of the process it replaced. See "Reading a real stop".

**Decided:** 2026-11-04, by the operator, in chat: "go" and then "next", on the list I gave after the third outside review ("graceful shutdown plus the bootstrap-from-empty path as the second PR"). The review's finding was S5 (and B3): the app does not stop gracefully.

## Why

A deploy on the host stops the old processes with SIGTERM ([lifecycle logging](./lifecycle-logging-2026-11-01.md): both old processes ended by a catchable SIGTERM). The lifecycle log wrote the signal and raised it again at once, by design: it "changes no behaviour". So a request in flight was cut, a paid one included (the payment is recorded before it is sent, so a retry finds it, but the caller sees a broken answer), and whatever the meter had counted since its last write, up to 20 seconds of usage, was lost.

## What it does

- `server/gracefulShutdown.ts` holds a set of tasks. A part of the app that has something to finish says so with `onShutdown(name, run)`. When a stop comes, all tasks run at once, one that throws or never ends stops no other, and the wait has a ceiling of 15 seconds (`SHUTDOWN_CEILING_MS`). It happens once: a second call gets the first answer. One JSON line, `nooscape_shutdown`, says how long it took, whether the ceiling was hit and how each task went.
- `startLifecycleLog({ beforeEnd })` (`server/lifecycleLog.ts`) runs that wait for SIGTERM and SIGINT only. The signal is still written first, and it is still raised again afterwards with the handler removed, so the process still ends by that signal (status 143 on Linux) and the next process still reads it as `signal`. A second stop signal while it waits ends the process at once, and so does `beforeEndMs` (20 seconds, more than the shutdown's own 15 so its line is written first). SIGHUP, SIGQUIT and SIGUSR2 never wait.
- When the wait ends with its answer, the lifecycle log also writes it to the trail as a `shutdown` event after the `signal` event (added 2026-11-05): how long it took, whether the ceiling was hit, and the names, only the names, of the tasks that did not finish well. A wait that is given up before it answers (a second signal, or the 20 seconds) writes none, and neither does a signal that was never a stop.
- `server/_core/index.ts` registers two tasks once the server exists: `http` stops listening, lets every request in flight finish (a settlement runs inside its request, so the payment path needs nothing of its own), and closes keep-alive connections as they go idle; `api meter` writes what has been counted. It is wired only where the lifecycle log is, in production.

## What was checked

- `server/gracefulShutdown.test.ts` (9 tests): the tasks run at once and one line says how each went; a task that throws is reported with no password in what it says and stops no other; the ceiling ends the wait and names the task still running; a second call runs nothing again; and on a real HTTP server a request in flight finishes while a new one is refused, an idle keep-alive connection ends without the server's own 5 second timeout, and one that goes idle after the close ends too.
- `server/lifecycleLog.test.ts`, real processes (not run on Windows, which has no signals to send): the process waits for `beforeEnd` before it ends by SIGTERM or SIGINT and is still ended by that signal with no exit code; a second signal ends it at once and a wait that does not end is given up at its limit; SIGHUP does not wait; and `index.ts` is held to the call and the two tasks.
- Each guard was failed by a planted bug and caught: SIGHUP treated as a stop, a second signal starting the wait again, the limit never applied, the ceiling never applied, the meter task missing, and the idle sweep left out (a connection that goes idle after the close then lingers 6 seconds).
- Run on Linux in Node 22 (a container), against a real HTTP server with these modules: with a 2 second request in flight, SIGTERM stopped the server listening at once (a new request was refused in 5 ms), the request finished with a 200 after 2,013 ms, both tasks reported `ok`, and the process ended by SIGTERM (status 143) 1,552 ms after the signal. With a request that never finishes, the wait ended at the ceiling (15,001 ms, `ceilingHit` true, `http` named as still running), the meter was written, and the process ended by SIGTERM at 15,007 ms.
- `server/lifecycleLog.test.ts`, added 2026-11-05: the trail event is read and summarised (the wait counts in the time the process ran, not in the gap before the next start); `readShutdown` takes the answer of the real `createShutdown` and nothing else (task names, never an error text); and on real processes the answer is written after the signal and the next process says it on the `previous` line, while a wait given up before it ended, a second signal and a signal that was never a stop write none. Five planted bugs (the answer never recorded, never shown, the failed names inverted, the ceiling never shown, an answer written for every signal) were each caught. Run on Linux in Node 22 (a container): 62 tests passed.

## Reading a real stop (2026-11-05)

The first read of a real stop was tried at 04:25 UTC on 2026-11-05, after PR 270 deployed. Two processes that had started at 03:39 and 03:40 UTC, with this code, were ended by SIGTERM at 04:24:59 UTC. The runtime log of the new deployment (39 lines) had no `nooscape_shutdown` line, and could not have: the log starts again at each deploy, and the line is written to the log of the deployment the old process ran in. What survived is the trail. Its `previous` lines say the two ended by `SIGTERM` and give the time of the signal, and nothing after it, so they could not say whether the wait ran, how long it took or whether the host cut it short. The follow-up closes that gap: the answer goes into the trail, and the start that follows a stop prints it as `shutdown` on the `previous` line.

| `previous.shutdown` | what it means |
|---|---|
| `{ tookMs, ceilingHit: false, failed: [] }` | The app waited for the requests in flight and the meter, and was done after `tookMs` milliseconds. |
| `ceilingHit` true | The 15 second ceiling ended the wait. `failed` names what was still running (`http` is a request that did not finish). |
| `failed` not empty, `ceilingHit` false | A task threw. Its error is in the process's own log, which the deploy replaced. |
| `null` on a process ended by `SIGTERM` | No answer was written: the process ran code from before this change, or the wait was given up before it answered (a second signal, or the 20 seconds), or it never ran. |

The first deploy after the follow-up goes live still stops processes that run the old code, so the deploy after that is the first stop to read. Read the runtime log right after it, before the next merge, and keep the `previous` lines.

## What it does not do

- A worker tick that runs longer than the ceiling is still cut. The tick is a request to the app, so it is waited for, but only for 15 seconds; ingestion is built to be resumed (a claim, a cursor), as it was before.
- It cannot make the host wait. How long lsnode lets an old process live after SIGTERM is not known. If the host ends it sooner than 15 seconds, the wait is cut by the host. What a real stop took is read from the `shutdown` field of the `previous` line that the next start prints (see "Reading a real stop"); the stop's own `nooscape_shutdown` line is in the log of the deployment it ran in, which that deploy replaces.
- It adds nothing in development, where the lifecycle log is not started.
- On a VPS run under Docker, the stop timeout must be longer than 20 seconds (`stop_grace_period: 25s` in the compose file), or Docker ends the process first.

## Addendum 2026-11-05: the first stops read on the host

The deploys of pull requests 273, 274 and 275 (15:35, 15:39 and 15:48 UTC) each stopped the two processes of the deployment before, which ran the code of this change, and the next start printed their `previous` lines with `shutdown` filled in: SIGTERM at 15:38:03 (`tookMs` 1 and 1), at 15:41:29 (0 and 0) and at 15:49:07 (1 and 1), with `ceilingHit` false and `failed` empty on all six. So the wait does run on the host, and its answer is readable after the next deploy, as the follow-up intended. The processes had been up for three to eight minutes and had nothing in flight, so it answered at once; the case with a request in flight is covered by the real-process tests on Linux, not yet by a stop on the host. What lsnode does with a process that is still busy after SIGTERM is still not known, and the first stop that catches one will say. The first deploy after the change (PR 272, 15:34 UTC) stopped processes that ran the old code, as this record said it would: their `previous` lines show `shutdown: null`.
