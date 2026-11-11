/// <reference types="vite/client" />
import {
  ServiceDTO,
  AvailableSlot,
  BookingQuoteDTO,
  BookingHoldResponse,
  ApproveAndCommitResponse,
  ConfirmBookingApprovalResponse,
  PrepareCancellationInput,
  PrepareCancellationResponse,
  CommitCancellationInput,
  CommitCancellationResponse,
  ProblemDetails,
} from "@velvetai/contracts";
import { isAuth0Configured, isMockAuthEnabled, computeAuthDiagnostic } from "./lib/auth-config.js";

export function generateIdempotencyKey(prefix: string): string {
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "") || "idemp";
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${cleanPrefix}-${randomPart}`;
}

export interface ApiClientConfig {
  baseUrl?: string;
  authToken?: string;
}

export class ApiError extends Error {
  public readonly code?: string;

  constructor(
    public readonly status: number,
    public readonly problem: ProblemDetails,
  ) {
    super(problem.detail || problem.title);
    this.name = "ApiError";
    this.code = problem.code;
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

const IDEMPOTENCY_STORAGE_PREFIX = "velvetai_idemp_v1:";

function readStoredActionKey(actionScope: string): string | undefined {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return undefined;
  }
  try {
    const val = window.sessionStorage.getItem(`${IDEMPOTENCY_STORAGE_PREFIX}${actionScope}`);
    return val && val.trim().length > 0 ? val : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredActionKey(actionScope: string, key: string): void {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(`${IDEMPOTENCY_STORAGE_PREFIX}${actionScope}`, key);
  } catch {
    // Ignore storage quota or restricted storage errors
  }
}

function removeStoredActionKey(actionScope: string): void {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(`${IDEMPOTENCY_STORAGE_PREFIX}${actionScope}`);
  } catch {
    // Ignore storage errors
  }
}

function clearAllStoredActionKeys(): void {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return;
  }
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(IDEMPOTENCY_STORAGE_PREFIX)) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      window.sessionStorage.removeItem(k);
    }
  } catch {
    // Ignore storage errors
  }
}

export class VelvetApiClient {
  private readonly baseUrl: string;
  private authToken?: string;
  private readonly actionIdempotencyKeys = new Map<string, string>();

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

  getOrCreateActionKey(actionScope: string, prefix: string): string {
    const existing = this.actionIdempotencyKeys.get(actionScope);
    if (existing) {
      return existing;
    }
    const stored = readStoredActionKey(actionScope);
    if (stored) {
      this.actionIdempotencyKeys.set(actionScope, stored);
      return stored;
    }
    const created = generateIdempotencyKey(prefix);
    this.actionIdempotencyKeys.set(actionScope, created);
    writeStoredActionKey(actionScope, created);
    return created;
  }

  clearActionKey(actionScope: string): void {
    this.actionIdempotencyKeys.delete(actionScope);
    removeStoredActionKey(actionScope);
  }

  resetActionKeys(): void {
    this.actionIdempotencyKeys.clear();
    clearAllStoredActionKeys();
  }

  private async withRetryIdempotencyKey<T>(
    actionScope: string,
    prefix: string,
    explicitKey: string | undefined,
    fn: (idempotencyKey: string) => Promise<T>,
    options?: { keepKeyOnSuccess?: boolean },
  ): Promise<T> {
    const hasExplicit = Boolean(explicitKey && explicitKey.trim().length > 0);
    const key = hasExplicit ? explicitKey!.trim() : this.getOrCreateActionKey(actionScope, prefix);
    const result = await fn(key);
    if (!hasExplicit && !options?.keepKeyOnSuccess) {
      this.clearActionKey(actionScope);
    }
    return result;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    authTokenOverride?: string,
  ): Promise<T> {
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

    let token = authTokenOverride?.trim() ? authTokenOverride.trim() : this.authToken;

    if (!authTokenOverride?.trim() && this.tokenProvider) {
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

    const method = (options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");

    // Invariant: EVERY mutating request must carry a non-empty Idempotency-Key
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const existingKey = headers.get("idempotency-key");
      if (!existingKey || existingKey.trim().length === 0) {
        headers.set("Idempotency-Key", generateIdempotencyKey("req"));
      }
    }

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
    const locationId = params.locationId || "01932b10-0000-7000-8000-000000000001";
    const actionScope = `quote:${params.serviceId}:${locationId}:${params.startsAt}:${params.timeZone}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "quote",
      idempotencyKey,
      (key) =>
        this.request<BookingQuoteDTO>("/v1/booking-quotes", {
          method: "POST",
          headers: {
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            locationId,
            ...params,
          }),
        }),
      { keepKeyOnSuccess: false },
    );
  }

  async prepareBooking(
    params: {
      serviceId: string;
      locationId: string;
      startsAt: string;
      timeZone: string;
      customer: { email: string; displayName?: string };
      note?: string;
    },
    clientId: string = "ask-ai",
    idempotencyKey?: string,
  ): Promise<any> {
    const actionScope = `prepare:${params.serviceId}:${params.locationId}:${params.startsAt}:${params.customer.email}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "prep",
      idempotencyKey,
      (key) =>
        this.request<any>("/v1/bookings/prepare", {
          method: "POST",
          headers: {
            "x-client-id": clientId,
            "Idempotency-Key": key,
          },
          body: JSON.stringify(params),
        }),
      { keepKeyOnSuccess: false },
    );
  }

  async createBookingHold(
    params: {
      quoteId?: string;
      serviceId?: string;
      locationId?: string;
      startsAt?: string;
      timeZone?: string;
      customer: { email: string; displayName?: string };
      note?: string;
    },
    idempotencyKey?: string,
  ): Promise<BookingHoldResponse> {
    const actionScope = `hold:${params.quoteId || params.serviceId || "slot"}:${params.startsAt || ""}:${params.customer.email}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "hold",
      idempotencyKey,
      (key) =>
        this.request<BookingHoldResponse>("/v1/booking-holds", {
          method: "POST",
          headers: {
            "Idempotency-Key": key,
          },
          body: JSON.stringify(params),
        }),
      { keepKeyOnSuccess: false },
    );
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
    const actionScope = `risk:${params.tier}:${params.leadDays ?? ""}:${params.customerHistoryScore ?? ""}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "risk",
      idempotencyKey,
      (key) =>
        this.request<{
          noShowProbability: string;
          depositTierPercent: string;
          policyRoute: string;
          rationale: string;
        }>("/v1/risk/evaluate", {
          method: "POST",
          headers: {
            "Idempotency-Key": key,
          },
          body: JSON.stringify(params),
        }),
      { keepKeyOnSuccess: false },
    );
  }

  async approveAndCommit(
    locator: string,
    idempotencyKey?: string,
    authTokenOverride?: string,
  ): Promise<ApproveAndCommitResponse> {
    const cleanLocator = locator.replace(/^.*\/v1\/booking-approvals\//, "").trim();
    const actionScope = `approve-and-commit:${cleanLocator}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "approve",
      idempotencyKey,
      (key) =>
        this.request<ApproveAndCommitResponse>(
          `/v1/booking-approvals/${cleanLocator}/approve-and-commit`,
          {
            method: "POST",
            headers: {
              "Idempotency-Key": key,
            },
            body: JSON.stringify({}),
          },
          authTokenOverride,
        ),
      { keepKeyOnSuccess: true },
    );
  }

  async confirmApproval(
    locator: string,
    idempotencyKey?: string,
    authTokenOverride?: string,
  ): Promise<ConfirmBookingApprovalResponse> {
    const cleanLocator = locator.replace(/^.*\/v1\/booking-approvals\//, "").trim();
    const actionScope = `confirm-approval:${cleanLocator}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "confirm",
      idempotencyKey,
      (key) =>
        this.request<ConfirmBookingApprovalResponse>(
          `/v1/booking-approvals/${cleanLocator}/confirm`,
          {
            method: "POST",
            headers: {
              "Idempotency-Key": key,
            },
            body: JSON.stringify({}),
          },
          authTokenOverride,
        ),
      { keepKeyOnSuccess: true },
    );
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
    const actionScope = `payment-order:${bookingId}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "pay-order",
      idempotencyKey,
      (key) =>
        this.request("/v1/bookings/" + bookingId + "/payment-order", {
          method: "POST",
          headers: {
            "Idempotency-Key": key,
          },
          body: JSON.stringify({}),
        }),
      { keepKeyOnSuccess: true },
    );
  }

  async capturePayment(
    paymentIntentId: string,
    idempotencyKey?: string,
  ): Promise<{
    bookingId: string;
    bookingStatus: "CONFIRMED" | "CAPTURE_UNCERTAIN" | "PAYMENT_FAILED" | "CANCELLED";
    paymentStatus: "CAPTURED" | "UNCERTAIN" | "FAILED";
    providerCaptureId?: string;
    operationId?: string;
    statusUrl?: string;
    version?: number;
  }> {
    const actionScope = `capture:${paymentIntentId}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "capture",
      idempotencyKey,
      (key) =>
        this.request("/v1/payments/" + paymentIntentId + "/capture", {
          method: "POST",
          headers: {
            "Idempotency-Key": key,
          },
          body: JSON.stringify({}),
        }),
      { keepKeyOnSuccess: true },
    );
  }

  async prepareCancellation(
    bookingId: string,
    params: PrepareCancellationInput = {},
    idempotencyKey?: string,
  ): Promise<PrepareCancellationResponse> {
    const actionScope = `prepare-cancel:${bookingId}:${params.reason || ""}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "cancel-prep",
      idempotencyKey,
      (key) =>
        this.request<PrepareCancellationResponse>(
          `/v1/bookings/${bookingId}/prepare-cancellation`,
          {
            method: "POST",
            headers: {
              "Idempotency-Key": key,
            },
            body: JSON.stringify(params),
          },
        ),
      { keepKeyOnSuccess: false },
    );
  }

  async cancelBooking(
    bookingId: string,
    params: CommitCancellationInput,
    idempotencyKey?: string,
  ): Promise<CommitCancellationResponse> {
    const actionScope = `cancel:${bookingId}:${params.cancellationConfirmationToken}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "cancel",
      idempotencyKey,
      (key) =>
        this.request<CommitCancellationResponse>(`/v1/bookings/${bookingId}/cancel`, {
          method: "POST",
          headers: {
            "Idempotency-Key": key,
          },
          body: JSON.stringify(params),
        }),
      { keepKeyOnSuccess: true },
    );
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

  async commitBooking(params: {
    intent: string;
    confirmation: string;
    idempotencyKey?: string;
  }): Promise<{
    bookingId: string;
    status: string;
    version: number;
  }> {
    const actionScope = `commit:${params.intent}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "commit",
      params.idempotencyKey,
      (key) =>
        this.request("/v1/bookings/commit", {
          method: "POST",
          headers: {
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            intent: params.intent,
            confirmation: params.confirmation,
          }),
        }),
      { keepKeyOnSuccess: true },
    );
  }

  async getBooking(bookingId: string): Promise<any> {
    return this.request(`/v1/bookings/${bookingId}`);
  }
}

export const apiClient = new VelvetApiClient();
