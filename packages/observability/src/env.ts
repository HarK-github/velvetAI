import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  // PostgreSQL
  DATABASE_URL: z
    .string()
    .default("postgresql://velvet:velvet_dev_pass@localhost:5432/velvetai?sslmode=disable"),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(10),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // OIDC
  OIDC_ISSUER: z.string().default("https://auth.example.test"),
  OIDC_AUDIENCE: z.string().default("velvetai-api"),
  OIDC_MOCK_ENABLED: z
    .string()
    .transform((val) => val === "true" || val === "1")
    .or(z.boolean())
    .default(true),

  // Cryptography & Signing
  INTENT_SIGNING_KEY: z
    .string()
    .min(16, "Intent signing key must be at least 16 characters")
    .default("dev_secret_intent_signing_key_at_least_32_chars"),
  CONFIRMATION_TOKEN_SECRET: z
    .string()
    .min(16, "Confirmation token secret must be at least 16 characters")
    .default("dev_secret_confirmation_token_secret_32_chars"),
  ENVELOPE_ENCRYPTION_KEY: z
    .string()
    .default("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"),

  // PayPal Sandbox
  PAYPAL_CLIENT_ID: z.string().default("mock_paypal_client_id"),
  PAYPAL_CLIENT_SECRET: z.string().default("mock_paypal_client_secret"),
  PAYPAL_ENVIRONMENT: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_WEBHOOK_ID: z.string().default("mock_webhook_id"),

  // App URLs
  WEB_BASE_URL: z.string().default("http://localhost:5173"),
  API_BASE_URL: z.string().default("http://localhost:3000"),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown> = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => ` - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${formatted}`);
  }
  return parsed.data;
}
