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
 * differs from the merchant time zone.
 */
export function getUserLocalTime(startsAt?: string, merchantTimeZone?: string): string | null {
  if (!startsAt) return null;
  try {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (merchantTimeZone && browserZone.toLowerCase() === merchantTimeZone.toLowerCase()) {
      return null;
    }
    const date = new Date(startsAt);
    if (isNaN(date.getTime())) return null;
    const formatter = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
    return formatter.format(date);
  } catch {
    return null;
  }
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

const ExpandableLookupChip: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <ToolStepChip
      label={label}
      isExpanded={isExpanded}
      onToggle={() => setIsExpanded(!isExpanded)}
    >
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
          <span className="ai-tool-action-name" style={{ color: "var(--ink, #ffffff)", fontWeight: 600 }}>
            Services
          </span>
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
  onSelectSlot: (prompt: string) => void;
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({ toolResult, toolArgs, onSelectSlot, isLiveEnvironment, timestamp }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const slots: any[] = Array.isArray(toolResult?.slots) ? toolResult.slots : [];

  const serviceName =
    toolResult?.serviceName || toolArgs?.serviceName || "Executive Haircut";
  const firstSlot = slots[0];
  const localDate = firstSlot?.display?.localDate || "Tomorrow";
  const zoneLabel = firstSlot?.display?.timeZoneLabel || toolResult?.timeZone || "EDT";

  const cardHeader = `Available times · ${serviceName} · ${localDate} · ${zoneLabel}`;
  const displayedSlots = isExpanded ? slots : slots.slice(0, 8);
  const hasMore = slots.length > 8;

  return (
    <div className="ai-tool-card" data-testid="slots-card">
      <div className="ai-tool-card-header mono">
        <div className="ai-tool-header-left">
          <span className="ai-tool-action-name" style={{ color: "var(--ink, #ffffff)", fontWeight: 600 }}>
            {cardHeader}
          </span>
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
                onClick={() => onSelectSlot(promptToSend)}
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
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({ toolResult, toolArgs, isLiveEnvironment, timestamp }) => {
  const serviceName = toolResult?.serviceName || toolArgs?.serviceName || "Service";
  const display = toolResult?.display;
  const startsAt = toolResult?.startsAt || toolArgs?.startsAt;
  const merchantZone = display?.timeZone || toolArgs?.timeZone || "America/New_York";

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
    display?.timeZoneLabel || (merchantZone.includes("New_York") ? "EDT" : merchantZone);

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
          <span className="ai-tool-action-name" style={{ color: "var(--ink, #ffffff)", fontWeight: 600 }}>
            Quote · {serviceName}
          </span>
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
            <span>Valid for 5 minutes</span>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Explicit card for prepare_booking.v1 output
 */
export const ApprovalCard: FC<{
  toolResult: any;
  toolArgs?: any;
  isLiveEnvironment: boolean;
  timestamp?: string;
}> = ({ toolResult, toolArgs, isLiveEnvironment, timestamp }) => {
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

  const rawLocator = toolResult?.approvalLocator || toolResult?.approval_locator || "";
  const cleanLocator = rawLocator.replace(/^.*\/v1\/booking-approvals\//, "");
  const approvalUrl =
    toolResult?.approvalUrl ||
    (rawLocator.startsWith("http://") || rawLocator.startsWith("https://")
      ? rawLocator
      : typeof window !== "undefined"
        ? `${window.location.origin}/approve/${cleanLocator}`
        : `/approve/${cleanLocator}`);

  return (
    <div className="ai-tool-card" data-testid="approval-card">
      <div className="ai-tool-card-header mono">
        <div className="ai-tool-header-left">
          <span className="ai-tool-action-name" style={{ color: "var(--ink, #ffffff)", fontWeight: 600 }}>
            Ready for your approval
          </span>
        </div>
        <div className="ai-tool-header-right">
          <span className="ai-tool-count" style={{ color: "#f59e0b" }}>
            Hold active · 15m window
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
            <span>● HOLD ACTIVE</span>
            <span className="mono">15m Window</span>
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
              color: "var(--secondary, #94a3b8)",
            }}
          >
            Your AI assistant reserved this time for you. Review terms and approve to book.
          </p>
          <a
            href={approvalUrl}
            className="button button--solid ai-review-terms-button"
            target="_self"
            id="ai-open-approval-btn"
          >
            Open approval page
          </a>
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
          <span className="ai-tool-action-name" style={{ color: "var(--ink, #ffffff)", fontWeight: 600 }}>
            Booking status
          </span>
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
          <span className="ai-tool-action-name" style={{ color: "var(--ink, #ffffff)", fontWeight: 600 }}>
            Cancellation policy
          </span>
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
 * Context-aware assistant follow-up prompt suggestions (T6)
 * Never suggests the action that was just completed.
 */
export function computeFollowUpSuggestions(items: ProcessedItem[]): string[] {
  const toolItems = items.filter((it) => it.kind === "tool" && it.toolResult);
  const lastTool = toolItems[toolItems.length - 1];

  if (!lastTool) {
    return [
      "Show available services",
      "Find available haircut slots tomorrow afternoon",
      "Prepare the 2 PM slot",
    ];
  }

  const toolName = (lastTool.toolName || "").toLowerCase();
  const res = lastTool.toolResult;

  if (toolName.includes("prepare_booking") || res.approvalLocator || res.approvalUrl) {
    return ["Open approval page", "Find a different time"];
  }

  if (toolName.includes("quote") || (res.total && res.deposit)) {
    return ["Prepare this booking", "Pick a different time"];
  }

  if (toolName.includes("find_available") || res.slots) {
    const firstSlot = res.slots?.[0];
    const timeLabel = firstSlot?.display?.localStart || "2:00 PM";
    return [`Hold ${timeLabel} slot`, "Show tomorrow morning", "Try another day"];
  }

  if (toolName.includes("list_service") || res.services) {
    const topService = res.services?.[0]?.name || "Executive Haircut";
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

      const toolName: string =
        part.toolName || toolInvocation.toolName || part.name || "Tool";

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
      it.kind === "tool" &&
      (it.toolName?.includes("list_service") || it.toolResult?.services)
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

  // 2. Check if this turn also contains slots, quote, or prepare
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

const AskAIDrawerInner: FC<AskAIDrawerInnerProps> = ({
  isOpen,
  onClose,
  authToken,
  tokenResolver,
  isAuthLoading = false,
  isAuthenticated = false,
  initialTokenPending = false,
  authError = null,
}) => {
  const [inputVal, setInputVal] = useState("");
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [streamAnnouncement, setStreamAnnouncement] = useState("");
  const lastPromptRef = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isAuthDisabled = isAuth0Configured()
    ? Boolean(isAuthLoading || !isAuthenticated || initialTokenPending)
    : Boolean(!isMockAuthEnabled() && !authToken);

  const apiBaseUrl = API_BASE_URL;

  // Keep latest tokenResolver in ref to prevent rebuilding transport while ensuring fresh resolution before every request
  const tokenResolverRef = useRef(tokenResolver);
  useEffect(() => {
    tokenResolverRef.current = tokenResolver;
  }, [tokenResolver]);

  // Fetch provider status honesty endpoint
  useEffect(() => {
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
    }
    prevAuthRef.current = isAuthenticated;
  }, [isAuthenticated, stop]);

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

  const [authPromptError, setAuthPromptError] = useState<Error | null>(null);

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
    setAuthPromptError(null);
  };

  const handleKeyDownInput = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const getErrorMessage = (err: Error) => {
    const msg = err.message || "";
    if (
      msg.includes("AUTH_REQUIRED") ||
      msg.includes("401") ||
      (err as any).status === 401 ||
      msg.includes("AUTHENTICATION_FAILED") ||
      msg.includes("unauthorized")
    ) {
      return "Authentication required. Please sign in with Auth0 to access the concierge.";
    }
    if (msg.includes("ai_provider_authentication")) {
      return "AI provider authentication failed. Please verify provider credentials.";
    }
    if (msg.includes("ai_model_not_found")) {
      return "AI model not found or currently unavailable.";
    }
    if (msg.includes("ai_quota_exceeded")) {
      return "AI quota exceeded. Please try again later.";
    }
    if (
      msg.includes("ai_provider_unavailable") ||
      msg.includes("503") ||
      (err as any).status === 503
    ) {
      return "AI Provider service is currently unavailable. Please try again shortly.";
    }
    if (msg.includes("ai_stream_error")) {
      return "An error occurred during AI response streaming. Please retry.";
    }
    if (msg.includes("403") || (err as any).status === 403) {
      return "Access forbidden. Your account lacks necessary permissions or active tenant membership.";
    }
    if (msg.includes("429") || (err as any).status === 429) {
      return "Rate limit of 60 requests per minute reached. Please wait a moment.";
    }
    return msg || "Failed to process AI response.";
  };

  if (!isOpen) return null;

  const isLiveEnvironment = Boolean(
    providerStatus?.provider === "gemini" && providerStatus?.realProviderVerified,
  );

  return (
    <div
      className="ai-drawer-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="velvetAI Concierge Assistant"
    >
      <aside className="ai-drawer" onClick={(e) => e.stopPropagation()} tabIndex={-1}>
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
              <p>
                Inquire about services, calculate real-time slot availability, request guaranteed
                quotes, and prepare booking holds with GiST exclusion.
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
            </div>
          )}

          {messages.map((m) => {
            const isUser = m.role === "user";
            const displayItems = processMessageParts(m.parts, (m as any).content);

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
                            onSelectSlot={handleQuickPrompt}
                            isLiveEnvironment={isLiveEnvironment}
                            timestamp={item.timestamp}
                          />
                        );
                      }

                      // 4. Authoritative quote card (A.2)
                      if (
                        (toolResult.total && toolResult.deposit) ||
                        item.toolName?.includes("quote")
                      ) {
                        return (
                          <QuoteCard
                            key={item.id}
                            toolResult={toolResult}
                            toolArgs={item.toolArgs}
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

          {/* Context-Aware Assistant Follow-up Suggestions Chips (T6) */}
          {!isLoading &&
            messages.length > 0 &&
            messages[messages.length - 1]?.role === "assistant" && (
              <div className="ai-followup-chips">
                <span className="mono ai-followup-label">Follow-up:</span>
                {computeFollowUpSuggestions(
                  processMessageParts(
                    messages[messages.length - 1]?.parts,
                    (messages[messages.length - 1] as any)?.content,
                  ),
                ).map((prompt, pIdx) => (
                  <button
                    key={pIdx}
                    type="button"
                    className="ai-followup-chip"
                    onClick={() => handleQuickPrompt(prompt)}
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

          {/* Error Banner with Retry */}
          {(error || authError || authPromptError) && (
            <div className="ai-error-banner" role="alert">
              <div className="ai-error-banner-content">
                <strong>Concierge Alert:</strong>{" "}
                {getErrorMessage(error || authError || authPromptError!)}
              </div>
              <button
                type="button"
                className="ai-retry-btn mono"
                onClick={handleRetry}
                disabled={isLoading}
              >
                Retry
              </button>
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
  const { isLoading, isAuthenticated, getAccessTokenSilently } = useAuth0();
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
    />
  );
};

export const AskAIDrawer: FC<AskAIDrawerProps> = (props) => {
  if (isAuth0Configured()) {
    return <AskAIAuth0Resolver {...props} />;
  }
  return <AskAIDrawerInner {...props} />;
};
