import { posix } from "node:path";
import type { ArgRule, Policy, TenantId } from "@warden/shared";

/**
 * The policy decision: may this caller make this call?
 *
 * Pure function — no I/O — so the most important logic in Warden can be
 * checked exhaustively without a database. Rate limiting and the actual
 * waiting-for-approval live elsewhere because they need shared state.
 *
 * Order (first match wins):
 *   1. deny list          — always wins
 *   2. allowlist          — if non-empty, the tool must be on it
 *   3. argument rules     — only when args are given (tools/call, not tools/list)
 *   4. approval list      — allowed, but a human must say yes first
 */

export type Decision = { verdict: "allow" } | { verdict: "approval" } | { verdict: "deny"; reason: string };

const ALLOW: Decision = { verdict: "allow" };

/** What a tenant (or key) gets before anyone has written a policy: everything, unlimited. */
export function defaultPolicy(tenantId: TenantId): Policy {
  return {
    tenantId,
    apiKeyId: null,
    allow: [],
    deny: [],
    rateLimitPerMinute: null,
    argRules: [],
    approval: [],
    redactSecrets: false,
    redactEmails: false,
    updatedAt: new Date(0).toISOString(),
  };
}

/** "*" = every tool; "fs.*" = every tool in the fs namespace; otherwise exact. */
export function matchesPattern(tool: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return tool.startsWith(pattern.slice(0, -1)); // "fs.*" -> "fs."
  return tool === pattern;
}

/** An argument as text: strings as-is, anything else as JSON, missing as "". */
function argText(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Is `target` outside `dir`? Both are normalised first, so "../" segments
 * are resolved before comparing: "/sandbox/public/../secret" is the path
 * "/sandbox/secret", which IS outside "/sandbox/public". A plain startsWith
 * check would wave that through. Relative paths count as outside, because
 * where they point depends on the upstream's working directory, not ours.
 */
export function isPathOutside(target: string, dir: string): boolean {
  if (!target.startsWith("/")) return true;
  const t = posix.normalize(target);
  const d = posix.normalize(dir).replace(/\/+$/, "") || "/";
  if (d === "/") return false;
  return !(t === d || t.startsWith(`${d}/`));
}

/** Does this rule fire (i.e. block) for these arguments? */
export function ruleBlocks(rule: ArgRule, args: Record<string, unknown>): boolean {
  const text = argText(args, rule.arg);
  switch (rule.op) {
    case "equals":
      return text === rule.value;
    case "contains":
      return text.includes(rule.value);
    case "startsWith":
      return text.startsWith(rule.value);
    case "notStartsWith":
      return !text.startsWith(rule.value);
    case "pathOutside":
      return isPathOutside(text, rule.value);
  }
}

const OP_WORDS: Record<ArgRule["op"], string> = {
  equals: "equals",
  contains: "contains",
  startsWith: "starts with",
  notStartsWith: "does not start with",
  pathOutside: "is outside",
};

export function describeRule(rule: ArgRule): string {
  return `argument "${rule.arg}" ${OP_WORDS[rule.op]} "${rule.value}"`;
}

/**
 * @param args The call's arguments, or undefined when deciding visibility for
 *             tools/list — argument rules can only judge an actual call.
 */
export function decide(policy: Policy, tool: string, args?: Record<string, unknown>): Decision {
  const denyRule = policy.deny.find((pattern) => matchesPattern(tool, pattern));
  if (denyRule !== undefined) {
    return { verdict: "deny", reason: `blocked by policy: ${tool} matches deny rule "${denyRule}"` };
  }

  if (policy.allow.length > 0 && !policy.allow.some((pattern) => matchesPattern(tool, pattern))) {
    return { verdict: "deny", reason: `blocked by policy: ${tool} is not in this key's allowlist` };
  }

  if (args !== undefined) {
    const fired = policy.argRules.find((rule) => matchesPattern(tool, rule.tool) && ruleBlocks(rule, args));
    if (fired !== undefined) {
      return { verdict: "deny", reason: `blocked by policy: ${tool} ${describeRule(fired)}` };
    }
  }

  if (policy.approval.some((pattern) => matchesPattern(tool, pattern))) return { verdict: "approval" };

  return ALLOW;
}
