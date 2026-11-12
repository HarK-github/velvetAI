/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { IanaTimeZone, Rfc3339Timestamp, ScheduleResponse } from "@velvetai/contracts";
import { buildBryntumEventDomConfig, buildEventVisual } from "../lib/schedule-render.js";
import { apiClient, API_BASE_URL } from "../api-client.js";
import { RouterProvider } from "../router.js";

const mockAuthState: {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: Record<string, string> | undefined;
  loginWithRedirect: ReturnType<typeof vi.fn>;
  getAccessTokenSilently: ReturnType<typeof vi.fn>;
} = {
  isAuthenticated: false,
  isLoading: false,
  user: undefined,
  loginWithRedirect: vi.fn(),
  getAccessTokenSilently: vi.fn().mockResolvedValue("judge-jwt-token"),
};

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => mockAuthState,
}));

interface MockDomNode {
  className?: string;
  text?: string;
  children?: MockDomNode[];
}

interface MockSchedulerResource {
  id: string;
  name: string;
}

interface MockSchedulerEvent {
  id: string;
  name?: string;
  cls?: string;
  [key: string]: unknown;
}

interface MockSchedulerProps {
  readOnly?: boolean;
  timeZone?: string;
  viewPreset?: string;
  eventStore?: { syncDataOnLoad?: boolean };
  resources?: MockSchedulerResource[];
  events?: MockSchedulerEvent[];
  eventRenderer?: (arg: {
    eventRecord: { data: MockSchedulerEvent; get: (k: string) => unknown };
  }) => MockDomNode[] | null;
  onEventClick?: (arg: {
    eventRecord: { data: MockSchedulerEvent; get: (k: string) => unknown };
  }) => void;
  [key: string]: unknown;
}

const capturedSchedulerProps: MockSchedulerProps[] = [];

vi.mock("@bryntum/scheduler-react", () => ({
  BryntumScheduler: (props: MockSchedulerProps) => {
    capturedSchedulerProps.push(props);
    const resources = props.resources ?? [];
    const events = props.events ?? [];
    return (
      <div
        data-testid="mock-bryntum-scheduler"
        data-readonly={String(props.readOnly)}
        data-timezone={String(props.timeZone)}
        data-viewpreset={String(props.viewPreset)}
        data-sync={String(props.eventStore?.syncDataOnLoad)}
      >
        <div data-testid="scheduler-resources">
          {resources.map((r) => (
            <span key={r.id}>{r.name}</span>
          ))}
        </div>
        <div data-testid="scheduler-events">
          {events.map((evt) => {
            const domNodes = props.eventRenderer
              ? props.eventRenderer({ eventRecord: { data: evt, get: (k: string) => evt[k] } })
              : null;
            const renderNode = (node: MockDomNode | undefined, idx: number): React.ReactNode => {
              if (!node) return null;
              return (
                <div key={idx} className={node.className}>
                  {node.text ?? null}
                  {Array.isArray(node.children) ? node.children.map(renderNode) : null}
                </div>
              );
            };
            return (
              <button
                key={evt.id}
                type="button"
                className={evt.cls}
                data-testid={`sched-event-${evt.id}`}
                onClick={() =>
                  props.onEventClick?.({
                    eventRecord: { data: evt, get: (k: string) => evt[k] },
                  })
                }
              >
                {Array.isArray(domNodes) ? domNodes.map(renderNode) : evt.name}
              </button>
            );
          })}
        </div>
      </div>
    );
  },
}));

import { SchedulePage } from "../pages/SchedulePage.js";

function buildJsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 304 ? "Not Modified" : status === 200 ? "OK" : "Error",
    headers: new Headers({
      "content-type": "application/json",
      ...headers,
    }),
    json: async () => body,
  } as unknown as Response;
}

const NY_TZ = "America/New_York" as IanaTimeZone;
const ts = (iso: string): Rfc3339Timestamp => iso as Rfc3339Timestamp;

