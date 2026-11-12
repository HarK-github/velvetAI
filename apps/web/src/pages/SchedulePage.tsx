import { useState, useEffect, useCallback, useMemo, useRef, type FC } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { BryntumScheduler } from "@bryntum/scheduler-react";
import type {
  RaceTestResponse,
  Rfc3339Timestamp,
  ScheduleEvent,
  ScheduleResponse,
} from "@velvetai/contracts";
import "../styles/bryntum-overrides.css";
import { apiClient, ApiError, API_BASE_URL } from "../api-client.js";
import { isAuth0Configured, isMockAuthEnabled } from "../lib/auth-config.js";
import { Link } from "../router.js";
import { formatUserLocalWindow } from "../lib/timezone.js";
import {
  AccountProvisioningNotice,
  isUserNotProvisionedError,
} from "../components/AccountProvisioningNotice.js";
import {
  addDaysToDateKey,
  buildBryntumEventDomConfig,
  buildEventVisual,
  buildNewBookingAnnouncement,
  formatMerchantDayLabel,
  getDateKeyInZone,
  getUtcForZoneWallClock,
  pickOpenRaceSlot,
  SCHEDULE_LEGEND_ITEMS,
} from "../lib/schedule-render.js";

const DEFAULT_MERCHANT_TZ = "America/New_York";
const POLL_INTERVAL_MS = 5_000;
const RACE_FLASH_DURATION_MS = 3_000;

interface FlashedHold {
  id: string;
  resourceId: string;
  startsAt: Rfc3339Timestamp;
  endsAt: Rfc3339Timestamp;
  serviceName: string;
  localStart: string;
  localEnd: string;
  timeZoneLabel: string;
  holdExpiresAt: Rfc3339Timestamp;
}

function readEventField<T>(eventRecord: unknown, field: string): T | undefined {
  if (!eventRecord || typeof eventRecord !== "object") return undefined;
  const rec = eventRecord as { get?: (k: string) => unknown; data?: Record<string, unknown> };
  if (typeof rec.get === "function") {
    const val = rec.get(field);
    if (val !== undefined) return val as T;
  }
  if (rec.data && field in rec.data) {
    return rec.data[field] as T;
  }
  return (eventRecord as Record<string, unknown>)[field] as T | undefined;
}

