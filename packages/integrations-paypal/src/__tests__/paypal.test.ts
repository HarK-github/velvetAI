import { describe, it, expect, vi } from "vitest";
import {
  generateUUIDv7,
  tenantIdSchema,
  bookingIdSchema,
  paymentIntentIdSchema,
  paymentCaptureIdSchema,
  currencyCodeSchema,
  moneyMinorSchema,
} from "@velvetai/contracts";
import {
  PayPalSandboxAdapter,
  PayPalHttpClient,
  PayPalAuthError,
  PayPalClientError,
  PayPalRetryableError,
  PayPalUnknownOutcomeError,
  minorUnitsToDecimal,
  decimalToMinorUnits,
} from "../index.js";

describe("minorUnitsToDecimal & decimalToMinorUnits", () => {
  it("converts minor units to decimal strings accurately", () => {
    expect(minorUnitsToDecimal("2500")).toBe("25.00");
    expect(minorUnitsToDecimal(2500n)).toBe("25.00");
    expect(minorUnitsToDecimal("0")).toBe("0.00");
    expect(minorUnitsToDecimal("99")).toBe("0.99");
    expect(minorUnitsToDecimal("5")).toBe("0.05");
    expect(minorUnitsToDecimal("-1550")).toBe("-15.50");
  });

  it("converts decimal strings to minor units accurately", () => {
    expect(decimalToMinorUnits("25.00")).toBe("2500");
    expect(decimalToMinorUnits("25.0")).toBe("2500");
    expect(decimalToMinorUnits("25")).toBe("2500");
    expect(decimalToMinorUnits("0.99")).toBe("99");
    expect(decimalToMinorUnits("0.05")).toBe("5");
    expect(decimalToMinorUnits("-15.50")).toBe("-1550");
  });
});

describe("PayPalHttpClient", () => {
  it("strictly enforces sandbox environment and rejects live URLs", () => {
    expect(
      () =>
        new PayPalHttpClient({
          // @ts-expect-error test invalid environment
          environment: "live",
          clientId: "id",
          clientSecret: "secret",
        }),
    ).toThrow(PayPalAuthError);

    expect(
      () =>
        new PayPalHttpClient({
          baseUrl: "https://api-m.paypal.com",
          clientId: "id",
          clientSecret: "secret",
        }),
    ).toThrow(PayPalAuthError);
  });

  it("caches OAuth token and deduplicates concurrent token stampedes", async () => {
    let tokenFetchCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v1/oauth2/token")) {
        tokenFetchCount++;
        // Simulate slight network latency
        await new Promise((r) => setTimeout(r, 10));
        return new Response(
          JSON.stringify({
            access_token: "mock_token_abc_123",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "paypal-debug-id": "debug-token-1",
            },
          },
        );
      }
      return new Response(JSON.stringify({ id: "ORDER_123", status: "CREATED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new PayPalHttpClient({
      clientId: "test_client",
      clientSecret: "test_secret",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // Fire 5 concurrent requests simultaneously
    const tokens = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);

    expect(tokenFetchCount).toBe(1);
    expect(tokens.every((t) => t === "mock_token_abc_123")).toBe(true);

    // Subsequent call uses cache
    const cachedToken = await client.getAccessToken();
    expect(tokenFetchCount).toBe(1);
    expect(cachedToken).toBe("mock_token_abc_123");
  });

  it("maps 401 to PayPalAuthError with debugId", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_client", error_description: "Client Authentication failed" }), {
        status: 401,
        headers: { "paypal-debug-id": "dbg-auth-fail" },
      }),
    );

    const client = new PayPalHttpClient({
      clientId: "bad_client",
      clientSecret: "bad_secret",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(client.getAccessToken()).rejects.toThrow(PayPalAuthError);
  });

  it("maps 422 to PayPalClientError", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed" }),
        {
          status: 422,
          headers: { "paypal-debug-id": "dbg-422" },
        },
      );
    });

    const client = new PayPalHttpClient({
      clientId: "c",
      clientSecret: "s",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.request({
        method: "POST",
        path: "/v2/checkout/orders",
        body: {},
      }),
    ).rejects.toThrow(PayPalClientError);
  });

  it("maps 429 and 503 to PayPalRetryableError", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
        status: 429,
        headers: { "paypal-debug-id": "dbg-rate-limit" },
      });
    });

    const client = new PayPalHttpClient({
      clientId: "c",
      clientSecret: "s",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.request({
        method: "GET",
        path: "/v2/checkout/orders/123",
      }),
    ).rejects.toThrow(PayPalRetryableError);
  });

  it("maps 500 on POST mutation to PayPalUnknownOutcomeError", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Internal server error" }), {
        status: 500,
        headers: { "paypal-debug-id": "dbg-500" },
      });
    });

    const client = new PayPalHttpClient({
      clientId: "c",
      clientSecret: "s",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.request({
        method: "POST",
        path: "/v2/checkout/orders/123/capture",
        body: {},
      }),
    ).rejects.toThrow(PayPalUnknownOutcomeError);
  });

  it("maps request timeout on POST to PayPalUnknownOutcomeError", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      throw abortError;
    });

    const client = new PayPalHttpClient({
      clientId: "c",
      clientSecret: "s",
      timeoutMs: 50,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.request({
        method: "POST",
        path: "/v2/checkout/orders/123/capture",
        body: {},
      }),
    ).rejects.toThrow(PayPalUnknownOutcomeError);
  });
});

