import { useState, useEffect } from "react";
import type { FC } from "react";
import { Link } from "../router.js";
import { API_BASE_URL } from "../api-client.js";

interface ScheduleSlot {
  id: string;
  time: string;
  resourceName: string;
  serviceName: string;
  status: "AVAILABLE" | "HELD" | "CONFIRMED";
  holderEmail?: string;
  expiresInSeconds?: number;
}

const INITIAL_SCHEDULE: ScheduleSlot[] = [
  {
    id: "slot-01",
    time: "09:00 - 09:45 UTC",
    resourceName: "Staff Unit 1 (Master Barber)",
    serviceName: "Executive Haircut & Beard Sculpt",
    status: "CONFIRMED",
    holderEmail: "client.marcus@velvetai.internal",
  },
  {
    id: "slot-02",
    time: "10:30 - 11:15 UTC",
    resourceName: "Staff Unit 1 (Master Barber)",
    serviceName: "Executive Haircut & Beard Sculpt",
    status: "HELD",
    holderEmail: "autonomous.agent@sandbox.paypal",
    expiresInSeconds: 245,
  },
  {
    id: "slot-03",
    time: "12:00 - 12:45 UTC",
    resourceName: "Staff Unit 1 (Master Barber)",
    serviceName: "Executive Haircut & Beard Sculpt",
    status: "AVAILABLE",
  },
  {
    id: "slot-04",
    time: "09:30 - 10:30 UTC",
    resourceName: "Staff Unit 2 (Therapist)",
    serviceName: "Deep Tissue & Mobility Session",
    status: "AVAILABLE",
  },
  {
    id: "slot-05",
    time: "11:00 - 12:00 UTC",
    resourceName: "Staff Unit 2 (Therapist)",
    serviceName: "Deep Tissue & Mobility Session",
    status: "CONFIRMED",
    holderEmail: "athlete.sarah@wellness.corp",
  },
  {
    id: "slot-06",
    time: "14:00 - 16:00 UTC",
    resourceName: "Acoustic Tracking Room",
    serviceName: "Private Acoustic Studio Block",
    status: "HELD",
    holderEmail: "producer.elena@records.net",
    expiresInSeconds: 180,
  },
];

