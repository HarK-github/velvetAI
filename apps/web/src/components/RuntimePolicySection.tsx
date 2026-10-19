import { useState } from "react";
import type { FC, CSSProperties } from "react";

interface PolicyTier {
  id: "low" | "elevated" | "high";
  label: string;
  ground: string;
  ink: string;
  accent: string;
  risk: string;
  deposit: string;
  rule: string;
}

const TIERS: PolicyTier[] = [
  {
    id: "low",
    label: "Low risk",
    ground: "#e4e4e2",
    ink: "#0d0d0f",
    accent: "#2f5bff",
    risk: "08%",
    deposit: "10%",
    rule: "BASELINE",
  },
  {
    id: "elevated",
    label: "Elevated",
    ground: "#efefee",
    ink: "#0d0d0f",
    accent: "#2f5bff",
    risk: "19%",
    deposit: "20%",
    rule: "REMINDER",
  },
  {
    id: "high",
    label: "High risk",
    ground: "#0d0d0f",
    ink: "#efefee",
    accent: "#7c97ff",
    risk: "31%",
    deposit: "30%",
    rule: "REVIEW",
  },
];

export const RuntimePolicySection: FC = () => {
  const [activeTier, setActiveTier] = useState<PolicyTier>(TIERS[0]!);

  const handleSelectTier = async (tier: PolicyTier) => {
    setActiveTier(tier);
    try {
      await fetch("http://localhost:3000/v1/risk/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: tier.id }),
      });
    } catch {
      // Offline fallback already active via state
    }
  };

  return (
    <section
      className="section field-swap"
      id="specification"
      aria-labelledby="policy-title"
      style={
        {
          "--field-ground": activeTier.ground,
          "--field-ink": activeTier.ink,
          "--field-accent": activeTier.accent,
        } as CSSProperties
      }
    >
      <span className="section-index mono">06 / Runtime policy field</span>

      <div className="section-inner">
        <div className="two-column">
          <div className="reveal">
            <p className="eyebrow mono">
              <span className="signal-dot" aria-hidden="true"></span>
              Deterministic tier simulator
            </p>

            <h2 className="display section-title" id="policy-title">
              Policy is code.
              <br />
              <span className="accent">Never prompt.</span>
            </h2>
          </div>

          <div className="section-copy reveal">
            <p className="lede">
              The statistical model returns a bounded probability. Merchant policy maps it to an
              exact deposit tier. Changing the variant repaints the entire field because risk state
              belongs to the whole decision—not a decorative swatch.
            </p>

            <div className="field-picker" aria-label="Select a risk-policy example">
              {TIERS.map((tier) => {
                const isSelected = activeTier.id === tier.id;
                return (
                  <button
                    key={tier.id}
                    className="field-button"
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => handleSelectTier(tier)}
                  >
                    {tier.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="field-panel reveal" aria-live="polite">
          <div className="field-cell">
            <span className="field-cell-label mono">No-show probability</span>
            <output className="field-cell-value" id="field-risk">
              {activeTier.risk}
            </output>
          </div>

          <div className="field-cell">
            <span className="field-cell-label mono">Deposit tier</span>
            <output className="field-cell-value" id="field-deposit">
              {activeTier.deposit}
            </output>
          </div>

          <div className="field-cell">
            <span className="field-cell-label mono">Policy route</span>
            <output className="field-cell-value" id="field-rule">
              {activeTier.rule}
            </output>
          </div>
        </div>

        <p className="spec-heading mono reveal">System specification / implemented boundaries</p>

        <div className="spec-columns reveal">
          <dl className="spec-list">
            <div className="spec-row">
              <dt>Runtime</dt>
              <dd>Node 24 LTS</dd>
            </div>
            <div className="spec-row">
              <dt>Interface</dt>
              <dd>React 19 / Vite</dd>
            </div>
            <div className="spec-row">
              <dt>API</dt>
              <dd>Fastify 5</dd>
            </div>
            <div className="spec-row">
              <dt>Database</dt>
              <dd>PostgreSQL 17+</dd>
            </div>
            <div className="spec-row">
              <dt>Queue</dt>
              <dd>BullMQ / Redis</dd>
            </div>
            <div className="spec-row">
              <dt>Architecture</dt>
              <dd>Modular monolith</dd>
            </div>
          </dl>

          <dl className="spec-list">
            <div className="spec-row">
              <dt>Payment</dt>
              <dd>PayPal sandbox</dd>
            </div>
            <div className="spec-row">
              <dt>Money</dt>
              <dd>BigInt minor</dd>
            </div>
            <div className="spec-row">
              <dt>Time</dt>
              <dd>UTC + IANA</dd>
            </div>
            <div className="spec-row">
              <dt>Concurrency</dt>
              <dd>GiST exclusion</dd>
            </div>
            <div className="spec-row">
              <dt>Webhook</dt>
              <dd>Signature verified</dd>
            </div>
            <div className="spec-row">
              <dt>Agent authority</dt>
              <dd>Proposal only</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
};
