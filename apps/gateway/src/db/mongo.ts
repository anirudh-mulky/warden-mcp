import { MongoClient, type Collection } from "mongodb";
import type { Policy, ToolCallRecord } from "@warden/shared";
import { env } from "../env.js";

/**
 * MongoDB holds the documents: tenant policies and the call log.
 * (DynamoDB holds the hot key-value data: API keys and rate counters.)
 *
 * Fail fast if Mongo is unreachable at boot: without policies Warden cannot
 * make correct decisions, so starting anyway would be starting broken.
 */
export interface MongoCollections {
  calls: Collection<ToolCallRecord>;
  policies: Collection<Policy>;
}

// 5s instead of the driver's 30s default, so a stopped Docker fails quickly.
export const mongoClient = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });

export async function connectMongo(): Promise<MongoCollections> {
  await mongoClient.connect();
  const db = mongoClient.db(); // the database named in MONGODB_URI ("warden")

  const calls = db.collection<ToolCallRecord>("calls");
  const policies = db.collection<Policy>("policies");

  // Indexes match the queries we actually run. createIndex is idempotent:
  // calling it on every boot is a no-op once the index exists.
  await calls.createIndex({ tenantId: 1, startedAt: -1 }); // "latest calls for tenant X"
  await policies.createIndex({ tenantId: 1 }, { unique: true }); // one policy per tenant

  return { calls, policies };
}
