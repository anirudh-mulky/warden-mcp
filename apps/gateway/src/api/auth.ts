import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Collection } from "mongodb";
import { z } from "zod";
import type { TenantId } from "@warden/shared";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/passwords.js";
import { endSession, startSession } from "../auth/session.js";
import type { UserDoc } from "../db/mongo.js";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Sign-up, log-in, log-out. The only /api routes that work without a session.
 *
 * Every sign-up creates a new tenant, owned by that user: one account, one
 * tenant. (Teams and invitations are deliberately out of scope.)
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

export function authRouter(users: Collection<UserDoc>): Router {
  const router = Router();

  router.post("/api/auth/signup", async (req: Request, res: Response) => {
    const parsed = signup.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid", message: z.prettifyError(parsed.error) });
      return;
    }
    const { email, password, signupCode } = parsed.data;

    // On a public deployment, an open sign-up page would let anyone use
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
    await startSession(res, { userId: user.id, email, tenantId: user.tenantId });
    res.status(201).json({ email, tenantId: user.tenantId });
  });

  router.post("/api/auth/login", async (req: Request, res: Response) => {
    const parsed = credentials.safeParse(req.body);
    const user = parsed.success ? await users.findOne({ email: parsed.data.email }) : null;

    // Always run one scrypt verification, real or dummy, so a missing
    // account takes as long as a wrong password. Same message either way.
    const ok = await verifyPassword(parsed.success ? parsed.data.password : "", user?.passwordHash ?? (await DUMMY_HASH));
    if (user === null || !ok) {
      res.status(401).json({ error: "unauthorized", message: "Wrong email or password." });
      return;
    }

    await startSession(res, { userId: user.id, email: user.email, tenantId: user.tenantId });
    res.json({ email: user.email, tenantId: user.tenantId });
  });

  router.post("/api/auth/logout", (_req: Request, res: Response) => {
    endSession(res);
    res.status(204).end();
  });

  return router;
}
