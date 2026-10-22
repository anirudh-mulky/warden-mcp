import type { NextFunction, Request, Response } from "express";
import { jwtVerify, SignJWT } from "jose";
import type { TenantId } from "@warden/shared";
import { jwtSecret } from "../env.js";

/**
 * Dashboard sessions: after login, the browser holds a signed token (a JWT)
 * in a cookie, so it does not resend the password on every request.
 *
 * The cookie is:
 *  - httpOnly  — page JavaScript cannot read it, so an injected script
 *                cannot steal the session.
 *  - SameSite=Strict — the browser will not attach it to requests that
 *                start on another site, which blocks cross-site request
 *                forgery against the dashboard API.
 *  - Secure whenever the site is served over HTTPS.
 *
 * API keys (for agents) and sessions (for humans) are separate on purpose:
 * a leaked agent key cannot open the dashboard, and vice versa.
 */

export interface SessionUser {
  userId: string;
  email: string;
  tenantId: TenantId;
}

const COOKIE = "warden_session";
const LIFETIME_SECONDS = 12 * 60 * 60;
const key = new TextEncoder().encode(jwtSecret);

export async function startSession(res: Response, user: SessionUser): Promise<void> {
  const token = await new SignJWT({ email: user.email, tenantId: user.tenantId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime(`${LIFETIME_SECONDS}s`)
    .sign(key);

  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    // Secure exactly when the request arrived over HTTPS (directly, or via a
    // proxy's X-Forwarded-Proto — app.ts trusts the proxy). On plain
    // http://localhost a Secure cookie would be refused by some browsers.
    secure: res.req.secure,
    maxAge: LIFETIME_SECONDS * 1000,
    path: "/",
  });
}

export function endSession(res: Response): void {
  res.clearCookie(COOKIE, { path: "/" });
}

/** Reads one cookie from the raw header. Express does not parse cookies by itself. */
function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Lets a request through only with a valid, unexpired session cookie. */
export function requireSession() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = readCookie(req, COOKIE);
    if (token !== undefined) {
      try {
        // algorithms is pinned: never let the token choose how it is checked.
        const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
        if (typeof payload.sub === "string" && typeof payload.email === "string" && typeof payload.tenantId === "string") {
          const user: SessionUser = { userId: payload.sub, email: payload.email, tenantId: payload.tenantId as TenantId };
          res.locals.user = user;
          next();
          return;
        }
      } catch {
        // expired, tampered with, or signed with a different secret — fall through
      }
    }
    res.status(401).json({ error: "unauthorized", message: "Sign in to use the dashboard." });
  };
}

/** The signed-in user. Throws if requireSession did not run first — a wiring bug. */
export function userOf(res: Response): SessionUser {
  const user = res.locals.user as SessionUser | undefined;
  if (user === undefined) throw new Error("userOf() used on a route not protected by requireSession");
  return user;
}
