/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useEffect } from "react";
import * as fs from "node:fs";
import * as path from "node:path";
import { render, screen, fireEvent, waitFor, cleanup, within, act } from "@testing-library/react";
import { useAuth0 } from "@auth0/auth0-react";
import { RouterProvider, useRouter } from "../router.js";
import { AskAIProvider, ASK_AI_STORAGE_PREFIX, useAskAI } from "../context/AskAIContext.js";
import {
  AskAIDrawer,
  computeFollowUpSuggestions,
  formatAskAIErrorMessage,
} from "../components/AskAIDrawer.js";
import { ApprovalPage } from "../pages/ApprovalPage.js";
import { BookingSimulatorSection } from "../components/BookingSimulatorSection.js";
import { apiClient } from "../api-client.js";
import * as approvalApi from "../lib/approval-api.js";

// Enforce Asia/Kolkata to verify timezone-aware rendering & countdown handling (P0/P1)
process.env.TZ = "Asia/Kolkata";

const mockSendMessage = vi.fn();
const mockStop = vi.fn();
const mockLoginWithRedirect = vi.fn();
const mockLogout = vi.fn();
const mockGetAccessTokenSilently = vi.fn().mockResolvedValue("mock-jwt-token");

let mockChatState = {
  messages: [] as any[],
  sendMessage: mockSendMessage,
  stop: mockStop,
  status: "ready" as string,
  error: undefined as Error | undefined,
};

vi.mock("@ai-sdk/react", () => ({
  useChat: () => {
    const [messages, setLocalMessages] = React.useState(mockChatState.messages);
    useEffect(() => {
      setLocalMessages(mockChatState.messages);
    }, [mockChatState.messages]);

    return {
      ...mockChatState,
      messages,
      setMessages: (updater: any) => {
        const next = typeof updater === "function" ? updater(mockChatState.messages) : updater;
        mockChatState.messages = next;
        setLocalMessages(next);
      },
      regenerate: vi.fn(),
    };
  },
}));

let mockAuthState = {
  isAuthenticated: true,
  isLoading: false,
  user: { sub: "auth0|test-sub-1", email: "buyer.ist@example.com", name: "Buyer IST" } as
    { sub?: string; email?: string; name?: string } | undefined,
  loginWithRedirect: mockLoginWithRedirect,
  logout: mockLogout,
  getAccessTokenSilently: mockGetAccessTokenSilently,
  error: undefined as Error | undefined,
};

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => mockAuthState,
  Auth0Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const AuthBridgeForTest: React.FC = () => {
  const { isLoading, isAuthenticated, user } = useAuth0();
  const { syncAuthState } = useAskAI();
  useEffect(() => {
    syncAuthState({
      sub: user?.sub ?? null,
      isAuthenticated,
      isLoading,
    });
  }, [user?.sub, isAuthenticated, isLoading, syncAuthState]);
  return null;
};

const RouteSpy: React.FC<{ onPath?: (p: string) => void }> = ({ onPath }) => {
  const { currentPath } = useRouter();
  useEffect(() => {
    onPath?.(currentPath);
  }, [currentPath, onPath]);
  return <div data-testid="current-path">{currentPath}</div>;
};

const baseApprovalDetails = {
  locator: "loc_p0_test",
  bookingId: "bk_p0_test",
  status: "PENDING" as const,
  bookingStatus: "HELD" as const,
  preparedBySurface: "ask-ai" as const,
  serviceName: "Executive Haircut & Beard Sculpt",
  locationName: "Manhattan Flagship",
  resourceName: "Master Stylist Marcus",
  startsAt: "2026-11-11T18:30:00.000Z", // 1:30 PM EST / 12:00 AM IST next day
  endsAt: "2026-11-11T19:15:00.000Z",
  timeZone: "America/New_York",
  allInPriceMinor: "7500",
  depositMinor: "2000",
  currency: "USD",
  formattedPrice: "$75.00",
  formattedDeposit: "$20.00",
  cancellationSummary: "Free cancellation up to 24 hours before appointment.",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  display: {
    localDate: "Wed, Nov 11, 2026",
    localStart: "1:30 PM",
    localEnd: "2:15 PM",
    timeZone: "America/New_York",
    timeZoneLabel: "EST",
  },
};

