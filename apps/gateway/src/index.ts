import type { ApiKeyId, TenantId } from "@warden/shared";
import { buildApp } from "./app.js";
import { hashApiKey } from "./auth/keys.js";
import { InMemoryKeyStore } from "./auth/store.js";
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

// In memory until STEP 6 swaps in DynamoDB. Memory is empty on every
// start, so in development we seed one fixed key from .env to test with.
const keyStore = new InMemoryKeyStore();

if (env.NODE_ENV === "development") {
  const devKey = env.WARDEN_DEV_API_KEY;
  if (devKey === undefined) {
    logger.warn("WARDEN_DEV_API_KEY is not set: every /mcp request will get 401");
  } else {
    await keyStore.put({
      id: "key_dev" as ApiKeyId,
      tenantId: "tenant_dev" as TenantId,
      name: "development key from .env",
      prefix: devKey.slice(0, 8),
      hash: hashApiKey(devKey),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    });
    // The prefix only — never the key itself.
    logger.info({ prefix: devKey.slice(0, 8), tenantId: "tenant_dev" }, "seeded development API key");
  }
}

const app = buildApp({ pool, keyStore });
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
