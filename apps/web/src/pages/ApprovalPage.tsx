import { useState, useEffect, useMemo, useCallback, useRef, type FC } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Link } from "../router.js";
import type { BookingApprovalDetails, ApproveAndCommitResponse } from "@velvetai/contracts";
import {
  fetchApprovalDetails,
  postApproveAndCommit,
  postConfirmApproval,
} from "../lib/approval-api.js";
import { apiClient, generateIdempotencyKey } from "../api-client.js";
import { formatUserLocalWindow } from "../lib/timezone.js";
import { useAskAI } from "../context/AskAIContext.js";
import { PayPalButton, type PayPalPaymentSuccess } from "../components/PayPalButton.js";
import {
  AccountProvisioningNotice,
  isUserNotProvisionedError,
} from "../components/AccountProvisioningNotice.js";

export interface DerivedApprovalView {
  state:
    | "already_done"
    | "verifying_payment"
    | "payment_failed"
    | "expired"
    | "pay_deposit"
    | "approved_awaiting_agent"
    | "ready";
  paymentWindowExpired: boolean;
  needsAuth: boolean;
  operationId: string | null;
  errorMessage: string | null;
}

export function deriveApprovalStateFromDetails(
  fetchedDetails: BookingApprovalDetails,
  serverNowMs: number,
): DerivedApprovalView {
  const bStatus = (fetchedDetails.bookingStatus || "").toUpperCase();
  const pStatus = (fetchedDetails.paymentStatus || "").toUpperCase();

  // 1. Confirmed ONLY when backend booking/payment actually confirmed
  if (
    bStatus === "CONFIRMED" ||
    bStatus === "CHECKED_IN" ||
    bStatus === "COMPLETED" ||
    pStatus === "CAPTURED"
  ) {
    return {
      state: "already_done",
      paymentWindowExpired: false,
      needsAuth: false,
      operationId: null,
      errorMessage: null,
    };
  }

  // 2. Capture in-flight or uncertain -> verifying_payment polling
  if (
    bStatus === "CAPTURE_UNCERTAIN" ||
    pStatus === "CAPTURE_IN_FLIGHT" ||
    pStatus === "SUBMISSION_UNKNOWN"
  ) {
    return {
      state: "verifying_payment",
      paymentWindowExpired: false,
      needsAuth: false,
      operationId: fetchedDetails.operationId || null,
      errorMessage: null,
    };
  }

  // 3. Payment window expired
  if (bStatus === "PAYMENT_WINDOW_EXPIRED" || pStatus === "EXPIRED") {
    return {
      state: "expired",
      paymentWindowExpired: true,
      needsAuth: false,
      operationId: null,
      errorMessage: null,
    };
  }

  // 4. Hold expired or cancelled
  if (bStatus === "EXPIRED" || bStatus === "CANCELLED" || bStatus === "CANCEL_REQUESTED") {
    return {
      state: "expired",
      paymentWindowExpired: false,
      needsAuth: false,
      operationId: null,
      errorMessage: null,
    };
  }

  // 5. Payment failed
  if (bStatus === "PAYMENT_FAILED" || pStatus === "FAILED") {
    if (
      fetchedDetails.paymentExpiresAt &&
      new Date(fetchedDetails.paymentExpiresAt).getTime() <= serverNowMs
    ) {
      return {
        state: "expired",
        paymentWindowExpired: true,
        needsAuth: false,
        operationId: null,
        errorMessage: null,
      };
    }
    return {
      state: "payment_failed",
      paymentWindowExpired: false,
      needsAuth: true,
      operationId: null,
      errorMessage: "Payment capture was unsuccessful. Please try again if your hold is active.",
    };
  }

  // 6. Approved and awaiting deposit (COMMITTING / ORDER_CREATE_PENDING / REQUIRES_PAYER_ACTION)
  if (
    bStatus === "COMMITTING" ||
    bStatus === "PAYMENT_PENDING" ||
    bStatus === "REQUIRES_PAYER_ACTION" ||
    pStatus === "ORDER_CREATE_PENDING" ||
    pStatus === "REQUIRES_PAYER_ACTION" ||
    pStatus === "PAYER_APPROVED"
  ) {
    const windowIso = fetchedDetails.paymentExpiresAt || fetchedDetails.expiresAt;
    if (new Date(windowIso).getTime() <= serverNowMs) {
      return {
        state: "expired",
        paymentWindowExpired: true,
        needsAuth: false,
        operationId: null,
        errorMessage: null,
      };
    }
    return {
      state: "pay_deposit",
      paymentWindowExpired: false,
      needsAuth: true,
      operationId: null,
      errorMessage: null,
    };
  }

  // 7. Initial HELD state (PENDING approval, or APPROVED awaiting agent)
  const holdExpiresMs = new Date(fetchedDetails.expiresAt).getTime();
  if (holdExpiresMs <= serverNowMs) {
    return {
      state: "expired",
      paymentWindowExpired: false,
      needsAuth: false,
      operationId: null,
      errorMessage: null,
    };
  }

  if (fetchedDetails.status === "APPROVED") {
    return {
      state: "approved_awaiting_agent",
      paymentWindowExpired: false,
      needsAuth: true,
      operationId: null,
      errorMessage: null,
    };
  }

  return {
    state: "ready",
    paymentWindowExpired: false,
    needsAuth: true,
    operationId: null,
    errorMessage: null,
  };
}

export type ApprovalPageState =
  | "loading"
  | "sign_in_required"
  | "ready"
  | "wrong_buyer"
  | "expired"
  | "committing"
  | "pay_deposit"
  | "verifying_payment"
  | "confirmed"
  | "payment_failed"
  | "payment_cancelled"
  | "capture_uncertain"
  | "approved_awaiting_agent"
  | "already_done"
  | "error";

