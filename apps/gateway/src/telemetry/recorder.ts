import { createHash } from "node:crypto";
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
 * Records every tools/call to MongoDB.
 *
 * record() does not make the MCP response wait for the insert: bookkeeping
 * must not slow the agent down. The insert runs in the background and a
 * failure is logged, never turned into a failed tool call.
 *
 * The recorder remembers unfinished inserts so that shutdown (and the
 * tests) can await flush() and lose nothing that was already accepted.
 */
export class CallRecorder {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly calls: Collection<ToolCallRecord>) {}

  record(record: ToolCallRecord): void {
    // A copy, because insertOne adds an _id to the object it is given.
    const write: Promise<void> = this.calls
      .insertOne({ ...record })
      .then(() => undefined)
      .catch((err: unknown) => {
        logger.error({ err, callId: record.id }, "failed to persist call record");
      })
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }

  /** Resolves once every insert started so far has finished. */
  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }

  /**
   * Newest first. With `since`, only calls that started after it — the
   * dashboard polls with the newest timestamp it has. ISO-8601 strings in
   * one format sort the same as the times they represent, so a string
   * comparison is a time comparison.
   */
  async recent(tenantId: TenantId, limit: number, since?: string): Promise<ToolCallRecord[]> {
    const filter = since === undefined ? { tenantId } : { tenantId, startedAt: { $gt: since } };
    const docs = await this.calls
      .find(filter, { projection: { _id: 0 } })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
    return docs as ToolCallRecord[];
  }

  /** Calls between two ISO times (either may be open), newest first — for export. */
  async range(tenantId: TenantId, from: string | undefined, to: string | undefined, limit: number): Promise<ToolCallRecord[]> {
    const startedAt: Record<string, string> = {};
    if (from !== undefined) startedAt.$gte = from;
    if (to !== undefined) startedAt.$lte = to;
    const filter = Object.keys(startedAt).length === 0 ? { tenantId } : { tenantId, startedAt };
    const docs = await this.calls.find(filter, { projection: { _id: 0 } }).sort({ startedAt: -1 }).limit(limit).toArray();
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
        // Latency only means something for calls that reached an upstream —
        // and NOT for approved calls, whose time is mostly a human deciding.
        // Mixing those in would make a fast gateway look seconds slow.
        const latencies = calls
          .filter((c) => c.verdict === "allow" && c.approval === undefined)
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
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}
