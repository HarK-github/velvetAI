import type { FC } from "react";
import { HeroSection } from "../components/HeroSection.js";
import { ProtocolSection } from "../components/ProtocolSection.js";
import { ComputedProofSection } from "../components/ComputedProofSection.js";
import { GeometrySection } from "../components/GeometrySection.js";
import { StateRotorSection } from "../components/StateRotorSection.js";
import { CommitSection } from "../components/CommitSection.js";
import { Link } from "../router.js";

export const HomePage: FC = () => {
  return (
    <>
      <HeroSection />

      {/* Quick Navigation Cards Banner */}
      <section
        style={{
          background: "var(--ground)",
          borderTop: "1px solid var(--hairline)",
          borderBottom: "1px solid var(--hairline)",
          padding: "48px var(--page-padding)",
        }}
      >
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: "20px",
            }}
          >
            <Link
              to="/book"
              className="quick-nav-card"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--hairline-strong)",
                borderRadius: "var(--radius-md)",
                padding: "24px",
                display: "block",
                boxShadow: "var(--card-shadow)",
                transition: "all 180ms ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                <span className="signal-dot signal-dot--emerald"></span>
                <span className="mono" style={{ color: "var(--accent)", fontSize: "11px", fontWeight: 600 }}>
                  CUSTOMER CONSOLE
                </span>
              </div>
              <h3
                style={{ fontFamily: "Archivo, sans-serif", fontSize: "19px", fontWeight: 700, margin: "8px 0 6px", color: "var(--ink)" }}
              >
                Book Appointment &rarr;
              </h3>
              <p
                style={{ color: "var(--secondary)", fontSize: "13px", margin: 0, lineHeight: 1.5 }}
              >
                Interactive slot selector, dynamic deposit calculation, and 300s GiST lock.
              </p>
            </Link>

            <Link
              to="/schedule"
              className="quick-nav-card"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--hairline-strong)",
                borderRadius: "var(--radius-md)",
                padding: "24px",
                display: "block",
                boxShadow: "var(--card-shadow)",
                transition: "all 180ms ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                <span className="signal-dot"></span>
                <span className="mono" style={{ color: "var(--accent)", fontSize: "11px", fontWeight: 600 }}>
                  MERCHANT SCHEDULE
                </span>
              </div>
              <h3
                style={{ fontFamily: "Archivo, sans-serif", fontSize: "19px", fontWeight: 700, margin: "8px 0 6px", color: "var(--ink)" }}
              >
                Schedule & Claims &rarr;
              </h3>
              <p
                style={{ color: "var(--secondary)", fontSize: "13px", margin: 0, lineHeight: 1.5 }}
              >
                Multi-resource availability, active reservations, and PostgreSQL concurrency telemetry.
              </p>
            </Link>

            <Link
              to="/policy"
              className="quick-nav-card"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--hairline-strong)",
                borderRadius: "var(--radius-md)",
                padding: "24px",
                display: "block",
                boxShadow: "var(--card-shadow)",
                transition: "all 180ms ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                <span className="signal-dot signal-dot--amber"></span>
                <span className="mono" style={{ color: "var(--accent)", fontSize: "11px", fontWeight: 600 }}>
                  POLICY ENGINE
                </span>
              </div>
              <h3
                style={{ fontFamily: "Archivo, sans-serif", fontSize: "19px", fontWeight: 700, margin: "8px 0 6px", color: "var(--ink)" }}
              >
                Risk & Policy Tiers &rarr;
              </h3>
              <p
                style={{ color: "var(--secondary)", fontSize: "13px", margin: 0, lineHeight: 1.5 }}
              >
                Deterministic risk tier simulator repainting UI colors, deposit formulas, and spec rules.
              </p>
            </Link>

            <Link
              to="/status"
              className="quick-nav-card"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--hairline-strong)",
                borderRadius: "var(--radius-md)",
                padding: "24px",
                display: "block",
                boxShadow: "var(--card-shadow)",
                transition: "all 180ms ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                <span className="signal-dot signal-dot--emerald"></span>
                <span className="mono" style={{ color: "#059669", fontSize: "11px", fontWeight: 600 }}>
                  SYSTEM HEALTH
                </span>
              </div>
              <h3
                style={{ fontFamily: "Archivo, sans-serif", fontSize: "19px", fontWeight: 700, margin: "8px 0 6px", color: "var(--ink)" }}
              >
                API Health & Latency &rarr;
              </h3>
              <p
                style={{ color: "var(--secondary)", fontSize: "13px", margin: 0, lineHeight: 1.5 }}
              >
                Live Fastify REST status, PostgreSQL/Redis readiness, and raw RFC 9457 inspectors.
              </p>
            </Link>
          </div>
        </div>
      </section>

      <ProtocolSection />
      <ComputedProofSection />
      <GeometrySection />
      <StateRotorSection />
      <CommitSection />
    </>
  );
};
