import { FC, useEffect, useState, useRef } from "react";
import { apiClient } from "../api-client.js";

declare global {
  interface Window {
    paypal?: {
      Buttons: (config: {
        createOrder: () => Promise<string>;
        onApprove: (data: { orderID: string }) => Promise<void>;
        onCancel?: (data: Record<string, unknown>) => void;
        onError?: (err: unknown) => void;
        style?: Record<string, unknown>;
      }) => {
        render: (container: HTMLElement | string) => Promise<void>;
      };
    };
  }
}

export interface PayPalPaymentSuccess {
  bookingId: string;
  bookingStatus: "CONFIRMED" | "CAPTURE_UNCERTAIN" | "CANCELLED";
  paymentStatus: "CAPTURED" | "UNCERTAIN" | "FAILED";
  providerCaptureId?: string;
}

interface PayPalButtonProps {
  bookingId: string;
  onPaymentOutcome: (outcome: PayPalPaymentSuccess) => void;
  onPaymentExpired?: () => void;
  onCancel?: () => void;
}

export const PayPalButton: FC<PayPalButtonProps> = ({
  bookingId,
  onPaymentOutcome,
  onPaymentExpired,
  onCancel,
}) => {
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [paymentExpiresAt, setPaymentExpiresAt] = useState<string | null>(null);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // 3. Check for window.paypal SDK
  useEffect(() => {
    if (typeof window !== "undefined" && window.paypal) {
      setSdkReady(true);
    }
  }, []);

  // 4. Render official PayPal JS SDK v6 buttons if script is loaded
  useEffect(() => {
    if (!sdkReady || !containerRef.current || !window.paypal) return;

    containerRef.current.innerHTML = "";
    const buttons = window.paypal.Buttons({
      style: {
        layout: "vertical",
        color: "gold",
        shape: "rect",
        label: "paypal",
      },
      // createOrder calls velvetAI payment-order endpoint (server determines amount/currency)
      createOrder: async () => {
        setIsProcessing(true);
        setError(null);
        try {
          const res = await apiClient.createPaymentOrder(bookingId);
          setPaymentIntentId(res.paymentIntentId);
          setPaymentExpiresAt(res.paymentExpiresAt);
          return res.paypalOrderId;
        } catch (err: unknown) {
          setError((err as Error).message || "Order creation failed");
          throw err;
        } finally {
          setIsProcessing(false);
        }
      },
      // onApprove calls velvetAI backend capture endpoint (does NOT confirm locally)
      onApprove: async () => {
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

    buttons.render(containerRef.current);
  }, [sdkReady, bookingId, paymentIntentId, onPaymentOutcome, onCancel]);

  // Fallback interactive sandbox execution when external CDN script is not loaded
  const handleSimulatedApproval = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      let intentId = paymentIntentId;
      if (!intentId) {
        const order = await apiClient.createPaymentOrder(bookingId);
        intentId = order.paymentIntentId;
        setPaymentIntentId(order.paymentIntentId);
        setPaymentExpiresAt(order.paymentExpiresAt);
      }
      // Call backend capture endpoint
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

      {/* Official PayPal JS SDK Buttons container */}
      <div ref={containerRef} id="paypal-button-container" />

      {/* Interactive Sandbox Checkout Button */}
      {(!sdkReady || isProcessing) && (
        <button
          type="button"
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
          onClick={handleSimulatedApproval}
        >
          {isProcessing
            ? "Authorizing & Capturing Deposit..."
            : isExpired
              ? "Payment Window Expired - Slot Released"
              : "Authorize & Capture via PayPal Sandbox"}
        </button>
      )}

      {isExpired && (
        <p
          className="mono"
          style={{ fontSize: "10px", color: "var(--muted)", marginTop: "8px", textAlign: "center" }}
        >
          Slot hold released back to inventory. Please re-select a slot to continue.
        </p>
      )}
    </div>
  );
};
