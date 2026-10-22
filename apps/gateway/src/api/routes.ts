import { Router, type Request, type Response } from "express";
import type { Collection } from "mongodb";
import { z } from "zod";
import type { ApiKeyId, CreatedApiKey, Me, Policy, PolicyInput, PolicyView, SettingsInput, ToolCallRecord, ToolInfo, UpstreamView } from "@warden/shared";
import type { Alerter, SettingsStore } from "../alerts/alerter.js";
import type { ApprovalStore } from "../approvals/store.js";
import type { AuditLog } from "../audit/log.js";
import { generateApiKey, newApiKeyId } from "../auth/keys.js";
import { endSession, userOf } from "../auth/session.js";
import { toPublicKey, type KeyAdmin } from "../auth/store.js";
import type { UserDoc } from "../db/mongo.js";
import { toolsFor } from "../mcp/server.js";
import type { UpstreamPool } from "../mcp/pool.js";
import { UnsafeUrlError, assertSafeUrl } from "../net/guard.js";
import { decide, describeRule } from "../policy/engine.js";
import type { PolicyStore } from "../policy/store.js";
import type { CallRecorder } from "../telemetry/recorder.js";
import type { TenantUpstreams } from "../upstreams/tenant.js";

/**
 * The dashboard's API. Mounted behind requireSession (see app.ts), so every
 * handler knows the signed-in user, and every query is scoped to that
 * user's tenant — one tenant can never read another's calls, keys or policy.
 * Every change is written to the audit log.
 */
export interface ApiDeps {
  policies: PolicyStore;
  recorder: CallRecorder;
  keyStore: KeyAdmin;
  pool: UpstreamPool;
  tenantUpstreams: TenantUpstreams;
  approvals: ApprovalStore;
  audit: AuditLog;
  settings: SettingsStore;
  alerter: Alerter;
  users: Collection<UserDoc>;
}

/* --------------------------------------------------------------- schemas */

/** "*", "fs.*", or an exact namespaced tool name. Nothing exotic. */
const pattern = z.string().regex(/^(\*|[A-Za-z0-9_-]+\.(\*|[A-Za-z0-9_.-]+))$/, "use *, ns.*, or ns.tool");

const argRule = z.object({
  tool: pattern,
  arg: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "argument names are letters, digits and _"),
  op: z.enum(["equals", "contains", "startsWith", "notStartsWith", "pathOutside"]),
  value: z.string().min(1).max(500),
});

const policyInput = z.object({
  allow: z.array(pattern).max(100),
  deny: z.array(pattern).max(100),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).nullable(),
  argRules: z.array(argRule).max(50).default([]),
  approval: z.array(pattern).max(100).default([]),
  redactSecrets: z.boolean().default(false),
  redactEmails: z.boolean().default(false),
});

const newKey = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
});

const settingsInput = z.object({
  webhookUrl: z.string().trim().url().max(500).nullable(),
  alertOnBlockedSpike: z.boolean(),
  blockedSpikeThreshold: z.number().int().min(1).max(10_000),
  alertOnUpstreamDown: z.boolean(),
});

const newUpstream = z.object({
  namespace: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "2-31 lowercase letters, digits or -, starting with a letter"),
  url: z.string().trim().url().max(500),
});

/* --------------------------------------------------------------- helpers */

function bad(res: Response, err: z.ZodError) {
  res.status(400).json({ error: "invalid", message: z.prettifyError(err) });
}

/** A short, human summary of what a policy save changed — for the audit log. */
function policyDiff(before: Policy, after: Policy): string {
  const parts: string[] = [];
  const list = (a: string[], b: string[], what: string) => {
    for (const x of b.filter((v) => !a.includes(v))) parts.push(`+${what} ${x}`);
    for (const x of a.filter((v) => !b.includes(v))) parts.push(`-${what} ${x}`);
  };
  list(before.deny, after.deny, "block");
  list(before.allow, after.allow, "allow-only");
  list(before.approval, after.approval, "approval");
  list(before.argRules.map(describeRule), after.argRules.map(describeRule), "rule");
  if (before.rateLimitPerMinute !== after.rateLimitPerMinute) parts.push(`rate limit ${before.rateLimitPerMinute ?? "none"} → ${after.rateLimitPerMinute ?? "none"}`);
  if (before.redactSecrets !== after.redactSecrets) parts.push(`secret masking ${after.redactSecrets ? "on" : "off"}`);
  if (before.redactEmails !== after.redactEmails) parts.push(`email masking ${after.redactEmails ? "on" : "off"}`);
  return parts.length === 0 ? "no change" : parts.join(", ");
}