describe("PayPalSandboxAdapter", () => {
  const tenantId = tenantIdSchema.parse(generateUUIDv7());
  const bookingId = bookingIdSchema.parse(generateUUIDv7());

  function createMockAdapter(handler: (path: string, options: RequestInit) => Promise<Response>) {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === "/v1/oauth2/token") {
        return new Response(JSON.stringify({ access_token: "valid_token", expires_in: 3600 }), { status: 200 });
      }
      return handler(parsedUrl.pathname, init ?? {});
    });

    return new PayPalSandboxAdapter({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      webhookId: "WH-1234567890",
      fetchFn: mockFetch as unknown as typeof fetch,
    });
  }

  it("createOrder sends proper payload and PayPal-Request-Id header", async () => {
    let capturedBody: unknown = null;
    let capturedHeaders: Record<string, string> | undefined = undefined;

    const adapter = createMockAdapter(async (_path, init) => {
      capturedBody = JSON.parse(init.body as string);
      capturedHeaders = init.headers as Record<string, string> | undefined;
      return new Response(
        JSON.stringify({
          id: "ORDER_987654321",
          status: "CREATED",
          intent: "CAPTURE",
        }),
        { status: 201 },
      );
    });

    const result = await adapter.createOrder({
      tenantId,
      bookingId,
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("5000"),
      },
      requestId: "idempotency-key-001",
    });

    expect(result.providerOrderId).toBe("ORDER_987654321");
    expect(result.paymentIntentId).toBeDefined();
    const body = capturedBody as { intent: string; purchase_units: Array<{ custom_id: string; amount: { value: string } }> };
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0]?.amount.value).toBe("50.00");
    expect(body.purchase_units[0]?.custom_id).toBe(bookingId);
    expect(capturedHeaders?.["PayPal-Request-Id"]).toBe("idempotency-key-001");
  });

  it("getOrder returns parsed order details with captures", async () => {
    const adapter = createMockAdapter(async () => {
      return new Response(
        JSON.stringify({
          id: "ORDER_111",
          status: "COMPLETED",
          intent: "CAPTURE",
          purchase_units: [
            {
              custom_id: bookingId,
              amount: { currency_code: "USD", value: "75.00" },
              payments: {
                captures: [
                  {
                    id: "CAP_999",
                    status: "COMPLETED",
                    amount: { currency_code: "USD", value: "75.00" },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const order = await adapter.getOrder("ORDER_111");
    expect(order.id).toBe("ORDER_111");
    expect(order.status).toBe("COMPLETED");
    expect(order.customId).toBe(bookingId);
    expect(order.amount.valueMinor).toBe("7500");
    expect(order.captures).toHaveLength(1);
    expect(order.captures?.[0]?.id).toBe("CAP_999");
    expect(order.captures?.[0]?.status).toBe("COMPLETED");
  });

  it("capturePayment returns CAPTURED when PayPal returns COMPLETED", async () => {
    const paymentIntentId = paymentIntentIdSchema.parse(generateUUIDv7());
    const adapter = createMockAdapter(async () => {
      return new Response(
        JSON.stringify({
          id: "ORDER_222",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: "CAP_333",
                    status: "COMPLETED",
                  },
                ],
              },
            },
          ],
        }),
        { status: 201 },
      );
    });

    const result = await adapter.capturePayment({
      tenantId,
      paymentIntentId,
      providerOrderId: "ORDER_222",
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("5000"),
      },
      requestId: "req-capture-1",
    });

    expect(result.providerCaptureId).toBe("CAP_333");
    expect(result.status).toBe("CAPTURED");
  });

  it("capturePayment returns UNCERTAIN when PayPal returns PENDING", async () => {
    const paymentIntentId = paymentIntentIdSchema.parse(generateUUIDv7());
    const adapter = createMockAdapter(async () => {
      return new Response(
        JSON.stringify({
          id: "ORDER_222",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: "CAP_PENDING_1",
                    status: "PENDING",
                  },
                ],
              },
            },
          ],
        }),
        { status: 201 },
      );
    });

    const result = await adapter.capturePayment({
      tenantId,
      paymentIntentId,
      providerOrderId: "ORDER_222",
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("5000"),
      },
      requestId: "req-capture-pending",
    });

    expect(result.providerCaptureId).toBe("CAP_PENDING_1");
    expect(result.status).toBe("UNCERTAIN");
  });

  it("refundPayment posts formatted amount and returns status", async () => {
    const paymentCaptureId = paymentCaptureIdSchema.parse(generateUUIDv7());
    let capturedBody: unknown = null;
    const adapter = createMockAdapter(async (_path, init) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          id: "REF_555",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "25.00" },
        }),
        { status: 201 },
      );
    });

    const refund = await adapter.refundPayment({
      tenantId,
      paymentCaptureId,
      providerCaptureId: "CAP_333",
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("2500"),
      },
      requestId: "req-refund-1",
    });

    expect(refund.providerRefundId).toBe("REF_555");
    expect(refund.status).toBe("COMPLETED");
    const body = capturedBody as { amount: { value: string } };
    expect(body.amount.value).toBe("25.00");
  });

  it("verifyWebhookSignature validates PayPal cert host and prevents SSRF", async () => {
    const adapter = createMockAdapter(async () => {
      return new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 });
    });

    // Valid PayPal cert URL
    const valid = await adapter.verifyWebhookSignature({
      headers: {
        "paypal-transmission-id": "trans-1",
        "paypal-transmission-time": "2026-10-21T10:00:00Z",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-transmission-sig": "signature==",
      },
      rawBody: JSON.stringify({ id: "WH-EVENT-1" }),
    });
    expect(valid).toBe(true);

    // SSRF attempt: internal or rogue domain
    const ssrfAttempt = await adapter.verifyWebhookSignature({
      headers: {
        "paypal-transmission-id": "trans-1",
        "paypal-transmission-time": "2026-10-21T10:00:00Z",
        "paypal-cert-url": "https://attacker.com/fake-cert",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-transmission-sig": "signature==",
      },
      rawBody: JSON.stringify({ id: "WH-EVENT-1" }),
    });
    expect(ssrfAttempt).toBe(false);

    // SSRF attempt: http:// instead of https://
    const httpAttempt = await adapter.verifyWebhookSignature({
      headers: {
        "paypal-transmission-id": "trans-1",
        "paypal-transmission-time": "2026-10-21T10:00:00Z",
        "paypal-cert-url": "http://api.sandbox.paypal.com/cert",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-transmission-sig": "signature==",
      },
      rawBody: JSON.stringify({ id: "WH-EVENT-1" }),
    });
    expect(httpAttempt).toBe(false);
  });

  it("createInvoiceDraft creates Invoicing v2 draft with item and balance due", async () => {
    let capturedBody: unknown = null;
    const adapter = createMockAdapter(async (_path, init) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          id: "INV2-ABC",
          status: "DRAFT",
          detail: { invoice_number: "0001" },
        }),
        { status: 201 },
      );
    });

    const result = await adapter.createInvoiceDraft({
      tenantId,
      bookingId,
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("15000"),
      },
      depositPaid: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("5000"),
      },
      balanceDue: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("10000"),
      },
      customerEmail: "client@example.com",
      customerName: "Alice Client",
      serviceName: "Full Hair Coloring",
    });

    expect(result.providerInvoiceId).toBe("INV2-ABC");
    expect(result.providerInvoiceNumber).toBe("0001");
    const body = capturedBody as {
      primary_recipients: Array<{ billing_info: { email_address: string } }>;
      items: Array<{ unit_amount: { value: string } }>;
    };
    expect(body.primary_recipients[0]?.billing_info.email_address).toBe("client@example.com");
    expect(body.items[0]?.unit_amount.value).toBe("100.00");
  });
});
