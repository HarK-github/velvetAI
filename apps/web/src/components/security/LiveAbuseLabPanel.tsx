import { useState, useEffect, useRef, useCallback, type FC } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { apiClient, API_BASE_URL } from "../../api-client.js";
import { isAuth0Configured, isMockAuthEnabled } from "../../lib/auth-config.js";
import type {
  ListLiveAbuseRunsResponse,
  LiveAbuseRun,
  LiveAbuseScenarioResult,
  LiveAbuseScenarioStatus,
  TriggerLiveAbuseRunResponse,
} from "./types.js";

function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `live-abuse-${crypto.randomUUID()}`;
  }
  return `live-abuse-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getScenarioStatusDisplay(status: LiveAbuseScenarioStatus): {
  icon: string;
  label: string;
  background: string;
  color: string;
} {
  switch (status) {
    case "PASS":
      return {
        icon: "✓",
        label: "Blocked as expected",
        background: "rgba(16, 185, 129, 0.12)",
        color: "#047857",
      };
    case "FAIL":
      return {
        icon: "✕",
        label: "Check failed",
        background: "rgba(220, 38, 38, 0.12)",
        color: "#b91c1c",
      };
    case "ERROR":
      return {
        icon: "!",
        label: "Execution error",
        background: "rgba(220, 38, 38, 0.12)",
        color: "#b91c1c",
      };
    case "RUNNING":
      return {
        icon: "⟳",
        label: "Running",
        background: "rgba(47, 91, 255, 0.12)",
        color: "#1d4ed8",
      };
    case "PENDING":
    default:
      return {
        icon: "•",
        label: "Pending",
        background: "rgba(107, 114, 128, 0.12)",
        color: "#4b5563",
      };
  }
}

export const LiveAbuseLabPanel: FC = () => {
  const { isAuthenticated, isLoading, loginWithRedirect, getAccessTokenSilently } = useAuth0();
  const [judgeStatus, setJudgeStatus] = useState<"checking" | "not_judge" | "ready">("checking");
  const [activeRun, setActiveRun] = useState<LiveAbuseRun | null>(null);
  const [isTriggering, setIsTriggering] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rateLimitNotice, setRateLimitNotice] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef<boolean>(true);

  const audience =
    (typeof import.meta.env !== "undefined"
      ? (import.meta.env.VITE_AUTH0_AUDIENCE as string)
      : "") || "https://velvetai.example/api";

  const resolveBearerToken = useCallback(async (): Promise<string | undefined> => {
    const existing = apiClient.getAuthToken();
    if (existing) {
      return existing;
    }
    if (isAuthenticated) {
      try {
        const acquired = await getAccessTokenSilently({
          authorizationParams: {
            audience,
            scope:
              "openid profile email booking:read booking:quote booking:prepare booking:commit booking:cancel",
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
      return existing;
    }
    return undefined;
  }, [audience, getAccessTokenSilently, isAuthenticated]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollRun = useCallback(async (statusUrl: string, token: string) => {
    if (!mountedRef.current) return;
    try {
      const res = await fetch(`${API_BASE_URL}${statusUrl}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        return;
      }
      const runData = (await res.json()) as LiveAbuseRun;
      if (!mountedRef.current) return;
      setActiveRun(runData);
      if (runData.status === "RUNNING") {
        pollTimerRef.current = setTimeout(() => {
          void pollRun(statusUrl, token);
        }, 350);
      }
    } catch {
      // Ignore transient poll errors; user can re-check cleanly
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  useEffect(() => {
    let cancelled = false;

    async function checkJudgeAccess() {
      if (isLoading) return;
      const existingToken = apiClient.getAuthToken();
      if (!isAuthenticated && !existingToken) {
        if (!cancelled) {
          setJudgeStatus("not_judge");
        }
        return;
      }

      const token = await resolveBearerToken();
      if (!token) {
        if (!cancelled) {
          setJudgeStatus("not_judge");
        }
        return;
      }

      try {
        const res = await fetch(`${API_BASE_URL}/v1/judge/abuse-lab/runs`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!res.ok) {
          if (!cancelled) {
            setJudgeStatus("not_judge");
          }
          return;
        }
        const payload = (await res.json()) as ListLiveAbuseRunsResponse;
        if (!cancelled) {
          if (payload.isJudge) {
            setJudgeStatus("ready");
            if (payload.latestRun) {
              setActiveRun(payload.latestRun);
              if (payload.latestRun.status === "RUNNING") {
                void pollRun(`/v1/judge/abuse-lab/runs/${payload.latestRun.runId}`, token);
              }
            }
          } else {
            setJudgeStatus("not_judge");
          }
        }
      } catch {
        if (!cancelled) {
          setJudgeStatus("not_judge");
        }
      }
    }

    void checkJudgeAccess();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLoading, pollRun, resolveBearerToken]);

  const handleRunLiveChecks = async () => {
    stopPolling();
    setActionError(null);
    setRateLimitNotice(null);
    setIsTriggering(true);

    try {
      const token = await resolveBearerToken();
      if (!token) {
        setJudgeStatus("not_judge");
        return;
      }

      const res = await fetch(`${API_BASE_URL}/v1/judge/abuse-lab/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": createIdempotencyKey(),
        },
        body: JSON.stringify({}),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after") || "30";
        const body = await res.json().catch(() => null);
        setRateLimitNotice(
          body?.detail ||
            `Live checks are rate-limited to 1 run per 30 seconds. Retry after ${retryAfter}s.`,
        );
        return;
      }

      if (res.status === 401 || res.status === 403) {
        setJudgeStatus("not_judge");
        return;
      }

      if (!res.ok) {
        const problem = await res.json().catch(() => null);
        setActionError(problem?.detail || problem?.title || `Failed with HTTP ${res.status}`);
        return;
      }

      const started = (await res.json()) as TriggerLiveAbuseRunResponse;
      await pollRun(started.statusUrl, token);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to start live abuse checks");
    } finally {
      if (mountedRef.current) {
        setIsTriggering(false);
      }
    }
  };

  const handleJudgeSignIn = async () => {
    if (!isAuth0Configured()) return;
    await loginWithRedirect({
      authorizationParams: {
        audience,
      },
      appState: { returnTo: "/security" },
    });
  };

  const passedCount = activeRun?.scenarios.filter((s) => s.status === "PASS").length ?? 0;
  const totalCount = activeRun?.scenarios.length ?? 0;
  const isRunActive = activeRun?.status === "RUNNING";

  return (
    <section
      aria-labelledby="live-run-heading"
      style={{
        background: "#ffffff",
        border: "1px solid var(--hairline)",
        padding: "28px",
        marginBottom: "40px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "16px",
          marginBottom: "18px",
        }}
      >
        <div>
          <span
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "4px 10px",
              background: "rgba(47, 91, 255, 0.09)",
              color: "var(--accent)",
              border: "1px solid rgba(47, 91, 255, 0.25)",
              fontSize: "10px",
              marginBottom: "10px",
            }}
          >
            <span className="signal-dot" aria-hidden="true"></span>
            LIVE VERIFICATION · JUDGE TENANT ONLY
          </span>
          <h2
            id="live-run-heading"
            className="display"
            style={{ fontSize: "clamp(22px, 2.8vw, 32px)", margin: "0 0 8px" }}
          >
            Live Attack Verification
          </h2>
          <p style={{ margin: 0, color: "var(--secondary)", fontSize: "13px", maxWidth: "66ch" }}>
            Executes live service-level and HTTP-route attacks directly against the judge tenant
            with before/after row counts verifying zero persistent state changes.
          </p>
        </div>

        {judgeStatus === "ready" && (
          <button
            type="button"
            className="button button--solid"
            onClick={() => void handleRunLiveChecks()}
            disabled={isTriggering || isRunActive}
            id="run-live-checks-button"
          >
            <span className="signal-dot signal-dot--emerald" aria-hidden="true"></span>
            {isTriggering || isRunActive ? "Running live checks..." : "Run live checks"}
          </button>
        )}
      </div>

      {judgeStatus === "checking" && (
        <p className="mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
          Checking demo judge permissions...
        </p>
      )}

      {judgeStatus === "not_judge" && (
        <div
          style={{
            padding: "20px",
            background: "var(--ground)",
            border: "1px solid var(--hairline)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div>
            <p style={{ margin: "0 0 4px", fontWeight: 600, fontSize: "14px" }}>
              Sign in as the demo judge to run live checks
            </p>
            <p style={{ margin: 0, color: "var(--secondary)", fontSize: "12px" }}>
              The CI-verified suite below is public; interactive live attack runs are restricted to
              the demo judge account in the isolated judge tenant.
            </p>
          </div>
          {isAuth0Configured() && !isAuthenticated && (
            <button
              type="button"
              className="button button--outline"
              onClick={() => void handleJudgeSignIn()}
            >
              Sign in as Demo Judge
            </button>
          )}
        </div>
      )}

      {rateLimitNotice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "12px 16px",
            marginBottom: "16px",
            background: "rgba(217, 119, 6, 0.1)",
            border: "1px solid rgba(217, 119, 6, 0.35)",
            color: "#92400e",
            fontSize: "12px",
          }}
        >
          {rateLimitNotice}
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          style={{
            padding: "12px 16px",
            marginBottom: "16px",
            background: "rgba(220, 38, 38, 0.1)",
            border: "1px solid rgba(220, 38, 38, 0.35)",
            color: "#991b1b",
            fontSize: "12px",
          }}
        >
          {actionError}
        </div>
      )}

      {judgeStatus === "ready" && (
        <div aria-live="polite">
          {!activeRun ? (
            <p style={{ margin: 0, color: "var(--secondary)", fontSize: "13px" }}>
              No live run recorded yet in this session. Click &ldquo;Run live checks&rdquo; to
              execute live attacks against the judge tenant.
            </p>
          ) : (
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                  padding: "12px 16px",
                  background: "var(--ground)",
                  border: "1px solid var(--hairline)",
                  marginBottom: "16px",
                }}
              >
                <strong style={{ fontSize: "14px" }}>
                  {activeRun.status === "RUNNING"
                    ? `Running live checks (${passedCount} of ${totalCount} passed so far)...`
                    : `${passedCount} of ${totalCount} blocked as expected`}
                </strong>
                {activeRun.summary && (
                  <span
                    className="mono"
                    style={{
                      padding: "4px 10px",
                      fontSize: "10px",
                      background: activeRun.summary.allStateUnchanged
                        ? "rgba(16, 185, 129, 0.12)"
                        : "rgba(220, 38, 38, 0.12)",
                      color: activeRun.summary.allStateUnchanged ? "#047857" : "#b91c1c",
                    }}
                  >
                    {activeRun.summary.allStateUnchanged
                      ? "State changed: none"
                      : "State changed: check scenario details"}
                  </span>
                )}
              </div>

              <div style={{ display: "grid", gap: "12px" }}>
                {activeRun.scenarios.map((scenario: LiveAbuseScenarioResult) => {
                  const statusUi = getScenarioStatusDisplay(scenario.status);
                  return (
                    <div
                      key={scenario.id}
                      style={{
                        border: "1px solid var(--hairline)",
                        padding: "16px",
                        display: "grid",
                        gap: "8px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "10px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            flexWrap: "wrap",
                          }}
                        >
                          <span className="mono" style={{ fontSize: "11px", fontWeight: 700 }}>
                            {scenario.id}
                          </span>
                          <span style={{ fontWeight: 600, fontSize: "14px" }}>{scenario.name}</span>
                          <span
                            className="mono"
                            style={{
                              padding: "2px 7px",
                              fontSize: "9px",
                              background: "var(--ground)",
                              border: "1px solid var(--hairline)",
                            }}
                          >
                            {scenario.level === "HTTP" ? "HTTP route" : "Service layer"}
                          </span>
                          <span
                            className="mono"
                            style={{
                              padding: "2px 7px",
                              fontSize: "9px",
                              color: "var(--secondary)",
                              border: "1px solid var(--hairline)",
                            }}
                          >
                            Also covered in CI: {scenario.ciScenarioId}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            flexWrap: "wrap",
                          }}
                        >
                          {scenario.stateUnchanged !== null && (
                            <span
                              className="mono"
                              style={{
                                padding: "3px 8px",
                                fontSize: "10px",
                                background: scenario.stateUnchanged
                                  ? "rgba(16, 185, 129, 0.1)"
                                  : "rgba(220, 38, 38, 0.12)",
                                color: scenario.stateUnchanged ? "#047857" : "#b91c1c",
                              }}
                            >
                              {scenario.stateUnchanged
                                ? "State changed: none"
                                : "State changed: mismatch"}
                            </span>
                          )}
                          <span
                            className="mono"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              padding: "3px 8px",
                              fontSize: "10px",
                              background: statusUi.background,
                              color: statusUi.color,
                            }}
                          >
                            <span aria-hidden="true">{statusUi.icon}</span>
                            {statusUi.label}
                          </span>
                          <span
                            className="mono"
                            style={{ fontSize: "10px", color: "var(--muted)" }}
                          >
                            {scenario.durationMs} ms
                          </span>
                        </div>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                          gap: "10px",
                          fontSize: "12px",
                          color: "var(--secondary)",
                        }}
                      >
                        <div>
                          <strong style={{ color: "var(--ink)" }}>Expected:</strong>{" "}
                          {scenario.expected}
                        </div>
                        <div>
                          <strong style={{ color: "var(--ink)" }}>Observed:</strong>{" "}
                          {scenario.observed || "Waiting to execute..."}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
