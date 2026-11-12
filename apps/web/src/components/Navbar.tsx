import { useState, useEffect, type FC } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Link, useRouter } from "../router.js";
import { apiClient, ApiError } from "../api-client.js";
import { isAuth0Configured, computeAuthDiagnostic, clearAuthCache } from "../lib/auth-config.js";
import { useAskAI } from "../context/AskAIContext.js";

const Auth0StateButton: FC = () => {
  const {
    isAuthenticated,
    isLoading,
    user,
    error,
    loginWithRedirect,
    logout,
    getAccessTokenSilently,
  } = useAuth0();
  const { clearConversation } = useAskAI();
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [authDetail, setAuthDetail] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loadingTimeout, setLoadingTimeout] = useState<boolean>(false);

  // Watchdog: prevent indefinite loading state without diagnostic feedback
  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => {
        setLoadingTimeout(true);
      }, 5000);
      return () => clearTimeout(timer);
    }
    setLoadingTimeout(false);
  }, [isLoading]);

  useEffect(() => {
    if (isAuthenticated) {
      const audience =
        (typeof import.meta.env !== "undefined"
          ? (import.meta.env.VITE_AUTH0_AUDIENCE as string)
          : "") || "https://velvetai.example/api";

      const tokenScope =
        "openid profile email booking:read booking:quote booking:prepare booking:commit booking:cancel";

      apiClient.setTokenProvider(async () => {
        return await getAccessTokenSilently({
          authorizationParams: {
            audience,
            scope: tokenScope,
          },
        });
      });

      getAccessTokenSilently({
        authorizationParams: {
          audience,
          scope: tokenScope,
        },
      })
        .then(async (token) => {
          if (token) {
            apiClient.setAuthToken(token);
            computeAuthDiagnostic(token);
          }
          // First protected request to test backend Auth0 verification:
          try {
            await apiClient.getServices();
            setAuthStatus("HTTP 200");
            setAuthDetail(null);
          } catch (err: unknown) {
            if (err instanceof ApiError) {
              setAuthStatus(`HTTP ${err.status}`);
              setAuthDetail(
                err.problem.code === "user_not_provisioned"
                  ? "Your account isn't set up yet"
                  : err.problem.detail || err.problem.code || null,
              );
            } else {
              setAuthStatus("Token Error");
              setAuthDetail(err instanceof Error ? err.message : String(err));
            }
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Token Error";
          setAuthStatus("Token Error");
          setAuthDetail(msg);
        });
    }
  }, [isAuthenticated, getAccessTokenSilently]);

  const isStaleAuthError =
    Boolean(error?.message) &&
    (error!.message.toLowerCase().includes("invalid state") ||
      error!.message.toLowerCase().includes("missing transaction") ||
      error!.message.toLowerCase().includes("missing_transaction"));

  useEffect(() => {
    if (isStaleAuthError && typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        if (
          url.searchParams.has("code") ||
          url.searchParams.has("state") ||
          url.searchParams.has("error") ||
          url.searchParams.has("iss")
        ) {
          url.searchParams.delete("code");
          url.searchParams.delete("state");
          url.searchParams.delete("error");
          url.searchParams.delete("error_description");
          url.searchParams.delete("iss");
          const cleanUrl = `${url.pathname}${url.search}${url.hash}`;
          window.history.replaceState({}, document.title, cleanUrl);
        }
      } catch {
        // ignore
      }
    }
  }, [isStaleAuthError]);

  const handleLogin = async () => {
    try {
      setLoginError(null);
      const audience =
        (typeof import.meta.env !== "undefined"
          ? (import.meta.env.VITE_AUTH0_AUDIENCE as string)
          : "") || "https://velvetai.example/api";
      const returnTo =
        typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
      await loginWithRedirect({
        appState: {
          returnTo,
        },
        authorizationParams: {
          audience,
        },
      });
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Authentication redirect failed");
    }
  };

  const activeError = isStaleAuthError ? null : loginError || error?.message;

  if (isLoading) {
    if (loadingTimeout) {
      return (
        <span
          id="auth0-loading-timeout"
          className="mono"
          style={{ fontSize: "11px", color: "var(--crimson, #ef4444)" }}
          title="Auth0 initialization timed out. Please check network connection."
        >
          Auth0 Timeout
        </span>
      );
    }
    return (
      <span id="auth0-loading" className="mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
        Auth...
      </span>
    );
  }

  if (activeError) {
    return (
      <div
        id="auth0-error-container"
        style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
      >
        <span
          className="mono"
          style={{
            fontSize: "10px",
            padding: "2px 6px",
            borderRadius: "4px",
            background: "rgba(239, 68, 68, 0.15)",
            color: "var(--crimson, #ef4444)",
            fontWeight: 600,
            maxWidth: "180px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={activeError}
          id="auth0-error-badge"
        >
          {activeError}
        </span>
        <button
          type="button"
          onClick={handleLogin}
          className="button button--outline"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            borderColor: "rgba(47, 91, 255, 0.4)",
            color: "var(--accent)",
            fontSize: "11px",
            padding: "4px 8px",
          }}
          id="login-button"
          aria-label="Retry sign in with Auth0"
        >
          Login
        </button>
      </div>
    );
  }

  if (isAuthenticated) {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
        {authStatus && (
          <span
            className="mono"
            style={{
              fontSize: "10px",
              padding: "2px 6px",
              borderRadius: "4px",
              background: authStatus.includes("200")
                ? "rgba(16, 185, 129, 0.15)"
                : "rgba(239, 68, 68, 0.15)",
              color: authStatus.includes("200")
                ? "var(--emerald, #10b981)"
                : "var(--crimson, #ef4444)",
              fontWeight: 600,
            }}
            title={authDetail || "First protected request result"}
            id="auth0-status-badge"
          >
            {authStatus}
          </span>
        )}
        <span
          className="mono"
          style={{
            fontSize: "11px",
            color: "var(--secondary)",
            maxWidth: "140px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={user?.email || user?.name}
        >
          {user?.name || user?.email || "User"}
        </span>
        <button
          type="button"
          onClick={() => {
            clearAuthCache();
            clearConversation({ resetAuth: true });
            apiClient.setAuthToken("");
            apiClient.setTokenProvider(async () => undefined);
            apiClient.resetActionKeys();
            computeAuthDiagnostic(undefined);
            logout({ logoutParams: { returnTo: window.location.origin } });
          }}
          className="button button--ghost"
          style={{ fontSize: "11px", padding: "4px 8px" }}
          aria-label="Log out"
          id="logout-button"
        >
          Logout
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleLogin}
      className="button button--outline"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        borderColor: "rgba(47, 91, 255, 0.4)",
        color: "var(--accent)",
      }}
      id="login-button"
      aria-label="Sign in with Auth0"
    >
      Login
    </button>
  );
};