const SAMPLE_SCHEDULE: ScheduleResponse = {
  tenantTimeZone: NY_TZ,
  scheduleRevision: "rev_sched_1",
  generatedAt: ts("2026-11-12T15:00:00.000Z"),
  resources: [
    { id: "r1", name: "Aria (Stylist)", kind: "STAFF", timeZone: NY_TZ },
    { id: "r2", name: "Marco (Barber)", kind: "STAFF", timeZone: NY_TZ },
    { id: "r3", name: "Lena (Therapist)", kind: "ROOM", timeZone: NY_TZ },
    { id: "r4", name: "Studio A (Room)", kind: "ROOM", timeZone: NY_TZ },
  ],
  events: [
    {
      id: "fx_1",
      resourceId: "r2",
      startsAt: ts("2026-11-12T14:00:00.000Z"),
      endsAt: ts("2026-11-12T14:45:00.000Z"),
      display: { localStart: "9:00 AM", localEnd: "9:45 AM", timeZoneLabel: "EST" },
      serviceName: "Executive Haircut & Beard Sculpt",
      kind: "DEMO_FIXTURE",
      status: "CONFIRMED",
      paymentState: "PAID",
      buyerLabel: "Demo guest 07",
    },
    {
      id: "bk_paid",
      resourceId: "r1",
      startsAt: ts("2026-11-12T15:00:00.000Z"),
      endsAt: ts("2026-11-12T16:00:00.000Z"),
      display: { localStart: "10:00 AM", localEnd: "11:00 AM", timeZoneLabel: "EST" },
      serviceName: "Color & Gloss",
      kind: "BOOKING",
      status: "CONFIRMED",
      paymentState: "PAID",
      buyerLabel: "Guest A.K.",
      preparedBy: "ASK_AI",
    },
  ],
  resourceTimeRanges: [],
};

