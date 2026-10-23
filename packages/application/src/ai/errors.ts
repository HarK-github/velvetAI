export type SafeAiErrorCode =
  | "ai_provider_authentication"
  | "ai_model_not_found"
  | "ai_quota_exceeded"
  | "ai_provider_unavailable"
  | "ai_stream_error";

export function classifyAiError(err: unknown): SafeAiErrorCode {
  if (!err) return "ai_stream_error";
  const str = String(
    typeof err === "object" && err !== null && "message" in err
      ? (err as { message: unknown }).message
      : err,
  ).toLowerCase();

  const statusCode =
    typeof err === "object" && err !== null && "statusCode" in err
      ? Number((err as { statusCode: unknown }).statusCode)
      : undefined;

  // 1. Authentication / API key issues
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    str.includes("api_key") ||
    str.includes("api key") ||
    str.includes("unauthorized") ||
    str.includes("authentication") ||
    str.includes("invalid key") ||
    str.includes("loadapikeyerror") ||
    str.includes("permission_denied") ||
    str.includes("permissiondenied")
  ) {
    return "ai_provider_authentication";
  }

  // 2. Model not found / unavailable
  if (
    statusCode === 404 ||
    str.includes("model not found") ||
    str.includes("nosuchmodelerror") ||
    str.includes("not_found") ||
    str.includes("not found") ||
    str.includes("does not exist") ||
    str.includes("is no longer available") ||
    str.includes("unsupported model")
  ) {
    return "ai_model_not_found";
  }

  // 3. Quota / Rate limit
  if (
    statusCode === 429 ||
    str.includes("quota") ||
    str.includes("rate limit") ||
    str.includes("ratelimit") ||
    str.includes("resource_exhausted") ||
    str.includes("resourceexhausted") ||
    str.includes("too many requests")
  ) {
    return "ai_quota_exceeded";
  }

  // 4. Provider unavailable
  if (
    statusCode === 503 ||
    str.includes("unavailable") ||
    str.includes("high demand") ||
    str.includes("spikes in demand") ||
    str.includes("econnrefused") ||
    str.includes("service unavailable") ||
    str.includes("connection error") ||
    str.includes("timeout") ||
    str.includes("aborted")
  ) {
    return "ai_provider_unavailable";
  }

  // 5. Default stream error
  return "ai_stream_error";
}
