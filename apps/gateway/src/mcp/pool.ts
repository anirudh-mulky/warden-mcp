import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logger.js";
import { UPSTREAMS, type UpstreamConfig } from "./upstreams.js";

interface Upstream {
  config: UpstreamConfig;
  client: Client;
}

/**
 * Long-lived connections to every upstream MCP server.
 *
 * Each stdio upstream is a child process. Spawning one per request would
 * cost ~200ms of process startup on every single tool call, so we start
 * them once at boot and keep them. The pool is created before the HTTP
 * server starts listening — no request should ever arrive to find its
 * upstream missing.
 */
export class UpstreamPool {
  private readonly upstreams = new Map<string, Upstream>();

  /** Connect to every configured upstream. Called once, at startup. */
  async connectAll(): Promise<void> {
    for (const config of UPSTREAMS) {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
      });

      // The client identifies US to the upstream. Upstream servers can
      // log or behave differently per client, so be honest about who we are.
      const client = new Client({ name: "warden-gateway", version: "0.0.0" });

      await client.connect(transport);
      this.upstreams.set(config.namespace, { config, client });

      const server = client.getServerVersion();
      logger.info(
        { namespace: config.namespace, upstream: server?.name, version: server?.version },
        "connected to upstream",
      );
    }
  }

  /**
   * Every tool from every upstream, with its namespace prefixed.
   *
   * "echo" on the "everything" server becomes "everything.echo". Without
   * this, two upstreams both exposing "search" would collide and the
   * agent would have no way to say which one it meant.
   */
  async listTools(): Promise<Tool[]> {
    const all: Tool[] = [];
    for (const [namespace, { client }] of this.upstreams) {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        all.push({ ...tool, name: `${namespace}.${tool.name}` });
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

    return upstream.client.callTool({ name: toolName, arguments: args });
  }

  /** Shut every child process down cleanly. */
  async closeAll(): Promise<void> {
    for (const [namespace, { client }] of this.upstreams) {
      await client.close().catch((err: unknown) => {
        logger.warn({ namespace, err }, "error closing upstream");
      });
    }
    this.upstreams.clear();
  }
}
