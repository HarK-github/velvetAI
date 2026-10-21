import { describe, it, expect } from "vitest";
import {
  moneyMinorSchema,
  moneySchema,
  getCurrencyScale,
  isSafeMoneyMinor,
} from "../primitives.js";

describe("Money Serialization & Currency Scale (Acceptance Audit Requirement 6)", () => {
  it("validates standard integer decimal strings for minor units", () => {
    const valid = moneyMinorSchema.parse("1500");
    expect(valid).toBe("1500");
    expect(typeof valid).toBe("string");

    // Zero is valid
    expect(moneyMinorSchema.parse("0")).toBe("0");

    // Negative integer decimal string is valid syntax for refunds/adjustments
    expect(moneyMinorSchema.parse("-500")).toBe("-500");
  });

  it("rejects non-integer, floating point, exponential, or malformed strings", () => {
    expect(() => moneyMinorSchema.parse("15.50")).toThrow();
    expect(() => moneyMinorSchema.parse("1e5")).toThrow();
    expect(() => moneyMinorSchema.parse("abc")).toThrow();
    expect(() => moneyMinorSchema.parse("")).toThrow();
    expect(() => moneyMinorSchema.parse(" 1500 ")).toThrow();
  });

  it("validates 2-decimal currencies (USD, EUR, GBP)", () => {
    expect(getCurrencyScale("USD")).toBe(2);
    expect(getCurrencyScale("EUR")).toBe(2);
    expect(getCurrencyScale("GBP")).toBe(2);

    const usdMoney = moneySchema.parse({
      currency: "USD",
      valueMinor: "1500", // $15.00
    });
    expect(usdMoney.valueMinor).toBe("1500");
    expect(usdMoney.currency).toBe("USD");
  });

  it("validates 0-decimal currencies (JPY, KRW, VND)", () => {
    expect(getCurrencyScale("JPY")).toBe(0);
    expect(getCurrencyScale("KRW")).toBe(0);
    expect(getCurrencyScale("VND")).toBe(0);

    const jpyMoney = moneySchema.parse({
      currency: "JPY",
      valueMinor: "3500", // 3,500 Yen (scale = 0)
    });
    expect(jpyMoney.valueMinor).toBe("3500");
    expect(jpyMoney.currency).toBe("JPY");
  });

  it("validates 3-decimal currencies (BHD, KWD, OMR)", () => {
    expect(getCurrencyScale("BHD")).toBe(3);
    expect(getCurrencyScale("KWD")).toBe(3);
    expect(getCurrencyScale("OMR")).toBe(3);

    const kwdMoney = moneySchema.parse({
      currency: "KWD",
      valueMinor: "1250", // 1.250 Dinar (scale = 3, 1000 fils = 1 KWD)
    });
    expect(kwdMoney.valueMinor).toBe("1250");
    expect(kwdMoney.currency).toBe("KWD");
  });

  it("tests min/max 64-bit integer limits and overflow boundaries", () => {
    const maxInt64 = "9223372036854775807";
    const minInt64 = "-9223372036854775808";
    const overflowInt64 = "9223372036854775808";
    const underflowInt64 = "-9223372036854775809";

    expect(isSafeMoneyMinor(maxInt64)).toBe(true);
    expect(isSafeMoneyMinor(minInt64)).toBe(true);
    expect(isSafeMoneyMinor("0")).toBe(true);

    expect(isSafeMoneyMinor(overflowInt64)).toBe(false);
    expect(isSafeMoneyMinor(underflowInt64)).toBe(false);
    expect(isSafeMoneyMinor("not-a-number")).toBe(false);
  });
});
