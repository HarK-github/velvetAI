import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type FC,
  type ReactNode,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useAuth0 } from "@auth0/auth0-react";
import { formatMoney } from "@velvetai/contracts";
import { apiClient, API_BASE_URL } from "../api-client.js";
import { isAuth0Configured, isMockAuthEnabled, computeAuthDiagnostic } from "../lib/auth-config.js";
import { useRouter } from "../router.js";
import { formatUserLocalSlot } from "../lib/timezone.js";
import { useAskAI, type ActiveHoldState, type ActiveQuoteState } from "../context/AskAIContext.js";
import { SafeMarkdown } from "./SafeMarkdown.js";

export interface ProviderStatus {
  provider: "fake" | "gemini";
  model: string | null;
  realProviderConfigured: boolean;
  realProviderVerified: boolean;
}

export interface AskAIDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  authToken?: string;
}

interface AskAIDrawerInnerProps extends AskAIDrawerProps {
  tokenResolver?: () => Promise<string | undefined>;
  isAuthLoading?: boolean;
  isAuthenticated?: boolean;
  initialTokenPending?: boolean;
  authError?: Error | null;
  userEmail?: string;
  userName?: string;
  onSignIn?: () => void;
}

export interface ProcessedItem {
  id: string;
  kind: "text" | "tool";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolResult?: any;
  toolArgs?: any;
  isPending?: boolean;
  isIntermediateLookup?: boolean;
  timestamp?: string;
}

/**
 * Returns a human-friendly action label for velvetAI tools
 */
export function getToolActionLabel(toolName: string): string {
  const clean = toolName.toLowerCase().replace(/[._]v\d+$/, "");
  if (clean.includes("list_service") || clean.includes("catalog")) {
    return "Services";
  }
  if (clean.includes("find_available") || clean.includes("slot")) {
    return "Available times";
  }
  if (clean.includes("quote")) {
    return "Quote";
  }
  if (clean.includes("prepare_booking") || clean.includes("hold")) {
    return "Ready for your approval";
  }
  if (clean.includes("prepare_cancel")) {
    return "Cancellation policy";
  }
  if (clean.includes("get_booking")) {
    return "Booking status";
  }
  return toolName.replace(/[._]/g, " ");
}

/**
 * Calculates user local time formatted via Intl when the browser time zone
 * differs from the merchant time zone. Uses readable zone abbreviation (e.g. "IST").
 */
export function getUserLocalTime(startsAt?: string, merchantTimeZone?: string): string | null {
  return formatUserLocalSlot(startsAt, merchantTimeZone);
}

/**
 * Small neutral chip for intermediate tool steps or unknown outputs.
 * Never renders raw JSON, "[object Object]", or empty cards.
 */
export const ToolStepChip: FC<{
  label: string;
  onToggle?: () => void;
  isExpanded?: boolean;
  children?: ReactNode;
}> = ({ label, onToggle, isExpanded, children }) => {
  return (
    <div className="ai-tool-step-container">
      <button
        type="button"
        className="ai-tool-step-chip mono"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={label}
      >
        <span>✓ {label}</span>
        {onToggle && <span style={{ fontSize: "9px" }}>{isExpanded ? "▲" : "▼"}</span>}
      </button>
      {isExpanded && children}
    </div>
  );
};

const ExpandableLookupChip: FC<{ label: string; children: ReactNode }> = ({ label, children }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <ToolStepChip label={label} isExpanded={isExpanded} onToggle={() => setIsExpanded(!isExpanded)}>
      {children}
    </ToolStepChip>
  );
};

/**
 * Explicit card for list_services.v1 output
 */
