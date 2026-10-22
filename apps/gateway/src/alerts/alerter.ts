import type { Collection } from "mongodb";
import type { SettingsInput, TenantId, TenantSettings, ToolCallRecord } from "@warden/shared";
import { logger } from "../logger.js";
import type { UpstreamPool } from "../mcp/pool.js";
import { assertSafeUrl } from "../net/guard.js";

/** Per-tenant alert settings in MongoDB. */
export class SettingsStore {
  constructor(private readonly settings: Collection<TenantSettings>) {}

  static defaults(tenantId: TenantId): TenantSettings {
    return {
      tenantId,
      webhookUrl: null,
      alertOnBlockedSpike: true,
      blockedSpikeThreshold: 10,
      alertOnUpstreamDown: true,
      updatedAt: new Date(0).toISOString(),
    };
  }

  async get(tenantId: TenantId): Promise<TenantSettings> {
    const doc = await this.settings.findOne({ tenantId }, { projection: { _id: 0 } });
    return doc === null ? SettingsStore.defaults(tenantId) : { ...SettingsStore.defaults(tenantId), ...doc };
  }

  async put(tenantId: TenantId, input: SettingsInput): Promise<TenantSettings> {
    const settings: TenantSettings = { tenantId, ...input, updatedAt: new Date().toISOString() };
    await this.settings.replaceOne({ tenantId }, { ...settings }, { upsert: true });
    return settings;
  }

  /** Every tenant that wants to hear about upstream outages. */
  async upstreamSubscribers(): Promise<TenantSettings[]> {
    return this.settings.find({ alertOnUpstreamDown: true, webhookUrl: { $ne: null } }, { projection: { _id: 0 } }).toArray();
  }
}

const SPIKE_WINDOW_MS = 5 * 60_000;
/** After an alert, stay quiet this long for the same tenant and kind, so a spike is one message, not fifty. */
const COOLDOWN_MS = 10 * 60_000;
const WATCH_MS = 30_000;

/**
 * Sends alerts to a tenant's webhook. The body carries both `content`
 * (Discord) and `text` (Slack), so either kind of incoming webhook works.
 */
export class Alerter {
  private readonly lastSent = new Map<string, number>();
  private readonly upstreamState = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly settings: SettingsStore,
    private readonly calls: Collection<ToolCallRecord>,
  ) {}

  /** POSTs one message. Throws on failure — callers decide whether that matters. */
  async send(webhookUrl: string, text: string, event: string, tenantId: TenantId): Promise<void> {
    const url = await assertSafeUrl(webhookUrl); // re-checked at send time, not only when saved
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, text, event, tenantId, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5_000),
      redirect: "error", // a redirect could bounce us to an internal address after the check
    });
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
  }

  private async sendOnce(tenantId: TenantId, kind: string, text: string, webhookUrl: string): Promise<void> {
    const key = `${tenantId}:${kind}`;
    const last = this.lastSent.get(key) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    this.lastSent.set(key, Date.now());
    try {
      await this.send(webhookUrl, text, kind, tenantId);
      logger.info({ tenantId, kind }, "alert sent");
    } catch (err) {
      logger.warn({ err, tenantId, kind }, "alert failed to send");
    }
  }

  /** Called after every blocked call. Cheap unless the tenant is actually spiking. */
  onBlocked(tenantId: TenantId): void {
    void (async () => {
      const s = await this.settings.get(tenantId);
      if (s.webhookUrl === null || !s.alertOnBlockedSpike) return;
      const since = new Date(Date.now() - SPIKE_WINDOW_MS).toISOString();
      const blocked = await this.calls.countDocuments({ tenantId, verdict: "deny", startedAt: { $gt: since } });
      if (blocked < s.blockedSpikeThreshold) return;
      await this.sendOnce(tenantId, "blocked-spike", `🚨 Warden: ${blocked} tool calls were blocked in the last 5 minutes (tenant ${tenantId}).`, s.webhookUrl);
    })().catch((err: unknown) => logger.warn({ err, tenantId }, "blocked-spike check failed"));
  }

  /** Every 30s, check the shared upstreams and tell subscribers when one goes down or comes back. */
  watchUpstreams(pool: UpstreamPool): void {
    for (const u of pool.health()) this.upstreamState.set(u.namespace, u.status);
    this.timer = setInterval(() => {
      void (async () => {
        await pool.listTools(); // refreshes health: a dead upstream is marked failed here
        for (const u of pool.health()) {
          const before = this.upstreamState.get(u.namespace);
          this.upstreamState.set(u.namespace, u.status);
          if (before === undefined || before === u.status) continue;
          const text =
            u.status === "failed"
              ? `🔴 Warden: upstream "${u.namespace}" is DOWN${u.error ? ` (${u.error})` : ""}. Its tools are unavailable.`
              : `🟢 Warden: upstream "${u.namespace}" is back.`;
          for (const s of await this.settings.upstreamSubscribers()) {
            if (s.webhookUrl !== null) await this.sendOnce(s.tenantId, `upstream-${u.namespace}-${u.status}`, text, s.webhookUrl);
          }
        }
      })().catch((err: unknown) => logger.warn({ err }, "upstream watch failed"));
    }, WATCH_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
