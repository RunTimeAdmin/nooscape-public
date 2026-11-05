# A stop signal waits for what the app has to finish (4 November 2026)

**Status.** Built on 2026-11-04 and not yet live; the merge and the first real stop on the host are recorded here when they are done.

**Decided:** 2026-11-04, by the operator, in chat: "go" and then "next", on the list I gave after the third outside review ("graceful shutdown plus the bootstrap-from-empty path as the second PR"). The review's finding was S5 (and B3): the app does not stop gracefully.

## Why

A deploy on the host stops the old processes with SIGTERM ([lifecycle logging](./lifecycle-logging-2026-11-01.md): both old processes ended by a catchable SIGTERM). The lifecycle log wrote the signal and raised it again at once, by design: it "changes no behaviour". So a request in flight was cut, a paid one included (the payment is recorded before it is sent, so a retry finds it, but the caller sees a broken answer), and whatever the meter had counted since its last write, up to 20 seconds of usage, was lost.

## What it does

- `server/gracefulShutdown.ts` holds a set of tasks. A part of the app that has something to finish says so with `onShutdown(name, run)`. When a stop comes, all tasks run at once, one that throws or never ends stops no other, and the wait has a ceiling of 15 seconds (`SHUTDOWN_CEILING_MS`). It happens once: a second call gets the first answer. One JSON line, `nooscape_shutdown`, says how long it took, whether the ceiling was hit and how each task went.
- `startLifecycleLog({ beforeEnd })` (`server/lifecycleLog.ts`) runs that wait for SIGTERM and SIGINT only. The signal is still written first, and it is still raised again afterwards with the handler removed, so the process still ends by that signal (status 143 on Linux) and the next process still reads it as `signal`. A second stop signal while it waits ends the process at once, and so does `beforeEndMs` (20 seconds, more than the shutdown's own 15 so its line is written first). SIGHUP, SIGQUIT and SIGUSR2 never wait.
- `server/_core/index.ts` registers two tasks once the server exists: `http` stops listening, lets every request in flight finish (a settlement runs inside its request, so the payment path needs nothing of its own), and closes keep-alive connections as they go idle; `api meter` writes what has been counted. It is wired only where the lifecycle log is, in production.

## What was checked

- `server/gracefulShutdown.test.ts` (9 tests): the tasks run at once and one line says how each went; a task that throws is reported with no password in what it says and stops no other; the ceiling ends the wait and names the task still running; a second call runs nothing again; and on a real HTTP server a request in flight finishes while a new one is refused, an idle keep-alive connection ends without the server's own 5 second timeout, and one that goes idle after the close ends too.
- `server/lifecycleLog.test.ts`, real processes (not run on Windows, which has no signals to send): the process waits for `beforeEnd` before it ends by SIGTERM or SIGINT and is still ended by that signal with no exit code; a second signal ends it at once and a wait that does not end is given up at its limit; SIGHUP does not wait; and `index.ts` is held to the call and the two tasks.
- Each guard was failed by a planted bug and caught: SIGHUP treated as a stop, a second signal starting the wait again, the limit never applied, the ceiling never applied, the meter task missing, and the idle sweep left out (a connection that goes idle after the close then lingers 6 seconds).
- Run on Linux in Node 22 (a container), against a real HTTP server with these modules: with a 2 second request in flight, SIGTERM stopped the server listening at once (a new request was refused in 5 ms), the request finished with a 200 after 2,013 ms, both tasks reported `ok`, and the process ended by SIGTERM (status 143) 1,552 ms after the signal. With a request that never finishes, the wait ended at the ceiling (15,001 ms, `ceilingHit` true, `http` named as still running), the meter was written, and the process ended by SIGTERM at 15,007 ms.

## What it does not do

- A worker tick that runs longer than the ceiling is still cut. The tick is a request to the app, so it is waited for, but only for 15 seconds; ingestion is built to be resumed (a claim, a cursor), as it was before.
- It cannot make the host wait. How long lsnode lets an old process live after SIGTERM is not known. If the host ends it sooner than 15 seconds, the wait is cut by the host. The `nooscape_shutdown` line in the runtime log at the next deploy says what a real stop took; read it there.
- It adds nothing in development, where the lifecycle log is not started.
- On a VPS run under Docker, the stop timeout must be longer than 20 seconds (`stop_grace_period: 25s` in the compose file), or Docker ends the process first.
