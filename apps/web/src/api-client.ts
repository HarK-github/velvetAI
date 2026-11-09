/// <reference types="vite/client" />
import {
  ServiceDTO,
  AvailableSlot,
  BookingQuoteDTO,
  BookingHoldResponse,
  ProblemDetails,
} from "@velvetai/contracts";
import { isAuth0Configured, isMockAuthEnabled, computeAuthDiagnostic } from "./lib/auth-config.js";

export interface ApiClientConfig {
  baseUrl?: string;
  authToken?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem: ProblemDetails,
  ) {
    super(problem.detail || problem.title);
    this.name = "ApiError";
  }
}

function getNodeProcess(): { env?: Record<string, string | undefined> } | undefined {
  if (typeof globalThis !== "undefined" && "process" in globalThis) {
    return (globalThis as Record<string, any>).process;
  }
  return undefined;
}

export function isApiConfigured(): boolean {
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  const nodeEnv = getNodeProcess()?.env;
  const envUrl = (env?.VITE_API_BASE_URL as string | undefined) ?? nodeEnv?.VITE_API_BASE_URL;

  if (envUrl && envUrl.trim().length > 0) {
    return true;
  }

  const isProd =
    (env && Boolean(env.PROD) && !env.DEV) ||
    nodeEnv?.NODE_ENV === "production" ||
    nodeEnv?.PROD === "true";

  if (isProd) {
    return false;
  }

  return true;
}

export function resolveApiBaseUrl(): string {
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  const nodeEnv = getNodeProcess()?.env;
  const envUrl = (env?.VITE_API_BASE_URL as string | undefined) ?? nodeEnv?.VITE_API_BASE_URL;

  if (envUrl && envUrl.trim().length > 0) {
    return envUrl.trim();
  }

  const isProd =
    (env && Boolean(env.PROD) && !env.DEV) ||
    nodeEnv?.NODE_ENV === "production" ||
    nodeEnv?.PROD === "true";

  if (isProd) {
    console.error(
      "API not configured: VITE_API_BASE_URL environment variable is missing in production build.",
    );
    return "";
  }

  return "http://localhost:3000";
}

export const API_BASE_URL = resolveApiBaseUrl();

export class VelvetApiClient {
  private readonly baseUrl: string;
  private authToken?: string;

  constructor(config?: ApiClientConfig) {
    this.baseUrl = config?.baseUrl ?? API_BASE_URL;
    this.authToken = config?.authToken;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private tokenProvider?: () => Promise<string | undefined>;

  setAuthToken(token: string): void {
    this.authToken = token;
    computeAuthDiagnostic(token);
  }

  getAuthToken(): string | undefined {
    return this.authToken;
  }

  setTokenProvider(provider: () => Promise<string | undefined>): void {
    this.tokenProvider = provider;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    if (!this.baseUrl) {
      console.error("API request blocked: API_BASE_URL is not configured.");
      throw new ApiError(500, {
        type: "https://api.velvetai.example/problems/unconfigured",
        title: "API Not Configured",
        status: 500,
        code: "api_not_configured",
        detail: "API not configured: VITE_API_BASE_URL must be set in production.",
      });
    }

    let token = this.authToken;

    if (this.tokenProvider) {
      try {
        const acquired = await this.tokenProvider();
        if (acquired) {
          token = acquired;
          this.authToken = acquired;
          computeAuthDiagnostic(acquired);
        }
      } catch (_err) {
        if (isAuth0Configured()) {
          throw new ApiError(401, {
            type: "https://api.velvetai.example/problems/unauthorized",
            title: "Authentication Failed",
            status: 401,
            code: "auth_token_acquisition_failed",
            detail: "Failed to acquire Auth0 access token. Please sign in again.",
          });
        }
      }
    }

    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");

    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    } else if (isAuth0Configured()) {
      // Never fall back to dev token when Auth0 is configured
      throw new ApiError(401, {
        type: "https://api.velvetai.example/problems/unauthorized",
        title: "Unauthorized",
        status: 401,
        code: "unauthorized",
        detail: "Authentication required. Please sign in with Auth0.",
      });
    } else if (isMockAuthEnabled()) {
      // Explicit offline test mode only
      headers.set(
        "authorization",
        "Bearer test-token:01932b10-0000-7000-8000-000000000002:01932b10-0000-7000-8000-000000000001:BUYER:1",
      );
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      let problem: ProblemDetails;
      try {
        problem = await response.json();
      } catch {
        problem = {
          type: "https://api.velvetai.example/problems/unknown",
          title: response.statusText || "Request failed",
          status: response.status,
          code: "unknown_error",
        };
      }
      throw new ApiError(response.status, problem);
    }

    return response.json();
  }

