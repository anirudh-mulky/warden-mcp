import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PolicyInput } from "@warden/shared";
import { callerOf } from "../auth/middleware.js";
import type { PolicyStore } from "../policy/store.js";
import type { CallRecorder } from "../telemetry/recorder.js";

/**
 * The dashboard's API. Mounted behind requireApiKey (see app.ts), so every
 * handler knows the caller, and every query is scoped to the caller's
 * tenant — one tenant can never read another's calls or policy.
 */
export interface ApiDeps {
  policies: PolicyStore;
  recorder: CallRecorder;
}

/** "*", "fs.*", or an exact namespaced tool name. Nothing exotic. */
const pattern = z.string().regex(/^(\*|[A-Za-z0-9_-]+\.(\*|[A-Za-z0-9_.-]+))$/, "use *, ns.*, or ns.tool");

const policyInput = z.object({
  allow: z.array(pattern).max(100),
  deny: z.array(pattern).max(100),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).nullable(),
});

export function apiRouter(deps: ApiDeps): Router {
  const router = Router();

  router.get("/api/me", (_req: Request, res: Response) => {
    res.json(callerOf(res));
  });

  router.get("/api/calls", async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json(await deps.recorder.recent(callerOf(res).tenantId, limit));
  });

  router.get("/api/stats", async (_req: Request, res: Response) => {
    res.json(await deps.recorder.stats(callerOf(res).tenantId));
  });

  router.get("/api/policy", async (_req: Request, res: Response) => {
    res.json(await deps.policies.get(callerOf(res).tenantId));
  });

  router.put("/api/policy", async (req: Request, res: Response) => {
    const parsed = policyInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_policy", details: z.prettifyError(parsed.error) });
      return;
    }
    const input: PolicyInput = parsed.data;
    res.json(await deps.policies.put(callerOf(res).tenantId, input));
  });

  /**
   * Live feed, as Server-Sent Events: the response never ends, and each new
   * call for this tenant is written to it as one `data:` line.
   */
  router.get("/api/calls/stream", (req: Request, res: Response) => {
    const { tenantId } = callerOf(res);

    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();

    const unsubscribe = deps.recorder.subscribe((record) => {
      if (record.tenantId === tenantId) res.write(`data: ${JSON.stringify(record)}\n\n`);
    });
    // A comment line every 15s keeps proxies from closing an idle stream.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    const stopOnShutdown = deps.recorder.onClose(() => res.end());

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      stopOnShutdown();
    });
  });

  return router;
}
