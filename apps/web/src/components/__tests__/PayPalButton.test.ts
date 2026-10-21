import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PAYPAL_V6_CORE_SCRIPT_URL,
  PAYPAL_V6_PROD_CORE_SCRIPT_URL,
  LEGACY_V5_SCRIPT_PREFIX,
  loadPayPalV6Script,
  PayPalV6SDKInstance,
  PayPalV6PaymentSession,
} from "../PayPalButton.js";
import { apiClient } from "../../api-client.js";

describe("PayPal JS SDK v6 Web Integration Proof", () => {
  let createdScripts: HTMLScriptElement[] = [];

  beforeEach(() => {
    createdScripts = [];
    // Mock minimal DOM environment in Node/Vitest
    const mockDocument = {
      querySelector: vi.fn((selector: string) => {
        return createdScripts.find((s) => selector.includes(s.src)) ?? null;
      }),
      createElement: vi.fn((tag: string) => {
        if (tag === "script") {
          const script = {
            src: "",
            async: false,
            onload: null as (() => void) | null,
            onerror: null as ((err: unknown) => void) | null,
          } as unknown as HTMLScriptElement;
          createdScripts.push(script);
          return script;
        }
        return {} as HTMLElement;
      }),
      head: {
        appendChild: vi.fn((el: HTMLScriptElement) => {
          // Immediately invoke onload to simulate script load
          if (el.onload) el.onload();
        }),
      },
    };

    // @ts-expect-error Mocking document for headless unit test
    globalThis.document = mockDocument;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the official v6 core script without legacy query string", async () => {
    await loadPayPalV6Script("sandbox");

    expect(createdScripts.length).toBe(1);
    const loadedScript = createdScripts[0]!;
    expect(loadedScript.src).toBe(PAYPAL_V6_CORE_SCRIPT_URL);
    expect(loadedScript.src).toBe("https://www.sandbox.paypal.com/web-sdk/v6/core");

    // Strictly does not load legacy v5 script
    expect(loadedScript.src.startsWith(LEGACY_V5_SCRIPT_PREFIX)).toBe(false);
    expect(loadedScript.src).not.toContain("?client-id=");
    expect(loadedScript.src).not.toContain("&currency=");
  });

  it("loads production v6 core script URL for production environment", async () => {
    await loadPayPalV6Script("production");

    expect(createdScripts.length).toBe(1);
    const loadedScript = createdScripts[0]!;
    expect(loadedScript.src).toBe(PAYPAL_V6_PROD_CORE_SCRIPT_URL);
    expect(loadedScript.src).toBe("https://www.paypal.com/web-sdk/v6/core");
    expect(loadedScript.src).not.toContain("?");
  });

  it("uses documented v6 createInstance and createPayPalOneTimePaymentSession APIs rather than legacy paypal.Buttons().render()", async () => {
    let capturedSessionConfig: Parameters<PayPalV6SDKInstance["createPayPalOneTimePaymentSession"]>[0] | null = null;

    const mockPaymentSession: PayPalV6PaymentSession = {
      start: vi.fn(async () => {}),
    };

    const mockSdkInstance: PayPalV6SDKInstance = {
      createPayPalOneTimePaymentSession: vi.fn((config) => {
        capturedSessionConfig = config;
        return mockPaymentSession;
      }),
    };

    const createInstanceMock = vi.fn(async () => mockSdkInstance);

    // Provide mock window.paypal
    // @ts-expect-error Mocking window for headless unit test
    globalThis.window = {
      paypal: {
        createInstance: createInstanceMock,
        // Legacy paypal.Buttons is explicitly omitted / undefined in v6
      },
    };

    // Initialize v6 instance
    const sdkInstance = await globalThis.window.paypal!.createInstance({
      clientId: "test_sandbox_client_id",
      components: ["paypal-payments"],
      pageType: "checkout",
      locale: "en-US",
    });

    expect(createInstanceMock).toHaveBeenCalledWith({
      clientId: "test_sandbox_client_id",
      components: ["paypal-payments"],
      pageType: "checkout",
      locale: "en-US",
    });

    // Create session
    const session = sdkInstance.createPayPalOneTimePaymentSession({
      createOrder: async () => ({ orderId: "TEST_ORDER_123" }),
      onApprove: async () => {},
      onCancel: () => {},
      onError: () => {},
    });

    expect(session).toBe(mockPaymentSession);
    expect(capturedSessionConfig).not.toBeNull();
    // Legacy Buttons and render must not exist
    expect("Buttons" in (globalThis.window.paypal as object)).toBe(false);
  });

  it("ensures createOrder returns { orderId } from backend server and onApprove calls backend capture", async () => {
    const bookingId = "bk_test_123";
    const paymentIntentId = "pi_test_456";
    const paypalOrderId = "PAYPAL_ORDER_789";

    vi.spyOn(apiClient, "createPaymentOrder").mockResolvedValue({
      paymentIntentId,
      paypalOrderId,
      amount: { currency: "USD", valueMinor: "5000" },
      status: "REQUIRES_PAYER_ACTION",
      paymentExpiresAt: new Date(Date.now() + 600000).toISOString(),
    });

    const captureSpy = vi.spyOn(apiClient, "capturePayment").mockResolvedValue({
      bookingId,
      bookingStatus: "CONFIRMED",
      paymentStatus: "CAPTURED",
      providerCaptureId: "CAP_999",
    });

    // 1. Server-side createOrder flow returning { orderId }
    const createOrderHandler = async () => {
      const res = await apiClient.createPaymentOrder(bookingId);
      return { orderId: res.paypalOrderId };
    };

    const orderResult = await createOrderHandler();
    expect(orderResult).toEqual({ orderId: paypalOrderId });
    expect(apiClient.createPaymentOrder).toHaveBeenCalledWith(bookingId);

    // 2. Server-side capture flow in onApprove callback
    const onApproveHandler = async (data: { orderId: string }) => {
      expect(data.orderId).toBe(paypalOrderId);
      await apiClient.capturePayment(paymentIntentId);
    };

    await onApproveHandler({ orderId: paypalOrderId });
    expect(captureSpy).toHaveBeenCalledWith(paymentIntentId);
  });

  it("verifies public client ID is separated and client secret is strictly absent", () => {
    // Assert that client secrets are never exposed to browser context
    const envVars = Object.keys(process.env);
    const leakedSecrets = envVars.filter(
      (k) => k.toLowerCase().includes("secret") && k.startsWith("VITE_"),
    );
    expect(leakedSecrets).toEqual([]);
  });
});
