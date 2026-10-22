import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiKeyId, CreatedApiKey, Me, PolicyInput, ToolInfo } from "@warden/shared";
import { generateApiKey, newApiKeyId } from "../auth/keys.js";
import { userOf } from "../auth/session.js";
import { toPublicKey, type KeyAdmin } from "../auth/store.js";
import type { UpstreamPool } from "../mcp/pool.js";
import { decide } from "../policy/engine.js";
import type { PolicyStore } from "../policy/store.js";
import type { CallRecorder } from "../telemetry/recorder.js";

/**
 * The dashboard's API. Mounted behind requireSession (see app.ts), so every
 * handler knows the signed-in user, and every query is scoped to that
 * user's tenant — one tenant can never read another's calls, keys or policy.
 */
export interface ApiDeps {
  policies: PolicyStore;
  recorder: CallRecorder;
  keyStore: KeyAdmin;
  pool: UpstreamPool;
}

/** "*", "fs.*", or an exact namespaced tool name. Nothing exotic. */
const pattern = z.string().regex(/^(\*|[A-Za-z0-9_-]+\.(\*|[A-Za-z0-9_.-]+))$/, "use *, ns.*, or ns.tool");

const policyInput = z.object({
  allow: z.array(pattern).max(100),
  deny: z.array(pattern).max(100),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).nullable(),
});

const newKey = z.object({ name: z.string().trim().min(1).max(80) });

export function apiRouter(deps: ApiDeps): Router {
  const router = Router();

  router.get("/api/me", (_req: Request, res: Response) => {
    const { email, tenantId } = userOf(res);
    const me: Me = { email, tenantId };
    res.json(me);
  });

  /** Recent calls, newest first. `?since=<ISO time>` returns only newer ones — the dashboard polls with it. */
  router.get("/api/calls", async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const since = typeof req.query.since === "string" && !Number.isNaN(Date.parse(req.query.since)) ? req.query.since : undefined;
    res.json(await deps.recorder.recent(userOf(res).tenantId, limit, since));
  });

  router.get("/api/stats", async (_req: Request, res: Response) => {
    res.json(await deps.recorder.stats(userOf(res).tenantId));
  });

  /**
   * Every upstream tool, with what the tenant's policy says about it. Uses
   * the very same decide() as tools/call, so the dashboard can never show a
   * tool as allowed that the gateway would actually refuse.
   */
  router.get("/api/tools", async (_req: Request, res: Response) => {
    const [tools, policy] = await Promise.all([deps.pool.listTools(), deps.policies.get(userOf(res).tenantId)]);
    const view: ToolInfo[] = tools
      .map((tool) => {
        const decision = decide(policy, tool.name);
        return {
          name: tool.name,
          description: tool.description ?? "",
          verdict: decision.verdict,
          reason: decision.verdict === "deny" ? decision.reason : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(view);
  });

  router.get("/api/policy", async (_req: Request, res: Response) => {
    res.json(await deps.policies.get(userOf(res).tenantId));
  });

  router.put("/api/policy", async (req: Request, res: Response) => {
    const parsed = policyInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_policy", message: z.prettifyError(parsed.error) });
      return;
    }
    const input: PolicyInput = parsed.data;
    res.json(await deps.policies.put(userOf(res).tenantId, input));
  });

  router.get("/api/keys", async (_req: Request, res: Response) => {
    const keys = await deps.keyStore.listByTenant(userOf(res).tenantId);
    res.json(keys.map(toPublicKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });

  router.post("/api/keys", async (req: Request, res: Response) => {
    const parsed = newKey.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid", message: z.prettifyError(parsed.error) });
      return;
    }
    const { key, prefix, hash } = generateApiKey();
    const stored = {
      id: newApiKeyId(),
      tenantId: userOf(res).tenantId,
      name: parsed.data.name,
      prefix,
      hash,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    await deps.keyStore.put(stored);
    // The one and only time the full key leaves the server.
    const created: CreatedApiKey = { key, apiKey: toPublicKey(stored) };
    res.status(201).json(created);
  });

  router.delete("/api/keys/:id", async (req: Request, res: Response) => {
    const revoked = await deps.keyStore.revoke(req.params.id as ApiKeyId, new Date().toISOString(), userOf(res).tenantId);
    // 404 whether it does not exist or belongs to someone else: don't confirm other tenants' key ids.
    res.status(revoked ? 204 : 404).end();
  });

  return router;
}
