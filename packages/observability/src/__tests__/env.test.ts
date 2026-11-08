import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { validateEnv, envSchema } from "../env.js";

const testEcKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const testEcPem = testEcKey.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const testEcBase64 = Buffer.from(testEcPem).toString("base64");

describe("envSchema and validateEnv", () => {
  it("validates default development values", () => {
    const env = validateEnv({});
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toContain("postgresql://");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.OIDC_MOCK_ENABLED).toBe(true);
  });

  it("parses valid custom production values", () => {
    const parsed = envSchema.parse({
      NODE_ENV: "production",
      PORT: "8080",
      DATABASE_URL: "postgresql://user:pass@render.host:5432/db",
      REDIS_URL: "redis://cache.host:6379",
      OIDC_ISSUER: "https://auth.velvetai.com",
      OIDC_AUDIENCE: "velvetai-prod",
      INTENT_SIGNING_KEY: testEcBase64,
      CONFIRMATION_TOKEN_SECRET: "super_secret_confirmation_token_secret_32_chars",
      ENVELOPE_ENCRYPTION_KEY: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    });

    expect(parsed.NODE_ENV).toBe("production");
    expect(parsed.PORT).toBe(8080);
    expect(parsed.OIDC_AUDIENCE).toBe("velvetai-prod");
    expect(parsed.ENVELOPE_ENCRYPTION_KEY).toBe(
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    );
  });

  it("throws error when secret is too short", () => {
    expect(() =>
      validateEnv({
        CONFIRMATION_TOKEN_SECRET: "short",
      }),
    ).toThrow("Environment validation failed");
  });

  it("rejects placeholder and invalid INTENT_SIGNING_KEY in production", () => {
    expect(() =>
      envSchema.parse({
        NODE_ENV: "production",
        INTENT_SIGNING_KEY: "dev_secret_intent_signing_key_at_least_32_chars",
        CONFIRMATION_TOKEN_SECRET: "super_secret_confirmation_token_secret_32_chars",
        ENVELOPE_ENCRYPTION_KEY: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      }),
    ).toThrow(/Production INTENT_SIGNING_KEY cannot be a default or placeholder value/);

    expect(() =>
      envSchema.parse({
        NODE_ENV: "production",
        INTENT_SIGNING_KEY: "not-a-valid-ec-pem-or-base64-key-content-32chars",
        CONFIRMATION_TOKEN_SECRET: "super_secret_confirmation_token_secret_32_chars",
        ENVELOPE_ENCRYPTION_KEY: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      }),
    ).toThrow(/Production INTENT_SIGNING_KEY must be a valid PKCS#8 PEM/);
  });

  it("rejects placeholder CONFIRMATION_TOKEN_SECRET in production", () => {
    expect(() =>
      envSchema.parse({
        NODE_ENV: "production",
        INTENT_SIGNING_KEY: testEcPem,
        CONFIRMATION_TOKEN_SECRET: "dev_secret_confirmation_token_secret_32_chars",
        ENVELOPE_ENCRYPTION_KEY: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      }),
    ).toThrow(/Production CONFIRMATION_TOKEN_SECRET cannot be a default or placeholder value/);
  });

  it("rejects default dev test vector for ENVELOPE_ENCRYPTION_KEY in production", () => {
    expect(() =>
      envSchema.parse({
        NODE_ENV: "production",
        INTENT_SIGNING_KEY: testEcPem,
        CONFIRMATION_TOKEN_SECRET: "super_secret_confirmation_token_secret_32_chars",
        ENVELOPE_ENCRYPTION_KEY: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      }),
    ).toThrow(/Production ENVELOPE_ENCRYPTION_KEY cannot use the default dev test vector/);
  });

  it("rejects non-64-character hex ENVELOPE_ENCRYPTION_KEY", () => {
    expect(() =>
      envSchema.parse({
        ENVELOPE_ENCRYPTION_KEY: "not-hex-and-too-short",
      }),
    ).toThrow(/Envelope encryption key must be a 64-character hex string/);
  });
});
