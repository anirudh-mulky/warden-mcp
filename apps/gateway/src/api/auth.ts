import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Collection } from "mongodb";
import { z } from "zod";
import type { TenantId } from "@warden/shared";
import type { AuditLog } from "../audit/log.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/passwords.js";
import { endSession, startSession } from "../auth/session.js";
import type { UserDoc } from "../db/mongo.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { RateLimiter } from "../policy/rate-limit.js";

/**
 * Sign-up, log-in, log-out. The only /api routes that work without a session.
 *
 * Every sign-up creates a new tenant, owned by that user: one account, one
 * tenant. (Teams and invitations are deliberately out of scope.)
 *
 * Brute-force protection: scrypt makes each guess slow, but nothing stops
 * an attacker from simply making many guesses. So attempts are counted in
 * DynamoDB, per IP and per email address:
 *   - per IP    20 sign-in attempts / 10 min, 10 sign-ups / hour
 *   - per email  8 sign-in attempts / 10 min
 * The per-email limit is what really protects an account — an attacker can
 * rotate IPs, but not the address they are trying to break into.
 */
const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "use at least 10 characters").max(200),
});
const signup = credentials.extend({ signupCode: z.string().optional() });

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface AuthDeps {
  users: Collection<UserDoc>;
  rateLimiter: RateLimiter;
  audit: AuditLog;
}

export function authRouter({ users, rateLimiter, audit }: AuthDeps): Router {
  const router = Router();

  /** True if under every limit. If the limiter itself is down, allow (fail open) and say so. */
  const underLimits = async (checks: [bucket: string, limit: number, windowSeconds: number][]): Promise<boolean> => {
    try {
      for (const [bucket, limit, window] of checks) if (!(await rateLimiter.take(bucket, limit, window))) return false;
      return true;
    } catch (err) {
      logger.warn({ err }, "login rate limiter unavailable, allowing attempt");
      return true;
    }
  };
  const tooMany = (res: Response, seconds: number) => {
    res.set("Retry-After", String(seconds));
    res.status(429).json({ error: "rate_limited", message: "Too many attempts. Wait a few minutes and try again." });
  };

  router.post("/api/auth/signup", async (req: Request, res: Response) => {
    if (env.RATE_LIMIT_AUTH_BY_IP && !(await underLimits([[`signup-ip:${req.ip}`, 10, 3600]]))) {
      tooMany(res, 3600);
      return;
    }
    const parsed = signup.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid", message: z.prettifyError(parsed.error) });
      return;
    }
    const { email, password, signupCode } = parsed.data;

    // On a shared deployment, an open sign-up page would let anyone use
    // your upstreams. SIGNUP_CODE turns sign-up into invitation-only.
    if (env.SIGNUP_CODE !== undefined && (signupCode === undefined || !sameSecret(signupCode, env.SIGNUP_CODE))) {
      res.status(403).json({ error: "forbidden", message: "A valid sign-up code is required." });
      return;
    }

    const user: UserDoc = {
      id: randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      tenantId: `t_${randomBytes(6).toString("hex")}` as TenantId,
      createdAt: new Date().toISOString(),
      sessionVersion: 0,
    };
    try {
      await users.insertOne({ ...user });
    } catch (err) {
      // 11000 = unique index violation: that email already has an account.
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "exists", message: "An account with that email already exists." });
        return;
      }
      throw err;
    }

    logger.info({ userId: user.id, tenantId: user.tenantId }, "user signed up");
    audit.record(user.tenantId, email, "account.create", email);
    await startSession(res, { userId: user.id, email, tenantId: user.tenantId }, 0);
    res.status(201).json({ email, tenantId: user.tenantId });
  });

  router.post("/api/auth/login", async (req: Request, res: Response) => {
    const parsed = credentials.safeParse(req.body);
    const email = parsed.success ? parsed.data.email : "";
    const checks: [string, number, number][] = [];
    if (env.RATE_LIMIT_AUTH_BY_IP) checks.push([`login-ip:${req.ip}`, 20, 600]);
    if (email !== "") checks.push([`login-email:${email}`, 8, 600]);
    if (!(await underLimits(checks))) {
      logger.warn({ ip: req.ip }, "login rate limited");
      tooMany(res, 600);
      return;
    }

    const user = parsed.success ? await users.findOne({ email }) : null;
    // Always run one scrypt verification, real or dummy, so a missing
    // account takes as long as a wrong password. Same message either way.
    const ok = await verifyPassword(parsed.success ? parsed.data.password : "", user?.passwordHash ?? (await DUMMY_HASH));
    if (user === null || !ok) {
      res.status(401).json({ error: "unauthorized", message: "Wrong email or password." });
      return;
    }

    audit.record(user.tenantId, user.email, "session.login", user.email);
    await startSession(res, { userId: user.id, email: user.email, tenantId: user.tenantId }, user.sessionVersion ?? 0);
    res.json({ email: user.email, tenantId: user.tenantId });
  });

  router.post("/api/auth/logout", (_req: Request, res: Response) => {
    endSession(res);
    res.status(204).end();
  });

  return router;
}
