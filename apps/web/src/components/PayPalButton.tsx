import { FC, useEffect, useState, useRef, useCallback } from "react";
import { apiClient } from "../api-client.js";

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
    const targetUrl = env === "production" ? PAYPAL_V6_PROD_CORE_SCRIPT_URL : PAYPAL_V6_CORE_SCRIPT_URL;
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
}

export interface PayPalButtonProps {
  bookingId: string;
  onPaymentOutcome: (outcome: PayPalPaymentSuccess) => void;
  onPaymentExpired?: () => void;
  onCancel?: () => void;
  clientId?: string;
  environment?: "sandbox" | "production";
}

export const PayPalButton: FC<PayPalButtonProps> = ({
  bookingId,
  onPaymentOutcome,
  onPaymentExpired,
  onCancel,
  clientId =
    (typeof import.meta !== "undefined" && (import.meta.env?.VITE_PAYPAL_CLIENT_ID as string | undefined)) ||
    "placeholder_paypal_sandbox_client_id",
  environment = "sandbox",
}) => {
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [paymentExpiresAt, setPaymentExpiresAt] = useState<string | null>(null);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const sessionRef = useRef<PayPalV6PaymentSession | null>(null);

  // 1. Initialize payment order to retrieve server-backed payment_expires_at
  useEffect(() => {
    let isMounted = true;
    apiClient
      .createPaymentOrder(bookingId)
      .then((order) => {
        if (!isMounted) return;
        setPaymentIntentId(order.paymentIntentId);
        setPaymentExpiresAt(order.paymentExpiresAt);
      })
      .catch((err: Error) => {
        if (!isMounted) return;
        setError(err.message || "Failed to initialize payment window");
      });

    return () => {
      isMounted = false;
    };
  }, [bookingId]);

  // 2. Countdown timer derived strictly from server payment_expires_at
  useEffect(() => {
    if (!paymentExpiresAt) {
      setCountdownSeconds(null);
      return;
    }

    const targetTime = new Date(paymentExpiresAt).getTime();
    const updateCountdown = () => {
      const remaining = Math.max(0, Math.floor((targetTime - Date.now()) / 1000));
      setCountdownSeconds(remaining);
      if (remaining <= 0) {
        onPaymentExpired?.();
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [paymentExpiresAt, onPaymentExpired]);

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
            const res = await apiClient.createPaymentOrder(bookingId);
            setPaymentIntentId(res.paymentIntentId);
            setPaymentExpiresAt(res.paymentExpiresAt);
            return { orderId: res.paypalOrderId };
          } catch (err: unknown) {
            setError((err as Error).message || "Order creation failed");
            throw err;
          } finally {
            setIsProcessing(false);
          }
        },
        onApprove: async (_data: { orderId: string }) => {
          if (!paymentIntentId) return;
          setIsProcessing(true);
          try {
            const outcome = await apiClient.capturePayment(paymentIntentId);
            onPaymentOutcome(outcome);
          } catch (err: unknown) {
            setError((err as Error).message || "Capture failed");
          } finally {
            setIsProcessing(false);
          }
        },
        onCancel: () => {
          onCancel?.();
        },
        onError: (err) => {
          setError(typeof err === "string" ? err : "PayPal Checkout error occurred");
        },
      });

      sessionRef.current = session;
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to initialize PayPal v6 session");
    }
  }, [bookingId, clientId, onPaymentOutcome, onCancel, paymentIntentId]);

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
        setError((err as Error).message || "PayPal checkout session failed");
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    // Direct API fallback execution (when CDN is blocked or mock testing)
    try {
      let intentId = paymentIntentId;
      if (!intentId) {
        const order = await apiClient.createPaymentOrder(bookingId);
        intentId = order.paymentIntentId;
        setPaymentIntentId(order.paymentIntentId);
        setPaymentExpiresAt(order.paymentExpiresAt);
      }
      const outcome = await apiClient.capturePayment(intentId);
      onPaymentOutcome(outcome);
    } catch (err: unknown) {
      setError((err as Error).message || "Capture failed");
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
          <span>
            {isExpired ? "PAYMENT WINDOW EXPIRED" : "PAYPAL PAYMENT WINDOW ACTIVE"}
          </span>
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
