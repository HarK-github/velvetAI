import { useState, useEffect } from "react";
import type { FC } from "react";
import { PayPalButton, PayPalPaymentSuccess } from "./PayPalButton.js";

interface ServiceItem {
  id: string;
  name: string;
  category: string;
  durationMinutes: number;
  priceMinor: number;
  depositMinor: number;
  currency: string;
  cancellationSummary: string;
}

interface SlotItem {
  startsAt: string;
  localStartsAt: string;
  fillProbability?: number;
  depositPreview: { valueMinor?: number; minor?: number; currency: string };
  price: { valueMinor?: number; minor?: number; currency: string };
}

interface QuoteData {
  quoteId: string;
  total: { valueMinor?: number; minor?: number; currency: string };
  deposit: { valueMinor?: number; minor?: number; currency: string };
  risk?: { noShowProbability: number; band: string };
  cancellationPolicy: { summary: string };
}

interface HoldData {
  bookingId: string;
  status: string;
  holdExpiresAt: string;
  signedIntent: string;
}

const FALLBACK_SERVICES: ServiceItem[] = [
  {
    id: "01932b10-0001-7000-8000-000000000001",
    name: "Executive Haircut & Beard Sculpt",
    category: "Salon & Grooming",
    durationMinutes: 45,
    priceMinor: 7500,
    depositMinor: 2000,
    currency: "USD",
    cancellationSummary: "100% deposit refund until 24 hours before appointment.",
  },
  {
    id: "01932b10-0001-7000-8000-000000000002",
    name: "Deep Tissue & Mobility Session",
    category: "Wellness & Recovery",
    durationMinutes: 60,
    priceMinor: 12000,
    depositMinor: 3500,
    currency: "USD",
    cancellationSummary: "Full deposit refund up to 48 hours prior; 50% thereafter.",
  },
  {
    id: "01932b10-0001-7000-8000-000000000003",
    name: "Private Acoustic Studio Block",
    category: "Creative Studios",
    durationMinutes: 120,
    priceMinor: 16000,
    depositMinor: 5000,
    currency: "USD",
    cancellationSummary: "Non-refundable deposit within 72 hours of session start.",
  },
];

