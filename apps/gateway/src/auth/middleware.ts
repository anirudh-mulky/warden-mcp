import type { NextFunction, Request, Response } from "express";
import type { ApiKeyId, TenantId } from "@warden/shared";
import { logger } from "../logger.js";
import { hashApiKey, looksLikeApiKey } from "./keys.js";
import type { KeyStore } from "./store.js";

/** Who is making this request. Set by requireApiKey, read by everything after it. */
export interface Caller {
  tenantId: TenantId;
  apiKeyId: ApiKeyId;
}

/** "Bearer <key>". The scheme name is case-insensitive in HTTP, so "bearer" works too. */
const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Builds middleware that lets a request through only with a valid API key.
 *
 * Every failure gets the SAME response. Telling a caller "that key exists
 * but is revoked" versus "that key never existed" would help an attacker
 * sort stolen keys into useful and useless. The real reason goes to our
 * own logs instead, where only we can read it.
 */
export function requireApiKey(store: KeyStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const match = BEARER.exec(req.get("authorization") ?? "");
    const key = match?.[1];

    if (key === undefined || !looksLikeApiKey(key)) {
      logger.debug({ path: req.path }, "auth rejected: missing or malformed key");
      reject(res);
      return;
    }

    // If the store throws (e.g. DynamoDB is down), Express 5 catches the
    // rejected promise and returns a 500. Correct: an outage is not a 401.
    const stored = await store.findByHash(hashApiKey(key));

    if (stored === null) {
      logger.info({ prefix: key.slice(0, 8) }, "auth rejected: unknown key");
      reject(res);
      return;
    }

    if (stored.revokedAt !== null) {
      // Warn, not info: a revoked key being tried may mean it leaked.
      logger.warn(
        { apiKeyId: stored.id, tenantId: stored.tenantId, revokedAt: stored.revokedAt },
        "auth rejected: revoked key used",
      );
      reject(res);
      return;
    }

    const caller: Caller = { tenantId: stored.tenantId, apiKeyId: stored.id };
    res.locals.caller = caller;
    next();
  };
}

/**
 * The caller for this request. Throws if requireApiKey did not run first —
 * that is a wiring bug in our code, and it must fail loudly rather than
 * quietly treat the request as belonging to nobody.
 */
export function callerOf(res: Response): Caller {
  const caller = res.locals.caller as Caller | undefined;
  if (caller === undefined) {
    throw new Error("callerOf() used on a route not protected by requireApiKey");
  }
  return caller;
}

function reject(res: Response): void {
  res
    .status(401)
    .set("WWW-Authenticate", 'Bearer realm="warden"')
    .json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: a valid Warden API key is required" },
      id: null,
    });
}
