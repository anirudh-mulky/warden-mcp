import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import type { AuditEntry, TenantId } from "@warden/shared";
import { logger } from "../logger.js";

/**
 * The audit log: every change made through the dashboard — who, what, when.
 *
 * The call log answers "what did the agents do?"; this answers "who changed
 * the rules?". When a tool that should have been blocked wasn't, the first
 * question is whether someone loosened the policy, and this is where the
 * answer lives.
 */
export class AuditLog {
  constructor(private readonly entries: Collection<AuditEntry>) {}

  /** Fire-and-forget: a failed audit write is logged, never turned into a failed request. */
  record(tenantId: TenantId, actor: string, action: string, target: string, detail: string | null = null): void {
    const entry: AuditEntry = { id: randomUUID(), tenantId, actor, action, target, detail, at: new Date().toISOString() };
    this.entries.insertOne({ ...entry }).catch((err: unknown) => logger.error({ err, action }, "failed to write audit entry"));
  }

  async list(tenantId: TenantId, limit = 100): Promise<AuditEntry[]> {
    const docs = await this.entries.find({ tenantId }, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
    return docs as AuditEntry[];
  }
}
