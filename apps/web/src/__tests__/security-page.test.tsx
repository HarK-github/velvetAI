/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import * as auth0React from "@auth0/auth0-react";
import type { LiveAbuseRun } from "@velvetai/contracts";
import { API_BASE_URL, apiClient } from "../api-client.js";
import { RouterProvider } from "../router.js";
import { Navbar } from "../components/Navbar.js";
import { SecurityPage } from "../pages/SecurityPage.js";

vi.mock("@auth0/auth0-react", async () => {
  const actual = await vi.importActual<typeof auth0React>("@auth0/auth0-react");
  return {
    ...actual,
    useAuth0: vi.fn(),
  };
});

function buildJsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function mockUseAuth0State(overrides?: {
  isAuthenticated?: boolean;
  isLoading?: boolean;
  getAccessTokenSilently?: ReturnType<typeof vi.fn>;
  loginWithRedirect?: ReturnType<typeof vi.fn>;
}) {
  vi.mocked(auth0React.useAuth0).mockReturnValue({
    isAuthenticated: overrides?.isAuthenticated ?? false,
    isLoading: overrides?.isLoading ?? false,
    user: undefined,
    error: undefined,
    loginWithRedirect: overrides?.loginWithRedirect ?? vi.fn().mockResolvedValue(undefined),
    logout: vi.fn(),
    getAccessTokenSilently:
      overrides?.getAccessTokenSilently ?? vi.fn().mockResolvedValue("judge-jwt-token"),
    getIdTokenClaims: vi.fn(),
    loginWithPopup: vi.fn(),
    handleRedirectCallback: vi.fn(),
    getAccessTokenWithPopup: vi.fn(),
  } as unknown as auth0React.Auth0ContextInterface);
}

