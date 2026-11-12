import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isApiConfigured, resolveApiBaseUrl, VelvetApiClient, ApiError } from "../api-client.js";

describe("No Hardcoded URLs Scanner & API Base URL Production Safety", () => {
  it("scans apps/web/src (excluding __tests__) and fails if 'localhost:3000' or 'http://localhost' appears outside api-client.ts", () => {
    // Resolve apps/web/src directory
    const srcDir = path.resolve(__dirname, "..");
    const violations: Array<{ file: string; line: number; matched: string; preview: string }> = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Exclude __tests__ directories
          if (entry.name === "__tests__") {
            continue;
          }
          scanDir(fullPath);
        } else if (entry.isFile()) {
          // Exclude test and Vitest setup files
          if (
            entry.name.endsWith(".test.ts") ||
            entry.name.endsWith(".test.tsx") ||
            entry.name.endsWith(".spec.ts") ||
            entry.name.endsWith(".spec.tsx") ||
            entry.name === "test-setup.ts"
          ) {
            continue;
          }
          // The ONLY file allowed to have local development fallback is api-client.ts
          if (entry.name === "api-client.ts") {
            continue;
          }

          const relativePath = path.relative(srcDir, fullPath);
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");

          lines.forEach((line, index) => {
            if (line.includes("localhost:3000")) {
              violations.push({
                file: relativePath,
                line: index + 1,
                matched: "localhost:3000",
                preview: line.trim(),
              });
            } else if (line.includes("http://localhost")) {
              violations.push({
                file: relativePath,
                line: index + 1,
                matched: "http://localhost",
                preview: line.trim(),
              });
            }
          });
        }
      }
    }

    scanDir(srcDir);

    expect(
      violations,
      `Found hardcoded localhost URLs in apps/web/src files:\n${violations
        .map((v) => `  ${v.file}:${v.line} [${v.matched}] -> ${v.preview}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  describe("API Base URL and Production Configuration Guard", () => {
    const originalConsoleError = console.error;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      console.error = originalConsoleError;
      vi.unstubAllEnvs();
    });

    it("identifies API as unconfigured in production when VITE_API_BASE_URL is missing", () => {
      vi.stubEnv("VITE_API_BASE_URL", "");
      vi.stubEnv("PROD", "true");
      vi.stubEnv("DEV", "false");
      vi.stubEnv("NODE_ENV", "production");

      // In production without VITE_API_BASE_URL, isApiConfigured() returns false
      expect(isApiConfigured()).toBe(false);
    });

    it("identifies API as configured when VITE_API_BASE_URL is provided", () => {
      vi.stubEnv("VITE_API_BASE_URL", "https://api.velvetai.com");
      vi.stubEnv("NODE_ENV", "production");

      expect(isApiConfigured()).toBe(true);
    });

    it("resolveApiBaseUrl logs console.error and returns empty string in production when VITE_API_BASE_URL is missing", () => {
      vi.stubEnv("VITE_API_BASE_URL", "");
      vi.stubEnv("PROD", "true");
      vi.stubEnv("DEV", "false");
      vi.stubEnv("NODE_ENV", "production");

      const consoleErrorMock = vi.fn();
      console.error = consoleErrorMock;

      const resolved = resolveApiBaseUrl();
      expect(resolved).toBe("");
      expect(consoleErrorMock).toHaveBeenCalled();
      expect(consoleErrorMock.mock.calls[0]?.[0]).toContain(
        "API not configured: VITE_API_BASE_URL environment variable is missing",
      );
    });

    it("VelvetApiClient fails loudly with ApiError 500 when baseUrl is empty", async () => {
      const consoleErrorMock = vi.fn();
      console.error = consoleErrorMock;

      const client = new VelvetApiClient({ baseUrl: "" });

      await expect(client.getServices()).rejects.toThrow(ApiError);
      try {
        await client.getServices();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(500);
        expect(apiErr.problem.code).toBe("api_not_configured");
        expect(apiErr.problem.title).toBe("API Not Configured");
      }
    });

    it("createBookingQuote attaches idempotency key automatically", async () => {
      let capturedHeaders: Headers | undefined;
      let capturedBody: any;

      const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(init?.body as string);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              quoteId: "quote-test-1",
              total: { minor: 5000, currency: "USD" },
              deposit: { minor: 1000, currency: "USD" },
              cancellationPolicy: { policyId: "pol-1", version: 1, summary: "Standard" },
            }),
        });
      });

      const client = new VelvetApiClient({ baseUrl: "https://api.velvetai.example" });
      (client as any).request = async (endpoint: string, options: RequestInit = {}) => {
        return mockFetch(`https://api.velvetai.example${endpoint}`, options).then((r: any) =>
          r.json(),
        );
      };

      await client.createBookingQuote({
        serviceId: "01932b10-0001-7000-8000-000000000001",
        startsAt: "2026-10-25T10:00:00.000Z",
        timeZone: "UTC",
      });

      expect(capturedHeaders?.get("idempotency-key")).toMatch(/^quote-/);
      expect(capturedBody.locationId).toBe("01932b10-0000-7000-8000-000000000001");
    });

    it("createBookingHold attaches idempotency key automatically", async () => {
      let capturedHeaders: Headers | undefined;

      const client = new VelvetApiClient({ baseUrl: "https://api.velvetai.example" });
      (client as any).request = async (endpoint: string, options: RequestInit = {}) => {
        capturedHeaders = new Headers(options.headers);
        return {
          bookingId: "b-123",
          status: "HELD",
          holdExpiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      };

      await client.createBookingHold({
        quoteId: "q-123",
        customer: { email: "test@example.com" },
      });

      expect(capturedHeaders?.get("idempotency-key")).toMatch(/^hold-/);
    });
  });
});
