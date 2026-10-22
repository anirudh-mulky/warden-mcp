import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Collection } from "mongodb";
import type { TenantId, TenantUpstream } from "@warden/shared";
import { logger } from "../logger.js";
import { assertSafeUrl } from "../net/guard.js";

/**
 * Remote MCP servers that a tenant adds itself, over Streamable HTTP.
 *
 * Deliberately HTTP only. The built-in upstreams are local programs Warden
 * launches; letting any signed-up user add a *command* to launch would be
 * remote code execution on the gateway host. A URL is far safer — and it
 * still passes the SSRF guard, both when added and on every connect.
 *
 * Connections are opened on first use and cached per upstream id.
 */

const CONNECT_TIMEOUT_MS = 8_000;
/** After a failure, don't retry for this long — otherwise every tools/list waits out the timeout again. */
const RETRY_AFTER_MS = 30_000;

interface Live {
  client: Client | null;
  status: "connected" | "failed" | "connecting";
  error: string | null;
  toolCount: number | null;
  pending: Promise<Client> | null;
  failedAt: number | null;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
}

export class TenantUpstreams {
  private readonly live = new Map<string, Live>();

  constructor(private readonly upstreams: Collection<TenantUpstream>) {}

  async list(tenantId: TenantId): Promise<TenantUpstream[]> {
    return this.upstreams.find({ tenantId }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  }

  async add(tenantId: TenantId, namespace: string, url: string): Promise<TenantUpstream> {
    await assertSafeUrl(url);
    const upstream: TenantUpstream = { id: randomUUID(), tenantId, namespace, url, createdAt: new Date().toISOString() };
    await this.upstreams.insertOne({ ...upstream });
    return upstream;
  }

  async remove(tenantId: TenantId, id: string): Promise<boolean> {
    const r = await this.upstreams.deleteOne({ tenantId, id });
    const live = this.live.get(id);
    this.live.delete(id);
    await live?.client?.close().catch(() => undefined);
    return r.deletedCount === 1;
  }

  status(id: string): Pick<Live, "status" | "error" | "toolCount"> {
    const l = this.live.get(id);
    return l === undefined ? { status: "connecting", error: null, toolCount: null } : { status: l.status, error: l.error, toolCount: l.toolCount };
  }

  /** A connected client for this upstream, connecting (once) if needed. */
  private connect(u: TenantUpstream): Promise<Client> {
    const existing = this.live.get(u.id);
    if (existing?.client != null && existing.status === "connected") return Promise.resolve(existing.client);
    if (existing?.pending != null) return existing.pending;
    if (existing?.status === "failed" && existing.failedAt !== null && Date.now() - existing.failedAt < RETRY_AFTER_MS) {
      return Promise.reject(new Error(existing.error ?? `${u.namespace} is unavailable`));
    }

    const entry: Live = { client: null, status: "connecting", error: null, toolCount: existing?.toolCount ?? null, pending: null, failedAt: null };
    entry.pending = (async () => {
      const url = await assertSafeUrl(u.url);
      const client = new Client({ name: "warden-gateway", version: "0.0.0" });
      await withTimeout(client.connect(new StreamableHTTPClientTransport(url)), CONNECT_TIMEOUT_MS, `connecting to ${u.namespace}`);
      return client;
    })()
      .then((client) => {
        Object.assign(entry, { client, status: "connected", error: null, pending: null, failedAt: null });
        logger.info({ tenantId: u.tenantId, namespace: u.namespace }, "custom upstream connected");
        return client;
      })
      .catch((err: unknown) => {
        Object.assign(entry, { client: null, status: "failed", error: err instanceof Error ? err.message : String(err), pending: null, failedAt: Date.now() });
        logger.warn({ tenantId: u.tenantId, namespace: u.namespace, err }, "custom upstream failed");
        throw err;
      });
    this.live.set(u.id, entry);
    return entry.pending;
  }

  /** Tools from every custom upstream of this tenant, namespaced. A dead one contributes nothing. */
  async listTools(tenantId: TenantId): Promise<Tool[]> {
    const all: Tool[] = [];
    await Promise.all(
      (await this.list(tenantId)).map(async (u) => {
        try {
          const client = await this.connect(u);
          const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listing ${u.namespace} tools`);
          const entry = this.live.get(u.id);
          if (entry !== undefined) entry.toolCount = tools.length;
          for (const t of tools) all.push({ ...t, name: `${u.namespace}.${t.name}` });
        } catch (err) {
          const entry = this.live.get(u.id);
          if (entry !== undefined && entry.status !== "failed") {
            Object.assign(entry, { client: null, status: "failed", error: err instanceof Error ? err.message : String(err), failedAt: Date.now() });
          }
        }
      }),
    );
    return all;
  }

  /** The custom upstream behind this namespace for this tenant, or null if there is none. */
  async find(tenantId: TenantId, namespace: string): Promise<TenantUpstream | null> {
    return this.upstreams.findOne({ tenantId, namespace }, { projection: { _id: 0 } });
  }

  async callTool(u: TenantUpstream, toolName: string, args: Record<string, unknown> | undefined) {
    const client = await this.connect(u);
    return client.callTool({ name: toolName, arguments: args });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((l) => l.client?.close().catch(() => undefined)));
    this.live.clear();
  }
}
