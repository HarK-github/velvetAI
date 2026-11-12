import type { FC } from "react";
import { Link } from "../router.js";

export const HeroSection: FC = () => {
  return (
    <section className="hero" id="top" aria-labelledby="hero-title">
      <div className="hero-inner">
        <div className="hero-copy">
          <p className="eyebrow mono">
            <span className="signal-dot" aria-hidden="true"></span>
            Agent-ready appointment infrastructure
          </p>

          <h1 className="display hero-title" id="hero-title">
            AI books it.
            <br />
            <span className="accent">PayPal seals it.</span>
          </h1>

          <p className="lede hero-lede">
            Production-grade booking, forecast-sized deposits and deterministic payment controls for
            local service businesses and autonomous agents.
          </p>

          <div className="button-row hero-actions">
            <a className="button button--solid" href="#protocol">
              <span className="signal-dot" aria-hidden="true"></span>
              Inspect protocol
            </a>
            <a className="button" href="#proof">
              Run proof
            </a>
            <Link to="/book" className="button button--primary">
              Live simulator &rarr;
            </Link>
          </div>

          <div className="hero-specs hairline-top" aria-label="Core system specifications">
            <div className="hero-spec-line">
              <span>Slot hold TTL</span>
              <span>300 seconds</span>
            </div>
            <div className="hero-spec-line">
              <span>Confirmation token</span>
              <span>120 seconds</span>
            </div>
            <div className="hero-spec-line">
              <span>Money representation</span>
              <span>BigInt / minor unit</span>
            </div>
          </div>
        </div>

        <div className="hero-subject" aria-label="velvetAI precision scheduling instrument">
          <svg viewBox="0 0 1000 660" role="img" aria-labelledby="hero-subject-title">
            <title id="hero-subject-title">
              A neutral machined scheduling instrument with an appointment dial
            </title>

            <defs>
              <linearGradient id="hero-metal-top" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#fcfcfb"></stop>
                <stop offset="0.36" stopColor="#babbbd"></stop>
                <stop offset="0.7" stopColor="#5e5f64"></stop>
                <stop offset="1" stopColor="#222327"></stop>
              </linearGradient>

              <linearGradient id="hero-metal-side" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#87888d"></stop>
                <stop offset="1" stopColor="#16171a"></stop>
              </linearGradient>

              <radialGradient id="hero-dial" cx="35%" cy="28%" r="78%">
                <stop offset="0" stopColor="#fafaf9"></stop>
                <stop offset="0.46" stopColor="#a4a5a9"></stop>
                <stop offset="0.78" stopColor="#44454a"></stop>
                <stop offset="1" stopColor="#151619"></stop>
              </radialGradient>

              <linearGradient id="hero-screen" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#34353a"></stop>
                <stop offset="1" stopColor="#101114"></stop>
              </linearGradient>
            </defs>

            <path
              d="M75 505 L165 293 L820 267 L944 420 L841 585 L167 613 Z"
              fill="url(#hero-metal-side)"
              stroke="#0d0d0f"
              strokeWidth="3"
            ></path>

            <path
              d="M165 293 L820 267 L901 391 L803 520 L112 533 Z"
              fill="url(#hero-metal-top)"
              stroke="#0d0d0f"
              strokeWidth="3"
            ></path>

            <path
              d="M195 323 L490 312 L525 444 L160 458 Z"
              fill="url(#hero-screen)"
              stroke="#0d0d0f"
              strokeWidth="3"
            ></path>

            <text x="200" y="365" fill="#efefee" fontSize="18" className="instrument-text">
              VELVET / NODE 01
            </text>

            <text
              x="199"
              y="416"
              fill="#efefee"
              fontSize="48"
              fontWeight="500"
              className="instrument-text"
            >
              14:30
            </text>

            <line x1="199" y1="432" x2="465" y2="422" stroke="#2f5bff" strokeWidth="5"></line>

            <circle
              cx="701"
              cy="362"
              r="226"
              fill="url(#hero-dial)"
              stroke="#0d0d0f"
              strokeWidth="4"
            ></circle>

            <circle
              cx="701"
              cy="362"
              r="181"
              fill="#1b1c20"
              stroke="#dadad8"
              strokeWidth="3"
            ></circle>

            <circle
              cx="701"
              cy="362"
              r="142"
              fill="#efefee"
              stroke="#0d0d0f"
              strokeWidth="3"
            ></circle>

            <g stroke="#0d0d0f" strokeWidth="3">
              <line x1="701" y1="207" x2="701" y2="232"></line>
              <line x1="856" y1="362" x2="831" y2="362"></line>
              <line x1="701" y1="517" x2="701" y2="492"></line>
              <line x1="546" y1="362" x2="571" y2="362"></line>
            </g>

            <path
              d="M604 260 A142 142 0 0 1 812 296"
              fill="none"
              stroke="#2f5bff"
              strokeWidth="8"
              strokeLinecap="square"
            ></path>

            <circle cx="701" cy="362" r="20" fill="#0d0d0f"></circle>
            <line
              x1="701"
              y1="362"
              x2="780"
              y2="298"
              stroke="#0d0d0f"
              strokeWidth="8"
              strokeLinecap="square"
            ></line>

            <circle cx="853" cy="466" r="8" fill="#2f5bff"></circle>

            <path
              d="M179 300 L812 278"
              fill="none"
              stroke="#ffffff"
              strokeWidth="5"
              opacity="0.7"
            ></path>

            <text x="620" y="572" fill="#efefee" fontSize="12" className="instrument-text">
              PAYMENT / VERIFIED
            </text>
          </svg>
        </div>
      </div>
    </section>
  );
};
