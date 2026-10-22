import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Policy, ToolCallRecord, Verdict } from "@warden/shared";
import type { Alerter } from "../alerts/alerter.js";
import type { ApprovalStore } from "../approvals/store.js";
import type { Caller } from "../auth/middleware.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { decide } from "../policy/engine.js";
import type { RateLimiter } from "../policy/rate-limit.js";
import { redactToolResult, redactValue } from "../policy/redact.js";
import type { PolicyStore } from "../policy/store.js";
import { hashArgs, type CallRecorder } from "../telemetry/recorder.js";
import type { TenantUpstreams } from "../upstreams/tenant.js";
import type { UpstreamPool } from "./pool.js";

/** Everything the MCP handlers need, passed in (same pattern as AppDeps). */
export interface McpDeps {
  pool: UpstreamPool;
  tenantUpstreams: TenantUpstreams;
  policies: PolicyStore;
  rateLimiter: RateLimiter;
  recorder: CallRecorder;
  approvals: ApprovalStore;
  alerter: Alerter;
}

/** What a denied, throttled or failed call returns: readable by the agent. */
function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Built-in tools plus this tenant's own custom-upstream tools. */
export async function toolsFor(deps: Pick<McpDeps, "pool" | "tenantUpstreams">, caller: Pick<Caller, "tenantId">) {
  const [builtin, custom] = await Promise.all([deps.pool.listTools(), deps.tenantUpstreams.listTools(caller.tenantId)]);
  return [...builtin, ...custom];
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
  const { pool, tenantUpstreams, policies, rateLimiter, recorder, approvals, alerter } = deps;

  const server = new Server(
    { name: "warden", version: "0.0.0" },
    // Declaring `tools: {}` tells the client "I support the tools/*
    // methods". Omit it and a well-behaved client will never even ask.
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const [tools, policy] = await Promise.all([toolsFor(deps, caller), policies.get(caller.tenantId, caller.apiKeyId)]);
    // Hide what the caller may not use, so the agent does not waste turns
    // on tools that will only be refused. tools/call still re-checks —
    // hiding a tool is a courtesy, not the security boundary.
    const visible = tools.filter((tool) => decide(policy, tool.name).verdict !== "deny");
    logger.debug({ tenantId: caller.tenantId, total: tools.length, visible: visible.length }, "tools/list");
    return { tools: visible };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const startedAt = Date.now();
    const separator = name.indexOf(".");
    const namespace = separator === -1 ? null : name.slice(0, separator);
    let approval: ToolCallRecord["approval"];

    /** Log one line and record one call, whatever the outcome. */
    const finish = (verdict: Verdict, reason: string | null, upstreamId: string | null, redactions = 0): void => {
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
        ...(redactions > 0 ? { redactions } : {}),
        ...(approval !== undefined ? { approval } : {}),
      };
      const level = verdict === "allow" ? "info" : verdict === "error" ? "error" : "warn";
      logger[level](record, "tools/call");
      recorder.record(record);
      if (verdict === "deny") alerter.onBlocked(caller.tenantId);
    };

    // 1. Policy. If we cannot load it, refuse: failing CLOSED means an
    //    outage can never turn into "everything is allowed".
    let policy: Policy;
    try {
      policy = await policies.get(caller.tenantId, caller.apiKeyId);
    } catch (err) {
      logger.error({ err, tenantId: caller.tenantId }, "policy lookup failed");
      finish("error", "policy unavailable", null);
      return errorResult("Warden could not load this key's policy, so the call was refused. Try again shortly.");
    }

    const decision = decide(policy, name, args ?? {});
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
        allowed = await rateLimiter.take(`key:${caller.apiKeyId}`, policy.rateLimitPerMinute);
      } catch (err) {
        logger.warn({ err, apiKeyId: caller.apiKeyId }, "rate limiter unavailable, allowing call");
      }
      if (!allowed) {
        const reason = `rate limit: this key may make ${policy.rateLimitPerMinute} calls per minute`;
        finish("throttle", reason, null);
        return errorResult(`${reason}. Wait and retry.`);
      }
    }

    // 3. Human approval. The agent's request stays open while a person
    //    decides in the dashboard. Approval failing to work = refuse.
    if (decision.verdict === "approval") {
      try {
        const masked = redactValue(args ?? {}, { secrets: true, emails: false }).value;
        const pending = await approvals.create(caller.tenantId, caller.apiKeyId, name, masked, env.APPROVAL_TIMEOUT_MS);
        logger.info({ tenantId: caller.tenantId, tool: name, approvalId: pending.id }, "waiting for approval");
        approval = await approvals.wait(pending, extra.signal);
      } catch (err) {
        logger.error({ err }, "approval failed");
        approval = "expired";
      }
      if (approval !== "approved") {
        const reason = approval === "denied" ? "denied by a reviewer" : `approval timed out after ${env.APPROVAL_TIMEOUT_MS / 1000}s`;
        finish("deny", reason, null);
        return errorResult(`Warden refused this call: ${reason}.`);
      }
    }

    // 4. Forward — to a built-in upstream, or one of this tenant's own.
    try {
      const custom = namespace === null || pool.has(namespace) ? null : await tenantUpstreams.find(caller.tenantId, namespace);
      const raw = custom === null ? await pool.callTool(name, args) : await tenantUpstreams.callTool(custom, name.slice(separator + 1), args);

      // 5. Mask secrets in what the agent is about to read.
      const { result, count } = redactToolResult(raw, { secrets: policy.redactSecrets, emails: policy.redactEmails });
      finish("allow", null, custom?.namespace ?? namespace, count);
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
