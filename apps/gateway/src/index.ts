import { buildApp } from "./app.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { UpstreamPool } from "./mcp/pool.js";

/**
 * Startup order matters: connect to the upstreams FIRST, and only then
 * start accepting HTTP. If we listened first, a request arriving during
 * the two seconds it takes to spawn child processes would fail with a
 * confusing error. Be unavailable rather than broken.
 */
const pool = new UpstreamPool();
await pool.connectAll();

const app = buildApp({ pool });
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "warden gateway listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await pool.closeAll();
    logger.info("closed cleanly");
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("forced exit after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
