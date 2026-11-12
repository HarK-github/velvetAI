/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import {
  sanitizeReturnTo,
  buildAuthScope,
  clearAuthCache,
  cleanStaleAuthParams,
} from "../lib/auth-config.js";
import { Auth0ProviderWithRedirect } from "../App.js";
import { RouterProvider, useRouter } from "../router.js";

// Mock @auth0/auth0-react
let capturedAuth0Config: any = null;
const mockLoginWithRedirect = vi.fn();

vi.mock("@auth0/auth0-react", () => ({
  Auth0Provider: ({ children, ...props }: any) => {
    capturedAuth0Config = props;
    return <div data-testid="auth0-provider-mock">{children}</div>;
  },
  useAuth0: () => ({
    isAuthenticated: true,
    user: { name: "Test Buyer", email: "test@velvetai.internal" },
    loginWithRedirect: mockLoginWithRedirect,
    logout: vi.fn(),
    getAccessTokenSilently: vi.fn().mockResolvedValue("mock-access-token"),
  }),
}));

describe("Auth0 Login Persistence & Session across Reloads (Finding 1)", () => {
  beforeEach(() => {
    capturedAuth0Config = null;
    localStorage.clear();
  });

  describe("sanitizeReturnTo URL Validation", () => {
    it("honors valid relative same-origin paths and query parameters", () => {
      expect(sanitizeReturnTo("/approve/loc_12345")).toBe("/approve/loc_12345");
      expect(sanitizeReturnTo("/approve/loc_test?service=haircut&ref=concierge")).toBe(
        "/approve/loc_test?service=haircut&ref=concierge",
      );
      expect(sanitizeReturnTo("/schedule")).toBe("/schedule");
      expect(sanitizeReturnTo("/book")).toBe("/book");
    });

    it("rejects absolute URLs with external protocols", () => {
      expect(sanitizeReturnTo("https://evil.com/phish")).toBe("/");
      expect(sanitizeReturnTo("http://attacker.com")).toBe("/");
      expect(sanitizeReturnTo("ftp://malicious.org")).toBe("/");
    });

    it("rejects protocol-relative (//) and backslash bypass attempts", () => {
      expect(sanitizeReturnTo("//evil.com")).toBe("/");
      expect(sanitizeReturnTo("//attacker.com/evil")).toBe("/");
      expect(sanitizeReturnTo("/\\attacker.com")).toBe("/");
    });

    it("rejects javascript: and data: URI injection schemes", () => {
      expect(sanitizeReturnTo("javascript:alert(1)")).toBe("/");
      expect(sanitizeReturnTo("data:text/html,<script>alert(1)</script>")).toBe("/");
    });

    it("falls back to / on null, undefined, or empty strings", () => {
      expect(sanitizeReturnTo(null)).toBe("/");
      expect(sanitizeReturnTo(undefined)).toBe("/");
      expect(sanitizeReturnTo("")).toBe("/");
      expect(sanitizeReturnTo("   ")).toBe("/");
    });
  });

  describe("Auth0Provider Configuration", () => {
    it("configures Refresh Token Rotation with localstorage cacheLocation and offline_access scope", () => {
      render(
        <RouterProvider>
          <Auth0ProviderWithRedirect
            domain="test.auth0.com"
            clientId="test-client-id"
            audience="https://velvetai.example/api"
          >
            <div>Test Child</div>
          </Auth0ProviderWithRedirect>
        </RouterProvider>,
      );

      expect(capturedAuth0Config).toBeDefined();
      expect(capturedAuth0Config.useRefreshTokens).toBe(true);
      expect(capturedAuth0Config.cacheLocation).toBe("localstorage");
      expect(capturedAuth0Config.authorizationParams.scope).toContain("offline_access");
      expect(capturedAuth0Config.authorizationParams.scope).toContain("booking:commit");
    });

    it("honors returnTo on redirect callback and rejects malicious URLs", () => {
      let currentNavPath = "";
      const TestConsumer = () => {
        const { currentPath } = useRouter();
        currentNavPath = currentPath;
        return <div data-testid="current-path">{currentPath}</div>;
      };

      render(
        <RouterProvider>
          <Auth0ProviderWithRedirect
            domain="test.auth0.com"
            clientId="test-client-id"
            audience="https://velvetai.example/api"
          >
            <TestConsumer />
          </Auth0ProviderWithRedirect>
        </RouterProvider>,
      );

      expect(typeof capturedAuth0Config.onRedirectCallback).toBe("function");

      // 1. Legitimate returnTo is honored
      act(() => {
        capturedAuth0Config.onRedirectCallback({ returnTo: "/approve/loc_verified_999" });
      });
      expect(currentNavPath).toBe("/approve/loc_verified_999");

      // 2. Malicious returnTo is sanitized to /
      act(() => {
        capturedAuth0Config.onRedirectCallback({ returnTo: "https://evil.attacker.com/steal" });
      });
      expect(currentNavPath).toBe("/");
    });

    it("persists simulated session in localstorage across reloads", () => {
      // Set Auth0 session token in localStorage to simulate rotated token persistence
      const fakeSessionKey =
        "@@auth0spajs@@::test-client-id::https://velvetai.example/api::openid profile email offline_access booking:read booking:quote booking:prepare booking:commit booking:cancel";
      const fakeTokenData = {
        body: {
          access_token: "header.payload.signature",
          refresh_token: "mock-refresh-token",
          decoded: {
            claims: {
              sub: "auth0|6af02be79968e1f8f05bcee2",
              email: "buyer@velvetai.internal",
            },
          },
        },
      };

      localStorage.setItem(fakeSessionKey, JSON.stringify(fakeTokenData));

      // Re-render simulates page reload
      render(
        <RouterProvider>
          <Auth0ProviderWithRedirect
            domain="test.auth0.com"
            clientId="test-client-id"
            audience="https://velvetai.example/api"
          >
            <div>Reloaded App</div>
          </Auth0ProviderWithRedirect>
        </RouterProvider>,
      );

      // Verify localStorage was retained and not wiped
      const restored = localStorage.getItem(fakeSessionKey);
      expect(restored).toBeDefined();
      const parsed = JSON.parse(restored!);
      expect(parsed.body.refresh_token).toBe("mock-refresh-token");
      expect(parsed.body.decoded.claims.sub).toBe("auth0|6af02be79968e1f8f05bcee2");
    });

    it("includes offline_access only together with an API audience", () => {
      // 1. With API audience -> includes offline_access
      expect(buildAuthScope("https://velvetai.example/api")).toContain("offline_access");

      // 2. Without audience or with empty string -> omits offline_access
      expect(buildAuthScope(undefined)).not.toContain("offline_access");
      expect(buildAuthScope("")).not.toContain("offline_access");
      expect(buildAuthScope("   ")).not.toContain("offline_access");

      // 3. Provider reflects this behavior
      render(
        <RouterProvider>
          <Auth0ProviderWithRedirect domain="test.auth0.com" clientId="test-client-id" audience="">
            <div>No Audience App</div>
          </Auth0ProviderWithRedirect>
        </RouterProvider>,
      );

      expect(capturedAuth0Config.authorizationParams.audience).toBeUndefined();
      expect(capturedAuth0Config.authorizationParams.scope).not.toContain("offline_access");
    });

    it("clears localStorage cache on logout via clearAuthCache", () => {
      const auth0Key1 = "@@auth0spajs@@::client::key1";
      const auth0Key2 = "@@auth0spajs@@::client::key2";
      const otherKey = "user_preference_theme";

      localStorage.setItem(auth0Key1, "token1");
      localStorage.setItem(auth0Key2, "token2");
      localStorage.setItem(otherKey, "dark");

      clearAuthCache();

      expect(localStorage.getItem(auth0Key1)).toBeNull();
      expect(localStorage.getItem(auth0Key2)).toBeNull();
      expect(localStorage.getItem(otherKey)).toBe("dark");
    });

    it("no redirect on load with a valid cache: does not invoke loginWithRedirect on mount", () => {
      mockLoginWithRedirect.mockClear();

      render(
        <RouterProvider>
          <Auth0ProviderWithRedirect
            domain="test.auth0.com"
            clientId="test-client-id"
            audience="https://velvetai.example/api"
          >
            <div>Cached App</div>
          </Auth0ProviderWithRedirect>
        </RouterProvider>,
      );

      // Verifies no automatic redirect occurs on load
      expect(mockLoginWithRedirect).not.toHaveBeenCalled();
    });

    it("clean URL after the callback: replaces URL without code/state/iss query params", () => {
      // Simulate arrival at callback URL with code, state, and iss params
      window.history.replaceState(
        {},
        document.title,
        "/?code=auth0_code_xyz&state=state_abc&iss=https%3A%2F%2Ftest.auth0.com%2F",
      );
      expect(window.location.search).toContain("code=");

      const replaceStateSpy = vi.spyOn(window.history, "replaceState");

      render(
        <RouterProvider>
          <Auth0ProviderWithRedirect
            domain="test.auth0.com"
            clientId="test-client-id"
            audience="https://velvetai.example/api"
          >
            <div>Callback Test App</div>
          </Auth0ProviderWithRedirect>
        </RouterProvider>,
      );

      act(() => {
        capturedAuth0Config.onRedirectCallback({ returnTo: "/approve/loc_verified_999" });
      });

      // Assert replaceState was used to clean URL and navigate to returnTo
      expect(replaceStateSpy).toHaveBeenCalled();
      expect(window.location.pathname).toBe("/approve/loc_verified_999");
      expect(window.location.search).toBe("");
    });

    it("stale params handled silently: cleans code/state when no transaction exists and enables skipRedirectCallback", () => {
      // Setup stale URL without an active transaction in sessionStorage
      window.history.replaceState(
        {},
        document.title,
        "/?code=stale_code_123&state=stale_state_456&iss=https%3A%2F%2Ftest.auth0.com%2F",
      );
      sessionStorage.clear();

      render(
        <RouterProvider>
          <Auth0ProviderWithRedirect
            domain="test.auth0.com"
            clientId="test-client-id"
            audience="https://velvetai.example/api"
          >
            <div>Stale Params App</div>
          </Auth0ProviderWithRedirect>
        </RouterProvider>,
      );

      // Verify stale params were stripped immediately from the browser URL
      expect(window.location.search).toBe("");
      // Verify skipRedirectCallback was passed as true so Auth0 doesn't crash on invalid state
      expect(capturedAuth0Config.skipRedirectCallback).toBe(true);
    });

    it("legitimate params with active transaction in storage are preserved for Auth0 code exchange", () => {
      // Setup URL with matching active transaction in sessionStorage
      window.history.replaceState({}, document.title, "/?code=fresh_code&state=fresh_state");
      sessionStorage.setItem(
        "a0.spajs.txs.test-client-id",
        JSON.stringify({ state: "fresh_state" }),
      );

      render(
        <RouterProvider>
          <Auth0ProviderWithRedirect
            domain="test.auth0.com"
            clientId="test-client-id"
            audience="https://velvetai.example/api"
          >
            <div>Fresh Callback App</div>
          </Auth0ProviderWithRedirect>
        </RouterProvider>,
      );

      // Legitimate callback: skipRedirectCallback is false
      expect(capturedAuth0Config.skipRedirectCallback).toBe(false);
      sessionStorage.clear();
    });

    it("cleanStaleAuthParams directly strips stale parameters and returns true", () => {
      window.history.replaceState(
        {},
        document.title,
        "/test-path?code=123&state=abc&iss=https%3A%2F%2Fauth0.com%2F",
      );
      sessionStorage.clear();

      const wasCleaned = cleanStaleAuthParams("test-client-id");
      expect(wasCleaned).toBe(true);
      expect(window.location.pathname).toBe("/test-path");
      expect(window.location.search).toBe("");
    });
  });
});
