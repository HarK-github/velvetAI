import { useState, useEffect } from "react";
import type { FC } from "react";
import { Auth0Provider } from "@auth0/auth0-react";
import { RouterProvider, useRouter } from "./router.js";
import { Navbar } from "./components/Navbar.js";
import { EdgeMeta } from "./components/EdgeMeta.js";
import { AskAIDrawer } from "./components/AskAIDrawer.js";
import { HomePage } from "./pages/HomePage.js";
import { BookingPage } from "./pages/BookingPage.js";
import { SchedulePage } from "./pages/SchedulePage.js";
import { PolicyPage } from "./pages/PolicyPage.js";
import { StatusPage } from "./pages/StatusPage.js";
import { ApprovalPage } from "./pages/ApprovalPage.js";
import { computeAuthDiagnostic } from "./lib/auth-config.js";
import { API_BASE_URL } from "./api-client.js";

const AppContent: FC = () => {
  const { currentPath } = useRouter();
  const [apiHealthy, setApiHealthy] = useState<boolean>(false);
  const [apiLatency, setApiLatency] = useState<number | null>(null);
  const [scrollPercentage, setScrollPercentage] = useState<number>(0);
  const [isAiOpen, setIsAiOpen] = useState<boolean>(false);

  // Monitor Fastify REST API health
  useEffect(() => {
    const checkApi = async () => {
      const start = performance.now();
      try {
        const res = await fetch(`${API_BASE_URL}/health/live`);
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
    if (currentPath.startsWith("/approve/")) {
      const locator = currentPath.slice("/approve/".length);
      return <ApprovalPage locator={locator} />;
    }
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

      <Navbar apiHealthy={apiHealthy} apiLatency={apiLatency} onOpenAi={() => setIsAiOpen(true)} />
      <EdgeMeta scrollPercentage={scrollPercentage} />

      <main id="main-content">{renderCurrentPage()}</main>

      <AskAIDrawer isOpen={isAiOpen} onClose={() => setIsAiOpen(false)} />
    </>
  );
};

export interface Auth0Diagnostic {
  auth0DomainConfigured: boolean;
  auth0ClientIdConfigured: boolean;
  auth0AudienceConfigured: boolean;
}

export function getAuth0Diagnostics(): Auth0Diagnostic {
  const env =
    typeof import.meta.env !== "undefined"
      ? import.meta.env
      : ({} as Record<string, string | undefined>);
  return {
    auth0DomainConfigured: Boolean(
      env.VITE_AUTH0_DOMAIN && env.VITE_AUTH0_DOMAIN.trim().length > 0,
    ),
    auth0ClientIdConfigured: Boolean(
      env.VITE_AUTH0_CLIENT_ID && env.VITE_AUTH0_CLIENT_ID.trim().length > 0,
    ),
    auth0AudienceConfigured: Boolean(
      env.VITE_AUTH0_AUDIENCE && env.VITE_AUTH0_AUDIENCE.trim().length > 0,
    ),
  };
}

if (typeof window !== "undefined") {
  computeAuthDiagnostic(undefined);
  if (typeof import.meta.env !== "undefined" && import.meta.env.DEV) {
    (window as unknown as { __AUTH0_DIAGNOSTIC__: Auth0Diagnostic }).__AUTH0_DIAGNOSTIC__ =
      getAuth0Diagnostics();
  }
}

export function App() {
  const auth0Domain =
    ((typeof import.meta.env !== "undefined" ? import.meta.env.VITE_AUTH0_DOMAIN : "") as string) ||
    "";
  const auth0ClientId =
    ((typeof import.meta.env !== "undefined"
      ? import.meta.env.VITE_AUTH0_CLIENT_ID
      : "") as string) || "";
  const auth0Audience =
    ((typeof import.meta.env !== "undefined"
      ? import.meta.env.VITE_AUTH0_AUDIENCE
      : "") as string) || "";

  const isConfigured = Boolean(auth0Domain && auth0ClientId);

  const content = (
    <RouterProvider>
      {!isConfigured && (
        <div
          id="auth0-unconfigured-alert"
          role="alert"
          style={{
            background: "rgba(239, 68, 68, 0.12)",
            color: "var(--crimson, #ef4444)",
            padding: "8px 16px",
            fontSize: "12px",
            textAlign: "center",
            borderBottom: "1px solid rgba(239, 68, 68, 0.3)",
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          Auth0 public configuration missing. Please verify VITE_AUTH0_DOMAIN and
          VITE_AUTH0_CLIENT_ID.
        </div>
      )}
      <AppContent />
    </RouterProvider>
  );

  if (isConfigured) {
    return (
      <Auth0Provider
        domain={auth0Domain}
        clientId={auth0ClientId}
        authorizationParams={{
          redirect_uri:
            typeof window !== "undefined" ? window.location.origin : "http://localhost:5173",
          audience: auth0Audience || undefined,
          scope:
            "openid profile email booking:read booking:quote booking:prepare booking:commit booking:cancel",
        }}
        cacheLocation="memory"
      >
        {content}
      </Auth0Provider>
    );
  }

  return content;
}

export default App;
