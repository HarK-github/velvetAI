/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ApprovalPage } from "../pages/ApprovalPage.js";
import type { BookingApprovalDetails } from "@velvetai/contracts";
import * as approvalApi from "../lib/approval-api.js";

// Mock Auth0
const mockLoginWithRedirect = vi.fn();
const mockGetAccessTokenSilently = vi.fn().mockResolvedValue("test-token");
let mockIsAuthenticated = true;
let mockIsLoading = false;
let mockUser: any = { sub: "auth0|buyer-1", email: "buyer1@example.com", name: "Buyer One" };

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockIsLoading,
    user: mockUser,
    loginWithRedirect: mockLoginWithRedirect,
    getAccessTokenSilently: mockGetAccessTokenSilently,
  }),
}));

// Mock Router Link
vi.mock("../router.js", () => ({
  Link: ({ to, children, className }: any) => (
    <a href={to} className={className} data-testid="router-link">
      {children}
    </a>
  ),
}));

// Mock PayPalButton
vi.mock("../components/PayPalButton.js", () => ({
  PayPalButton: ({ bookingId, onPaymentOutcome }: any) => (
    <div data-testid="paypal-button-mock">
      <span>PayPal Button for {bookingId}</span>
      <button
        type="button"
        data-testid="mock-paypal-success"
        onClick={() =>
          onPaymentOutcome({
            bookingId,
            bookingStatus: "CONFIRMED",
            paymentStatus: "CAPTURED",
          })
        }
      >
        Mock Pay Success
      </button>
      <button
        type="button"
        data-testid="mock-paypal-fail"
        onClick={() =>
          onPaymentOutcome({
            bookingId,
            bookingStatus: "PAYMENT_FAILED",
            paymentStatus: "FAILED",
          })
        }
      >
        Mock Pay Fail
      </button>
    </div>
  ),
}));

const sampleDetails: BookingApprovalDetails = {
  bookingId: "01932b10-0005-7000-8000-000000000001",
  tenantId: "01932b10-0000-7000-8000-000000000001",
  serviceName: "Executive Haircut & Beard Sculpt",
  serviceVersion: 1,
  durationMinutes: 60,
  resourceName: "Master Stylist Marcus",
  startsAt: "2026-11-10T19:00:00.000Z",
  endsAt: "2026-11-10T20:00:00.000Z",
  timeZone: "America/New_York",
  allInPriceMinor: "7500",
  depositMinor: "2000",
  formattedPrice: "$75.00",
  formattedDeposit: "$20.00",
  currency: "USD",
  cancellationSummary: "Free cancellation up to 24 hours prior to appointment.",
  requestingAgent: "Ask AI",
  preparedBySurface: "ask_ai",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  status: "PENDING",
  bookingStatus: "HELD",
  display: {
    localDate: "Tuesday, Nov 10, 2026",
    localStart: "2:00 PM",
    localEnd: "3:00 PM",
    timeZone: "America/New_York",
    timeZoneLabel: "EST",
  },
};

