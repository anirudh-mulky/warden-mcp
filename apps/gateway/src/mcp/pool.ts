import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logger.js";
import { UPSTREAMS, type UpstreamConfig } from "./upstreams.js";

export type UpstreamStatus = "connected" | "failed";

export interface UpstreamHealth {
  id: string;
  namespace: string;
  status: UpstreamStatus;
  /** Present only when status is "failed". */
  error?: string;
  /** ISO timestamp of the last successful connect. */
  connectedAt?: string;
}

interface Upstream {
  config: UpstreamConfig;
  client: Client | null;
  status: UpstreamStatus;
  error?: string;
  connectedAt?: string;
}

/**
 * Long-lived connections to every upstream MCP server.
 *
 * Each stdio upstream is a child process, so we start them once at boot
 * and keep them rather than paying ~200ms of process startup per call.
 *
 * The important property of this class: a broken upstream degrades the
 * gateway, it never takes it down. Warden sits in front of N servers, so
 * being a single point of failure for all N would make it worse than no
 * gateway at all.
 */
export class UpstreamPool {
  private readonly upstreams = new Map<string, Upstream>();

  /**
   * Connect to every configured upstream. Called once, before the HTTP
   * server starts listening.
   *
   * Promise.allSettled, not Promise.all — that is the whole design in one
   * word. Promise.all rejects the moment any single promise rejects, so
   * one unreachable server would abort startup entirely. allSettled waits
   * for all of them and reports each outcome separately, letting us record
   * the failures and carry on with the ones that worked.
   */
  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(
      UPSTREAMS.map(async (config) => {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
        });
        const client = new Client({ name: "warden-gateway", version: "0.0.0" });
        await client.connect(transport);
        return { config, client };
      }),
    );

    results.forEach((result, index) => {
      const config = UPSTREAMS[index]!;

      if (result.status === "fulfilled") {
        const { client } = result.value;
        this.upstreams.set(config.namespace, {
          config,
          client,
          status: "connected",
          connectedAt: new Date().toISOString(),
        });
        const info = client.getServerVersion();
        logger.info(
          { namespace: config.namespace, upstream: info?.name, version: info?.version },
          "upstream connected",
        );
        return;
      }

      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      this.upstreams.set(config.namespace, { config, client: null, status: "failed", error });
      // Loud, because a silently missing upstream is a system that quietly
      // loses capabilities and nobody notices for a month.
      logger.error({ namespace: config.namespace, command: config.command, error }, "upstream failed to connect");
    });

    const healthy = [...this.upstreams.values()].filter((u) => u.status === "connected").length;
    logger.info({ healthy, total: this.upstreams.size }, "upstream pool ready");
  }

  /** Is this a built-in namespace? (Anything else may be a tenant's custom upstream.) */
  has(namespace: string): boolean {
    return this.upstreams.has(namespace);
  }

  /** What every upstream is doing right now. Rendered by GET /readyz. */
  health(): UpstreamHealth[] {
    return [...this.upstreams.values()].map((u) => ({
      id: u.config.id,
      namespace: u.config.namespace,
      status: u.status,
      ...(u.error === undefined ? {} : { error: u.error }),
      ...(u.connectedAt === undefined ? {} : { connectedAt: u.connectedAt }),
    }));
  }

  /**
   * Every tool from every HEALTHY upstream, namespace-prefixed.
   *
   * A dead upstream contributes nothing rather than throwing. The agent
   * ends up with a smaller toolbox and never knows the difference, which
   * is the correct outcome — it can still do the other three things it
   * came here to do.
   */
  async listTools(): Promise<Tool[]> {
    const all: Tool[] = [];

    for (const [namespace, upstream] of this.upstreams) {
      if (upstream.status !== "connected" || upstream.client === null) continue;

      try {
        const { tools } = await upstream.client.listTools();
        for (const tool of tools) {
          all.push({ ...tool, name: `${namespace}.${tool.name}` });
        }
      } catch (err) {
        // It answered the handshake at boot but is failing now. Mark it
        // down so /readyz tells the truth, and keep going.
        upstream.status = "failed";
        upstream.error = err instanceof Error ? err.message : String(err);
        upstream.client = null;
        logger.error({ namespace, err }, "upstream went down during tools/list");
      }
    }

    return all;
  }

  /**
   * Route a namespaced call to the right upstream, stripping the prefix
   * on the way out — the upstream has never heard of our namespaces.
   */
  async callTool(namespacedName: string, args: Record<string, unknown> | undefined) {
    const separator = namespacedName.indexOf(".");
    if (separator === -1) {
      throw new Error(`Tool name "${namespacedName}" is missing a namespace prefix`);
    }
    const namespace = namespacedName.slice(0, separator);
    const toolName = namespacedName.slice(separator + 1);

    const upstream = this.upstreams.get(namespace);
    if (!upstream) {
      throw new Error(`No upstream registered for namespace "${namespace}"`);
    }
    // Here we DO fail loudly. tools/list degrading silently is kind; a
    // tool call silently doing nothing would be a lie to the agent.
    if (upstream.status !== "connected" || upstream.client === null) {
      throw new Error(`Upstream "${namespace}" is unavailable: ${upstream.error ?? "not connected"}`);
    }

    return upstream.client.callTool({ name: toolName, arguments: args });
  }

  /** Shut every child process down cleanly. */
  async closeAll(): Promise<void> {
    for (const [namespace, upstream] of this.upstreams) {
      if (upstream.client === null) continue;
      await upstream.client.close().catch((err: unknown) => {
        logger.warn({ namespace, err }, "error closing upstream");
      });
    }
    this.upstreams.clear();
  }
}
