import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import type { ApiKeyId, Approval, TenantId } from "@warden/shared";

/**
 * Human-in-the-loop approvals.
 *
 * A call that needs approval creates a "pending" document, then WAITS —
 * holding the agent's request open — while it re-reads that document every
 * POLL_MS. A person approves or denies it in the dashboard, which flips the
 * status; the waiting call sees the change and carries on (or refuses).
 *
 * The decision lives in MongoDB rather than in memory, so approving works
 * even if the dashboard request lands on a different gateway instance from
 * the waiting call.
 *
 * The arguments are stored (masked) only so a human can judge the call, and
 * are removed as soon as it is decided or expires.
 */

const POLL_MS = 750;

export type Outcome = "approved" | "denied" | "expired";

export class ApprovalStore {
  constructor(private readonly approvals: Collection<Approval>) {}

  async create(tenantId: TenantId, apiKeyId: ApiKeyId, tool: string, args: unknown, timeoutMs: number): Promise<Approval> {
    const now = Date.now();
    const approval: Approval = {
      id: randomUUID(),
      tenantId,
      apiKeyId,
      tool,
      args,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
      decidedAt: null,
      decidedBy: null,
    };
    await this.approvals.insertOne({ ...approval });
    return approval;
  }

  /** Waits until a human decides or the approval expires. */
  async wait(approval: Approval, signal?: AbortSignal): Promise<Outcome> {
    const deadline = Date.parse(approval.expiresAt);
    while (Date.now() < deadline && signal?.aborted !== true) {
      const doc = await this.approvals.findOne({ id: approval.id }, { projection: { status: 1 } });
      if (doc?.status === "approved" || doc?.status === "denied") return doc.status;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    // Only flips it if nobody decided at the very last moment.
    const expired = await this.approvals.updateOne(
      { id: approval.id, status: "pending" },
      { $set: { status: "expired", decidedAt: new Date().toISOString() }, $unset: { args: "" } },
    );
    if (expired.modifiedCount === 1) return "expired";
    const doc = await this.approvals.findOne({ id: approval.id }, { projection: { status: 1 } });
    return doc?.status === "approved" ? "approved" : doc?.status === "denied" ? "denied" : "expired";
  }

  /**
   * Record a decision. Conditional on status "pending" and on the tenant, so
   * a decision can't be made twice, after expiry, or by another tenant.
   */
  async decide(tenantId: TenantId, id: string, outcome: "approved" | "denied", by: string): Promise<Approval | null> {
    return this.approvals.findOneAndUpdate(
      { id, tenantId, status: "pending", expiresAt: { $gt: new Date().toISOString() } },
      { $set: { status: outcome, decidedAt: new Date().toISOString(), decidedBy: by }, $unset: { args: "" } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  }

  /** Pending first (oldest first, so nothing waits at the bottom), then the latest decisions. */
  async list(tenantId: TenantId): Promise<{ pending: Approval[]; recent: Approval[] }> {
    const now = new Date().toISOString();
    const [pending, recent] = await Promise.all([
      this.approvals.find({ tenantId, status: "pending", expiresAt: { $gt: now } }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray(),
      this.approvals.find({ tenantId, status: { $ne: "pending" } }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(20).toArray(),
    ]);
    return { pending, recent };
  }

  async pendingCount(tenantId: TenantId): Promise<number> {
    return this.approvals.countDocuments({ tenantId, status: "pending", expiresAt: { $gt: new Date().toISOString() } });
  }
}