/**
 * One CSV cell. Quotes anything with a comma, quote or newline, and defuses
 * "formula injection": a cell beginning with = + - @ is executed by
 * spreadsheet apps when the file is opened, so it gets a leading quote.
 */
function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function apiRouter(deps: ApiDeps): Router {
  const router = Router();

  /** ?key=<id> → that key, if it belongs to the signed-in tenant. undefined = tenant default. null = not yours. */
  const keyScope = async (req: Request, res: Response): Promise<ApiKeyId | undefined | null> => {
    const raw = req.query.key;
    if (typeof raw !== "string" || raw === "") return undefined;
    const keys = await deps.keyStore.listByTenant(userOf(res).tenantId);
    return keys.some((k) => k.id === raw) ? (raw as ApiKeyId) : null;
  };

  /* ---------------------------------------------------------- account */

  router.get("/api/me", (_req: Request, res: Response) => {
    const { email, tenantId } = userOf(res);
    const me: Me = { email, tenantId };
    res.json(me);
  });

  /** Kills every session for this account, including this one. */
  router.post("/api/auth/logout-all", async (_req: Request, res: Response) => {
    const user = userOf(res);
    await deps.users.updateOne({ id: user.userId }, { $inc: { sessionVersion: 1 } });
    deps.audit.record(user.tenantId, user.email, "session.revoke-all", user.email);
    endSession(res);
    res.status(204).end();
  });

  /* ------------------------------------------------------------ calls */

  /** Recent calls, newest first. `?since=<ISO time>` returns only newer ones — the dashboard polls with it. */
  router.get("/api/calls", async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const since = typeof req.query.since === "string" && !Number.isNaN(Date.parse(req.query.since)) ? req.query.since : undefined;
    res.json(await deps.recorder.recent(userOf(res).tenantId, limit, since));
  });

  /** The call log as a download: ?format=csv|json&from=<ISO>&to=<ISO>, at most 10,000 rows. */
  router.get("/api/calls/export", async (req: Request, res: Response) => {
    const { tenantId, email } = userOf(res);
    const format = req.query.format === "json" ? "json" : "csv";
    const from = typeof req.query.from === "string" && !Number.isNaN(Date.parse(req.query.from)) ? new Date(req.query.from).toISOString() : undefined;
    const to = typeof req.query.to === "string" && !Number.isNaN(Date.parse(req.query.to)) ? new Date(req.query.to).toISOString() : undefined;
    const rows = await deps.recorder.range(tenantId, from, to, 10_000);
    deps.audit.record(tenantId, email, "calls.export", `${rows.length} calls as ${format}`);

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    res.set("Content-Disposition", `attachment; filename="warden-calls-${stamp}.${format}"`);
    if (format === "json") {
      res.type("application/json").send(JSON.stringify(rows, null, 2));
      return;
    }
    const cols: (keyof ToolCallRecord)[] = ["startedAt", "tool", "verdict", "reason", "latencyMs", "apiKeyId", "upstreamId", "redactions", "approval", "argsHash", "id"];
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
    res.type("text/csv").send(csv);
  });

  router.get("/api/stats", async (_req: Request, res: Response) => {
    res.json(await deps.recorder.stats(userOf(res).tenantId));
  });

  /* ----------------------------------------------------------- policy */

  /**
   * Every tool the tenant can reach (built-in + custom), with what the
   * effective policy for the chosen scope says about it — using the very
   * same decide() as tools/call, so the dashboard can never disagree with
   * the gateway.
   */
  router.get("/api/tools", async (req: Request, res: Response) => {
    const { tenantId } = userOf(res);
    const key = await keyScope(req, res);
    if (key === null) {
      res.status(404).json({ error: "not_found", message: "No such key." });
      return;
    }
    const [tools, policy] = await Promise.all([toolsFor(deps, { tenantId }), deps.policies.get(tenantId, key)]);
    const view: ToolInfo[] = tools
      .map((tool) => {
        const d = decide(policy, tool.name);
        return { name: tool.name, description: tool.description ?? "", verdict: d.verdict, reason: d.verdict === "deny" ? d.reason : null };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(view);
  });

  router.get("/api/policy", async (req: Request, res: Response) => {
    const { tenantId } = userOf(res);
    const key = await keyScope(req, res);
    if (key === null) {
      res.status(404).json({ error: "not_found", message: "No such key." });
      return;
    }
    const exact = key === undefined ? null : await deps.policies.getExact(tenantId, key);
    const view: PolicyView = exact !== null ? { policy: exact, isOverride: true } : { policy: await deps.policies.get(tenantId), isOverride: false };
    res.json(view);
  });

  router.put("/api/policy", async (req: Request, res: Response) => {
    const { tenantId, email } = userOf(res);
    const key = await keyScope(req, res);
    if (key === null) {
      res.status(404).json({ error: "not_found", message: "No such key." });
      return;
    }
    const parsed = policyInput.safeParse(req.body);
    if (!parsed.success) {
      bad(res, parsed.error);
      return;
    }
    const before = await deps.policies.get(tenantId, key);
    const input: PolicyInput = parsed.data;
    const saved = await deps.policies.put(tenantId, key ?? null, input);
    deps.audit.record(tenantId, email, "policy.update", key === undefined ? "default policy" : `key ${key}`, policyDiff(before, saved));
    const view: PolicyView = { policy: saved, isOverride: key !== undefined };
    res.json(view);
  });

  /** Remove a key's override, so it inherits the tenant default again. */
  router.delete("/api/policy", async (req: Request, res: Response) => {
    const { tenantId, email } = userOf(res);
    const key = await keyScope(req, res);
    if (key === null || key === undefined) {
      res.status(400).json({ error: "invalid", message: "Pass ?key=<id> to remove that key's override." });
      return;
    }
    const removed = await deps.policies.removeOverride(tenantId, key);
    if (removed) deps.audit.record(tenantId, email, "policy.reset", `key ${key}`, "now uses the default policy");
    res.status(removed ? 204 : 404).end();
  });

  /* ------------------------------------------------------------- keys */

  router.get("/api/keys", async (_req: Request, res: Response) => {
    const keys = await deps.keyStore.listByTenant(userOf(res).tenantId);
    res.json(keys.map(toPublicKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });

  router.post("/api/keys", async (req: Request, res: Response) => {
    const { tenantId, email } = userOf(res);
    const parsed = newKey.safeParse(req.body);
    if (!parsed.success) {
      bad(res, parsed.error);
      return;
    }
    const { key, prefix, hash } = generateApiKey();
    const now = Date.now();
    const stored = {
      id: newApiKeyId(),
      tenantId,
      name: parsed.data.name,
      prefix,
      hash,
      createdAt: new Date(now).toISOString(),
      revokedAt: null,
      expiresAt: parsed.data.expiresInDays === null ? null : new Date(now + parsed.data.expiresInDays * 86_400_000).toISOString(),
    };
    await deps.keyStore.put(stored);
    deps.audit.record(tenantId, email, "key.create", `${stored.name} (${stored.id})`, stored.expiresAt === null ? "never expires" : `expires ${stored.expiresAt.slice(0, 10)}`);
    // The one and only time the full key leaves the server.
    const created: CreatedApiKey = { key, apiKey: toPublicKey(stored) };
    res.status(201).json(created);
  });

  router.delete("/api/keys/:id", async (req: Request, res: Response) => {
    const { tenantId, email } = userOf(res);
    const revoked = await deps.keyStore.revoke(req.params.id as ApiKeyId, new Date().toISOString(), tenantId);
    if (revoked) deps.audit.record(tenantId, email, "key.revoke", String(req.params.id));
    // 404 whether it does not exist or belongs to someone else: don't confirm other tenants' key ids.
    res.status(revoked ? 204 : 404).end();
  });

  /* -------------------------------------------------------- approvals */

  router.get("/api/approvals", async (_req: Request, res: Response) => {
    res.json(await deps.approvals.list(userOf(res).tenantId));
  });

  router.get("/api/approvals/count", async (_req: Request, res: Response) => {
    res.json({ pending: await deps.approvals.pendingCount(userOf(res).tenantId) });
  });

  router.post("/api/approvals/:id", async (req: Request, res: Response) => {
    const { tenantId, email } = userOf(res);
    const decision = req.body?.decision;
    if (decision !== "approved" && decision !== "denied") {
      res.status(400).json({ error: "invalid", message: 'decision must be "approved" or "denied"' });
      return;
    }
    const updated = await deps.approvals.decide(tenantId, String(req.params.id), decision, email);
    if (updated === null) {
      res.status(409).json({ error: "conflict", message: "Already decided or expired." });
      return;
    }
    deps.audit.record(tenantId, email, decision === "approved" ? "approval.approve" : "approval.deny", updated.tool);
    res.json(updated);
  });

  /* ------------------------------------------------------------ audit */

  router.get("/api/audit", async (_req: Request, res: Response) => {
    res.json(await deps.audit.list(userOf(res).tenantId));
  });

  /* --------------------------------------------------------- settings */

  router.get("/api/settings", async (_req: Request, res: Response) => {
    res.json(await deps.settings.get(userOf(res).tenantId));
  });

  router.put("/api/settings", async (req: Request, res: Response) => {
    const { tenantId, email } = userOf(res);
    const parsed = settingsInput.safeParse(req.body);
    if (!parsed.success) {
      bad(res, parsed.error);
      return;
    }
    const input: SettingsInput = parsed.data;
    if (input.webhookUrl !== null) {
      try {
        await assertSafeUrl(input.webhookUrl);
      } catch (err) {
        res.status(400).json({ error: "unsafe_url", message: err instanceof UnsafeUrlError ? err.message : "That URL cannot be used." });
        return;
      }
    }
    const saved = await deps.settings.put(tenantId, input);
    deps.audit.record(tenantId, email, "settings.update", "alerts", input.webhookUrl === null ? "webhook removed" : `webhook ${new URL(input.webhookUrl).host}`);
    res.json(saved);
  });

  router.post("/api/settings/test", async (_req: Request, res: Response) => {
    const { tenantId } = userOf(res);
    const s = await deps.settings.get(tenantId);
    if (s.webhookUrl === null) {
      res.status(400).json({ error: "invalid", message: "Save a webhook URL first." });
      return;
    }
    try {
      await deps.alerter.send(s.webhookUrl, "✅ Warden test alert — your webhook works.", "test", tenantId);
      res.status(204).end();
    } catch (err) {
      res.status(502).json({ error: "send_failed", message: err instanceof Error ? err.message : "Could not reach the webhook." });
    }
  });

  /* -------------------------------------------------------- upstreams */

  router.get("/api/upstreams", async (_req: Request, res: Response) => {
    const { tenantId } = userOf(res);
    const builtin: UpstreamView[] = deps.pool.health().map((u) => ({
      id: u.id,
      namespace: u.namespace,
      kind: "builtin",
      url: null,
      status: u.status,
      error: u.error ?? null,
      toolCount: null,
    }));
    await deps.tenantUpstreams.listTools(tenantId); // connects, and refreshes status + tool counts
    const custom: UpstreamView[] = (await deps.tenantUpstreams.list(tenantId)).map((u) => ({
      id: u.id,
      namespace: u.namespace,
      kind: "custom",
      url: u.url,
      ...deps.tenantUpstreams.status(u.id),
    }));
    res.json([...builtin, ...custom]);
  });

  router.post("/api/upstreams", async (req: Request, res: Response) => {
    const { tenantId, email } = userOf(res);
    const parsed = newUpstream.safeParse(req.body);
    if (!parsed.success) {
      bad(res, parsed.error);
      return;
    }
    const { namespace, url } = parsed.data;
    if (deps.pool.has(namespace)) {
      res.status(409).json({ error: "exists", message: `"${namespace}" is a built-in namespace.` });
      return;
    }
    try {
      const added = await deps.tenantUpstreams.add(tenantId, namespace, url);
      deps.audit.record(tenantId, email, "upstream.add", namespace, new URL(url).host);
      res.status(201).json(added);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        res.status(400).json({ error: "unsafe_url", message: err.message });
        return;
      }
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "exists", message: `You already have an upstream called "${namespace}".` });
        return;
      }
      throw err;
    }
  });

  router.delete("/api/upstreams/:id", async (req: Request, res: Response) => {
    const { tenantId, email } = userOf(res);
    const removed = await deps.tenantUpstreams.remove(tenantId, String(req.params.id));
    if (removed) deps.audit.record(tenantId, email, "upstream.remove", String(req.params.id));
    res.status(removed ? 204 : 404).end();
  });

  return router;
}