export const SchedulePage: FC = () => {
  const {
    isAuthenticated,
    isLoading: authLoading,
    loginWithRedirect,
    getAccessTokenSilently,
  } = useAuth0();

  const [merchantTz, setMerchantTz] = useState<string>(DEFAULT_MERCHANT_TZ);
  const [selectedDateKey, setSelectedDateKey] = useState<string>(() =>
    getDateKeyInZone(new Date(), DEFAULT_MERCHANT_TZ),
  );
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unprovisionedError, setUnprovisionedError] = useState<boolean>(false);
  const [pollWarning, setPollWarning] = useState<boolean>(false);
  const [isPublicDemoMode, setIsPublicDemoMode] = useState<boolean>(true);
  const [isJudge, setIsJudge] = useState<boolean>(false);
  const [selectedEvent, setSelectedEvent] = useState<ScheduleEvent | null>(null);
  const [announcement, setAnnouncement] = useState<string>("");

  const [lastUpdatedAtMs, setLastUpdatedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [isRunningRace, setIsRunningRace] = useState<boolean>(false);
  const [raceResult, setRaceResult] = useState<RaceTestResponse | null>(null);
  const [raceError, setRaceError] = useState<string | null>(null);
  const [flashedHold, setFlashedHold] = useState<FlashedHold | null>(null);

  const etagRef = useRef<string | null>(null);
  const prevEventIdsRef = useRef<Set<string> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef<boolean>(true);

  const audience =
    (typeof import.meta.env !== "undefined"
      ? (import.meta.env.VITE_AUTH0_AUDIENCE as string)
      : "") || "https://velvetai.example/api";

  const tokenScope =
    "openid profile email booking:read booking:quote booking:prepare booking:commit booking:cancel";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  // Resolve Auth0 bearer token for authenticated requests
  const resolveAccessToken = useCallback(async (): Promise<string | undefined> => {
    const existing = apiClient.getAuthToken();
    if (existing) {
      return existing;
    }
    if (isAuthenticated) {
      try {
        const acquired = await getAccessTokenSilently({
          authorizationParams: {
            audience,
            scope: tokenScope,
          },
        });
        if (acquired) {
          apiClient.setAuthToken(acquired);
          return acquired;
        }
      } catch {
        return undefined;
      }
    }
    if (!isAuth0Configured() && isMockAuthEnabled()) {
      return "mock";
    }
    return undefined;
  }, [audience, getAccessTokenSilently, isAuthenticated]);

  // Check whether signed-in principal holds judge permissions (for Race Test button)
  useEffect(() => {
    let cancelled = false;
    async function probeJudgeAccess() {
      if (authLoading) return;
      if (!isAuthenticated && !apiClient.getAuthToken()) {
        if (!cancelled) setIsJudge(false);
        return;
      }
      const token = await resolveAccessToken();
      if (!token || token === "mock" || !API_BASE_URL) {
        if (!cancelled) setIsJudge(false);
        return;
      }
      try {
        const res = await fetch(`${API_BASE_URL}/v1/judge/abuse-lab/runs`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!cancelled && res.ok) {
          const data = (await res.json()) as { isJudge?: boolean };
          setIsJudge(Boolean(data.isJudge));
          return;
        }
      } catch {
        // Ignore; judge controls remain hidden
      }
      if (!cancelled) setIsJudge(false);
    }
    void probeJudgeAccess();
    return () => {
      cancelled = true;
    };
  }, [authLoading, isAuthenticated, resolveAccessToken]);

  const queryRange = useMemo(() => {
    const startUtc = getUtcForZoneWallClock(selectedDateKey, "00:00:00", merchantTz);
    const nextKey = addDaysToDateKey(selectedDateKey, 1);
    const endUtc = getUtcForZoneWallClock(nextKey, "00:00:00", merchantTz);
    const viewStart = getUtcForZoneWallClock(selectedDateKey, "08:00:00", merchantTz);
    const viewEnd = getUtcForZoneWallClock(selectedDateKey, "21:00:00", merchantTz);
    return {
      fromIso: startUtc.toISOString(),
      toIso: endUtc.toISOString(),
      viewStart,
      viewEnd,
    };
  }, [selectedDateKey, merchantTz]);

  const applySchedulePayload = useCallback((nextData: ScheduleResponse) => {
    if (prevEventIdsRef.current) {
      const msg = buildNewBookingAnnouncement(
        prevEventIdsRef.current,
        nextData.events,
        nextData.resources,
      );
      if (msg) {
        setAnnouncement(msg);
      }
    }
    prevEventIdsRef.current = new Set(nextData.events.map((e) => e.id));
    setMerchantTz(nextData.tenantTimeZone);
    setSchedule(nextData);
    setLastUpdatedAtMs(Date.now());
  }, []);

  const fetchSchedule = useCallback(
    async (opts?: { isBackgroundPoll?: boolean }) => {
      if (authLoading && !opts?.isBackgroundPoll) return;
      if (!opts?.isBackgroundPoll) {
        setLoadError(null);
      }

      const token = await resolveAccessToken();
      const usePublicInit = !token;

      try {
        const result = await apiClient.getMerchantSchedule({
          from: queryRange.fromIso,
          to: queryRange.toIso,
          etag: opts?.isBackgroundPoll ? etagRef.current : null,
          publicMode: usePublicInit,
        });

        if (!mountedRef.current) return;
        setUnprovisionedError(false);
        setPollWarning(false);
        setLoadError(null);
        setIsPublicDemoMode(usePublicInit);

        if (result.kind === "ok") {
          etagRef.current = result.etag;
          applySchedulePayload(result.data);
        } else {
          setLastUpdatedAtMs(Date.now());
        }
      } catch (err: unknown) {
        if (!mountedRef.current) return;

        if (isUserNotProvisionedError(err)) {
          setUnprovisionedError(true);
          setPollWarning(false);
          setLoading(false);
          return;
        }

        // Signed-in BUYER lacks merchant:schedule -> fall back cleanly to public demo view
        if (
          !usePublicInit &&
          err instanceof ApiError &&
          err.status === 403 &&
          err.code === "insufficient_scope"
        ) {
          try {
            const pubRes = await apiClient.getMerchantSchedule({
              from: queryRange.fromIso,
              to: queryRange.toIso,
              etag: opts?.isBackgroundPoll ? etagRef.current : null,
              publicMode: true,
            });
            if (!mountedRef.current) return;
            setUnprovisionedError(false);
            setPollWarning(false);
            setLoadError(null);
            setIsPublicDemoMode(true);
            if (pubRes.kind === "ok") {
              etagRef.current = pubRes.etag;
              applySchedulePayload(pubRes.data);
            } else {
              setLastUpdatedAtMs(Date.now());
            }
            return;
          } catch {
            // Fall through to error notice below
          }
        }

        if (opts?.isBackgroundPoll) {
          setPollWarning(true);
        } else {
          setLoadError(err instanceof Error ? err.message : "Failed to load schedule.");
        }
      } finally {
        if (mountedRef.current && !opts?.isBackgroundPoll) {
          setLoading(false);
        }
      }
    },
    [authLoading, resolveAccessToken, queryRange.fromIso, queryRange.toIso, applySchedulePayload],
  );

  // Initial & date-change fetch
  useEffect(() => {
    etagRef.current = null;
    prevEventIdsRef.current = null;
    setLoading(true);
    void fetchSchedule();
  }, [fetchSchedule]);

  // 5s background polling paused when tab is hidden
  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void fetchSchedule({ isBackgroundPoll: true });
    };

    const pollId = setInterval(tick, POLL_INTERVAL_MS);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchSchedule({ isBackgroundPoll: true });
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      clearInterval(pollId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [fetchSchedule]);

  // 1s ticker for "Updated N s ago" + live hold countdowns
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const handleSignIn = async () => {
    if (!isAuth0Configured()) return;
    await loginWithRedirect({
      authorizationParams: { audience },
      appState: { returnTo: "/schedule" },
    });
  };

  const handleRunRaceTest = async () => {
    setIsRunningRace(true);
    setRaceError(null);
    setRaceResult(null);

    const events = schedule?.events ?? [];
    const resources = schedule?.resources ?? [];
    const target = pickOpenRaceSlot({
      events,
      resources,
      dateKey: selectedDateKey,
      timeZone: merchantTz,
      nowMs: Date.now(),
    });

    try {
      const outcome = await apiClient.runRaceTest({
        parallel: 20,
        ...(target.resourceId ? { resourceId: target.resourceId } : {}),
        startsAt: target.startsAt,
      });
      if (!mountedRef.current) return;
      setRaceResult(outcome);
      setAnnouncement(
        `${outcome.attempts} simultaneous attempts completed: ${outcome.succeeded} hold won, ${outcome.conflicts} rejected by the database.`,
      );

      // Jump day to the target slot day if needed & flash winning hold briefly before release settles
      const slotDayKey = getDateKeyInZone(new Date(outcome.startsAt), merchantTz);
      if (slotDayKey !== selectedDateKey) {
        setSelectedDateKey(slotDayKey);
      }

      if (outcome.winnerHoldId) {
        if (flashTimerRef.current) {
          clearTimeout(flashTimerRef.current);
        }
        setFlashedHold({
          id: outcome.winnerHoldId,
          resourceId: outcome.resourceId,
          startsAt: outcome.startsAt,
          endsAt: outcome.endsAt,
          serviceName: outcome.serviceName,
          localStart: outcome.display.localStart,
          localEnd: outcome.display.localEnd,
          timeZoneLabel: outcome.display.timeZoneLabel,
          holdExpiresAt: new Date(Date.now() + 300_000).toISOString() as Rfc3339Timestamp,
        });
        flashTimerRef.current = setTimeout(() => {
          if (mountedRef.current) {
            setFlashedHold(null);
          }
        }, RACE_FLASH_DURATION_MS);
      }

      void fetchSchedule({ isBackgroundPoll: true });
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if (isUserNotProvisionedError(err)) {
        setUnprovisionedError(true);
      } else {
        setRaceError(err instanceof Error ? err.message : "Race test failed.");
      }
    } finally {
      if (mountedRef.current) {
        setIsRunningRace(false);
      }
    }
  };

  // Build Bryntum resource & event records cleanly without recreating scheduler
  const bryntumResources = useMemo(
    () =>
      (schedule?.resources ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        timeZone: r.timeZone,
      })),
    [schedule?.resources],
  );

  const hasActiveHold = Boolean(flashedHold || schedule?.events.some((e) => e.kind === "HOLD"));
  const holdTickSec = hasActiveHold ? Math.floor(nowMs / 1000) : 0;

  const visibleEvents = useMemo(() => {
    const tickNowMs = holdTickSec * 1000;
    const base = schedule?.events ?? [];
    const active = base.filter((evt) => {
      if (evt.kind !== "HOLD" || !evt.holdExpiresAt) return true;
      const visual = buildEventVisual(evt, tickNowMs);
      return !visual.expiredLocally;
    });

    if (flashedHold && !active.some((e) => e.id === flashedHold.id)) {
      active.push({
        id: flashedHold.id,
        resourceId: flashedHold.resourceId,
        startsAt: flashedHold.startsAt,
        endsAt: flashedHold.endsAt,
        display: {
          localStart: flashedHold.localStart,
          localEnd: flashedHold.localEnd,
          timeZoneLabel: flashedHold.timeZoneLabel,
        },
        serviceName: flashedHold.serviceName,
        kind: "HOLD",
        status: "HELD",
        paymentState: "NONE",
        holdExpiresAt: flashedHold.holdExpiresAt,
        buyerLabel: "Race Winner",
      });
    }

    return active;
  }, [schedule?.events, flashedHold, holdTickSec]);

  const bryntumEvents = useMemo(() => {
    const tickNowMs = holdTickSec * 1000;
    return visibleEvents.map((evt) => {
      const isRaceFlash = Boolean(flashedHold && evt.id === flashedHold.id);
      const visual = buildEventVisual({ ...evt, isRaceFlash }, tickNowMs);
      return {
        id: evt.id,
        resourceId: evt.resourceId,
        startDate: evt.startsAt,
        endDate: evt.endsAt,
        name: `${visual.statusLine} — ${evt.serviceName}`,
        cls: visual.cls,
        kind: evt.kind,
        status: evt.status,
        paymentState: evt.paymentState,
        serviceName: evt.serviceName,
        buyerLabel: evt.buyerLabel,
        holdExpiresAt: evt.holdExpiresAt,
        preparedBy: evt.preparedBy,
        noShowRisk: evt.noShowRisk,
        isRaceFlash,
        visual,
      };
    });
  }, [visibleEvents, flashedHold, holdTickSec]);

  const schedulerColumns = useMemo(() => [{ text: "Provider", field: "name", width: 210 }], []);
  const eventStoreConfig = useMemo(() => ({ syncDataOnLoad: true }), []);
  const resourceStoreConfig = useMemo(() => ({ syncDataOnLoad: true }), []);

  const eventRenderer = useCallback(
    ({ eventRecord }: { eventRecord: unknown }) => {
      const prebuilt = readEventField<ReturnType<typeof buildEventVisual>>(eventRecord, "visual");
      if (prebuilt) {
        return buildBryntumEventDomConfig(prebuilt);
      }
      const visual = buildEventVisual(
        {
          kind: readEventField<ScheduleEvent["kind"]>(eventRecord, "kind") ?? "BOOKING",
          status: readEventField<string>(eventRecord, "status") ?? "CONFIRMED",
          paymentState:
            readEventField<ScheduleEvent["paymentState"]>(eventRecord, "paymentState") ?? "PAID",
          serviceName: readEventField<string>(eventRecord, "serviceName") ?? "Appointment",
          buyerLabel: readEventField<string>(eventRecord, "buyerLabel") ?? "Guest",
          holdExpiresAt: readEventField<string>(eventRecord, "holdExpiresAt"),
          preparedBy: readEventField<ScheduleEvent["preparedBy"]>(eventRecord, "preparedBy"),
          noShowRisk: readEventField<ScheduleEvent["noShowRisk"]>(eventRecord, "noShowRisk"),
          isRaceFlash: Boolean(readEventField<boolean>(eventRecord, "isRaceFlash")),
        },
        nowMs,
      );
      return buildBryntumEventDomConfig(visual);
    },
    [nowMs],
  );

  const handleEventClick = useCallback(
    ({ eventRecord }: { eventRecord: unknown }) => {
      const clickedId = readEventField<string>(eventRecord, "id");
      if (!clickedId) return;
      const found = visibleEvents.find((e) => e.id === clickedId);
      if (found) {
        setSelectedEvent(found);
      }
    },
    [visibleEvents],
  );

  const updatedSecondsAgo =
    lastUpdatedAtMs !== null ? Math.max(0, Math.floor((nowMs - lastUpdatedAtMs) / 1000)) : null;

  const merchantDayLabel = formatMerchantDayLabel(selectedDateKey, merchantTz);

  const selectedLocalWindow = selectedEvent
    ? formatUserLocalWindow(selectedEvent.startsAt, selectedEvent.endsAt, merchantTz)
    : null;

  return (
    <div style={{ paddingTop: "var(--nav-height)" }}>
      <section
        style={{
          background: "var(--stage)",
          padding: "48px var(--page-padding) 32px",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              flexWrap: "wrap",
              gap: "20px",
            }}
          >
            <div>
              <p className="eyebrow mono">
                <span className="signal-dot signal-dot--emerald" aria-hidden="true"></span>
                BRYNTUM SCHEDULER &bull; LIVE CALENDAR
              </p>
              <h1
                className="display"
                style={{ fontSize: "clamp(32px, 5vw, 56px)", maxWidth: "820px" }}
              >
                Live provider schedule.
              </h1>
              <p className="lede" style={{ marginTop: "12px", maxWidth: "60ch" }}>
                Bookings made via Ask AI, MCP, or PayPal Sandbox checkout appear automatically in
                the merchant time zone (<strong>{merchantTz}</strong>).
              </p>
            </div>

            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
              <Link to="/book" className="button button--solid">
                <span className="signal-dot signal-dot--emerald" aria-hidden="true"></span>
                Book Slot
              </Link>
              {isJudge && (
                <button
                  type="button"
                  id="run-race-test-button"
                  className="button button--primary"
                  onClick={handleRunRaceTest}
                  disabled={isRunningRace}
                >
                  {isRunningRace ? "Running 20 attempts..." : "Race test (20 simultaneous holds)"}
                </button>
              )}
            </div>
          </div>

          {!isAuthenticated && (
            <div
              data-testid="schedule-signed-out-banner"
              style={{
                marginTop: "20px",
                padding: "14px 18px",
                background: "#14151a",
                color: "#f9fafb",
                borderRadius: "8px",
                border: "1px solid rgba(124, 151, 255, 0.35)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "12px",
              }}
            >
              <span style={{ fontSize: "13px" }}>
                Demo schedule (read-only). Sign in to book or run the race test.
              </span>
              {isAuth0Configured() && (
                <button
                  type="button"
                  className="button button--primary button--sm"
                  onClick={handleSignIn}
                >
                  Sign in or create account
                </button>
              )}
            </div>
          )}

          {isAuthenticated && isPublicDemoMode && !unprovisionedError && (
            <div
              data-testid="schedule-buyer-demo-banner"
              style={{
                marginTop: "20px",
                padding: "12px 16px",
                background: "#ffffff",
                border: "1px solid var(--hairline)",
                borderRadius: "8px",
                fontSize: "13px",
                color: "var(--text-body)",
              }}
            >
              Demo schedule (read-only). Sign in with the demo judge account to unlock live race
              test controls.
            </div>
          )}
        </div>
      </section>

      <section
        className="section"
        style={{ background: "var(--ground)", minHeight: "auto", paddingBottom: "72px" }}
      >
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <div aria-live="polite" className="sr-only" data-testid="schedule-aria-live">
            {announcement}
          </div>

          {unprovisionedError && (
            <div style={{ marginBottom: "20px" }}>
              <AccountProvisioningNotice onRetry={() => void fetchSchedule()} />
            </div>
          )}

          {raceError && (
            <div
              role="alert"
              style={{
                marginBottom: "20px",
                padding: "14px 18px",
                borderRadius: "8px",
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.35)",
                color: "#b91c1c",
                fontSize: "13px",
              }}
            >
              {raceError}
            </div>
          )}

          {raceResult && (
            <div
              role="status"
              data-testid="race-test-result"
              style={{
                marginBottom: "20px",
                padding: "16px 20px",
                borderRadius: "8px",
                background: "#12131a",
                color: "#f9fafb",
                border: "1px solid rgba(16, 185, 129, 0.45)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "12px",
              }}
            >
              <div>
                <strong style={{ fontSize: "14px", color: "#34d399" }}>
                  {raceResult.succeeded === 1 && raceResult.conflicts === 19
                    ? "20 simultaneous attempts → 1 hold, 19 rejected by the database"
                    : `${raceResult.attempts} simultaneous attempts → ${raceResult.succeeded} ${
                        raceResult.succeeded === 1 ? "hold" : "holds"
                      }, ${raceResult.conflicts} rejected by the database`}
                </strong>
                <div style={{ fontSize: "12px", color: "#d1d5db", marginTop: "4px" }}>
                  {raceResult.serviceName} · {raceResult.display.localStart}{" "}
                  {raceResult.display.timeZoneLabel} ({raceResult.durationMs} ms) — winning hold
                  flashed and released cleanly.
                </div>
              </div>
            </div>
          )}

          {/* Toolbar */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "12px",
              marginBottom: "16px",
              padding: "14px 18px",
              background: "#ffffff",
              border: "1px solid var(--hairline)",
              borderRadius: "8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="button button--outline button--sm"
                onClick={() => setSelectedDateKey((d) => addDaysToDateKey(d, -1))}
              >
                &larr; Prev
              </button>
              <button
                type="button"
                className="button button--outline button--sm"
                onClick={() => setSelectedDateKey(getDateKeyInZone(new Date(), merchantTz))}
              >
                Today
              </button>
              <button
                type="button"
                className="button button--outline button--sm"
                onClick={() => setSelectedDateKey((d) => addDaysToDateKey(d, 1))}
              >
                Next &rarr;
              </button>
              <strong style={{ marginLeft: "8px", fontSize: "14px" }}>{merchantDayLabel}</strong>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              {pollWarning && (
                <span
                  className="mono"
                  role="status"
                  style={{
                    fontSize: "11px",
                    padding: "4px 8px",
                    borderRadius: "4px",
                    background: "rgba(245, 158, 11, 0.14)",
                    color: "#b45309",
                    fontWeight: 600,
                  }}
                >
                  Live updates paused — retrying
                </span>
              )}
              <span
                className="mono"
                data-testid="schedule-updated-ago"
                style={{ fontSize: "11px", color: "var(--text-dim)" }}
              >
                {updatedSecondsAgo !== null ? `Updated ${updatedSecondsAgo} s ago` : "Syncing..."}
              </span>
            </div>
          </div>

          {/* Screen-reader & visual Legend */}
          <div
            style={{
              marginBottom: "16px",
              padding: "14px 18px",
              background: "#ffffff",
              border: "1px solid var(--hairline)",
              borderRadius: "8px",
            }}
          >
            <div
              className="mono"
              style={{ fontSize: "10px", color: "var(--text-dim)", marginBottom: "10px" }}
            >
              STATUS &amp; PAYMENT LEGEND
            </div>
            <ul
              aria-label="Schedule legend"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexWrap: "wrap",
                gap: "12px 20px",
              }}
            >
              {SCHEDULE_LEGEND_ITEMS.map((item) => (
                <li
                  key={item.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "12px",
                    color: "var(--ink)",
                  }}
                  title={item.description}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          </div>

          {loadError ? (
            <div
              role="alert"
              style={{
                padding: "24px",
                background: "#ffffff",
                border: "1px solid rgba(239, 68, 68, 0.35)",
                borderRadius: "8px",
              }}
            >
              <strong>Unable to load live schedule</strong>
              <p style={{ margin: "6px 0 14px", fontSize: "13px", color: "var(--text-body)" }}>
                {loadError}
              </p>
              <button
                type="button"
                className="button button--outline"
                onClick={() => void fetchSchedule()}
              >
                Retry
              </button>
            </div>
          ) : loading && !schedule ? (
            <div
              style={{
                padding: "48px",
                textAlign: "center",
                background: "#ffffff",
                border: "1px solid var(--hairline)",
                borderRadius: "8px",
              }}
            >
              Loading Bryntum Scheduler...
            </div>
          ) : (
            <div className="velvet-bryntum-shell" data-testid="bryntum-scheduler-container">
              <BryntumScheduler
                height={420}
                rowHeight={68}
                barMargin={6}
                readOnly={true}
                timeZone={merchantTz}
                startDate={queryRange.viewStart}
                endDate={queryRange.viewEnd}
                viewPreset="hourAndDay"
                columns={schedulerColumns}
                resources={bryntumResources}
                events={bryntumEvents}
                resourceStore={resourceStoreConfig}
                eventStore={eventStoreConfig}
                resourceTimeRanges={schedule?.resourceTimeRanges ?? []}
                resourceTimeRangesFeature={true}
                eventRenderer={eventRenderer}
                onEventClick={handleEventClick}
              />
            </div>
          )}

          {/* Basic event summary panel on click */}
          {selectedEvent && (
            <aside
              aria-label="Selected appointment details"
              data-testid="selected-event-panel"
              style={{
                marginTop: "20px",
                padding: "20px 24px",
                background: "#ffffff",
                border: "1px solid var(--hairline)",
                borderRadius: "8px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: "16px",
                flexWrap: "wrap",
              }}
            >
              <div>
                <div className="mono" style={{ fontSize: "11px", color: "var(--text-dim)" }}>
                  {selectedEvent.kind === "DEMO_FIXTURE" ? "DEMO BOOKING" : selectedEvent.kind} ·{" "}
                  {selectedEvent.status} · Payment: {selectedEvent.paymentState}
                </div>
                <h2 style={{ margin: "6px 0", fontSize: "18px" }}>{selectedEvent.serviceName}</h2>
                <div style={{ fontSize: "13px", color: "var(--ink)" }}>
                  {selectedEvent.display.localStart} – {selectedEvent.display.localEnd}{" "}
                  {selectedEvent.display.timeZoneLabel} ({selectedEvent.buyerLabel})
                </div>
                {selectedLocalWindow && (
                  <div style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "4px" }}>
                    {selectedLocalWindow}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => setSelectedEvent(null)}
              >
                Close
              </button>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
};

export default SchedulePage;
