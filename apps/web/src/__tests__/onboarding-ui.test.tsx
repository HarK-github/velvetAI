/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import {
  FirstRunWelcomeBanner,
  getWelcomeStorageKey,
} from "../components/FirstRunWelcomeBanner.js";
import { AccountProvisioningNotice } from "../components/AccountProvisioningNotice.js";
import { formatAskAIErrorMessage } from "../components/AskAIDrawer.js";
import { apiClient, API_BASE_URL } from "../api-client.js";
import { RouterProvider } from "../router.js";

const mockAuthState: {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: Record<string, string> | undefined;
  loginWithRedirect: ReturnType<typeof vi.fn>;
  getAccessTokenSilently: ReturnType<typeof vi.fn>;
} = {
  isAuthenticated: true,
  isLoading: false,
  user: { sub: "auth0|first-run-buyer" },
  loginWithRedirect: vi.fn(),
  getAccessTokenSilently: vi.fn().mockResolvedValue("buyer-jwt-token"),
};

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => mockAuthState,
}));

vi.mock("@bryntum/scheduler-react", () => ({
  BryntumScheduler: () => <div data-testid="mock-bryntum-scheduler" />,
}));

import { SchedulePage } from "../pages/SchedulePage.js";

describe("WP 04A Part 5 Onboarding UI", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    apiClient.setAuthToken("");
    mockAuthState.isAuthenticated = true;
    mockAuthState.isLoading = false;
    mockAuthState.user = { sub: "auth0|first-run-buyer" };
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    globalThis.fetch = originalFetch;
    apiClient.setAuthToken("");
  });

  it("shows first-run welcome card once after first login and persists dismissal to localStorage", () => {
    const onOpenAi = vi.fn();
    const { rerender } = render(<FirstRunWelcomeBanner onOpenAi={onOpenAi} />);

    const card = screen.getByTestId("first-run-welcome-card");
    expect(card.textContent).toContain(
      "Welcome — you can now book with Ask AI. Paying uses PayPal Sandbox: use the sandbox buyer from the testing instructions.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("first-run-welcome-card")).toBeNull();
    expect(window.localStorage.getItem(getWelcomeStorageKey("auth0|first-run-buyer"))).toBe("1");

    // Re-mounting keeps welcome card dismissed
    rerender(<FirstRunWelcomeBanner onOpenAi={onOpenAi} />);
    expect(screen.queryByTestId("first-run-welcome-card")).toBeNull();
  });

  it("renders friendly user_not_provisioned state with Retry button across components", () => {
    const formatted = formatAskAIErrorMessage(
      new Error('{"code":"user_not_provisioned","detail":"User not provisioned"}'),
    );
    expect(formatted.message).toContain("Your account isn't set up yet");
    expect(formatted.isAuthError).toBe(false);

    const onRetry = vi.fn();
    render(<AccountProvisioningNotice onRetry={onRetry} />);
    expect(screen.getByText("Your account isn't set up yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("displays friendly provisioning notice on /schedule when backend returns 403 user_not_provisioned", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith(`${API_BASE_URL}/v1/merchant/schedule`)) {
        return {
          ok: false,
          status: 403,
          statusText: "Forbidden",
          headers: new Headers({ "content-type": "application/problem+json" }),
          json: async () => ({
            title: "Forbidden",
            status: 403,
            code: "user_not_provisioned",
            detail: "User has not been provisioned in local database",
          }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 403,
        headers: new Headers(),
        json: async () => ({}),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RouterProvider>
        <SchedulePage />
      </RouterProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("account-not-provisioned-notice")).toBeTruthy();
    });
    expect(screen.getByText("Your account isn't set up yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
