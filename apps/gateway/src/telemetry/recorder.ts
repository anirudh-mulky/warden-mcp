import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Collection } from "mongodb";
import type { TenantId, ToolCallRecord, ToolStats } from "@warden/shared";
import { logger } from "../logger.js";

/**
 * Fingerprint of a call's arguments. We store this, never the arguments:
 * they may hold secrets or private file contents, but the hash still lets
 * you spot the same call being repeated.
 */
export function hashArgs(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex");
}

/**
 * Records every tools/call: persisted to MongoDB, and broadcast to anyone
 * watching the live feed.
 *
 * record() does NOT wait for the database. The agent's response must not be
 * slowed down by our bookkeeping, so the insert runs in the background and
 * a failure is logged rather than failing the call. (On AWS this would be
 * a queue; locally, a background insert gives the same property.)
 *
 * The live feed is an in-process EventEmitter, so it only sees calls served
 * by THIS process. Fine for one instance; several instances would need a
 * shared channel (e.g. Mongo change streams or Redis pub/sub).
 */
export class CallRecorder {
  private readonly events = new EventEmitter();

  constructor(private readonly calls: Collection<ToolCallRecord>) {
    // One listener per open dashboard tab; don't warn past the default of 10.
    this.events.setMaxListeners(0);
  }

  record(record: ToolCallRecord): void {
    this.events.emit("call", record);
    // A copy, because insertOne adds an _id to the object it is given.
    this.calls.insertOne({ ...record }).catch((err: unknown) => {
      logger.error({ err, callId: record.id }, "failed to persist call record");
    });
  }

  /** Subscribe to new calls. Returns the function that unsubscribes. */
  subscribe(listener: (record: ToolCallRecord) => void): () => void {
    this.events.on("call", listener);
    return () => this.events.off("call", listener);
  }

  /** Tell every live-feed connection to close, so shutdown is not held open. */
  closeAll(): void {
    this.events.emit("close");
  }

  onClose(listener: () => void): () => void {
    this.events.once("close", listener);
    return () => this.events.off("close", listener);
  }

  async recent(tenantId: TenantId, limit: number): Promise<ToolCallRecord[]> {
    const docs = await this.calls
      .find({ tenantId }, { projection: { _id: 0 } })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
    return docs as ToolCallRecord[];
  }

  /** Per-tool counts and latency percentiles over the tenant's last `window` calls. */
  async stats(tenantId: TenantId, window = 500): Promise<ToolStats[]> {
    const byTool = new Map<string, ToolCallRecord[]>();
    for (const call of await this.recent(tenantId, window)) {
      const list = byTool.get(call.tool) ?? [];
      list.push(call);
      byTool.set(call.tool, list);
    }

    return [...byTool.entries()]
      .map(([tool, calls]) => {
        // Latency only means something for calls that reached an upstream.
        const latencies = calls
          .filter((c) => c.verdict === "allow")
          .map((c) => c.latencyMs)
          .sort((a, b) => a - b);
        return {
          tool,
          calls: calls.length,
          allowed: calls.filter((c) => c.verdict === "allow").length,
          denied: calls.filter((c) => c.verdict === "deny").length,
          throttled: calls.filter((c) => c.verdict === "throttle").length,
          errors: calls.filter((c) => c.verdict === "error").length,
          p50Ms: percentile(latencies, 50),
          p95Ms: percentile(latencies, 95),
        };
      })
      .sort((a, b) => b.calls - a.calls);
  }
}

/** Nearest-rank percentile of an ascending list. Null for an empty list. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}
