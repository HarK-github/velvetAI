/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "../components/ErrorBoundary.js";

const ProblemChild: React.FC<{ shouldThrow?: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) {
    throw new Error("Simulated render crash");
  }
  return <div data-testid="child-content">Normal render</div>;
};

describe("ErrorBoundary Component", () => {
  afterEach(() => {
    cleanup();
  });
  it("renders normal children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <ProblemChild shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("child-content").textContent).toBe("Normal render");
  });

  it("catches render errors and renders the friendly fallback UI with reload button", () => {
    // Suppress console.error in vitest output for expected error throw
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ProblemChild shouldThrow={true} />
      </ErrorBoundary>,
    );

    const fallback = screen.getByRole("alert");
    expect(fallback).toBeDefined();
    expect(fallback.id).toBe("error-boundary-fallback");
    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(
      screen.getByText(
        "An unexpected error occurred during rendering. Please reload the page to restore your session.",
      ),
    ).toBeDefined();

    const reloadBtn = screen.getByRole("button", { name: "Reload" });
    expect(reloadBtn).toBeDefined();

    consoleSpy.mockRestore();
  });

  it("triggers reload on reload button click", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ProblemChild shouldThrow={true} />
      </ErrorBoundary>,
    );

    const reloadBtn = screen.getByRole("button", { name: "Reload" });
    fireEvent.click(reloadBtn);
    expect(reloadMock).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
