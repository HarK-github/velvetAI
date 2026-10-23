import { ModelProviderPort } from "./ports.js";
import { FakeModelProvider } from "./fake-model-provider.js";
import { GeminiModelProvider } from "./gemini-provider.js";

export * from "./ports.js";
export * from "./errors.js";
export * from "./fake-model-provider.js";
export * from "./gemini-provider.js";

/**
 * Creates and returns the configured ModelProviderPort based on AI_PROVIDER environment variable.
 * Fallbacks to FakeModelProvider if provider is unspecified or "fake".
 */
export function createModelProviderFromEnv(): ModelProviderPort {
  const provider = (process.env.AI_PROVIDER || "fake").toLowerCase();
  if (provider === "gemini") {
    return new GeminiModelProvider();
  }
  return new FakeModelProvider();
}