describe("P0 & P1 Comprehensive Fixes (TZ=Asia/Kolkata)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mockSendMessage.mockReset();
    mockStop.mockReset();
    mockLoginWithRedirect.mockReset();
    mockLogout.mockReset();
    mockGetAccessTokenSilently.mockReset().mockResolvedValue("mock-jwt-token");
    apiClient.setAuthToken("");
    apiClient.resetActionKeys();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    delete (globalThis as any).window.paypal;

    mockChatState = {
      messages: [],
      sendMessage: mockSendMessage,
      stop: mockStop,
      status: "ready",
      error: undefined,
    };

    mockAuthState = {
      isAuthenticated: true,
      isLoading: false,
      user: { sub: "auth0|test-sub-1", email: "buyer.ist@example.com", name: "Buyer IST" },
      loginWithRedirect: mockLoginWithRedirect,
      logout: mockLogout,
      getAccessTokenSilently: mockGetAccessTokenSilently,
      error: undefined,
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/v1/ai/status")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              provider: "gemini",
              model: "gemini-2.5-flash",
              realProviderConfigured: true,
              realProviderVerified: true,
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    globalThis.fetch = originalFetch;
    apiClient.setAuthToken("");
    apiClient.resetActionKeys();
    window.sessionStorage.clear();
    delete (globalThis as any).window.paypal;
  });

  it("P0-1: ApprovalCard & Follow-up navigate client-side, AskAIContext persists by sub and clears on logout", async () => {
    const onClose = vi.fn();
    mockChatState.messages = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            toolCallId: "prep-1",
            toolName: "prepare_booking.v1",
            result: {
              bookingId: "bk_nav_1",
              status: "HELD",
              holdExpiresAt: new Date(Date.now() + 300_000).toISOString(),
              approvalLocator: "/v1/booking-approvals/loc_client_nav",
              terms: {
                serviceId: "s1",
                serviceName: "Executive Haircut",
                startsAt: "2026-11-11T18:30:00.000Z",
                timeZone: "America/New_York",
              },
            },
          },
        ],
      },
    ];

    const resetKeysSpy = vi.spyOn(apiClient, "resetActionKeys");

    const { unmount } = render(
      <AskAIProvider>
        <RouterProvider>
          <AuthBridgeForTest />
          <RouteSpy />
          <AskAIDrawer isOpen={true} onClose={onClose} />
        </RouterProvider>
      </AskAIProvider>,
    );

    // persisted to sessionStorage under sub
    await waitFor(() => {
      const stored = window.sessionStorage.getItem(`${ASK_AI_STORAGE_PREFIX}auth0|test-sub-1`);
      expect(stored).toBeTruthy();
      expect(stored).toContain("loc_client_nav");
    });

    // Click "Open approval page" button -> SPA navigation to /approve/loc_client_nav & closes drawer
    const openBtn = screen.getAllByRole("button", { name: "Open approval page" })[0]!;
    fireEvent.click(openBtn);
    expect(screen.getByTestId("current-path").textContent).toBe("/approve/loc_client_nav");
    expect(window.location.pathname).toBe("/approve/loc_client_nav");
    expect(onClose).toHaveBeenCalledTimes(1);

    // Simulate browser reload: clear in-memory chat, remount fresh AskAIProvider, should restore from sessionStorage!
    unmount();
    mockChatState.messages = [];
    const { rerender: rerenderReloaded } = render(
      <AskAIProvider>
        <RouterProvider>
          <AuthBridgeForTest />
          <RouteSpy />
          <AskAIDrawer isOpen={true} onClose={onClose} />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("approval-card")).toBeDefined();
      expect(screen.getByText(/Hold active · 5m window/i)).toBeDefined();
    });

    // Simulate logout -> clears chat, deletes sessionStorage key, and resets apiClient action keys
    mockAuthState = {
      ...mockAuthState,
      isAuthenticated: false,
      user: undefined,
    };
    rerenderReloaded(
      <AskAIProvider>
        <RouterProvider>
          <AuthBridgeForTest />
          <RouteSpy />
          <AskAIDrawer isOpen={true} onClose={onClose} />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => {
      expect(window.sessionStorage.getItem(`${ASK_AI_STORAGE_PREFIX}auth0|test-sub-1`)).toBeNull();
      expect(screen.queryByTestId("approval-card")).toBeNull();
    });
    expect(resetKeysSpy).toHaveBeenCalled();
  });

  it("P0-2: single active QuoteCard, 'Held ✓', replace-hold prompt via prepareCancellation + cancel, in-flight ref locks, disabled follow-ups", async () => {
    const slotAStart = "2026-11-11T17:00:00.000Z";
    const slotBStart = "2026-11-11T19:00:00.000Z";

    mockChatState.messages = [
      {
        id: "m-slots",
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            toolCallId: "slots-1",
            toolName: "find_available_slots.v1",
            result: {
              serviceId: "s1",
              locationId: "loc1",
              serviceName: "Executive Haircut",
              resolvedDate: "Wed, Nov 11",
              timeZone: "America/New_York",
              slots: [
                {
                  serviceId: "s1",
                  locationId: "loc1",
                  startsAt: slotAStart,
                  timeZone: "America/New_York",
                  display: {
                    localDate: "Wed, Nov 11",
                    localStart: "12:00 PM",
                    localEnd: "12:45 PM",
                    timeZone: "America/New_York",
                    timeZoneLabel: "EST",
                  },
                },
                {
                  serviceId: "s1",
                  locationId: "loc1",
                  startsAt: slotBStart,
                  timeZone: "America/New_York",
                  display: {
                    localDate: "Wed, Nov 11",
                    localStart: "2:00 PM",
                    localEnd: "2:45 PM",
                    timeZone: "America/New_York",
                    timeZoneLabel: "EST",
                  },
                },
              ],
            },
          },
        ],
      },
    ];

    let resolveQuoteA: ((v: any) => void) | null = null;
    const quoteSpy = vi
      .spyOn(apiClient, "createBookingQuote")
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveQuoteA = res;
          }),
      )
      .mockResolvedValueOnce({
        quoteId: "q_slot_b",
        serviceName: "Executive Haircut",
        serviceId: "s1",
        startsAt: slotBStart,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        total: { valueMinor: "7500", currency: "USD" },
        deposit: { valueMinor: "2000", currency: "USD" },
        cancellationPolicy: { policyId: "pol1", summary: "Free cancel 24h prior" },
        display: {
          localDate: "Wed, Nov 11",
          localStart: "2:00 PM",
          localEnd: "2:45 PM",
          timeZone: "America/New_York",
          timeZoneLabel: "EST",
        },
      } as any);

    const prepSpy = vi
      .spyOn(apiClient, "prepareBooking")
      .mockResolvedValueOnce({
        bookingId: "bk_hold_a",
        status: "HELD",
        holdExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        version: 1,
        intent: "int_a",
        approvalLocator: "/v1/booking-approvals/loc_hold_a",
        terms: { serviceName: "Executive Haircut" },
      } as any)
      .mockResolvedValueOnce({
        bookingId: "bk_hold_b",
        status: "HELD",
        holdExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        version: 1,
        intent: "int_b",
        approvalLocator: "/v1/booking-approvals/loc_hold_b",
        terms: { serviceName: "Executive Haircut" },
      } as any);

    const prepCancelSpy = vi.spyOn(apiClient, "prepareCancellation").mockResolvedValueOnce({
      bookingId: "bk_hold_a",
      cancellationAllowed: true,
      refundEligibleMinor: "0",
      currency: "USD",
      policySummary: "Hold released",
      cancellationConfirmationToken: "cancel_conf_tok_123456",
    });

    const cancelSpy = vi.spyOn(apiClient, "cancelBooking").mockResolvedValueOnce({
      bookingId: "bk_hold_a",
      status: "CANCELLED",
      refundStatus: "NO_REFUND",
      refundAmountMinor: "0",
      currency: "USD",
      resourceClaimReleased: true,
      cancelledAt: new Date().toISOString(),
    });

    render(
      <AskAIProvider>
        <RouterProvider>
          <AskAIDrawer isOpen={true} onClose={() => {}} />
        </RouterProvider>
      </AskAIProvider>,
    );

    const chipA = screen.getByRole("button", { name: /Select slot at 12:00 PM/i });
    const chipB = screen.getByRole("button", { name: /Select slot at 2:00 PM/i });

    // Rapid double click on chip A: synchronous useRef lock prevents second quote call
    fireEvent.click(chipA);
    fireEvent.click(chipB);
    expect(quoteSpy).toHaveBeenCalledTimes(1);

    // Follow-up & slot chips are disabled while quoting is in-flight
    expect(chipA.hasAttribute("disabled")).toBe(true);
    expect(chipB.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Show tomorrow morning" }).hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      resolveQuoteA!({
        quoteId: "q_slot_a",
        serviceName: "Executive Haircut",
        serviceId: "s1",
        startsAt: slotAStart,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        total: { valueMinor: "7500", currency: "USD" },
        deposit: { valueMinor: "2000", currency: "USD" },
        cancellationPolicy: { policyId: "pol1", summary: "Free cancel 24h prior" },
        display: {
          localDate: "Wed, Nov 11",
          localStart: "12:00 PM",
          localEnd: "12:45 PM",
          timeZone: "America/New_York",
          timeZoneLabel: "EST",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("quote-card")).toHaveLength(1);
    });

    // Click "Hold this time" -> shows "Held ✓" disabled & 5m Window
    fireEvent.click(
      within(screen.getByTestId("quote-card")).getByRole("button", { name: "Hold this time" }),
    );
    await waitFor(() => {
      const heldBtn = within(screen.getByTestId("quote-card")).getByRole("button", {
        name: "Held",
      });
      expect(heldBtn.textContent).toBe("Held ✓");
      expect(heldBtn.hasAttribute("disabled")).toBe(true);
      expect(screen.getByText(/Hold active · 5m window/i)).toBeDefined();
      expect(screen.getByText("5m Window")).toBeDefined();
    });

    // Click slot chip B -> REPLACES QuoteCard A (strictly 1 QuoteCard in DOM!)
    fireEvent.click(screen.getByRole("button", { name: /Select slot at 2:00 PM/i }));
    await waitFor(() => {
      const quoteCards = screen.getAllByTestId("quote-card");
      expect(quoteCards).toHaveLength(1);
      expect(quoteCards[0]!.textContent).toContain("2:00 PM");
      expect(quoteCards[0]!.textContent).not.toContain("12:00 PM");
    });

    // Try to hold slot B while slot A is HELD -> asks "You're already holding ... Replace it?"
    fireEvent.click(
      within(screen.getByTestId("quote-card")).getByRole("button", { name: "Hold this time" }),
    );
    expect(
      screen.getByText(/You're already holding Wed, Nov 11 at 12:00 PM EST\. Replace it\?/i),
    ).toBeDefined();
    expect(prepSpy).toHaveBeenCalledTimes(1); // Not prepared yet!

    // Confirm replacement -> prepareCancellation + cancelBooking + prepareBooking
    fireEvent.click(screen.getByRole("button", { name: "Yes, replace hold" }));
    await waitFor(() => {
      expect(prepCancelSpy).toHaveBeenCalledWith("bk_hold_a", expect.any(Object));
      expect(cancelSpy).toHaveBeenCalledWith("bk_hold_a", {
        cancellationConfirmationToken: "cancel_conf_tok_123456",
        reason: "Replacing held slot with new selection",
      });
      expect(prepSpy).toHaveBeenCalledTimes(2);
    });

    // P2-2: Ordering must be new QuoteCard -> "Previous hold released" -> new ApprovalCard, and boilerplate emitted once
    await waitFor(() => {
      expect(screen.getByText("Previous hold released")).toBeDefined();
      expect(screen.getByText("Ready for your approval")).toBeDefined();
    });

    const newQuoteCard = screen.getByTestId("quote-card");
    const releasedLabel = screen.getByText("Previous hold released");
    const activeApprovalLabel = screen.getByText("Ready for your approval");
    expect(
      Boolean(
        newQuoteCard.compareDocumentPosition(releasedLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        releasedLabel.compareDocumentPosition(activeApprovalLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    const drawerText = document.body.textContent || "";
    const holdBoilerplateMatches =
      drawerText.match(/I have prepared your booking hold\. Please review and approve/g) || [];
    expect(holdBoilerplateMatches).toHaveLength(1);
  });

  it("P0-3: index.css defines all missing UI tokens/classes & ApprovalPage uses light shadow", () => {
    const cssPath = path.resolve(__dirname, "../index.css");
    const css = fs.readFileSync(cssPath, "utf-8");

    for (const token of [
      "--text-dim:",
      "--text-body:",
      ".text-muted",
      ".spinner",
      ".button--primary",
      ".button--secondary",
      ".button--outline",
      ".button--ghost",
      ".button--sm",
      ".signal-dot--red",
      ".signal-dot--amber",
      ".signal-dot--gold",
      ".ai-drawer .button--secondary",
    ]) {
      expect(css, `Missing CSS rule ${token}`).toContain(token);
    }

    const approvalSrc = fs.readFileSync(
      path.resolve(__dirname, "../pages/ApprovalPage.tsx"),
      "utf-8",
    );
    expect(approvalSrc).not.toContain("rgba(0, 0, 0, 0.4)");
    expect(approvalSrc).toContain("rgba(13, 13, 15, 0.08)");
  });

  it("P0-4: ApprovalPage fetches once across auth transitions, hides AI hero/attribution on 404, maps 404 copy, no duplicate sentence", async () => {
    // 1. Single fetch across auth transition (isAuthLoading: true -> false, isAuthenticated: false -> true)
    const fetchSpy = vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: baseApprovalDetails as any,
      serverTime: Date.now(),
    });

    mockAuthState = {
      ...mockAuthState,
      isLoading: true,
      isAuthenticated: false,
    };

    const { rerender } = render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_single_fetch" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    mockAuthState = { ...mockAuthState, isLoading: false, isAuthenticated: false };
    rerender(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_single_fetch" />
        </RouterProvider>
      </AskAIProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("state-sign-in-required")).toBeDefined());

    mockAuthState = { ...mockAuthState, isLoading: false, isAuthenticated: true };
    rerender(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_single_fetch" />
        </RouterProvider>
      </AskAIProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("state-ready")).toBeDefined());
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // No duplicate sentence on ready state
    const bodyText = document.body.textContent || "";
    const occurrences = bodyText.split("Your AI assistant reserved this time for you.").length - 1;
    expect(occurrences).toBe(1);

    cleanup();

    // 2. 404 / Not-found hides "Prepared by ..." & AI hero, maps 404 message cleanly
    const err404 = Object.assign(
      new Error("Approval interaction loc_missing not found in tenant"),
      {
        status: 404,
        code: "APPROVAL_NOT_FOUND",
      },
    );
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockRejectedValueOnce(err404);

    render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_missing" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("state-error")).toBeDefined());
    expect(screen.getByText("This booking link wasn't found or has expired.")).toBeDefined();
    expect(screen.queryByTestId("page-eyebrow")).toBeNull();
    expect(screen.queryByText(/Prepared by Ask AI/i)).toBeNull();
    expect(screen.queryByText(/Your AI assistant reserved this time for you/i)).toBeNull();
    expect(screen.queryByText(/loc_missing/)).toBeNull();
  });

  it("P0-5 & P1-11/12/13: CAPTURE_UNCERTAIN polls getOperation (3s->10s), cancel shows hold-until, expire shows Time released, network drop never shows Failed to fetch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: baseApprovalDetails as any,
      serverTime: Date.now() + 2000,
    });
    vi.spyOn(approvalApi, "postApproveAndCommit").mockResolvedValue({
      bookingId: "bk_p0_test",
      status: "COMMITTING",
      next: { type: "PAY_DEPOSIT", paymentOrderUrl: "/v1/bookings/bk_p0_test/payment-order" },
    } as any);
    vi.spyOn(apiClient, "createPaymentOrder").mockResolvedValue({
      paymentIntentId: "pi_unc_1",
      paypalOrderId: "ORD_UNC_1",
      amount: { currency: "USD", valueMinor: "2000" },
      status: "REQUIRES_PAYER_ACTION",
      paymentExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    vi.spyOn(apiClient, "capturePayment").mockResolvedValueOnce({
      bookingId: "bk_p0_test",
      bookingStatus: "CAPTURE_UNCERTAIN",
      paymentStatus: "UNCERTAIN",
      operationId: "op_poll_1",
    } as any);

    const getOpSpy = vi.spyOn(apiClient, "getOperation").mockImplementation(async () => {
      const count = getOpSpy.mock.calls.length;
      // Return SUCCEEDED on a poll after 2 minutes (120s) to verify 3s -> 10s transition
      if (count >= 42) {
        return {
          id: "op_poll_1",
          operationType: "CAPTURE",
          state: "SUCCEEDED",
          providerCaptureId: "CAP_OK",
        };
      }
      return { id: "op_poll_1", operationType: "CAPTURE", state: "PENDING" };
    });

    render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_uncertain" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("state-ready")).toBeDefined());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => expect(screen.getByTestId("state-pay-deposit")).toBeDefined());
    await waitFor(() => expect(apiClient.createPaymentOrder).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: /Authorize & Capture via PayPal Sandbox/i }),
    );
    await waitFor(() => expect(screen.getByTestId("state-verifying-payment")).toBeDefined());

    // First 2 minutes poll at 3s intervals, then slows to 10s intervals
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(getOpSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(118_000);
    });
    const countAround2Min = getOpSpy.mock.calls.length;
    expect(countAround2Min).toBeGreaterThanOrEqual(38);
    expect(countAround2Min).toBeLessThan(42);

    // Next 3s should NOT poll again yet (10s interval now active); advancing 10s triggers SUCCEEDED poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(getOpSpy).toHaveBeenCalledTimes(countAround2Min);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(getOpSpy.mock.calls.length).toBeGreaterThanOrEqual(42);

    await waitFor(() => expect(screen.getByTestId("state-confirmed")).toBeDefined());
    expect(screen.getByRole("link", { name: "Back to home" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Book another with Ask AI" })).toBeDefined();

    vi.useRealTimers();
    cleanup();

    // Network error during capture -> capture_uncertain without raw "Failed to fetch"
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValueOnce({
      details: baseApprovalDetails as any,
      serverTime: Date.now(),
    });
    vi.spyOn(apiClient, "capturePayment").mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_net_drop" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("state-ready")).toBeDefined());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));
    await waitFor(() => expect(screen.getByTestId("state-pay-deposit")).toBeDefined());

    fireEvent.click(
      screen.getByRole("button", { name: /Authorize & Capture via PayPal Sandbox/i }),
    );
    await waitFor(() => expect(screen.getByTestId("state-capture-uncertain")).toBeDefined());
    expect(screen.getByText(/We couldn't confirm the payment yet/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /Check payment status/i })).toBeDefined();
    expect(document.body.textContent).not.toContain("Failed to fetch");

    cleanup();

    // PayPal SDK onCancel -> payment_cancelled ("Payment cancelled — your hold is still active until ...")
    let capturedCallbacks: any = null;
    const scriptEl = document.createElement("script");
    scriptEl.src = "https://www.sandbox.paypal.com/web-sdk/v6/core";
    document.head.appendChild(scriptEl);
    (globalThis as any).window.paypal = {
      createInstance: vi.fn(async () => ({
        createPayPalOneTimePaymentSession: (opts: any) => {
          capturedCallbacks = opts;
          return {
            start: vi.fn(async () => {
              opts.onCancel();
            }),
          };
        },
      })),
    };

    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValueOnce({
      details: baseApprovalDetails as any,
      serverTime: Date.now(),
    });

    render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_cancel" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("state-ready")).toBeDefined());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));
    await waitFor(() => expect(screen.getByTestId("state-pay-deposit")).toBeDefined());
    await waitFor(() => expect(capturedCallbacks).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Pay with PayPal \(JS SDK v6\)/i }));
    await waitFor(() => expect(screen.getByTestId("state-payment-cancelled")).toBeDefined());
    expect(screen.getByText(/Payment cancelled — your hold is still active until/i)).toBeDefined();
    expect(screen.getByRole("button", { name: "Pay again" })).toBeDefined();
  });

  it("P0-5 & P1-13: Payment window expiry -> 'Time released' + 'Find a new time'; sign_in_required expiry -> expired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValueOnce({
      details: baseApprovalDetails as any,
      serverTime: Date.now(),
    });
    vi.spyOn(approvalApi, "postApproveAndCommit").mockResolvedValueOnce({
      bookingId: "bk_exp_win",
      status: "COMMITTING",
      next: { type: "PAY_DEPOSIT", paymentOrderUrl: "/v1/bookings/bk_exp_win/payment-order" },
    } as any);
    vi.spyOn(apiClient, "createPaymentOrder").mockResolvedValueOnce({
      paymentIntentId: "pi_exp_1",
      paypalOrderId: "ORD_EXP_1",
      amount: { currency: "USD", valueMinor: "2000" },
      status: "REQUIRES_PAYER_ACTION",
      paymentExpiresAt: new Date(Date.now() + 2000).toISOString(),
    });

    render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_pay_exp" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("state-ready")).toBeDefined());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));
    await waitFor(() => expect(screen.getByTestId("state-pay-deposit")).toBeDefined());
    await waitFor(() => expect(apiClient.createPaymentOrder).toHaveBeenCalled());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    await waitFor(() => expect(screen.getByTestId("state-expired")).toBeDefined());
    expect(screen.getByRole("heading", { name: "Time released" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Find a new time" })).toBeDefined();

    cleanup();

    // P1-13: sign_in_required countdown reaching 0 -> expired
    mockAuthState = { ...mockAuthState, isAuthenticated: false, isLoading: false };
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValueOnce({
      details: {
        ...baseApprovalDetails,
        expiresAt: new Date(Date.now() + 2000).toISOString(),
      } as any,
      serverTime: Date.now(),
    });

    render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_signin_exp" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("state-sign-in-required")).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => expect(screen.getByTestId("state-expired")).toBeDefined());
    vi.useRealTimers();
  });

  it("P0-6: Approve-only enters approved_awaiting_agent ('Approved. Your assistant can now complete the booking.')", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValueOnce({
      details: {
        ...baseApprovalDetails,
        preparedBySurface: "mcp",
      } as any,
      serverTime: Date.now(),
    });
    vi.spyOn(approvalApi, "postConfirmApproval").mockResolvedValueOnce({
      confirmation: "conf_mcp_123",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_mcp" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("state-ready")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Approve only (let my assistant finish)" }));

    await waitFor(() => expect(screen.getByTestId("state-approved-awaiting-agent")).toBeDefined());
    expect(
      screen.getAllByText(/Approved\. Your assistant can now complete the booking\./i).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/already been confirmed/i)).toBeNull();
  });

  it("P0-7 & P1-10/14/15: Signed-out Ask AI, 401 Sign-in alert, 429/network error parsing, tail follow-ups, /v1/ai/status lazy fetch", async () => {
    mockAuthState = {
      ...mockAuthState,
      isAuthenticated: false,
      isLoading: false,
      user: undefined,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          provider: "gemini",
          model: "gemini-2.5-flash",
          realProviderConfigured: true,
          realProviderVerified: true,
        }),
    } as any);

    // P1-15: closed drawer should NOT call /v1/ai/status
    const { rerender } = render(<AskAIDrawer isOpen={false} onClose={() => {}} />);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Open drawer while signed out -> calls /v1/ai/status, shows Sign in or create account, NO quick pills
    rerender(<AskAIDrawer isOpen={true} onClose={() => {}} />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const signInBtn = screen.getByRole("button", { name: "Sign in or create account" });
    expect(signInBtn).toBeDefined();
    expect(screen.queryByText("Show available services")).toBeNull();
    fireEvent.click(signInBtn);
    expect(mockLoginWithRedirect).toHaveBeenCalledTimes(1);

    // 401 chat error shows "Sign in" button instead of "Retry"
    mockChatState.error = Object.assign(new Error("HTTP 401 AUTH_REQUIRED"), { status: 401 });
    rerender(<AskAIDrawer isOpen={true} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    // P1-10: Error message normalization
    expect(formatAskAIErrorMessage(new TypeError("Failed to fetch")).message).toBe(
      "Connection problem — check your network and try again.",
    );
    expect(
      formatAskAIErrorMessage(
        new Error('429 {"code":"CONCURRENCY_LIMIT_EXCEEDED","detail":"busy"}'),
      ).message,
    ).toContain("still finishing");

    // P1-14: Empty slots never emit "Hold <time>", handles get_booking & prepare_cancellation from tail
    const emptySlotsFollowUps = computeFollowUpSuggestions([
      {
        id: "slots-empty",
        kind: "tool",
        toolName: "find_available_slots.v1",
        toolResult: { slots: [] },
      },
    ]);
    expect(emptySlotsFollowUps.some((s) => s.startsWith("Hold "))).toBe(false);

    const cancelFollowUps = computeFollowUpSuggestions([
      {
        id: "prep-1",
        kind: "tool",
        toolName: "prepare_booking.v1",
        toolResult: { bookingId: "b1", approvalLocator: "loc1" },
      },
      {
        id: "cancel-prep",
        kind: "tool",
        toolName: "prepare_cancellation.v1",
        toolResult: { bookingId: "b1", cancellationAllowed: true },
      },
    ]);
    expect(cancelFollowUps).toContain("Confirm cancellation");
  });

  it("P1-9: /book BookingSimulatorSection signed-out does not auto-quote and hides hardcoded email", async () => {
    vi.stubEnv("VITE_ENABLE_OFFLINE_DEMO", "false");
    mockAuthState = {
      ...mockAuthState,
      isAuthenticated: false,
      isLoading: false,
      user: undefined,
    };

    const quoteSpy = vi.spyOn(apiClient, "createBookingQuote");
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/v1/services")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              services: [
                {
                  id: "s1",
                  versions: [
                    {
                      name: "Executive Haircut",
                      durationMinutes: 45,
                      priceMinor: 7500,
                      baseDepositMinor: 2000,
                      currency: "USD",
                    },
                  ],
                },
              ],
            }),
        });
      }
      if (url.includes("/v1/availability")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              slots: [
                {
                  startsAt: "2026-11-11T17:00:00.000Z",
                  localStartsAt: "12:00 PM",
                  depositPreview: { minor: 2000, currency: "USD" },
                  price: { minor: 7500, currency: "USD" },
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    render(<BookingSimulatorSection />);

    expect(await screen.findByText("Sign in to get a live quote")).toBeDefined();
    expect(quoteSpy).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain("agent.alex@velvetai.internal");
    vi.unstubAllEnvs();
  });

  it("P0 bug fix: leaving and returning mid-payment resumes pay_deposit and reuses exact payment-order Idempotency-Key", async () => {
    const paymentExpiresAt = new Date(Date.now() + 540_000).toISOString();
    const orderKeysSeen: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/payment-order")) {
        const key = new Headers(init?.headers).get("idempotency-key") || "";
        orderKeysSeen.push(key);
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              paymentIntentId: "pi_resume_1",
              paypalOrderId: "PAYPAL_RESUME_1",
              amount: { currency: "USD", valueMinor: "2000" },
              status: "REQUIRES_PAYER_ACTION",
              paymentExpiresAt,
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }) as any;

    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValueOnce({
      details: baseApprovalDetails as any,
      serverTime: Date.now(),
    });
    vi.spyOn(approvalApi, "postApproveAndCommit").mockResolvedValueOnce({
      bookingId: "bk_p0_test",
      status: "COMMITTING",
      next: { type: "PAY_DEPOSIT", paymentOrderUrl: "/v1/bookings/bk_p0_test/payment-order" },
    } as any);

    const { unmount } = render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_mid_payment" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("state-ready")).toBeDefined());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => expect(screen.getByTestId("state-pay-deposit")).toBeDefined());
    await waitFor(() => expect(orderKeysSeen).toHaveLength(1));
    expect(orderKeysSeen[0]).toMatch(/^pay-order-/);

    // User leaves /approve/<locator>
    unmount();

    // User returns -> confirmation was CONSUMED, booking is COMMITTING / REQUIRES_PAYER_ACTION
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValueOnce({
      details: {
        ...baseApprovalDetails,
        status: "CONSUMED",
        bookingStatus: "COMMITTING",
        paymentStatus: "REQUIRES_PAYER_ACTION",
        paymentExpiresAt,
      } as any,
      serverTime: Date.now(),
    });

    render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_mid_payment" />
        </RouterProvider>
      </AskAIProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("state-pay-deposit")).toBeDefined());
    expect(screen.queryByTestId("state-already-done")).toBeNull();
    expect(screen.queryByText(/has already been confirmed/i)).toBeNull();
    expect(screen.getByText(/Approved — pay the \$20\.00 deposit to confirm/i)).toBeDefined();
    expect(screen.getByText(/PAYPAL PAYMENT WINDOW ACTIVE/i)).toBeDefined();

    await waitFor(() => expect(orderKeysSeen).toHaveLength(2));
    expect(orderKeysSeen[1]).toBe(orderKeysSeen[0]);
  });

  it("P0 & P2-1: derives approval page state for every booking/payment status and shows readable 'IST' timezone label", async () => {
    const openWindow = new Date(Date.now() + 480_000).toISOString();

    const cases: Array<{
      name: string;
      patch: Record<string, unknown>;
      expectedTestId: string;
      expectedText?: RegExp;
    }> = [
      {
        name: "ORDER_CREATE_PENDING -> pay_deposit",
        patch: {
          status: "CONSUMED",
          bookingStatus: "COMMITTING",
          paymentStatus: "ORDER_CREATE_PENDING",
          paymentExpiresAt: openWindow,
        },
        expectedTestId: "state-pay-deposit",
        expectedText: /Approved — pay the \$20\.00 deposit to confirm/i,
      },
      {
        name: "CAPTURE_IN_FLIGHT -> verifying_payment",
        patch: {
          status: "CONSUMED",
          bookingStatus: "COMMITTING",
          paymentStatus: "CAPTURE_IN_FLIGHT",
          operationId: "op_inflight_1",
        },
        expectedTestId: "state-verifying-payment",
      },
      {
        name: "CAPTURE_UNCERTAIN -> verifying_payment",
        patch: {
          status: "CONSUMED",
          bookingStatus: "CAPTURE_UNCERTAIN",
          operationId: "op_unc_resume_1",
        },
        expectedTestId: "state-verifying-payment",
      },
      {
        name: "CONFIRMED -> already_done",
        patch: {
          status: "CONSUMED",
          bookingStatus: "CONFIRMED",
          paymentStatus: "CAPTURED",
        },
        expectedTestId: "state-already-done",
        expectedText: /This booking has already been confirmed/i,
      },
      {
        name: "PAYMENT_FAILED -> payment_failed",
        patch: {
          status: "CONSUMED",
          bookingStatus: "PAYMENT_FAILED",
          paymentStatus: "FAILED",
          paymentExpiresAt: openWindow,
        },
        expectedTestId: "state-payment-failed",
      },
      {
        name: "PAYMENT_WINDOW_EXPIRED -> expired (Time released)",
        patch: {
          status: "CONSUMED",
          bookingStatus: "PAYMENT_WINDOW_EXPIRED",
          paymentStatus: "EXPIRED",
        },
        expectedTestId: "state-expired",
        expectedText: /Time released/i,
      },
      {
        name: "EXPIRED -> expired",
        patch: {
          status: "PENDING",
          bookingStatus: "EXPIRED",
        },
        expectedTestId: "state-expired",
      },
    ];

    for (const tc of cases) {
      cleanup();
      vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValueOnce({
        details: {
          ...baseApprovalDetails,
          ...tc.patch,
        } as any,
        serverTime: Date.now(),
      });

      render(
        <AskAIProvider>
          <RouterProvider>
            <ApprovalPage locator="loc_status_matrix" />
          </RouterProvider>
        </AskAIProvider>,
      );

      await waitFor(() =>
        expect(screen.getByTestId(tc.expectedTestId), `Case ${tc.name} failed`).toBeDefined(),
      );
      if (tc.expectedText) {
        expect(screen.getAllByText(tc.expectedText).length).toBeGreaterThanOrEqual(1);
      }
      if (tc.expectedTestId !== "state-already-done") {
        expect(screen.queryByText(/This booking has already been confirmed/i)).toBeNull();
      }
    }

    // P2-1: Ready state displays readable "IST" instead of "GMT+5:30" under TZ=Asia/Kolkata
    cleanup();
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValueOnce({
      details: baseApprovalDetails as any,
      serverTime: Date.now(),
    });
    render(
      <AskAIProvider>
        <RouterProvider>
          <ApprovalPage locator="loc_tz_ist" />
        </RouterProvider>
      </AskAIProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("state-ready")).toBeDefined());
    const secondary = screen.getByTestId("secondary-time");
    expect(secondary.textContent).toContain("Your time:");
    expect(secondary.textContent).toContain("IST");
    expect(secondary.textContent).not.toContain("GMT+5:30");
  });
});
