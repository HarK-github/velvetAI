import { useState, useMemo, type FC } from "react";
import {
  GITHUB_COMMIT_BASE_URL,
  type AbuseLabReport,
  type AbuseScenarioCategory,
  type AbuseScenarioSeverity,
} from "./types.js";

interface CiVerificationTableProps {
  report: AbuseLabReport;
}

const SEVERITIES: Array<"ALL" | AbuseScenarioSeverity> = [
  "ALL",
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
];
const CATEGORIES: Array<"ALL" | AbuseScenarioCategory> = [
  "ALL",
  "AUTH",
  "CRYPTO",
  "CONCURRENCY",
  "IDEMPOTENCY",
  "PAYMENT",
  "TENANCY",
  "INJECTION",
];

function formatReportDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function getSeverityStyle(severity: AbuseScenarioSeverity): {
  background: string;
  color: string;
  border: string;
} {
  switch (severity) {
    case "CRITICAL":
      return {
        background: "rgba(220, 38, 38, 0.1)",
        color: "#b91c1c",
        border: "1px solid rgba(220, 38, 38, 0.3)",
      };
    case "HIGH":
      return {
        background: "rgba(217, 119, 6, 0.1)",
        color: "#b45309",
        border: "1px solid rgba(217, 119, 6, 0.3)",
      };
    case "MEDIUM":
      return {
        background: "rgba(47, 91, 255, 0.08)",
        color: "#1d4ed8",
        border: "1px solid rgba(47, 91, 255, 0.25)",
      };
    case "LOW":
    default:
      return {
        background: "rgba(107, 114, 128, 0.1)",
        color: "#374151",
        border: "1px solid rgba(107, 114, 128, 0.25)",
      };
  }
}

