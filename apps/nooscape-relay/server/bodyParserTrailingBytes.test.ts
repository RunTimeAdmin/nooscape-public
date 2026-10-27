import { spawn } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * GHSA-27r3-jxmh-p828 (CVE-2026-111181), body-parser before 1.20.9. After a compressed request body was read, the decoder stayed piped
 * from the request with no error listener, so bytes that arrived later made it emit an error nothing caught, and one unauthenticated
 * request stopped the process. The app mounts express.json and express.urlencoded on every request (server/_core/index.ts), so every
 * path was open to it. Hostinger's scan flagged it on 23 October 2026. The server below runs in a child process with the same two
 * parsers, so the crash this test looks for ends the child and not the test run.
 */
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const serverSource = `
const express = require("express");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "100kb", extended: true }));
app.post("/", (_req, res) => res.json({ ok: true }));
const server = app.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`;

function startServer() {
  const child = spawn(process.execPath, ["-e", serverSource], { cwd: appRoot, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<string>(resolve => child.once("exit", (code, signal) => resolve(`the server exited (code ${code}, signal ${signal})`)));
  const port = new Promise<number>((resolve, reject) => {
    child.stdout.once("data", chunk => resolve(Number(String(chunk).split("PORT ")[1])));
    child.once("error", reject);
  });
  return { child, exited, port };
}

describe("a compressed request body followed by bytes that arrive late", () => {
  it("is answered and does not stop the server", async () => {
    const { child, exited, port } = startServer();
    try {
      const listening = await port;
      const frame = gzipSync(Buffer.from('{"a":1}'));
      // Zeros after the frame end the decoder's output at once, so the body is read and the request answered; the bytes sent
      // afterwards then reach a decoder that has already finished.
      const padding = Buffer.alloc(8);
      const late = Buffer.from("late bytes");
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: listening,
            method: "POST",
            path: "/",
            headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": frame.length + padding.length + late.length },
          },
          response => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.write(Buffer.concat([frame, padding]));
        setTimeout(() => req.end(late), 300);
      });
      expect(status).toBe(200);
      // A crash follows the late bytes within milliseconds; the wait is generous.
      const outcome = await Promise.race([exited, new Promise<string>(resolve => setTimeout(() => resolve("the server is still running"), 1000))]);
      expect(outcome).toBe("the server is still running");
    } finally {
      child.kill();
    }
  });
});
