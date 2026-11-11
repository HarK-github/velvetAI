import type { FC } from "react";

const PROTECTION_CARDS = [
  {
    id: "double-booking",
    eyebrow: "01 · POSTGRESQL GIST EXCLUSION",
    title: "Database prevents double booking",
    summary:
      "A PostgreSQL GiST exclusion constraint blocks overlapping time ranges for active holds and bookings on each resource atomically. Parallel races cannot sneak two winners into the same slot.",
  },
  {
    id: "human-approval",
    eyebrow: "02 · TWO-PHASE AGENT BOUNDARY",
    title: "Humans approve, AI can't pay",
    summary:
      "AI assistants can search slots and prepare a hold, but commit tools fail closed for models and M2M tokens reject with HUMAN_APPROVAL_REQUIRED. Only a signed-in human buyer confirms.",
  },
  {
    id: "signed-terms",
    eyebrow: "03 · ES256 SIGNED INTENT",
    title: "Signed booking terms",
    summary:
      "Prices, deposits, start times, and cancellation policy snapshots are locked inside an ES256-signed intent at hold creation. Any tampered price or swapped claim fails verification.",
  },
  {
    id: "one-time-approval",
    eyebrow: "04 · HASHED ONE-TIME TOKEN",
    title: "One-time approvals",
    summary:
      "Browser confirmations mint a 256-bit random token whose SHA-256 hash is locked FOR UPDATE and consumed inside one atomic DB transaction, blocking replays across new idempotency keys.",
  },
  {
    id: "tenant-isolation",
    eyebrow: "05 · FORCE ROW LEVEL SECURITY",
    title: "Tenant isolation",
    summary:
      "Every tenant-owned PostgreSQL table enforces FORCE ROW LEVEL SECURITY keyed on transaction-local app.tenant_id under a restricted NOBYPASSRLS runtime role.",
  },
  {
    id: "paypal-capture",
    eyebrow: "06 · CAPTURE-FINALITY LEDGER",
    title: "Payment confirmed only by PayPal capture",
    summary:
      "Bookings become CONFIRMED strictly after PayPal Orders v2 capture completes, while uncertain outcomes hold the slot and reconcile via verified webhooks into an append-only ledger.",
  },
] as const;

export const SecurityArchitectureCards: FC = () => {
  return (
    <section aria-labelledby="how-protections-work-heading" style={{ marginBottom: "64px" }}>
      <div style={{ marginBottom: "20px" }}>
        <p className="eyebrow mono" style={{ marginBottom: "8px" }}>
          <span className="signal-dot" aria-hidden="true"></span>
          DEFENSE IN DEPTH &bull; ARCHITECTURAL GUARANTEES
        </p>
        <h2
          id="how-protections-work-heading"
          className="display"
          style={{ fontSize: "clamp(22px, 2.8vw, 32px)" }}
        >
          How the protections work
        </h2>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "20px",
        }}
      >
        {PROTECTION_CARDS.map((card) => (
          <article
            key={card.id}
            style={{
              background: "#ffffff",
              border: "1px solid var(--hairline)",
              padding: "24px",
            }}
          >
            <div
              className="mono"
              style={{ fontSize: "10px", color: "var(--accent)", marginBottom: "10px" }}
            >
              {card.eyebrow}
            </div>
            <h3 style={{ margin: "0 0 10px", fontSize: "16px", fontWeight: 700 }}>{card.title}</h3>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--secondary)", lineHeight: 1.65 }}>
              {card.summary}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
};