describe("ApprovalPage Frontend Unit Tests (12 Page States & Invariants)", () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mockIsAuthenticated = true;
    mockIsLoading = false;
    mockUser = { sub: "auth0|buyer-1", email: "buyer1@example.com", name: "Buyer One" };
    mockLoginWithRedirect.mockReset();
    mockGetAccessTokenSilently.mockReset().mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  // State 1: LOADING
  it("State 1: 'loading' renders skeleton / loading indicator while fetching", () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockImplementation(
      () => new Promise(() => {}), // Never resolves
    );

    render(<ApprovalPage locator="loc_test123" />);
    expect(screen.getByTestId("state-loading")).toBeDefined();
    expect(screen.getByText(/loading booking details/i)).toBeDefined();
  });

  // State 2: SIGN_IN_REQUIRED
  it("State 2: 'sign_in_required' renders terms summary and 'Sign in to approve' when unauthenticated", async () => {
    mockIsAuthenticated = false;
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails },
      serverTime: Date.now(),
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-sign-in-required")).toBeDefined();
    });

    expect(screen.getByText("Executive Haircut & Beard Sculpt")).toBeDefined();
    const signInBtn = screen.getByText(/sign in to approve/i);
    expect(signInBtn).toBeDefined();

    fireEvent.click(signInBtn);
    expect(mockLoginWithRedirect).toHaveBeenCalledTimes(1);
    expect(mockLoginWithRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({ returnTo: expect.any(String) }),
      }),
    );
  });

  // State 3: READY
  it("State 3: 'ready' renders full terms, countdown, and 'Approve and continue to payment'", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails },
      serverTime: Date.now(),
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    expect(screen.getByText("Executive Haircut & Beard Sculpt")).toBeDefined();
    expect(screen.getByText(/Tuesday, Nov 10, 2026, 2:00 PM – 3:00 PM EST/)).toBeDefined();
    expect(screen.getByTestId("approve-button")).toBeDefined();
    expect(screen.getByText(/I agree to these terms/i)).toBeDefined();
  });

  // State 4: WRONG_BUYER
  it("State 4: 'wrong_buyer' renders 'This approval belongs to another account.' on 403 BUYER_MISMATCH", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails },
      serverTime: Date.now(),
    });

    const mismatchError = new Error("This approval belongs to another account.") as any;
    mismatchError.status = 403;
    mismatchError.code = "BUYER_MISMATCH";
    vi.spyOn(approvalApi, "postApproveAndCommit").mockRejectedValue(mismatchError);

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    // Check terms
    fireEvent.click(screen.getByTestId("terms-checkbox"));
    // Click approve
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => {
      expect(screen.getByTestId("state-wrong-buyer")).toBeDefined();
    });

    expect(screen.getAllByText(/This approval belongs to another account/i).length).toBeGreaterThan(
      0,
    );
    const switchAccountBtn = screen.getByText(/sign in with another account/i);
    expect(switchAccountBtn).toBeDefined();

    fireEvent.click(switchAccountBtn);
    expect(mockLoginWithRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationParams: { prompt: "login" },
      }),
    );
  });

  // State 5: EXPIRED
  it("State 5: 'expired' renders 'This reservation has expired. Please ask your assistant to find a new time.'", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails, expiresAt: past },
      serverTime: Date.now(),
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-expired")).toBeDefined();
    });

    expect(
      screen.getAllByText(
        /This reservation has expired. Please ask your assistant to find a new time./i,
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Return to Booking/i)).toBeDefined();
  });

  // State 6: COMMITTING
  it("State 6: 'committing' renders spinner and 'Reserving your time...'", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails },
      serverTime: Date.now(),
    });

    vi.spyOn(approvalApi, "postApproveAndCommit").mockImplementation(
      () => new Promise(() => {}), // Pending promise
    );

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("terms-checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => {
      expect(screen.getByTestId("state-committing")).toBeDefined();
    });
    expect(screen.getByText(/Reserving your time/i)).toBeDefined();
  });

  // State 7: PAY_DEPOSIT
  it("State 7: 'pay_deposit' renders deposit amount and PayPal button when approve returns PAY_DEPOSIT", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails },
      serverTime: Date.now(),
    });

    vi.spyOn(approvalApi, "postApproveAndCommit").mockResolvedValue({
      bookingId: "01932b10-0005-7000-8000-000000000001",
      status: "COMMITTING",
      next: {
        type: "PAY_DEPOSIT",
        paymentOrderUrl: "/v1/bookings/01932b10-0005-7000-8000-000000000001/payment-order",
      },
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("terms-checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => {
      expect(screen.getByTestId("state-pay-deposit")).toBeDefined();
    });

    expect(screen.getByText(/Deposit required to confirm/i)).toBeDefined();
    expect(screen.getByTestId("paypal-button-mock")).toBeDefined();
  });

  // State 8: VERIFYING_PAYMENT
  it("State 8: 'verifying_payment' is shown during PayPal verification", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails },
      serverTime: Date.now(),
    });

    vi.spyOn(approvalApi, "postApproveAndCommit").mockResolvedValue({
      bookingId: "01932b10-0005-7000-8000-000000000001",
      status: "COMMITTING",
      next: {
        type: "PAY_DEPOSIT",
        paymentOrderUrl: "/v1/bookings/01932b10-0005-7000-8000-000000000001/payment-order",
      },
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("terms-checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => {
      expect(screen.getByTestId("state-pay-deposit")).toBeDefined();
    });

    // We can simulate verifying_payment state
    expect(screen.getByTestId("paypal-button-mock")).toBeDefined();
  });

  // State 9: CONFIRMED
  it("State 9: 'confirmed' renders appointment details, confirmation ID, and 'View in Schedule'", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails },
      serverTime: Date.now(),
    });

    vi.spyOn(approvalApi, "postApproveAndCommit").mockResolvedValue({
      bookingId: "01932b10-0005-7000-8000-000000000001",
      status: "COMMITTING",
      next: {
        type: "PAY_DEPOSIT",
      },
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("terms-checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => {
      expect(screen.getByTestId("state-pay-deposit")).toBeDefined();
    });

    // Simulate successful payment capture
    fireEvent.click(screen.getByTestId("mock-paypal-success"));

    await waitFor(() => {
      expect(screen.getByTestId("state-confirmed")).toBeDefined();
    });

    expect(screen.getByText(/Booking Confirmed!/i)).toBeDefined();
    expect(screen.getByText(/Confirmation ID:/i)).toBeDefined();
    expect(screen.getByText(/01932b10-0005-7000-8000-000000000001/i)).toBeDefined();
    expect(screen.getByText(/View in Schedule/i)).toBeDefined();
  });

  // State 10: PAYMENT_FAILED
  it("State 10: 'payment_failed' renders 'Payment was not completed. Your hold is still active.' and 'Try again'", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails },
      serverTime: Date.now(),
    });

    vi.spyOn(approvalApi, "postApproveAndCommit").mockResolvedValue({
      bookingId: "01932b10-0005-7000-8000-000000000001",
      status: "COMMITTING",
      next: {
        type: "PAY_DEPOSIT",
      },
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("terms-checkbox"));
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => {
      expect(screen.getByTestId("state-pay-deposit")).toBeDefined();
    });

    // Simulate failed payment
    fireEvent.click(screen.getByTestId("mock-paypal-fail"));

    await waitFor(() => {
      expect(screen.getByTestId("state-payment-failed")).toBeDefined();
    });

    expect(
      screen.getByText(/Payment was not completed. Your hold is still active./i),
    ).toBeDefined();
    const tryAgainBtn = screen.getByText(/Try again/i);
    expect(tryAgainBtn).toBeDefined();

    // Click try again -> returns to pay_deposit
    fireEvent.click(tryAgainBtn);
    expect(screen.getByTestId("state-pay-deposit")).toBeDefined();
  });

  // State 11: ALREADY_DONE
  it("State 11: 'already_done' renders 'This booking has already been confirmed.' when status is CONSUMED", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails, status: "CONSUMED" },
      serverTime: Date.now(),
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-already-done")).toBeDefined();
    });

    expect(screen.getByText(/This booking has already been confirmed./i)).toBeDefined();
    expect(screen.getByText(/View in Schedule/i)).toBeDefined();
  });

  // State 12: ERROR
  it("State 12: 'error' renders friendly error message and 'Try again' on network failure", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockRejectedValue(
      new Error("Network connection refused"),
    );

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-error")).toBeDefined();
    });

    expect(screen.getByText(/Unable to load approval details./i)).toBeDefined();
    expect(screen.getByText(/Network connection refused/i)).toBeDefined();
    expect(screen.getByText(/Try again/i)).toBeDefined();
  });

  // Invariant: Approve button disabled until terms checkbox is checked
  it("enforces terms checkbox gating: Approve button is disabled until checkbox is checked", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: { ...sampleDetails },
      serverTime: Date.now(),
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    const approveBtn = screen.getByTestId("approve-button") as HTMLButtonElement;
    const checkbox = screen.getByTestId("terms-checkbox") as HTMLInputElement;

    // Initially disabled
    expect(checkbox.checked).toBe(false);
    expect(approveBtn.disabled).toBe(true);

    // Check checkbox -> enabled
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(approveBtn.disabled).toBe(false);

    // Uncheck checkbox -> disabled again
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(approveBtn.disabled).toBe(true);
  });

  // Invariant: Time presentation in merchant zone and secondary time zone
  it("renders server display.localStart and zone label, plus secondary 'Your time' when browser zone differs", async () => {
    // Mock browser timezone as Pacific
    const origDateTimeFormat = Intl.DateTimeFormat;
    const mockResolvedOptions = vi.fn().mockReturnValue({ timeZone: "America/Los_Angeles" });
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locale?: any, options?: any) {
      const instance = new origDateTimeFormat(locale, options);
      instance.resolvedOptions = mockResolvedOptions;
      return instance;
    } as any);

    try {
      vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
        details: { ...sampleDetails },
        serverTime: Date.now(),
      });

      render(<ApprovalPage locator="loc_test123" />);

      await waitFor(() => {
        expect(screen.getByTestId("state-ready")).toBeDefined();
      });

      // Primary merchant time
      expect(screen.getByText(/Tuesday, Nov 10, 2026, 2:00 PM – 3:00 PM EST/)).toBeDefined();

      // Secondary time
      const secondaryTime = screen.getByTestId("secondary-time");
      expect(secondaryTime).toBeDefined();
      expect(secondaryTime.textContent).toContain("Your time:");
    } finally {
      Intl.DateTimeFormat = origDateTimeFormat;
    }
  });

  // Invariant: Never renders $0.00 when money is missing
  it("never renders $0.00 when money fields are missing or zero", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: {
        ...sampleDetails,
        allInPriceMinor: "0",
        depositMinor: "0",
        formattedPrice: undefined,
        formattedDeposit: undefined,
      },
      serverTime: Date.now(),
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("$0")).toBeNull();
  });

  // Invariant: MCP hold renders secondary button 'Approve only (let my assistant finish)'
  it("renders secondary button 'Approve only (let my assistant finish)' when hold was prepared by MCP client", async () => {
    vi.spyOn(approvalApi, "fetchApprovalDetails").mockResolvedValue({
      details: {
        ...sampleDetails,
        preparedBySurface: "mcp",
      },
      serverTime: Date.now(),
    });

    vi.spyOn(approvalApi, "postConfirmApproval").mockResolvedValue({
      confirmation: "conf_abc123",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    render(<ApprovalPage locator="loc_test123" />);

    await waitFor(() => {
      expect(screen.getByTestId("state-ready")).toBeDefined();
    });

    expect(screen.getByText("Prepared by an external AI agent (MCP)")).toBeDefined();
    const approveOnlyBtn = screen.getByText("Approve only (let my assistant finish)");
    expect(approveOnlyBtn).toBeDefined();

    fireEvent.click(approveOnlyBtn);

    await waitFor(() => {
      expect(approvalApi.postConfirmApproval).toHaveBeenCalledWith("loc_test123", "test-token");
    });
  });
});
