import { useRef, useEffect, useState } from "react";
import type { FC } from "react";

export const StateRotorSection: FC = () => {
  const sectionRef = useRef<HTMLElement>(null);
  const [rotation, setRotation] = useState<number>(0);
  const [marqueeShift, setMarqueeShift] = useState<number>(12);

  useEffect(() => {
    const handleScroll = () => {
      if (!sectionRef.current) return;
      const rect = sectionRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const travel = Math.max(sectionRef.current.offsetHeight - viewportHeight, 1);
      const progress = Math.min(1, Math.max(0, -rect.top / travel));

      setRotation(progress * 540);
      setMarqueeShift(12 - progress * 44);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <section className="motion-section" id="engine" ref={sectionRef} aria-labelledby="engine-label">
      <div className="motion-stage">
        <div
          className="stage-marquee"
          aria-hidden="true"
          style={{ transform: `translate3d(${marqueeShift.toFixed(2)}vw, -50%, 0)` }}
        >
          <span>BOOKING ENGINE</span>
          <span>BOOKING ENGINE</span>
          <span>BOOKING ENGINE</span>
        </div>

        <div className="stage-product">
          <svg viewBox="0 0 600 600" role="img" aria-labelledby="stage-product-title">
            <title id="stage-product-title">A rotating appointment-state instrument</title>

            <defs>
              <radialGradient id="stage-metal" cx="34%" cy="28%" r="78%">
                <stop offset="0" stopColor="#ffffff"></stop>
                <stop offset="0.42" stopColor="#b5b6b9"></stop>
                <stop offset="0.76" stopColor="#4e4f54"></stop>
                <stop offset="1" stopColor="#111215"></stop>
              </radialGradient>

              <linearGradient id="stage-inner" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#f5f5f3"></stop>
                <stop offset="1" stopColor="#77787d"></stop>
              </linearGradient>
            </defs>

            <circle
              cx="300"
              cy="300"
              r="278"
              fill="url(#stage-metal)"
              stroke="#0d0d0f"
              strokeWidth="4"
            ></circle>

            <circle
              cx="300"
              cy="300"
              r="230"
              fill="#17181b"
              stroke="#efefee"
              strokeWidth="3"
            ></circle>

            <g
              className="stage-rotor"
              id="stage-rotor"
              style={{ transform: `rotate(${rotation.toFixed(2)}deg)` }}
            >
              <circle
                cx="300"
                cy="300"
                r="190"
                fill="url(#stage-inner)"
                stroke="#0d0d0f"
                strokeWidth="4"
              ></circle>

              <g stroke="#0d0d0f" strokeWidth="4">
                <line x1="300" y1="123" x2="300" y2="154"></line>
                <line x1="477" y1="300" x2="446" y2="300"></line>
                <line x1="300" y1="477" x2="300" y2="446"></line>
                <line x1="123" y1="300" x2="154" y2="300"></line>

                <line x1="425" y1="175" x2="404" y2="196"></line>
                <line x1="425" y1="425" x2="404" y2="404"></line>
                <line x1="175" y1="425" x2="196" y2="404"></line>
                <line x1="175" y1="175" x2="196" y2="196"></line>
              </g>

              <path
                d="M175 175 A177 177 0 0 1 425 175"
                fill="none"
                stroke="#2f5bff"
                strokeWidth="9"
              ></path>

              <path
                d="M300 300 L300 162"
                fill="none"
                stroke="#0d0d0f"
                strokeWidth="12"
                strokeLinecap="square"
              ></path>

              <circle cx="300" cy="300" r="28" fill="#0d0d0f"></circle>
              <circle cx="300" cy="135" r="8" fill="#2f5bff"></circle>
            </g>

            <text
              x="300"
              y="532"
              fill="#efefee"
              textAnchor="middle"
              fontSize="11"
              className="instrument-text"
            >
              HOLD / VERIFY / CAPTURE
            </text>
          </svg>
        </div>

        <p className="stage-label mono" id="engine-label">
          05 / Appointment state rotor
        </p>

        <output className="stage-readout mono" id="rotation-readout" aria-live="off">
          {rotation.toFixed(1).padStart(5, "0")}°
        </output>
      </div>
    </section>
  );
};
