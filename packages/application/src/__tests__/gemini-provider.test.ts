import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeminiModelProvider, classifyAiError } from "../ai/index.js";

describe("GeminiModelProvider Validation & Safety Guardrails", () => {
  const secretApiKey = "secret-gemini-api-key-xyz-123456789";
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("unavailable configured model returns safe error and leaves provider unverified", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          {
            name: "models/gemini-3.5-flash",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    });

    const provider = new GeminiModelProvider(secretApiKey, "gemini-nonexistent-model");
    expect(provider.isVerified).toBe(false);

    const validation = await provider.validateModel("gemini-nonexistent-model");
    expect(validation).toEqual({
      valid: false,
      error: "ai_model_not_found",
    });

    // Provider remains unverified
    expect(provider.isVerified).toBe(false);

    // Ensure API key was not leaked in returned object
    expect(JSON.stringify(validation)).not.toContain(secretApiKey);
  });

  it("available model selection identifies supported model without marking provider verified", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          {
            name: "models/gemini-3.5-flash",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    });

    const provider = new GeminiModelProvider(secretApiKey, "gemini-3.5-flash");
    expect(provider.isVerified).toBe(false);

    const validation = await provider.validateModel("gemini-3.5-flash");
    expect(validation).toEqual({
      valid: true,
      modelName: "gemini-3.5-flash",
    });

    // Invariant: listing/validating models alone does NOT mark the provider verified
    expect(provider.isVerified).toBe(false);

    // Key is never leaked
    expect(JSON.stringify(validation)).not.toContain(secretApiKey);
  });

  it("provider authentication failure fails safely without exposing API keys", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    const provider = new GeminiModelProvider(secretApiKey);
    const validation = await provider.validateModel();

    expect(validation).toEqual({
      valid: false,
      error: "ai_provider_authentication",
    });
    expect(provider.isVerified).toBe(false);
    expect(JSON.stringify(validation)).not.toContain(secretApiKey);
  });

  it("quota and rate-limit failure returns safe ai_quota_exceeded code", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });

    const provider = new GeminiModelProvider(secretApiKey);
    const validation = await provider.validateModel();

    expect(validation).toEqual({
      valid: false,
      error: "ai_quota_exceeded",
    });
    expect(provider.isVerified).toBe(false);
  });

  it("successful real-provider verification state transition occurs only after generation/tool-capable request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          {
            name: "models/gemini-3.5-flash",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    });

    const provider = new GeminiModelProvider(secretApiKey, "gemini-3.5-flash");

    // 1. Initial state is unverified
    expect(provider.isVerified).toBe(false);

    // 2. Listing/validating models does NOT transition to verified
    await provider.validateModel();
    expect(provider.isVerified).toBe(false);

    // 3. Explicit markVerified on successful tool-capable generation transitions state
    provider.markVerified();
    expect(provider.isVerified).toBe(true);
  });

  it("classifyAiError classifies all error categories safely", () => {
    expect(classifyAiError(new Error("API_KEY_INVALID"))).toBe("ai_provider_authentication");
    expect(classifyAiError({ statusCode: 401 })).toBe("ai_provider_authentication");
    expect(classifyAiError({ statusCode: 403 })).toBe("ai_provider_authentication");
    expect(classifyAiError(new Error("models/gemini-2.5-flash is no longer available"))).toBe(
      "ai_model_not_found",
    );
    expect(classifyAiError({ statusCode: 404 })).toBe("ai_model_not_found");
    expect(classifyAiError(new Error("Resource has been exhausted (quota exceeded)"))).toBe(
      "ai_quota_exceeded",
    );
    expect(classifyAiError({ statusCode: 429 })).toBe("ai_quota_exceeded");
    expect(
      classifyAiError(new Error("This model is currently experiencing high demand spikes")),
    ).toBe("ai_provider_unavailable");
    expect(classifyAiError({ statusCode: 503 })).toBe("ai_provider_unavailable");
    expect(classifyAiError(new Error("Unexpected stream interruption"))).toBe("ai_stream_error");
  });
});
