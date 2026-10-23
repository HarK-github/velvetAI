import { describe, it, expect } from "vitest";
import { formatMoney, getCurrencyScale, canonicalMoneySchema } from "../money.js";

describe("Authoritative Money Contract and Formatting", () => {
  describe("Canonical Money Schema Validation", () => {
    it("validates canonical wire shape with valueMinor decimal string and currency", () => {
      const validMoney = {
        valueMinor: "7500",
        currency: "USD",
      };
      const parsed = canonicalMoneySchema.parse(validMoney);
      expect(parsed.valueMinor).toBe("7500");
      expect(parsed.currency).toBe("USD");
    });

    it("rejects non-integer decimal strings, floats, and malformed minor units", () => {
      expect(() => canonicalMoneySchema.parse({ valueMinor: "75.00", currency: "USD" })).toThrow();
      expect(() => canonicalMoneySchema.parse({ valueMinor: "abc", currency: "USD" })).toThrow();
      expect(() => canonicalMoneySchema.parse({ valueMinor: 7500, currency: "USD" })).toThrow();
    });

    it("rejects non-3-character ISO currency codes", () => {
      expect(() => canonicalMoneySchema.parse({ valueMinor: "7500", currency: "US" })).toThrow();
      expect(() =>
        canonicalMoneySchema.parse({ valueMinor: "7500", currency: "DOLLARS" }),
      ).toThrow();
    });
  });

  describe("formatMoney Currency Scaling & Display Formatting", () => {
    it("renders USD 7500 as $75.00 and USD 2000 as $20.00", () => {
      expect(formatMoney({ valueMinor: "7500", currency: "USD" })).toBe("$75.00");
      expect(formatMoney({ valueMinor: "2000", currency: "USD" })).toBe("$20.00");
    });

    it("renders zero minor units properly ($0.00 when minor is '0', not fallback)", () => {
      expect(formatMoney({ valueMinor: "0", currency: "USD" })).toBe("$0.00");
    });

    it("renders small minor units with zero-padding (USD 5 -> $0.05, USD 50 -> $0.50)", () => {
      expect(formatMoney({ valueMinor: "5", currency: "USD" })).toBe("$0.05");
      expect(formatMoney({ valueMinor: "50", currency: "USD" })).toBe("$0.50");
    });

    it("renders zero-decimal currencies accurately without fraction digits (JPY 1000 -> ¥1,000)", () => {
      expect(getCurrencyScale("JPY")).toBe(0);
      expect(formatMoney({ valueMinor: "1000", currency: "JPY" })).toBe("¥1,000");
    });

    it("renders three-decimal currencies accurately with 3 fraction digits (KWD 1500 -> KWD 1.500)", () => {
      expect(getCurrencyScale("KWD")).toBe(3);
      const kwdFormatted = formatMoney({ valueMinor: "1500", currency: "KWD" });
      // Non-breaking space or standard space depending on Intl implementation
      expect(kwdFormatted.replace(/\u00a0/g, " ")).toBe("KWD 1.500");
    });

    it("renders negative amounts cleanly (-USD 7500 -> -$75.00)", () => {
      expect(formatMoney({ valueMinor: "-7500", currency: "USD" })).toBe("-$75.00");
    });

    it("handles BigInt and integer number inputs safely", () => {
      expect(formatMoney({ valueMinor: 7500n as any, currency: "USD" })).toBe("$75.00");
      expect(formatMoney({ valueMinor: 9500 as any, currency: "USD" })).toBe("$95.00");
    });
  });

  describe("Malformed, Missing, and Unknown Money Values", () => {
    it("renders visible data error for missing or undefined money objects, NEVER $0.00", () => {
      const resNull = formatMoney(null);
      expect(resNull).toBe("[Pricing unavailable]");
      expect(resNull).not.toBe("$0.00");

      const resUndefined = formatMoney(undefined);
      expect(resUndefined).toBe("[Pricing unavailable]");
      expect(resUndefined).not.toBe("$0.00");
    });

    it("renders visible data error for missing valueMinor, NEVER $0.00", () => {
      const res = formatMoney({ currency: "USD" });
      expect(res).toBe("[Pricing unavailable]");
      expect(res).not.toBe("$0.00");
    });

    it("renders visible data error for malformed non-integer string ('abc', '', 'NaN'), NEVER $0.00", () => {
      expect(formatMoney({ valueMinor: "abc", currency: "USD" })).toBe("[Pricing unavailable]");
      expect(formatMoney({ valueMinor: "", currency: "USD" })).toBe("[Pricing unavailable]");
      expect(formatMoney({ valueMinor: "NaN", currency: "USD" })).toBe("[Pricing unavailable]");
      expect(formatMoney({ valueMinor: "75.50", currency: "USD" })).toBe("[Pricing unavailable]");
    });

    it("renders visible data error for invalid currency codes, NEVER $0.00", () => {
      expect(formatMoney({ valueMinor: "7500", currency: "" })).toBe("[Pricing unavailable]");
      expect(formatMoney({ valueMinor: "7500", currency: "INVALID_LONG" })).toBe(
        "[Pricing unavailable]",
      );
    });

    it("supports custom fallback error labels for specific UI contexts", () => {
      expect(
        formatMoney(
          { valueMinor: "invalid", currency: "USD" },
          { fallbackErrorLabel: "Price error" },
        ),
      ).toBe("Price error");
    });
  });
});
