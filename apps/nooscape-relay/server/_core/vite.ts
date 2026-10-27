import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";
import { catchPages } from "../catchPage";
import { routeHeads } from "../routeHead";
import { sitemapRoute } from "../sitemap";
import { isClientRoutePath } from "../clientRoutes";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    // The config is a function of the command, so it is called the way Vite would; spreading the function itself adds no options at all.
    ...viteConfig({ command: "serve", mode: "development" }),
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

/**
 * Build files under /assets carry a content hash in their name, so one name is one file for ever and a browser may
 * keep it for a year. Everything else, index.html included, is still revalidated on every visit.
 */
export function immutableAssets(distPath: string) {
  return express.static(path.join(distPath, "assets"), { immutable: true, maxAge: "1y", index: false });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use("/assets", immutableAssets(distPath));

  // /sitemap.xml is built from the fixed pages in the copied file plus the reviewed records and the catch days (server/sitemap.ts),
  // so it is mounted before the static files, which would send the fixed pages alone.
  app.use(sitemapRoute(distPath));
  app.use(express.static(distPath));

  // The Owl's Catch pages carry their own head (title, preview text, address) for crawlers that run no script.
  app.use(catchPages(distPath));

  // Every other routed page carries its own head too (server/routeHead.ts): the fixed pages from a table, and /agents/:id by name.
  app.use(routeHeads(distPath));

  // fall through to the SPA shell. Status honesty: a path the client's wouter
  // switch can route gets 200, and everything else is the catch-all NotFound's
  // territory — it still receives the same shell (so the rendered page is the
  // styled NotFound), but with a real HTTP 404 instead of a 200 homepage.
  // The path comes from originalUrl because a wildcard mount rewrites
  // req.path to "/" (verified live-probed against express 4.22); the query
  // string never participates in routing.
  app.use("*", (req, res) => {
    const pathname = (req.originalUrl || "/").split("?")[0]!;
    const status = isClientRoutePath(pathname) ? 200 : 404;
    res.status(status).sendFile(path.resolve(distPath, "index.html"));
  });
}