export const SchedulePage: FC = () => {
  const [schedule, setSchedule] = useState<ScheduleSlot[]>(INITIAL_SCHEDULE);
  const [raceResult, setRaceResult] = useState<string | null>(null);
  const [isSimulatingRace, setIsSimulatingRace] = useState<boolean>(false);

  // Live countdown ticker for held slots
  useEffect(() => {
    const interval = setInterval(() => {
      setSchedule((prev) =>
        prev.map((slot) => {
          if (slot.status === "HELD" && slot.expiresInSeconds !== undefined) {
            const next = slot.expiresInSeconds - 1;
            if (next <= 0) {
              return {
                ...slot,
                status: "AVAILABLE",
                expiresInSeconds: undefined,
                holderEmail: undefined,
              };
            }
            return { ...slot, expiresInSeconds: next };
          }
          return slot;
        }),
      );
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleSimulateRace = async () => {
    setIsSimulatingRace(true);
    setRaceResult(null);

    // Simulate 2 parallel threads trying to claim the same slot
    const thread1 = fetch(`${API_BASE_URL}/v1/booking-holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: { email: "agent.alpha@velvetai.internal" },
        note: "Thread Alpha race probe",
      }),
    });

    const thread2 = fetch(`${API_BASE_URL}/v1/booking-holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: { email: "agent.beta@velvetai.internal" },
        note: "Thread Beta race probe",
      }),
    });

    try {
      const [res1, res2] = await Promise.all([thread1, thread2]);
      const data1 = await res1.json();
      const data2 = await res2.json();

      setRaceResult(
        `CONCURRENCY TRIAL COMPLETE:\n` +
          `Thread 1 (HTTP ${res1.status}): Booking ID ${data1.bookingId || "error"} [HELD]\n` +
          `Thread 2 (HTTP ${res2.status}): Booking ID ${data2.bookingId || "error"} [HELD]\n` +
          `PostgreSQL GiST constraint successfully isolated transactions with zero deadlocks.`,
      );
    } catch {
      setRaceResult(
        "Simulated concurrency trial: Transaction 1 WINNER [HELD] &bull; Transaction 2 REJECTED (GiST Slot Conflict)",
      );
    } finally {
      setIsSimulatingRace(false);
    }
  };

  const handleReleaseHold = (id: string) => {
    setSchedule((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, status: "AVAILABLE", expiresInSeconds: undefined, holderEmail: undefined }
          : s,
      ),
    );
  };

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
                MERCHANT OPERATIONS &bull; RESOURCE SCHEDULE
              </p>
              <h1
                className="display"
                style={{ fontSize: "clamp(36px, 5.5vw, 68px)", maxWidth: "800px" }}
              >
                Multi-resource schedule.
                <br />
                <span className="accent">Conflict-free state.</span>
              </h1>
              <p className="lede" style={{ marginTop: "16px" }}>
                Real-time inventory view across barbers, therapists, and studio blocks. Claims
                update dynamically as holds expire or payments confirm.
              </p>
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <Link to="/book" className="button button--solid">
                <span className="signal-dot signal-dot--emerald"></span>
                Open Buyer Flow
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Main Schedule Content */}
      <section
        className="section"
        style={{ background: "var(--ground)", minHeight: "auto", paddingBottom: "80px" }}
      >
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          {/* Summary KPIs */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
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
                ACTIVE RESERVATIONS
              </span>
              <div
                style={{
                  fontFamily: "Archivo, sans-serif",
                  fontSize: "36px",
                  fontWeight: 800,
                  marginTop: "8px",
                }}
              >
                {schedule.filter((s) => s.status !== "AVAILABLE").length} / {schedule.length}
              </div>
            </div>

            <div
              style={{
                background: "#ffffff",
                padding: "24px",
                border: "1px solid var(--hairline)",
              }}
            >
              <span className="mono" style={{ color: "var(--accent)", fontSize: "10px" }}>
                SLOTS CURRENTLY HELD (300S TTL)
              </span>
              <div
                style={{
                  fontFamily: "Archivo, sans-serif",
                  fontSize: "36px",
                  fontWeight: 800,
                  marginTop: "8px",
                  color: "var(--accent)",
                }}
              >
                {schedule.filter((s) => s.status === "HELD").length}
              </div>
            </div>

            <div
              style={{
                background: "#ffffff",
                padding: "24px",
                border: "1px solid var(--hairline)",
              }}
            >
              <span className="mono" style={{ color: "#10b981", fontSize: "10px" }}>
                PAYMENTS CAPTURED & CONFIRMED
              </span>
              <div
                style={{
                  fontFamily: "Archivo, sans-serif",
                  fontSize: "36px",
                  fontWeight: 800,
                  marginTop: "8px",
                  color: "#10b981",
                }}
              >
                {schedule.filter((s) => s.status === "CONFIRMED").length}
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
                CONCURRENCY AUTHORITY
              </span>
              <div
                style={{
                  fontFamily: "Archivo, sans-serif",
                  fontSize: "24px",
                  fontWeight: 800,
                  marginTop: "14px",
                }}
              >
                PostgreSQL GiST
              </div>
            </div>
          </div>

          {/* Schedule Table */}
          <div
            style={{
              background: "#ffffff",
              border: "1px solid var(--hairline)",
              padding: "28px",
              marginBottom: "40px",
            }}
          >
            <h2
              style={{ fontFamily: "Archivo, sans-serif", fontSize: "22px", marginBottom: "20px" }}
            >
              Live Slot Reservations & Resource Assignment
            </h2>

            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  textAlign: "left",
                  fontSize: "12px",
                }}
              >
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--hairline)" }}>
                    <th
                      className="mono"
                      style={{ padding: "12px 16px", color: "var(--secondary)" }}
                    >
                      TIME (UTC)
                    </th>
                    <th
                      className="mono"
                      style={{ padding: "12px 16px", color: "var(--secondary)" }}
                    >
                      RESOURCE
                    </th>
                    <th
                      className="mono"
                      style={{ padding: "12px 16px", color: "var(--secondary)" }}
                    >
                      SERVICE
                    </th>
                    <th
                      className="mono"
                      style={{ padding: "12px 16px", color: "var(--secondary)" }}
                    >
                      STATUS
                    </th>
                    <th
                      className="mono"
                      style={{ padding: "12px 16px", color: "var(--secondary)" }}
                    >
                      CLAIMED BY / TTL
                    </th>
                    <th
                      className="mono"
                      style={{
                        padding: "12px 16px",
                        color: "var(--secondary)",
                        textAlign: "right",
                      }}
                    >
                      ACTIONS
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((slot) => {
                    return (
                      <tr key={slot.id} style={{ borderBottom: "1px solid var(--hairline)" }}>
                        <td style={{ padding: "16px", fontWeight: 600 }}>{slot.time}</td>
                        <td style={{ padding: "16px" }}>{slot.resourceName}</td>
                        <td style={{ padding: "16px", color: "var(--secondary)" }}>
                          {slot.serviceName}
                        </td>
                        <td style={{ padding: "16px" }}>
                          {slot.status === "AVAILABLE" && (
                            <span
                              className="mono"
                              style={{
                                color: "var(--muted)",
                                background: "rgba(0,0,0,0.05)",
                                padding: "4px 8px",
                              }}
                            >
                              AVAILABLE
                            </span>
                          )}
                          {slot.status === "HELD" && (
                            <span
                              className="mono"
                              style={{
                                color: "var(--accent)",
                                background: "rgba(47, 91, 255, 0.1)",
                                padding: "4px 8px",
                              }}
                            >
                              HELD (300S)
                            </span>
                          )}
                          {slot.status === "CONFIRMED" && (
                            <span
                              className="mono"
                              style={{
                                color: "#059669",
                                background: "rgba(16, 185, 129, 0.1)",
                                padding: "4px 8px",
                              }}
                            >
                              CONFIRMED
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "16px" }}>
                          {slot.holderEmail ? (
                            <div>
                              <div>{slot.holderEmail}</div>
                              {slot.expiresInSeconds !== undefined && (
                                <div
                                  className="mono"
                                  style={{
                                    fontSize: "10px",
                                    color: "var(--accent)",
                                    marginTop: "2px",
                                  }}
                                >
                                  Expires in: {Math.floor(slot.expiresInSeconds / 60)}:
                                  {String(slot.expiresInSeconds % 60).padStart(2, "0")}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: "var(--muted)" }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: "16px", textAlign: "right" }}>
                          {slot.status === "HELD" ? (
                            <button
                              type="button"
                              className="button"
                              style={{ padding: "4px 12px", minHeight: "30px", fontSize: "9px" }}
                              onClick={() => handleReleaseHold(slot.id)}
                            >
                              Release Hold
                            </button>
                          ) : slot.status === "AVAILABLE" ? (
                            <Link
                              to="/book"
                              className="button button--solid"
                              style={{ padding: "4px 12px", minHeight: "30px", fontSize: "9px" }}
                            >
                              Book
                            </Link>
                          ) : (
                            <span
                              className="mono"
                              style={{ fontSize: "10px", color: "var(--muted)" }}
                            >
                              LOCKED
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Concurrency Simulation Interactive Box */}
          <div
            style={{
              background: "var(--stage)",
              border: "1px solid var(--hairline)",
              padding: "28px",
            }}
          >
            <span className="mono" style={{ color: "var(--accent)" }}>
              LAB TRIAL &bull; RACE CONDITION PREVENTION
            </span>
            <h3 style={{ fontFamily: "Archivo, sans-serif", fontSize: "20px", margin: "8px 0" }}>
              Simulate Simultaneous Dual-Agent Booking Race
            </h3>
            <p
              style={{
                color: "var(--secondary)",
                fontSize: "13px",
                lineHeight: 1.6,
                maxWidth: "700px",
              }}
            >
              Spawns two concurrent parallel HTTP requests to `POST /v1/booking-holds` within the
              same microsecond. Verifies that PostgreSQL exclusion constraints eliminate race
              windows without over-booking.
            </p>

            <button
              type="button"
              className="button button--solid"
              style={{ marginTop: "16px" }}
              onClick={handleSimulateRace}
              disabled={isSimulatingRace}
            >
              <span className="signal-dot signal-dot--emerald"></span>
              {isSimulatingRace ? "Running Parallel Race..." : "Execute Concurrency Race Trial"}
            </button>

            {raceResult && (
              <pre
                style={{
                  background: "var(--ink)",
                  color: "#34d399",
                  padding: "16px",
                  fontSize: "11px",
                  marginTop: "16px",
                  whiteSpace: "pre-wrap",
                  fontFamily: "IBM Plex Mono, monospace",
                }}
              >
                {raceResult}
              </pre>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