export const CiVerificationTable: FC<CiVerificationTableProps> = ({ report }) => {
  const [selectedSeverity, setSelectedSeverity] = useState<"ALL" | AbuseScenarioSeverity>("ALL");
  const [selectedCategory, setSelectedCategory] = useState<"ALL" | AbuseScenarioCategory>("ALL");

  const shortSha = report.commitSha.slice(0, 7);
  const formattedDate = formatReportDate(report.generatedAt);

  const filteredScenarios = useMemo(() => {
    return report.scenarios.filter((s) => {
      if (selectedSeverity !== "ALL" && s.severity !== selectedSeverity) return false;
      if (selectedCategory !== "ALL" && s.category !== selectedCategory) return false;
      return true;
    });
  }, [report.scenarios, selectedSeverity, selectedCategory]);

  return (
    <section
      aria-labelledby="ci-verified-heading"
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
          marginBottom: "20px",
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
              background: "rgba(16, 185, 129, 0.12)",
              color: "#047857",
              border: "1px solid rgba(16, 185, 129, 0.3)",
              fontSize: "10px",
              marginBottom: "10px",
            }}
          >
            <span aria-hidden="true">✓</span> CI-VERIFIED REPORT ARTIFACT
          </span>
          <h2
            id="ci-verified-heading"
            className="display"
            style={{ fontSize: "clamp(22px, 2.8vw, 32px)", margin: "0 0 8px" }}
          >
            Automated Abuse Lab Suite ({report.passed} of {report.total} passed)
          </h2>
          <p style={{ margin: 0, color: "var(--secondary)", fontSize: "13px" }}>
            Verified by the automated suite at commit{" "}
            <a
              href={`${GITHUB_COMMIT_BASE_URL}/${report.commitSha}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mono"
              style={{
                color: "var(--accent)",
                textDecoration: "underline",
                fontSize: "12px",
              }}
            >
              {shortSha}
            </a>{" "}
            on {formattedDate}
          </p>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
          <label className="mono" style={{ fontSize: "10px", color: "var(--secondary)" }}>
            Severity
            <select
              aria-label="Filter by severity"
              value={selectedSeverity}
              onChange={(e) => setSelectedSeverity(e.target.value as "ALL" | AbuseScenarioSeverity)}
              style={{
                display: "block",
                marginTop: "4px",
                padding: "8px 12px",
                border: "1px solid var(--hairline)",
                background: "var(--ground)",
                fontFamily: "inherit",
                fontSize: "11px",
              }}
            >
              {SEVERITIES.map((sev) => (
                <option key={sev} value={sev}>
                  {sev}
                </option>
              ))}
            </select>
          </label>

          <label className="mono" style={{ fontSize: "10px", color: "var(--secondary)" }}>
            Category
            <select
              aria-label="Filter by category"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value as "ALL" | AbuseScenarioCategory)}
              style={{
                display: "block",
                marginTop: "4px",
                padding: "8px 12px",
                border: "1px solid var(--hairline)",
                background: "var(--ground)",
                fontFamily: "inherit",
                fontSize: "11px",
              }}
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <p className="mono" style={{ fontSize: "10px", color: "var(--muted)", margin: "0 0 12px" }}>
        Showing {filteredScenarios.length} of {report.total} scenarios
      </p>

      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "12px",
            textAlign: "left",
          }}
        >
          <thead>
            <tr
              className="mono"
              style={{
                borderBottom: "2px solid var(--hairline)",
                color: "var(--secondary)",
                fontSize: "10px",
              }}
            >
              <th style={{ padding: "10px 12px" }}>Severity</th>
              <th style={{ padding: "10px 12px" }}>Category</th>
              <th style={{ padding: "10px 12px" }}>Scenario &amp; Threat</th>
              <th style={{ padding: "10px 12px" }}>What Protects It</th>
              <th style={{ padding: "10px 12px" }}>Result</th>
            </tr>
          </thead>
          <tbody>
            {filteredScenarios.map((scenario) => {
              const badge = getSeverityStyle(scenario.severity);
              return (
                <tr
                  key={scenario.id}
                  style={{
                    borderBottom: "1px solid var(--hairline)",
                    verticalAlign: "top",
                  }}
                >
                  <td style={{ padding: "12px" }}>
                    <span
                      className="mono"
                      style={{
                        display: "inline-block",
                        padding: "3px 8px",
                        fontSize: "10px",
                        ...badge,
                      }}
                    >
                      {scenario.severity}
                    </span>
                  </td>
                  <td style={{ padding: "12px" }}>
                    <span className="mono" style={{ fontSize: "10px", color: "var(--secondary)" }}>
                      {scenario.category}
                    </span>
                  </td>
                  <td style={{ padding: "12px", maxWidth: "360px" }}>
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                      <span className="mono" style={{ fontSize: "10px", color: "var(--muted)" }}>
                        {scenario.id}
                      </span>{" "}
                      {scenario.name}
                    </div>
                    <div style={{ color: "var(--secondary)", lineHeight: 1.5 }}>
                      {scenario.threat}
                    </div>
                  </td>
                  <td style={{ padding: "12px", maxWidth: "340px", lineHeight: 1.5 }}>
                    {scenario.protects}
                  </td>
                  <td style={{ padding: "12px", whiteSpace: "nowrap" }}>
                    <span
                      className="mono"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "3px 8px",
                        fontSize: "10px",
                        background:
                          scenario.result === "PASS"
                            ? "rgba(16, 185, 129, 0.12)"
                            : "rgba(220, 38, 38, 0.12)",
                        color: scenario.result === "PASS" ? "#047857" : "#b91c1c",
                      }}
                    >
                      <span aria-hidden="true">{scenario.result === "PASS" ? "✓" : "✕"}</span>
                      {scenario.result === "PASS" ? "Blocked as expected" : "Check failed"}
                    </span>
                    <div
                      className="mono"
                      style={{ fontSize: "9px", color: "var(--muted)", marginTop: "4px" }}
                    >
                      {scenario.durationMs} ms
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};