export const BookingSimulatorSection: FC = () => {
  const [services, setServices] = useState<ServiceItem[]>(FALLBACK_SERVICES);
  const [selectedService, setSelectedService] = useState<ServiceItem>(FALLBACK_SERVICES[0]!);
  const [slots, setSlots] = useState<SlotItem[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<SlotItem | null>(null);
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [hold, setHold] = useState<HoldData | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [isLoadingSlots, setIsLoadingSlots] = useState<boolean>(false);
  const [isLockingHold, setIsLockingHold] = useState<boolean>(false);
  const [customerEmail, setCustomerEmail] = useState<string>("agent.alex@velvetai.internal");
  const [paymentOutcome, setPaymentOutcome] = useState<PayPalPaymentSuccess | null>(null);

  // Fetch published services from Fastify API
  useEffect(() => {
    fetch("http://localhost:3000/v1/services")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.services && Array.isArray(data.services)) {
          const mapped: ServiceItem[] = data.services.map(
            (s: {
              id: string;
              versions?: Array<{
                name?: string;
                durationMinutes?: number;
                priceMinor?: number;
                baseDepositMinor?: number;
                currency?: string;
              }>;
            }) => {
              const v = s.versions?.[0] || {};
              return {
                id: s.id,
                name: v.name || "Custom Service",
                category: "Verified Service",
                durationMinutes: v.durationMinutes || 45,
                priceMinor: v.priceMinor || 7500,
                depositMinor: v.baseDepositMinor || 2000,
                currency: v.currency || "USD",
                cancellationSummary: "100% deposit refund until 24 hours before appointment.",
              };
            },
          );
          if (mapped.length > 0) {
            setServices(mapped);
            setSelectedService(mapped[0]!);
          }
        }
      })
      .catch(() => {
        // Fallback already pre-populated
      });
  }, []);

  // Fetch availability when selected service changes
  useEffect(() => {
    setIsLoadingSlots(true);
    fetch(`http://localhost:3000/v1/availability?serviceId=${selectedService.id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.slots && Array.isArray(data.slots)) {
          setSlots(data.slots);
          setSelectedSlot(data.slots[0] || null);
        } else {
          // Local fallback slots
          const dummySlots: SlotItem[] = [
            {
              startsAt: new Date().toISOString(),
              localStartsAt: "09:30",
              fillProbability: 0.85,
              depositPreview: {
                minor: selectedService.depositMinor,
                currency: selectedService.currency,
              },
              price: { minor: selectedService.priceMinor, currency: selectedService.currency },
            },
            {
              startsAt: new Date(Date.now() + 3600000).toISOString(),
              localStartsAt: "11:00",
              fillProbability: 0.72,
              depositPreview: {
                minor: selectedService.depositMinor,
                currency: selectedService.currency,
              },
              price: { minor: selectedService.priceMinor, currency: selectedService.currency },
            },
            {
              startsAt: new Date(Date.now() + 7200000).toISOString(),
              localStartsAt: "13:30",
              fillProbability: 0.94,
              depositPreview: {
                minor: selectedService.depositMinor,
                currency: selectedService.currency,
              },
              price: { minor: selectedService.priceMinor, currency: selectedService.currency },
            },
            {
              startsAt: new Date(Date.now() + 10800000).toISOString(),
              localStartsAt: "15:00",
              fillProbability: 0.61,
              depositPreview: {
                minor: selectedService.depositMinor,
                currency: selectedService.currency,
              },
              price: { minor: selectedService.priceMinor, currency: selectedService.currency },
            },
          ];
          setSlots(dummySlots);
          setSelectedSlot(dummySlots[0]!);
        }
      })
      .catch(() => {
        setSlots([]);
      })
      .finally(() => {
        setIsLoadingSlots(false);
      });
  }, [selectedService]);

  // Request real-time quote when slot changes
  useEffect(() => {
    if (!selectedSlot) return;

    fetch("http://localhost:3000/v1/booking-quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId: selectedService.id,
        startsAt: selectedSlot.startsAt,
        timeZone: "UTC",
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setQuote(data);
        }
      })
      .catch(() => {
        setQuote({
          quoteId: "quote-local-preview",
          total: { minor: selectedService.priceMinor, currency: selectedService.currency },
          deposit: { minor: selectedService.depositMinor, currency: selectedService.currency },
          risk: { noShowProbability: 0.08, band: "low" },
          cancellationPolicy: { summary: selectedService.cancellationSummary },
        });
      });
  }, [selectedService, selectedSlot]);

  // Handle countdown timer when hold is active
  useEffect(() => {
    if (!hold?.holdExpiresAt) {
      setRemainingSeconds(null);
      return;
    }

    const interval = setInterval(() => {
      const diff = Math.max(
        0,
        Math.floor((new Date(hold.holdExpiresAt).getTime() - Date.now()) / 1000),
      );
      setRemainingSeconds(diff);
      if (diff <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [hold]);

  const handleLockHold = async () => {
    if (!quote) return;
    setIsLockingHold(true);
    setPaymentOutcome(null);

    try {
      const res = await fetch("http://localhost:3000/v1/booking-holds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteId: quote.quoteId,
          customer: { email: customerEmail, displayName: "Autonomous Agent Demo" },
          note: "Reserved via velvetAI interactive frontend console",
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setHold(data);
      }
    } catch {
      // Fallback local hold simulation
      setHold({
        bookingId: "01932b10-simulated-hold-0001",
        status: "HELD",
        holdExpiresAt: new Date(Date.now() + 300 * 1000).toISOString(),
        signedIntent: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzaW0iLCJleHAiOjMwMH0.signature-preview",
      });
    } finally {
      setIsLockingHold(false);
    }
  };

  const formatMoney = (minor: number, currency: string) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(minor / 100);
  };

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  return (
    <section className="section simulator-section" id="simulator" aria-labelledby="simulator-title">
      <span className="section-index mono">05 / Interactive Console</span>

      <div className="section-inner">
        <div className="reveal">
          <p className="eyebrow mono">
            <span className="signal-dot signal-dot--emerald" aria-hidden="true"></span>
            Live PostgreSQL + Fastify Integration
          </p>

          <h2 className="display section-title" id="simulator-title">
            Book the slot.
            <br />
            <span className="accent">Test live policy.</span>
          </h2>

          <p className="lede">
            Execute real-time service queries, demand forecasts, deposit tier calculations, and
            300-second slot holds backed by cryptographic JWS signed intents.
          </p>
        </div>

        <div className="simulator-grid reveal">
          {/* Left Column: Service & Slot Selection */}
          <div>
            <span
              className="mono"
              style={{ color: "var(--secondary)", display: "block", marginBottom: "16px" }}
            >
              Select Published Service
            </span>

            {services.map((service) => {
              const isSelected = selectedService.id === service.id;
              return (
                <div
                  key={service.id}
                  className={`service-card ${isSelected ? "service-card--active" : ""}`}
                  onClick={() => setSelectedService(service)}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                    }}
                  >
                    <div>
                      <span className="mono" style={{ color: "var(--accent)", fontSize: "10px" }}>
                        {service.category} &bull; {service.durationMinutes} MIN
                      </span>
                      <h3
                        style={{
                          fontFamily: "Archivo, sans-serif",
                          fontSize: "18px",
                          margin: "4px 0",
                        }}
                      >
                        {service.name}
                      </h3>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div
                        style={{
                          fontFamily: "Archivo, sans-serif",
                          fontWeight: 800,
                          fontSize: "18px",
                        }}
                      >
                        {formatMoney(service.priceMinor, service.currency)}
                      </div>
                      <div className="mono" style={{ fontSize: "10px", color: "var(--muted)" }}>
                        Base Deposit: {formatMoney(service.depositMinor, service.currency)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            <div style={{ marginTop: "32px" }}>
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}
              >
                <span className="mono" style={{ color: "var(--secondary)" }}>
                  Available Slots Today (
                  {isLoadingSlots ? "Querying..." : `${slots.length} available`})
                </span>
                <span className="mono" style={{ fontSize: "10px", color: "var(--muted)" }}>
                  UTC Authority &bull; GiST Lock
                </span>
              </div>

              <div className="slot-grid">
                {slots.map((slot) => {
                  const isSelected = selectedSlot?.localStartsAt === slot.localStartsAt;
                  return (
                    <button
                      key={slot.localStartsAt}
                      type="button"
                      className={`slot-button ${isSelected ? "slot-button--active" : ""}`}
                      onClick={() => setSelectedSlot(slot)}
                    >
                      <div style={{ fontWeight: 600 }}>{slot.localStartsAt}</div>
                      {slot.fillProbability && (
                        <div style={{ fontSize: "9px", opacity: 0.8, marginTop: "2px" }}>
                          {Math.round(slot.fillProbability * 100)}% fill
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Column: Quote & Slot Hold Execution Console */}
          <div>
            <div className="quote-console">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "20px",
                }}
              >
                <span className="mono" style={{ color: "var(--accent)" }}>
                  01 / Live Quote Snapshot
                </span>

                {remainingSeconds !== null && (
                  <div className="countdown-badge mono">
                    <span className="signal-dot signal-dot--emerald"></span>
                    HOLD: {formatTimer(remainingSeconds)}
                  </div>
                )}
              </div>

              <div className="quote-line">
                <span style={{ color: "var(--secondary)" }}>Service</span>
                <span style={{ fontWeight: 600 }}>{selectedService.name}</span>
              </div>

              <div className="quote-line">
                <span style={{ color: "var(--secondary)" }}>Selected Time</span>
                <span style={{ fontWeight: 600 }}>
                  Today @ {selectedSlot?.localStartsAt || "09:30"} UTC
                </span>
              </div>

              <div className="quote-line">
                <span style={{ color: "var(--secondary)" }}>Full Price</span>
                <span>{formatMoney(selectedService.priceMinor, selectedService.currency)}</span>
              </div>

              <div className="quote-line" style={{ borderBottom: "2px solid var(--ink)" }}>
                <div>
                  <div style={{ fontWeight: 700 }}>Required Deposit Due</div>
                  <div className="mono" style={{ fontSize: "10px", color: "var(--muted)" }}>
                    Forecast risk tier: Low (10-25%)
                  </div>
                </div>
                <div className="quote-total">
                  {formatMoney(
                    quote?.deposit.valueMinor ??
                      quote?.deposit.minor ??
                      selectedService.depositMinor,
                    selectedService.currency,
                  )}
                </div>
              </div>

              <div style={{ margin: "20px 0" }}>
                <label
                  className="mono"
                  style={{
                    fontSize: "10px",
                    color: "var(--secondary)",
                    display: "block",
                    marginBottom: "6px",
                  }}
                >
                  Customer / Agent Identity (OIDC Verified)
                </label>
                <input
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    fontFamily: "IBM Plex Mono, monospace",
                    fontSize: "11px",
                    border: "1px solid var(--hairline)",
                    background: "var(--ground)",
                  }}
                />
              </div>

              <div
                style={{
                  marginBottom: "24px",
                  fontSize: "11px",
                  color: "var(--secondary)",
                  lineHeight: 1.5,
                }}
              >
                <strong>Cancellation Policy:</strong> {selectedService.cancellationSummary}
              </div>

              {!hold ? (
                <button
                  className="button button--solid"
                  style={{ width: "100%", minHeight: "48px" }}
                  onClick={handleLockHold}
                  disabled={isLockingHold}
                >
                  <span className="signal-dot signal-dot--emerald" aria-hidden="true"></span>
                  {isLockingHold ? "Claiming Slot..." : "Lock 300s Hold & Sign Intent"}
                </button>
              ) : (
                <div>
                  <div
                    style={{
                      background: "rgba(16, 185, 129, 0.08)",
                      border: "1px solid rgba(16, 185, 129, 0.3)",
                      padding: "16px",
                      marginBottom: "16px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginBottom: "6px",
                      }}
                    >
                      <span className="mono" style={{ color: "#059669", fontWeight: 700 }}>
                        &bull; Slot Held (GiST Claim Locked)
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: "10px", color: "var(--secondary)" }}
                      >
                        {formatTimer(remainingSeconds ?? 300)} left
                      </span>
                    </div>
                    <div className="mono" style={{ fontSize: "10px", wordBreak: "break-all" }}>
                      Booking ID: {hold.bookingId}
                    </div>
                  </div>

                  <div style={{ marginBottom: "16px" }}>
                    <span
                      className="mono"
                      style={{
                        fontSize: "9px",
                        color: "var(--muted)",
                        display: "block",
                        marginBottom: "4px",
                      }}
                    >
                      Cryptographic JWS Signed Intent (HMAC-SHA256):
                    </span>
                    <pre
                      style={{
                        background: "var(--ink)",
                        color: "var(--accent-lift)",
                        padding: "12px",
                        fontSize: "9px",
                        overflowX: "auto",
                        maxHeight: "80px",
                        margin: 0,
                      }}
                    >
                      {hold.signedIntent}
                    </pre>
                  </div>

                  {paymentOutcome ? (
                    paymentOutcome.bookingStatus === "CONFIRMED" ? (
                      <div
                        style={{
                          background: "rgba(16, 185, 129, 0.12)",
                          border: "1px solid rgba(16, 185, 129, 0.4)",
                          padding: "20px",
                          marginTop: "16px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                          <span className="signal-dot signal-dot--emerald"></span>
                          <strong className="mono" style={{ color: "#059669", fontSize: "12px" }}>
                            BOOKING CONFIRMED &bull; DEPOSIT CAPTURED
                          </strong>
                        </div>
                        <p style={{ fontSize: "11px", color: "var(--secondary)", margin: "4px 0" }}>
                          PayPal Capture ID:{" "}
                          <code className="mono">{paymentOutcome.providerCaptureId || "CAP-COMPLETED"}</code>
                        </p>
                        <p style={{ fontSize: "11px", color: "var(--secondary)", margin: "4px 0" }}>
                          Booking ID: <code className="mono">{paymentOutcome.bookingId}</code>
                        </p>
                        <div className="mono" style={{ fontSize: "10px", color: "var(--muted)", marginTop: "8px" }}>
                          Double-entry journal posted &bull; Balanced ledger recorded
                        </div>
                        <button
                          type="button"
                          className="button"
                          style={{ marginTop: "12px", width: "100%", fontSize: "11px" }}
                          onClick={() => {
                            setHold(null);
                            setPaymentOutcome(null);
                          }}
                        >
                          Book Another Appointment &rarr;
                        </button>
                      </div>
                    ) : (
                      <div
                        style={{
                          background: "rgba(245, 158, 11, 0.12)",
                          border: "1px solid rgba(245, 158, 11, 0.4)",
                          padding: "20px",
                          marginTop: "16px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                          <span className="signal-dot signal-dot--amber"></span>
                          <strong className="mono" style={{ color: "#d97706", fontSize: "12px" }}>
                            CAPTURE PENDING &bull; RECONCILING IN BACKGROUND
                          </strong>
                        </div>
                        <p style={{ fontSize: "11px", color: "var(--secondary)", margin: "4px 0" }}>
                          Booking claim remains blocking while outbox worker reconciles provider state.
                        </p>
                      </div>
                    )
                  ) : (
                    <PayPalButton
                      bookingId={hold.bookingId}
                      onPaymentOutcome={(outcome) => setPaymentOutcome(outcome)}
                      onPaymentExpired={() => {
                        setHold(null);
                        setPaymentOutcome(null);
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
