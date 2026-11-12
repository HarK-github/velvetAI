import { useState, useEffect, useCallback, useRef } from "react";
import type { FC } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { PayPalButton, PayPalPaymentSuccess } from "./PayPalButton.js";
import { API_BASE_URL, apiClient } from "../api-client.js";
import { isAuth0Configured, isMockAuthEnabled } from "../lib/auth-config.js";
import {
  AccountProvisioningNotice,
  isUserNotProvisionedError,
} from "./AccountProvisioningNotice.js";
import { Link } from "../router.js";

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
  endsAt?: string;
  localStartsAt: string;
  locationId?: string;
  resourceId?: string;
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
  const [showProofDetails, setShowProofDetails] = useState<boolean>(false);

  const { isAuthenticated, user, loginWithRedirect } = useAuth0();
  const [customerEmail, setCustomerEmail] = useState<string>(() => user?.email || "");
  const [paymentOutcome, setPaymentOutcome] = useState<PayPalPaymentSuccess | null>(null);

  useEffect(() => {
    if (user?.email && !customerEmail) {
      setCustomerEmail(user.email);
    }
  }, [user?.email, customerEmail]);

  const canQuote =
    isDemoMode ||
    isAuthenticated ||
    Boolean(apiClient.getAuthToken()) ||
    (!isAuth0Configured() && isMockAuthEnabled());

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
        const data = await apiClient.createBookingQuote({
          serviceId: service.id,
          locationId: slot.locationId || "01932b10-0000-7000-8000-000000000001",
          startsAt: slot.startsAt,
          timeZone: "UTC",
        });
        if (!isMountedRef.current) return;
        setQuote(data as unknown as QuoteData);
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
            isUserNotProvisionedError(err)
              ? "user_not_provisioned"
              : err instanceof Error
                ? err.message
                : "Failed to calculate dynamic deposit quote",
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
    if (!selectedService || !selectedSlot || !canQuote) {
      setQuote(null);
      return;
    }
    void fetchQuote(selectedService, selectedSlot);
  }, [selectedService, selectedSlot, canQuote, fetchQuote]);

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
      const data = await apiClient.createBookingHold({
        quoteId: quote.quoteId,
        serviceId: selectedService?.id,
        locationId: selectedSlot?.locationId,
        startsAt: selectedSlot?.startsAt,
        timeZone: "UTC",
        customer: { email: customerEmail, displayName: "Autonomous Agent Demo" },
        note: "Reserved via velvetAI interactive frontend console",
      });
      if (!isMountedRef.current) return;
      setHold(data as unknown as HoldData);
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      setHoldError(
        isUserNotProvisionedError(err)
          ? "user_not_provisioned"
          : err instanceof Error
            ? err.message
            : "Failed to secure slot hold on server",
      );
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
    <section className="simulator-section" id="simulator" aria-labelledby="simulator-title" style={{ padding: "40px var(--page-padding) 80px" }}>
      <div className="section-inner">
        <div className="reveal" style={{ marginBottom: "28px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
            <div>
              <p className="eyebrow mono" style={{ marginBottom: "12px" }}>
                <span className="signal-dot signal-dot--emerald" aria-hidden="true"></span>
                CUSTOMER BOOKING ENGINE &bull; 300s GiST GUARANTEE
              </p>

              <h1 className="display section-title" id="simulator-title" style={{ fontSize: "clamp(32px, 4.5vw, 56px)", margin: 0 }}>
                Select service. <span className="accent">Lock guaranteed slot.</span>
              </h1>

              <p className="lede" style={{ marginTop: "12px", maxWidth: "60ch" }}>
                Directly interact with velvetAI's PostgreSQL catalog and real-time availability engine.
                When you reserve, an exclusion lock guarantees no double bookings during checkout.
              </p>
            </div>

            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <Link to="/schedule" className="button button--outline button--sm">
                View Schedule &rarr;
              </Link>
              <Link to="/policy" className="button button--outline button--sm">
                Risk Policies &rarr;
              </Link>
            </div>
          </div>
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--ink)" }}>
                  1. Select Published Service
                </span>
                <span className="mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
                  {services.length} services loaded
                </span>
              </div>

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
                        alignItems: "flex-start",
                        gap: "16px",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                          <span
                            className="mono"
                            style={{
                              color: isSelected ? "var(--accent)" : "var(--secondary)",
                              fontSize: "10px",
                              background: isSelected ? "rgba(30, 64, 175, 0.08)" : "var(--surface-sunken)",
                              padding: "2px 6px",
                              borderRadius: "4px",
                            }}
                          >
                            {service.category}
                          </span>
                          <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                            ⏱ {service.durationMinutes} min
                          </span>
                        </div>
                        <h3
                          style={{
                            fontFamily: "Archivo, sans-serif",
                            fontSize: "17px",
                            fontWeight: 700,
                            margin: "6px 0 2px",
                            color: "var(--ink)",
                          }}
                        >
                          {service.name}
                        </h3>
                        <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--secondary)", lineHeight: 1.4 }}>
                          {service.cancellationSummary}
                        </p>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div
                          style={{
                            fontFamily: "Archivo, sans-serif",
                            fontWeight: 800,
                            fontSize: "20px",
                            color: isSelected ? "var(--accent)" : "var(--ink)",
                          }}
                        >
                          {formatMoney(service.priceMinor, service.currency)}
                        </div>
                        <div className="mono" style={{ fontSize: "11px", color: "var(--muted)", marginTop: "2px" }}>
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
                    alignItems: "center",
                    marginBottom: "12px",
                  }}
                >
                  <div>
                    <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--ink)" }}>
                      2. Available Slots Today
                    </span>
                    <span style={{ fontSize: "12px", color: "var(--muted)", marginLeft: "8px" }}>
                      ({isLoadingSlots ? "Querying..." : `${slots.length} available`})
                    </span>
                  </div>
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
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                  >
                    <p style={{ margin: "0 0 10px 0", color: "#dc2626" }}>{slotError}</p>
                    <button
                      type="button"
                      className="button button--sm"
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
                            <div style={{ fontSize: "10px", opacity: 0.8, marginTop: "2px" }}>
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
                      marginBottom: "16px",
                    }}
                  >
                    <span className="mono" style={{ color: "var(--accent)", fontWeight: 600 }}>
                      RESERVATION MANIFEST
                    </span>

                    {remainingSeconds !== null && (
                      <div className="countdown-badge mono">
                        <span className="signal-dot signal-dot--emerald"></span>
                        HOLD: {formatTimer(remainingSeconds)}
                      </div>
                    )}
                  </div>

                  {remainingSeconds !== null && (
                    <div style={{ marginBottom: "18px" }}>
                      <div
                        style={{
                          width: "100%",
                          height: "6px",
                          background: "rgba(0,0,0,0.06)",
                          borderRadius: "999px",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.min(100, Math.max(0, ((remainingSeconds ?? 300) / 300) * 100))}%`,
                            height: "100%",
                            background:
                              remainingSeconds < 60 ? "var(--accent-coral)" : "var(--accent-emerald)",
                            transition: "width 1s linear",
                          }}
                        />
                      </div>
                    </div>
                  )}

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

                  {!canQuote && (
                    <div
                      role="status"
                      style={{
                        margin: "16px 0",
                        padding: "12px 16px",
                        background: "rgba(30, 64, 175, 0.06)",
                        border: "1px solid rgba(30, 64, 175, 0.2)",
                        borderRadius: "var(--radius-sm)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "12px",
                        fontSize: "13px",
                      }}
                    >
                      <span style={{ fontWeight: 500 }}>Sign in to get a live quote</span>
                      {typeof loginWithRedirect === "function" && (
                        <button
                          type="button"
                          className="button button--primary button--sm"
                          onClick={() => {
                            void loginWithRedirect({
                              appState: {
                                returnTo:
                                  typeof window !== "undefined"
                                    ? `${window.location.pathname}${window.location.search}`
                                    : "/book",
                              },
                            });
                          }}
                        >
                          Sign in
                        </button>
                      )}
                    </div>
                  )}

                  {quoteError &&
                    (quoteError === "user_not_provisioned" ? (
                      <div style={{ margin: "12px 0" }}>
                        <AccountProvisioningNotice
                          onRetry={() => {
                            if (selectedService && selectedSlot) {
                              void fetchQuote(selectedService, selectedSlot);
                            }
                          }}
                          retrying={isLoadingQuote}
                        />
                      </div>
                    ) : (
                      <div
                        role="alert"
                        style={{
                          margin: "12px 0",
                          padding: "10px 14px",
                          background: "rgba(239, 68, 68, 0.08)",
                          border: "1px solid rgba(239, 68, 68, 0.3)",
                          borderRadius: "var(--radius-sm)",
                          color: "#dc2626",
                          fontSize: "12px",
                        }}
                      >
                        {quoteError}
                      </div>
                    ))}

                  <div style={{ margin: "18px 0" }}>
                    <label
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
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
                      placeholder="you@example.com"
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "10px 14px",
                        fontFamily: "inherit",
                        fontSize: "13px",
                        border: "1px solid var(--hairline-strong)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--surface)",
                        color: "var(--ink)",
                        outline: "none",
                      }}
                    />
                  </div>

                  <div
                    style={{
                      marginBottom: "20px",
                      fontSize: "12px",
                      color: "var(--secondary)",
                      lineHeight: 1.5,
                      background: "var(--surface-sunken)",
                      padding: "10px 12px",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    <strong style={{ color: "var(--ink)" }}>Cancellation Policy:</strong>{" "}
                    {quote?.cancellationPolicy?.summary || selectedService.cancellationSummary}
                  </div>

                  {holdError &&
                    (holdError === "user_not_provisioned" ? (
                      <div style={{ margin: "12px 0" }}>
                        <AccountProvisioningNotice
                          onRetry={() => void handleLockHold()}
                          retrying={isLockingHold}
                        />
                      </div>
                    ) : (
                      <div
                        role="alert"
                        style={{
                          margin: "12px 0",
                          padding: "10px 14px",
                          background: "rgba(239, 68, 68, 0.08)",
                          border: "1px solid rgba(239, 68, 68, 0.3)",
                          borderRadius: "var(--radius-sm)",
                          color: "#dc2626",
                          fontSize: "12px",
                        }}
                      >
                        {holdError}
                      </div>
                    ))}

                  {!hold ? (
                    <button
                      className="button button--solid"
                      style={{ width: "100%", minHeight: "46px", fontSize: "14px", fontWeight: 600 }}
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
                          borderRadius: "var(--radius-sm)",
                          padding: "14px",
                          marginBottom: "16px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginBottom: "4px",
                          }}
                        >
                          <span className="mono" style={{ color: "#059669", fontWeight: 700 }}>
                            &bull; Slot Held (GiST Claim Locked)
                          </span>
                          <span
                            className="mono"
                            style={{ fontSize: "11px", color: "var(--secondary)" }}
                          >
                            {formatTimer(remainingSeconds ?? 300)} left
                          </span>
                        </div>
                        <div className="mono" style={{ fontSize: "11px", color: "var(--secondary)", wordBreak: "break-all" }}>
                          Booking ID: {hold.bookingId}
                        </div>
                      </div>

                      {/* Technical Cryptographic Proof Accordion */}
                      <div style={{ marginBottom: "16px" }}>
                        <button
                          type="button"
                          onClick={() => setShowProofDetails(!showProofDetails)}
                          style={{
                            background: "transparent",
                            border: "none",
                            padding: "4px 0",
                            fontSize: "11px",
                            fontWeight: 600,
                            color: "var(--muted)",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          <span>{showProofDetails ? "▾ Hide" : "▸ Show"} Cryptographic JWS Signed Intent (HMAC-SHA256)</span>
                        </button>
                        {showProofDetails && (
                          <pre
                            style={{
                              background: "var(--ink)",
                              color: "var(--accent-lift)",
                              padding: "10px 12px",
                              borderRadius: "6px",
                              fontSize: "9px",
                              overflowX: "auto",
                              maxHeight: "90px",
                              margin: "6px 0 0",
                            }}
                          >
                            {hold.signedIntent}
                          </pre>
                        )}
                      </div>

                      {paymentOutcome ? (
                        paymentOutcome.bookingStatus === "CONFIRMED" ? (
                          <div
                            style={{
                              background: "rgba(16, 185, 129, 0.12)",
                              border: "1px solid rgba(16, 185, 129, 0.4)",
                              borderRadius: "var(--radius-sm)",
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
                                fontSize: "12px",
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
                                fontSize: "12px",
                                color: "var(--secondary)",
                                margin: "4px 0",
                              }}
                            >
                              Booking ID: <code className="mono">{paymentOutcome.bookingId}</code>
                            </p>
                            <div
                              className="mono"
                              style={{
                                fontSize: "11px",
                                color: "var(--muted)",
                                marginTop: "8px",
                              }}
                            >
                              Double-entry journal posted &bull; Balanced ledger recorded
                            </div>
                            <button
                              type="button"
                              className="button button--solid"
                              style={{ marginTop: "14px", width: "100%", fontSize: "12px" }}
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
                              borderRadius: "var(--radius-sm)",
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
                                fontSize: "12px",
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
                  style={{ textAlign: "center", padding: "48px 24px" }}
                >
                  <p style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 600, color: "var(--ink)" }}>
                    Ready to Book
                  </p>
                  <span style={{ fontSize: "13px", color: "var(--muted)" }}>
                    Select a service on the left to configure your appointment and calculate the deposit.
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
