import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isWebMcpSupported, registerWebMcpTools, getWebMcpStatus } from "../lib/webmcp.js";
import { VelvetApiClient } from "../api-client.js";

describe("W6: WebMCP Progressive Enhancement via document.modelContext", () => {
  let mockApiClient: VelvetApiClient;
  let mockModelContext: {
    registerTool: ReturnType<typeof vi.fn>;
    unregisterTool: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    (globalThis as any).document = {};

    mockApiClient = {
      getServices: vi.fn().mockResolvedValue({
        services: [
          {
            id: "01932b10-0001-7000-8000-000000000001",
            name: "Royal Shave",
            versions: [
              {
                id: "01932b10-0004-7000-8000-000000000001",
                name: "Royal Shave",
                durationMinutes: 45,
                priceMinor: "8500",
                baseDepositMinor: "2500",
                currency: "USD",
              },
            ],
          },
        ],
        total: 1,
      }),
      getAvailability: vi.fn().mockResolvedValue({
        slots: [{ startsAt: "2026-11-01T14:00:00Z", endsAt: "2026-11-01T14:45:00Z" }],
      }),
      createBookingQuote: vi.fn().mockResolvedValue({
        quoteId: "quote-123",
        total: { valueMinor: "8500", currency: "USD" },
      }),
      prepareBooking: vi.fn().mockResolvedValue({
        bookingId: "booking-abc",
        status: "HELD",
        holdExpiresAt: "2026-11-01T14:15:00Z",
        version: 1,
        approvalLocator: "/v1/booking-approvals/loc_abc123",
        requiresHumanConfirmation: true,
      }),
      commitBooking: vi.fn().mockResolvedValue({
        bookingId: "booking-abc",
        status: "COMMITTING",
        version: 2,
      }),
      getBooking: vi.fn().mockResolvedValue({
        id: "booking-abc",
        status: "HELD",
        note: "Sensitive customer note",
      }),
    } as unknown as VelvetApiClient;

    mockModelContext = {
      registerTool: vi.fn().mockResolvedValue(undefined),
      unregisterTool: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    delete (globalThis as any).document;
    try {
      delete (navigator as any).modelContext;
    } catch {
      // ignore
    }
  });

  it("strictly detects document.modelContext and ignores navigator.modelContext", () => {
    // 1. When neither exists: false
    expect(isWebMcpSupported()).toBe(false);

    // 2. Strict Invariant: navigator.modelContext must NEVER be checked or used
    (navigator as any).modelContext = mockModelContext;
    expect(isWebMcpSupported()).toBe(false);

    // 3. Only document.modelContext enables WebMCP
    (document as any).modelContext = mockModelContext;
    expect(isWebMcpSupported()).toBe(true);
  });

  it("registers all 6 tools with correct advisory annotations and same-origin enforcement", async () => {
    (document as any).modelContext = mockModelContext;

    const cleanup = await registerWebMcpTools(mockApiClient);

    expect(mockModelContext.registerTool).toHaveBeenCalledTimes(6);

    const registeredTools = mockModelContext.registerTool.mock.calls.map((call) => call[0]);
    const toolNames = registeredTools.map((t) => t.name);

    expect(toolNames).toContain("list_services.v1");
    expect(toolNames).toContain("find_available_slots.v1");
    expect(toolNames).toContain("quote_booking.v1");
    expect(toolNames).toContain("prepare_booking.v1");
    expect(toolNames).toContain("get_booking.v1");
    expect(toolNames).toContain("commit_booking.v1");

    // Verify Advisory Annotations per W6 Specification
    const listServices = registeredTools.find((t) => t.name === "list_services.v1");
    expect(listServices.annotations.readOnlyHint).toBe(true);

    const findSlots = registeredTools.find((t) => t.name === "find_available_slots.v1");
    expect(findSlots.annotations.readOnlyHint).toBe(true);

    const prepareBooking = registeredTools.find((t) => t.name === "prepare_booking.v1");
    expect(prepareBooking.annotations.readOnlyHint).toBe(false);
    expect(prepareBooking.annotations.consequentialHint).toBe(true);

    const commitBooking = registeredTools.find((t) => t.name === "commit_booking.v1");
    expect(commitBooking.annotations.readOnlyHint).toBe(false);
    expect(commitBooking.annotations.consequentialHint).toBe(true);

    // Verify Default Same-Origin Policy: exposedTo must NOT be configured
    for (const call of mockModelContext.registerTool.mock.calls) {
      const options = call[1];
      expect(options?.exposedTo).toBeUndefined();
    }

    // Diagnostics status returns registered tools
    const status = getWebMcpStatus();
    expect(status.supported).toBe(true);
    expect(status.registeredCount).toBe(6);

    // Calling cleanup unregisters / resets status
    cleanup();
    expect(getWebMcpStatus().registeredCount).toBe(0);
  });

  it("prepare_booking.v1 returns approval locator and never exposes confirmation token", async () => {
    (document as any).modelContext = mockModelContext;
    await registerWebMcpTools(mockApiClient);

    const registeredTools = mockModelContext.registerTool.mock.calls.map((call) => call[0]);
    const prepareTool = registeredTools.find((t) => t.name === "prepare_booking.v1");

    const result = await prepareTool.execute({
      serviceId: "01932b10-0001-7000-8000-000000000001",
      locationId: "01932b10-0002-7000-8000-000000000001",
      startsAt: "2026-11-01T14:00:00Z",
      timeZone: "America/New_York",
      customer: { email: "buyer@example.com" },
    });

    expect(result.status).toBe("HELD");
    expect(result.approvalLocator).toBe("/v1/booking-approvals/loc_abc123");
    expect(result.requiresHumanConfirmation).toBe(true);

    // CRITICAL SECURITY ASSERTION: Never expose raw confirmation tokens
    expect(result).not.toHaveProperty("confirmation");
    expect(result).not.toHaveProperty("confirmationToken");
  });

  it("get_booking.v1 excludes customer notes from tool output", async () => {
    (document as any).modelContext = mockModelContext;
    await registerWebMcpTools(mockApiClient);

    const registeredTools = mockModelContext.registerTool.mock.calls.map((call) => call[0]);
    const getBookingTool = registeredTools.find((t) => t.name === "get_booking.v1");

    const result = await getBookingTool.execute({ bookingId: "booking-abc" });
    expect(result.id).toBe("booking-abc");
    expect(result).not.toHaveProperty("note");
    expect(result).not.toHaveProperty("customerNote");
  });
});
