import type { FC } from "react";
import { BookingSimulatorSection } from "../components/BookingSimulatorSection.js";
import { Link } from "../router.js";

export const BookingPage: FC = () => {
  return (
    <div style={{ paddingTop: "var(--nav-height)" }}>
      {/* Page Hero Header */}
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
                CUSTOMER BOOKING ENGINE &bull; 300-SECOND GiST RESERVATION
              </p>
              <h1
                className="display"
                style={{ fontSize: "clamp(36px, 5.5vw, 68px)", maxWidth: "800px" }}
              >
                Select service.
                <br />
                <span className="accent">Lock guaranteed slot.</span>
              </h1>
              <p className="lede" style={{ marginTop: "16px" }}>
                Directly interact with velvetAI's versioned catalog and real-time availability
                engine. When you reserve, PostgreSQL secures the slot with an exclusion claim
                preventing any double booking.
              </p>
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <Link to="/schedule" className="button">
                View Schedule &rarr;
              </Link>
              <Link to="/policy" className="button">
                Risk Policies &rarr;
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Main Interactive Booking Console */}
      <BookingSimulatorSection />
    </div>
  );
};
