export interface AuthDiagnostic {
  authSource: "auth0" | "mock" | "none";
  accessTokenPresent: boolean;
  accessTokenJwtShaped: boolean;
}

export function isAuth0Configured(): boolean {
  if (typeof import.meta.env === "undefined") return false;
  const domain = import.meta.env.VITE_AUTH0_DOMAIN;
  const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;
  return Boolean(
    typeof domain === "string" &&
    domain.trim().length > 0 &&
    typeof clientId === "string" &&
    clientId.trim().length > 0,
  );
}

export function isMockAuthEnabled(): boolean {
  if (typeof import.meta.env === "undefined") return false;
  // Rule 1: Never enable mock auth if real Auth0 is configured
  if (isAuth0Configured()) return false;

  const mockEnv = import.meta.env.VITE_OIDC_MOCK_ENABLED ?? import.meta.env.OIDC_MOCK_ENABLED;
  if (mockEnv === "false" || mockEnv === false) {
    return false;
  }

  // Only allowed in non-production test or explicit mock mode without Auth0
  return import.meta.env.MODE === "test" || mockEnv === "true" || mockEnv === true;
}

export function isJwtShaped(token?: string | null): boolean {
  if (!token || typeof token !== "string") return false;
  const parts = token.trim().split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function computeAuthDiagnostic(token?: string | null): AuthDiagnostic {
  const present = Boolean(token && typeof token === "string" && token.trim().length > 0);
  const jwt = isJwtShaped(token);

  let authSource: "auth0" | "mock" | "none" = "none";
  if (present) {
    if (jwt) {
      authSource = "auth0";
    } else if (
      (token!.trim().startsWith("test-token:") || token!.trim() === "test-token") &&
      isMockAuthEnabled()
    ) {
      authSource = "mock";
    }
  }

  const diagnostic: AuthDiagnostic = {
    authSource,
    accessTokenPresent: present,
    accessTokenJwtShaped: jwt,
  };

  if (typeof window !== "undefined") {
    (window as any).__AUTH_DIAGNOSTIC__ = diagnostic;
  }

  return diagnostic;
}