describe("SecurityPage (/security Abuse Lab Dashboard)", () => {
  beforeEach(() => {
    apiClient.setAuthToken(null);
    mockUseAuth0State();
  });

  afterEach(() => {
    apiClient.setAuthToken(null);
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders publicly without login, loads all 51 CI scenarios from the static JSON artifact, and shows commit link", () => {
    render(
      <RouterProvider>
        <SecurityPage />
      </RouterProvider>,
    );

    expect(screen.getByRole("heading", { name: "Security proof" })).toBeTruthy();
    expect(
      screen.getByText("Every attack below is checked by code, not by asking the AI to behave."),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Automated Abuse Lab Suite (51 of 51 passed)" }),
    ).toBeTruthy();
    expect(screen.getByText("Showing 51 of 51 scenarios")).toBeTruthy();
    expect(screen.getByText("SEC-001")).toBeTruthy();
    expect(screen.getByText("TRANS-023")).toBeTruthy();
    expect(screen.getAllByText("Blocked as expected").length).toBeGreaterThanOrEqual(51);

    const commitLinks = screen
      .getAllByRole("link")
      .filter((el) =>
        (el.getAttribute("href") ?? "").startsWith(
          "https://github.com/HarK-github/velvetAI/commit/",
        ),
      );
    expect(commitLinks.length).toBe(1);

    expect(screen.getByText("Sign in as the demo judge to run live checks")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How the protections work" })).toBeTruthy();
  });

  it("filters CI scenarios by severity and category", () => {
    render(
      <RouterProvider>
        <SecurityPage />
      </RouterProvider>,
    );

    const severitySelect = screen.getByLabelText("Filter by severity") as HTMLSelectElement;
    const categorySelect = screen.getByLabelText("Filter by category") as HTMLSelectElement;

    fireEvent.change(severitySelect, { target: { value: "CRITICAL" } });
    expect(screen.getByText("Showing 25 of 51 scenarios")).toBeTruthy();

    fireEvent.change(categorySelect, { target: { value: "PAYMENT" } });
    expect(screen.queryByText("SEC-001")).toBeNull();
    expect(screen.getByText(/Showing \d+ of 51 scenarios/)).toBeTruthy();

    fireEvent.change(severitySelect, { target: { value: "ALL" } });
    fireEvent.change(categorySelect, { target: { value: "ALL" } });
    expect(screen.getByText("Showing 51 of 51 scenarios")).toBeTruthy();
  });

  it("shows the demo judge sign-in prompt when a non-judge signed-in user receives 403", async () => {
    const fetchMock = vi.fn().mockResolvedValue(buildJsonResponse({ detail: "Forbidden" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    mockUseAuth0State({
      isAuthenticated: true,
      getAccessTokenSilently: vi.fn().mockResolvedValue("buyer-token"),
    });

    render(
      <RouterProvider>
        <SecurityPage />
      </RouterProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Sign in as the demo judge to run live checks")).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/v1/judge/abuse-lab/runs`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer buyer-token",
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Run live checks" })).toBeNull();
  });

  it("lets a signed-in demo judge trigger live checks with Idempotency-Key, polls status, and shows State changed: none", async () => {
    const runningRun: LiveAbuseRun = {
      runId: "01932b10-0000-7000-8000-000000009991",
      status: "RUNNING",
      startedAt: "2026-11-10T18:00:00.000Z",
      finishedAt: null,
      scenarios: [
        {
          id: "L1",
          name: "Concurrent slot hoarding race",
          level: "Service",
          ciScenarioId: "SEC-003",
          status: "PASS",
          durationMs: 48,
          expected: "1 winner + 19 slot_unavailable (409)",
          observed: "1 winner, 19 slot_unavailable (409)",
          stateUnchanged: true,
        },
        {
          id: "L11",
          name: "Missing Idempotency-Key on mutating POST rejected",
          level: "HTTP",
          ciScenarioId: "No direct CI equivalent",
          status: "PASS",
          durationMs: 9,
          expected: "400 idempotency_key_required",
          observed: "HTTP 400 (idempotency_key_required)",
          stateUnchanged: true,
        },
        {
          id: "L4",
          name: "Agent approves its own hold with M2M token",
          level: "Service",
          ciScenarioId: "TRANS-021",
          status: "RUNNING",
          durationMs: 0,
          expected: "HUMAN_APPROVAL_REQUIRED (403)",
          observed: "",
          stateUnchanged: null,
        },
      ],
      summary: null,
    };

    const completedRun: LiveAbuseRun = {
      ...runningRun,
      status: "SUCCEEDED",
      finishedAt: "2026-11-10T18:00:01.000Z",
      scenarios: [
        runningRun.scenarios[0]!,
        runningRun.scenarios[1]!,
        {
          ...runningRun.scenarios[2]!,
          status: "PASS",
          durationMs: 19,
          observed: "Rejected with HUMAN_APPROVAL_REQUIRED (403)",
          stateUnchanged: true,
        },
      ],
      summary: {
        total: 3,
        passed: 3,
        failed: 0,
        errored: 0,
        allStateUnchanged: true,
      },
    };

    let pollCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url === `${API_BASE_URL}/v1/judge/abuse-lab/runs` &&
        (!init?.method || init.method === "GET")
      ) {
        return buildJsonResponse({ isJudge: true, latestRun: null, runs: [] }, 200);
      }
      if (url === `${API_BASE_URL}/v1/judge/abuse-lab/runs` && init?.method === "POST") {
        const headers = init.headers as Record<string, string>;
        expect(headers["Idempotency-Key"]).toMatch(/^live-abuse-/);
        expect(headers.Authorization).toBe("Bearer judge-jwt-token");
        return buildJsonResponse(
          {
            runId: completedRun.runId,
            status: "RUNNING",
            statusUrl: `/v1/judge/abuse-lab/runs/${completedRun.runId}`,
          },
          202,
        );
      }
      if (url === `${API_BASE_URL}/v1/judge/abuse-lab/runs/${completedRun.runId}`) {
        pollCount += 1;
        return buildJsonResponse(pollCount === 1 ? runningRun : completedRun, 200);
      }
      return buildJsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    mockUseAuth0State({
      isAuthenticated: true,
      getAccessTokenSilently: vi.fn().mockResolvedValue("judge-jwt-token"),
    });

    render(
      <RouterProvider>
        <SecurityPage />
      </RouterProvider>,
    );

    const runButton = await screen.findByRole("button", { name: "Run live checks" });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(screen.getByText("3 of 3 blocked as expected")).toBeTruthy();
    });

    expect(screen.getAllByText("State changed: none").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("Also covered in CI: SEC-003")).toBeTruthy();
    expect(screen.getByText("No direct CI equivalent")).toBeTruthy();
    expect(screen.getByText("Also covered in CI: TRANS-021")).toBeTruthy();
  });

  it("displays rate limit feedback when the server returns HTTP 429", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url === `${API_BASE_URL}/v1/judge/abuse-lab/runs` &&
        (!init?.method || init.method === "GET")
      ) {
        return buildJsonResponse({ isJudge: true, latestRun: null, runs: [] }, 200);
      }
      if (url === `${API_BASE_URL}/v1/judge/abuse-lab/runs` && init?.method === "POST") {
        return buildJsonResponse(
          {
            detail: "Rate limit exceeded: please wait 24s before running live checks again.",
          },
          429,
          { "Retry-After": "24" },
        );
      }
      return buildJsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    mockUseAuth0State({
      isAuthenticated: true,
      getAccessTokenSilently: vi.fn().mockResolvedValue("judge-jwt-token"),
    });

    render(
      <RouterProvider>
        <SecurityPage />
      </RouterProvider>,
    );

    const runButton = await screen.findByRole("button", { name: "Run live checks" });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(
        screen.getByText("Rate limit exceeded: please wait 24s before running live checks again."),
      ).toBeTruthy();
    });
  });

  it("exposes a Security navigation link to /security in Navbar", () => {
    render(
      <RouterProvider>
        <Navbar />
      </RouterProvider>,
    );

    const securityLink = screen.getByRole("link", { name: "Security" });
    expect(securityLink.getAttribute("href")).toBe("/security");
  });
});
