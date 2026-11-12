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
  TriggerLiveAbuseRunResponse,
  ScheduleResponse,
  RaceTestResponse,
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
  public readonly retryAfterSeconds?: number;

  constructor(
    public readonly status: number,
    public readonly problem: ProblemDetails,
    retryAfterSeconds?: number,
  ) {
    super(problem.detail || problem.title);
    this.name = "ApiError";
    this.code = problem.code;
    this.retryAfterSeconds = retryAfterSeconds;
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

  private ensureBaseUrl(): void {
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
  }

  private async resolveAuthToken(authTokenOverride?: string): Promise<string | undefined> {
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

    return token;
  }

  private resolveAuthorizationHeader(token: string | undefined): string | undefined {
    if (token) {
      return `Bearer ${token}`;
    }
    if (isAuth0Configured()) {
      // Never fall back to dev token when Auth0 is configured
      throw new ApiError(401, {
        type: "https://api.velvetai.example/problems/unauthorized",
        title: "Unauthorized",
        status: 401,
        code: "unauthorized",
        detail: "Authentication required. Please sign in with Auth0.",
      });
    }
    if (isMockAuthEnabled()) {
      // Explicit offline test mode only
      return "Bearer test-token:01932b10-0000-7000-8000-000000000002:01932b10-0000-7000-8000-000000000001:BUYER:1";
    }
    return undefined;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    authTokenOverride?: string,
  ): Promise<T> {
    this.ensureBaseUrl();

    const token = await this.resolveAuthToken(authTokenOverride);
    const authorization = this.resolveAuthorizationHeader(token);

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

    if (authorization) {
      headers.set("authorization", authorization);
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
      const rawRetryAfter = response.headers?.get?.("retry-after");
      const retryAfterSeconds =
        rawRetryAfter && /^\d+$/.test(rawRetryAfter.trim())
          ? Number.parseInt(rawRetryAfter.trim(), 10)
          : undefined;
      throw new ApiError(response.status, problem, retryAfterSeconds);
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

  /**
   * Triggers a live Judge Abuse Lab verification run using a reusable per-action Idempotency-Key.
   */
  async triggerLiveAbuseRun(
    authTokenOverride?: string,
    idempotencyKey?: string,
  ): Promise<
    | { kind: "started"; data: TriggerLiveAbuseRunResponse }
    | { kind: "rate_limited"; detail: string }
    | { kind: "unauthorized" }
  > {
    this.ensureBaseUrl();
    const token = await this.resolveAuthToken(authTokenOverride);
    const authorization = this.resolveAuthorizationHeader(token);

    return this.withRetryIdempotencyKey(
      "live-abuse:run",
      "live-abuse",
      idempotencyKey,
      async (key) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        };
        if (authorization) {
          headers.Authorization = authorization;
        }

        const res = await fetch(`${this.baseUrl}/v1/judge/abuse-lab/runs`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        });

        if (res.status === 429) {
          const retryAfter = res.headers?.get?.("retry-after") || "30";
          const body = await res.json().catch(() => null);
          return {
            kind: "rate_limited" as const,
            detail:
              body?.detail ||
              `Live checks are rate-limited to 1 run per 30 seconds. Retry after ${retryAfter}s.`,
          };
        }

        if (res.status === 401 || res.status === 403) {
          return { kind: "unauthorized" as const };
        }

        if (!res.ok) {
          let problem: ProblemDetails;
          try {
            problem = await res.json();
          } catch {
            problem = {
              type: "https://api.velvetai.example/problems/unknown",
              title: res.statusText || `Failed with HTTP ${res.status}`,
              status: res.status,
              code: "unknown_error",
            };
          }
          throw new ApiError(res.status, problem);
        }

        const data = (await res.json()) as TriggerLiveAbuseRunResponse;
        return { kind: "started" as const, data };
      },
      { keepKeyOnSuccess: false },
    );
  }

  /**
   * Fetches the Bryntum Scheduler read model (`GET /v1/merchant/schedule`), supporting ETag/304
   * and unauthenticated public demo mode (`?public=true`).
   */
  async getMerchantSchedule(params: {
    from: string;
    to: string;
    etag?: string | null;
    publicMode?: boolean;
  }): Promise<
    | { kind: "ok"; data: ScheduleResponse; etag: string | null }
    | { kind: "not_modified"; etag: string | null }
  > {
    this.ensureBaseUrl();

    const query = new URLSearchParams({
      from: params.from,
      to: params.to,
    });
    if (params.publicMode) {
      query.set("public", "true");
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (!params.publicMode) {
      const token = await this.resolveAuthToken();
      const authorization = this.resolveAuthorizationHeader(token);
      if (authorization) {
        headers.Authorization = authorization;
      }
    }

    if (params.etag) {
      headers["If-None-Match"] = params.etag;
    }

    const res = await fetch(`${this.baseUrl}/v1/merchant/schedule?${query.toString()}`, {
      method: "GET",
      headers,
    });

    const responseEtag = res.headers?.get?.("etag") ?? null;
    if (res.status === 304) {
      return {
        kind: "not_modified",
        etag: responseEtag ?? params.etag ?? null,
      };
    }

    if (!res.ok) {
      let problem: ProblemDetails;
      try {
        problem = await res.json();
      } catch {
        problem = {
          type: "https://api.velvetai.example/problems/unknown",
          title: res.statusText || "Request failed",
          status: res.status,
          code: "unknown_error",
        };
      }
      const rawRetryAfter = res.headers?.get?.("retry-after");
      const retryAfterSeconds =
        rawRetryAfter && /^\d+$/.test(rawRetryAfter.trim())
          ? Number.parseInt(rawRetryAfter.trim(), 10)
          : undefined;
      throw new ApiError(res.status, problem, retryAfterSeconds);
    }

    const data = (await res.json()) as ScheduleResponse;
    return {
      kind: "ok",
      data,
      etag: responseEtag ?? `"${data.scheduleRevision}"`,
    };
  }

  /**
   * Triggers N parallel hold attempts on a single slot via the production PostgreSQL GiST path.
   */
  async runRaceTest(
    params: {
      resourceId?: string;
      serviceId?: string;
      startsAt?: string;
      parallel?: number;
    } = {},
    idempotencyKey?: string,
  ): Promise<RaceTestResponse> {
    const actionScope = `judge:race-test:${params.resourceId || "default"}:${params.startsAt || "auto"}`;
    return this.withRetryIdempotencyKey(
      actionScope,
      "race-test",
      idempotencyKey,
      (key) =>
        this.request<RaceTestResponse>("/v1/judge/race-test", {
          method: "POST",
          headers: {
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            parallel: params.parallel ?? 20,
            ...(params.resourceId ? { resourceId: params.resourceId } : {}),
            ...(params.serviceId ? { serviceId: params.serviceId } : {}),
            ...(params.startsAt ? { startsAt: params.startsAt } : {}),
          }),
        }),
      { keepKeyOnSuccess: false },
    );
  }
}

export const apiClient = new VelvetApiClient();
