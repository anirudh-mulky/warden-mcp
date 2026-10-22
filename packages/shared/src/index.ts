/**
 * Domain types shared by the gateway and the dashboard.
 *
 * Nothing in this package may import from Node, Express, React or any
 * database driver. It is pure vocabulary: the words both sides of the
 * system agree to use. Keeping it dependency-free is what lets the
 * browser bundle import it without dragging the server in.
 */

/** What the gateway decided to do with a single tool call. */
export type Verdict = "allow" | "deny" | "throttle" | "error";

/** Stable identifiers. Branded so a TenantId can never be passed where an ApiKeyId belongs. */
export type TenantId = string & { readonly __brand: "TenantId" };
export type ApiKeyId = string & { readonly __brand: "ApiKeyId" };

/**
 * An API key as the outside world may see it.
 *
 * Deliberately has no hash and no secret. The dashboard renders this type,
 * so anything on it can end up in a browser. The gateway's stored record
 * extends it with the hash; that extension never leaves the backend.
 */
export interface ApiKey {
  id: ApiKeyId;
  tenantId: TenantId;
  /** Human label, e.g. "cursor on my laptop". */
  name: string;
  /** First characters of the key, e.g. "wdn_4f9a". Enough to recognise it, useless to an attacker. */
  prefix: string;
  createdAt: string;
  /** Null while the key works. Set instead of deleting, so the audit log keeps pointing at something. */
  revokedAt: string | null;
  /** After this moment the key stops working on its own. Null = never expires. */
  expiresAt: string | null;
}

/**
 * One line in the call log: everything we know about a single tools/call.
 * This is the object the dashboard renders, so its shape is a contract.
 */
export interface ToolCallRecord {
  id: string;
  tenantId: TenantId;
  apiKeyId: ApiKeyId;
  /** Namespaced tool name as the agent asked for it, e.g. "fs.write_file". */
  tool: string;
  /** Which upstream it was routed to, or null if we denied it before routing. */
  upstreamId: string | null;
  /** SHA-256 of the arguments. We store the fingerprint, never the arguments. */
  argsHash: string;
  verdict: Verdict;
  /** Human-readable reason, shown in the dashboard. Null when simply allowed. */
  reason: string | null;
  /** Round-trip time in milliseconds, measured at the gateway (includes any wait for approval). */
  latencyMs: number;
  /** ISO-8601 timestamp. Strings, not Dates — these cross a JSON boundary. */
  startedAt: string;
  /** How many secrets were masked in the result before it reached the agent. Absent on old records. */
  redactions?: number;
  /** Set when the call needed a human decision. Absent when it did not. */
  approval?: "approved" | "denied" | "expired";
}

/** Operators for argument rules. */
export type ArgOp = "equals" | "contains" | "startsWith" | "notStartsWith" | "pathOutside";

/**
 * "Block <tool> when argument <arg> <op> <value>". For example:
 *   { tool: "fs.write_file", arg: "path", op: "pathOutside", value: "/app/sandbox/public" }
 * blocks any write outside that folder, including sneaky "../" escapes.
 */
export interface ArgRule {
  tool: string;
  arg: string;
  op: ArgOp;
  value: string;
}

/**
 * The rules for a tenant — or, when apiKeyId is set, an override for one key.
 *
 * Tool patterns: "*" matches every tool, "fs.*" every tool in the fs
 * namespace, anything else the namespaced tool name exactly.
 */
export interface Policy {
  tenantId: TenantId;
  /** Null for the tenant-wide default; a key id for that key's own policy. */
  apiKeyId: ApiKeyId | null;
  /** If non-empty, ONLY tools matching one of these may be called. Empty = all tools. */
  allow: string[];
  /** Tools matching any of these are always refused. Deny beats allow. */
  deny: string[];
  /** Max tools/call per API key per minute. null = unlimited. */
  rateLimitPerMinute: number | null;
  /** Content-aware rules on a call's arguments. */
  argRules: ArgRule[];
  /** Tools matching these wait for a human to approve each call in the dashboard. */
  approval: string[];
  /** Mask API keys, tokens and private keys in tool results before the agent sees them. */
  redactSecrets: boolean;
  /** Also mask email addresses in tool results. */
  redactEmails: boolean;
  updatedAt: string;
}

