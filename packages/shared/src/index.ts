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

/** One customer account. Every key, upstream and call record belongs to exactly one. */
export interface Tenant {
  id: TenantId;
  name: string;
  createdAt: string;
}

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
}

/** An upstream MCP server that Warden proxies to. */
export interface UpstreamServer {
  id: string;
  tenantId: TenantId;
  /** Prefix applied to this server's tools, e.g. "github" -> "github.create_issue". */
  namespace: string;
  /** Where the real MCP server lives. */
  url: string;
  enabled: boolean;
}

/**
 * One line in the audit log: everything we know about a single tools/call.
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
  /** Round-trip time in milliseconds, measured at the gateway. */
  latencyMs: number;
  /** ISO-8601 timestamp. Strings, not Dates — these cross a JSON boundary. */
  startedAt: string;
}

/**
 * A tenant's rules. Evaluated on every tools/list and tools/call.
 *
 * Patterns: "*" matches every tool, "fs.*" matches every tool in the fs
 * namespace, anything else must match the namespaced tool name exactly.
 */
export interface Policy {
  tenantId: TenantId;
  /** If non-empty, ONLY tools matching one of these may be called. Empty = all tools. */
  allow: string[];
  /** Tools matching any of these are always refused. Deny beats allow. */
  deny: string[];
  /** Max tools/call per API key per minute. null = unlimited. */
  rateLimitPerMinute: number | null;
  updatedAt: string;
}

/** The editable part of a Policy, as sent by the dashboard. */
export type PolicyInput = Pick<Policy, "allow" | "deny" | "rateLimitPerMinute">;

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

/** One upstream tool, and what the tenant's current policy says about it. */
export interface ToolInfo {
  name: string;
  description: string;
  /** "allow" or "deny" under the current policy (rate limits not included). */
  verdict: "allow" | "deny";
  /** Why it is denied. Null when allowed. */
  reason: string | null;
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

/** Shape of GET /healthz. Trivial now; it will grow dependency checks. */
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
