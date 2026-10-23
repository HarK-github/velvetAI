import { createGoogle } from "@ai-sdk/google";
import { generateText, tool } from "ai";
import { z } from "zod";
import { ModelProviderPort } from "./ports.js";
import { classifyAiError } from "./errors.js";

export class GeminiModelProvider implements ModelProviderPort {
  public readonly providerName = "gemini";
  public isVerified = false;
  public readonly defaultModelId: string;
  private apiKey: string;
  private googleClient: ReturnType<typeof createGoogle>;

  constructor(apiKey?: string, defaultModelId?: string) {
    const key = apiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!key) {
      throw new Error(
        "GeminiModelProvider error: GOOGLE_GENERATIVE_AI_API_KEY environment variable is not configured. Server-only key required.",
      );
    }

    this.apiKey = key;
    this.defaultModelId = defaultModelId || process.env.AI_MODEL || "gemini-3.5-flash";
    this.googleClient = createGoogle({
      apiKey: key,
    });
  }

  getLanguageModel(modelId?: string): any {
    const targetModel = modelId || this.defaultModelId;
    return this.googleClient(targetModel);
  }

  markVerified(): void {
    this.isVerified = true;
  }

  async validateModel(
    modelId?: string,
  ): Promise<{ valid: boolean; modelName?: string; error?: string }> {
    const targetModel = modelId || this.defaultModelId;
    const cleanTarget = targetModel.startsWith("models/")
      ? targetModel.slice("models/".length)
      : targetModel;

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.apiKey)}`;
      const res = await fetch(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
      });

      if (!res.ok) {
        const error = classifyAiError({ statusCode: res.status });
        return { valid: false, error };
      }

      const body = (await res.json()) as {
        models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
      };

      const found = body.models?.find((m) => {
        const name = m.name?.startsWith("models/") ? m.name.slice("models/".length) : m.name;
        return name === cleanTarget;
      });

      if (!found || !found.supportedGenerationMethods?.includes("generateContent")) {
        return { valid: false, error: "ai_model_not_found" };
      }

      // Valid model found; listing alone does NOT mark provider verified
      return { valid: true, modelName: cleanTarget };
    } catch (err: unknown) {
      const safeCode = classifyAiError(err);
      return { valid: false, error: safeCode };
    }
  }

  async verifyWithExecution(prompt = "Hello", tools?: Record<string, any>): Promise<boolean> {
    const model = this.getLanguageModel();
    const verificationTools = tools || {
      ping_service: tool({
        description: "Verification ping service",
        inputSchema: z.object({}),
        execute: async () => ({ status: "ok" }),
      }),
    };

    try {
      await generateText({
        model,
        prompt,
        tools: verificationTools,
      });

      this.isVerified = true;
      return true;
    } catch (err: unknown) {
      const safeCode = classifyAiError(err);
      const safeErr = new Error(`Gemini execution verification failed: ${safeCode}`);
      (safeErr as any).code = safeCode;
      throw safeErr;
    }
  }
}
