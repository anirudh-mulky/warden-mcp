import { createWarden } from "./bootstrap.js";
import { env } from "./env.js";
import { logger } from "./logger.js";

/** The gateway as a long-running server — via `pnpm dev`, or inside the Docker image. */
const warden = await createWarden().catch(() => process.exit(1));

const server = warden.app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "warden gateway listening");
});

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests
 * finish, then close upstreams and databases. The 10s timer is the escape
 * hatch so one hung request cannot block shutdown forever.
 */
function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await warden.close();
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
