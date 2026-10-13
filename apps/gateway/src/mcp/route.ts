import { Router, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { callerOf } from "../auth/middleware.js";
import { logger } from "../logger.js";
import { buildMcpServer } from "./server.js";
import type { UpstreamPool } from "./pool.js";

/**
 * The /mcp endpoint an agent points at.
 *
 * This runs in STATELESS mode: `sessionIdGenerator: undefined` means the
 * transport issues no session id, and we build a fresh Server and
 * transport for every request, then throw both away.
 *
 * That looks wasteful, and on a normal server it slightly is. We do it
 * because of Day 9: on AWS Lambda there is no "between requests" — each
 * invocation may land on a different machine with no memory of the last
 * one. Code that quietly relies on in-process session state works
 * beautifully on your laptop and falls apart the moment it scales past
 * one instance. Choosing statelessness now means no rewrite later.
 *
 * The expensive thing — the upstream child processes — lives in the
 * pool, which IS long-lived. Only the cheap per-request wrapper is
 * rebuilt.
 */
export function mcpRouter(pool: UpstreamPool): Router {
  const router = Router();

  router.post("/mcp", async (req: Request, res: Response) => {
    // requireApiKey ran before this handler (see app.ts), so the caller
    // is known. Each request's server is built for exactly one tenant.
    const server = buildMcpServer(pool, callerOf(res));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // If the client hangs up mid-request, tear both down or we leak.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      // express.json() already consumed the body, so hand it over
      // explicitly — the transport cannot re-read a used stream.
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "mcp request failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no server-initiated stream to open and no session
  // to delete, so answer these honestly instead of hanging.
  const notAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this endpoint is stateless" },
      id: null,
    });
  };
  router.get("/mcp", notAllowed);
  router.delete("/mcp", notAllowed);

  return router;
}
