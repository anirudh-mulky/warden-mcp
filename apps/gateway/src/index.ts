import type { ApiKeyId, TenantId } from "@warden/shared";
import { buildApp } from "./app.js";
import { DynamoKeyStore } from "./auth/dynamo-store.js";
import { hashApiKey } from "./auth/keys.js";
import type { KeyStore } from "./auth/store.js";
import { connectMongo, mongoClient } from "./db/mongo.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { UpstreamPool } from "./mcp/pool.js";
import { DynamoRateLimiter } from "./policy/rate-limit.js";
import { PolicyStore } from "./policy/store.js";
import { CallRecorder } from "./telemetry/recorder.js";

/**
 * Startup order matters: connect to everything FIRST, and only then start
 * accepting HTTP. If we listened first, a request arriving during startup
 * would fail with a confusing error. Be unavailable rather than broken.
 */
const collections = await connectMongo().catch((err: unknown) => {
  logger.fatal({ err }, "cannot reach MongoDB — is Docker running? (pnpm infra:up)");
  process.exit(1);
});

const pool = new UpstreamPool();
await pool.connectAll();

const keyStore = new DynamoKeyStore();
await seedDevKey(keyStore);

const recorder = new CallRecorder(collections.calls);
const app = buildApp({
  pool,
  keyStore,
  policies: new PolicyStore(collections.policies),
  rateLimiter: new DynamoRateLimiter(),
  recorder,
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "warden gateway listening");
});

/**
 * Development only: make sure the key in WARDEN_DEV_API_KEY exists, so you
 * always have one working key. Keys now live in DynamoDB and survive
 * restarts, so this must be idempotent — skip if it is already there.
 */
async function seedDevKey(store: KeyStore): Promise<void> {
  if (env.NODE_ENV !== "development") return;
  const devKey = env.WARDEN_DEV_API_KEY;
  if (devKey === undefined) {
    logger.warn("WARDEN_DEV_API_KEY is not set: create a key with `pnpm --filter @warden/gateway keys create`");
    return;
  }
  const hash = hashApiKey(devKey);
  if ((await store.findByHash(hash)) !== null) return;

  await store.put({
    id: "key_dev" as ApiKeyId,
    tenantId: "tenant_dev" as TenantId,
    name: "development key from .env",
    prefix: devKey.slice(0, 8),
    hash,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });
  // The prefix only — never the key itself.
  logger.info({ prefix: devKey.slice(0, 8), tenantId: "tenant_dev" }, "seeded development API key");
}

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  // Live-feed streams never end on their own; close them so server.close()
  // is not left waiting on them until the 10s timer fires.
  recorder.closeAll();
  server.close(async () => {
    await pool.closeAll();
    await mongoClient.close();
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
