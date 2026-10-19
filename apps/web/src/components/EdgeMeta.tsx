import type { FC } from "react";

interface EdgeMetaProps {
  scrollPercentage: number;
}

export const EdgeMeta: FC<EdgeMetaProps> = ({ scrollPercentage }) => {
  const formattedPercent = String(Math.round(scrollPercentage)).padStart(3, "0");

  return (
    <>
      <aside className="edge-meta edge-meta--left" aria-hidden="true">
        velvetAI / system build 01 / deterministic commerce
      </aside>

      <aside className="edge-meta edge-meta--bottom" aria-hidden="true">
        Scroll <span className="edge-scroll">{formattedPercent}%</span> / PayPal sandbox / UTC
        authority
      </aside>
    </>
  );
};