describe("WP 05: Bryntum SchedulePage & Status Renderers", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    capturedSchedulerProps.length = 0;
    apiClient.setAuthToken("");
    apiClient.resetActionKeys();
    mockAuthState.isAuthenticated = false;
    mockAuthState.isLoading = false;
    mockAuthState.user = undefined;
    mockAuthState.loginWithRedirect = vi.fn();
    mockAuthState.getAccessTokenSilently = vi.fn().mockResolvedValue("judge-jwt-token");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    globalThis.fetch = originalFetch;
    apiClient.setAuthToken("");
  });

  it("renders distinct icon, text, and CSS classes for every booking/hold/fixture status without raw HTML", () => {
    const now = Date.UTC(2026, 10, 12, 15, 0, 0);
    const holdExp = new Date(now + 252_000).toISOString();

    const hold = buildEventVisual(
      {
        kind: "HOLD",
        status: "HELD",
        paymentState: "NONE",
        serviceName: "Haircut <script>alert(1)</script>",
        buyerLabel: "Guest R.T.",
        holdExpiresAt: holdExp,
        preparedBy: "ASK_AI",
      },
      now,
    );
    expect(hold.statusLine).toBe("Hold · 4:12 left");
    expect(hold.cls).toContain("velvet-evt--hold");
    expect(hold.tags).toContain("via AI");

    const dom = buildBryntumEventDomConfig(hold);
    expect(JSON.stringify(dom)).not.toContain('html"');

    const awaiting = buildEventVisual(
      {
        kind: "BOOKING",
        status: "REQUIRES_PAYER_ACTION",
        paymentState: "AWAITING_PAYER",
        serviceName: "Studio",
        buyerLabel: "Guest A.",
      },
      now,
    );
    expect(awaiting.statusLine).toBe("Awaiting deposit");
    expect(awaiting.cls).toContain("velvet-evt--awaiting-payer");

    const verifying = buildEventVisual(
      {
        kind: "BOOKING",
        status: "CAPTURE_UNCERTAIN",
        paymentState: "VERIFYING",
        serviceName: "Studio",
        buyerLabel: "Guest B.",
      },
      now,
    );
    expect(verifying.statusLine).toBe("Verifying payment");
    expect(verifying.cls).toContain("velvet-evt--verifying");

    const paid = buildEventVisual(
      {
        kind: "BOOKING",
        status: "CONFIRMED",
        paymentState: "PAID",
        serviceName: "Studio",
        buyerLabel: "Guest C.",
        preparedBy: "MCP",
      },
      now,
    );
    expect(paid.statusLine).toBe("Confirmed · Deposit paid");
    expect(paid.tags).toContain("via MCP");

    const checkedIn = buildEventVisual(
      {
        kind: "BOOKING",
        status: "CHECKED_IN",
        paymentState: "PAID",
        serviceName: "Studio",
        buyerLabel: "Guest D.",
      },
      now,
    );
    expect(checkedIn.statusLine).toBe("Checked in");

    const completed = buildEventVisual(
      {
        kind: "BOOKING",
        status: "COMPLETED",
        paymentState: "PAID",
        serviceName: "Studio",
        buyerLabel: "Guest E.",
      },
      now,
    );
    expect(completed.statusLine).toBe("Completed");
    expect(completed.cls).toContain("velvet-evt--completed");

    const noShow = buildEventVisual(
      {
        kind: "BOOKING",
        status: "NO_SHOW",
        paymentState: "PAID",
        serviceName: "Studio",
        buyerLabel: "Guest F.",
      },
      now,
    );
    expect(noShow.statusLine).toBe("No-show");
    expect(noShow.cls).toContain("velvet-evt--no-show");

    const cancelled = buildEventVisual(
      {
        kind: "BOOKING",
        status: "CANCELLED",
        paymentState: "NONE",
        serviceName: "Studio",
        buyerLabel: "Guest G.",
      },
      now,
    );
    expect(cancelled.statusLine).toBe("Cancelled");
    expect(cancelled.cls).toContain("velvet-evt--cancelled");

    const fixture = buildEventVisual(
      {
        kind: "DEMO_FIXTURE",
        status: "CONFIRMED",
        paymentState: "PAID",
        serviceName: "Deep Tissue",
        buyerLabel: "Demo guest 03",
      },
      now,
    );
    expect(fixture.statusLine).toContain("Demo booking");
    expect(fixture.cls).toContain("velvet-evt--demo");
  });

  it("renders signed-out public read-only Bryntum schedule, legend, merchant TZ, and hides race test", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`${API_BASE_URL}/v1/merchant/schedule`)) {
        expect(url).toContain("public=true");
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
        return buildJsonResponse(SAMPLE_SCHEDULE, 200, { ETag: '"rev_sched_1"' });
      }
      return buildJsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RouterProvider>
        <SchedulePage />
      </RouterProvider>,
    );

    expect(
      await screen.findByText("Demo schedule (read-only). Sign in to book or run the race test."),
    ).toBeTruthy();

    const sched = await screen.findByTestId("mock-bryntum-scheduler");
    expect(sched.getAttribute("data-readonly")).toBe("true");
    expect(sched.getAttribute("data-timezone")).toBe("America/New_York");
    expect(sched.getAttribute("data-viewpreset")).toBe("hourAndDay");
    expect(sched.getAttribute("data-sync")).toBe("true");

    expect(screen.getByText("Aria (Stylist)")).toBeTruthy();
    expect(screen.getByText("Marco (Barber)")).toBeTruthy();
    expect(screen.getByText("Lena (Therapist)")).toBeTruthy();
    expect(screen.getByText("Studio A (Room)")).toBeTruthy();

    expect(screen.getByRole("list", { name: "Schedule legend" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Race test/i })).toBeNull();

    // Clicking event opens detail card
    fireEvent.click(screen.getByTestId("sched-event-bk_paid"));
    expect(await screen.findByTestId("selected-event-panel")).toBeTruthy();
    expect(screen.getByText(/10:00 AM – 11:00 AM EST/)).toBeTruthy();
  });

  it("polls every 5 s with If-None-Match, respects visibilityState, and announces new bookings via aria-live", async () => {
    vi.useFakeTimers();

    const updatedSchedule: ScheduleResponse = {
      ...SAMPLE_SCHEDULE,
      scheduleRevision: "rev_sched_2",
      events: [
        ...SAMPLE_SCHEDULE.events,
        {
          id: "bk_live_new",
          resourceId: "r2",
          startsAt: ts("2026-11-12T19:00:00.000Z"),
          endsAt: ts("2026-11-12T19:45:00.000Z"),
          display: { localStart: "2:00 PM", localEnd: "2:45 PM", timeZoneLabel: "EST" },
          serviceName: "Executive Haircut & Beard Sculpt",
          kind: "BOOKING",
          status: "CONFIRMED",
          paymentState: "PAID",
          buyerLabel: "Guest L.N.",
        },
      ],
    };

    let pollStep = 0;
    const seenIfNoneMatch: Array<string | undefined> = [];

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`${API_BASE_URL}/v1/merchant/schedule`)) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seenIfNoneMatch.push(headers["If-None-Match"]);
        pollStep += 1;
        if (pollStep === 1) {
          return buildJsonResponse(SAMPLE_SCHEDULE, 200, { ETag: '"rev_sched_1"' });
        }
        if (pollStep === 2) {
          return buildJsonResponse(null, 304, { ETag: '"rev_sched_1"' });
        }
        return buildJsonResponse(updatedSchedule, 200, { ETag: '"rev_sched_2"' });
      }
      return buildJsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RouterProvider>
        <SchedulePage />
      </RouterProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("mock-bryntum-scheduler")).toBeTruthy();

    // Advance 5s -> poll #2 sends If-None-Match and receives 304
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(seenIfNoneMatch[1]).toBe('"rev_sched_1"');

    // Hide tab for 5s -> polling pauses
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(pollStep).toBe(2);

    // Show tab & advance 5s -> poll #3 returns updated schedule and announces new booking
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getByTestId("schedule-aria-live").textContent).toContain(
      "New booking: Executive Haircut & Beard Sculpt, 2:00 PM EST, Marco (Barber).",
    );
  });

  it("lets a signed-in judge run POST /v1/judge/race-test with Idempotency-Key and flashes winning hold", async () => {
    mockAuthState.isAuthenticated = true;
    mockAuthState.user = { sub: "auth0|judge-user" };

    const raceStart = new Date(Date.now() + 3600_000 * 3);
    const raceEnd = new Date(raceStart.getTime() + 45 * 60_000);

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`${API_BASE_URL}/v1/merchant/schedule`)) {
        return buildJsonResponse(SAMPLE_SCHEDULE, 200, { ETag: '"rev_sched_1"' });
      }
      if (url === `${API_BASE_URL}/v1/judge/abuse-lab/runs`) {
        return buildJsonResponse({ isJudge: true, latestRun: null, runs: [] }, 200);
      }
      if (url === `${API_BASE_URL}/v1/judge/race-test` && init?.method === "POST") {
        const key = new Headers(init.headers).get("idempotency-key");
        expect(key).toMatch(/^race-test-/);
        return buildJsonResponse(
          {
            attempts: 20,
            succeeded: 1,
            conflicts: 19,
            winnerHoldId: "hold_winner_123",
            resourceId: "r1",
            serviceId: "svc_1",
            serviceName: "Executive Haircut & Beard Sculpt",
            startsAt: raceStart.toISOString(),
            endsAt: raceEnd.toISOString(),
            display: { localStart: "1:00 PM", localEnd: "1:45 PM", timeZoneLabel: "EST" },
            durationMs: 42,
          },
          200,
        );
      }
      return buildJsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RouterProvider>
        <SchedulePage />
      </RouterProvider>,
    );

    const raceBtn = await screen.findByRole("button", {
      name: /Race test \(20 simultaneous holds\)/i,
    });
    fireEvent.click(raceBtn);

    const resultBanner = await screen.findByTestId("race-test-result");
    expect(resultBanner.textContent).toContain(
      "20 simultaneous attempts → 1 hold, 19 rejected by the database",
    );

    // Flashed winning hold renders on scheduler temporarily
    const flashEl = await screen.findByTestId("sched-event-hold_winner_123");
    expect(flashEl.className).toContain("velvet-evt--race-flash");
  });

  it("ticks hold countdown every second, removes expired holds locally, and shows retry pill on poll failure", async () => {
    vi.useFakeTimers();
    const baseNow = new Date("2026-11-12T15:00:00.000Z");
    vi.setSystemTime(baseNow);

    const scheduleWithShortHold: ScheduleResponse = {
      ...SAMPLE_SCHEDULE,
      events: [
        ...SAMPLE_SCHEDULE.events,
        {
          id: "hold_short",
          resourceId: "r2",
          startsAt: ts("2026-11-12T17:00:00.000Z"),
          endsAt: ts("2026-11-12T17:45:00.000Z"),
          display: { localStart: "12:00 PM", localEnd: "12:45 PM", timeZoneLabel: "EST" },
          serviceName: "Executive Haircut & Beard Sculpt",
          kind: "HOLD",
          status: "HELD",
          paymentState: "NONE",
          holdExpiresAt: ts(new Date(baseNow.getTime() + 3000).toISOString()),
          buyerLabel: "Guest S.H.",
        },
      ],
    };

    let pollCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith(`${API_BASE_URL}/v1/merchant/schedule`)) {
        pollCount += 1;
        if (pollCount === 1) {
          return buildJsonResponse(scheduleWithShortHold, 200, { ETag: '"rev_short"' });
        }
        return buildJsonResponse({ title: "Temporary Outage", status: 503 }, 503);
      }
      return buildJsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RouterProvider>
        <SchedulePage />
      </RouterProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("sched-event-hold_short").textContent).toContain("Hold · 0:03 left");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId("sched-event-hold_short").textContent).toContain("Hold · 0:02 left");

    // Reaching expiry removes hold locally & polling failure at 5s shows retry pill
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByTestId("sched-event-hold_short")).toBeNull();
    expect(screen.getByText("Live updates paused — retrying")).toBeTruthy();
  });
});
