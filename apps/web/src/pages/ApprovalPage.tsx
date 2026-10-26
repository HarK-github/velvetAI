import { useState, useEffect, type FC } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Link } from "../router.js";
import type { BookingApprovalDetails } from "@velvetai/contracts";

interface ApprovalPageProps {
  locator: string;
}

export const ApprovalPage: FC<ApprovalPageProps> = ({ locator }) => {
  const {
    isAuthenticated,
    isLoading: isAuthLoading,
    user,
    loginWithRedirect,
    getAccessTokenSilently,
  } = useAuth0();

  const [details, setDetails] = useState<BookingApprovalDetails | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [isApproving, setIsApproving] = useState<boolean>(false);
  const [approved, setApproved] = useState<boolean>(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const fetchDetails = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`http://localhost:3000/v1/booking-approvals/${locator}`, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || `HTTP ${res.status}: Failed to load approval details`);
      }

      const data: BookingApprovalDetails = await res.json();
      setDetails(data);
      if (data.status === "APPROVED" || data.status === "CONSUMED") {
        setApproved(true);
      }
    } catch (err: unknown) {
      const errorObj = err as Error;
      setError(errorObj.message || "Failed to load approval session");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (locator) {
      fetchDetails();
    }
  }, [locator]);

  const handleApprove = async () => {
    if (!isAuthenticated) {
      loginWithRedirect({
        appState: { returnTo: window.location.pathname },
      });
      return;
    }

    setIsApproving(true);
    setApprovalError(null);

    try {
      const audience =
        (typeof import.meta.env !== "undefined"
          ? (import.meta.env.VITE_AUTH0_AUDIENCE as string)
          : "") || "https://velvetai.example/api";

      const token = await getAccessTokenSilently({
        authorizationParams: {
          audience,
          scope: "openid profile email booking:commit",
        },
      });

      const res = await fetch(`http://localhost:3000/v1/booking-approvals/${locator}/confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "idempotency-key": `approve-ui-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        },
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(
          errJson.detail || errJson.title || `Approval failed with HTTP ${res.status}`,
        );
      }

      setApproved(true);
      // Refresh status from server
      await fetchDetails();
    } catch (err: unknown) {
      const errorObj = err as Error;
      setApprovalError(errorObj.message || "Failed to confirm approval");
    } finally {
      setIsApproving(false);
    }
  };

  const formatPrice = (minor: string, currency: string) => {
    const val = (parseInt(minor, 10) / 100).toFixed(2);
    return `${currency} $${val}`;
  };

  const formatTimestamp = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });
    } catch {
      return ts;
    }
  };

  return (
    <div style={{ paddingTop: "var(--nav-height)" }}>
      {/* Header */}
      <section
        style={{
          background: "var(--stage)",
          padding: "60px var(--page-padding) 40px",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <p className="eyebrow mono">
            <span
              className={`signal-dot ${approved ? "signal-dot--emerald" : "signal-dot--gold"}`}
              aria-hidden="true"
            ></span>
            HUMAN BUYER CONFIRMATION &bull; AMENDMENT D.4 PROTOCOL
          </p>
          <h1
            className="display"
            style={{ fontSize: "clamp(36px, 5.5vw, 68px)", maxWidth: "840px" }}
          >
            Review Terms.
            <br />
            <span className="accent">
              {approved ? "Hold Approved." : "Human Approval Required."}
            </span>
          </h1>
          <p className="lede" style={{ marginTop: "16px", maxWidth: "720px" }}>
            An AI agent has held a reservation slot on your behalf. Under velvetAI security policy,
            the agent cannot confirm or commit the booking until you personally review and authorize
            the terms.
          </p>
        </div>
      </section>

      {/* Main Content */}
      <section
        className="section"
        style={{ background: "var(--ground)", minHeight: "60vh", paddingBottom: "80px" }}
      >
        <div style={{ maxWidth: "800px", margin: "0 auto" }}>
          {loading && (
            <div style={{ textAlign: "center", padding: "60px 0" }}>
              <p className="mono" style={{ color: "var(--text-dim)" }}>
                Loading booking approval terms from authoritative ledger...
              </p>
            </div>
          )}

          {error && (
            <div
              style={{
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                borderRadius: "12px",
                padding: "24px",
                margin: "24px 0",
              }}
            >
              <h3 style={{ color: "#ef4444", margin: "0 0 8px 0" }}>
                Approval Session Unavailable
              </h3>
              <p style={{ margin: "0 0 16px 0", color: "var(--text-body)" }}>{error}</p>
              <Link to="/book" className="button">
                Return to Booking
              </Link>
            </div>
          )}

          {!loading && details && (
            <div
              style={{
                background: "var(--stage)",
                border: "1px solid var(--hairline)",
                borderRadius: "16px",
                padding: "36px",
                boxShadow: "0 20px 40px rgba(0, 0, 0, 0.4)",
              }}
            >
              {/* Approval status banner */}
              {approved ? (
                <div
                  style={{
                    background: "rgba(16, 185, 129, 0.12)",
                    border: "1px solid rgba(16, 185, 129, 0.3)",
                    borderRadius: "8px",
                    padding: "16px 20px",
                    marginBottom: "28px",
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                  }}
                >
                  <span className="signal-dot signal-dot--emerald" style={{ flexShrink: 0 }}></span>
                  <div>
                    <strong style={{ color: "#10b981" }}>Terms Approved</strong>
                    <div style={{ fontSize: "14px", color: "var(--text-body)", marginTop: "4px" }}>
                      This booking hold is authorized. Your agent can now finalize the commitment.
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    background: "rgba(245, 158, 11, 0.12)",
                    border: "1px solid rgba(245, 158, 11, 0.3)",
                    borderRadius: "8px",
                    padding: "16px 20px",
                    marginBottom: "28px",
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                  }}
                >
                  <span className="signal-dot signal-dot--gold" style={{ flexShrink: 0 }}></span>
                  <div>
                    <strong style={{ color: "#f59e0b" }}>Pending Buyer Confirmation</strong>
                    <div style={{ fontSize: "14px", color: "var(--text-body)", marginTop: "4px" }}>
                      Expires at {formatTimestamp(details.expiresAt)}
                    </div>
                  </div>
                </div>
              )}

              {/* Service & Hold Details */}
              <div style={{ marginBottom: "28px" }}>
                <p className="eyebrow mono" style={{ marginBottom: "6px" }}>
                  SERVICE RESERVATION
                </p>
                <h2 style={{ margin: "0 0 10px 0", fontSize: "28px" }}>{details.serviceName}</h2>
                <p style={{ color: "var(--text-dim)", margin: 0 }}>
                  Timezone: {details.timeZone} &bull; Service Revision {details.serviceVersion}
                </p>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "20px",
                  padding: "24px 0",
                  borderTop: "1px solid var(--hairline)",
                  borderBottom: "1px solid var(--hairline)",
                  marginBottom: "28px",
                }}
              >
                <div>
                  <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    SCHEDULED TIME
                  </span>
                  <div style={{ marginTop: "6px", fontWeight: 600 }}>
                    {formatTimestamp(details.startsAt)}
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--text-dim)", marginTop: "2px" }}>
                    Until {formatTimestamp(details.endsAt)}
                  </div>
                </div>

                <div>
                  <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    ALL-IN PRICE / DEPOSIT
                  </span>
                  <div style={{ marginTop: "6px", fontWeight: 600, fontSize: "18px" }}>
                    {formatPrice(details.allInPriceMinor, details.currency)}
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--text-dim)", marginTop: "2px" }}>
                    Deposit required: {formatPrice(details.depositMinor, details.currency)}
                  </div>
                </div>

                <div>
                  <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    REQUESTING AGENT
                  </span>
                  <div style={{ marginTop: "6px", fontFamily: "monospace", fontSize: "13px" }}>
                    {details.requestingAgent}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "2px" }}>
                    Hold session: {locator.substring(0, 12)}...
                  </div>
                </div>
              </div>

              {/* Policy & Cancellation */}
              <div
                style={{
                  background: "var(--ground)",
                  borderRadius: "10px",
                  padding: "16px 20px",
                  marginBottom: "28px",
                  border: "1px solid var(--hairline)",
                }}
              >
                <div className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                  CANCELLATION & REFUND POLICY
                </div>
                <div style={{ marginTop: "6px", fontSize: "14px", lineHeight: "1.5" }}>
                  {details.cancellationSummary}
                </div>
              </div>

              {/* Action Buttons */}
              {approvalError && (
                <div
                  style={{
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    borderRadius: "8px",
                    padding: "12px 16px",
                    marginBottom: "20px",
                    color: "#ef4444",
                    fontSize: "14px",
                  }}
                >
                  {approvalError}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "16px",
                }}
              >
                <div>
                  {isAuthenticated ? (
                    <div className="mono" style={{ fontSize: "13px", color: "var(--text-dim)" }}>
                      Authenticated buyer: <strong>{user?.email || user?.name}</strong>
                    </div>
                  ) : (
                    <div className="mono" style={{ fontSize: "13px", color: "#f59e0b" }}>
                      Buyer sign-in required to authorize this booking
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: "12px" }}>
                  {!approved && (
                    <>
                      {!isAuthenticated ? (
                        <button
                          type="button"
                          className="button button--solid"
                          onClick={() =>
                            loginWithRedirect({
                              appState: { returnTo: window.location.pathname },
                            })
                          }
                          disabled={isAuthLoading}
                        >
                          Sign In with Auth0 &rarr;
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button button--solid"
                          onClick={handleApprove}
                          disabled={isApproving}
                        >
                          {isApproving ? "Authorizing..." : "Approve Booking Hold &rarr;"}
                        </button>
                      )}
                    </>
                  )}
                  {approved && (
                    <Link to="/schedule" className="button button--solid">
                      View In Schedule &rarr;
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
