import { z } from "zod";
import { looksLikeApiKey } from "./auth/keys.js";

/**
 * Environment variables, parsed and validated once at startup.
 *
 * Why bother? `process.env.PORT` is typed `string | undefined` and is a
 * lie: it might be missing, or it might be "banana". Reading it directly
 * all over the codebase means every one of those reads can fail at 3am.
 *
 * Instead we validate the whole environment here, at boot. If something
 * is missing or malformed the process refuses to start and tells you
 * exactly which variable is wrong. Failing loudly at startup beats
 * failing quietly under load. This is called "fail fast".
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  MONGODB_URI: z.string().url().default("mongodb://localhost:27017/warden"),
  DYNAMODB_ENDPOINT: z.string().url().optional(),
  /** Development only: one fixed key seeded at boot, so it survives tsx restarts. */
  WARDEN_DEV_API_KEY: z
    .string()
    .refine(looksLikeApiKey, "must be a Warden API key: wdn_ followed by 43 characters")
    .optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Not using the logger here — the logger needs LOG_LEVEL, which is
  // exactly what might be broken. console.error is the honest choice.
  console.error("Invalid environment variables:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
