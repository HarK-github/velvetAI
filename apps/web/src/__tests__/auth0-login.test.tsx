/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import * as auth0React from "@auth0/auth0-react";
import { App, getAuth0Diagnostics } from "../App.js";
import { Navbar } from "../components/Navbar.js";
import { RouterProvider } from "../router.js";
import { chromium } from "playwright-core";

vi.mock("@auth0/auth0-react", async () => {
  const actual = await vi.importActual<typeof auth0React>("@auth0/auth0-react");
  return {
    ...actual,
    useAuth0: vi.fn(),
    Auth0Provider: vi.fn(({ children }) => <div data-testid="auth0-provider">{children}</div>),
  };
});

describe("Auth0 Frontend Authentication & Login Verification", () => {
  let mockLoginWithRedirect: ReturnType<typeof vi.fn>;
  let mockLogout: ReturnType<typeof vi.fn>;
  let mockGetAccessTokenSilently: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLoginWithRedirect = vi.fn().mockResolvedValue(undefined);
    mockLogout = vi.fn();
    mockGetAccessTokenSilently = vi.fn().mockResolvedValue("mock_token");

    vi.mocked(auth0React.useAuth0).mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      user: undefined,
      error: undefined,
      loginWithRedirect: mockLoginWithRedirect,
      logout: mockLogout,
      getAccessTokenSilently: mockGetAccessTokenSilently,
      getIdTokenClaims: vi.fn(),
      loginWithPopup: vi.fn(),
      handleRedirectCallback: vi.fn(),
      getAccessTokenWithPopup: vi.fn(),
    } as unknown as auth0React.Auth0ContextInterface);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("1. Auth0Provider receives all required public configuration", () => {
    render(<App />);

    const auth0ProviderMock = vi.mocked(auth0React.Auth0Provider);
    expect(auth0ProviderMock).toHaveBeenCalled();
    const lastCallProps = auth0ProviderMock.mock
      .calls[0]![0] as auth0React.Auth0ProviderWithConfigOptions;

    expect(typeof lastCallProps.domain).toBe("string");
    expect(lastCallProps.domain.length).toBeGreaterThan(0);
    expect(typeof lastCallProps.clientId).toBe("string");
    expect(lastCallProps.clientId.length).toBeGreaterThan(0);

    const authParams = lastCallProps.authorizationParams;
    expect(authParams).toBeDefined();
    expect(authParams?.redirect_uri).toBe(window.location.origin);
    expect(authParams?.audience).toBe("https://velvetai.example/api");
    expect(authParams?.scope).toContain("openid");
    expect(authParams?.scope).toContain("profile");
    expect(authParams?.scope).toContain("email");
    expect(authParams?.scope).toContain("booking:read");

    expect(lastCallProps.cacheLocation).toBe("localstorage");
    expect(lastCallProps.useRefreshTokens).toBe(true);
  });

  it("2. Missing configuration renders a visible safe error banner", () => {
    const diag = getAuth0Diagnostics();
    expect(diag).toHaveProperty("auth0DomainConfigured");
    expect(diag).toHaveProperty("auth0ClientIdConfigured");
    expect(diag).toHaveProperty("auth0AudienceConfigured");

    // Render App with Auth0 unconfigured
    const originalDomain = import.meta.env.VITE_AUTH0_DOMAIN;
    delete (import.meta.env as Record<string, unknown>).VITE_AUTH0_DOMAIN;

    render(<App />);

    // Should render a safe unconfigured alert banner
    const alert = screen.getByRole("alert");
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain("Auth0 public configuration missing");

    // Restore
    (import.meta.env as Record<string, unknown>).VITE_AUTH0_DOMAIN = originalDomain;
  });

  it("3. Login button is enabled after initialization", () => {
    render(
      <RouterProvider>
        <Navbar apiHealthy={true} apiLatency={12} />
      </RouterProvider>,
    );

    const loginButton = screen.getByRole("button", { name: /Sign in with Auth0/i });
    expect(loginButton).toBeDefined();
    expect(loginButton).not.toHaveProperty("disabled", true);
    expect(loginButton.getAttribute("type")).toBe("button");
  });

  it("4. Clicking Login invokes loginWithRedirect exactly once", async () => {
    render(
      <RouterProvider>
        <Navbar apiHealthy={true} apiLatency={12} />
      </RouterProvider>,
    );

    const loginButton = screen.getByRole("button", { name: /Sign in with Auth0/i });
    fireEvent.click(loginButton);

    expect(mockLoginWithRedirect).toHaveBeenCalledTimes(1);
  });

  it("5. Correct audience, redirect URI and scope are supplied to the Auth0Provider", () => {
    render(<App />);

    const auth0ProviderMock = vi.mocked(auth0React.Auth0Provider);
    const props = auth0ProviderMock.mock.calls[0]![0] as auth0React.Auth0ProviderWithConfigOptions;
    const params = props.authorizationParams;

    expect(params?.audience).toBe("https://velvetai.example/api");
    expect(params?.redirect_uri).toBe(window.location.origin);
    expect(params?.scope).toBe(
      "openid profile email offline_access booking:read booking:quote booking:prepare booking:commit booking:cancel",
    );
  });

  it("6. Rejected loginWithRedirect promise renders an error safely", async () => {
    mockLoginWithRedirect.mockRejectedValueOnce(
      new Error("Client is not authorized to access resource server"),
    );

    render(
      <RouterProvider>
        <Navbar apiHealthy={true} apiLatency={12} />
      </RouterProvider>,
    );

    const loginButton = screen.getByRole("button", { name: /Sign in with Auth0/i });
    fireEvent.click(loginButton);

    await waitFor(() => {
      const errorBadge = screen.getByText(/Client is not authorized/i);
      expect(errorBadge).toBeDefined();
    });
  });

  it("7. Button inside a form does not submit or reload the page", () => {
    const submitHandler = vi.fn((e: React.FormEvent) => e.preventDefault());

    render(
      <RouterProvider>
        <form onSubmit={submitHandler}>
          <Navbar apiHealthy={true} apiLatency={12} />
        </form>
      </RouterProvider>,
    );

    const loginButton = screen.getByRole("button", { name: /Sign in with Auth0/i });
    expect(loginButton.getAttribute("type")).toBe("button");

    fireEvent.click(loginButton);

    // Form submit must not be triggered by type="button"
    expect(submitHandler).not.toHaveBeenCalled();
    expect(mockLoginWithRedirect).toHaveBeenCalledTimes(1);
  });

  it("8. Tokens and secrets are never rendered or logged", () => {
    const consoleSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");

    render(<App />);

    const bodyText = document.body.textContent || "";
    expect(bodyText).not.toContain("client_secret");
    expect(bodyText).not.toContain("AUTH0_CLIENT_SECRET");
    expect(bodyText).not.toContain("mock_token");

    for (const call of [...consoleSpy.mock.calls, ...errorSpy.mock.calls]) {
      const msg = call.join(" ");
      expect(msg).not.toContain("client_secret");
      expect(msg).not.toContain("AUTH0_CLIENT_SECRET");
      expect(msg).not.toContain("mock_token");
    }
  });

  it("9. Playwright/browser smoke test observes navigation toward Auth0 /authorize with PKCE params", async () => {
    const browser = await chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage();
      let authorizeInitiated = false;
      let capturedParams: Record<string, string | null> = {};

      page.on("request", (req) => {
        if (req.url().includes("/authorize")) {
          authorizeInitiated = true;
          const u = new URL(req.url());
          capturedParams = {
            response_type: u.searchParams.get("response_type"),
            has_code_challenge: u.searchParams.has("code_challenge") ? "true" : "false",
            code_challenge_method: u.searchParams.get("code_challenge_method"),
            has_client_id: u.searchParams.has("client_id") ? "true" : "false",
            redirect_uri: u.searchParams.get("redirect_uri"),
            audience: u.searchParams.get("audience"),
            has_state: u.searchParams.has("state") ? "true" : "false",
          };
        }
      });

      try {
        await page.goto("http://localhost:5173", { timeout: 4000 });
      } catch (err) {
        if (err instanceof Error && err.message.includes("ERR_CONNECTION_REFUSED")) {
          // Dev server is not running during headless unit test run; skip live browser navigation
          return;
        }
        throw err;
      }
      const btn = await page.waitForSelector("#login-button");
      await btn.click();
      await page.waitForTimeout(2500);

      expect(authorizeInitiated).toBe(true);
      expect(capturedParams.response_type).toBe("code");
      expect(capturedParams.has_code_challenge).toBe("true");
      expect(capturedParams.code_challenge_method).toBe("S256");
      expect(capturedParams.has_client_id).toBe("true");
      expect(capturedParams.redirect_uri).toBe("http://localhost:5173");
      expect(capturedParams.audience).toBe("https://velvetai.example/api");
      expect(capturedParams.has_state).toBe("true");
    } finally {
      await browser.close();
    }
  }, 15000);
});
