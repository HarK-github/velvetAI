import { useState, useEffect } from "react";
import type { FC } from "react";
import { RouterProvider, useRouter } from "./router.js";
import { Navbar } from "./components/Navbar.js";
import { EdgeMeta } from "./components/EdgeMeta.js";
import { HomePage } from "./pages/HomePage.js";
import { BookingPage } from "./pages/BookingPage.js";
import { SchedulePage } from "./pages/SchedulePage.js";
import { PolicyPage } from "./pages/PolicyPage.js";
import { StatusPage } from "./pages/StatusPage.js";

const AppContent: FC = () => {
  const { currentPath } = useRouter();
  const [apiHealthy, setApiHealthy] = useState<boolean>(false);
  const [apiLatency, setApiLatency] = useState<number | null>(null);
  const [scrollPercentage, setScrollPercentage] = useState<number>(0);

  // Monitor Fastify REST API health
  useEffect(() => {
    const checkApi = async () => {
      const start = performance.now();
      try {
        const res = await fetch("http://localhost:3000/health/live");
        const elapsed = Math.round(performance.now() - start);
        if (res.ok) {
          setApiHealthy(true);
          setApiLatency(elapsed);
        } else {
          setApiHealthy(false);
        }
      } catch {
        setApiHealthy(false);
      }
    };

    checkApi();
    const interval = setInterval(checkApi, 10000);
    return () => clearInterval(interval);
  }, []);

  // Scroll choreography for edge telemetry and hero parity shifts
  useEffect(() => {
    const handleScroll = () => {
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? Math.min(1, Math.max(0, window.scrollY / docHeight)) : 0;
      setScrollPercentage(progress * 100);

      // Hero word & subject shift on home page
      const hero = document.getElementById("top");
      if (hero) {
        const rect = hero.getBoundingClientRect();
        const heroProgress = Math.min(1, Math.max(0, -rect.top / Math.max(rect.height, 1)));
        document.documentElement.style.setProperty(
          "--hero-word-shift",
          `${(-heroProgress * 34).toFixed(2)}px`,
        );
        document.documentElement.style.setProperty(
          "--hero-subject-shift",
          `${(heroProgress * 44).toFixed(2)}px`,
        );
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const renderCurrentPage = () => {
    switch (currentPath) {
      case "/book":
        return <BookingPage />;
      case "/schedule":
        return <SchedulePage />;
      case "/policy":
        return <PolicyPage />;
      case "/status":
        return <StatusPage />;
      case "/":
      default:
        return <HomePage />;
    }
  };

  return (
    <>
      <a className="skip-link mono" href="#main-content">
        Skip to content
      </a>

      <Navbar apiHealthy={apiHealthy} apiLatency={apiLatency} />
      <EdgeMeta scrollPercentage={scrollPercentage} />

      <main id="main-content">{renderCurrentPage()}</main>
    </>
  );
};

export function App() {
  return (
    <RouterProvider>
      <AppContent />
    </RouterProvider>
  );
}

export default App;
