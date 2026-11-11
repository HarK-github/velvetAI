import type { FC } from "react";
import { abuseLabReportSchema } from "@velvetai/contracts";
import rawAbuseLabReport from "../data/abuse-lab-report.json" with { type: "json" };
import { Link } from "../router.js";
import { CiVerificationTable } from "../components/security/CiVerificationTable.js";
import { LiveAbuseLabPanel } from "../components/security/LiveAbuseLabPanel.js";
import { SecurityArchitectureCards } from "../components/security/SecurityArchitectureCards.js";
import type { AbuseLabReport } from "../components/security/types.js";

const DEFAULT_REPORT: AbuseLabReport = abuseLabReportSchema.parse(rawAbuseLabReport);

interface SecurityPageProps {
  report?: AbuseLabReport;
}

export const SecurityPage: FC<SecurityPageProps> = ({ report = DEFAULT_REPORT }) => {
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
                ABUSE LAB &bull; DETERMINISTIC SECURITY DASHBOARD
              </p>
              <h1
                className="display"
                style={{ fontSize: "clamp(36px, 5.5vw, 68px)", maxWidth: "800px" }}
              >
                Security proof
              </h1>
              <p className="lede" style={{ marginTop: "16px", maxWidth: "56ch" }}>
                Every attack below is checked by code, not by asking the AI to behave.
              </p>
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <Link to="/book" className="button button--solid">
                <span className="signal-dot signal-dot--emerald" aria-hidden="true"></span>
                Book Slot
              </Link>
              <Link to="/status" className="button">
                API Status &rarr;
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Main Content */}
      <section
        className="section"
        style={{ background: "var(--ground)", minHeight: "auto", paddingBottom: "80px" }}
      >
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <LiveAbuseLabPanel />
          <CiVerificationTable report={report} />
          <SecurityArchitectureCards />
        </div>
      </section>
    </div>
  );
};
