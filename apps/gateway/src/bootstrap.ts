import type { Express } from "express";
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

export interface Warden {
  app: Express;
  recorder: CallRecorder;
  /** Stop upstream processes and close database connections. */
  close(): Promise<void>;
}

/**
 * Connects every dependency and builds the app. Shared by index.ts and the
 * integration test, so the test exercises exactly the production wiring.
 *
 * Order matters: connect to everything FIRST, so no request can arrive
 * before the gateway is able to answer it.
 */
export async function createWarden(): Promise<Warden> {
  const collections = await connectMongo().catch((err: unknown) => {
    logger.fatal({ err }, "cannot reach MongoDB — locally, is Docker running? (pnpm infra:up)");
    throw err;
  });

  const pool = new UpstreamPool();
  await pool.connectAll();

  const keyStore = new DynamoKeyStore();
  await seedDevKey(keyStore);

  const recorder = new CallRecorder(collections.calls);
  const app = buildApp({
    pool,
    keyStore,
    users: collections.users,
    policies: new PolicyStore(collections.policies),
    rateLimiter: new DynamoRateLimiter(),
    recorder,
  });

  return {
    app,
    recorder,
    async close() {
      await recorder.flush();
      await pool.closeAll();
      await mongoClient.close();
    },
  };
}

/**
 * Development only: make sure the key in WARDEN_DEV_API_KEY exists, so you
 * always have one working key. Idempotent — keys survive restarts.
 */
async function seedDevKey(store: KeyStore): Promise<void> {
  if (env.NODE_ENV !== "development") return;
  const devKey = env.WARDEN_DEV_API_KEY;
  if (devKey === undefined) return;

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
