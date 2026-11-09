/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as auth0React from "@auth0/auth0-react";
import { AskAIDrawer } from "../components/AskAIDrawer.js";

// Force process timezone to Asia/Kolkata for testing time zone translation
process.env.TZ = "Asia/Kolkata";

const mockSendMessage = vi.fn();

const mockUseChatState = {
  messages: [] as any[],
  sendMessage: mockSendMessage,
  stop: vi.fn(),
  status: "ready" as const,
  error: undefined as Error | undefined,
  setMessages: vi.fn(),
  regenerate: vi.fn(),
};

vi.mock("@ai-sdk/react", () => ({
  useChat: () => mockUseChatState,
}));

vi.mock("@auth0/auth0-react", async () => {
  const actual = await vi.importActual<typeof auth0React>("@auth0/auth0-react");
  return {
    ...actual,
    useAuth0: () => ({
      isAuthenticated: true,
      isLoading: false,
      user: { name: "Test Buyer", email: "buyer@velvetai.example" },
      getAccessTokenSilently: vi.fn().mockResolvedValue("test-token"),
      loginWithRedirect: vi.fn(),
      logout: vi.fn(),
    }),
  };
});

describe("Ask AI Golden Path Scenarios (TZ=Asia/Kolkata)", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockUseChatState.messages = [];
  });

  afterEach(() => {
    cleanup();
  });

  it("13. Scenario 'Find an Executive Haircut tomorrow afternoon': collapsed catalog chip, merchant zone primary + 'Your time', +N more when > 8, chips clickable", () => {
    // 9 slots with server-side display in America/New_York (EDT)
    const mockSlots = Array.from({ length: 9 }).map((_, i) => {
      const hour = 12 + Math.floor(i / 2);
      const min = (i % 2) * 30;
      const hourStr = hour > 12 ? `${hour - 12}` : `${hour}`;
      const minStr = min === 0 ? "00" : `${min}`;
      const localStart = `${hourStr}:${minStr} PM`;
      // UTC time for 12:00 PM EDT is 16:00 UTC
      const utcHour = 16 + Math.floor(i / 2);
      const startsAt = `2026-10-28T${utcHour.toString().padStart(2, "0")}:${minStr}:00.000Z`;

      return {
        startsAt,
        endsAt: `2026-10-28T${(utcHour + 1).toString().padStart(2, "0")}:${minStr}:00.000Z`,
        timeZone: "America/New_York",
        display: {
          localDate: "Wed, Oct 28, 2026",
          localStart,
          localEnd: `${hourStr}:${min === 0 ? "45" : "15"} PM`,
          timeZone: "America/New_York",
          timeZoneLabel: "EDT",
        },
      };
    });

    const assistantParts = [
      {
        type: "tool-call",
        toolCallId: "call-list-1",
        toolName: "list_services_v1",
        args: {},
      },
      {
        type: "tool-result",
        toolCallId: "call-list-1",
        toolName: "list_services_v1",
        result: {
          services: [
            { id: "s1", name: "Executive Haircut & Beard Sculpt", durationMinutes: 45, price: { valueMinor: "7500", currency: "USD" } },
            { id: "s2", name: "Royal Shave Treatment", durationMinutes: 30, price: { valueMinor: "5000", currency: "USD" } },
            { id: "s3", name: "Private Acoustic Studio Block", durationMinutes: 60, price: { valueMinor: "14000", currency: "USD" } },
          ],
          total: 3,
        },
      },
      {
        type: "tool-call",
        toolCallId: "call-slots-1",
        toolName: "find_available_slots_v1",
        args: { serviceName: "Executive Haircut & Beard Sculpt" },
      },
      {
        type: "tool-result",
        toolCallId: "call-slots-1",
        toolName: "find_available_slots_v1",
        result: {
          serviceName: "Executive Haircut & Beard Sculpt",
          timeZone: "America/New_York",
          slots: mockSlots,
          scheduleRevision: 1,
        },
      },
      {
        type: "text",
        text: "Available times for Executive Haircut tomorrow afternoon are shown below. Tap a time to hold it for 5 minutes.",
      },
    ];

    mockUseChatState.messages = [
      {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Find an Executive Haircut tomorrow afternoon" }],
      },
      {
        id: "msg-2",
        role: "assistant",
        parts: assistantParts,
      },
    ];

    render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

    // 1. Collapsed catalog chip only, NO full service catalog card by default
    expect(screen.getByText(/Checked catalog · 3 services/i)).toBeDefined();
    expect(screen.queryByTestId("service-list-card")).toBeNull();

    // 2. Slots card header has service name, date, merchant zone label, and slot count
    expect(screen.getByTestId("slots-card")).toBeDefined();
    expect(screen.getByText(/Available times · Executive Haircut & Beard Sculpt · Wed, Oct 28, 2026 · EDT/i)).toBeDefined();
    expect(screen.getByText("9 slots")).toBeDefined();
    expect(screen.queryByText(/Authoritative Available Windows/i)).toBeNull();
    expect(screen.queryByText(/Live service catalog/i)).toBeNull();

    // 3. Primary times in EDT + Secondary line in IST ("Your time: ...")
    expect(screen.getByText(/12:00 PM – 12:45 PM EDT/i)).toBeDefined();
    // 12:00 PM EDT (16:00 UTC) in Asia/Kolkata (+5:30) is 9:30 PM IST
    const yourTimeNodes = screen.getAllByText(/Your time: 9:30 PM/i);
    expect(yourTimeNodes.length).toBeGreaterThanOrEqual(1);

    // 4. "+N more" button present because slots.length (9) > 8
    const moreBtn = screen.getByRole("button", { name: /\+1 more/i });
    expect(moreBtn).toBeDefined();

    // 5. Chips are clickable buttons sending "Prepare the <localStart> <zoneLabel> <service> slot on <localDate>"
    const firstChip = screen.getByRole("button", { name: /Select slot at 12:00 PM – 12:45 PM EDT/i });
    fireEvent.click(firstChip);
    expect(mockSendMessage).toHaveBeenCalledWith({
      text: "Prepare the 12:00 PM EDT Executive Haircut & Beard Sculpt slot on Wed, Oct 28, 2026",
    });

    // 6. Expanding "+1 more" shows the 9th slot
    fireEvent.click(moreBtn);
    expect(screen.getByRole("button", { name: /Show fewer/i })).toBeDefined();

    // 7. Context-aware follow-up chips after slots
    expect(screen.getByRole("button", { name: /Hold 12:00 PM slot/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Show tomorrow morning/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Try another day/i })).toBeDefined();
    // Never suggests "Find available slots" when slots was just shown
    expect(screen.queryByRole("button", { name: /^Find available slots$/i })).toBeNull();
  });

  it("14. Scenario 'I want to book for 6 pm of private acoustic studio block': quote card formatted money, approval card with absolute URL, no raw JSON, no '[object Object]'", () => {
    const assistantParts = [
      {
        type: "tool-call",
        toolCallId: "call-quote-1",
        toolName: "quote_booking_v1",
        args: { serviceName: "Private Acoustic Studio Block" },
      },
      {
        type: "tool-result",
        toolCallId: "call-quote-1",
        toolName: "quote_booking_v1",
        result: {
          quoteId: "quote_123456",
          expiresAt: "2026-10-28T22:05:00.000Z",
          serviceVersion: 1,
          scheduleRevision: 1,
          serviceName: "Private Acoustic Studio Block",
          startsAt: "2026-10-28T22:00:00.000Z",
          endsAt: "2026-10-28T23:00:00.000Z",
          display: {
            localDate: "Wed, Oct 28, 2026",
            localStart: "6:00 PM",
            localEnd: "7:00 PM",
            timeZone: "America/New_York",
            timeZoneLabel: "EDT",
          },
          total: { valueMinor: "14000", currency: "USD" },
          deposit: { valueMinor: "3500", currency: "USD" },
          cancellationPolicy: {
            policyId: "pol_std",
            version: 1,
            summary: "Full deposit refund if cancelled at least 24 hours prior to appointment.",
          },
        },
      },
      {
        type: "tool-call",
        toolCallId: "call-prep-1",
        toolName: "prepare_booking_v1",
        args: {},
      },
      {
        type: "tool-result",
        toolCallId: "call-prep-1",
        toolName: "prepare_booking_v1",
        result: {
          bookingId: "book_test789",
          status: "HELD",
          holdExpiresAt: "2026-10-28T22:15:00.000Z",
          version: 1,
          intent: "jwt.intent.token",
          approvalLocator: "/v1/booking-approvals/loc_studio6pm",
          approvalUrl: "http://localhost:5174/approve/loc_studio6pm",
          requiresHumanConfirmation: true,
          terms: {
            serviceId: "s3",
            serviceName: "Private Acoustic Studio Block",
            startsAt: "2026-10-28T22:00:00.000Z",
            timeZone: "America/New_York",
            display: {
              localDate: "Wed, Oct 28, 2026",
              localStart: "6:00 PM",
              localEnd: "7:00 PM",
              timeZone: "America/New_York",
              timeZoneLabel: "EDT",
            },
          },
        },
      },
      {
        type: "text",
        text: "I used salon time (EDT); that's 3:30 AM your time. I prepared your booking hold; please review and approve on the approval page.",
      },
    ];

    mockUseChatState.messages = [
      {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "I want to book for 6 pm of private acoustic studio block" }],
      },
      {
        id: "msg-2",
        role: "assistant",
        parts: assistantParts,
      },
    ];

    const { container } = render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

    // 1. QuoteCard renders
    expect(screen.getByTestId("quote-card")).toBeDefined();
    expect(screen.getByText("Quote · Private Acoustic Studio Block")).toBeDefined();

    // 2. Financial breakdown in QuoteCard
    expect(screen.getByText("$140.00")).toBeDefined(); // Total
    expect(screen.getByText("$35.00")).toBeDefined();  // Deposit
    expect(screen.getByText("$105.00")).toBeDefined(); // Balance Due
    expect(screen.getByText(/Full deposit refund if cancelled at least 24 hours prior/i)).toBeDefined();

    // 3. ApprovalCard renders with absolute URL
    expect(screen.getByTestId("approval-card")).toBeDefined();
    expect(screen.getByText("Ready for your approval")).toBeDefined();
    expect(screen.getByText(/Hold active · 15m window/i)).toBeDefined();
    const openApprovalLink = screen.getByRole("link", { name: "Open approval page" });
    expect(openApprovalLink.getAttribute("href")).toBe("http://localhost:5174/approve/loc_studio6pm");

    // 4. Critical data hygiene: NO quoteId, NO policyId, NO raw valueMinor, NO "[object Object]"
    const text = container.textContent || "";
    expect(text).not.toContain("quoteId");
    expect(text).not.toContain("quote_123456");
    expect(text).not.toContain("policyId");
    expect(text).not.toContain("pol_std");
    expect(text).not.toContain("valueMinor");
    expect(text).not.toContain("serviceVersion");
    expect(text).not.toContain("scheduleRevision");
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain("items items");

    // 5. Context-aware follow-up chips after prepare
    const followUpBtns = screen.getAllByRole("button", { name: "Open approval page" });
    expect(followUpBtns.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Find a different time" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Prepare a booking" })).toBeNull();
  });

  it("15. Clean neutral chip for unknown/unsupported tool output — NEVER JSON.stringify raw data into the UI", () => {
    mockUseChatState.messages = [
      {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Evaluate risk profile" }],
      },
      {
        id: "msg-2",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "call-unknown-1",
            toolName: "evaluate_risk.v1",
            args: {},
          },
          {
            type: "tool-result",
            toolCallId: "call-unknown-1",
            toolName: "evaluate_risk.v1",
            result: {
              rawRiskScore: 0.12,
              internalMetadata: { flags: ["trusted_buyer"], rawId: 9999 },
            },
          },
        ],
      },
    ];

    const { container } = render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

    // Neutral chip renders
    expect(screen.getByText(/Checked evaluate risk/i)).toBeDefined();

    // Verify NO raw JSON or brackets
    const text = container.textContent || "";
    expect(text).not.toContain("{");
    expect(text).not.toContain("}");
    expect(text).not.toContain("rawRiskScore");
    expect(text).not.toContain("internalMetadata");
    expect(text).not.toContain("[object Object]");
  });
});