export const ServiceListCard: FC<{
  services: any[];
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({ services, isLiveEnvironment, timestamp }) => {
  const seenIds = new Set<string>();
  const uniqueServices: any[] = [];
  for (const s of services) {
    const id = s?.id || `srv-${uniqueServices.length}`;
    if (!seenIds.has(id)) {
      seenIds.add(id);
      uniqueServices.push(s);
    }
  }

  return (
    <div className="ai-tool-card" data-testid="service-list-card">
      <div className="ai-tool-card-header mono">
        <div className="ai-tool-header-left">
          <span className="ai-tool-action-name">Services</span>
        </div>
        <div className="ai-tool-header-right">
          <span className="ai-tool-count">{uniqueServices.length} services</span>
          {timestamp && <span className="ai-tool-time">{timestamp}</span>}
          <span
            className={`ai-tool-env-tag ${
              isLiveEnvironment ? "ai-tool-env-tag--live" : "ai-tool-env-tag--dev"
            }`}
          >
            {isLiveEnvironment ? "LIVE DATA" : "SYNTHETIC DEV"}
          </span>
        </div>
      </div>
      <div className="ai-tool-card-content">
        <div className="ai-services-grid">
          {uniqueServices.map((s) => {
            const name = s.name || s.versions?.[0]?.name || "Service";
            const duration =
              s.durationMinutes ??
              s.duration_minutes ??
              s.versions?.[0]?.durationMinutes ??
              s.versions?.[0]?.duration_minutes ??
              45;
            const priceObj =
              s.price && typeof s.price === "object"
                ? s.price
                : {
                    valueMinor:
                      s.priceMinor ??
                      s.price_minor ??
                      s.versions?.[0]?.priceMinor ??
                      s.versions?.[0]?.price_minor ??
                      "0",
                    currency: s.currency ?? s.versions?.[0]?.currency ?? "USD",
                  };
            const formattedPrice = s.formattedPrice || formatMoney(priceObj);
            const depositObj =
              s.deposit && typeof s.deposit === "object"
                ? s.deposit
                : {
                    valueMinor:
                      s.depositMinor ??
                      s.baseDepositMinor ??
                      s.base_deposit_minor ??
                      s.versions?.[0]?.baseDepositMinor ??
                      s.versions?.[0]?.base_deposit_minor ??
                      "0",
                    currency: s.currency ?? s.versions?.[0]?.currency ?? "USD",
                  };
            const rawDeposit = depositObj.valueMinor;
            const hasDeposit =
              rawDeposit !== undefined &&
              rawDeposit !== null &&
              rawDeposit !== "" &&
              rawDeposit !== "0" &&
              rawDeposit !== 0;
            const formattedDeposit = hasDeposit
              ? s.formattedDeposit || formatMoney(depositObj)
              : null;

            return (
              <div key={s.id} className="ai-service-item">
                <div className="ai-service-item-main">
                  <strong className="ai-service-name">{name}</strong>
                  <div className="mono text-muted ai-service-details">
                    {duration} min • {formattedPrice}
                    {formattedDeposit && ` • Deposit: ${formattedDeposit}`}
                  </div>
                </div>
                {s.description && <p className="ai-service-desc">{s.description}</p>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/**
 * Explicit card for find_available_slots.v1 output
 */
export const SlotsCard: FC<{
  toolResult: any;
  toolArgs?: any;
  onSelectSlot: (slotOrPrompt: any, toolResult?: any, toolArgs?: any) => void;
  isQuoting?: boolean;
  isHolding?: boolean;
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({
  toolResult,
  toolArgs,
  onSelectSlot,
  isQuoting = false,
  isHolding = false,
  isLiveEnvironment,
  timestamp,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const slots: any[] = Array.isArray(toolResult?.slots) ? toolResult.slots : [];

  const serviceName = toolResult?.serviceName || toolArgs?.serviceName || "Executive Haircut";
  const firstSlot = slots[0];
  const localDate = toolResult?.resolvedDate || firstSlot?.display?.localDate || "Tomorrow";
  const zoneLabel = firstSlot?.display?.timeZoneLabel || toolResult?.timeZone || "EST";

  const cardHeader = `Available times · ${serviceName} · ${localDate} · ${zoneLabel}`;
  const displayedSlots = isExpanded ? slots : slots.slice(0, 8);
  const hasMore = slots.length > 8;

  return (
    <div className="ai-tool-card" data-testid="slots-card">
      <div className="ai-tool-card-header mono">
        <div className="ai-tool-header-left">
          <span className="ai-tool-action-name">{cardHeader}</span>
        </div>
        <div className="ai-tool-header-right">
          <span className="ai-tool-count">{slots.length} slots</span>
          {timestamp && <span className="ai-tool-time">{timestamp}</span>}
          <span
            className={`ai-tool-env-tag ${
              isLiveEnvironment ? "ai-tool-env-tag--live" : "ai-tool-env-tag--dev"
            }`}
          >
            {isLiveEnvironment ? "LIVE DATA" : "SYNTHETIC DEV"}
          </span>
        </div>
      </div>
      <div className="ai-tool-card-content">
        <div className="ai-slots-grid" role="group" aria-label="Available booking time slots">
          {displayedSlots.map((slot, idx) => {
            const startLabel =
              slot.display?.localStart ||
              (slot.startsAt
                ? new Date(slot.startsAt).toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: true,
                    timeZone: slot.timeZone || "America/New_York",
                  })
                : "Slot");
            const endLabel = slot.display?.localEnd;
            const slotZone = slot.display?.timeZoneLabel || zoneLabel;
            const slotDate = slot.display?.localDate || localDate;
            const primaryTime = `${startLabel}${endLabel ? ` – ${endLabel}` : ""} ${slotZone}`;

            const merchantTz = slot.display?.timeZone || slot.timeZone || "America/New_York";
            const userLocal = getUserLocalTime(slot.startsAt, merchantTz);

            const promptToSend = `Prepare the ${startLabel} ${slotZone} ${serviceName} slot on ${slotDate}`;

            return (
              <button
                key={idx}
                type="button"
                className="ai-slot-button mono"
                onClick={() => onSelectSlot(slot, toolResult, toolArgs)}
                data-prompt={promptToSend}
                disabled={isQuoting || isHolding}
                aria-label={`Select slot at ${primaryTime}`}
              >
                <span className="ai-slot-primary-time">{primaryTime}</span>
                {userLocal && <span className="ai-slot-user-time">Your time: {userLocal}</span>}
              </button>
            );
          })}
          {hasMore && (
            <button
              type="button"
              className="ai-slot-more-btn mono"
              onClick={() => setIsExpanded(!isExpanded)}
              aria-label={isExpanded ? "Show fewer" : `+${slots.length - 8} more`}
            >
              {isExpanded ? "Show fewer" : `+${slots.length - 8} more`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Explicit card for quote_booking.v1 output
 */
export const QuoteCard: FC<{
  toolResult: any;
  toolArgs?: any;
  onHoldThisTime?: (quote: any, args?: any) => void;
  onPickDifferentTime?: () => void;
  onRefreshQuote?: (quote: any, args?: any) => void;
  isHolding?: boolean;
  isActionDisabled?: boolean;
  isAlreadyHeld?: boolean;
  replacePrompt?: {
    activeHoldTime: string;
    onConfirm: () => void;
    onCancel: () => void;
  } | null;
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({
  toolResult,
  toolArgs,
  onHoldThisTime,
  onPickDifferentTime,
  onRefreshQuote,
  isHolding = false,
  isActionDisabled = false,
  isAlreadyHeld = false,
  replacePrompt = null,
  isLiveEnvironment,
  timestamp,
}) => {
  const serviceName = toolResult?.serviceName || toolArgs?.serviceName || "Service";
  const display = toolResult?.display;
  const startsAt = toolResult?.startsAt || toolArgs?.startsAt;
  const merchantZone = display?.timeZone || toolArgs?.timeZone || "America/New_York";

  const expiresAt = toolResult?.expiresAt;
  const [secondsRemaining, setSecondsRemaining] = useState<number>(() => {
    if (!expiresAt) return 300;
    const diff = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
    return Math.max(0, diff);
  });

  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => {
      const diff = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
      setSecondsRemaining(Math.max(0, diff));
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const isExpired = secondsRemaining <= 0;
  const mins = Math.floor(secondsRemaining / 60);
  const secs = secondsRemaining % 60;
  const formattedCountdown = `${mins}:${secs < 10 ? "0" : ""}${secs}`;

  const localDate =
    display?.localDate ||
    (startsAt
      ? new Date(startsAt).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: merchantZone,
        })
      : "Upcoming Appointment");

  const localStart =
    display?.localStart ||
    (startsAt
      ? new Date(startsAt).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: merchantZone,
        })
      : "");

  const localEnd = display?.localEnd || "";
  const zoneLabel =
    display?.timeZoneLabel || (merchantZone.includes("New_York") ? "EST" : merchantZone);

  const primaryTimeStr = `${localDate}${localStart ? ` · ${localStart}${localEnd ? ` – ${localEnd}` : ""} ${zoneLabel}` : ""}`;
  const userLocal = startsAt ? getUserLocalTime(startsAt, merchantZone) : null;

  const totalMoney = toolResult?.total ? formatMoney(toolResult.total) : "$0.00";
  const depositMoney = toolResult?.deposit ? formatMoney(toolResult.deposit) : "$0.00";

  let balanceMoney = "$0.00";
  try {
    const totalMinor = BigInt(toolResult?.total?.valueMinor ?? 0);
    const depositMinor = BigInt(toolResult?.deposit?.valueMinor ?? 0);
    const balanceMinor = totalMinor >= depositMinor ? totalMinor - depositMinor : 0n;
    balanceMoney = formatMoney({
      valueMinor: balanceMinor.toString(),
      currency: toolResult?.total?.currency || "USD",
    });
  } catch {
    balanceMoney = "$0.00";
  }

  const policySummary =
    toolResult?.cancellationPolicy?.summary ||
    "Full deposit refund if cancelled at least 24 hours prior to appointment.";

  return (
    <div className="ai-tool-card" data-testid="quote-card">
      <div className="ai-tool-card-header mono">
        <div className="ai-tool-header-left">
          <span className="ai-tool-action-name">Quote · {serviceName}</span>
        </div>
        <div className="ai-tool-header-right">
          {timestamp && <span className="ai-tool-time">{timestamp}</span>}
          <span
            className={`ai-tool-env-tag ${
              isLiveEnvironment ? "ai-tool-env-tag--live" : "ai-tool-env-tag--dev"
            }`}
          >
            {isLiveEnvironment ? "LIVE DATA" : "SYNTHETIC DEV"}
          </span>
        </div>
      </div>
      <div className="ai-tool-card-content">
        <div className="ai-quote-card">
          <div className="ai-quote-header">
            <div className="ai-quote-service-title">{serviceName}</div>
            <div className="ai-quote-time-row mono">{primaryTimeStr}</div>
            {userLocal && <div className="ai-quote-user-time mono">Your time: {userLocal}</div>}
          </div>

          <div className="ai-quote-financials mono">
            <div className="ai-quote-fin-row ai-quote-fin-row--total">
              <span>Total Price:</span>
              <span>{totalMoney}</span>
            </div>
            <div className="ai-quote-fin-row ai-quote-fin-row--deposit">
              <span>Deposit Required:</span>
              <span>{depositMoney}</span>
            </div>
            <div className="ai-quote-fin-row ai-quote-fin-row--balance">
              <span>Balance Due at Appointment:</span>
              <span>{balanceMoney}</span>
            </div>
          </div>

          <div className="ai-quote-policy">
            <strong>Cancellation:</strong> {policySummary}
          </div>

          <div className="ai-quote-expiry mono">
            <span>⏱ Guaranteed Quote</span>
            <span>{isExpired ? "Quote expired" : `Expires in ${formattedCountdown}`}</span>
          </div>

          <div
            className="ai-quote-actions"
            style={{ marginTop: "12px", display: "flex", gap: "8px" }}
          >
            {isAlreadyHeld ? (
              <button
                type="button"
                className="button button--primary button--sm is-held"
                disabled
                aria-label="Held"
              >
                Held ✓
              </button>
            ) : isExpired ? (
              <button
                type="button"
                className="button button--primary button--sm"
                onClick={() => onRefreshQuote?.(toolResult, toolArgs)}
                disabled={isHolding || isActionDisabled}
                aria-label="Refresh quote"
              >
                Refresh quote
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary button--sm"
                onClick={() => onHoldThisTime?.(toolResult, toolArgs)}
                disabled={isHolding || isActionDisabled}
                aria-label="Hold this time"
              >
                {isHolding ? "Holding slot..." : "Hold this time"}
              </button>
            )}
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={() => onPickDifferentTime?.()}
              disabled={isHolding || isActionDisabled}
              aria-label="Pick a different time"
            >
              Pick a different time
            </button>
          </div>
          {replacePrompt && (
            <div className="ai-hold-replace-prompt" role="alert">
              <div>You&apos;re already holding {replacePrompt.activeHoldTime}. Replace it?</div>
              <div className="ai-hold-replace-actions">
                <button
                  type="button"
                  className="button button--primary button--sm"
                  onClick={replacePrompt.onConfirm}
                  disabled={isHolding || isActionDisabled}
                >
                  Yes, replace hold
                </button>
                <button
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={replacePrompt.onCancel}
                  disabled={isHolding || isActionDisabled}
                >
                  Keep existing
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export function extractCleanLocator(raw: string): string {
  return String(raw || "")
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^.*\/v1\/booking-approvals\//, "")
    .replace(/^.*\/approve\?intent=/, "")
    .replace(/^.*\/approve\//, "")
    .replace(/^\/+/, "");
}

export function formatHoldTimeSummary(
  startsAt?: string,
  display?: { localDate?: string; localStart?: string; timeZoneLabel?: string },
  timeZone = "America/New_York",
): string {
  if (display?.localDate && display?.localStart) {
    return `${display.localDate} at ${display.localStart}${display.timeZoneLabel ? ` ${display.timeZoneLabel}` : ""}`;
  }
  if (!startsAt) return "another time";
  try {
    const dt = new Date(startsAt);
    if (isNaN(dt.getTime())) return "another time";
    const dateStr = dt.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone,
    });
    const timeStr = dt.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    });
    return `${dateStr} at ${timeStr}`;
  } catch {
    return "another time";
  }
}

export function formatAskAIErrorMessage(err: unknown): { message: string; isAuthError: boolean } {
  const errAny = err as { message?: string; status?: number; code?: string; name?: string } | null;
  const rawMsg =
    err instanceof Error ? err.message : typeof err === "string" ? err : errAny?.message || "";
  let parsedCode = errAny?.code || "";
  let parsedDetail = "";
  const status = errAny?.status;

  if (rawMsg.includes("{")) {
    const jsonStart = rawMsg.indexOf("{");
    try {
      const parsed = JSON.parse(rawMsg.slice(jsonStart)) as Record<string, unknown>;
      if (typeof parsed.code === "string") parsedCode = parsed.code;
      if (typeof parsed.error === "string" && !parsedCode) parsedCode = parsed.error;
      if (typeof parsed.detail === "string") parsedDetail = parsed.detail;
      else if (typeof parsed.message === "string") parsedDetail = parsed.message;
      else if (typeof parsed.title === "string") parsedDetail = parsed.title;
    } catch {
      // Ignore partial / non-JSON text
    }
  }

  const combined = `${rawMsg} ${parsedCode} ${parsedDetail}`;

  if (
    err instanceof TypeError ||
    /failed to fetch|networkerror|network request failed|load failed/i.test(combined)
  ) {
    return {
      message: "Connection problem — check your network and try again.",
      isAuthError: false,
    };
  }

  if (status === 401 || /AUTH_REQUIRED|AUTHENTICATION_FAILED|unauthorized|401/i.test(combined)) {
    return {
      message: "Authentication required. Please sign in with Auth0 to access the concierge.",
      isAuthError: true,
    };
  }

  if (parsedCode === "user_not_provisioned" || /user_not_provisioned/i.test(combined)) {
    return {
      message: "Your account isn't set up yet. Click Retry in a moment to finish setup.",
      isAuthError: false,
    };
  }

  if (parsedCode === "CONCURRENCY_LIMIT_EXCEEDED" || /CONCURRENCY_LIMIT_EXCEEDED/i.test(combined)) {
    return {
      message: "Another concierge request is still finishing. Please wait a moment and try again.",
      isAuthError: false,
    };
  }

  if (
    parsedCode === "RATE_LIMIT_EXCEEDED" ||
    status === 429 ||
    /RATE_LIMIT_EXCEEDED|\b429\b/i.test(combined)
  ) {
    return {
      message: "Rate limit of 60 requests per minute reached. Please wait a moment.",
      isAuthError: false,
    };
  }

  if (combined.includes("ai_provider_authentication")) {
    return {
      message: "AI provider authentication failed. Please verify provider credentials.",
      isAuthError: false,
    };
  }
  if (combined.includes("ai_model_not_found")) {
    return { message: "AI model not found or currently unavailable.", isAuthError: false };
  }
  if (combined.includes("ai_quota_exceeded")) {
    return { message: "AI quota exceeded. Please try again later.", isAuthError: false };
  }
  if (combined.includes("ai_provider_unavailable") || status === 503 || /\b503\b/.test(combined)) {
    return {
      message: "AI Provider service is currently unavailable. Please try again shortly.",
      isAuthError: false,
    };
  }
  if (combined.includes("ai_stream_error")) {
    return {
      message: "An error occurred during AI response streaming. Please retry.",
      isAuthError: false,
    };
  }
  if (status === 403 || /\b403\b/.test(combined)) {
    return {
      message: "Access forbidden. Your account lacks necessary permissions or active membership.",
      isAuthError: false,
    };
  }

  return {
    message: parsedDetail || rawMsg || "Failed to process request. Please try again.",
    isAuthError: false,
  };
}

/**
 * Explicit card for prepare_booking.v1 output
 */
export const ApprovalCard: FC<{
  toolResult: any;
  toolArgs?: any;
  onOpenApproval?: (locator: string) => void;
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({ toolResult, toolArgs, onOpenApproval, isLiveEnvironment, timestamp }) => {
  const serviceName =
    toolResult?.terms?.serviceName ||
    toolResult?.serviceName ||
    toolArgs?.serviceName ||
    "Executive Haircut & Beard Sculpt";

  const display = toolResult?.terms?.display || toolResult?.display;
  const startsAt = toolResult?.terms?.startsAt || toolResult?.startsAt || toolArgs?.startsAt;
  const timeZone = toolResult?.terms?.timeZone || toolResult?.timeZone || "America/New_York";

  const localDate =
    display?.localDate ||
    (startsAt
      ? new Date(startsAt).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone,
        })
      : "Tomorrow");

  const localStart =
    display?.localStart ||
    (startsAt
      ? new Date(startsAt).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone,
        })
      : "2:00 PM");

  const zoneLabel = display?.timeZoneLabel || (timeZone.includes("New_York") ? "EDT" : timeZone);

  const rawLocator =
    toolResult?.approvalLocator || toolResult?.approval_locator || toolResult?.approvalUrl || "";
  const cleanLocator = extractCleanLocator(rawLocator);
  const isReleased = toolResult?.status === "CANCELLED";

  return (
    <div className="ai-tool-card" data-testid="approval-card">
      <div className="ai-tool-card-header mono">
        <div className="ai-tool-header-left">
          <span className="ai-tool-action-name">
            {isReleased ? "Previous hold released" : "Ready for your approval"}
          </span>
        </div>
        <div className="ai-tool-header-right">
          <span className="ai-tool-count" style={{ color: isReleased ? "#94a3b8" : "#f59e0b" }}>
            {isReleased ? "Released" : "Hold active · 5m window"}
          </span>
          {timestamp && <span className="ai-tool-time">{timestamp}</span>}
          <span
            className={`ai-tool-env-tag ${
              isLiveEnvironment ? "ai-tool-env-tag--live" : "ai-tool-env-tag--dev"
            }`}
          >
            {isLiveEnvironment ? "LIVE DATA" : "SYNTHETIC DEV"}
          </span>
        </div>
      </div>
      <div className="ai-tool-card-content">
        <div className="ai-approval-card">
          <div className="ai-hold-badge">
            <span>{isReleased ? "○ HOLD RELEASED" : "● HOLD ACTIVE"}</span>
            <span className="mono">{isReleased ? "Replaced" : "5m Window"}</span>
          </div>
          <div style={{ marginTop: "6px", fontWeight: 600, color: "#ffffff", fontSize: "13px" }}>
            {serviceName}
          </div>
          <div className="mono text-muted" style={{ fontSize: "11px", margin: "2px 0 6px 0" }}>
            {localDate} at {localStart} {zoneLabel}
          </div>
          <p
            style={{
              margin: "6px 0 10px 0",
              fontSize: "12px",
              color: "#cbd5e1",
            }}
          >
            {isReleased
              ? "This earlier hold was released when you selected a new time."
              : "Your AI assistant reserved this time for you. Review terms and approve to book."}
          </p>
          {!isReleased && cleanLocator && (
            <button
              type="button"
              className="button button--solid ai-review-terms-button"
              id="ai-open-approval-btn"
              onClick={() => onOpenApproval?.(cleanLocator)}
            >
              Open approval page
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Explicit card for get_booking.v1 output
 */
export const BookingStatusCard: FC<{
  toolResult: any;
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({ toolResult, isLiveEnvironment, timestamp }) => {
  const status = toolResult?.status || "HELD";
  const startsAt = toolResult?.startsAt;
  const userLocal = startsAt ? getUserLocalTime(startsAt) : null;

  return (
    <div className="ai-tool-card" data-testid="booking-status-card">
      <div className="ai-tool-card-header mono">
        <div className="ai-tool-header-left">
          <span className="ai-tool-action-name">Booking status</span>
        </div>
        <div className="ai-tool-header-right">
          <span className="ai-tool-count">{status}</span>
          {timestamp && <span className="ai-tool-time">{timestamp}</span>}
          <span
            className={`ai-tool-env-tag ${
              isLiveEnvironment ? "ai-tool-env-tag--live" : "ai-tool-env-tag--dev"
            }`}
          >
            {isLiveEnvironment ? "LIVE DATA" : "SYNTHETIC DEV"}
          </span>
        </div>
      </div>
      <div className="ai-tool-card-content">
        <div
          style={{
            padding: "8px",
            background: "#252836",
            borderRadius: "6px",
            fontSize: "12px",
          }}
        >
          <div>
            Status:{" "}
            <strong
              style={{
                color: status === "CONFIRMED" ? "var(--emerald, #10b981)" : "#f59e0b",
              }}
            >
              {status}
            </strong>
          </div>
          {startsAt && (
            <div className="mono text-muted" style={{ marginTop: "4px", fontSize: "11px" }}>
              Time: {new Date(startsAt).toLocaleString()}
              {userLocal && ` (Your time: ${userLocal})`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Explicit card for prepare_cancellation.v1 output
 */
export const CancellationCard: FC<{
  toolResult: any;
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({ toolResult, isLiveEnvironment, timestamp }) => {
  const allowed = toolResult?.cancellationAllowed;
  const policySummary = toolResult?.policySummary || "Standard cancellation terms apply.";
  const refundFormatted = toolResult?.refundEligibleMinor
    ? formatMoney({
        valueMinor: toolResult.refundEligibleMinor,
        currency: toolResult.currency || "USD",
      })
    : null;

  return (
    <div className="ai-tool-card" data-testid="cancellation-card">
      <div className="ai-tool-card-header mono">
        <div className="ai-tool-header-left">
          <span className="ai-tool-action-name">Cancellation policy</span>
        </div>
        <div className="ai-tool-header-right">
          {timestamp && <span className="ai-tool-time">{timestamp}</span>}
          <span
            className={`ai-tool-env-tag ${
              isLiveEnvironment ? "ai-tool-env-tag--live" : "ai-tool-env-tag--dev"
            }`}
          >
            {isLiveEnvironment ? "LIVE DATA" : "SYNTHETIC DEV"}
          </span>
        </div>
      </div>
      <div className="ai-tool-card-content">
        <div
          style={{
            padding: "8px",
            background: "#252836",
            borderRadius: "6px",
            fontSize: "12px",
          }}
        >
          <div>
            Cancellation: <strong>{allowed ? "Permitted" : "Not permitted"}</strong>
          </div>
          {refundFormatted && (
            <div>
              Refund Eligible:{" "}
              <strong style={{ color: "var(--emerald, #10b981)" }}>{refundFormatted}</strong>
            </div>
          )}
          <div className="text-muted" style={{ marginTop: "4px", fontSize: "11px" }}>
            {policySummary}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Clean neutral notice for tool error results
 */
export const ToolErrorCard: FC<{
  message: string;
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({ message, isLiveEnvironment, timestamp }) => {
  return (
    <div
      className="ai-tool-card"
      style={{ borderColor: "rgba(239, 68, 68, 0.4)" }}
      data-testid="tool-error-card"
    >
      <div className="ai-tool-card-header mono">
        <div className="ai-tool-header-left">
          <span style={{ color: "var(--crimson, #ef4444)", fontWeight: 600 }}>Notice</span>
        </div>
        <div className="ai-tool-header-right">
          {timestamp && <span className="ai-tool-time">{timestamp}</span>}
          <span
            className={`ai-tool-env-tag ${
              isLiveEnvironment ? "ai-tool-env-tag--live" : "ai-tool-env-tag--dev"
            }`}
          >
            {isLiveEnvironment ? "LIVE DATA" : "SYNTHETIC DEV"}
          </span>
        </div>
      </div>
      <div className="ai-tool-card-content" style={{ color: "#fca5a5", fontSize: "12px" }}>
        {message}
      </div>
    </div>
  );
};

/**
 * Context-aware assistant follow-up prompt suggestions (T6 / P1-14)
 * Computes suggestions from the conversation tail and never emits "Hold <time>" when slots are empty.
 */
export function computeFollowUpSuggestions(items: ProcessedItem[]): string[] {
  const toolItems = items.filter((it) => it.kind === "tool" && it.toolResult);
  const tailToolItems = [...toolItems].reverse();
  const latestTool = tailToolItems[0];

  if (latestTool) {
    if (
      latestTool.toolName?.includes("prepare_cancel") ||
      latestTool.toolResult?.cancellationAllowed !== undefined
    ) {
      if (latestTool.toolResult?.cancellationAllowed) {
        return ["Confirm cancellation", "Keep booking"];
      }
      return ["Check booking status", "Find a new time"];
    }

    if (
      latestTool.toolName?.includes("get_booking") ||
      (latestTool.toolResult?.bookingId &&
        latestTool.toolResult?.status &&
        !latestTool.toolResult?.approvalLocator &&
        !latestTool.toolResult?.approvalUrl)
    ) {
      const bookingStatus = String(latestTool.toolResult.status).toUpperCase();
      if (bookingStatus === "HELD") {
        return ["Open approval page", "Cancel this booking"];
      }
      if (bookingStatus === "CANCELLED") {
        return ["Find a new time", "Show available services"];
      }
      return ["Show available services", "Check another booking"];
    }
  }

  // Check for highest-order active action from conversation tail
  const prepareItem = tailToolItems.find(
    (it) =>
      (it.toolName?.includes("prepare_booking") ||
        it.toolResult?.approvalLocator ||
        it.toolResult?.approvalUrl) &&
      it.toolResult?.status !== "CANCELLED",
  );
  if (prepareItem) {
    return ["Open approval page", "Find a different time"];
  }

  const quoteItem = tailToolItems.find(
    (it) => it.toolName?.includes("quote") || (it.toolResult?.total && it.toolResult?.deposit),
  );
  if (quoteItem) {
    const isExpired =
      quoteItem.toolResult?.expiresAt &&
      new Date(quoteItem.toolResult.expiresAt).getTime() <= Date.now();
    if (isExpired) {
      return ["Refresh quote", "Pick a different time"];
    }
    return ["Hold this time", "Pick a different time"];
  }

  const slotsItem = tailToolItems.find(
    (it) => it.toolName?.includes("find_available") || it.toolResult?.slots !== undefined,
  );
  if (slotsItem) {
    const slots = Array.isArray(slotsItem.toolResult?.slots) ? slotsItem.toolResult.slots : [];
    if (slots.length === 0) {
      return ["Check another day", "Show available services"];
    }
    const firstSlot = slots[0];
    const timeLabel = firstSlot?.display?.localStart || "next available slot";
    return [`Hold ${timeLabel}`, "Show tomorrow morning", "Try another day"];
  }

  const servicesItem = tailToolItems.find(
    (it) => it.toolName?.includes("list_service") || it.toolResult?.services,
  );
  if (servicesItem) {
    const topService = servicesItem.toolResult?.services?.[0]?.name || "Executive Haircut";
    return [`Show times for ${topService}`, "Compare deposits"];
  }

  return [
    "Show available services",
    "Find available haircut slots tomorrow afternoon",
    "Prepare the 2 PM slot",
  ];
}

/**
 * Authoritatively processes and groups message stream parts:
 * - One UI result group per toolCallId.
 * - Intermediate catalog lookups collapsed to ToolStepChip.
 * - Deduplicates streaming tool items while preserving distinct services.
 * - Never leaves empty cards or raw data dumps.
 */
export function processMessageParts(
  parts: any[] | undefined,
  fallbackContent?: string,
): ProcessedItem[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    if (fallbackContent) {
      return [{ id: "fallback-text", kind: "text", text: fallbackContent }];
    }
    return [];
  }

  const items: ProcessedItem[] = [];
  const toolCallMap = new Map<string, number>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    if (part.type === "text" && typeof part.text === "string") {
      items.push({
        id: `text-${i}`,
        kind: "text",
        text: part.text,
      });
      continue;
    }

    const isTool =
      part.type?.includes("tool") ||
      part.toolName !== undefined ||
      part.toolCallId !== undefined ||
      part.toolInvocation !== undefined;

    if (isTool) {
      const toolInvocation = part.toolInvocation || {};
      const toolCallId: string =
        part.toolCallId ||
        toolInvocation.toolCallId ||
        part.id ||
        `tool-${part.toolName || "tool"}-${i}`;

      const toolName: string = part.toolName || toolInvocation.toolName || part.name || "Tool";

      const toolResult: any =
        part.output ?? part.result ?? toolInvocation.result ?? toolInvocation.output;

      const toolArgs: any = part.args ?? toolInvocation.args;
      const isPending =
        !toolResult && (part.type === "tool-call" || toolInvocation.state === "call");

      if (toolCallMap.has(toolCallId)) {
        // In-place update: stream chunk updates existing card without appending
        const existingIdx = toolCallMap.get(toolCallId)!;
        const existing = items[existingIdx];
        if (existing) {
          if (toolResult !== undefined) {
            existing.toolResult = toolResult;
            existing.isPending = false;
          }
          if (toolArgs !== undefined) {
            existing.toolArgs = toolArgs;
          }
          if (toolName && (!existing.toolName || existing.toolName === "Tool")) {
            existing.toolName = toolName;
          }
        }
      } else {
        const itemIdx = items.length;
        toolCallMap.set(toolCallId, itemIdx);
        items.push({
          id: toolCallId,
          kind: "tool",
          toolCallId,
          toolName,
          toolResult,
          toolArgs,
          isPending,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
      }
    }
  }

  // Deduplication & intermediate lookup detection:
  // 1. If multiple list_services calls exist in this message turn, keep only the latest one
  const listServiceIndices = items
    .map((it, idx) =>
      it.kind === "tool" && (it.toolName?.includes("list_service") || it.toolResult?.services)
        ? idx
        : -1,
    )
    .filter((idx) => idx !== -1);

  if (listServiceIndices.length > 1) {
    for (let i = listServiceIndices.length - 2; i >= 0; i--) {
      const removeIdx = listServiceIndices[i]!;
      items.splice(removeIdx, 1);
    }
  }

  // 2. Deduplicate find_available_slots: if multiple slot calls in the same turn, keep only the latest one
  const slotIndices = items
    .map((it, idx) =>
      it.kind === "tool" && (it.toolName?.includes("find_available") || it.toolResult?.slots)
        ? idx
        : -1,
    )
    .filter((idx) => idx !== -1);

  if (slotIndices.length > 1) {
    for (let i = slotIndices.length - 2; i >= 0; i--) {
      const removeIdx = slotIndices[i]!;
      items.splice(removeIdx, 1);
    }
  }

  // 3. If there is a quote or prepare in the turn, and any list_services appears AFTER it, remove that subsequent list_services
  const firstQuoteOrPrepareIdx = items.findIndex(
    (it) =>
      it.kind === "tool" &&
      (it.toolName?.includes("quote") ||
        (it.toolResult?.total && it.toolResult?.deposit) ||
        it.toolName?.includes("prepare_booking") ||
        it.toolResult?.approvalLocator ||
        it.toolResult?.approvalUrl),
  );

  if (firstQuoteOrPrepareIdx !== -1) {
    for (let i = items.length - 1; i > firstQuoteOrPrepareIdx; i--) {
      const it = items[i];
      if (
        it?.kind === "tool" &&
        (it.toolName?.includes("list_service") || it.toolResult?.services)
      ) {
        items.splice(i, 1);
      }
    }
  }

  // 4. Check if this turn also contains slots, quote, or prepare
  const hasFollowOnAction = items.some(
    (it) =>
      it.kind === "tool" &&
      (it.toolName?.includes("find_available") ||
        it.toolResult?.slots ||
        it.toolName?.includes("quote") ||
        (it.toolResult?.total && it.toolResult?.deposit) ||
        it.toolName?.includes("prepare_booking") ||
        it.toolResult?.approvalLocator ||
        it.toolResult?.approvalUrl),
  );

  for (const it of items) {
    if (it.kind === "tool" && (it.toolName?.includes("list_service") || it.toolResult?.services)) {
      if (hasFollowOnAction) {
        it.isIntermediateLookup = true;
      }
    }
  }

  return items;
}

function isQuoteToolPart(part: any): boolean {
  if (!part || typeof part !== "object") return false;
  const toolName = String(
    part.toolName ||
      (typeof part.type === "string" && part.type.startsWith("tool-") ? part.type.slice(5) : ""),
  ).toLowerCase();
  if (toolName.includes("quote")) return true;
  const res = part.output ?? part.result;
  return Boolean(res && typeof res === "object" && res.total && res.deposit);
}

function replaceActiveQuoteMessage(prevMessages: any[], newQuoteMsg: any): any[] {
  const cleaned = prevMessages
    .map((msg) => {
      if (!msg || !Array.isArray(msg.parts)) return msg;
      const keptParts = msg.parts.filter((part: any) => !isQuoteToolPart(part));
      if (keptParts.length === msg.parts.length) return msg;
      const hasMeaningfulContent = keptParts.some(
        (p: any) =>
          (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) ||
          (p.type && p.type !== "text" && p.type !== "step-start"),
      );
      if (!hasMeaningfulContent) return null;
      return { ...msg, parts: keptParts };
    })
    .filter(Boolean);
  return [...cleaned, newQuoteMsg];
}

const HOLD_BOILERPLATE_TEXT =
  "I have prepared your booking hold. Please review and approve on the approval page.";

function buildHoldConversationMessages(
  prevMessages: any[],
  newPrepMsg: any,
  releasedBookingId?: string,
): any[] {
  let extractedReleasedPart: any | null = null;

  const cleaned = prevMessages
    .map((msg) => {
      if (!msg || !Array.isArray(msg.parts)) return msg;
      const keptParts: any[] = [];
      for (const part of msg.parts) {
        if (
          part?.type === "text" &&
          typeof part.text === "string" &&
          part.text.trim() === HOLD_BOILERPLATE_TEXT
        ) {
          continue;
        }
        const res = part?.output ?? part?.result;
        if (
          releasedBookingId &&
          res &&
          typeof res === "object" &&
          res.bookingId === releasedBookingId
        ) {
          extractedReleasedPart =
            part.output !== undefined
              ? { ...part, output: { ...res, status: "CANCELLED" } }
              : { ...part, result: { ...res, status: "CANCELLED" } };
          continue;
        }
        keptParts.push(part);
      }

      const hasMeaningfulContent = keptParts.some(
        (p: any) =>
          (p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) ||
          (p?.type && p.type !== "text" && p.type !== "step-start"),
      );
      if (!hasMeaningfulContent) return null;
      return { ...msg, parts: keptParts };
    })
    .filter(Boolean);

  if (extractedReleasedPart) {
    const releasedMsg = {
      id: `msg-released-${Date.now()}`,
      role: "assistant",
      parts: [extractedReleasedPart],
    };
    return [...cleaned, releasedMsg, newPrepMsg];
  }

  return [...cleaned, newPrepMsg];
}

function deriveLatestHoldFromMessages(msgs: any[]): ActiveHoldState | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    const parts = processMessageParts(msg?.parts, msg?.content);
    for (let j = parts.length - 1; j >= 0; j--) {
      const item = parts[j];
      if (!item) continue;
      if (
        item.kind === "tool" &&
        item.toolResult &&
        (item.toolResult.approvalLocator ||
          item.toolResult.approvalUrl ||
          item.toolName?.includes("prepare_booking"))
      ) {
        if (item.toolResult.status === "CANCELLED") {
          return null;
        }
        const bookingId = item.toolResult.bookingId || "";
        if (!bookingId) continue;
        const rawLocator =
          item.toolResult.approvalLocator ||
          item.toolResult.approval_locator ||
          item.toolResult.approvalUrl ||
          "";
        const locator = extractCleanLocator(rawLocator);
        const terms = item.toolResult.terms || item.toolResult;
        const startsAt = terms?.startsAt || item.toolArgs?.startsAt || "";
        const timeZone = terms?.timeZone || item.toolArgs?.timeZone || "America/New_York";
        const serviceId =
          terms?.serviceId || item.toolArgs?.serviceId || "01932b10-0001-7000-8000-000000000001";
        const serviceName = terms?.serviceName || item.toolArgs?.serviceName || "Service";
        const display = terms?.display;
        return {
          bookingId,
          locator,
          serviceId,
          locationId: terms?.locationId || item.toolArgs?.locationId,
          serviceName,
          startsAt,
          timeZone,
          holdExpiresAt: item.toolResult.holdExpiresAt,
          timeLabel: formatHoldTimeSummary(startsAt, display, timeZone),
          status: "HELD",
        };
      }
    }
  }
  return null;
}

const AskAIDrawerInner: FC<AskAIDrawerInnerProps> = ({
  isOpen,
  onClose,
  authToken,
  tokenResolver,
  isAuthLoading = false,
  isAuthenticated = false,
  initialTokenPending = false,
  authError = null,
  userEmail,
  userName,
  onSignIn,
}) => {
  const { navigate } = useRouter();
  const askAiCtx = useAskAI();
  const [inputVal, setInputVal] = useState("");
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [streamAnnouncement, setStreamAnnouncement] = useState("");
  const [isQuotingSlot, setIsQuotingSlot] = useState(false);
  const [isHoldingSlot, setIsHoldingSlot] = useState(false);
  const [fallbackActiveHold, setFallbackActiveHold] = useState<ActiveHoldState | null>(null);
  const [pendingReplaceHold, setPendingReplaceHold] = useState<{
    quoteData: any;
    quoteArgs?: any;
    existingHold: ActiveHoldState;
  } | null>(null);
  const isQuotingRef = useRef(false);
  const isHoldingRef = useRef(false);
  const isSyncingFromContextRef = useRef(false);
  const lastHydrationVersionRef = useRef<number>(-1);
  const lastClearVersionRef = useRef<number>(askAiCtx.clearVersion);
  const lastPromptRef = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isAuthDisabled = isAuth0Configured()
    ? Boolean(isAuthLoading || !isAuthenticated || initialTokenPending)
    : Boolean(!isMockAuthEnabled() && !authToken);

  const isSignedOut = isAuth0Configured()
    ? Boolean(!isAuthLoading && !isAuthenticated)
    : Boolean(!isMockAuthEnabled() && !authToken && !apiClient.getAuthToken());

  const apiBaseUrl = API_BASE_URL;

  // Keep latest tokenResolver in ref to prevent rebuilding transport while ensuring fresh resolution before every request
  const tokenResolverRef = useRef(tokenResolver);
  useEffect(() => {
    tokenResolverRef.current = tokenResolver;
  }, [tokenResolver]);

  // Fetch provider status honesty endpoint only when the drawer is open (P1-15)
  useEffect(() => {
    if (!isOpen) return;
    let mounted = true;
    fetch(`${apiBaseUrl}/v1/ai/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ProviderStatus | null) => {
        if (mounted && data) {
          setProviderStatus(data);
        }
      })
      .catch(() => {});

    return () => {
      mounted = false;
    };
  }, [apiBaseUrl, isOpen]);

  // Compute honest model label
  const statusLabel = useMemo(() => {
    if (!providerStatus) return "Deterministic Demo Model";
    if (providerStatus.provider === "fake") {
      return "Deterministic Demo Model";
    }
    if (providerStatus.provider === "gemini") {
      if (!providerStatus.realProviderVerified) {
        return "Gemini • Not yet verified";
      }
      return "Gemini (live)";
    }
    return "Deterministic Demo Model";
  }, [providerStatus]);

  // Dynamic authenticated transport resolving token immediately before every request
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${apiBaseUrl}/v1/ai/chat`,
        headers: async () => {
          let token = authToken;
          if (!token && tokenResolverRef.current) {
            token = await tokenResolverRef.current();
          }
          if (!token) {
            token = apiClient.getAuthToken();
          }
          if (token) {
            computeAuthDiagnostic(token);
            return {
              authorization: `Bearer ${token}`,
            };
          }
          if (isAuth0Configured()) {
            throw new Error(
              "AUTH_REQUIRED: Authentication required. Please sign in with Auth0 to access the concierge.",
            );
          }
          if (isMockAuthEnabled()) {
            return {
              authorization:
                "Bearer test-token:01932b10-0000-7000-8000-000000000002:01932b10-0000-7000-8000-000000000001:BUYER:1",
            };
          }
          throw new Error("AUTH_REQUIRED: Authentication required. Please sign in with Auth0.");
        },
      }),
    [apiBaseUrl, authToken],
  );

  const { messages, sendMessage, stop, status, error, setMessages, regenerate } = useChat({
    transport,
  });

  const [authPromptError, setAuthPromptError] = useState<Error | null>(null);

  const updateActiveHold = useCallback(
    (hold: ActiveHoldState | null) => {
      setFallbackActiveHold(hold);
      if (askAiCtx.hasProvider) {
        askAiCtx.setActiveHold(hold);
      }
    },
    [askAiCtx],
  );

  // Restore persisted conversation from AskAIContext on mount or sessionStorage hydration
  useEffect(() => {
    if (!askAiCtx.hasProvider) return;
    if (
      lastHydrationVersionRef.current !== askAiCtx.hydrationVersion &&
      askAiCtx.messages.length > 0
    ) {
      lastHydrationVersionRef.current = askAiCtx.hydrationVersion;
      isSyncingFromContextRef.current = true;
      setMessages(askAiCtx.messages);
    } else if (lastHydrationVersionRef.current === -1) {
      lastHydrationVersionRef.current = askAiCtx.hydrationVersion;
      if (askAiCtx.messages.length > 0 && messages.length === 0) {
        isSyncingFromContextRef.current = true;
        setMessages(askAiCtx.messages);
      }
    }
  }, [
    askAiCtx.hasProvider,
    askAiCtx.hydrationVersion,
    askAiCtx.messages,
    messages.length,
    setMessages,
  ]);

  // Mirror local chat messages and derived hold state back into AskAIContext for route/reload persistence
  useEffect(() => {
    if (!askAiCtx.hasProvider) return;
    if (isSyncingFromContextRef.current) {
      isSyncingFromContextRef.current = false;
      return;
    }
    if (messages.length > 0) {
      askAiCtx.setMessages(messages);
      const derivedHold = deriveLatestHoldFromMessages(messages);
      if (derivedHold && askAiCtx.activeHold?.bookingId !== derivedHold.bookingId) {
        askAiCtx.setActiveHold(derivedHold);
      }
    }
  }, [askAiCtx, messages]);

  // Respond cleanly to explicit logout / context reset
  useEffect(() => {
    if (!askAiCtx.hasProvider) return;
    if (lastClearVersionRef.current !== askAiCtx.clearVersion) {
      lastClearVersionRef.current = askAiCtx.clearVersion;
      stop();
      if (typeof setMessages === "function") setMessages([]);
      setFallbackActiveHold(null);
      setPendingReplaceHold(null);
      setAuthPromptError(null);
    }
  }, [askAiCtx.hasProvider, askAiCtx.clearVersion, setMessages, stop]);

  const effectiveActiveHold: ActiveHoldState | null = useMemo(() => {
    if (askAiCtx.hasProvider) {
      return askAiCtx.activeHold ?? deriveLatestHoldFromMessages(messages);
    }
    return fallbackActiveHold ?? deriveLatestHoldFromMessages(messages);
  }, [askAiCtx.hasProvider, askAiCtx.activeHold, fallbackActiveHold, messages]);

  const isLoading = status === "streaming" || status === "submitted";

  // Aria-live announcement for stream completion
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current === "streaming" && status === "ready") {
      setStreamAnnouncement("Concierge response complete.");
      // If provider was not yet verified, refetch status to reflect live verification
      if (providerStatus && !providerStatus.realProviderVerified) {
        fetch(`${apiBaseUrl}/v1/ai/status`)
          .then((res) => (res.ok ? res.json() : null))
          .then((data: ProviderStatus | null) => {
            if (data) setProviderStatus(data);
          })
          .catch(() => {});
      }
    }
    prevStatusRef.current = status;
  }, [status, apiBaseUrl, providerStatus]);

  // Abort active chat stream on logout
  const prevAuthRef = useRef(isAuthenticated);
  useEffect(() => {
    if (prevAuthRef.current === true && isAuthenticated === false) {
      stop();
      if (typeof setMessages === "function") setMessages([]);
      setFallbackActiveHold(null);
      setPendingReplaceHold(null);
      setAuthPromptError(null);
      if (askAiCtx.hasProvider) {
        askAiCtx.clearConversation({ resetAuth: true });
      }
    }
    prevAuthRef.current = isAuthenticated;
  }, [isAuthenticated, stop, setMessages, askAiCtx]);

  // Auto-scroll to bottom of conversation
  useEffect(() => {
    if (isOpen && typeof messagesEndRef.current?.scrollIntoView === "function") {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isOpen, isLoading]);

  // Auto-focus input when drawer opens
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Keyboard navigation: Escape key closes drawer
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleSignIn = useCallback(() => {
    if (onSignIn) {
      onSignIn();
    }
  }, [onSignIn]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = inputVal.trim();
    if (!text || isLoading) return;
    if (isAuthDisabled) {
      if (!isAuthenticated && isAuth0Configured()) {
        setAuthPromptError(
          new Error(
            "AUTH_REQUIRED: Authentication required. Please sign in with Auth0 to access the concierge.",
          ),
        );
      }
      return;
    }
    setAuthPromptError(null);
    lastPromptRef.current = text;
    setInputVal("");
    sendMessage({ text });
  };

  const handleQuickPrompt = (prompt: string) => {
    if (isLoading) return;
    if (isAuthDisabled) {
      if (!isAuthenticated && isAuth0Configured()) {
        setAuthPromptError(
          new Error(
            "AUTH_REQUIRED: Authentication required. Please sign in with Auth0 to access the concierge.",
          ),
        );
      }
      return;
    }
    setAuthPromptError(null);
    lastPromptRef.current = prompt;
    sendMessage({ text: prompt });
  };

  const handleSlotClick = async (slotOrPrompt: any, toolResult?: any, toolArgs?: any) => {
    if (typeof slotOrPrompt === "string") {
      handleQuickPrompt(slotOrPrompt);
      return;
    }

    if (isQuotingRef.current || isHoldingRef.current) return;
    isQuotingRef.current = true;
    setIsQuotingSlot(true);
    setPendingReplaceHold(null);

    try {
      const slot = slotOrPrompt;
      const serviceId =
        slot.serviceId ||
        toolResult?.serviceId ||
        toolArgs?.serviceId ||
        "01932b10-0001-7000-8000-000000000001";
      const locationId =
        slot.locationId ||
        toolResult?.locationId ||
        toolArgs?.locationId ||
        "01932b10-0002-7000-8000-000000000001";
      const startsAt = slot.startsAt;
      const timeZone = slot.timeZone || toolResult?.timeZone || "America/New_York";

      const quoteRes = await apiClient.createBookingQuote({
        serviceId,
        locationId,
        startsAt,
        timeZone,
      });

      const resolvedServiceName = quoteRes.serviceName || toolResult?.serviceName;
      if (askAiCtx.hasProvider) {
        const nextQuote: ActiveQuoteState = {
          quoteId: quoteRes.quoteId,
          serviceId,
          locationId,
          serviceName: resolvedServiceName,
          startsAt,
          timeZone,
          expiresAt: quoteRes.expiresAt,
        };
        askAiCtx.setActiveQuote(nextQuote);
      }

      const quoteCallId = `quote-direct-${Date.now()}`;
      const quoteMsg: any = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            toolCallId: quoteCallId,
            toolName: "quote_booking.v1",
            result: quoteRes,
            args: {
              serviceId,
              locationId,
              startsAt,
              timeZone,
              serviceName: resolvedServiceName,
            },
          },
        ],
      };
      setMessages((prev) => replaceActiveQuoteMessage(prev, quoteMsg));
    } catch (err: any) {
      const formatted = formatAskAIErrorMessage(err);
      const errorMsg: any = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: `Unable to quote slot: ${formatted.message}`,
          },
        ],
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      isQuotingRef.current = false;
      setIsQuotingSlot(false);
    }
  };

  const executePrepareHold = async (
    quoteData: any,
    quoteArgs?: any,
    replaceOldHold?: ActiveHoldState,
  ) => {
    if (isHoldingRef.current) return;
    isHoldingRef.current = true;
    setIsHoldingSlot(true);

    try {
      const serviceId =
        quoteData.serviceId || quoteArgs?.serviceId || "01932b10-0001-7000-8000-000000000001";
      const locationId =
        quoteData.locationId || quoteArgs?.locationId || "01932b10-0002-7000-8000-000000000001";
      const startsAt = quoteData.startsAt || quoteArgs?.startsAt;
      const timeZone = quoteData.display?.timeZone || quoteArgs?.timeZone || "America/New_York";

      if (replaceOldHold) {
        const prepCancel = await apiClient.prepareCancellation(replaceOldHold.bookingId, {
          reason: "Replacing held slot with new selection",
        });
        if (!prepCancel.cancellationAllowed || !prepCancel.cancellationConfirmationToken) {
          throw new Error(
            prepCancel.policySummary || "Could not release your previous hold before rebooking.",
          );
        }
        await apiClient.cancelBooking(replaceOldHold.bookingId, {
          cancellationConfirmationToken: prepCancel.cancellationConfirmationToken,
          reason: "Replacing held slot with new selection",
        });
      }

      const actionScope = `askai-prep:${quoteData.quoteId || `${serviceId}:${startsAt}`}`;
      const idempotencyKey = apiClient.getOrCreateActionKey(actionScope, "askai-prep");
      const prepareRes = await apiClient.prepareBooking(
        {
          serviceId,
          locationId,
          startsAt,
          timeZone,
          customer: {
            email: userEmail || "guest@velvetai.internal",
            displayName: userName || "Valued Customer",
          },
          note: "Prepared by Ask AI",
        },
        "ask-ai",
        idempotencyKey,
      );

      const resolvedServiceName =
        quoteData.serviceName || quoteArgs?.serviceName || prepareRes.terms?.serviceName;
      const locator = extractCleanLocator(prepareRes.approvalLocator || "");
      const newHold: ActiveHoldState = {
        bookingId: prepareRes.bookingId,
        locator,
        serviceId,
        locationId,
        serviceName: resolvedServiceName,
        startsAt,
        timeZone,
        holdExpiresAt: prepareRes.holdExpiresAt,
        timeLabel: formatHoldTimeSummary(startsAt, quoteData.display, timeZone),
        quoteId: quoteData.quoteId,
        status: "HELD",
      };
      updateActiveHold(newHold);
      setPendingReplaceHold(null);

      const prepCallId = `prep-direct-${Date.now()}`;
      const prepMsg: any = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            toolCallId: prepCallId,
            toolName: "prepare_booking.v1",
            result: prepareRes,
            args: {
              serviceId,
              locationId,
              startsAt,
              timeZone,
              serviceName: resolvedServiceName,
            },
          },
          {
            type: "text",
            text: HOLD_BOILERPLATE_TEXT,
          },
        ],
      };
      setMessages((prev) =>
        buildHoldConversationMessages(prev, prepMsg, replaceOldHold?.bookingId),
      );
    } catch (err: any) {
      const formatted = formatAskAIErrorMessage(err);
      const errorMsg: any = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: `Unable to prepare hold: ${formatted.message}`,
          },
        ],
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      isHoldingRef.current = false;
      setIsHoldingSlot(false);
    }
  };

  const handleHoldThisTime = async (quoteData: any, quoteArgs?: any) => {
    if (isHoldingRef.current || isQuotingRef.current) return;

    const targetServiceId =
      quoteData.serviceId || quoteArgs?.serviceId || "01932b10-0001-7000-8000-000000000001";
    const targetStartsAt = quoteData.startsAt || quoteArgs?.startsAt;

    if (effectiveActiveHold && effectiveActiveHold.status === "HELD") {
      const isSameSlot =
        effectiveActiveHold.serviceId === targetServiceId &&
        effectiveActiveHold.startsAt === targetStartsAt;
      if (isSameSlot) {
        return;
      }
      setPendingReplaceHold({
        quoteData,
        quoteArgs,
        existingHold: effectiveActiveHold,
      });
      return;
    }

    await executePrepareHold(quoteData, quoteArgs);
  };

  const handleConfirmReplaceHold = async () => {
    if (!pendingReplaceHold) return;
    await executePrepareHold(
      pendingReplaceHold.quoteData,
      pendingReplaceHold.quoteArgs,
      pendingReplaceHold.existingHold,
    );
  };

  const handleCancelReplaceHold = () => {
    setPendingReplaceHold(null);
  };

  const openApprovalPage = useCallback(
    (rawLocator: string) => {
      const cleanLocator = extractCleanLocator(rawLocator);
      if (!cleanLocator) return;
      navigate(`/approve/${cleanLocator}`);
    },
    [navigate],
  );

  const handleFollowUpClick = (prompt: string) => {
    if (isQuotingRef.current || isHoldingRef.current || isLoading) return;
    if (prompt === "Open approval page") {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const parts = processMessageParts(msg?.parts, (msg as any)?.content);
        const approvalItem = parts.find(
          (p) =>
            (p.toolResult?.approvalUrl || p.toolResult?.approvalLocator) &&
            p.toolResult?.status !== "CANCELLED",
        );
        if (approvalItem) {
          const rawLocator =
            approvalItem.toolResult?.approvalUrl || approvalItem.toolResult?.approvalLocator;
          openApprovalPage(rawLocator);
          return;
        }
      }
    }

    if (prompt === "Hold this time") {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const parts = processMessageParts(msg?.parts, (msg as any)?.content);
        const quoteItem = parts.find((p) => p.toolResult?.total && p.toolResult?.deposit);
        if (quoteItem) {
          void handleHoldThisTime(quoteItem.toolResult, quoteItem.toolArgs);
          return;
        }
      }
    }

    handleQuickPrompt(prompt);
  };

  const handleRetry = () => {
    if (isLoading) return;
    if (typeof regenerate === "function") {
      regenerate();
    } else if (lastPromptRef.current) {
      sendMessage({ text: lastPromptRef.current });
    }
  };

  const handleClearConversation = () => {
    if (isLoading) {
      stop();
    }
    setMessages([]);
    setFallbackActiveHold(null);
    setPendingReplaceHold(null);
    setAuthPromptError(null);
    if (askAiCtx.hasProvider) {
      askAiCtx.clearConversation();
    } else {
      apiClient.resetActionKeys();
    }
  };

  const handleKeyDownInput = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const getErrorDetails = (err: Error) => formatAskAIErrorMessage(err);

  // Enforce at most one active QuoteCard per conversation (must precede any early returns per Rules of Hooks)
  const processedByMessage = useMemo(
    () =>
      messages.map((m) => ({
        msg: m,
        items: processMessageParts(m.parts, (m as any).content),
      })),
    [messages],
  );

  const latestQuoteItemId = useMemo(() => {
    let latestId: string | null = null;
    for (const entry of processedByMessage) {
      for (const item of entry.items) {
        if (
          item.kind === "tool" &&
          item.toolResult &&
          ((item.toolResult.total && item.toolResult.deposit) || item.toolName?.includes("quote"))
        ) {
          latestId = item.id;
        }
      }
    }
    return latestId;
  }, [processedByMessage]);

  const conversationTailItems = useMemo(
    () => processedByMessage.flatMap((entry) => entry.items),
    [processedByMessage],
  );

  if (!isOpen) return null;

  const isLiveEnvironment = Boolean(
    providerStatus?.provider === "gemini" && providerStatus?.realProviderVerified,
  );

  const activeErrorObj = error || authError || authPromptError;
  const activeErrorDetails = activeErrorObj ? getErrorDetails(activeErrorObj) : null;

  return (
    <div
      className="ai-drawer-overlay"
      role="region"
      aria-label="velvetAI Concierge Assistant"
    >
      <aside className="ai-drawer" tabIndex={-1}>
        {/* Header */}
        <header className="ai-drawer-header">
          <div className="ai-drawer-title-group">
            <span className="ai-status-pulse" aria-hidden="true"></span>
            <div>
              <h2 className="ai-drawer-title">velvetAI Concierge</h2>
              <span id="ai-model-badge" className="ai-drawer-subtitle mono">
                {statusLabel}
              </span>
            </div>
          </div>
          <div className="ai-drawer-header-actions">
            {messages.length > 0 && (
              <button
                type="button"
                className="ai-clear-btn mono"
                onClick={handleClearConversation}
                aria-label="Clear conversation"
                title="Clear conversation"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              className="ai-drawer-close"
              onClick={onClose}
              aria-label="Close concierge drawer"
            >
              ✕
            </button>
          </div>
        </header>

        {/* Live announcement region for accessibility */}
        <div aria-live="polite" className="sr-only">
          {streamAnnouncement}
        </div>

        {/* Message Viewport */}
        <div className="ai-messages-viewport">
          {messages.length === 0 && (
            <div className="ai-empty-state">
              <div className="ai-empty-icon" aria-hidden="true">
                ✦
              </div>
              <h3>Luxury Scheduling Concierge</h3>
              {isSignedOut ? (
                <>
                  <p>
                    Sign in to check live openings, lock in a 5-minute hold, and approve your
                    booking.
                  </p>
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={handleSignIn}
                    aria-label="Sign in or create account"
                  >
                    Sign in or create account
                  </button>
                </>
              ) : (
                <>
                  <p>
                    Ask about services, find open times, get a quote, and hold a time for you to
                    approve.
                  </p>
                  <div className="ai-quick-prompts">
                    <button
                      type="button"
                      className="ai-prompt-pill"
                      onClick={() => handleQuickPrompt("Show available services")}
                    >
                      Show available services
                    </button>
                    <button
                      type="button"
                      className="ai-prompt-pill"
                      onClick={() =>
                        handleQuickPrompt("Find available haircut slots tomorrow afternoon")
                      }
                    >
                      Find available haircut slots tomorrow afternoon
                    </button>
                    <button
                      type="button"
                      className="ai-prompt-pill"
                      onClick={() => handleQuickPrompt("Prepare the 2 PM slot")}
                    >
                      Prepare the 2 PM slot
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {processedByMessage.map(({ msg: m, items: displayItems }) => {
            const isUser = m.role === "user";

            return (
              <div
                key={m.id}
                className={`ai-message-row ${isUser ? "ai-message-row--user" : "ai-message-row--assistant"}`}
              >
                <div className={`ai-bubble ${isUser ? "ai-bubble--user" : "ai-bubble--assistant"}`}>
                  <div className="ai-bubble-meta mono">{isUser ? "You" : "velvetAI Concierge"}</div>

                  {displayItems.map((item) => {
                    if (item.kind === "text" && item.text) {
                      return <SafeMarkdown key={item.id} content={item.text} />;
                    }

                    if (item.kind === "tool") {
                      if (item.isPending) {
                        return (
                          <div key={item.id} className="ai-tool-card">
                            <div className="ai-tool-card-content mono text-muted ai-tool-pending">
                              <span className="ai-typing-indicator">
                                <span></span>
                                <span></span>
                                <span></span>
                              </span>
                              <span>Executing request...</span>
                            </div>
                          </div>
                        );
                      }

                      const toolResult = item.toolResult;
                      if (!toolResult) return null;

                      // 1. Collapsed intermediate catalog lookup (Requirement D.9)
                      if (item.isIntermediateLookup && toolResult.services) {
                        return (
                          <ExpandableLookupChip
                            key={item.id}
                            label={`Checked catalog · ${toolResult.services.length} services`}
                          >
                            <ServiceListCard
                              services={toolResult.services}
                              isLiveEnvironment={isLiveEnvironment}
                              timestamp={item.timestamp}
                            />
                          </ExpandableLookupChip>
                        );
                      }

                      // 2. Tool error results
                      if (toolResult.error || toolResult.code === "COMMIT_NOT_PERMITTED_FOR_AI") {
                        return (
                          <ToolErrorCard
                            key={item.id}
                            message={
                              toolResult.message || toolResult.error || "Operation not permitted"
                            }
                            isLiveEnvironment={isLiveEnvironment}
                            timestamp={item.timestamp}
                          />
                        );
                      }

                      // 3. Available slots card (T1, T2)
                      if (toolResult.slots || item.toolName?.includes("find_available")) {
                        return (
                          <SlotsCard
                            key={item.id}
                            toolResult={toolResult}
                            toolArgs={item.toolArgs}
                            onSelectSlot={handleSlotClick}
                            isQuoting={isQuotingSlot}
                            isHolding={isHoldingSlot}
                            isLiveEnvironment={isLiveEnvironment}
                            timestamp={item.timestamp}
                          />
                        );
                      }

                      // 4. Authoritative quote card (A.2 / P0-2: single active QuoteCard per conversation)
                      if (
                        (toolResult.total && toolResult.deposit) ||
                        item.toolName?.includes("quote")
                      ) {
                        if (latestQuoteItemId && item.id !== latestQuoteItemId) {
                          return null;
                        }
                        const qServiceId =
                          toolResult.serviceId ||
                          item.toolArgs?.serviceId ||
                          "01932b10-0001-7000-8000-000000000001";
                        const qStartsAt = toolResult.startsAt || item.toolArgs?.startsAt;
                        const isAlreadyHeld = Boolean(
                          effectiveActiveHold &&
                          effectiveActiveHold.status === "HELD" &&
                          effectiveActiveHold.serviceId === qServiceId &&
                          effectiveActiveHold.startsAt === qStartsAt,
                        );
                        const matchingReplacePrompt =
                          pendingReplaceHold &&
                          (pendingReplaceHold.quoteData?.quoteId
                            ? pendingReplaceHold.quoteData.quoteId === toolResult.quoteId
                            : pendingReplaceHold.quoteData?.startsAt === qStartsAt)
                            ? {
                                activeHoldTime: pendingReplaceHold.existingHold.timeLabel,
                                onConfirm: () => {
                                  void handleConfirmReplaceHold();
                                },
                                onCancel: handleCancelReplaceHold,
                              }
                            : null;

                        return (
                          <QuoteCard
                            key={item.id}
                            toolResult={toolResult}
                            toolArgs={item.toolArgs}
                            onHoldThisTime={handleHoldThisTime}
                            onRefreshQuote={handleSlotClick}
                            onPickDifferentTime={() =>
                              handleQuickPrompt("Show available haircut slots tomorrow afternoon")
                            }
                            isHolding={isHoldingSlot}
                            isActionDisabled={isQuotingSlot || isHoldingSlot}
                            isAlreadyHeld={isAlreadyHeld}
                            replacePrompt={matchingReplacePrompt}
                            isLiveEnvironment={isLiveEnvironment}
                            timestamp={item.timestamp}
                          />
                        );
                      }

                      // 5. Two-phase prepare booking hold snapshot (Approval card)
                      if (
                        toolResult.approvalLocator ||
                        toolResult.approvalUrl ||
                        item.toolName?.includes("prepare_booking")
                      ) {
                        return (
                          <ApprovalCard
                            key={item.id}
                            toolResult={toolResult}
                            toolArgs={item.toolArgs}
                            onOpenApproval={openApprovalPage}
                            isLiveEnvironment={isLiveEnvironment}
                            timestamp={item.timestamp}
                          />
                        );
                      }

                      // 6. Services list card (explicit service request)
                      if (toolResult.services || item.toolName?.includes("list_service")) {
                        return (
                          <ServiceListCard
                            key={item.id}
                            services={toolResult.services}
                            isLiveEnvironment={isLiveEnvironment}
                            timestamp={item.timestamp}
                          />
                        );
                      }

                      // 7. Booking status card
                      if (toolResult.bookingId && toolResult.status) {
                        return (
                          <BookingStatusCard
                            key={item.id}
                            toolResult={toolResult}
                            isLiveEnvironment={isLiveEnvironment}
                            timestamp={item.timestamp}
                          />
                        );
                      }

                      // 8. Cancellation policy card
                      if (
                        toolResult.cancellationAllowed !== undefined ||
                        item.toolName?.includes("prepare_cancel")
                      ) {
                        return (
                          <CancellationCard
                            key={item.id}
                            toolResult={toolResult}
                            isLiveEnvironment={isLiveEnvironment}
                            timestamp={item.timestamp}
                          />
                        );
                      }

                      // 9. Unknown/unsupported tool output -> neutral chip, NEVER raw JSON or [object Object] (A.3)
                      const actionLabel = getToolActionLabel(item.toolName || "Tool");
                      return (
                        <div key={item.id} className="ai-tool-step-chip mono">
                          ✓ Checked {actionLabel}
                        </div>
                      );
                    }

                    return null;
                  })}
                </div>
              </div>
            );
          })}

          {/* Context-Aware Assistant Follow-up Suggestions Chips (T6 / P1-14) */}
          {!isLoading &&
            !isSignedOut &&
            messages.length > 0 &&
            messages[messages.length - 1]?.role === "assistant" && (
              <div className="ai-followup-chips">
                <span className="mono ai-followup-label">Follow-up:</span>
                {computeFollowUpSuggestions(conversationTailItems).map((prompt, pIdx) => (
                  <button
                    key={pIdx}
                    type="button"
                    className="ai-followup-chip"
                    onClick={() => handleFollowUpClick(prompt)}
                    disabled={isQuotingSlot || isHoldingSlot || isLoading}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}

          {/* Loading Indicator */}
          {isLoading && (
            <div className="ai-message-row ai-message-row--assistant">
              <div className="ai-bubble ai-bubble--assistant ai-bubble--pulsing">
                <div className="ai-bubble-meta mono">velvetAI Concierge</div>
                <div className="ai-typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}

          {/* Error Banner with Sign-in (on 401) or Retry */}
          {activeErrorDetails && (
            <div className="ai-error-banner" role="alert">
              <div className="ai-error-banner-content">
                <strong>Concierge Alert:</strong> {activeErrorDetails.message}
              </div>
              {activeErrorDetails.isAuthError || isSignedOut ? (
                <button
                  type="button"
                  className="button button--primary button--sm"
                  onClick={handleSignIn}
                >
                  Sign in
                </button>
              ) : (
                <button
                  type="button"
                  className="ai-retry-btn mono"
                  onClick={handleRetry}
                  disabled={isLoading}
                >
                  Retry
                </button>
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <form onSubmit={handleSubmit} className="ai-drawer-form">
          <input
            ref={inputRef}
            type="text"
            className="ai-input"
            placeholder="Ask concierge for services, slots, or quotes..."
            title={
              isAuthLoading
                ? "Auth0 initializing..."
                : !isAuthenticated && isAuth0Configured()
                  ? "Please sign in with Auth0 to ask concierge..."
                  : initialTokenPending && isAuth0Configured()
                    ? "Verifying access credentials..."
                    : undefined
            }
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDownInput}
            disabled={isLoading || isAuthDisabled}
            aria-label="Message prompt"
          />
          {isLoading ? (
            <button
              type="button"
              className="button button--outline ai-stop-button"
              onClick={stop}
              aria-label="Stop generation"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="button button--solid ai-send-button"
              disabled={isLoading || isAuthDisabled || !inputVal.trim()}
              aria-label="Send message"
            >
              Send
            </button>
          )}
        </form>
      </aside>
    </div>
  );
};

const AskAIAuth0Resolver: FC<AskAIDrawerProps> = (props) => {
  const { isLoading, isAuthenticated, getAccessTokenSilently, loginWithRedirect, user } =
    useAuth0();
  const [initialTokenPending, setInitialTokenPending] = useState<boolean>(Boolean(isLoading));
  const [authError, setAuthError] = useState<Error | null>(null);

  const audience =
    (typeof import.meta.env !== "undefined"
      ? (import.meta.env.VITE_AUTH0_AUDIENCE as string)
      : "") || "https://velvetai.example/api";
  const scopes =
    "openid profile email booking:read booking:quote booking:prepare booking:commit booking:cancel";

  useEffect(() => {
    let mounted = true;
    if (isLoading) {
      setInitialTokenPending(true);
      return;
    }
    setInitialTokenPending(false);
    if (!isAuthenticated) {
      return;
    }

    Promise.resolve(
      getAccessTokenSilently?.({
        authorizationParams: {
          audience,
          scope: scopes,
        },
      }),
    )
      .then((token) => {
        if (!mounted) return;
        if (token) {
          computeAuthDiagnostic(token);
          apiClient.setAuthToken(token);
        }
        setAuthError(null);
      })
      .catch((err) => {
        if (!mounted) return;
        setAuthError(err instanceof Error ? err : new Error("Token acquisition failed"));
      });

    return () => {
      mounted = false;
    };
  }, [isLoading, isAuthenticated, getAccessTokenSilently, audience, scopes]);

  const tokenResolver = useCallback(async (): Promise<string> => {
    if (!isAuthenticated) {
      throw new Error(
        "AUTH_REQUIRED: Authentication required. Please sign in with Auth0 to access the concierge.",
      );
    }
    try {
      const token = await getAccessTokenSilently({
        authorizationParams: {
          audience,
          scope: scopes,
        },
      });
      if (!token) {
        throw new Error(
          "AUTH_REQUIRED: Failed to acquire Auth0 access token. Please sign in again.",
        );
      }
      computeAuthDiagnostic(token);
      return token;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("AUTH_REQUIRED")) {
        throw err;
      }
      throw new Error("AUTH_REQUIRED: Failed to acquire Auth0 access token. Please sign in again.");
    }
  }, [isAuthenticated, getAccessTokenSilently, audience, scopes]);

  return (
    <AskAIDrawerInner
      {...props}
      isAuthLoading={isLoading}
      isAuthenticated={isAuthenticated}
      initialTokenPending={initialTokenPending}
      authError={authError}
      tokenResolver={tokenResolver}
      userEmail={user?.email}
      userName={user?.name}
      onSignIn={() => {
        if (typeof loginWithRedirect === "function") {
          void loginWithRedirect({
            appState: {
              returnTo:
                typeof window !== "undefined"
                  ? `${window.location.pathname}${window.location.search}`
                  : "/",
            },
          });
        }
      }}
    />
  );
};

export const AskAIDrawer: FC<AskAIDrawerProps> = (props) => {
  if (isAuth0Configured()) {
    return <AskAIAuth0Resolver {...props} />;
  }
  return <AskAIDrawerInner {...props} />;
};
