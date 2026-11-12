/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BookingSimulatorSection } from "../components/BookingSimulatorSection.js";
import { apiClient } from "../api-client.js";

describe("BookingSimulatorSection — Database Truth & Fallback Elimination (C4)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    apiClient.setAuthToken("");
    apiClient.resetActionKeys();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    apiClient.setAuthToken("");
    apiClient.resetActionKeys();
    vi.unstubAllEnvs();
  });

  it("renders error state with Retry button and does NOT render mock cards when catalog API fails", async () => {
    // Force offline demo mode to false (default production/live behavior)
    vi.stubEnv("VITE_ENABLE_OFFLINE_DEMO", "false");

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network connection refused"));

    render(<BookingSimulatorSection />);

    // Expect loading state first or wait for error state
    const alert = await screen.findByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain("Unable to Load Live Booking Catalog");
    expect(alert.textContent).toContain("Network connection refused");

    // Verify Retry button is present
    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeTruthy();

    // Verify NO mock cards are rendered
    expect(screen.queryByText("Executive Haircut & Beard Sculpt")).toBeNull();
    expect(screen.queryByText("Deep Tissue & Mobility Session")).toBeNull();
    expect(screen.queryByText("Private Acoustic Studio Block")).toBeNull();
  });

  it("recovers and renders live catalog services when Retry is clicked", async () => {
    vi.stubEnv("VITE_ENABLE_OFFLINE_DEMO", "false");
    apiClient.setAuthToken("test-simulator-token");

    let callCount = 0;
    let quoteHeaders: Headers | undefined;
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/v1/services")) {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("503 Service Unavailable"));
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              services: [
                {
                  id: "01932b10-live-0001-7000-8000-000000000001",
                  versions: [
                    {
                      name: "Authoritative Live Salon Service",
                      durationMinutes: 50,
                      priceMinor: 9500,
                      baseDepositMinor: 2500,
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
                  startsAt: "2026-10-24T14:00:00.000Z",
                  localStartsAt: "14:00",
                  depositPreview: { minor: 2500, currency: "USD" },
                  price: { minor: 9500, currency: "USD" },
                },
              ],
            }),
        });
      }
      if (url.includes("/v1/booking-quotes")) {
        quoteHeaders = new Headers(init?.headers);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              quoteId: "quote-test-123",
              total: { minor: 9500, currency: "USD" },
              deposit: { minor: 2500, currency: "USD" },
              cancellationPolicy: { summary: "Standard cancellation policy" },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<BookingSimulatorSection />);

    // Initially fails
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("503 Service Unavailable");

    // Click retry
    const retryBtn = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retryBtn);

    // Live service appears
    const items = await screen.findAllByText("Authoritative Live Salon Service");
    expect(items.length).toBeGreaterThan(0);

    // Wait for slot and quote to settle
    expect(await screen.findByText("14:00")).toBeTruthy();
    expect(await screen.findByText("$25.00")).toBeTruthy();

    // Error alert is cleared and quote sent Idempotency-Key
    expect(screen.queryByRole("alert")).toBeNull();
    expect(quoteHeaders?.get("idempotency-key")).toMatch(/^quote-/);
  });

  it("renders visible offline demo banner and disables hold when VITE_ENABLE_OFFLINE_DEMO is true", async () => {
    vi.stubEnv("VITE_ENABLE_OFFLINE_DEMO", "true");

    // API fails
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Offline development mode"));

    render(<BookingSimulatorSection />);

    // Should display offline demo banner
    const demoBanner = await screen.findByTestId("offline-demo-banner");
    expect(demoBanner).toBeTruthy();
    expect(demoBanner.textContent).toContain("Offline demo data — not bookable");

    // In demo mode, fallback cards are shown for dev exploration
    const matches = await screen.findAllByText("Executive Haircut & Beard Sculpt");
    expect(matches.length).toBeGreaterThan(0);

    // The hold button should be disabled with demo notice
    const holdButton = screen.getByRole("button", { name: /Hold Disabled \(Demo Mode\)/i });
    expect(holdButton).toBeTruthy();
    expect(holdButton.hasAttribute("disabled")).toBe(true);

    // Wait for slot and quote to settle in demo mode
    expect(await screen.findByText("09:30")).toBeTruthy();
    expect(await screen.findByText("$20.00")).toBeTruthy();
  });
});
