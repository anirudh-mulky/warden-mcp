import type { Policy, TenantId } from "@warden/shared";

/**
 * The policy decision: may this tenant call this tool?
 *
 * Pure function — no I/O — so the most important logic in Warden can be
 * checked exhaustively without a database. Rate limiting is separate
 * (rate-limit.ts) because it needs shared state; this part needs none.
 */

export type Decision = { verdict: "allow" } | { verdict: "deny"; reason: string };

const ALLOW: Decision = { verdict: "allow" };

/** What a tenant gets before anyone has written a policy: everything, unlimited. */
export function defaultPolicy(tenantId: TenantId): Policy {
  return { tenantId, allow: [], deny: [], rateLimitPerMinute: null, updatedAt: new Date(0).toISOString() };
}

/** "*" = every tool; "fs.*" = every tool in the fs namespace; otherwise exact. */
export function matchesPattern(tool: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return tool.startsWith(pattern.slice(0, -1)); // "fs.*" -> "fs."
  return tool === pattern;
}

export function decide(policy: Policy, tool: string): Decision {
  // Deny is checked first and always wins, so an allowlist can never
  // accidentally re-open something that was explicitly blocked.
  const denyRule = policy.deny.find((pattern) => matchesPattern(tool, pattern));
  if (denyRule !== undefined) {
    return { verdict: "deny", reason: `blocked by policy: ${tool} matches deny rule "${denyRule}"` };
  }

  if (policy.allow.length > 0 && !policy.allow.some((pattern) => matchesPattern(tool, pattern))) {
    return { verdict: "deny", reason: `blocked by policy: ${tool} is not in this key's allowlist` };
  }

  return ALLOW;
}
