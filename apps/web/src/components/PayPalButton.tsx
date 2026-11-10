import { FC, useEffect, useState, useRef, useCallback } from "react";
import { apiClient, generateIdempotencyKey } from "../api-client.js";

/**
 * Official PayPal JS SDK v6 URLs.
 * Documentation Reference:
 * https://www.paypal.com/web-sdk/v6/core
 * Note: v6 loads the lightweight core script directly without query parameters (unlike legacy v5).
 */
export const PAYPAL_V6_CORE_SCRIPT_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";
export const PAYPAL_V6_PROD_CORE_SCRIPT_URL = "https://www.paypal.com/web-sdk/v6/core";
export const LEGACY_V5_SCRIPT_PREFIX = "https://www.paypal.com/sdk/js";

export interface PayPalV6InstanceConfig {
  clientId?: string;
  clientToken?: string;
  components?: string[];
  pageType?: string;
  locale?: string;
}

export interface PayPalV6PaymentSessionConfig {
  createOrder?: () => Promise<{ orderId: string }>;
  onApprove: (data: { orderId: string }) => Promise<void>;
  onCancel?: (data: unknown) => void;
  onError?: (err: unknown) => void;
}

export interface PayPalV6PaymentSession {
  start: (options?: { presentationMode?: "auto" | "popup" | "modal" }) => Promise<void>;
}

export interface PayPalV6SDKInstance {
  createPayPalOneTimePaymentSession: (
    config: PayPalV6PaymentSessionConfig,
  ) => PayPalV6PaymentSession;
}

declare global {
  interface Window {
    paypal?: {
      createInstance: (config: PayPalV6InstanceConfig) => Promise<PayPalV6SDKInstance>;
    };
  }
}

