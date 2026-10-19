import type { FC } from "react";
import { Link, useRouter } from "../router.js";

interface NavbarProps {
  apiHealthy: boolean;
  apiLatency: number | null;
}

export const Navbar: FC<NavbarProps> = ({ apiHealthy, apiLatency }) => {
  const { currentPath } = useRouter();

  return (
    <nav className="site-nav" aria-label="Primary navigation">
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label="velvetAI home">
          velvetAI<span className="brand-period">.</span>
        </Link>

        <div className="nav-actions">
          <div className="nav-links" aria-label="Page sections">
            <Link
              to="/"
              className="nav-link"
              style={{
                borderColor: currentPath === "/" ? "var(--accent)" : "transparent",
                color: currentPath === "/" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/" ? 600 : 500,
              }}
            >
              Overview
            </Link>
            <Link
              to="/book"
              className="nav-link"
              style={{
                borderColor: currentPath === "/book" ? "var(--accent)" : "transparent",
                color: currentPath === "/book" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/book" ? 600 : 500,
              }}
            >
              Book Slot
            </Link>
            <Link
              to="/schedule"
              className="nav-link"
              style={{
                borderColor: currentPath === "/schedule" ? "var(--accent)" : "transparent",
                color: currentPath === "/schedule" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/schedule" ? 600 : 500,
              }}
            >
              Schedule
            </Link>
            <Link
              to="/policy"
              className="nav-link"
              style={{
                borderColor: currentPath === "/policy" ? "var(--accent)" : "transparent",
                color: currentPath === "/policy" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/policy" ? 600 : 500,
              }}
            >
              Policy & Spec
            </Link>
            <Link
              to="/status"
              className="nav-link"
              style={{
                borderColor: currentPath === "/status" ? "var(--accent)" : "transparent",
                color: currentPath === "/status" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/status" ? 600 : 500,
              }}
            >
              API Status
            </Link>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Link
              to="/status"
              className="mono"
              style={{
                fontSize: "10px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                color: apiHealthy ? "var(--ink)" : "var(--muted)",
                cursor: "pointer",
              }}
              title={apiHealthy ? `API Live (${apiLatency}ms)` : "Connecting to API..."}
            >
              <span
                className={`signal-dot ${apiHealthy ? "signal-dot--emerald" : ""}`}
                aria-hidden="true"
              ></span>
              {apiHealthy ? `API ${apiLatency ?? 0}ms` : "API Syncing"}
            </Link>

            <Link to="/book" className="button button--solid">
              <span className="signal-dot" aria-hidden="true"></span>
              Book Now
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
};
