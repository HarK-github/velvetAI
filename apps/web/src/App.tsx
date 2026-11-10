import { useState, useEffect } from "react";
import type { FC, ReactNode } from "react";
import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { RouterProvider, useRouter } from "./router.js";
import { AskAIProvider, useAskAI } from "./context/AskAIContext.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Navbar } from "./components/Navbar.js";
import { EdgeMeta } from "./components/EdgeMeta.js";
import { AskAIDrawer } from "./components/AskAIDrawer.js";
import { HomePage } from "./pages/HomePage.js";
import { BookingPage } from "./pages/BookingPage.js";
import { SchedulePage } from "./pages/SchedulePage.js";
import { PolicyPage } from "./pages/PolicyPage.js";
import { StatusPage } from "./pages/StatusPage.js";
import { ApprovalPage } from "./pages/ApprovalPage.js";
import {
  computeAuthDiagnostic,
  sanitizeReturnTo,
  buildAuthScope,
  cleanStaleAuthParams,
} from "./lib/auth-config.js";
import { API_BASE_URL, isApiConfigured } from "./api-client.js";

const AskAIAuthSync: FC = () => {
  const { isLoading, isAuthenticated, user } = useAuth0();
  const { syncAuthState } = useAskAI();

  useEffect(() => {
    syncAuthState({
      sub: user?.sub ?? null,
      isAuthenticated,
      isLoading,
    });
  }, [user?.sub, isAuthenticated, isLoading, syncAuthState]);

  return null;
};

const AppContent: FC = () => {
  const { currentPath } = useRouter();
  const { isOpen: isAiOpen, openDrawer, closeDrawer } = useAskAI();
  const [apiHealthy, setApiHealthy] = useState<boolean>(false);
  const [apiLatency, setApiLatency] = useState<number | null>(null);
  const [scrollPercentage, setScrollPercentage] = useState<number>(0);

  // Monitor Fastify REST API health
  useEffect(() => {
    const checkApi = async () => {
      if (!API_BASE_URL) {
        setApiHealthy(false);
        setApiLatency(null);
        return;
      }
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

      {!isApiConfigured() && (
        <div
          role="alert"
          id="api-unconfigured-alert"
          style={{
            background: "#b91c1c",
            color: "#ffffff",
            padding: "12px 16px",
            textAlign: "center",
            fontWeight: 600,
            fontSize: "14px",
            letterSpacing: "0.02em",
            zIndex: 99999,
            position: "relative",
          }}
        >
          API not configured: VITE_API_BASE_URL environment variable must be set in production.
        </div>
      )}

      <Navbar apiHealthy={apiHealthy} apiLatency={apiLatency} onOpenAi={openDrawer} />
      <EdgeMeta scrollPercentage={scrollPercentage} />

      <main id="main-content">{renderCurrentPage()}</main>

      <AskAIDrawer isOpen={isAiOpen} onClose={closeDrawer} />
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

export const Auth0ProviderWithRedirect: FC<{
  domain: string;
  clientId: string;
  audience?: string;
  children: ReactNode;
}> = ({ domain, clientId, audience, children }) => {
  const { navigate } = useRouter();

  // Proactively detect and clean stale code/state parameters before Auth0 initializes
  const [isStaleParam] = useState(() => cleanStaleAuthParams(clientId));

  const onRedirectCallback = (appState?: { returnTo?: string }) => {
    const target = sanitizeReturnTo(appState?.returnTo);
    if (typeof window !== "undefined") {
      window.history.replaceState({}, document.title, target);
    }
    navigate(target, { replace: true });
  };

  const redirectUri =
    typeof window !== "undefined"
      ? window.location.origin
      : (typeof import.meta.env !== "undefined" && import.meta.env.VITE_PUBLIC_WEB_ORIGIN) || "";

  const hasAudience = Boolean(audience && audience.trim().length > 0);
  const effectiveScope = buildAuthScope(audience);

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        redirect_uri: redirectUri,
        audience: hasAudience ? audience : undefined,
        scope: effectiveScope,
      }}
      useRefreshTokens={true}
      cacheLocation="localstorage"
      skipRedirectCallback={isStaleParam}
      onRedirectCallback={onRedirectCallback}
    >
      {children}
    </Auth0Provider>
  );
};

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

  return (
    <ErrorBoundary>
      <AskAIProvider>
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
          {isConfigured ? (
            <Auth0ProviderWithRedirect
              domain={auth0Domain}
              clientId={auth0ClientId}
              audience={auth0Audience}
            >
              <AskAIAuthSync />
              <AppContent />
            </Auth0ProviderWithRedirect>
          ) : (
            <AppContent />
          )}
        </RouterProvider>
      </AskAIProvider>
    </ErrorBoundary>
  );
}

export default App;
