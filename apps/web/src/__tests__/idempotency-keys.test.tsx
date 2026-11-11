/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import * as fs from "node:fs";
import * as path from "node:path";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { VelvetApiClient, apiClient } from "../api-client.js";
import { PayPalButton } from "../components/PayPalButton.js";
import { ApprovalPage } from "../pages/ApprovalPage.js";

const mockLoginWithRedirect = vi.fn();
const mockGetAccessTokenSilently = vi.fn().mockResolvedValue("eyJ.mock.jwt");

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { sub: "auth0|buyer-e2e", email: "buyer@velvetai.example", name: "Buyer E2E" },
    loginWithRedirect: mockLoginWithRedirect,
    getAccessTokenSilently: mockGetAccessTokenSilently,
  }),
}));

vi.mock("../router.js", () => ({
  Link: ({ to, children, className }: any) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

describe("Idempotency-Key Enforcement & Retry Reuse Across Web App", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    apiClient.setAuthToken("");
    apiClient.resetActionKeys();
    delete (globalThis as any).window.paypal;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    apiClient.setAuthToken("");
    apiClient.resetActionKeys();
    delete (globalThis as any).window.paypal;
  });

  it("1. Fails if any mutating POST/PUT/PATCH/DELETE in apps/web/src is outside api-client.ts", () => {
    const srcDir = path.resolve(__dirname, "..");
    const violations: Array<{ file: string; line: number; text: string }> = [];

    function scan(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue;
          scan(fullPath);
        } else if (entry.isFile()) {
          if (
            entry.name === "api-client.ts" ||
            entry.name.endsWith(".test.ts") ||
            entry.name.endsWith(".test.tsx")
          ) {
            continue;
          }
          const lines = fs.readFileSync(fullPath, "utf-8").split("\n");
          lines.forEach((line, idx) => {
            if (/method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/i.test(line)) {
              violations.push({
                file: path.relative(srcDir, fullPath),
                line: idx + 1,
                text: line.trim(),
              });
            }
          });
        }
      }
    }

    scan(srcDir);
    expect(violations).toEqual([]);
  });

  it("2. Fails if any mutating VelvetApiClient method or HTTP call lacks a non-empty Idempotency-Key", async () => {
    const recordedCalls: Array<{ method: string; url: string; idempotencyKey: string | null }> = [];

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const key = headers.get("idempotency-key");

      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        // Hard invariant check inside fetch spy: fail immediately if Idempotency-Key is absent
        expect(key, `Missing Idempotency-Key on ${method} ${url}`).toBeTruthy();
        expect(key!.trim().length, `Empty Idempotency-Key on ${method} ${url}`).toBeGreaterThan(0);
      }

      recordedCalls.push({ method, url, idempotencyKey: key });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    }) as any;

    const client = new VelvetApiClient({
      baseUrl: "https://api.velvetai.example",
      authToken: "eyJ.test.jwt",
    });

    await client.createPaymentOrder("bk_1");
    await client.capturePayment("pi_1");
    await client.approveAndCommit("loc_1");
    await client.confirmApproval("loc_1");
    await client.createBookingQuote({
      serviceId: "svc_1",
      locationId: "loc_1",
      startsAt: "2026-11-12T18:00:00.000Z",
      timeZone: "America/New_York",
    });
    await client.prepareBooking({
      serviceId: "svc_1",
      locationId: "loc_1",
      startsAt: "2026-11-12T18:00:00.000Z",
      timeZone: "America/New_York",
      customer: { email: "buyer@velvetai.example" },
    });
    await client.createBookingHold({
      quoteId: "q_1",
      customer: { email: "buyer@velvetai.example" },
    });
    await client.commitBooking({ intent: "int_1", confirmation: "conf_1" });
    await client.evaluateRisk({ tier: "low" });
    await client.prepareCancellation("bk_1", { reason: "reschedule" });
    await client.cancelBooking("bk_1", { cancellationConfirmationToken: "cancel_tok_1" });
    await client.triggerLiveAbuseRun("eyJ.test.jwt");

    // Also verify raw mutating methods via internal request guard (POST/PUT/PATCH/DELETE)
    await (client as any).request("/v1/custom-post", { method: "POST", body: "{}" });
    await (client as any).request("/v1/custom-put", { method: "PUT", body: "{}" });
    await (client as any).request("/v1/custom-patch", { method: "PATCH", body: "{}" });
    await (client as any).request("/v1/custom-delete", { method: "DELETE" });

    expect(recordedCalls.length).toBe(16);
    for (const call of recordedCalls) {
      expect(call.idempotencyKey).toBeTruthy();
    }
  });

  it("3. Reuses the exact same Idempotency-Key when retrying failed mutating actions", async () => {
    const keysByUrl = new Map<string, string[]>();
    let orderAttempt = 0;
    let captureAttempt = 0;
    let quoteAttempt = 0;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const key = headers.get("idempotency-key") || "";
      const list = keysByUrl.get(url) || [];
      list.push(key);
      keysByUrl.set(url, list);

      if (url.endsWith("/payment-order")) {
        orderAttempt++;
        if (orderAttempt === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            json: () => Promise.resolve({ title: "Transient Error", status: 500 }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ paymentIntentId: "pi_r1", paypalOrderId: "ORD_R1" }),
        });
      }

      if (url.endsWith("/capture")) {
        captureAttempt++;
        if (captureAttempt === 1) {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            json: () => Promise.resolve({ title: "Gateway Timeout", status: 503 }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              bookingId: "bk_r1",
              bookingStatus: "CONFIRMED",
              paymentStatus: "CAPTURED",
            }),
        });
      }

      if (url.endsWith("/v1/booking-quotes")) {
        quoteAttempt++;
        if (quoteAttempt === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            json: () => Promise.resolve({ title: "Transient Error", status: 500 }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ quoteId: `q_${quoteAttempt}` }),
        });
      }

      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }) as any;

    const client = new VelvetApiClient({
      baseUrl: "https://api.velvetai.example",
      authToken: "eyJ.test.jwt",
    });

    // Payment order retry reuses identical key
    await expect(client.createPaymentOrder("bk_r1")).rejects.toThrow();
    await client.createPaymentOrder("bk_r1");
    const orderKeys = keysByUrl.get(
      "https://api.velvetai.example/v1/bookings/bk_r1/payment-order",
    )!;
    expect(orderKeys.length).toBe(2);
    expect(orderKeys[0]).toBe(orderKeys[1]);

    // Capture retry reuses identical key
    await expect(client.capturePayment("pi_r1")).rejects.toThrow();
    await client.capturePayment("pi_r1");
    const captureKeys = keysByUrl.get("https://api.velvetai.example/v1/payments/pi_r1/capture")!;
    expect(captureKeys.length).toBe(2);
    expect(captureKeys[0]).toBe(captureKeys[1]);

    // Quote retry after failure reuses key; subsequent fresh quote after 2xx gets a NEW key
    const quoteParams = {
      serviceId: "svc_1",
      locationId: "loc_1",
      startsAt: "2026-11-12T18:00:00.000Z",
      timeZone: "America/New_York",
    };
    await expect(client.createBookingQuote(quoteParams)).rejects.toThrow();
    await client.createBookingQuote(quoteParams); // retry -> same key
    await client.createBookingQuote(quoteParams); // fresh refresh after previous 2xx -> new key
    const quoteKeys = keysByUrl.get("https://api.velvetai.example/v1/booking-quotes")!;
    expect(quoteKeys.length).toBe(3);
    expect(quoteKeys[0]).toBe(quoteKeys[1]);
    expect(quoteKeys[2]).not.toBe(quoteKeys[1]);
  });

  it("4. PayPalButton sends Idempotency-Key on payment-order and capture and reuses keys on retry", async () => {
    apiClient.setAuthToken("eyJ.paypal.jwt");

    const orderKeys: string[] = [];
    const captureKeys: string[] = [];
    let orderCallCount = 0;
    let captureCallCount = 0;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const key = headers.get("idempotency-key") || "";

      if (url.includes("/payment-order")) {
        orderCallCount++;
        orderKeys.push(key);
        if (orderCallCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ title: "Transient payment init error", status: 500 }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              paymentIntentId: "pi_paypal_btn_1",
              paypalOrderId: "PAYPAL_ORD_1",
              amount: { currency: "USD", valueMinor: "2000" },
              status: "REQUIRES_PAYER_ACTION",
              paymentExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            }),
        });
      }

      if (url.includes("/capture")) {
        captureCallCount++;
        captureKeys.push(key);
        if (captureCallCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () => Promise.resolve({ title: "Capture network glitch", status: 503 }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              bookingId: "bk_paypal_btn_1",
              bookingStatus: "CONFIRMED",
              paymentStatus: "CAPTURED",
              providerCaptureId: "CAP_OK_1",
            }),
        });
      }

      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }) as any;

    const onOutcome = vi.fn();
    render(<PayPalButton bookingId="bk_paypal_btn_1" onPaymentOutcome={onOutcome} />);

    // Initial mount payment-order fails transiently (with Idempotency-Key)
    await waitFor(() => {
      expect(screen.getByText(/Transient payment init error/i)).toBeDefined();
    });
    expect(orderKeys.length).toBe(1);
    expect(orderKeys[0]).toMatch(/^pay-order-/);

    // Click Pay -> retries payment-order with SAME key, then tries capture (fails once)
    const payBtn = screen.getByRole("button", { name: /Authorize & Capture via PayPal Sandbox/i });
    fireEvent.click(payBtn);

    await waitFor(() => {
      expect(screen.getByText(/Capture network glitch/i)).toBeDefined();
    });
    expect(orderKeys.length).toBe(2);
    expect(orderKeys[1]).toBe(orderKeys[0]);
    expect(captureKeys.length).toBe(1);
    expect(captureKeys[0]).toMatch(/^capture-/);

    // Retry capture -> reuses SAME capture Idempotency-Key and confirms!
    fireEvent.click(payBtn);
    await waitFor(() => {
      expect(onOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "bk_paypal_btn_1",
          bookingStatus: "CONFIRMED",
          paymentStatus: "CAPTURED",
        }),
      );
    });
    expect(captureKeys.length).toBe(2);
    expect(captureKeys[1]).toBe(captureKeys[0]);
    expect(orderKeys.length).toBe(2); // Did not create a second order!
  });

  it("5. ApprovalPage full c5 flow sends Idempotency-Key on approve-and-commit, payment-order, and capture (and reuses keys across Try again remount)", async () => {
    const seenHeaders: Array<{ url: string; method: string; key: string | null }> = [];
    let captureAttempts = 0;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const key = headers.get("idempotency-key");
      seenHeaders.push({ url, method, key });

      if (url.endsWith("/v1/booking-approvals/loc_e2e_c5") && method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ date: new Date().toUTCString() }),
          json: () =>
            Promise.resolve({
              bookingId: "bk_e2e_c5",
              tenantId: "01932b10-0000-7000-8000-000000000001",
              serviceName: "Executive Haircut & Beard Sculpt",
              serviceVersion: 1,
              durationMinutes: 45,
              resourceName: "Master Barber",
              startsAt: "2026-11-11T18:30:00.000Z",
              endsAt: "2026-11-11T19:15:00.000Z",
              timeZone: "America/New_York",
              allInPriceMinor: "7500",
              depositMinor: "2000",
              formattedPrice: "$75.00",
              formattedDeposit: "$20.00",
              currency: "USD",
              cancellationSummary: "Full refund 24h prior.",
              requestingAgent: "ask-ai",
              preparedBySurface: "ask_ai",
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              status: "PENDING",
              bookingStatus: "HELD",
              display: {
                localDate: "Wed, Nov 11, 2026",
                localStart: "1:30 PM",
                localEnd: "2:15 PM",
                timeZone: "America/New_York",
                timeZoneLabel: "EST",
              },
            }),
        });
      }

      if (url.endsWith("/v1/booking-approvals/loc_e2e_c5/approve-and-commit")) {
        expect(key).toBeTruthy();
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              bookingId: "bk_e2e_c5",
              status: "COMMITTING",
              next: {
                type: "PAY_DEPOSIT",
                paymentOrderUrl: "/v1/bookings/bk_e2e_c5/payment-order",
              },
            }),
        });
      }

      if (url.endsWith("/v1/bookings/bk_e2e_c5/payment-order")) {
        expect(key).toBeTruthy();
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              paymentIntentId: "pi_e2e_c5",
              paypalOrderId: "ORD_E2E_C5",
              amount: { currency: "USD", valueMinor: "2000" },
              status: "REQUIRES_PAYER_ACTION",
              paymentExpiresAt: new Date(Date.now() + 600_000).toISOString(),
            }),
        });
      }

      if (url.endsWith("/v1/payments/pi_e2e_c5/capture")) {
        expect(key).toBeTruthy();
        captureAttempts++;
        if (captureAttempts === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                bookingId: "bk_e2e_c5",
                bookingStatus: "PAYMENT_FAILED",
                paymentStatus: "FAILED",
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              bookingId: "bk_e2e_c5",
              bookingStatus: "CONFIRMED",
              paymentStatus: "CAPTURED",
              providerCaptureId: "CAP_E2E_C5",
            }),
        });
      }

      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }) as any;

    render(<ApprovalPage locator="loc_e2e_c5" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("terms-checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => {
      expect(screen.getByTestId("state-pay-deposit")).toBeDefined();
    });

    // Wait for initial payment-order call from PayPalButton mount
    await waitFor(() => {
      expect(seenHeaders.some((h) => h.url.endsWith("/payment-order"))).toBe(true);
    });

    // Click Pay -> first capture returns PAYMENT_FAILED, unmounting PayPalButton
    fireEvent.click(
      screen.getByRole("button", { name: /Authorize & Capture via PayPal Sandbox/i }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("state-payment-failed")).toBeDefined();
    });

    // Click "Try again" -> remounts PayPalButton for same bookingId and reuses keys!
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => {
      expect(screen.getByTestId("state-pay-deposit")).toBeDefined();
    });

    await waitFor(() => {
      expect(seenHeaders.filter((h) => h.url.endsWith("/payment-order")).length).toBe(2);
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Authorize & Capture via PayPal Sandbox/i }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("state-confirmed")).toBeDefined();
    });

    const approveHeaders = seenHeaders.filter((h) => h.url.endsWith("/approve-and-commit"));
    const orderHeaders = seenHeaders.filter((h) => h.url.endsWith("/payment-order"));
    const captureHeaders = seenHeaders.filter((h) => h.url.endsWith("/capture"));

    expect(approveHeaders.length).toBe(1);
    expect(approveHeaders[0]!.key).toMatch(/^approve-/);

    expect(orderHeaders.length).toBe(2);
    expect(orderHeaders[0]!.key).toMatch(/^pay-order-/);
    expect(orderHeaders[1]!.key).toBe(orderHeaders[0]!.key);

    expect(captureHeaders.length).toBe(2);
    expect(captureHeaders[0]!.key).toMatch(/^capture-/);
    expect(captureHeaders[1]!.key).toBe(captureHeaders[0]!.key);
  });

  it("6. PayPalButton JS SDK v6 session sends Idempotency-Key on createOrder and onApprove capture and reuses keys on retry", async () => {
    apiClient.setAuthToken("eyJ.sdk.jwt");

    const scriptEl = document.createElement("script");
    scriptEl.src = "https://www.sandbox.paypal.com/web-sdk/v6/core";
    document.head.appendChild(scriptEl);

    const orderKeys: string[] = [];
    const captureKeys: string[] = [];
    let orderAttempt = 0;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const key = headers.get("idempotency-key") || "";

      if (url.includes("/payment-order")) {
        orderAttempt++;
        orderKeys.push(key);
        if (orderAttempt === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ title: "Order init failed once", status: 500 }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              paymentIntentId: "pi_sdk_1",
              paypalOrderId: "PAYPAL_SDK_ORD_1",
              amount: { currency: "USD", valueMinor: "2000" },
              status: "REQUIRES_PAYER_ACTION",
              paymentExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            }),
        });
      }

      if (url.includes("/capture")) {
        captureKeys.push(key);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              bookingId: "bk_sdk_1",
              bookingStatus: "CONFIRMED",
              paymentStatus: "CAPTURED",
              providerCaptureId: "CAP_SDK_1",
            }),
        });
      }

      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }) as any;

    let capturedConfig: any = null;
    (globalThis as any).window.paypal = {
      createInstance: vi.fn().mockResolvedValue({
        createPayPalOneTimePaymentSession: vi.fn((config: any) => {
          capturedConfig = config;
          return {
            start: vi.fn(async () => {
              const { orderId } = await capturedConfig.createOrder();
              await capturedConfig.onApprove({ orderId });
            }),
          };
        }),
      }),
    };

    const onOutcome = vi.fn();
    render(<PayPalButton bookingId="bk_sdk_1" onPaymentOutcome={onOutcome} />);

    // Wait for SDK session initialization and first mount order failure
    await waitFor(() => {
      expect(screen.getByText(/Order init failed once/i)).toBeDefined();
      expect(screen.getByRole("button", { name: /Pay with PayPal \(JS SDK v6\)/i })).toBeDefined();
    });

    // Click Pay -> SDK calls createOrder() (retried with SAME key!) -> then onApprove() calls capture (with capture Idempotency-Key)
    fireEvent.click(screen.getByRole("button", { name: /Pay with PayPal \(JS SDK v6\)/i }));

    await waitFor(() => {
      expect(onOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "bk_sdk_1",
          bookingStatus: "CONFIRMED",
          paymentStatus: "CAPTURED",
        }),
      );
    });

    expect(orderKeys.length).toBe(2);
    expect(orderKeys[0]).toMatch(/^pay-order-/);
    expect(orderKeys[1]).toBe(orderKeys[0]);
    expect(captureKeys.length).toBe(1);
    expect(captureKeys[0]).toMatch(/^capture-/);

    scriptEl.remove();
  });
});
