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
  /**
   * ALWAYS a local DynamoDB (DynamoDB Local in Docker). Warden is designed to
   * cost nothing, so it never talks to real AWS: this is required in every
   * environment, and an amazonaws.com address is refused outright.
   */
  DYNAMODB_ENDPOINT: z
    .string()
    .url()
    .default("http://localhost:8000")
    .refine((url) => !new URL(url).hostname.endsWith("amazonaws.com"), {
      message: "Warden only runs against a local DynamoDB; real AWS endpoints are refused so it can never cost money",
    }),
  AWS_REGION: z.string().default("us-east-1"),
  DYNAMODB_TABLE_API_KEYS: z.string().default("warden-api-keys"),
  DYNAMODB_TABLE_RATE_LIMITS: z.string().default("warden-rate-limits"),
  /** Development only: one fixed key seeded at boot, so it survives tsx restarts. */
  WARDEN_DEV_API_KEY: z
    .string()
    .refine(looksLikeApiKey, "must be a Warden API key: wdn_ followed by 43 characters")
    .optional(),

  /** Signs dashboard session tokens. Required, and at least 32 chars, in production. */
  JWT_SECRET: z.string().min(32).optional(),
  /** If set, sign-up requires this code — invitation-only accounts. */
  // A blank value (e.g. SIGNUP_CODE= in a compose file) means "not set".
  SIGNUP_CODE: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(8).optional()),
  /** If set, the gateway also serves the built dashboard from this directory (the Docker image does). */
  DASHBOARD_DIR: z.string().optional(),
  /** Directory the filesystem upstream may touch. Defaults to the repo's sandbox/. */
  FS_SANDBOX_DIR: z.string().optional(),

  /**
   * Believe X-Forwarded-For / X-Forwarded-Proto. Only true behind a proxy you
   * control: otherwise anyone can fake their IP and walk around the login
   * rate limit by sending a different header on every attempt.
   */
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /**
   * Let webhooks and custom upstreams target private/internal addresses
   * (localhost, 10.x, 192.168.x, cloud metadata...). Off by default: a
   * user-supplied URL that reaches internal services is SSRF.
   */
  ALLOW_PRIVATE_NETWORK_TARGETS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /**
   * Per-IP limits on sign-in and sign-up. On by default. The integration
   * tests turn it off because every test request comes from one address;
   * the per-email limit (the one that protects accounts) stays on regardless.
   */
  RATE_LIMIT_AUTH_BY_IP: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** How long a call needing approval waits for a human. Below MCP clients' usual 60s timeout. */
  APPROVAL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(55_000).default(45_000),
})
  .refine((e) => e.NODE_ENV !== "production" || e.JWT_SECRET !== undefined, {
    message: "JWT_SECRET must be set in production",
    path: ["JWT_SECRET"],
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

/**
 * The session-signing secret. Outside production a fixed, clearly-fake value
 * is used so development needs no setup; production cannot reach this
 * fallback because the schema above refuses to start without JWT_SECRET.
 */
export const jwtSecret = env.JWT_SECRET ?? "development-only-secret-never-use-in-production";
