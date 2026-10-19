import { useMemo } from "react";
import type { FC } from "react";

export const ComputedProofSection: FC = () => {
  const { referencePath, controlledPath, referenceRms, controlledRms, ratio } = useMemo(() => {
    const sampleCount = 720;
    const widthStart = 34;
    const widthEnd = 766;
    const centreY = 170;
    const pixelsPerUnit = 6.3;

    const referenceValues: number[] = [];
    const controlledValues: number[] = [];

    for (let index = 0; index < sampleCount; index += 1) {
      const t = index / (sampleCount - 1);

      const reference =
        10.8 * Math.sin(t * Math.PI * 8.2) +
        5.6 * Math.sin(t * Math.PI * 21.1 + 0.7) +
        2.9 * Math.sin(t * Math.PI * 51.4 + 1.2);

      const controlled =
        1.65 * Math.sin(t * Math.PI * 8.2) +
        0.72 * Math.sin(t * Math.PI * 21.1 + 0.7) +
        0.36 * Math.sin(t * Math.PI * 51.4 + 1.2);

      referenceValues.push(reference);
      controlledValues.push(controlled);
    }

    const toPath = (values: number[]) => {
      return values
        .map((value, index) => {
          const progress = index / (values.length - 1);
          const x = widthStart + progress * (widthEnd - widthStart);
          const y = centreY - value * pixelsPerUnit;
          return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
        })
        .join(" ");
    };

    const rms = (values: number[]) => {
      const meanSquare = values.reduce((sum, value) => sum + value * value, 0) / values.length;
      return Math.sqrt(meanSquare);
    };

    const refRms = rms(referenceValues);
    const ctrlRms = rms(controlledValues);
    const rat = (refRms / ctrlRms).toFixed(1);

    return {
      referencePath: toPath(referenceValues),
      controlledPath: toPath(controlledValues),
      referenceRms: `${refRms.toFixed(2)} RMS`,
      controlledRms: `${ctrlRms.toFixed(2)} RMS`,
      ratio: `${rat}×`,
    };
  }, []);

  return (
    <section className="section proof" id="proof" aria-labelledby="proof-title">
      <span className="section-index mono">03 / Computed proof</span>

      <div className="section-inner proof-grid">
        <div className="reveal">
          <p className="eyebrow mono">
            <span className="signal-dot" aria-hidden="true"></span>
            Deterministic contention simulation / 720 samples
          </p>

          <h2 className="display proof-title" id="proof-title">
            Races become state.
            <br />
            <span style={{ color: "var(--accent-lift)" }}>Not damage.</span>
          </h2>

          <p className="lede">
            Both traces use the same scale. The figure is calculated at runtime from the RMS
            displacement of two deterministic signals—not typed into the page as an unsupported
            claim.
          </p>

          <div className="proof-figure">
            <output className="proof-number" id="proof-number">
              {ratio}
            </output>
            <span className="proof-unit mono" id="proof-unit">
              Lower RMS state drift / same scale
            </span>
          </div>

          <div className="trace-legend mono">
            <span className="legend-item">
              <span className="legend-line"></span>
              Unlocked client state
              <output style={{ marginLeft: "6px" }}>{referenceRms}</output>
            </span>

            <span className="legend-item">
              <span className="legend-line legend-line--accent"></span>
              Database claim
              <output style={{ marginLeft: "6px" }}>{controlledRms}</output>
            </span>
          </div>
        </div>

        <div className="reveal">
          <svg
            className="proof-chart"
            viewBox="0 0 800 360"
            role="img"
            aria-labelledby="trace-title trace-description"
          >
            <title id="trace-title">Same-scale state drift comparison</title>
            <desc id="trace-description">
              A wandering reference trace and a controlled trace computed from deterministic sine
              terms on the same vertical scale.
            </desc>

            <rect className="chart-frame" x="34" y="24" width="732" height="292"></rect>
            <line className="chart-guide" x1="34" y1="170" x2="766" y2="170"></line>
            <line className="chart-guide" x1="34" y1="97" x2="766" y2="97"></line>
            <line className="chart-guide" x1="34" y1="243" x2="766" y2="243"></line>

            <text className="chart-label" x="34" y="342">
              T+000
            </text>
            <text className="chart-label" x="705" y="342">
              T+720
            </text>
            <text className="chart-label" x="42" y="88">
              +SCALE
            </text>
            <text className="chart-label" x="42" y="264">
              −SCALE
            </text>

            <path id="reference-trace" className="trace-reference" d={referencePath}></path>

            <path id="controlled-trace" className="trace-controlled" d={controlledPath}></path>
          </svg>
        </div>
      </div>
    </section>
  );
};
