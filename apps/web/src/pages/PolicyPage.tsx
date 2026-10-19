import type { FC } from "react";
import { RuntimePolicySection } from "../components/RuntimePolicySection.js";
import { Link } from "../router.js";

export const PolicyPage: FC = () => {
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
                <span className="signal-dot" aria-hidden="true"></span>
                POLICY ENGINE &bull; DETERMINISTIC SPECIFICATION
              </p>
              <h1
                className="display"
                style={{ fontSize: "clamp(36px, 5.5vw, 68px)", maxWidth: "800px" }}
              >
                Policy is code.
                <br />
                <span className="accent">Never prompt.</span>
              </h1>
              <p className="lede" style={{ marginTop: "16px" }}>
                AI models propose actions, but deterministic code controls all financial decisions.
                Statistical demand forecasts map strictly to immutable deposit policies and
                cancellation boundaries.
              </p>
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <Link to="/book" className="button button--solid">
                <span className="signal-dot signal-dot--emerald"></span>
                Book Slot
              </Link>
              <Link to="/status" className="button">
                System Status &rarr;
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Interactive Policy Section */}
      <RuntimePolicySection />
    </div>
  );
};