const AuthNavButton: FC = () => {
  if (!isAuth0Configured()) {
    return (
      <span
        id="auth0-unconfigured-badge"
        className="mono"
        style={{
          fontSize: "10px",
          color: "var(--muted)",
          padding: "2px 6px",
          border: "1px dashed var(--hairline, rgba(0,0,0,0.15))",
          borderRadius: "4px",
        }}
        title="Auth0 unconfigured"
      >
        Auth0 Off
      </span>
    );
  }
  return <Auth0StateButton />;
};

interface NavbarProps {
  apiHealthy: boolean;
  apiLatency: number | null;
  onOpenAi?: () => void;
}

export const Navbar: FC<NavbarProps> = ({ apiHealthy, apiLatency, onOpenAi }) => {
  const { currentPath } = useRouter();

  const navItems = [
    { to: "/", label: "Overview" },
    { to: "/book", label: "Book Slot" },
    { to: "/schedule", label: "Schedule" },
    { to: "/policy", label: "Policy & Spec" },
    { to: "/status", label: "API Status" },
    { to: "/security", label: "Security" },
  ];

  return (
    <nav className="site-nav" aria-label="Primary navigation">
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label="velvetAI home">
          velvetAI<span className="brand-period">.</span>
        </Link>

        <div className="nav-actions">
          <div className="nav-links" aria-label="Page sections">
            {navItems.map((item) => {
              const isActive = currentPath === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`nav-link ${isActive ? "nav-link--active" : ""}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Link
              to="/status"
              className="mono"
              style={{
                fontSize: "11px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 10px",
                borderRadius: "999px",
                background: apiHealthy ? "rgba(5, 150, 105, 0.08)" : "rgba(107, 114, 128, 0.1)",
                color: apiHealthy ? "#059669" : "var(--muted)",
                cursor: "pointer",
                fontWeight: 600,
                letterSpacing: "0.02em",
              }}
              title={apiHealthy ? `API Live (${apiLatency}ms)` : "Connecting to API..."}
            >
              <span
                className={`signal-dot ${apiHealthy ? "signal-dot--emerald" : ""}`}
                aria-hidden="true"
              ></span>
              {apiHealthy ? `${apiLatency ?? 0}ms` : "Syncing"}
            </Link>

            {onOpenAi && (
              <button
                type="button"
                id="open-ask-ai-button"
                className="button button--outline"
                onClick={onOpenAi}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  borderColor: "rgba(30, 64, 175, 0.3)",
                  color: "var(--accent)",
                  background: "rgba(30, 64, 175, 0.04)",
                  fontWeight: 600,
                }}
                aria-label="Open Ask AI concierge drawer"
              >
                <span style={{ fontSize: "14px", color: "var(--accent)" }}>✦</span> Ask AI
              </button>
            )}

            <AuthNavButton />

            <Link to="/book" className="button button--solid">
              <span className="signal-dot" aria-hidden="true"></span>
              Book Now
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
};
