import { describe, it, expect } from "vitest";
import { validateEnv, envSchema } from "../env.js";

describe("envSchema and validateEnv", () => {
  it("validates default development values", () => {
    const env = validateEnv({});
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toContain("postgresql://");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.OIDC_MOCK_ENABLED).toBe(true);
  });

  it("parses valid custom values", () => {
    const parsed = envSchema.parse({
      NODE_ENV: "production",
      PORT: "8080",
      DATABASE_URL: "postgresql://user:pass@render.host:5432/db",
      REDIS_URL: "redis://cache.host:6379",
      OIDC_ISSUER: "https://auth.velvetai.com",
      OIDC_AUDIENCE: "velvetai-prod",
      INTENT_SIGNING_KEY: "super_secret_signing_key_at_least_32_chars_long",
      CONFIRMATION_TOKEN_SECRET: "super_secret_confirmation_token_secret_32_chars",
    });

    expect(parsed.NODE_ENV).toBe("production");
    expect(parsed.PORT).toBe(8080);
    expect(parsed.OIDC_AUDIENCE).toBe("velvetai-prod");
  });

  it("throws error when secret is too short", () => {
    expect(() =>
      validateEnv({
        INTENT_SIGNING_KEY: "short",
      }),
    ).toThrow("Environment validation failed");
  });
});
