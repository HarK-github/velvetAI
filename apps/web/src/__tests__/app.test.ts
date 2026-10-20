import { describe, it, expect } from "vitest";
import { App } from "../App.js";
import { HomePage } from "../pages/HomePage.js";
import { BookingPage } from "../pages/BookingPage.js";
import { SchedulePage } from "../pages/SchedulePage.js";
import { PolicyPage } from "../pages/PolicyPage.js";
import { StatusPage } from "../pages/StatusPage.js";
import { RouterProvider, Link, useRouter } from "../router.js";
import { apiClient, VelvetApiClient } from "../api-client.js";
import {
  LoadingState,
  EmptyState,
  ValidationErrorState,
  ForbiddenState,
  DependencyErrorState,
} from "../components/UIStates.js";

describe("Web App Multi-Page Architecture", () => {
  it("exports App component function", () => {
    expect(typeof App).toBe("function");
  });

  it("exports all distinct page components", () => {
    expect(typeof HomePage).toBe("function");
    expect(typeof BookingPage).toBe("function");
    expect(typeof SchedulePage).toBe("function");
    expect(typeof PolicyPage).toBe("function");
    expect(typeof StatusPage).toBe("function");
  });

  it("exports Router utilities", () => {
    expect(typeof RouterProvider).toBe("function");
    expect(typeof Link).toBe("function");
    expect(typeof useRouter).toBe("function");
  });

  it("exports typed API client and all explicit UI state components", () => {
    expect(apiClient).toBeInstanceOf(VelvetApiClient);
    expect(typeof LoadingState).toBe("function");
    expect(typeof EmptyState).toBe("function");
    expect(typeof ValidationErrorState).toBe("function");
    expect(typeof ForbiddenState).toBe("function");
    expect(typeof DependencyErrorState).toBe("function");
  });
});
