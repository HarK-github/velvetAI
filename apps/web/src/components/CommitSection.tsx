import type { FC } from "react";

export const CommitSection: FC = () => {
  return (
    <section className="section close-section" id="close" aria-labelledby="close-title">
      <span className="section-index mono">07 / Commit</span>

      <div className="section-inner close-layout">
        <div className="reveal">
          <p className="eyebrow mono">
            <span className="signal-dot" aria-hidden="true"></span>
            Booking state / payment state / one agreement
          </p>

          <h2 className="display close-title" id="close-title">
            Book the slot.
            <br />
            Prove the payment.
            <br />
            <span className="accent">Keep control.</span>
          </h2>
        </div>

        <div className="close-actions reveal">
          <p className="lede">
            Autonomous discovery with deterministic execution. Every booking remains attributable,
            bounded and recoverable.
          </p>

          <div className="button-row">
            <a className="button button--solid" href="#top">
              <span className="signal-dot" aria-hidden="true"></span>
              Restart system
            </a>
            <a className="button" href="#specification">
              Read specification
            </a>
            <a className="button" href="#simulator">
              Interactive demo
            </a>
          </div>

          <p className="fine-print">
            No testimonials. No invented customer counts. No decorative benchmarks. Every numerical
            promise shown above is either a policy constant or computed in this document.
          </p>
        </div>
      </div>

      <footer className="footer-strip mono">
        <span>PayPal sandbox</span>
        <span>PostgreSQL authority</span>
        <span>Agent Abuse Lab</span>
        <span>Build 01 / 2026</span>
      </footer>

      <div className="close-word-wrap" aria-hidden="true">
        <div className="close-word">VELVETAI</div>
      </div>
    </section>
  );
};
