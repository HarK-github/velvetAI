import type { FC } from "react";

export const ProtocolSection: FC = () => {
  return (
    <section className="section protocol" id="protocol" aria-labelledby="protocol-title">
      <span className="section-index mono">02 / Protocol</span>

      <div className="section-inner two-column">
        <div className="protocol-intro reveal">
          <p className="eyebrow mono">
            <span className="signal-dot" aria-hidden="true"></span>
            One application state
          </p>

          <h2 className="display section-title" id="protocol-title">
            One booking.
            <br />
            Four surfaces.
            <br />
            <span className="accent">No split truth.</span>
          </h2>

          <p className="lede">
            REST, MCP, WebMCP and Ask AI call the same typed command handlers. Agents propose.
            Deterministic policy decides. PostgreSQL remains the authority for every slot and
            financial transition.
          </p>
        </div>

        <dl className="protocol-list reveal">
          <div className="data-row">
            <dt>REST</dt>
            <dd>Canonical browser and merchant operations</dd>
            <output>01</output>
          </div>

          <div className="data-row">
            <dt>MCP</dt>
            <dd>Delegated agent tools through scoped OAuth</dd>
            <output>02</output>
          </div>

          <div className="data-row">
            <dt>WebMCP</dt>
            <dd>Progressive browser-agent discovery layer</dd>
            <output>03</output>
          </div>

          <div className="data-row">
            <dt>Ask AI</dt>
            <dd>In-page intent translation with bounded tools</dd>
            <output>04</output>
          </div>

          <div className="data-row">
            <dt>Tenant context</dt>
            <dd>Derived from authenticated membership only</dd>
            <output>Required</output>
          </div>

          <div className="data-row">
            <dt>AI financial authority</dt>
            <dd>Models may explain but never authorize money</dd>
            <output>00</output>
          </div>
        </dl>
      </div>
    </section>
  );
};
