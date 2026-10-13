import express, { type Express, type Request, type Response } from "express";
// Named import, not default: pino-http is CommonJS, and under NodeNext its
// types put the function at `.default`, so a default import type-checks as
// a non-callable object even though it works at runtime.
import { pinoHttp } from "pino-http";
import type { HealthResponse, ReadyResponse } from "@warden/shared";
import { requireApiKey } from "./auth/middleware.js";
import type { KeyStore } from "./auth/store.js";
import { logger } from "./logger.js";
import { mcpRouter } from "./mcp/route.js";
import type { UpstreamPool } from "./mcp/pool.js";

const startedAt = Date.now();
const VERSION = "0.0.0";

/** Everything the app needs from the outside world, passed in explicitly. */
export interface AppDeps {
  pool: UpstreamPool;
  keyStore: KeyStore;
}

/**
 * Builds the Express application.
 *
 * Dependencies arrive as an argument rather than being imported. That is
 * what lets Day 12's tests hand in a fake pool that returns canned tools,
 * with no child processes anywhere. A module that reaches out and imports
 * its own dependencies cannot be tested without them.
 *
 * Still no app.listen() here — creating the app and starting the server
 * stay separate jobs.
 */
export function buildApp(deps: AppDeps): Express {
  const app = express();

  app.set("trust proxy", true);
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
   * Readiness probe. Unlike /healthz this DOES inspect dependencies,
   * because that is the question it exists to answer.
   *
   * Three states, not two. "degraded" is the one people forget to model,
   * and it is the state a gateway spends most of its bad days in: still
   * useful, just not whole. Collapsing it into "unhealthy" gets you
   * restarted for no reason; collapsing it into "healthy" means nobody
   * ever finds out.
   */
  app.get("/readyz", (_req: Request, res: Response<ReadyResponse>) => {
    const upstreams = deps.pool.health();
    const healthy = upstreams.filter((u) => u.status === "connected").length;

    const status: ReadyResponse["status"] =
      healthy === upstreams.length ? "ready" : healthy === 0 ? "unavailable" : "degraded";

    // 503 only when nothing works at all. A degraded gateway still serves
    // real traffic and must not be taken out of rotation for it.
    res.status(status === "unavailable" ? 503 : 200).json({ status, upstreams });
  });

  // Everything under /mcp needs a valid key. /healthz and /readyz above
  // stay open on purpose: AWS health checks cannot carry an API key.
  app.use("/mcp", requireApiKey(deps.keyStore));
  app.use(mcpRouter(deps.pool));

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  return app;
}
