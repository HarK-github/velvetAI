import type { FC } from "react";
import { BookingSimulatorSection } from "../components/BookingSimulatorSection.js";

export const BookingPage: FC = () => {
  return (
    <div style={{ paddingTop: "var(--nav-height)" }}>
      {/* Main Interactive Booking Console */}
      <BookingSimulatorSection />
    </div>
  );
};
