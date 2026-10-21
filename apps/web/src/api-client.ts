/// <reference types="vite/client" />
import {
  ServiceDTO,
  AvailableSlot,
  BookingQuoteDTO,
  BookingHoldResponse,
  ProblemDetails,
} from "@velvetai/contracts";

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

export class VelvetApiClient {
  private readonly baseUrl: string;
  private authToken?: string;

  constructor(config?: ApiClientConfig) {
    const envBaseUrl = typeof import.meta.env !== "undefined"
      ? (import.meta.env.VITE_API_BASE_URL as string | undefined)
      : undefined;
    this.baseUrl = config?.baseUrl ?? envBaseUrl ?? "http://localhost:3000";
    this.authToken = config?.authToken;
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    if (this.authToken) {
      headers.set("authorization", `Bearer ${this.authToken}`);
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

  async getAvailability(serviceId: string): Promise<{ slots: AvailableSlot[]; scheduleRevision: number }> {
    return this.request<{ slots: AvailableSlot[]; scheduleRevision: number }>(
      `/v1/availability?serviceId=${encodeURIComponent(serviceId)}`,
    );
  }

  async createBookingQuote(params: {
    serviceId: string;
    locationId: string;
    startsAt: string;
    timeZone: string;
  }): Promise<BookingQuoteDTO> {
    return this.request<BookingQuoteDTO>("/v1/booking-quotes", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async createBookingHold(params: {
    quoteId: string;
    customer: { email: string; displayName?: string };
    note?: string;
  }, idempotencyKey?: string): Promise<BookingHoldResponse> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers["idempotency-key"] = idempotencyKey;
    }
    return this.request<BookingHoldResponse>("/v1/booking-holds", {
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
}

export const apiClient = new VelvetApiClient();