  async getServices(): Promise<{ services: ServiceDTO[]; total: number }> {
    return this.request<{ services: ServiceDTO[]; total: number }>("/v1/services");
  }

  async getAvailability(
    serviceId: string,
  ): Promise<{ slots: AvailableSlot[]; scheduleRevision: number }> {
    return this.request<{ slots: AvailableSlot[]; scheduleRevision: number }>(
      `/v1/availability?serviceId=${encodeURIComponent(serviceId)}`,
    );
  }

  async createBookingQuote(
    params: {
      serviceId: string;
      locationId?: string;
      startsAt: string;
      timeZone: string;
    },
    idempotencyKey?: string,
  ): Promise<BookingQuoteDTO> {
    const headers: Record<string, string> = {
      "idempotency-key":
        idempotencyKey || `quote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    return this.request<BookingQuoteDTO>("/v1/booking-quotes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        locationId: params.locationId || "01932b10-0000-7000-8000-000000000001",
        ...params,
      }),
    });
  }

  async createBookingHold(
    params: {
      quoteId: string;
      customer: { email: string; displayName?: string };
      note?: string;
    },
    idempotencyKey?: string,
  ): Promise<BookingHoldResponse> {
    const headers: Record<string, string> = {
      "idempotency-key":
        idempotencyKey || `hold-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    return this.request<BookingHoldResponse>("/v1/booking-holds", {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });
  }

  async evaluateRisk(
    params: { tier: string; leadDays?: number; customerHistoryScore?: number },
    idempotencyKey?: string,
  ): Promise<{
    noShowProbability: string;
    depositTierPercent: string;
    policyRoute: string;
    rationale: string;
  }> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers["idempotency-key"] = idempotencyKey;
    }
    return this.request<{
      noShowProbability: string;
      depositTierPercent: string;
      policyRoute: string;
      rationale: string;
    }>("/v1/risk/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });
  }

  async createPaymentOrder(
    bookingId: string,
    idempotencyKey?: string,
  ): Promise<{
    paymentIntentId: string;
    paypalOrderId: string;
    amount: { currency: string; valueMinor: string };
    status: "REQUIRES_PAYER_ACTION";
    paymentExpiresAt: string;
  }> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers["idempotency-key"] = idempotencyKey;
    }
    return this.request("/v1/bookings/" + bookingId + "/payment-order", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
  }

  async capturePayment(
    paymentIntentId: string,
    idempotencyKey?: string,
  ): Promise<{
    bookingId: string;
    bookingStatus: "CONFIRMED" | "CAPTURE_UNCERTAIN" | "CANCELLED";
    paymentStatus: "CAPTURED" | "UNCERTAIN" | "FAILED";
    providerCaptureId?: string;
    operationId?: string;
    statusUrl?: string;
    version?: number;
  }> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers["idempotency-key"] = idempotencyKey;
    }
    return this.request("/v1/payments/" + paymentIntentId + "/capture", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
  }

  async getOperation(operationId: string): Promise<{
    id: string;
    operationType: string;
    state: string;
    providerOrderId?: string;
    providerCaptureId?: string;
  }> {
    return this.request(`/v1/operations/${operationId}`);
  }

  async prepareBooking(params: {
    serviceId: string;
    locationId: string;
    startsAt: string;
    timeZone: string;
    customer: { email: string; displayName?: string };
    note?: string;
  }): Promise<{
    bookingId: string;
    status: "HELD";
    holdExpiresAt: string;
    version: number;
    intent: string;
    approvalLocator: string;
    terms: any;
  }> {
    return this.request("/v1/bookings/prepare", {
      method: "POST",
      headers: {
        "idempotency-key": `prep-${Date.now()}-${Math.random()}`,
      },
      body: JSON.stringify(params),
    });
  }

  async commitBooking(params: {
    intent: string;
    confirmation: string;
    idempotencyKey?: string;
  }): Promise<{
    bookingId: string;
    status: string;
    version: number;
  }> {
    return this.request("/v1/bookings/commit", {
      method: "POST",
      headers: {
        "idempotency-key": params.idempotencyKey || `commit-${Date.now()}-${Math.random()}`,
      },
      body: JSON.stringify({
        intent: params.intent,
        confirmation: params.confirmation,
      }),
    });
  }

  async getBooking(bookingId: string): Promise<any> {
    return this.request(`/v1/bookings/${bookingId}`);
  }
}

export const apiClient = new VelvetApiClient();
