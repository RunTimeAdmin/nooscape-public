import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { registerApiCachePolicy, registerSecurityHeaders } from "./securityHeaders";
import { logUnexpectedTrpcError } from "./trpc";
import { serveStatic, setupVite } from "./vite";
import { rateLimitExpress } from "../rateLimit";
import { registerApiV1 } from "../apiV1";
import { registerSecurityTxt } from "../securityTxt";
import { registerRelayKeyList } from "../keyList";
import { registerDiscovery } from "../discovery";
import { TRPC_MAX_BATCH_SIZE } from "@shared/trpcBatch";
import { describeDatabaseTarget } from "../databaseTarget";
import { applyPendingMigrations } from "../dbMigrations";
import { startReadWarming } from "../warmReads";
import { preferIPv4 } from "./ipv4First";

preferIPv4();

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Apply pending schema migrations before the server accepts traffic so code
  // and schema ship together. A failed migration exits loudly instead of
  // serving an API that would silently fail closed on missing columns. Local
  // tooling runs without DATABASE_URL and skips this step.
  if (process.env.DATABASE_URL) {
    try {
      const appliedMigrations = await applyPendingMigrations(process.env.DATABASE_URL);
      if (appliedMigrations.length > 0) {
        console.log(`[Migrations] Applied ${appliedMigrations.length} pending: ${appliedMigrations.join(", ")}`);
      } else {
        console.log("[Migrations] Schema is current; nothing to apply.");
      }
    } catch (error) {
      console.error("[Migrations] Failed to apply pending migrations:", error);
      console.error(`[Migrations] ${await describeDatabaseTarget(process.env.DATABASE_URL)}`);
      process.exit(1);
    }
  } else {
    console.log("[Migrations] DATABASE_URL not set; skipped (local tooling mode).");
  }
  const app = express();
  const server = createServer(app);
  // The relay sits behind the Hostinger edge (hcdn): trust the single proxy
  // hop so req.ip / req.secure reflect the real client.
  app.set("trust proxy", 1);
  registerSecurityHeaders(app);
  // Mounted before the rate limiter and routers so even 429/error responses
  // carry the policy; static assets are served outside /api and stay cacheable.
  registerApiCachePolicy(app);
  // The REST API (docs/data-access-2026-10-19.md): its own limit of 30 a minute, read only, mounted before the tRPC limiter and the body parsers.
  registerApiV1(app);
  // Public surface limits: the tRPC API is rate limited per client. The
  // budget (600 per 5 minutes) is well above a browsing session - home page
  // queries are batched and poll every 8-20s. Mounted before the body parsers,
  // so a client over its limit is refused without its body being read and parsed.
  app.use("/api/trpc", rateLimitExpress("trpc", 600, 5 * 60 * 1000));
  // The relay accepts small JSON payloads only; the largest known body is a
  // 256 KB evidence packet. Uploads and downloads use presigned storage URLs
  // outside this server, so the template's 50 MB limits are not needed.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "100kb", extended: true }));
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      maxBatchSize: TRPC_MAX_BATCH_SIZE,
      onError: logUnexpectedTrpcError,
    })
  );
  // The security contact, before the static files and the client's catch-all.
  registerSecurityTxt(app);
  registerRelayKeyList(app);
  // The page for models and the list of payable routes (docs/x402-discovery-2026-10-21.md), for the same reason.
  registerDiscovery(app);
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  // In production the host assigns the port. Taking another one would leave the proxy pointing at nothing while the
  // process looks healthy, so a busy port ends the process instead (listen's error is not caught).
  const port = process.env.NODE_ENV === "production" ? preferredPort : await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    console.log("[Runtime] Single-instance mode: operator sessions, rate limits and read caches live in this process's memory, so run one instance only.");
    if (process.env.DATABASE_URL) startReadWarming();
  });
}

startServer().catch(console.error);