export function loadPayPalV6Script(env: "sandbox" | "production" = "sandbox"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      resolve();
      return;
    }
    const targetUrl =
      env === "production" ? PAYPAL_V6_PROD_CORE_SCRIPT_URL : PAYPAL_V6_CORE_SCRIPT_URL;
    const existing = document.querySelector(`script[src="${targetUrl}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = targetUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = (err) =>
      reject(new Error(`Failed to load PayPal v6 core script from ${targetUrl}: ${String(err)}`));
    document.head.appendChild(script);
  });
}

export interface PayPalPaymentSuccess {
  bookingId: string;
  bookingStatus: "CONFIRMED" | "CAPTURE_UNCERTAIN" | "PAYMENT_FAILED" | "CANCELLED";
  paymentStatus: "CAPTURED" | "UNCERTAIN" | "FAILED";
  providerCaptureId?: string;
  operationId?: string;
  statusUrl?: string;
}

export interface PayPalButtonProps {
  bookingId: string;
  onPaymentOutcome: (outcome: PayPalPaymentSuccess) => void;
  onPaymentExpired?: () => void;
  onCancel?: () => void;
  onCaptureNetworkError?: (info: { message: string; paymentIntentId?: string }) => void;
  serverTimeOffsetMs?: number;
  orderIdempotencyKey?: string;
  getCaptureIdempotencyKey?: (paymentIntentId: string) => string;
  clientId?: string;
  environment?: "sandbox" | "production";
}

export const PayPalButton: FC<PayPalButtonProps> = ({
  bookingId,
  onPaymentOutcome,
  onPaymentExpired,
  onCancel,
  onCaptureNetworkError,
  serverTimeOffsetMs = 0,
  orderIdempotencyKey,
  getCaptureIdempotencyKey,
  clientId = (typeof import.meta !== "undefined" &&
    (import.meta.env?.VITE_PAYPAL_CLIENT_ID as string | undefined)) ||
    "placeholder_paypal_sandbox_client_id",
  environment = "sandbox",
}) => {
  const [paymentExpiresAt, setPaymentExpiresAt] = useState<string | null>(null);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const sessionRef = useRef<PayPalV6PaymentSession | null>(null);
  const paymentIntentIdRef = useRef<string | null>(null);
  const paypalOrderIdRef = useRef<string | null>(null);
  const paymentExpiresAtRef = useRef<string | null>(null);
  const fallbackOrderKeyRef = useRef<{ bookingId: string; key: string } | null>(null);
  const fallbackCaptureKeysRef = useRef<Map<string, string>>(new Map());
  const inFlightOrderRef = useRef<{
    bookingId: string;
    promise: Promise<{
      paymentIntentId: string;
      paypalOrderId: string;
      paymentExpiresAt: string;
    }>;
  } | null>(null);

  const resolveOrderKey = useCallback(() => {
    if (orderIdempotencyKey && orderIdempotencyKey.trim().length > 0) {
      return orderIdempotencyKey.trim();
    }
    if (fallbackOrderKeyRef.current?.bookingId === bookingId) {
      return fallbackOrderKeyRef.current.key;
    }
    const generated = generateIdempotencyKey("pay-order");
    fallbackOrderKeyRef.current = { bookingId, key: generated };
    return generated;
  }, [bookingId, orderIdempotencyKey]);

  const resolveCaptureKey = useCallback(
    (intentId: string) => {
      if (getCaptureIdempotencyKey) {
        return getCaptureIdempotencyKey(intentId);
      }
      const existing = fallbackCaptureKeysRef.current.get(intentId);
      if (existing) {
        return existing;
      }
      const generated = generateIdempotencyKey("capture");
      fallbackCaptureKeysRef.current.set(intentId, generated);
      return generated;
    },
    [getCaptureIdempotencyKey],
  );

  // Reset refs when bookingId changes
  useEffect(() => {
    paymentIntentIdRef.current = null;
    paypalOrderIdRef.current = null;
    paymentExpiresAtRef.current = null;
    inFlightOrderRef.current = null;
    setPaymentExpiresAt(null);
  }, [bookingId]);

  const ensurePaymentOrder = useCallback(async () => {
    if (paymentIntentIdRef.current && paypalOrderIdRef.current) {
      return {
        paymentIntentId: paymentIntentIdRef.current,
        paypalOrderId: paypalOrderIdRef.current,
        paymentExpiresAt: paymentExpiresAtRef.current || "",
      };
    }
    if (inFlightOrderRef.current?.bookingId === bookingId) {
      return inFlightOrderRef.current.promise;
    }

    const orderKey = resolveOrderKey();
    const promise = apiClient.createPaymentOrder(bookingId, orderKey).then((order) => {
      paymentIntentIdRef.current = order.paymentIntentId;
      paypalOrderIdRef.current = order.paypalOrderId;
      paymentExpiresAtRef.current = order.paymentExpiresAt;
      return {
        paymentIntentId: order.paymentIntentId,
        paypalOrderId: order.paypalOrderId,
        paymentExpiresAt: order.paymentExpiresAt,
      };
    });

    inFlightOrderRef.current = { bookingId, promise };
    try {
      const order = await promise;
      setPaymentExpiresAt(order.paymentExpiresAt);
      return order;
    } finally {
      if (inFlightOrderRef.current?.promise === promise) {
        inFlightOrderRef.current = null;
      }
    }
  }, [bookingId, resolveOrderKey]);

  // 1. Initialize payment order to retrieve server-backed payment_expires_at
  useEffect(() => {
    let isMounted = true;
    ensurePaymentOrder().catch((err: Error) => {
      if (!isMounted) return;
      setError(err.message || "Failed to initialize payment window");
    });

    return () => {
      isMounted = false;
    };
  }, [bookingId, ensurePaymentOrder]);

  const hasEmittedExpiredRef = useRef(false);

  // 2. Countdown timer derived strictly from server payment_expires_at + server offset (P1-12)
  useEffect(() => {
    hasEmittedExpiredRef.current = false;
    if (!paymentExpiresAt) {
      setCountdownSeconds(null);
      return;
    }

    const targetTime = new Date(paymentExpiresAt).getTime();
    const updateCountdown = () => {
      const effectiveNow = Date.now() + serverTimeOffsetMs;
      const remaining = Math.max(0, Math.floor((targetTime - effectiveNow) / 1000));
      setCountdownSeconds(remaining);
      if (remaining <= 0 && !hasEmittedExpiredRef.current) {
        hasEmittedExpiredRef.current = true;
        onPaymentExpired?.();
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [paymentExpiresAt, serverTimeOffsetMs, onPaymentExpired]);

  // 3. Dynamic loading of PayPal JS SDK v6 core script
  useEffect(() => {
    let isMounted = true;
    loadPayPalV6Script(environment)
      .then(() => {
        if (!isMounted) return;
        if (typeof window !== "undefined" && window.paypal?.createInstance) {
          setSdkReady(true);
        }
      })
      .catch(() => {
        // External CDN may be offline in mock/sandbox test environments
        if (isMounted) setSdkReady(false);
      });

    return () => {
      isMounted = false;
    };
  }, [environment]);

  const handleCaptureException = useCallback(
    (err: unknown, activeIntentId?: string) => {
      const rawMsg = err instanceof Error ? err.message : String(err || "");
      const isNetworkErr =
        err instanceof TypeError ||
        /failed to fetch|networkerror|network request failed|load failed/i.test(rawMsg);
      if (isNetworkErr) {
        const friendly = "We couldn't confirm the payment yet — please check payment status.";
        setError(friendly);
        onCaptureNetworkError?.({ message: friendly, paymentIntentId: activeIntentId });
        return;
      }
      setError(rawMsg || "Capture failed");
    },
    [onCaptureNetworkError],
  );

  // 4. Initialize v6 SDK instance and One-Time Payment Session
  const initV6Session = useCallback(async () => {
    if (typeof window === "undefined" || !window.paypal?.createInstance) return;

    try {
      const sdkInstance = await window.paypal.createInstance({
        clientId,
        components: ["paypal-payments"],
        pageType: "checkout",
        locale: "en-US",
      });

      const session = sdkInstance.createPayPalOneTimePaymentSession({
        createOrder: async () => {
          setIsProcessing(true);
          setError(null);
          try {
            const order = await ensurePaymentOrder();
            return { orderId: order.paypalOrderId };
          } catch (err: unknown) {
            setError((err as Error).message || "Order creation failed");
            throw err;
          } finally {
            setIsProcessing(false);
          }
        },
        onApprove: async (_data: { orderId: string }) => {
          const activeIntentId = paymentIntentIdRef.current;
          if (!activeIntentId) return;
          setIsProcessing(true);
          try {
            const captureKey = resolveCaptureKey(activeIntentId);
            const outcome = await apiClient.capturePayment(activeIntentId, captureKey);
            onPaymentOutcome(outcome);
          } catch (err: unknown) {
            handleCaptureException(err, activeIntentId);
          } finally {
            setIsProcessing(false);
          }
        },
        onCancel: () => {
          setIsProcessing(false);
          onCancel?.();
        },
        onError: (err) => {
          setIsProcessing(false);
          setError(typeof err === "string" ? err : "PayPal Checkout error occurred");
        },
      });

      sessionRef.current = session;
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to initialize PayPal v6 session");
    }
  }, [
    clientId,
    ensurePaymentOrder,
    handleCaptureException,
    onCancel,
    onPaymentOutcome,
    resolveCaptureKey,
  ]);

  useEffect(() => {
    if (sdkReady) {
      void initV6Session();
    }
  }, [sdkReady, initV6Session]);

  // 5. User interaction: triggers paymentSession.start() or backend simulated fallback
  const handlePaymentClick = async () => {
    setIsProcessing(true);
    setError(null);

    if (sessionRef.current) {
      try {
        await sessionRef.current.start({ presentationMode: "auto" });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err || "");
        if (/cancel/i.test(msg)) {
          onCancel?.();
        } else {
          setError(msg || "PayPal checkout session failed");
        }
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    // Direct API fallback execution (when CDN is blocked or mock testing)
    let activeIntentId: string | undefined;
    try {
      const order = await ensurePaymentOrder();
      activeIntentId = order.paymentIntentId;
      const captureKey = resolveCaptureKey(order.paymentIntentId);
      const outcome = await apiClient.capturePayment(order.paymentIntentId, captureKey);
      onPaymentOutcome(outcome);
    } catch (err: unknown) {
      handleCaptureException(err, activeIntentId);
    } finally {
      setIsProcessing(false);
    }
  };

  const isExpired = countdownSeconds !== null && countdownSeconds <= 0;

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  return (
    <div className="paypal-checkout-container" style={{ marginTop: "16px" }}>
      {/* Server-derived payment window countdown */}
      {countdownSeconds !== null && (
        <div
          className="countdown-badge mono"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 12px",
            background: isExpired ? "rgba(239, 68, 68, 0.1)" : "rgba(16, 185, 129, 0.1)",
            border: `1px solid ${isExpired ? "rgba(239, 68, 68, 0.3)" : "rgba(16, 185, 129, 0.3)"}`,
            marginBottom: "12px",
            fontSize: "11px",
          }}
        >
          <span>{isExpired ? "PAYMENT WINDOW EXPIRED" : "PAYPAL PAYMENT WINDOW ACTIVE"}</span>
          <span style={{ fontWeight: 700, color: isExpired ? "#ef4444" : "#10b981" }}>
            {formatTimer(countdownSeconds)}
          </span>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px",
            background: "rgba(239, 68, 68, 0.1)",
            color: "#ef4444",
            fontSize: "11px",
            marginBottom: "12px",
            border: "1px solid rgba(239, 68, 68, 0.3)",
          }}
        >
          {error}
        </div>
      )}

      {/* Official PayPal JS SDK v6 Web Component & Interactive Trigger */}
      <div id="paypal-button-container">
        <button
          type="button"
          id="paypal-v6-checkout-button"
          className="button button--solid"
          style={{
            width: "100%",
            background: isExpired ? "var(--muted)" : "#0070ba",
            borderColor: isExpired ? "var(--hairline)" : "#0070ba",
            color: "#ffffff",
            fontWeight: 700,
            cursor: isExpired || isProcessing ? "not-allowed" : "pointer",
            minHeight: "44px",
          }}
          disabled={isExpired || isProcessing}
          onClick={handlePaymentClick}
        >
          {isProcessing
            ? "Authorizing & Capturing Deposit..."
            : isExpired
              ? "Payment Window Expired - Slot Released"
              : sdkReady
                ? "Pay with PayPal (JS SDK v6)"
                : "Authorize & Capture via PayPal Sandbox"}
        </button>
      </div>

      {isExpired && (
        <p
          className="mono"
          style={{ fontSize: "10px", color: "var(--muted)", marginTop: "8px", textAlign: "center" }}
        >
          Slot hold released. Please return to schedule to select a new time slot.
        </p>
      )}
    </div>
  );
};
