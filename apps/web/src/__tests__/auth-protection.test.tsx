/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { VelvetApiClient, ApiError } from "../api-client.js";
import { AskAIDrawer } from "../components/AskAIDrawer.js";
import { computeAuthDiagnostic, isJwtShaped } from "../lib/auth-config.js";

let mockUseChatState = {
  messages: [] as any[],
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: "ready",
  error: null as Error | null,
};

let capturedTransport: any = null;

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn((opts?: any) => {
    if (opts?.transport) {
      capturedTransport = opts.transport;
    }
    return mockUseChatState;
  }),
}));

const mockGetAccessTokenSilently = vi.fn();
let mockIsAuthenticated = true;
let mockIsLoading = false;

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: vi.fn(() => ({
    isLoading: mockIsLoading,
    isAuthenticated: mockIsAuthenticated,
    getAccessTokenSilently: mockGetAccessTokenSilently,
  })),
}));

describe("Auth Protection & Dev-Token Prevention Guardrails", () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mockIsAuthenticated = true;
    mockIsLoading = false;
    mockGetAccessTokenSilently.mockReset();
    mockUseChatState = {
      messages: [],
      sendMessage: vi.fn(),
      stop: vi.fn(),
      status: "ready",
      error: null,
    };
    capturedTransport = null;

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/v1/ai/status")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              provider: "fake",
              model: "fake-model",
              realProviderConfigured: false,
              realProviderVerified: false,
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ services: [], total: 0 }),
      });
    }) as any;
  });

  afterEach(() => {
    cleanup();
  });

  describe("Requirement 1 & 2: Browser API Client Token Acquisition", () => {
    it("Auth0 configured + token acquisition success → Auth0 token attached", async () => {
      const client = new VelvetApiClient({ baseUrl: "http://localhost:3000" });
      const fakeJwt = "header.payload.signature";

      client.setTokenProvider(async () => fakeJwt);

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ services: [], total: 0 }),
      });
      globalThis.fetch = fetchSpy as any;

      await client.getServices();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const callArgs = fetchSpy.mock.calls[0];
      const headers = callArgs[1]?.headers as Headers;
      expect(headers.get("authorization")).toBe(`Bearer ${fakeJwt}`);
    });

    it("Auth0 configured + token acquisition failure → no API request made", async () => {
      const client = new VelvetApiClient({ baseUrl: "http://localhost:3000" });

      client.setTokenProvider(async () => {
        throw new Error("Consent required / silent token acquisition failed");
      });

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      await expect(client.getServices()).rejects.toThrow(ApiError);
      // Critical check: network request must be stopped
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("No test-token fallback when Auth0 is configured", async () => {
      const client = new VelvetApiClient({ baseUrl: "http://localhost:3000" });
      // No token provider and no token set
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      await expect(client.getServices()).rejects.toThrow(ApiError);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("Requirement 2: Ask AI Transport Token Protection", () => {
    it("Auth0 configured + token acquisition success → Auth0 token attached to chat transport", async () => {
      const fakeJwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRoMHx1c2VyMTIzIn0.signature";
      mockGetAccessTokenSilently.mockResolvedValue(fakeJwt);

      render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

      expect(capturedTransport).toBeDefined();
      const headers = await capturedTransport.headers();
      expect(headers).toEqual({
        authorization: `Bearer ${fakeJwt}`,
      });
      expect(headers.authorization).not.toContain("test-token");
    });

    it("Auth0 configured + token acquisition failure → transport throws error and never provides test-token", async () => {
      mockGetAccessTokenSilently.mockRejectedValue(new Error("Login required"));

      render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

      expect(capturedTransport).toBeDefined();
      await expect(capturedTransport.headers()).rejects.toThrow(/AUTH_REQUIRED/);
    });

    it("Auth0 configured + unauthenticated user → transport stops request immediately", async () => {
      mockIsAuthenticated = false;

      render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

      expect(capturedTransport).toBeDefined();
      await expect(capturedTransport.headers()).rejects.toThrow(/AUTH_REQUIRED/);
    });

    it("Immediate Ask AI submit after Auth0 redirect waits for token", () => {
      // Simulate Auth0 redirect state where auth state loading is active
      mockIsLoading = true;
      mockIsAuthenticated = true;

      render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

      const input = screen.getByRole("textbox") as HTMLInputElement;
      const sendButton = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;

      // Input and send button must be disabled while Auth0 redirect/loading is active
      expect(input.disabled).toBe(true);
      expect(sendButton.disabled).toBe(true);
    });

    it("Subsequent requests obtain/refresh headers safely", async () => {
      mockIsAuthenticated = true;
      const token1 = "token.part1.sig";
      const token2 = "token.part2.sig";

      mockGetAccessTokenSilently
        .mockResolvedValueOnce("init.token.sig")
        .mockResolvedValueOnce(token1)
        .mockResolvedValueOnce(token2);

      render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

      const headers1 = await capturedTransport.headers();
      expect(headers1.authorization).toBe(`Bearer ${token1}`);

      const headers2 = await capturedTransport.headers();
      expect(headers2.authorization).toBe(`Bearer ${token2}`);
    });

    it("Logout aborts the stream", () => {
      mockUseChatState.status = "streaming";
      mockIsAuthenticated = true;

      const { rerender } = render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

      expect(mockUseChatState.stop).not.toHaveBeenCalled();

      // Trigger logout
      mockIsAuthenticated = false;
      rerender(<AskAIDrawer isOpen={true} onClose={() => {}} />);

      expect(mockUseChatState.stop).toHaveBeenCalled();
    });

    it("No token is rendered or logged in the DOM", async () => {
      const secretJwt = "super_secret_jwt_token_123456789.payload.sig";
      mockGetAccessTokenSilently.mockResolvedValue(secretJwt);

      const { container } = render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

      expect(container.innerHTML).not.toContain(secretJwt);
    });
  });

  describe("Requirement 6: Safe Login / Token Error Display", () => {
    it("Ask AI shows a safe login error on AUTH_REQUIRED", () => {
      mockUseChatState.error = new Error("AUTH_REQUIRED: Please sign in with Auth0");

      render(<AskAIDrawer isOpen={true} onClose={() => {}} />);

      const alert = screen.getByRole("alert");
      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain(
        "Authentication required. Please sign in with Auth0 to access the concierge.",
      );
      // Ensure no tokens or internal error stacks leaked
      expect(alert.textContent).not.toContain("test-token");
      expect(alert.textContent).not.toContain("stack");
    });

    it("Ask AI maps safe public error codes cleanly", () => {
      const testCases = [
        {
          raw: "ai_provider_authentication",
          expected: "AI provider authentication failed. Please verify provider credentials.",
        },
        {
          raw: "ai_model_not_found",
          expected: "AI model not found or currently unavailable.",
        },
        {
          raw: "ai_quota_exceeded",
          expected: "AI quota exceeded. Please try again later.",
        },
        {
          raw: "ai_provider_unavailable",
          expected: "AI Provider service is currently unavailable. Please try again shortly.",
        },
        {
          raw: "ai_stream_error",
          expected: "An error occurred during AI response streaming. Please retry.",
        },
      ];

      for (const tc of testCases) {
        mockUseChatState.error = new Error(tc.raw);
        const { unmount } = render(<AskAIDrawer isOpen={true} onClose={() => {}} />);
        const alert = screen.getByRole("alert");
        expect(alert.textContent).toContain(tc.expected);
        unmount();
      }
    });
  });

  describe("Requirement 7: Safe Development Diagnostic", () => {
    it("computes diagnostic containing booleans and authSource only, never returning token", () => {
      const jwtToken = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123";
      const diagJwt = computeAuthDiagnostic(jwtToken);

      expect(diagJwt).toEqual({
        authSource: "auth0",
        accessTokenPresent: true,
        accessTokenJwtShaped: true,
      });

      // Assert window.__AUTH_DIAGNOSTIC__ is set with safe booleans
      expect((window as any).__AUTH_DIAGNOSTIC__).toEqual({
        authSource: "auth0",
        accessTokenPresent: true,
        accessTokenJwtShaped: true,
      });
      // Diagnostic must NEVER store the raw token
      expect(Object.values(diagJwt)).not.toContain(jwtToken);
      expect((diagJwt as any).token).toBeUndefined();

      // Empty / unauthenticated state
      const diagNone = computeAuthDiagnostic(undefined);
      expect(diagNone).toEqual({
        authSource: "none",
        accessTokenPresent: false,
        accessTokenJwtShaped: false,
      });

      // Null state
      const diagNull = computeAuthDiagnostic(null);
      expect(diagNull).toEqual({
        authSource: "none",
        accessTokenPresent: false,
        accessTokenJwtShaped: false,
      });
    });

    it("isJwtShaped accurately validates 3-part non-empty tokens", () => {
      expect(isJwtShaped("aaa.bbb.ccc")).toBe(true);
      expect(isJwtShaped("header.payload.signature")).toBe(true);
      expect(isJwtShaped("test-token:123:456:BUYER:1")).toBe(false);
      expect(isJwtShaped("not-a-jwt")).toBe(false);
      expect(isJwtShaped("..")).toBe(false);
      expect(isJwtShaped("a.b.")).toBe(false);
      expect(isJwtShaped("")).toBe(false);
      expect(isJwtShaped(undefined)).toBe(false);
    });
  });
});
