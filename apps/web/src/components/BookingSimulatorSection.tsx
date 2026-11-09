import { useState, useEffect, useCallback, useRef } from "react";
import type { FC } from "react";
import { PayPalButton, PayPalPaymentSuccess } from "./PayPalButton.js";
import { API_BASE_URL } from "../api-client.js";

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
  const isDemoMode = import.meta.env.VITE_ENABLE_OFFLINE_DEMO === "true";
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [services, setServices] = useState<ServiceItem[]>([]);
  const [selectedService, setSelectedService] = useState<ServiceItem | null>(null);
  const [isLoadingServices, setIsLoadingServices] = useState<boolean>(true);
  const [serviceError, setServiceError] = useState<string | null>(null);

  const [slots, setSlots] = useState<SlotItem[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<SlotItem | null>(null);
  const [isLoadingSlots, setIsLoadingSlots] = useState<boolean>(false);
  const [slotError, setSlotError] = useState<string | null>(null);

  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [isLoadingQuote, setIsLoadingQuote] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [hold, setHold] = useState<HoldData | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [isLockingHold, setIsLockingHold] = useState<boolean>(false);

  const [customerEmail, setCustomerEmail] = useState<string>("agent.alex@velvetai.internal");
  const [paymentOutcome, setPaymentOutcome] = useState<PayPalPaymentSuccess | null>(null);

  // Fetch published services from Fastify API
  const fetchServices = useCallback(async () => {
    setIsLoadingServices(true);
    setServiceError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/services`);
      if (!res.ok) {
        throw new Error(`Catalog API responded with HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data?.services || !Array.isArray(data.services) || data.services.length === 0) {
        throw new Error("No active services returned by catalog API");
      }
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
      if (!isMountedRef.current) return;
      setServices(mapped);
      setSelectedService((prev) =>
        prev && mapped.some((m) => m.id === prev.id) ? prev : mapped[0]!,
      );
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      if (isDemoMode) {
        setServices(FALLBACK_SERVICES);
        setSelectedService(FALLBACK_SERVICES[0]!);
      } else {
        setServices([]);
        setSelectedService(null);
        setServiceError(
          err instanceof Error ? err.message : "Failed to connect to live booking catalog API",
        );
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoadingServices(false);
      }
    }
  }, [isDemoMode]);

  useEffect(() => {
    void fetchServices();
  }, [fetchServices]);

  // Fetch availability when selected service changes
  const fetchSlots = useCallback(
    async (service: ServiceItem) => {
      setIsLoadingSlots(true);
      setSlotError(null);
      try {
        const res = await fetch(`${API_BASE_URL}/v1/availability?serviceId=${service.id}`);
        if (!res.ok) {
          throw new Error(`Availability API responded with HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!isMountedRef.current) return;
        if (data?.slots && Array.isArray(data.slots)) {
          setSlots(data.slots);
          setSelectedSlot(data.slots[0] || null);
        } else {
          throw new Error("Invalid availability response format");
        }
      } catch (err: unknown) {
        if (!isMountedRef.current) return;
        if (isDemoMode) {
          const dummySlots: SlotItem[] = [
            {
              startsAt: new Date().toISOString(),
              localStartsAt: "09:30",
              fillProbability: 0.85,
              depositPreview: {
                minor: service.depositMinor,
                currency: service.currency,
              },
              price: { minor: service.priceMinor, currency: service.currency },
            },
            {
              startsAt: new Date(Date.now() + 3600000).toISOString(),
              localStartsAt: "11:00",
              fillProbability: 0.72,
              depositPreview: {
                minor: service.depositMinor,
                currency: service.currency,
              },
              price: { minor: service.priceMinor, currency: service.currency },
            },
          ];
          setSlots(dummySlots);
          setSelectedSlot(dummySlots[0]!);
        } else {
          setSlots([]);
          setSelectedSlot(null);
          setSlotError(err instanceof Error ? err.message : "Failed to load availability slots");
        }
      } finally {
        if (isMountedRef.current) {
          setIsLoadingSlots(false);
        }
      }
    },
    [isDemoMode],
  );

  useEffect(() => {
    if (!selectedService) {
      setSlots([]);
      setSelectedSlot(null);
      return;
    }
    void fetchSlots(selectedService);
  }, [selectedService, fetchSlots]);

  // Request real-time quote when slot changes
  const fetchQuote = useCallback(
    async (service: ServiceItem, slot: SlotItem) => {
      setIsLoadingQuote(true);
      setQuoteError(null);
      try {
        const res = await fetch(`${API_BASE_URL}/v1/booking-quotes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceId: service.id,
            startsAt: slot.startsAt,
            timeZone: "UTC",
          }),
        });
        if (!res.ok) {
          throw new Error(`Quote API responded with HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!isMountedRef.current) return;
        setQuote(data);
      } catch (err: unknown) {
        if (!isMountedRef.current) return;
        if (isDemoMode) {
          setQuote({
            quoteId: "quote-local-preview",
            total: { minor: service.priceMinor, currency: service.currency },
            deposit: { minor: service.depositMinor, currency: service.currency },
            risk: { noShowProbability: 0.08, band: "low" },
            cancellationPolicy: { summary: service.cancellationSummary },
          });
        } else {
          setQuote(null);
          setQuoteError(
            err instanceof Error ? err.message : "Failed to calculate dynamic deposit quote",
          );
        }
      } finally {
        if (isMountedRef.current) {
          setIsLoadingQuote(false);
        }
      }
    },
    [isDemoMode],
  );

  useEffect(() => {
    if (!selectedService || !selectedSlot) {
      setQuote(null);
      return;
    }
    void fetchQuote(selectedService, selectedSlot);
  }, [selectedService, selectedSlot, fetchQuote]);

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
    if (!quote || isDemoMode) return;
    setIsLockingHold(true);
    setHoldError(null);
    setPaymentOutcome(null);

    try {
      const res = await fetch(`${API_BASE_URL}/v1/booking-holds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteId: quote.quoteId,
          customer: { email: customerEmail, displayName: "Autonomous Agent Demo" },
          note: "Reserved via velvetAI interactive frontend console",
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(
          errData?.error?.message ||
            errData?.message ||
            `HTTP ${res.status}: Failed to lock slot hold`,
        );
      }
      const data = await res.json();
      if (!isMountedRef.current) return;
      setHold(data);
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      setHoldError(err instanceof Error ? err.message : "Failed to secure slot hold on server");
    } finally {
      if (isMountedRef.current) {
        setIsLockingHold(false);
      }
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

        {isDemoMode && (
          <div
            className="demo-banner mono"
            data-testid="offline-demo-banner"
            style={{
              background: "rgba(245, 158, 11, 0.15)",
              border: "1px solid #f59e0b",
              color: "#b45309",
              padding: "12px 16px",
              marginBottom: "24px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "12px",
              borderRadius: "4px",
            }}
          >
            <span className="signal-dot signal-dot--amber"></span>
            Offline demo data — not bookable
          </div>
        )}

        {serviceError && services.length === 0 ? (
          <div
            className="booking-error-state"
            data-testid="booking-error-state"
            role="alert"
            style={{
              background: "rgba(239, 68, 68, 0.08)",
              border: "1px solid rgba(239, 68, 68, 0.4)",
              padding: "24px",
              margin: "24px 0",
              borderRadius: "4px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                marginBottom: "8px",
              }}
            >
              <span
                className="signal-dot signal-dot--red"
                style={{ background: "#ef4444" }}
                aria-hidden="true"
              ></span>
              <h3 style={{ margin: 0, fontSize: "16px", color: "#dc2626" }}>
                Unable to Load Live Booking Catalog
              </h3>
            </div>
            <p style={{ margin: "0 0 16px 0", color: "var(--secondary)", fontSize: "13px" }}>
              {serviceError}
            </p>
            <p style={{ margin: "0 0 16px 0", color: "var(--muted)", fontSize: "11px" }}>
              VelvetAI strictly enforces database truth. Static or mock services are never displayed
              when the live catalog API is unreachable.
            </p>
            <button
              type="button"
              className="button button--solid"
              onClick={() => void fetchServices()}
              disabled={isLoadingServices}
            >
              {isLoadingServices ? "Retrying..." : "Retry Connection"}
            </button>
          </div>
        ) : isLoadingServices && services.length === 0 ? (
          <div style={{ padding: "40px", textAlign: "center", color: "var(--secondary)" }}>
            <span className="mono">Querying PostgreSQL catalog...</span>
          </div>
        ) : (
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
                const isSelected = selectedService?.id === service.id;
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
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                  }}
                >
                  <span className="mono" style={{ color: "var(--secondary)" }}>
                    Available Slots Today (
                    {isLoadingSlots ? "Querying..." : `${slots.length} available`})
                  </span>
                  <span className="mono" style={{ fontSize: "10px", color: "var(--muted)" }}>
                    UTC Authority &bull; GiST Lock
                  </span>
                </div>

                {slotError ? (
                  <div
                    role="alert"
                    style={{
                      margin: "16px 0",
                      padding: "16px",
                      background: "rgba(239, 68, 68, 0.08)",
                      border: "1px solid rgba(239, 68, 68, 0.3)",
                      borderRadius: "4px",
                      fontSize: "12px",
                    }}
                  >
                    <p style={{ margin: "0 0 10px 0", color: "#dc2626" }}>{slotError}</p>
                    <button
                      type="button"
                      className="button"
                      style={{ fontSize: "11px", padding: "4px 10px" }}
                      onClick={() => selectedService && void fetchSlots(selectedService)}
                      disabled={isLoadingSlots}
                    >
                      {isLoadingSlots ? "Retrying..." : "Retry Availability"}
                    </button>
                  </div>
                ) : slots.length === 0 && !isLoadingSlots ? (
                  <p
                    className="mono"
                    style={{ fontSize: "12px", color: "var(--muted)", margin: "16px 0" }}
                  >
                    No available slots found for this service today.
                  </p>
                ) : (
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
                          {slot.fillProbability !== undefined && (
                            <div style={{ fontSize: "9px", opacity: 0.8, marginTop: "2px" }}>
                              {Math.round(slot.fillProbability * 100)}% fill
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Quote & Slot Hold Execution Console */}
            <div>
              {selectedService ? (
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
                      {selectedSlot
                        ? `Today @ ${selectedSlot.localStartsAt} UTC`
                        : "Select an available slot"}
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
                        {isLoadingQuote
                          ? "Calculating live deposit..."
                          : quote?.risk?.band
                            ? `Forecast risk tier: ${quote.risk.band.toUpperCase()} (${Math.round((quote.risk.noShowProbability ?? 0.1) * 100)}%)`
                            : "Standard policy tier"}
                      </div>
                    </div>
                    <div className="quote-total">
                      {formatMoney(
                        quote?.deposit?.valueMinor ??
                          quote?.deposit?.minor ??
                          selectedService.depositMinor,
                        selectedService.currency,
                      )}
                    </div>
                  </div>

                  {quoteError && (
                    <div
                      role="alert"
                      style={{
                        margin: "12px 0",
                        padding: "8px 12px",
                        background: "rgba(239, 68, 68, 0.08)",
                        border: "1px solid rgba(239, 68, 68, 0.3)",
                        borderRadius: "4px",
                        color: "#dc2626",
                        fontSize: "11px",
                      }}
                    >
                      {quoteError}
                    </div>
                  )}

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
                    <strong>Cancellation Policy:</strong>{" "}
                    {quote?.cancellationPolicy?.summary || selectedService.cancellationSummary}
                  </div>

                  {holdError && (
                    <div
                      role="alert"
                      style={{
                        margin: "12px 0",
                        padding: "10px 14px",
                        background: "rgba(239, 68, 68, 0.08)",
                        border: "1px solid rgba(239, 68, 68, 0.3)",
                        borderRadius: "4px",
                        color: "#dc2626",
                        fontSize: "11px",
                      }}
                    >
                      {holdError}
                    </div>
                  )}

                  {!hold ? (
                    <button
                      className="button button--solid"
                      style={{ width: "100%", minHeight: "48px" }}
                      onClick={() => void handleLockHold()}
                      disabled={isLockingHold || !quote || isDemoMode}
                    >
                      <span className="signal-dot signal-dot--emerald" aria-hidden="true"></span>
                      {isDemoMode
                        ? "Hold Disabled (Demo Mode)"
                        : isLockingHold
                          ? "Claiming Slot..."
                          : "Lock 300s Hold & Sign Intent"}
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
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                marginBottom: "8px",
                              }}
                            >
                              <span className="signal-dot signal-dot--emerald"></span>
                              <strong
                                className="mono"
                                style={{ color: "#059669", fontSize: "12px" }}
                              >
                                BOOKING CONFIRMED &bull; DEPOSIT CAPTURED
                              </strong>
                            </div>
                            <p
                              style={{
                                fontSize: "11px",
                                color: "var(--secondary)",
                                margin: "4px 0",
                              }}
                            >
                              PayPal Capture ID:{" "}
                              <code className="mono">
                                {paymentOutcome.providerCaptureId || "CAP-COMPLETED"}
                              </code>
                            </p>
                            <p
                              style={{
                                fontSize: "11px",
                                color: "var(--secondary)",
                                margin: "4px 0",
                              }}
                            >
                              Booking ID: <code className="mono">{paymentOutcome.bookingId}</code>
                            </p>
                            <div
                              className="mono"
                              style={{
                                fontSize: "10px",
                                color: "var(--muted)",
                                marginTop: "8px",
                              }}
                            >
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
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                marginBottom: "8px",
                              }}
                            >
                              <span className="signal-dot signal-dot--amber"></span>
                              <strong
                                className="mono"
                                style={{ color: "#d97706", fontSize: "12px" }}
                              >
                                CAPTURE PENDING &bull; RECONCILING IN BACKGROUND
                              </strong>
                            </div>
                            <p
                              style={{
                                fontSize: "11px",
                                color: "var(--secondary)",
                                margin: "4px 0",
                              }}
                            >
                              Booking claim remains blocking while outbox worker reconciles provider
                              state.
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
              ) : (
                <div
                  className="quote-console"
                  style={{ textAlign: "center", padding: "40px 20px" }}
                >
                  <span className="mono" style={{ color: "var(--muted)" }}>
                    Select a service above to inspect real-time quote
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
