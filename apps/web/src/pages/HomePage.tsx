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
          padding: "40px var(--page-padding)",
        }}
      >
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "20px",
            }}
          >
            <Link
              to="/book"
              style={{
                background: "#ffffff",
                border: "1px solid var(--hairline)",
                padding: "24px",
                display: "block",
                transition: "all 200ms ease",
              }}
            >
              <span className="mono" style={{ color: "var(--accent)", fontSize: "10px" }}>
                01 / CUSTOMER SURFACE
              </span>
              <h3
                style={{ fontFamily: "Archivo, sans-serif", fontSize: "20px", margin: "8px 0 4px" }}
              >
                Book Appointment &rarr;
              </h3>
              <p
                style={{ color: "var(--secondary)", fontSize: "12px", margin: 0, lineHeight: 1.5 }}
              >
                Interactive slot selector, demand forecast deposit calculation, and 300s GiST lock.
              </p>
            </Link>

            <Link
              to="/schedule"
              style={{
                background: "#ffffff",
                border: "1px solid var(--hairline)",
                padding: "24px",
                display: "block",
                transition: "all 200ms ease",
              }}
            >
              <span className="mono" style={{ color: "var(--accent)", fontSize: "10px" }}>
                02 / MERCHANT SURFACE
              </span>
              <h3
                style={{ fontFamily: "Archivo, sans-serif", fontSize: "20px", margin: "8px 0 4px" }}
              >
                Schedule & Claims &rarr;
              </h3>
              <p
                style={{ color: "var(--secondary)", fontSize: "12px", margin: 0, lineHeight: 1.5 }}
              >
                Multi-resource availability, active reservations, and PostgreSQL concurrency
                telemetry.
              </p>
            </Link>

            <Link
              to="/policy"
              style={{
                background: "#ffffff",
                border: "1px solid var(--hairline)",
                padding: "24px",
                display: "block",
                transition: "all 200ms ease",
              }}
            >
              <span className="mono" style={{ color: "var(--accent)", fontSize: "10px" }}>
                03 / POLICY ENGINE
              </span>
              <h3
                style={{ fontFamily: "Archivo, sans-serif", fontSize: "20px", margin: "8px 0 4px" }}
              >
                Risk & Policy Tiers &rarr;
              </h3>
              <p
                style={{ color: "var(--secondary)", fontSize: "12px", margin: 0, lineHeight: 1.5 }}
              >
                Deterministic risk tier simulator repainting UI colors, deposit formulas, and spec
                rules.
              </p>
            </Link>

            <Link
              to="/status"
              style={{
                background: "#ffffff",
                border: "1px solid var(--hairline)",
                padding: "24px",
                display: "block",
                transition: "all 200ms ease",
              }}
            >
              <span className="mono" style={{ color: "#10b981", fontSize: "10px" }}>
                04 / OBSERVABILITY
              </span>
              <h3
                style={{ fontFamily: "Archivo, sans-serif", fontSize: "20px", margin: "8px 0 4px" }}
              >
                API Health & Latency &rarr;
              </h3>
              <p
                style={{ color: "var(--secondary)", fontSize: "12px", margin: 0, lineHeight: 1.5 }}
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
