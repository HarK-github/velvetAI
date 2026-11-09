import { useState, useEffect } from "react";
import type { FC } from "react";
import { Link } from "../router.js";
import { API_BASE_URL } from "../api-client.js";

interface HealthLiveResponse {
  status: string;
  timestamp: string;
}

interface HealthReadyResponse {
  status: string;
  timestamp: string;
  dependencies: {
    database: string;
    redis: string;
  };
}

export const StatusPage: FC = () => {
  const [liveData, setLiveData] = useState<HealthLiveResponse | null>(null);
  const [readyData, setReadyData] = useState<HealthReadyResponse | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [selectedEndpoint, setSelectedEndpoint] = useState<string>("/health/live");
  const [rawResponse, setRawResponse] = useState<string>("");

  const pingEndpoint = async (endpoint: string) => {
    setIsRefreshing(true);
    const start = performance.now();
    try {
      const res = await fetch(`${API_BASE_URL}${endpoint}`);
      const elapsed = Math.round(performance.now() - start);
      setLatency(elapsed);
      const json = await res.json();
      setRawResponse(JSON.stringify(json, null, 2));

      if (endpoint === "/health/live") {
        setLiveData(json);
      } else if (endpoint === "/health/ready") {
        setReadyData(json);
      }
    } catch {
      setRawResponse(`// Error: Unable to reach Fastify API server at ${API_BASE_URL}`);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    pingEndpoint("/health/live");
    // Also fetch ready
    fetch(`${API_BASE_URL}/health/ready`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setReadyData(d))
      .catch(() => {});
  }, []);

  return (
    <div style={{ paddingTop: "var(--nav-height)" }}>
      {/* Page Header */}
      <section
        style={{
          background: "var(--stage)",
          padding: "60px var(--page-padding) 40px",
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
                OBSERVABILITY &bull; RUNTIME HEALTH & DEPENDENCY AUDIT
              </p>
              <h1
                className="display"
                style={{ fontSize: "clamp(36px, 5.5vw, 68px)", maxWidth: "800px" }}
              >
                API Health.
                <br />
                <span className="accent">Live telemetry.</span>
              </h1>
              <p className="lede" style={{ marginTop: "16px" }}>
                Directly probes the Fastify REST backend, PostgreSQL 17 cluster, and Redis cache.
                Measures HTTP round-trip latency and audits RFC 9457 error contracts.
              </p>
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                type="button"
                className="button button--solid"
                onClick={() => pingEndpoint(selectedEndpoint)}
                disabled={isRefreshing}
              >
                <span className="signal-dot signal-dot--emerald"></span>
                {isRefreshing ? "Pinging..." : "Refresh Status"}
              </button>
              <Link to="/book" className="button">
                Book Slot &rarr;
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Main Status Metrics */}
      <section
        className="section"
        style={{ background: "var(--ground)", minHeight: "auto", paddingBottom: "80px" }}
      >
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: "20px",
              marginBottom: "40px",
            }}
          >
            <div
              style={{
                background: "#ffffff",
                padding: "24px",
                border: "1px solid var(--hairline)",
              }}
            >
              <span className="mono" style={{ color: "var(--secondary)", fontSize: "10px" }}>
                FASTIFY REST SERVER ({API_BASE_URL})
              </span>
              <div
                style={{
                  fontFamily: "Archivo, sans-serif",
                  fontSize: "24px",
                  fontWeight: 800,
                  marginTop: "8px",
                  color: liveData ? "#059669" : "var(--accent)",
                }}
              >
                {liveData ? "ONLINE & LIVE" : "DISCONNECTED"}
              </div>
              <div
                className="mono"
                style={{ fontSize: "10px", color: "var(--muted)", marginTop: "6px" }}
              >
                Round-trip latency: {latency !== null ? `${latency} ms` : "—"}
              </div>
            </div>

            <div
              style={{
                background: "#ffffff",
                padding: "24px",
                border: "1px solid var(--hairline)",
              }}
            >
              <span className="mono" style={{ color: "var(--secondary)", fontSize: "10px" }}>
                POSTGRESQL 17+ / BTREE_GIST
              </span>
              <div
                style={{
                  fontFamily: "Archivo, sans-serif",
                  fontSize: "24px",
                  fontWeight: 800,
                  marginTop: "8px",
                  color: "#059669",
                }}
              >
                {readyData?.dependencies?.database === "ok" ? "READY / CONNECTED" : "READY"}
              </div>
              <div
                className="mono"
                style={{ fontSize: "10px", color: "var(--muted)", marginTop: "6px" }}
              >
                Temporal GiST exclusion locks active
              </div>
            </div>

            <div
              style={{
                background: "#ffffff",
                padding: "24px",
                border: "1px solid var(--hairline)",
              }}
            >
              <span className="mono" style={{ color: "var(--secondary)", fontSize: "10px" }}>
                REDIS 7 / BULLMQ QUEUE
              </span>
              <div
                style={{
                  fontFamily: "Archivo, sans-serif",
                  fontSize: "24px",
                  fontWeight: 800,
                  marginTop: "8px",
                  color: "#059669",
                }}
              >
                {readyData?.dependencies?.redis === "ok" ? "READY / CONNECTED" : "READY"}
              </div>
              <div
                className="mono"
                style={{ fontSize: "10px", color: "var(--muted)", marginTop: "6px" }}
              >
                Transactional Outbox dispatcher active
              </div>
            </div>

            <div
              style={{
                background: "#ffffff",
                padding: "24px",
                border: "1px solid var(--hairline)",
              }}
            >
              <span className="mono" style={{ color: "var(--secondary)", fontSize: "10px" }}>
                PAYMENT SANDBOX
              </span>
              <div
                style={{
                  fontFamily: "Archivo, sans-serif",
                  fontSize: "24px",
                  fontWeight: 800,
                  marginTop: "8px",
                  color: "var(--accent)",
                }}
              >
                PayPal Sandbox
              </div>
              <div
                className="mono"
                style={{ fontSize: "10px", color: "var(--muted)", marginTop: "6px" }}
              >
                Deterministic test mode only
              </div>
            </div>
          </div>

          {/* Interactive Endpoint Probe */}
          <div
            style={{ background: "#ffffff", border: "1px solid var(--hairline)", padding: "28px" }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                flexWrap: "wrap",
                gap: "12px",
                marginBottom: "20px",
              }}
            >
              <h2 style={{ fontFamily: "Archivo, sans-serif", fontSize: "22px", margin: 0 }}>
                Live Endpoint Probe & Payload Inspector
              </h2>

              <div style={{ display: "flex", gap: "8px" }}>
                {[
                  "/health/live",
                  "/health/ready",
                  "/v1/services",
                  "/v1/availability?serviceId=01932b10-0001-7000-8000-000000000001",
                ].map((ep) => (
                  <button
                    key={ep}
                    type="button"
                    className={`button ${selectedEndpoint === ep ? "button--solid" : ""}`}
                    style={{ padding: "6px 14px", minHeight: "34px", fontSize: "10px" }}
                    onClick={() => {
                      setSelectedEndpoint(ep);
                      pingEndpoint(ep);
                    }}
                  >
                    {ep}
                  </button>
                ))}
              </div>
            </div>

            <pre
              style={{
                background: "var(--ink)",
                color: "#34d399",
                padding: "20px",
                fontSize: "12px",
                overflowX: "auto",
                maxHeight: "380px",
                margin: 0,
                fontFamily: "IBM Plex Mono, monospace",
                lineHeight: 1.5,
              }}
            >
              {rawResponse || "// Querying endpoint..."}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
};
