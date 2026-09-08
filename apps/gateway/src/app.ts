import express, { type Express, type Request, type Response } from "express";
import pinoHttp from "pino-http";
import type { HealthResponse } from "@warden/shared";
import { logger } from "./logger.js";
import { mcpRouter } from "./mcp/route.js";
import type { UpstreamPool } from "./mcp/pool.js";

const startedAt = Date.now();
const VERSION = "0.0.0";

/** Everything the app needs from the outside world, passed in explicitly. */
export interface AppDeps {
  pool: UpstreamPool;
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

  app.use(mcpRouter(deps.pool));

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  return app;
}
