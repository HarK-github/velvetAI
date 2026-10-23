import { useState, useEffect, type FC } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Link, useRouter } from "../router.js";
import { apiClient } from "../api-client.js";
import { isAuth0Configured, computeAuthDiagnostic } from "../lib/auth-config.js";

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
          const res = await fetch("http://localhost:3000/v1/services", {
            headers: token
              ? {
                  authorization: `Bearer ${token}`,
                }
              : {},
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            setAuthStatus(`HTTP ${res.status}`);
            setAuthDetail(body?.detail || body?.code || null);
          } else {
            setAuthStatus(`HTTP ${res.status}`);
            setAuthDetail(null);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Token Error";
          setAuthStatus("Token Error");
          setAuthDetail(msg);
        });
    }
  }, [isAuthenticated, getAccessTokenSilently]);

  const handleLogin = async () => {
    try {
      setLoginError(null);
      const audience =
        (typeof import.meta.env !== "undefined"
          ? (import.meta.env.VITE_AUTH0_AUDIENCE as string)
          : "") || "https://velvetai.example/api";
      await loginWithRedirect({
        authorizationParams: {
          audience,
        },
      });
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Authentication redirect failed");
    }
  };

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

  const activeError = loginError || error?.message;

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
            apiClient.setAuthToken("");
            apiClient.setTokenProvider(async () => undefined);
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

  return (
    <nav className="site-nav" aria-label="Primary navigation">
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label="velvetAI home">
          velvetAI<span className="brand-period">.</span>
        </Link>

        <div className="nav-actions">
          <div className="nav-links" aria-label="Page sections">
            <Link
              to="/"
              className="nav-link"
              style={{
                borderColor: currentPath === "/" ? "var(--accent)" : "transparent",
                color: currentPath === "/" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/" ? 600 : 500,
              }}
            >
              Overview
            </Link>
            <Link
              to="/book"
              className="nav-link"
              style={{
                borderColor: currentPath === "/book" ? "var(--accent)" : "transparent",
                color: currentPath === "/book" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/book" ? 600 : 500,
              }}
            >
              Book Slot
            </Link>
            <Link
              to="/schedule"
              className="nav-link"
              style={{
                borderColor: currentPath === "/schedule" ? "var(--accent)" : "transparent",
                color: currentPath === "/schedule" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/schedule" ? 600 : 500,
              }}
            >
              Schedule
            </Link>
            <Link
              to="/policy"
              className="nav-link"
              style={{
                borderColor: currentPath === "/policy" ? "var(--accent)" : "transparent",
                color: currentPath === "/policy" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/policy" ? 600 : 500,
              }}
            >
              Policy & Spec
            </Link>
            <Link
              to="/status"
              className="nav-link"
              style={{
                borderColor: currentPath === "/status" ? "var(--accent)" : "transparent",
                color: currentPath === "/status" ? "var(--ink)" : "var(--secondary)",
                fontWeight: currentPath === "/status" ? 600 : 500,
              }}
            >
              API Status
            </Link>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Link
              to="/status"
              className="mono"
              style={{
                fontSize: "10px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                color: apiHealthy ? "var(--ink)" : "var(--muted)",
                cursor: "pointer",
              }}
              title={apiHealthy ? `API Live (${apiLatency}ms)` : "Connecting to API..."}
            >
              <span
                className={`signal-dot ${apiHealthy ? "signal-dot--emerald" : ""}`}
                aria-hidden="true"
              ></span>
              {apiHealthy ? `API ${apiLatency ?? 0}ms` : "API Syncing"}
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
                  borderColor: "rgba(47, 91, 255, 0.4)",
                  color: "var(--accent)",
                }}
                aria-label="Open Ask AI concierge drawer"
              >
                <span>✦</span> Ask AI
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
