import pino from "pino";
import { env } from "./env.js";

/**
 * Structured logging.
 *
 * console.log writes a human sentence. That is useless in production:
 * you cannot search "call took 312ms for tenant abc" across a million
 * lines. Pino writes JSON instead — one object per line — so CloudWatch
 * can filter on `latencyMs > 500` or `tenantId = "..."` directly.
 *
 * In development that JSON is unreadable, so pino-pretty reformats it
 * for your terminal. Development gets pretty; production gets machine
 * readable. Same call site, different rendering.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }
    : {}),
  // Never let a secret reach the logs, even by accident.
  redact: ["req.headers.authorization", "req.headers['x-api-key']"],
});

export type Logger = typeof logger;
