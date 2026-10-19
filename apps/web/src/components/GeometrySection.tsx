import { Fragment } from "react";
import type { FC } from "react";

export const GeometrySection: FC = () => {
  const startX = 70;
  const endX = 800;
  const axisY = 406;
  const totalSeconds = 300;

  const xForSecond = (second: number) => startX + (second / totalSeconds) * (endX - startX);

  const ticks = [0, 60, 120, 180, 240, 300];

  const events = [
    { second: 0, label: "QUOTE", value: "T+000", labelY: 90 },
    { second: 30, label: "HOLD LOCKED", value: "T+030", labelY: 151 },
    { second: 120, label: "CONFIRM TOKEN EXPIRES", value: "T+120", labelY: 62 },
    { second: 240, label: "PAYMENT BOUNDARY", value: "T+240", labelY: 130 },
    { second: 300, label: "HOLD EXPIRES", value: "T+300", labelY: 82 },
  ];

  const pathYForSecond = (second: number) => {
    if (second < 30) return 406;
    if (second < 120) return 344;
    if (second < 240) return 276;
    return 216;
  };

  return (
    <section className="section geometry" id="geometry" aria-labelledby="geometry-title">
      <span className="section-index mono">04 / Temporal geometry</span>

      <div className="section-inner geometry-grid">
        <div className="reveal">
          <p className="eyebrow mono">
            <span className="signal-dot" aria-hidden="true"></span>
            Hold lifecycle / real seconds
          </p>

          <h2 className="display section-title" id="geometry-title">
            300 seconds.
            <br />
            <span className="accent">Drawn to scale.</span>
          </h2>

          <p className="lede">
            Quote, hold, buyer confirmation and expiry are represented on one real-time axis. The
            heavier line is the booking lifecycle; leaders identify exact policy boundaries.
          </p>

          <dl className="definition-list">
            <div className="data-row">
              <dt>Hold TTL</dt>
              <dd>Maximum unpaid reservation window</dd>
              <output>300 s</output>
            </div>

            <div className="data-row">
              <dt>Confirm token</dt>
              <dd>One-time consequential approval</dd>
              <output>120 s</output>
            </div>

            <div className="data-row">
              <dt>Tool budget</dt>
              <dd>Maximum tools in one agent run</dd>
              <output>20 calls</output>
            </div>

            <div className="data-row">
              <dt>Concurrency</dt>
              <dd>PostgreSQL exclusion constraint</dd>
              <output>GiST</output>
            </div>
          </dl>
        </div>

        <figure className="technical-figure reveal" aria-label="Booking hold lifecycle">
          <svg
            id="timing-diagram"
            className="technical-svg"
            viewBox="0 0 860 520"
            role="img"
            aria-labelledby="timing-title timing-desc"
          >
            <title id="timing-title">Five-minute booking hold lifecycle</title>
            <desc id="timing-desc">
              A scale drawing from zero to three hundred seconds with quote, confirmation, payment
              and expiry boundaries.
            </desc>

            <line className="construction-line" x1="70" y1="406" x2="800" y2="406"></line>

            {/* Grid ticks */}
            {ticks.map((sec) => {
              const x = xForSecond(sec);
              return (
                <Fragment key={sec}>
                  <line className="construction-line" x1={x} y1={120} x2={x} y2={axisY + 16} />
                  <text className="technical-label" x={x} y={axisY + 43} textAnchor="middle">
                    {sec}s
                  </text>
                </Fragment>
              );
            })}

            {/* Timing path */}
            <path
              id="timing-path"
              className="timing-line"
              d="M70 406 L143 406 L143 344 L362 344 L362 276 L654 276 L654 216 L800 216"
            ></path>

            {/* Event Markers & Leaders */}
            {events.map((evt, idx) => {
              const x = xForSecond(evt.second);
              const pathY = pathYForSecond(evt.second);
              const isLast = idx === events.length - 1;
              const labelX = isLast ? x - 14 : x + 14;
              const anchor = isLast ? "end" : "start";

              return (
                <Fragment key={evt.second}>
                  <line className="leader-line" x1={x} y1={pathY} x2={x} y2={evt.labelY + 16} />
                  <circle className="technical-point" cx={x} cy={pathY} r={6} />
                  <text className="technical-label" x={labelX} y={evt.labelY} textAnchor={anchor}>
                    {evt.label}
                  </text>
                  <text
                    className="technical-value"
                    x={labelX}
                    y={evt.labelY + 18}
                    textAnchor={anchor}
                  >
                    {evt.value}
                  </text>
                </Fragment>
              );
            })}
          </svg>
        </figure>
      </div>
    </section>
  );
};
