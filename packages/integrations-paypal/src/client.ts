import {
  PayPalClientError,
  PayPalRetryableError,
  PayPalUnknownOutcomeError,
  PayPalAuthError,
} from "./errors.js";
import { PayPalSandboxConfig } from "./types.js";

export class PayPalHttpClient {
  readonly baseUrl: string;
  readonly clientId: string;
  private readonly clientSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  private cachedAccessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private tokenRefreshPromise: Promise<string> | null = null;

  constructor(config: PayPalSandboxConfig) {
    if (config.environment && config.environment !== "sandbox") {
      throw new PayPalAuthError("Only PayPal sandbox environment is permitted in Epic 3; live payments are rejected");
    }

    const resolvedBaseUrl = config.baseUrl ?? "https://api-m.sandbox.paypal.com";
    if (resolvedBaseUrl.includes("api-m.paypal.com") && !resolvedBaseUrl.includes("sandbox")) {
      throw new PayPalAuthError("Production PayPal API URL is strictly prohibited in Epic 3");
    }

    this.baseUrl = resolvedBaseUrl.replace(/\/+$/, "");
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /**
   * Retrieves an OAuth 2.0 access token using client credentials.
   * Caches token until expiry minus 60 seconds.
   * Serializes token refresh to eliminate token stampede.
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedAccessToken && this.tokenExpiresAt > now) {
      return this.cachedAccessToken;
    }

    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = (async () => {
      try {
        const authHeader = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
          response = await this.fetchFn(`${this.baseUrl}/v1/oauth2/token`, {
            method: "POST",
            headers: {
              Authorization: authHeader,
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
            body: "grant_type=client_credentials",
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        const debugId = response.headers.get("paypal-debug-id") ?? undefined;

        if (!response.ok) {
          const bodyText = await response.text();
          let parsedError: Record<string, unknown> = {};
          try {
            parsedError = JSON.parse(bodyText);
          } catch {
            // raw text error
          }

          if (response.status === 401) {
            throw new PayPalAuthError(
              `PayPal authentication failed: ${parsedError.error_description || response.statusText}`,
              { debugId, httpStatus: response.status, errorCode: "AUTH_FAILURE", details: parsedError },
            );
          }

          throw new PayPalClientError(
            `Failed to obtain PayPal OAuth token: ${parsedError.error_description || response.statusText}`,
            { debugId, httpStatus: response.status, errorCode: "TOKEN_ERROR", details: parsedError },
          );
        }

        const tokenData = (await response.json()) as { access_token: string; expires_in: number };
        this.cachedAccessToken = tokenData.access_token;
        // Provider expiry minus 60 seconds safety margin
        this.tokenExpiresAt = Date.now() + Math.max(0, (tokenData.expires_in - 60)) * 1000;
        return this.cachedAccessToken;
      } finally {
        this.tokenRefreshPromise = null;
      }
    })();

    return this.tokenRefreshPromise;
  }

  /**
   * Executes an authenticated HTTP request against PayPal Sandbox REST APIs.
   * Maps status codes and transport errors to the typed error taxonomy.
   */
  async request<T>(options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    requestId?: string;
    skipAuth?: boolean;
    additionalHeaders?: Record<string, string>;
  }): Promise<{ data: T; debugId?: string; status: number }> {
    const { method, path, body, requestId, skipAuth, additionalHeaders } = options;
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...additionalHeaders,
    };

    if (!skipAuth) {
      const token = await this.getAccessToken();
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (requestId) {
      headers["PayPal-Request-Id"] = requestId;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const isAbort = (err as Error).name === "AbortError";
      const message = isAbort
        ? `PayPal HTTP request timed out after ${this.timeoutMs}ms: ${method} ${path}`
        : `PayPal transport error: ${(err as Error).message}`;

      // POST mutations that time out or drop connection have UNKNOWN outcome
      if (method === "POST") {
        throw new PayPalUnknownOutcomeError(message, {
          errorCode: isAbort ? "REQUEST_TIMEOUT" : "CONNECTION_DROPPED",
          cause: err,
        });
      }

      throw new PayPalRetryableError(message, {
        errorCode: isAbort ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        cause: err,
      });
    }

    clearTimeout(timeoutId);
    const debugId = response.headers.get("paypal-debug-id") ?? undefined;
    const status = response.status;

    if (!response.ok) {
      const responseBody = await response.text();
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = JSON.parse(responseBody);
      } catch {
        // non-JSON error
      }

      const errorMessage =
        (parsedBody.message as string) ||
        (parsedBody.error_description as string) ||
        `PayPal API returned HTTP ${status}: ${response.statusText}`;
      const errorCode = (parsedBody.name as string) || (parsedBody.error as string) || `HTTP_${status}`;

      if (status === 401) {
        throw new PayPalAuthError(errorMessage, { debugId, httpStatus: status, errorCode, details: parsedBody });
      }

      if (status === 429) {
        throw new PayPalRetryableError(`Rate limit exceeded: ${errorMessage}`, {
          debugId,
          httpStatus: status,
          errorCode: "RATE_LIMIT_EXCEEDED",
          details: parsedBody,
        });
      }

      if (status === 503) {
        throw new PayPalRetryableError(`Service unavailable: ${errorMessage}`, {
          debugId,
          httpStatus: status,
          errorCode: "SERVICE_UNAVAILABLE",
          details: parsedBody,
        });
      }

      // 500, 502, 504 on POST mutations represent unknown remote outcome
      if (method === "POST" && [500, 502, 504].includes(status)) {
        throw new PayPalUnknownOutcomeError(errorMessage, {
          debugId,
          httpStatus: status,
          errorCode: "UNKNOWN_MUTATION_OUTCOME",
          details: parsedBody,
        });
      }

      if (status >= 400 && status < 500) {
        throw new PayPalClientError(errorMessage, {
          debugId,
          httpStatus: status,
          errorCode,
          details: parsedBody,
        });
      }

      // Any other 5xx
      throw new PayPalRetryableError(errorMessage, {
        debugId,
        httpStatus: status,
        errorCode,
        details: parsedBody,
      });
    }

    // 204 No Content
    if (status === 204) {
      return { data: {} as T, debugId, status };
    }

    const data = (await response.json()) as T;
    return { data, debugId, status };
  }
}
