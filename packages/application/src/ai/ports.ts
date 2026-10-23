/**
 * ModelProviderPort: Application-level abstraction for AI models.
 * Decouples domain logic from specific model providers (Gemini, Fake, etc.).
 */

export interface ModelProviderPort {
  /**
   * Identifying name of the active provider (e.g. "gemini", "fake").
   */
  readonly providerName: string;

  /**
   * Whether the real provider has been verified via real generation and tool capability.
   */
  readonly isVerified?: boolean;

  /**
   * Default configured model identifier.
   */
  readonly defaultModelId?: string;

  /**
   * Retrieves an AI SDK LanguageModel instance for the requested or default model ID.
   */
  getLanguageModel(modelId?: string): any;

  /**
   * Safely validates that the model is supported and available without leaking credentials.
   */
  validateModel?(modelId?: string): Promise<{ valid: boolean; modelName?: string; error?: string }>;

  /**
   * Explicitly marks provider as verified after successful generation & tool call.
   */
  markVerified?(): void;

  /**
   * Executes a minimal verification prompt and tool call.
   */
  verifyWithExecution?(prompt?: string, tools?: Record<string, any>): Promise<boolean>;
}
