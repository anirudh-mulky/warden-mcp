import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallRecord, Verdict } from "@warden/shared";
import type { Caller } from "../auth/middleware.js";
import { logger } from "../logger.js";
import { decide } from "../policy/engine.js";
import type { RateLimiter } from "../policy/rate-limit.js";
import type { PolicyStore } from "../policy/store.js";
import { hashArgs, type CallRecorder } from "../telemetry/recorder.js";
import type { UpstreamPool } from "./pool.js";

/** Everything the MCP handlers need, passed in (same pattern as AppDeps). */
export interface McpDeps {
  pool: UpstreamPool;
  policies: PolicyStore;
  rateLimiter: RateLimiter;
  recorder: CallRecorder;
}

/** What a denied, throttled or failed call returns: readable by the agent. */
function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Builds the MCP server that agents talk to, for ONE caller.
 *
 * Note this uses the low-level `Server`, not `McpServer`. `McpServer` is
 * for servers that own a fixed set of tools defined in code. Warden owns
 * no tools at all — it answers "what tools exist?" by asking its
 * upstreams at request time, then filtering by the caller's policy.
 */
export function buildMcpServer(deps: McpDeps, caller: Caller): Server {
  const { pool, policies, rateLimiter, recorder } = deps;

  const server = new Server(
    { name: "warden", version: "0.0.0" },
    // Declaring `tools: {}` tells the client "I support the tools/*
    // methods". Omit it and a well-behaved client will never even ask.
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const [tools, policy] = await Promise.all([pool.listTools(), policies.get(caller.tenantId)]);
    // Hide what the caller may not use, so the agent does not waste turns
    // on tools that will only be refused. tools/call still re-checks —
    // hiding a tool is a courtesy, not the security boundary.
    const visible = tools.filter((tool) => decide(policy, tool.name).verdict === "allow");
    logger.debug({ tenantId: caller.tenantId, total: tools.length, visible: visible.length }, "tools/list");
    return { tools: visible };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startedAt = Date.now();
    const separator = name.indexOf(".");
    const namespace = separator === -1 ? null : name.slice(0, separator);

    /** Log one line and record one call, whatever the outcome. */
    const finish = (verdict: Verdict, reason: string | null, upstreamId: string | null): void => {
      const record: ToolCallRecord = {
        id: randomUUID(),
        tenantId: caller.tenantId,
        apiKeyId: caller.apiKeyId,
        tool: name,
        upstreamId,
        argsHash: hashArgs(args),
        verdict,
        reason,
        latencyMs: Date.now() - startedAt,
        startedAt: new Date(startedAt).toISOString(),
      };
      const level = verdict === "allow" ? "info" : verdict === "error" ? "error" : "warn";
      logger[level](record, "tools/call");
      recorder.record(record);
    };

    // 1. Policy. If we cannot load it, refuse: failing CLOSED means an
    //    outage can never turn into "everything is allowed".
    let policy;
    try {
      policy = await policies.get(caller.tenantId);
    } catch (err) {
      logger.error({ err, tenantId: caller.tenantId }, "policy lookup failed");
      finish("error", "policy unavailable", null);
      return errorResult("Warden could not load this key's policy, so the call was refused. Try again shortly.");
    }

    const decision = decide(policy, name);
    if (decision.verdict === "deny") {
      finish("deny", decision.reason, null);
      return errorResult(decision.reason);
    }

    // 2. Rate limit. If the counter store is down we let the call through
    //    (fail OPEN) — a brief loss of limiting beats taking every tenant
    //    offline. Policy fails closed; limits fail open. A deliberate split.
    if (policy.rateLimitPerMinute !== null) {
      let allowed = true;
      try {
        allowed = await rateLimiter.take(caller.apiKeyId, policy.rateLimitPerMinute);
      } catch (err) {
        logger.warn({ err, apiKeyId: caller.apiKeyId }, "rate limiter unavailable, allowing call");
      }
      if (!allowed) {
        const reason = `rate limit: this key may make ${policy.rateLimitPerMinute} calls per minute`;
        finish("throttle", reason, null);
        return errorResult(`${reason}. Wait and retry.`);
      }
    }

    // 3. Forward to the upstream.
    try {
      const result = await pool.callTool(name, args);
      finish("allow", null, namespace);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish("error", message, namespace);
      // MCP convention: tool failures come back as a result with isError,
      // not as a JSON-RPC error, so the model gets to read why.
      return errorResult(message);
    }
  });

  return server;
}
