import { z } from "zod";
import crypto from "node:crypto";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    // PostgreSQL
    DATABASE_URL: z
      .string()
      .default(process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable"),
    DATABASE_POOL_MIN: z.coerce.number().default(2),
    DATABASE_POOL_MAX: z.coerce.number().default(10),

    // Redis
    REDIS_URL: z.string().default("redis://localhost:6379"),

    // OIDC & Auth0
    OIDC_ISSUER: z.string().default("https://auth.example.test"),
    OIDC_AUDIENCE: z.string().default("velvetai-api"),
    OIDC_MOCK_ENABLED: z
      .string()
      .transform((val) => val === "true" || val === "1")
      .or(z.boolean())
      .default(true),
    AUTH0_ISSUER: z.string().default("https://auth.example.test/"),
    AUTH0_AUDIENCE: z.string().default("https://velvetai.example/api"),
    AUTH0_JWKS_URI: z.string().optional(),

    // Self-Service Onboarding & Public Demo Access
    SELF_SIGNUP_ENABLED: z
      .string()
      .transform((val) => val === "true" || val === "1")
      .or(z.boolean())
      .default(false),
    SELF_SIGNUP_TENANT_ID: z.string().default("01932b10-0000-7000-8000-000000000a01"),
    PUBLIC_DEMO_TENANT_ID: z.string().default("01932b10-0000-7000-8000-000000000a01"),

    // AI Provider & Gemini
    AI_PROVIDER: z.enum(["gemini", "fake"]).default("fake"),
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
    AI_MODEL: z.string().default("gemini-3.5-flash-lite"),

    // Host & Origin Security Allowlist
    ALLOWED_HOSTS: z
      .string()
      .default(
        "localhost,localhost:80,localhost:3000,127.0.0.1,127.0.0.1:80,127.0.0.1:3000,localhost:5173,127.0.0.1:5173,velvetai-api.onrender.com",
      ),
    ALLOWED_ORIGINS: z
      .string()
      .default("http://localhost:5173,http://localhost:3000,https://velvetai.onrender.com"),

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
      .regex(
        /^[0-9a-fA-F]{64}$/,
        "Envelope encryption key must be a 64-character hex string (32 bytes)",
      )
      .default("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"),

    // PayPal Sandbox
    PAYPAL_CLIENT_ID: z.string().default("mock_paypal_client_id"),
    PAYPAL_CLIENT_SECRET: z.string().default("mock_paypal_client_secret"),
    PAYPAL_ENVIRONMENT: z
      .literal("sandbox", {
        errorMap: () => ({
          message:
            "Only PayPal sandbox environment is permitted; live environment is strictly prohibited",
        }),
      })
      .default("sandbox"),
    PAYPAL_WEBHOOK_ID: z.string().default("mock_webhook_id"),

    // App URLs
    WEB_BASE_URL: z.string().default("http://localhost:5173"),
    API_BASE_URL: z.string().default("http://localhost:3000"),
    MCP_RESOURCE_URL: z.string().default("http://localhost:3000/mcp"),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === "production") {
      // 1. INTENT_SIGNING_KEY: Reject placeholders, require valid EC private key PEM or base64 PKCS#8
      if (
        data.INTENT_SIGNING_KEY.startsWith("dev_secret_") ||
        data.INTENT_SIGNING_KEY.includes("placeholder")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["INTENT_SIGNING_KEY"],
          message: "Production INTENT_SIGNING_KEY cannot be a default or placeholder value",
        });
      } else {
        try {
          let pem = data.INTENT_SIGNING_KEY.trim();
          if (!pem.includes("-----BEGIN")) {
            const decoded = Buffer.from(pem, "base64").toString("utf8");
            if (decoded.includes("-----BEGIN")) {
              pem = decoded;
            }
          }
          pem = pem.replace(/\\n/g, "\n");
          const privKey = crypto.createPrivateKey(pem);
          if (privKey.asymmetricKeyType !== "ec") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["INTENT_SIGNING_KEY"],
              message: "Production INTENT_SIGNING_KEY must be an EC (P-256 / ES256) private key",
            });
          }
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["INTENT_SIGNING_KEY"],
            message: `Production INTENT_SIGNING_KEY must be a valid PKCS#8 PEM or base64-encoded PKCS#8 PEM: ${(err as Error).message}`,
          });
        }
      }

      // 2. CONFIRMATION_TOKEN_SECRET: Reject placeholders, require length >= 32
      if (
        data.CONFIRMATION_TOKEN_SECRET.startsWith("dev_secret_") ||
        data.CONFIRMATION_TOKEN_SECRET.includes("placeholder")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CONFIRMATION_TOKEN_SECRET"],
          message: "Production CONFIRMATION_TOKEN_SECRET cannot be a default or placeholder value",
        });
      } else if (data.CONFIRMATION_TOKEN_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CONFIRMATION_TOKEN_SECRET"],
          message: "Production CONFIRMATION_TOKEN_SECRET must be at least 32 characters",
        });
      }

      // 3. ENVELOPE_ENCRYPTION_KEY: Reject dev default test vector
      if (
        data.ENVELOPE_ENCRYPTION_KEY ===
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ENVELOPE_ENCRYPTION_KEY"],
          message: "Production ENVELOPE_ENCRYPTION_KEY cannot use the default dev test vector",
        });
      }
    }
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
