import { join, sep } from "node:path";
import express, { type Express, type Request, type Response } from "express";
// Named import, not default: pino-http is CommonJS, and under NodeNext its
// types put the function at `.default`, so a default import type-checks as
// a non-callable object even though it works at runtime.
import { pinoHttp } from "pino-http";
import type { Collection } from "mongodb";
import type { HealthResponse, ReadyResponse } from "@warden/shared";
import { authRouter } from "./api/auth.js";
import { apiRouter, type ApiDeps } from "./api/routes.js";
import type { AuditLog } from "./audit/log.js";
import { requireApiKey } from "./auth/middleware.js";
import { requireSession } from "./auth/session.js";
import type { KeyAdmin } from "./auth/store.js";
import type { UserDoc } from "./db/mongo.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { mcpRouter } from "./mcp/route.js";
import type { McpDeps } from "./mcp/server.js";

const startedAt = Date.now();
const VERSION = "0.0.0";

/** Everything the app needs from the outside world, passed in explicitly. */
export interface AppDeps extends McpDeps, ApiDeps {
  keyStore: KeyAdmin;
  users: Collection<UserDoc>;
  audit: AuditLog;
}

/**
 * Builds the Express application.
 *
 * Dependencies arrive as an argument rather than being imported, which is
 * what lets the tests hand in in-memory stores. No app.listen() here:
 * index.ts listens, and the tests listen on a random port.
 *
 * Two kinds of caller, two kinds of credential:
 *   /mcp  — AI agents, with an API key       (requireApiKey)
 *   /api  — humans, with a session cookie    (requireSession)
 */
export function buildApp(deps: AppDeps): Express {
  const app = express();

  // Off unless configured: trusting X-Forwarded-For from anyone would let a
  // client fake its IP on every request and dodge the login rate limit.
  app.set("trust proxy", env.TRUST_PROXY);
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req: Request, res: Response<HealthResponse>) => {
    res.json({
      status: "ok",
      service: "warden-gateway",
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  /**
   * Readiness probe. Unlike /healthz this DOES inspect dependencies.
   * Three states: "degraded" still serves traffic, so it returns 200;
   * only "unavailable" (no upstream at all) returns 503.
   */
  app.get("/readyz", (_req: Request, res: Response<ReadyResponse>) => {
    const upstreams = deps.pool.health();
    const healthy = upstreams.filter((u) => u.status === "connected").length;
    const status: ReadyResponse["status"] =
      healthy === upstreams.length ? "ready" : healthy === 0 ? "unavailable" : "degraded";
    res.status(status === "unavailable" ? 503 : 200).json({ status, upstreams });
  });

  // Agents.
  app.use("/mcp", requireApiKey(deps.keyStore));
  app.use(mcpRouter(deps));

  // Humans. Sign-up and log-in are mounted BEFORE the session check —
  // you cannot need a session to get a session.
  app.use(authRouter({ users: deps.users, rateLimiter: deps.rateLimiter, audit: deps.audit }));
  app.use("/api", requireSession(deps.users));
  app.use(apiRouter(deps));
  app.use("/api", (req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", path: req.originalUrl });
  });

  // The built dashboard, when there is one (the Docker image). Page requests
  // fall back to index.html so the single-page app handles its own routes.
  if (env.DASHBOARD_DIR !== undefined) {
    const dir = env.DASHBOARD_DIR;
    // Caching: index.html must NEVER be cached — it names the current bundle,
    // and a cached copy keeps pointing at last release's JavaScript. The
    // bundles in /assets have a content hash in their file name, so they
    // can be cached forever: new code means a new name.
    app.use(
      express.static(dir, {
        index: "index.html",
        setHeaders(res, filePath) {
          res.setHeader("Cache-Control", filePath.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
        },
      }),
    );
    app.get(/^\/(?!mcp|api|healthz|readyz|\.well-known).*/, (req: Request, res: Response, next) => {
      // Only browsers asking for a page get the dashboard. A program asking
      // for JSON (e.g. an MCP client probing /.well-known/oauth-* after a
      // 401) must get a real 404 — an HTML page with status 200 tells it
      // "yes, OAuth lives here" and it fails trying to parse the page.
      if (req.accepts(["html", "json"]) !== "html") {
        next();
        return;
      }
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(join(dir, "index.html"));
    });
  }

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  return app;
}
