/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { sanitizeReturnTo } from "../lib/auth-config.js";
import { Auth0ProviderWithRedirect } from "../App.js";
import { RouterProvider, useRouter } from "../router.js";

// Mock @auth0/auth0-react
let capturedAuth0Config: any = null;
vi.mock("@auth0/auth0-react", () => ({
  Auth0Provider: ({ children, ...props }: any) => {
    capturedAuth0Config = props;
    return <div data-testid="auth0-provider-mock">{children}</div>;
  },
  useAuth0: () => ({
    isAuthenticated: true,
    user: { name: "Test Buyer", email: "test@velvetai.internal" },
    loginWithRedirect: vi.fn(),
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
  });
});
