/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { SafeMarkdown, isSafeUrl } from "../components/SafeMarkdown.js";

describe("SafeMarkdown Component", () => {
  it("renders markdown headings as proper heading tags", () => {
    const markdown = "# Luxury Header 1\n## Luxury Header 2\n### Luxury Header 3";
    render(<SafeMarkdown content={markdown} />);

    expect(screen.getByRole("heading", { level: 3, name: "Luxury Header 1" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Luxury Header 2" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 5, name: "Luxury Header 3" })).toBeTruthy();
  });

  it("renders bold and emphasis formatting correctly", () => {
    const markdown = "Welcome to **VelvetAI** with *concierge* service.";
    render(<SafeMarkdown content={markdown} />);

    const strongEl = screen.getByText("VelvetAI");
    expect(strongEl.tagName.toLowerCase()).toBe("strong");
    expect(strongEl.className).toContain("ai-md-strong");

    const emEl = screen.getByText("concierge");
    expect(emEl.tagName.toLowerCase()).toBe("em");
    expect(emEl.className).toContain("ai-md-em");
  });

  it("renders ordered and unordered lists correctly", () => {
    const markdown = "- Cut & Style\n- Beard Grooming\n- Scalp Treatment";
    render(<SafeMarkdown content={markdown} />);

    const listItems = screen.getAllByRole("listitem");
    expect(listItems).toHaveLength(3);
    expect(listItems[0]?.textContent).toBe("Cut & Style");
    expect(listItems[1]?.textContent).toBe("Beard Grooming");
    expect(listItems[2]?.textContent).toBe("Scalp Treatment");
  });

  it("does not execute raw HTML scripts or inject DOM elements", () => {
    const maliciousHtml =
      '<script>window.__pwned = true;</script><img src="x" onerror="alert(1)" /><div id="injected-div">Sneaky</div>';
    render(<SafeMarkdown content={maliciousHtml} />);

    // Script must not execute or be inserted as an active element
    expect((window as any).__pwned).toBeUndefined();
    expect(document.querySelector("script")).toBeNull();
    // Raw HTML div must not be parsed into DOM nodes (without rehype-raw it renders escaped text or is omitted)
    expect(document.getElementById("injected-div")).toBeNull();
  });

  it("rejects dangerous javascript:, vbscript:, and data: link protocols", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("JAVASCRIPT:alert(document.cookie)")).toBe(false);
    expect(isSafeUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeUrl("https://velvetai.luxury/booking")).toBe(true);
    expect(isSafeUrl("/approve?id=123")).toBe(true);

    const markdown =
      "[Dangerous Link](javascript:alert(1)) and [Safe Link](https://velvetai.luxury/terms)";
    render(<SafeMarkdown content={markdown} />);

    // Dangerous link must not have an anchor with href="javascript:..."
    const links = screen.queryAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe("Safe Link");
    expect(links[0]?.getAttribute("href")).toBe("https://velvetai.luxury/terms");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0]?.getAttribute("target")).toBe("_blank");

    // The dangerous link text should still render as a safe span, not an active link
    expect(screen.getByText("Dangerous Link").tagName.toLowerCase()).toBe("span");
  });

  it("preserves streaming partial text updates without duplicating DOM nodes", () => {
    const { rerender, container } = render(<SafeMarkdown content="Here is our " />);
    expect(screen.getByText("Here is our")).toBeTruthy();

    rerender(<SafeMarkdown content="Here is our current catalog of services:" />);
    expect(screen.getByText("Here is our current catalog of services:")).toBeTruthy();

    // Verify there is only one prose container and no duplicated sibling text blocks
    const proseContainers = container.querySelectorAll(".ai-markdown-prose");
    expect(proseContainers).toHaveLength(1);
  });
});
