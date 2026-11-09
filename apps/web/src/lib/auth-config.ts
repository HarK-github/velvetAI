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

/**
 * Sanitizes returnTo paths to guarantee relative, same-origin redirection.
 * Rejects absolute URLs, protocol-relative paths (//), javascript: or data: schemes,
 * and backslash path traversal tricks.
 */
export function sanitizeReturnTo(returnTo?: string | null): string {
  if (!returnTo || typeof returnTo !== "string") return "/";
  const trimmed = returnTo.trim();

  // Must begin with single forward slash
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
    return "/";
  }

  // Reject control characters
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return "/";
    }
  }

  try {
    // Construct dummy URL to test parsing and prevent origin escaping
    const dummy = new URL(trimmed, "http://localhost");
    if (dummy.origin !== "http://localhost") {
      return "/";
    }
    // Return relative path including query and hash
    return `${dummy.pathname}${dummy.search}${dummy.hash}`;
  } catch {
    return "/";
  }
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

/**
 * Builds the Auth0 authorization scope string.
 * offline_access is strictly included only when an API audience is present,
 * as Auth0 refresh token issuance requires an authorized API resource identifier.
 */
export function buildAuthScope(audience?: string | null): string {
  const hasAudience = Boolean(audience && audience.trim().length > 0);
  return hasAudience
    ? "openid profile email offline_access booking:read booking:quote booking:prepare booking:commit booking:cancel"
    : "openid profile email booking:read booking:quote booking:prepare booking:commit booking:cancel";
}

/**
 * Clears Auth0 cached session keys from localStorage on logout.
 */
export function clearAuthCache(): void {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && (key.startsWith("@@auth0spajs@@") || key.startsWith("auth0"))) {
          keysToRemove.push(key);
        }
      }
      for (const k of keysToRemove) {
        window.localStorage.removeItem(k);
      }
    } catch {
      // Ignore storage errors in restricted contexts
    }
  }
}