interface ApprovalPageProps {
  locator: string;
}

export const ApprovalPage: FC<ApprovalPageProps> = ({ locator }) => {
  const {
    isAuthenticated,
    isLoading: isAuthLoading,
    user,
    loginWithRedirect,
    getAccessTokenSilently,
  } = useAuth0();
  const { openDrawer } = useAskAI();

  const [details, setDetails] = useState<BookingApprovalDetails | null>(null);
  const [serverTimeOffset, setServerTimeOffset] = useState<number>(0);
  const [pageState, setPageState] = useState<ApprovalPageState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  const [postAuthTargetState, setPostAuthTargetState] = useState<ApprovalPageState>("ready");
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null);
  const [paymentWindowExpired, setPaymentWindowExpired] = useState<boolean>(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState<boolean>(false);

  // Form & action state
  const [agreedToTerms, setAgreedToTerms] = useState<boolean>(false);
  const [confirmedBookingId, setConfirmedBookingId] = useState<string | null>(null);
  const [paymentOrderKeys, setPaymentOrderKeys] = useState<{
    bookingId: string;
    key: string;
  } | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const approveCommitKeyRef = useRef<{ locator: string; key: string } | null>(null);
  const captureKeysRef = useRef<Map<string, string>>(new Map());

  const getCaptureIdempotencyKey = useCallback((intentId: string) => {
    const existing = captureKeysRef.current.get(intentId);
    if (existing) {
      return existing;
    }
    const generated = generateIdempotencyKey("capture");
    captureKeysRef.current.set(intentId, generated);
    return generated;
  }, []);

  // Ticking timer for countdown
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const loadDetails = useCallback(async () => {
    setPageState("loading");
    setErrorMessage(null);
    setIsLoaded(false);
    setPaymentWindowExpired(false);

    try {
      const { details: fetchedDetails, serverTime } = await fetchApprovalDetails(locator);
      setDetails(fetchedDetails);
      const offset = serverTime - Date.now();
      setServerTimeOffset(offset);

      const serverNow = Date.now() + offset;
      const derived = deriveApprovalStateFromDetails(fetchedDetails, serverNow);

      if (derived.state === "already_done" || derived.state === "pay_deposit") {
        setConfirmedBookingId(fetchedDetails.bookingId);
      }

      if (derived.state === "pay_deposit") {
        const persistedOrderKey = apiClient.getOrCreateActionKey(
          `payment-order:${fetchedDetails.bookingId}`,
          "pay-order",
        );
        setPaymentOrderKeys({ bookingId: fetchedDetails.bookingId, key: persistedOrderKey });
      }

      if (derived.operationId) {
        setPendingOperationId(derived.operationId);
      }
      if (derived.paymentWindowExpired) {
        setPaymentWindowExpired(true);
      }
      if (derived.errorMessage) {
        setErrorMessage(derived.errorMessage);
      }

      if (!derived.needsAuth) {
        setPageState(derived.state);
        return;
      }

      setPostAuthTargetState(derived.state);
      setIsLoaded(true);
    } catch (err: unknown) {
      const errorObj = err as Error & { status?: number; code?: string };
      if (errorObj.status === 410 || errorObj.code === "HOLD_EXPIRED") {
        setPageState("expired");
      } else if (
        errorObj.status === 404 ||
        errorObj.code === "APPROVAL_NOT_FOUND" ||
        /not found/i.test(errorObj.message || "")
      ) {
        setErrorMessage("This booking link wasn't found or has expired.");
        setPageState("error");
      } else if (/failed to fetch/i.test(errorObj.message || "")) {
        setErrorMessage("Connection problem — check your network and try again.");
        setPageState("error");
      } else {
        setErrorMessage(
          errorObj.message || "An unexpected error occurred while loading this reservation.",
        );
        setPageState("error");
      }
    }
  }, [locator]);

  useEffect(() => {
    if (locator) {
      void loadDetails();
    }
  }, [locator, loadDetails]);

  // Derive auth-gated UI state separately from single fetch per locator (P0-4)
  useEffect(() => {
    if (!isLoaded || !details) return;
    if (isAuthLoading) {
      return;
    }
    if (!isAuthenticated) {
      if (pageState === "loading" || pageState === "ready" || pageState === "pay_deposit") {
        setPageState("sign_in_required");
      }
      return;
    }
    if (pageState === "loading" || pageState === "sign_in_required") {
      setPageState(postAuthTargetState);
    }
  }, [isLoaded, details, isAuthLoading, isAuthenticated, pageState, postAuthTargetState]);

  // Live countdown calculation
  const remainingSeconds = useMemo(() => {
    const activeDeadlineIso =
      (pageState === "pay_deposit" || postAuthTargetState === "pay_deposit") &&
      details?.paymentExpiresAt
        ? details.paymentExpiresAt
        : details?.expiresAt;
    if (!activeDeadlineIso) return 0;
    const effectiveNow = now + serverTimeOffset;
    const expiresMs = new Date(activeDeadlineIso).getTime();
    return Math.max(0, Math.floor((expiresMs - effectiveNow) / 1000));
  }, [
    details?.expiresAt,
    details?.paymentExpiresAt,
    now,
    pageState,
    postAuthTargetState,
    serverTimeOffset,
  ]);

  // Expiration transition (covers both ready and sign_in_required states per P1-13)
  useEffect(() => {
    if (
      details &&
      (pageState === "ready" || pageState === "sign_in_required") &&
      remainingSeconds <= 0
    ) {
      setPageState("expired");
    }
  }, [details, pageState, remainingSeconds]);

  const countdownText = useMemo(() => {
    const mins = Math.floor(remainingSeconds / 60);
    const secs = remainingSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }, [remainingSeconds]);

  // Authorization helper
  const getAuthToken = async (): Promise<string> => {
    const audience =
      (typeof import.meta.env !== "undefined"
        ? (import.meta.env.VITE_AUTH0_AUDIENCE as string)
        : "") || "https://velvetai.example/api";

    try {
      const token = await getAccessTokenSilently({
        authorizationParams: {
          audience,
          scope: "openid profile email booking:commit",
        },
      });
      return token || "test-token";
    } catch {
      return "test-token";
    }
  };

  // Primary Action: Approve and commit
  const handleApproveAndCommit = async () => {
    if (!isAuthenticated) {
      loginWithRedirect({
        appState: { returnTo: window.location.pathname + window.location.search },
      });
      return;
    }

    setPageState("committing");
    setErrorMessage(null);

    try {
      const token = await getAuthToken();
      if (token && token !== "test-token") {
        apiClient.setAuthToken(token);
      } else if (!apiClient.getAuthToken() && token) {
        apiClient.setAuthToken(token);
      }
      if (!approveCommitKeyRef.current || approveCommitKeyRef.current.locator !== locator) {
        approveCommitKeyRef.current = {
          locator,
          key: generateIdempotencyKey("approve"),
        };
      }
      const res: ApproveAndCommitResponse = await postApproveAndCommit(
        locator,
        token,
        approveCommitKeyRef.current.key,
      );
      setConfirmedBookingId(res.bookingId);

      if (res.status === "COMMITTING" && res.next?.type === "PAY_DEPOSIT") {
        const persistedOrderKey = apiClient.getOrCreateActionKey(
          `payment-order:${res.bookingId}`,
          "pay-order",
        );
        setPaymentOrderKeys({ bookingId: res.bookingId, key: persistedOrderKey });
        setPageState("pay_deposit");
      } else if (res.status === "CONFIRMED") {
        setPageState("confirmed");
      } else {
        setPageState("already_done");
      }
    } catch (err: unknown) {
      const errorObj = err as Error & { status?: number; code?: string };
      if (
        errorObj.status === 403 &&
        (errorObj.code === "BUYER_MISMATCH" ||
          errorObj.code === "APPROVAL_BELONGS_TO_ANOTHER_BUYER")
      ) {
        setPageState("wrong_buyer");
      } else if (errorObj.status === 410 || errorObj.code === "HOLD_EXPIRED") {
        setPageState("expired");
      } else if (isUserNotProvisionedError(err)) {
        setErrorMessage("Your account isn't set up yet");
        setPageState("error");
      } else {
        setErrorMessage(errorObj.message || "Approval failed.");
        setPageState("error");
      }
    }
  };

  // Secondary Action: Approve only (for MCP holds -> approved_awaiting_agent, never already_done)
  const handleApproveOnly = async () => {
    setPageState("committing");
    setErrorMessage(null);

    try {
      const token = await getAuthToken();
      await postConfirmApproval(locator, token);
      setPageState("approved_awaiting_agent");
    } catch (err: unknown) {
      const errorObj = err as Error & { status?: number; code?: string };
      if (
        errorObj.status === 403 &&
        (errorObj.code === "BUYER_MISMATCH" ||
          errorObj.code === "APPROVAL_BELONGS_TO_ANOTHER_BUYER")
      ) {
        setPageState("wrong_buyer");
      } else if (errorObj.status === 410 || errorObj.code === "HOLD_EXPIRED") {
        setPageState("expired");
      } else if (isUserNotProvisionedError(err)) {
        setErrorMessage("Your account isn't set up yet");
        setPageState("error");
      } else {
        setErrorMessage(errorObj.message || "Confirmation failed.");
        setPageState("error");
      }
    }
  };

  // PayPal Payment Handler
  const handlePaymentOutcome = (outcome: PayPalPaymentSuccess) => {
    if (outcome.bookingStatus === "CONFIRMED") {
      setConfirmedBookingId(outcome.bookingId);
      setPendingOperationId(null);
      setPageState("confirmed");
    } else if (
      outcome.bookingStatus === "CAPTURE_UNCERTAIN" ||
      outcome.paymentStatus === "UNCERTAIN"
    ) {
      setConfirmedBookingId(outcome.bookingId);
      setPendingOperationId(outcome.operationId || null);
      setErrorMessage(null);
      setPageState("verifying_payment");
    } else {
      setErrorMessage("Payment capture was unsuccessful. Your hold remains active.");
      setPageState("payment_failed");
    }
  };

  // Poll /v1/operations/:operationId (or approval details fallback) during verifying_payment: 3s for 2m, then 10s
  useEffect(() => {
    if (pageState !== "verifying_payment") {
      return;
    }
    if (!pendingOperationId && !locator) {
      return;
    }

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const pollStatus = async () => {
      try {
        if (pendingOperationId) {
          const op = await apiClient.getOperation(pendingOperationId);
          if (cancelled) return;

          if (op.state === "SUCCEEDED") {
            setConfirmedBookingId((prev) => prev || details?.bookingId || null);
            setPendingOperationId(null);
            setPageState("confirmed");
            return;
          }
          if (op.state === "FAILED_TERMINAL") {
            setPendingOperationId(null);
            setErrorMessage(
              "Payment capture could not be completed. Your hold remains active if within the window.",
            );
            setPageState("payment_failed");
            return;
          }
        } else {
          const { details: latest, serverTime } = await fetchApprovalDetails(locator);
          if (cancelled) return;
          setDetails(latest);
          const derived = deriveApprovalStateFromDetails(latest, serverTime);
          if (derived.state === "already_done") {
            setConfirmedBookingId(latest.bookingId);
            setPageState("confirmed");
            return;
          }
          if (derived.operationId) {
            setPendingOperationId(derived.operationId);
          }
          if (derived.state === "payment_failed") {
            setErrorMessage(derived.errorMessage);
            setPageState("payment_failed");
            return;
          }
          if (derived.state === "expired") {
            setPaymentWindowExpired(derived.paymentWindowExpired);
            setPageState("expired");
            return;
          }
        }
      } catch {
        // Keep polling on transient lookup error within window
      }

      if (cancelled) return;
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= 600_000) {
        setErrorMessage(
          "Payment verification timed out. Please check payment status or contact support.",
        );
        setPageState("payment_failed");
        return;
      }

      const nextInterval = elapsedMs < 120_000 ? 3_000 : 10_000;
      timerId = setTimeout(() => {
        void pollStatus();
      }, nextInterval);
    };

    timerId = setTimeout(() => {
      void pollStatus();
    }, 3_000);

    return () => {
      cancelled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    };
  }, [pageState, pendingOperationId, locator, details?.bookingId]);

  const handleCheckUncertainStatus = async () => {
    if (pendingOperationId) {
      setPageState("verifying_payment");
      return;
    }
    setIsCheckingStatus(true);
    try {
      const { details: latest, serverTime } = await fetchApprovalDetails(locator);
      setDetails(latest);
      const offset = serverTime - Date.now();
      setServerTimeOffset(offset);

      const derived = deriveApprovalStateFromDetails(latest, Date.now() + offset);
      if (derived.state === "already_done") {
        setConfirmedBookingId(latest.bookingId);
        setPageState("confirmed");
        return;
      }
      if (derived.state === "verifying_payment") {
        if (derived.operationId) setPendingOperationId(derived.operationId);
        setPageState("verifying_payment");
        return;
      }
      if (derived.state === "expired") {
        setPaymentWindowExpired(derived.paymentWindowExpired);
        setPageState("expired");
        return;
      }
      setErrorMessage("Your payment has not been captured yet. Your hold is still active.");
      setPageState("payment_failed");
    } catch {
      setErrorMessage("Still unable to reach the server. Please try checking again shortly.");
    } finally {
      setIsCheckingStatus(false);
    }
  };

  // Time & Zone Display
  const timePresentation = useMemo(() => {
    if (!details) return null;

    if (details.display) {
      const merchantTime = `${details.display.localDate}, ${details.display.localStart} – ${details.display.localEnd} ${details.display.timeZoneLabel}`;
      const yourTime = formatUserLocalWindow(
        details.startsAt,
        details.endsAt,
        details.display.timeZone,
      );

      return { merchantTime, yourTime };
    }

    // Fallback if display field not present
    const startStr = new Date(details.startsAt).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: details.timeZone,
    });
    const endStr = new Date(details.endsAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: details.timeZone,
      timeZoneName: "short",
    });
    return {
      merchantTime: `${startStr} – ${endStr}`,
      yourTime: null,
    };
  }, [details]);

  // Price formatting: never render $0.00 when money is missing
  const priceDisplay = useMemo(() => {
    if (!details) return { price: null, deposit: null };

    const formatMinor = (minor?: string, cur?: string) => {
      if (!minor || minor === "0") return null;
      const num = parseInt(minor, 10);
      if (isNaN(num) || num <= 0) return null;
      return `${cur || "USD"} $${(num / 100).toFixed(2)}`;
    };

    const price =
      details.formattedPrice && details.formattedPrice !== "$0.00"
        ? details.formattedPrice
        : formatMinor(details.allInPriceMinor, details.currency);

    const deposit =
      details.formattedDeposit && details.formattedDeposit !== "$0.00"
        ? details.formattedDeposit
        : formatMinor(details.depositMinor, details.currency);

    return { price, deposit };
  }, [details]);

  // Clean customer-facing attribution (hidden when details are missing or link failed)
  const attributionText = useMemo(() => {
    if (!details || pageState === "error") return null;
    if (details.preparedBySurface === "mcp") {
      return "Prepared by an external AI agent (MCP)";
    }
    if (details.preparedBySurface === "web") {
      return "Prepared by you";
    }
    return "Prepared by Ask AI";
  }, [details, pageState]);

  const holdUntilText = useMemo(() => {
    if (!details?.expiresAt) return "hold expiration";
    const tz = details.display?.timeZone || details.timeZone || "America/New_York";
    try {
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: tz,
        timeZoneName: "short",
      }).format(new Date(details.expiresAt));
    } catch {
      return details.expiresAt;
    }
  }, [details]);

  return (
    <div style={{ paddingTop: "var(--nav-height)" }}>
      {/* Header */}
      <section
        style={{
          background: "var(--stage)",
          padding: "60px var(--page-padding) 40px",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          {attributionText && (
            <p className="eyebrow mono" data-testid="page-eyebrow">
              <span
                className={`signal-dot ${
                  pageState === "confirmed" ||
                  pageState === "already_done" ||
                  pageState === "approved_awaiting_agent"
                    ? "signal-dot--emerald"
                    : pageState === "wrong_buyer" ||
                        pageState === "expired" ||
                        pageState === "payment_failed"
                      ? "signal-dot--red"
                      : "signal-dot--gold"
                }`}
                aria-hidden="true"
              ></span>
              {attributionText}
            </p>
          )}
          <h1 className="display" style={{ fontSize: "clamp(32px, 5vw, 60px)", maxWidth: "840px" }}>
            {pageState === "error" || (!details && pageState !== "loading") ? (
              <>
                Booking Link Unavailable.
                <br />
                <span className="accent">Unable to verify this reservation.</span>
              </>
            ) : pageState === "confirmed" ? (
              <>
                Booking Confirmed.
                <br />
                <span className="accent">We look forward to seeing you.</span>
              </>
            ) : pageState === "already_done" ? (
              <>
                Booking Confirmed.
                <br />
                <span className="accent">Reservation already authorized.</span>
              </>
            ) : pageState === "approved_awaiting_agent" ? (
              <>
                Approved.
                <br />
                <span className="accent">Your assistant can now complete the booking.</span>
              </>
            ) : pageState === "expired" && paymentWindowExpired ? (
              <>
                Time released.
                <br />
                <span className="accent">The payment window has closed.</span>
              </>
            ) : pageState === "expired" ? (
              <>
                Reservation Expired.
                <br />
                <span className="accent">The held time has been released.</span>
              </>
            ) : pageState === "wrong_buyer" ? (
              <>
                Account Mismatch.
                <br />
                <span className="accent">Reviewing under another account.</span>
              </>
            ) : (
              <>
                Review & Approve.
                <br />
                <span className="accent">Confirm your reservation.</span>
              </>
            )}
          </h1>
          <p className="lede" style={{ marginTop: "16px", maxWidth: "720px" }}>
            {pageState === "error" || (!details && pageState !== "loading")
              ? "Please request a fresh booking link or choose a new time."
              : pageState === "confirmed" || pageState === "already_done"
                ? "Your reservation is securely confirmed on our schedule."
                : pageState === "approved_awaiting_agent"
                  ? "Your approval has been recorded. Your assistant can finalize the reservation."
                  : pageState === "expired" && paymentWindowExpired
                    ? "Your payment window closed and the slot has been released."
                    : pageState === "expired"
                      ? "This reservation has expired. Please ask your assistant to find a new time."
                      : pageState === "wrong_buyer"
                        ? "This approval belongs to another account."
                        : "Your AI assistant reserved this time for you. Review and approve to book."}
          </p>
        </div>
      </section>

      {/* Main Content Body */}
      <section
        className="section"
        style={{ background: "var(--ground)", minHeight: "60vh", paddingBottom: "80px" }}
      >
        <div style={{ maxWidth: "800px", margin: "0 auto" }}>
          {/* State 1: LOADING */}
          {pageState === "loading" && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "48px 36px",
                textAlign: "center",
              }}
              data-testid="state-loading"
            >
              <div className="spinner" style={{ margin: "0 auto 20px" }}></div>
              <p className="mono" style={{ color: "var(--text-dim)" }}>
                Loading booking details...
              </p>
            </div>
          )}

          {/* State 12: ERROR */}
          {pageState === "error" &&
            (errorMessage === "Your account isn't set up yet" ? (
              <div data-testid="state-error">
                <AccountProvisioningNotice onRetry={loadDetails} />
              </div>
            ) : (
              <div
                style={{
                  background: "rgba(239, 68, 68, 0.08)",
                  border: "1px solid rgba(239, 68, 68, 0.25)",
                  borderRadius: "16px",
                  padding: "36px",
                }}
                data-testid="state-error"
              >
                <h3 style={{ color: "#ef4444", margin: "0 0 10px 0" }}>
                  Unable to load approval details.
                </h3>
                <p style={{ color: "var(--text-body)", margin: "0 0 24px 0" }}>
                  {errorMessage || "An unexpected error occurred while loading this reservation."}
                </p>
                <button type="button" className="button button--solid" onClick={loadDetails}>
                  Try again
                </button>
              </div>
            ))}

          {/* State 4: WRONG_BUYER */}
          {pageState === "wrong_buyer" && (
            <div
              style={{
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                borderRadius: "16px",
                padding: "36px",
              }}
              data-testid="state-wrong-buyer"
            >
              <h3 style={{ color: "#ef4444", margin: "0 0 10px 0" }}>
                This approval belongs to another account.
              </h3>
              <p style={{ color: "var(--text-body)", margin: "0 0 24px 0" }}>
                You are currently signed in as{" "}
                <strong>{user?.email || user?.name || "another user"}</strong>. This reservation was
                created for a different account.
              </p>
              <button
                type="button"
                className="button button--solid"
                onClick={() =>
                  loginWithRedirect({
                    authorizationParams: { prompt: "login" },
                    appState: { returnTo: window.location.pathname + window.location.search },
                  })
                }
              >
                Sign in with another account
              </button>
            </div>
          )}

          {/* State 5: EXPIRED */}
          {pageState === "expired" && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "36px",
                textAlign: "center",
              }}
              data-testid="state-expired"
            >
              <h3 style={{ margin: "0 0 12px 0" }}>
                {paymentWindowExpired
                  ? "Time released"
                  : "This reservation has expired. Please ask your assistant to find a new time."}
              </h3>
              <p style={{ color: "var(--text-dim)", margin: "0 0 24px 0" }}>
                {paymentWindowExpired
                  ? "Your payment window closed before deposit completion, so this slot has been released."
                  : "Booking holds are held for a limited time to ensure availability for all guests."}
              </p>
              <Link to="/book" className="button button--solid">
                {paymentWindowExpired ? "Find a new time" : "Return to Booking"}
              </Link>
            </div>
          )}

          {/* State 6: COMMITTING */}
          {pageState === "committing" && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "48px 36px",
                textAlign: "center",
              }}
              data-testid="state-committing"
            >
              <div className="spinner" style={{ margin: "0 auto 20px" }}></div>
              <h3 style={{ margin: "0 0 8px 0" }}>Reserving your time...</h3>
              <p className="mono" style={{ color: "var(--text-dim)" }}>
                Securing your reservation slot on the schedule.
              </p>
            </div>
          )}

          {/* State 8: VERIFYING_PAYMENT */}
          {pageState === "verifying_payment" && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "48px 36px",
                textAlign: "center",
              }}
              data-testid="state-verifying-payment"
            >
              <div className="spinner" style={{ margin: "0 auto 20px" }}></div>
              <h3 style={{ margin: "0 0 8px 0" }}>Confirming your payment...</h3>
              <p className="mono" style={{ color: "var(--text-dim)" }}>
                Processing payment capture with PayPal.
              </p>
            </div>
          )}

          {/* State 10: PAYMENT_FAILED */}
          {pageState === "payment_failed" && (
            <div
              style={{
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                borderRadius: "16px",
                padding: "36px",
              }}
              data-testid="state-payment-failed"
            >
              <h3 style={{ color: "#ef4444", margin: "0 0 10px 0" }}>
                Payment was not completed. Your hold is still active.
              </h3>
              <p style={{ color: "var(--text-body)", margin: "0 0 24px 0" }}>
                {errorMessage || "We could not capture payment for your deposit. Please try again."}
              </p>
              <button
                type="button"
                className="button button--solid"
                onClick={() => setPageState("pay_deposit")}
              >
                Try again
              </button>
            </div>
          )}

          {/* State 10b: PAYMENT_CANCELLED */}
          {pageState === "payment_cancelled" && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "36px",
                boxShadow: "0 12px 32px rgba(13, 13, 15, 0.08)",
              }}
              data-testid="state-payment-cancelled"
            >
              <h3 style={{ margin: "0 0 10px 0" }}>
                Payment cancelled — your hold is still active until {holdUntilText}.
              </h3>
              <p style={{ color: "var(--text-body)", margin: "0 0 24px 0" }}>
                No charge was made. You can resume checkout before your hold window expires.
              </p>
              <button
                type="button"
                className="button button--solid"
                onClick={() => setPageState("pay_deposit")}
              >
                Pay again
              </button>
            </div>
          )}

          {/* State 10c: CAPTURE_UNCERTAIN (network drop during capture) */}
          {pageState === "capture_uncertain" && (
            <div
              style={{
                background: "rgba(245, 158, 11, 0.08)",
                border: "1px solid rgba(245, 158, 11, 0.3)",
                borderRadius: "16px",
                padding: "36px",
              }}
              data-testid="state-capture-uncertain"
            >
              <h3 style={{ margin: "0 0 10px 0" }}>We couldn&apos;t confirm the payment yet</h3>
              <p style={{ color: "var(--text-body)", margin: "0 0 24px 0" }}>
                {errorMessage ||
                  "A network interruption prevented us from receiving PayPal's capture confirmation. Check your payment status before trying again."}
              </p>
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="button button--solid"
                  onClick={() => {
                    void handleCheckUncertainStatus();
                  }}
                  disabled={isCheckingStatus}
                >
                  {isCheckingStatus ? "Checking status..." : "Check payment status"}
                </button>
                <button
                  type="button"
                  className="button button--outline"
                  onClick={() => setPageState("pay_deposit")}
                  disabled={isCheckingStatus}
                >
                  Try again
                </button>
              </div>
            </div>
          )}

          {/* State 11a: APPROVED_AWAITING_AGENT (Approve-only for MCP holds, P0-6) */}
          {pageState === "approved_awaiting_agent" && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "36px",
                boxShadow: "0 12px 32px rgba(13, 13, 15, 0.08)",
              }}
              data-testid="state-approved-awaiting-agent"
            >
              <div
                style={{
                  background: "rgba(16, 185, 129, 0.12)",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                  borderRadius: "8px",
                  padding: "16px 20px",
                  marginBottom: "24px",
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <span className="signal-dot signal-dot--emerald" style={{ flexShrink: 0 }}></span>
                <div>
                  <strong style={{ color: "#10b981" }}>
                    Approved. Your assistant can now complete the booking.
                  </strong>
                  <div style={{ fontSize: "14px", color: "var(--text-body)", marginTop: "4px" }}>
                    Your one-time approval token is ready for your agent to finalize the
                    reservation.
                  </div>
                </div>
              </div>

              {details && (
                <div style={{ marginBottom: "28px" }}>
                  <h3 style={{ margin: "0 0 8px 0" }}>{details.serviceName}</h3>
                  {timePresentation && (
                    <div style={{ color: "var(--text-body)", fontSize: "15px" }}>
                      {timePresentation.merchantTime}
                    </div>
                  )}
                </div>
              )}

              <Link to="/schedule" className="button button--solid">
                View in Schedule &rarr;
              </Link>
            </div>
          )}

          {/* State 11: ALREADY_DONE */}
          {pageState === "already_done" && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "36px",
              }}
              data-testid="state-already-done"
            >
              <div
                style={{
                  background: "rgba(16, 185, 129, 0.12)",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                  borderRadius: "8px",
                  padding: "16px 20px",
                  marginBottom: "24px",
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <span className="signal-dot signal-dot--emerald" style={{ flexShrink: 0 }}></span>
                <div>
                  <strong style={{ color: "#10b981" }}>
                    This booking has already been confirmed.
                  </strong>
                  <div style={{ fontSize: "14px", color: "var(--text-body)", marginTop: "4px" }}>
                    Your reservation is securely recorded.
                  </div>
                </div>
              </div>

              {details && (
                <div style={{ marginBottom: "28px" }}>
                  <h3 style={{ margin: "0 0 8px 0" }}>{details.serviceName}</h3>
                  {timePresentation && (
                    <div style={{ color: "var(--text-body)", fontSize: "15px" }}>
                      {timePresentation.merchantTime}
                    </div>
                  )}
                </div>
              )}

              <Link to="/schedule" className="button button--solid">
                View in Schedule &rarr;
              </Link>
            </div>
          )}

          {/* State 9: CONFIRMED */}
          {pageState === "confirmed" && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "36px",
                boxShadow: "0 12px 32px rgba(13, 13, 15, 0.08)",
              }}
              data-testid="state-confirmed"
            >
              <div
                style={{
                  background: "rgba(16, 185, 129, 0.12)",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                  borderRadius: "8px",
                  padding: "16px 20px",
                  marginBottom: "28px",
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <span className="signal-dot signal-dot--emerald" style={{ flexShrink: 0 }}></span>
                <div>
                  <strong style={{ color: "#10b981", fontSize: "18px" }}>Booking Confirmed!</strong>
                  <div style={{ fontSize: "14px", color: "var(--text-body)", marginTop: "4px" }}>
                    Your appointment has been successfully scheduled and paid.
                  </div>
                </div>
              </div>

              {details && (
                <div style={{ marginBottom: "28px" }}>
                  <h2 style={{ margin: "0 0 12px 0", fontSize: "28px" }}>{details.serviceName}</h2>
                  {details.resourceName && (
                    <p style={{ color: "var(--text-dim)", margin: "0 0 16px 0", fontSize: "16px" }}>
                      With {details.resourceName}
                    </p>
                  )}

                  {timePresentation && (
                    <div
                      style={{
                        padding: "16px",
                        background: "var(--ground)",
                        borderRadius: "8px",
                        border: "1px solid var(--hairline)",
                        marginBottom: "20px",
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: "16px" }}>
                        {timePresentation.merchantTime}
                      </div>
                      {timePresentation.yourTime && (
                        <div
                          style={{ fontSize: "14px", color: "var(--text-dim)", marginTop: "4px" }}
                        >
                          {timePresentation.yourTime}
                        </div>
                      )}
                    </div>
                  )}

                  {confirmedBookingId && (
                    <div className="mono" style={{ fontSize: "13px", color: "var(--text-dim)" }}>
                      Confirmation ID: <span className="mono text-muted">{confirmedBookingId}</span>
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginTop: "32px" }}>
                <Link to="/schedule" className="button button--solid">
                  View in Schedule &rarr;
                </Link>
                <button type="button" className="button button--secondary" onClick={openDrawer}>
                  Book another with Ask AI
                </button>
                <Link to="/" className="button button--outline">
                  Back to home
                </Link>
                {details && (
                  <a
                    href={`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(details.serviceName)}&dates=${details.startsAt.replace(/[-:]/g, "").replace(/\.\d+/, "")}/${details.endsAt.replace(/[-:]/g, "").replace(/\.\d+/, "")}&details=${encodeURIComponent("VelvetAI Luxury Grooming Reservation")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="button button--outline"
                  >
                    Add to Google Calendar ↗
                  </a>
                )}
              </div>
            </div>
          )}

          {/* State 7: PAY_DEPOSIT */}
          {pageState === "pay_deposit" && details && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "36px",
                boxShadow: "0 12px 32px rgba(13, 13, 15, 0.08)",
              }}
              data-testid="state-pay-deposit"
            >
              <div
                style={{
                  background: "rgba(245, 158, 11, 0.12)",
                  border: "1px solid rgba(245, 158, 11, 0.3)",
                  borderRadius: "8px",
                  padding: "16px 20px",
                  marginBottom: "28px",
                }}
              >
                <strong style={{ color: "#f59e0b" }}>
                  Approved — pay the {priceDisplay.deposit ? `${priceDisplay.deposit} ` : ""}
                  deposit to confirm
                </strong>
                <div style={{ fontSize: "14px", color: "var(--text-body)", marginTop: "4px" }}>
                  Deposit required to confirm. Please complete payment before the window closes.
                </div>
              </div>

              <div style={{ marginBottom: "28px" }}>
                <h2 style={{ margin: "0 0 10px 0", fontSize: "28px" }}>{details.serviceName}</h2>
                {timePresentation && (
                  <div style={{ color: "var(--text-body)", fontSize: "15px" }}>
                    {timePresentation.merchantTime}
                  </div>
                )}
              </div>

              {priceDisplay.deposit && (
                <div
                  style={{
                    padding: "20px",
                    background: "var(--ground)",
                    borderRadius: "10px",
                    border: "1px solid var(--hairline)",
                    marginBottom: "28px",
                  }}
                >
                  <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    DEPOSIT DUE NOW
                  </span>
                  <div style={{ fontSize: "24px", fontWeight: 700, marginTop: "6px" }}>
                    {priceDisplay.deposit}
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--text-dim)", marginTop: "4px" }}>
                    {details.cancellationSummary}
                  </div>
                </div>
              )}

              <PayPalButton
                bookingId={confirmedBookingId || details.bookingId}
                serverTimeOffsetMs={serverTimeOffset}
                initialPaymentExpiresAt={details.paymentExpiresAt ?? null}
                orderIdempotencyKey={
                  paymentOrderKeys?.bookingId === (confirmedBookingId || details.bookingId)
                    ? paymentOrderKeys.key
                    : undefined
                }
                getCaptureIdempotencyKey={getCaptureIdempotencyKey}
                onPaymentOutcome={handlePaymentOutcome}
                onCancel={() => setPageState("payment_cancelled")}
                onPaymentExpired={() => {
                  setPaymentWindowExpired(true);
                  setPageState("expired");
                }}
                onCaptureNetworkError={() => {
                  setErrorMessage(null);
                  setPageState("capture_uncertain");
                }}
              />
            </div>
          )}

          {/* State 2 & 3: SIGN_IN_REQUIRED or READY */}
          {(pageState === "sign_in_required" || pageState === "ready") && details && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "36px",
                boxShadow: "0 12px 32px rgba(13, 13, 15, 0.08)",
              }}
              data-testid={
                pageState === "sign_in_required" ? "state-sign-in-required" : "state-ready"
              }
            >
              {/* Countdown banner */}
              <div
                style={{
                  background: "rgba(245, 158, 11, 0.12)",
                  border: "1px solid rgba(245, 158, 11, 0.3)",
                  borderRadius: "8px",
                  padding: "16px 20px",
                  marginBottom: "28px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <span className="signal-dot signal-dot--gold" style={{ flexShrink: 0 }}></span>
                  <div>
                    <strong style={{ color: "#f59e0b" }}>Reserved for you</strong>
                    <div style={{ fontSize: "14px", color: "var(--text-body)", marginTop: "2px" }}>
                      Hold expires in <strong className="mono">{countdownText}</strong>
                    </div>
                  </div>
                </div>
              </div>

              {/* Service & Time Info */}
              <div style={{ marginBottom: "28px" }}>
                {attributionText && (
                  <p className="eyebrow mono" style={{ marginBottom: "6px" }}>
                    {attributionText.toUpperCase()}
                  </p>
                )}
                <h2 style={{ margin: "0 0 10px 0", fontSize: "28px" }}>{details.serviceName}</h2>
                {details.resourceName && (
                  <p style={{ color: "var(--text-dim)", margin: "0 0 12px 0", fontSize: "16px" }}>
                    With {details.resourceName}
                  </p>
                )}
                {timePresentation && (
                  <div>
                    <div style={{ fontSize: "16px", fontWeight: 600 }}>
                      {timePresentation.merchantTime}
                    </div>
                    {timePresentation.yourTime && (
                      <div
                        style={{ fontSize: "14px", color: "var(--text-dim)", marginTop: "4px" }}
                        data-testid="secondary-time"
                      >
                        {timePresentation.yourTime}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Financial Breakdown */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "20px",
                  padding: "24px 0",
                  borderTop: "1px solid var(--hairline)",
                  borderBottom: "1px solid var(--hairline)",
                  marginBottom: "28px",
                }}
              >
                <div>
                  <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    ALL-IN TOTAL
                  </span>
                  <div style={{ marginTop: "6px", fontWeight: 700, fontSize: "20px" }}>
                    {priceDisplay.price || "—"}
                  </div>
                </div>

                <div>
                  <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    DEPOSIT DUE NOW
                  </span>
                  <div style={{ marginTop: "6px", fontWeight: 700, fontSize: "20px" }}>
                    {priceDisplay.deposit || "—"}
                  </div>
                </div>

                {details.durationMinutes && (
                  <div>
                    <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                      DURATION
                    </span>
                    <div style={{ marginTop: "6px", fontWeight: 600, fontSize: "18px" }}>
                      {details.durationMinutes} min
                    </div>
                  </div>
                )}
              </div>

              {/* Policy & Terms Summary */}
              <div
                style={{
                  background: "var(--ground)",
                  borderRadius: "10px",
                  padding: "16px 20px",
                  marginBottom: "28px",
                  border: "1px solid var(--hairline)",
                }}
              >
                <div className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                  CANCELLATION & REFUND POLICY
                </div>
                <div style={{ marginTop: "6px", fontSize: "14px", lineHeight: "1.5" }}>
                  {details.cancellationSummary}
                </div>
              </div>

              {/* Sign In Required State */}
              {pageState === "sign_in_required" && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "16px",
                  }}
                >
                  <p style={{ color: "var(--text-dim)", margin: 0, fontSize: "14px" }}>
                    Please sign in to authorize this appointment.
                  </p>
                  <button
                    type="button"
                    className="button button--solid"
                    onClick={() =>
                      loginWithRedirect({
                        appState: { returnTo: window.location.pathname + window.location.search },
                      })
                    }
                  >
                    Sign in to approve &rarr;
                  </button>
                </div>
              )}

              {/* Ready State */}
              {pageState === "ready" && (
                <div>
                  {/* Terms Checkbox */}
                  <div style={{ marginBottom: "24px" }}>
                    <label
                      htmlFor="terms-checkbox"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        cursor: "pointer",
                        fontSize: "14px",
                      }}
                    >
                      <input
                        id="terms-checkbox"
                        data-testid="terms-checkbox"
                        type="checkbox"
                        checked={agreedToTerms}
                        onChange={(e) => setAgreedToTerms(e.target.checked)}
                        style={{ width: "18px", height: "18px", accentColor: "var(--accent)" }}
                      />
                      <span>I agree to these terms</span>
                    </label>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "16px",
                    }}
                  >
                    <div>
                      {details.preparedBySurface === "mcp" && (
                        <button
                          type="button"
                          className="button button--ghost"
                          onClick={handleApproveOnly}
                          style={{ fontSize: "13px", color: "var(--text-dim)" }}
                        >
                          Approve only (let my assistant finish)
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      className="button button--solid"
                      onClick={handleApproveAndCommit}
                      disabled={!agreedToTerms}
                      data-testid="approve-button"
                    >
                      Approve and continue to payment &rarr;
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
