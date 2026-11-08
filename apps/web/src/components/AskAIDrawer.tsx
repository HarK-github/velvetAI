import {
  FC,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  FormEvent,
  KeyboardEvent,
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
  timestamp?: string;
}

/**
 * Returns a human-friendly action label for velvetAI tools
 */
export function getToolActionLabel(toolName: string): string {
  const clean = toolName.toLowerCase().replace(/[._]v\d+$/, "");
  if (clean.includes("list_service") || clean.includes("catalog")) {
    return "Live service catalog";
  }
  if (clean.includes("find_available") || clean.includes("slot")) {
    return "Available booking windows";
  }
  if (clean.includes("quote")) {
    return "Authoritative quote snapshot";
  }
  if (clean.includes("prepare_booking") || clean.includes("hold")) {
    return "Authoritative booking hold";
  }
  if (clean.includes("prepare_cancel")) {
    return "Cancellation policy terms";
  }
  return toolName.replace(/[._]/g, " ");
}

/**
 * Authoritatively processes and groups message stream parts:
 * - One UI result group per toolCallId.
 * - Stream updates replace/update existing tool part in place; they never append another card set.
 * - Deduplicates streaming tool items while preserving distinct services.
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
        part.toolName || toolInvocation.toolName || part.name || "Live service catalog";

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
      return `${providerStatus.model || "Gemini 3.5"} • Authoritative Tools`;
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
    }
    prevStatusRef.current = status;
  }, [status]);

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
                      const actionLabel = getToolActionLabel(item.toolName || "Tool");
                      const toolResult = item.toolResult;
                      const itemCount =
                        toolResult?.total !== undefined
                          ? `${toolResult.total} items`
                          : toolResult?.services?.length !== undefined
                            ? `${toolResult.services.length} services`
                            : toolResult?.slots?.length !== undefined
                              ? `${toolResult.slots.length} slots`
                              : undefined;

                      return (
                        <div key={item.id} className="ai-tool-card">
                          <div className="ai-tool-card-header mono">
                            <div className="ai-tool-header-left">
                              <span className="ai-tool-badge">Verified from velvetAI catalog</span>
                              <span className="ai-tool-action-name">{actionLabel}</span>
                            </div>
                            <div className="ai-tool-header-right">
                              {itemCount && <span className="ai-tool-count">{itemCount}</span>}
                              {item.timestamp && (
                                <span className="ai-tool-time">{item.timestamp}</span>
                              )}
                              <span
                                className={`ai-tool-env-tag ${
                                  isLiveEnvironment
                                    ? "ai-tool-env-tag--live"
                                    : "ai-tool-env-tag--dev"
                                }`}
                              >
                                {isLiveEnvironment ? "LIVE DATA" : "SYNTHETIC DEV"}
                              </span>
                            </div>
                          </div>

                          {item.isPending && (
                            <div className="ai-tool-card-content mono text-muted ai-tool-pending">
                              <span className="ai-typing-indicator">
                                <span></span>
                                <span></span>
                                <span></span>
                              </span>
                              <span>Querying live catalog...</span>
                            </div>
                          )}

                          {toolResult && (
                            <div className="ai-tool-card-content">
                              {/* Services List Card */}
                              {toolResult.services && (
                                <div className="ai-services-grid">
                                  {(() => {
                                    const seenIds = new Set<string>();
                                    const uniqueServices: any[] = [];
                                    for (const s of toolResult.services) {
                                      const id = s?.id || `srv-${uniqueServices.length}`;
                                      if (!seenIds.has(id)) {
                                        seenIds.add(id);
                                        uniqueServices.push(s);
                                      }
                                    }

                                    return uniqueServices.map((s: any) => {
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
                                                s.versions?.[0]?.price_minor,
                                              currency:
                                                s.currency ?? s.versions?.[0]?.currency ?? "USD",
                                            };
                                      const formattedPrice =
                                        s.formattedPrice || formatMoney(priceObj);

                                      const depositObj =
                                        s.deposit && typeof s.deposit === "object"
                                          ? s.deposit
                                          : {
                                              valueMinor:
                                                s.depositMinor ??
                                                s.baseDepositMinor ??
                                                s.base_deposit_minor ??
                                                s.versions?.[0]?.baseDepositMinor ??
                                                s.versions?.[0]?.base_deposit_minor,
                                              currency:
                                                s.currency ?? s.versions?.[0]?.currency ?? "USD",
                                            };
                                      const rawDepositMinor = depositObj.valueMinor;
                                      const hasDeposit =
                                        rawDepositMinor !== undefined &&
                                        rawDepositMinor !== null &&
                                        rawDepositMinor !== "" &&
                                        rawDepositMinor !== "0" &&
                                        rawDepositMinor !== 0;
                                      const formattedDeposit = hasDeposit
                                        ? s.formattedDeposit || formatMoney(depositObj)
                                        : null;

                                      return (
                                        <div key={s.id} className="ai-service-item">
                                          <div className="ai-service-item-main">
                                            <strong className="ai-service-name">{name}</strong>
                                            <div className="mono text-muted ai-service-details">
                                              {duration} min • {formattedPrice}
                                              {formattedDeposit &&
                                                ` • Deposit: ${formattedDeposit}`}
                                            </div>
                                          </div>
                                          {s.description && (
                                            <p className="ai-service-desc">{s.description}</p>
                                          )}
                                        </div>
                                      );
                                    });
                                  })()}
                                </div>
                              )}

                              {/* Available Slots Card */}
                              {toolResult.slots && (
                                <div className="ai-slots-grid">
                                  <div
                                    className="mono"
                                    style={{ fontSize: "11px", marginBottom: "4px", width: "100%" }}
                                  >
                                    Authoritative Available Windows:
                                  </div>
                                  {toolResult.slots.slice(0, 4).map((slot: any, sIdx: number) => {
                                    const timeStr = slot.startsAt || slot.starts_at;
                                    return (
                                      <div key={sIdx} className="ai-slot-badge mono">
                                        {timeStr
                                          ? new Date(timeStr).toLocaleTimeString([], {
                                              hour: "2-digit",
                                              minute: "2-digit",
                                            })
                                          : "Slot"}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}

                              {/* Two-Phase Prepare Booking Hold Snapshot */}
                              {(toolResult.approvalLocator || toolResult.approval_locator) && (
                                <div className="ai-approval-card">
                                  <div className="ai-hold-badge">
                                    <span>● HOLD ACTIVE</span>
                                    <span className="mono">15m Window</span>
                                  </div>
                                  <p style={{ margin: "8px 0 4px 0", fontSize: "12px" }}>
                                    Authoritative slot reserved. Buyer must review policy terms and
                                    confirm in browser to issue confirmation token.
                                  </p>
                                  <div
                                    className="mono"
                                    style={{ fontSize: "11px", color: "var(--muted)" }}
                                  >
                                    Booking Hold Reference:{" "}
                                    <span className="mono text-muted">Active</span>
                                  </div>
                                  <a
                                    href={toolResult.approvalLocator || toolResult.approval_locator}
                                    className="button button--solid ai-review-terms-button"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    Review Terms & Confirm Hold ↗
                                  </a>
                                </div>
                              )}

                              {/* Raw fallback if neither services, slots, nor hold */}
                              {!toolResult.services &&
                                !toolResult.slots &&
                                !toolResult.approvalLocator &&
                                !toolResult.approval_locator && (
                                  <pre className="ai-tool-pre mono">
                                    {JSON.stringify(toolResult, null, 2)}
                                  </pre>
                                )}
                            </div>
                          )}
                        </div>
                      );
                    }

                    return null;
                  })}
                </div>
              </div>
            );
          })}

          {/* Assistant Follow-up Suggestions Chips */}
          {!isLoading &&
            messages.length > 0 &&
            messages[messages.length - 1]?.role === "assistant" && (
              <div className="ai-followup-chips">
                <span className="mono ai-followup-label">Follow-up:</span>
                <button
                  type="button"
                  className="ai-followup-chip"
                  onClick={() => handleQuickPrompt("Find available slots")}
                >
                  Find available slots
                </button>
                <button
                  type="button"
                  className="ai-followup-chip"
                  onClick={() => handleQuickPrompt("Compare services")}
                >
                  Compare services
                </button>
                <button
                  type="button"
                  className="ai-followup-chip"
                  onClick={() => handleQuickPrompt("Prepare a booking")}
                >
                  Prepare a booking
                </button>
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
