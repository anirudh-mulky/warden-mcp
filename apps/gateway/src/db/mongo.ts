import { MongoClient, type Collection } from "mongodb";
import type { Approval, AuditEntry, Policy, TenantId, TenantSettings, TenantUpstream, ToolCallRecord } from "@warden/shared";
import { env } from "../env.js";

/**
 * MongoDB holds the documents: users, policies, the call log, approvals,
 * the audit log, alert settings and custom upstreams.
 * (DynamoDB holds the hot key-value data: API keys and rate counters.)
 *
 * Fail fast if Mongo is unreachable at boot: without policies Warden cannot
 * make correct decisions, so starting anyway would be starting broken.
 */

/** A dashboard account. Lives only in the backend — the hash never leaves it. */
export interface UserDoc {
  id: string;
  /** Lower-cased, so "A@x.com" and "a@x.com" are one account. */
  email: string;
  passwordHash: string;
  tenantId: TenantId;
  createdAt: string;
  /**
   * Bumped by "sign out everywhere". Every session token carries the version
   * it was issued under; a token with an old version is refused. Absent on
   * accounts created before this existed, which reads as 0.
   */
  sessionVersion?: number;
}

export interface MongoCollections {
  calls: Collection<ToolCallRecord>;
  policies: Collection<Policy>;
  users: Collection<UserDoc>;
  approvals: Collection<Approval>;
  audit: Collection<AuditEntry>;
  settings: Collection<TenantSettings>;
  upstreams: Collection<TenantUpstream>;
}

// 5s instead of the driver's 30s default, so a stopped Docker fails quickly.
export const mongoClient = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });

export async function connectMongo(): Promise<MongoCollections> {
  await mongoClient.connect();
  const db = mongoClient.db(); // the database named in MONGODB_URI ("warden")

  const c: MongoCollections = {
    calls: db.collection<ToolCallRecord>("calls"),
    policies: db.collection<Policy>("policies"),
    users: db.collection<UserDoc>("users"),
    approvals: db.collection<Approval>("approvals"),
    audit: db.collection<AuditEntry>("audit"),
    settings: db.collection<TenantSettings>("settings"),
    upstreams: db.collection<TenantUpstream>("upstreams"),
  };

  // Migration: policies used to be one per tenant (unique on tenantId).
  // Per-key overrides need uniqueness on (tenantId, apiKeyId) instead, and
  // the old index would refuse a second policy for the same tenant.
  await c.policies.dropIndex("tenantId_1").catch(() => undefined); // already gone = fine

  // Indexes match the queries we actually run. createIndex is idempotent.
  await Promise.all([
    c.calls.createIndex({ tenantId: 1, startedAt: -1 }),
    c.calls.createIndex({ tenantId: 1, verdict: 1, startedAt: -1 }), // blocked-spike alert count
    c.policies.createIndex({ tenantId: 1, apiKeyId: 1 }, { unique: true }),
    c.users.createIndex({ email: 1 }, { unique: true }),
    c.users.createIndex({ id: 1 }, { unique: true }),
    c.approvals.createIndex({ id: 1 }, { unique: true }),
    c.approvals.createIndex({ tenantId: 1, status: 1, createdAt: 1 }),
    c.audit.createIndex({ tenantId: 1, at: -1 }),
    c.settings.createIndex({ tenantId: 1 }, { unique: true }),
    c.upstreams.createIndex({ tenantId: 1, namespace: 1 }, { unique: true }),
  ]);

  return c;
}
