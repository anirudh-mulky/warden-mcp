import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logger.js";
import type { UpstreamPool } from "./pool.js";

/**
 * Builds the MCP server that agents talk to.
 *
 * Note this uses the low-level `Server`, not `McpServer`. `McpServer` is
 * for servers that own a fixed set of tools defined in code. Warden owns
 * no tools at all — it answers "what tools exist?" by asking its
 * upstreams at request time. That means handling the raw protocol
 * methods ourselves, which is exactly what a proxy should do.
 */
export function buildMcpServer(pool: UpstreamPool): Server {
  const server = new Server(
    { name: "warden", version: "0.0.0" },
    // Declaring `tools: {}` tells the client "I support the tools/*
    // methods". Omit it and a well-behaved client will never even ask.
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await pool.listTools();
    logger.debug({ count: tools.length }, "tools/list");
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startedAt = Date.now();

    // Day 5 puts the policy check right here, before the call is
    // forwarded. Today everything is allowed — this is the seam.

    try {
      const result = await pool.callTool(name, args);
      logger.info({ tool: name, latencyMs: Date.now() - startedAt, verdict: "allow" }, "tools/call");
      return result;
    } catch (err) {
      logger.error({ tool: name, latencyMs: Date.now() - startedAt, err }, "tools/call failed");
      // MCP convention: tool failures come back as a result with
      // isError, not as a JSON-RPC error. A protocol-level error means
      // "your request was malformed"; a failed tool is a valid request
      // with a bad outcome, and the model should get to read why.
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  return server;
}