/** The editable part of a Policy, as sent by the dashboard. */
export type PolicyInput = Pick<Policy, "allow" | "deny" | "rateLimitPerMinute" | "argRules" | "approval" | "redactSecrets" | "redactEmails">;

/** A policy as the dashboard sees it: the stored one, and whether it is a per-key override. */
export interface PolicyView {
  policy: Policy;
  /** True when this key has its own policy; false when it inherits the tenant default. */
  isOverride: boolean;
}

/** Per-tool summary over a tenant's recent calls. Latencies are measured, never estimated. */
export interface ToolStats {
  tool: string;
  calls: number;
  allowed: number;
  denied: number;
  throttled: number;
  errors: number;
  /** Over allowed calls only. Null when there are none to measure. */
  p50Ms: number | null;
  p95Ms: number | null;
}

/** One upstream tool, and what the effective policy says about it (argument rules aside). */
export interface ToolInfo {
  name: string;
  description: string;
  /** "approval" = allowed, but each call waits for a human. */
  verdict: "allow" | "deny" | "approval";
  /** Why it is denied. Null otherwise. */
  reason: string | null;
}

/** A call waiting for (or past) a human decision. */
export interface Approval {
  id: string;
  tenantId: TenantId;
  apiKeyId: ApiKeyId;
  tool: string;
  /** The call's arguments with secrets masked, so a human can judge it. Deleted once decided. */
  args: unknown;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** One change made through the dashboard: who did what, when. */
export interface AuditEntry {
  id: string;
  tenantId: TenantId;
  actor: string;
  action: string;
  target: string;
  detail: string | null;
  at: string;
}

/** Per-tenant alert settings. */
export interface TenantSettings {
  tenantId: TenantId;
  /** Where alerts are POSTed (Discord and Slack webhooks both work). Null = alerts off. */
  webhookUrl: string | null;
  alertOnBlockedSpike: boolean;
  /** Blocked calls within 5 minutes that count as a spike. */
  blockedSpikeThreshold: number;
  alertOnUpstreamDown: boolean;
  updatedAt: string;
}

export type SettingsInput = Pick<TenantSettings, "webhookUrl" | "alertOnBlockedSpike" | "blockedSpikeThreshold" | "alertOnUpstreamDown">;

/** A remote MCP server a tenant added itself, reached over Streamable HTTP. */
export interface TenantUpstream {
  id: string;
  tenantId: TenantId;
  /** Prefix for its tools, e.g. "github" -> "github.create_issue". */
  namespace: string;
  url: string;
  createdAt: string;
}

/** An upstream as the dashboard lists it, with live status. */
export interface UpstreamView {
  id: string;
  namespace: string;
  /** "builtin" = shared by every tenant; "custom" = added by this tenant. */
  kind: "builtin" | "custom";
  url: string | null;
  status: "connected" | "failed" | "connecting";
  error: string | null;
  toolCount: number | null;
}

/** The signed-in dashboard user, as returned by /api/me. Never includes the password hash. */
export interface Me {
  email: string;
  tenantId: TenantId;
}

/** Response to creating a key: the full key appears here once and never again. */
export interface CreatedApiKey {
  key: string;
  apiKey: ApiKey;
}

/** Shape of GET /healthz. */
export interface HealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  uptimeSeconds: number;
}

/** One upstream MCP server's current state, as reported by GET /readyz. */
export interface UpstreamHealthView {
  id: string;
  namespace: string;
  status: "connected" | "failed";
  error?: string;
  connectedAt?: string;
}

/**
 * Shape of GET /readyz — the honest answer to "can this gateway actually
 * serve traffic, and with what?". Distinct from /healthz, which only says
 * whether the process is alive.
 */
export interface ReadyResponse {
  status: "ready" | "degraded" | "unavailable";
  upstreams: UpstreamHealthView[];
}
