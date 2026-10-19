import { describe, it, expect } from "vitest";
import {
  uuidSchema,
  generateUUIDv7,
  currencyCodeSchema,
  moneyMinorSchema,
  ianaTimeZoneSchema,
  createProblemDetails,
} from "../index.js";

describe("Contracts and Branded Primitives", () => {
  it("validates UUIDs correctly", () => {
    const validUuid = "0192f5d2-1111-7111-8111-111111111111";
    expect(uuidSchema.parse(validUuid)).toBe(validUuid);
    expect(() => uuidSchema.parse("invalid-uuid")).toThrow();
  });

  it("generates valid UUIDv7 format", () => {
    const id = generateUUIDv7();
    expect(uuidSchema.parse(id)).toBe(id);
    expect(id.charAt(14)).toBe("7"); // version 7
    expect(["8", "9", "a", "b"]).toContain(id.charAt(19).toLowerCase()); // variant 1
  });

  it("validates currency codes", () => {
    expect(currencyCodeSchema.parse("USD")).toBe("USD");
    expect(currencyCodeSchema.parse("eur")).toBe("EUR");
    expect(() => currencyCodeSchema.parse("US")).toThrow();
  });

  it("handles money minor units as bigint without floating point loss", () => {
    const val = moneyMinorSchema.parse(5000);
    expect(val).toBe(5000n);
    const bigVal = moneyMinorSchema.parse(10000000000n);
    expect(bigVal).toBe(10000000000n);
  });

  it("validates IANA time zones", () => {
    expect(ianaTimeZoneSchema.parse("UTC")).toBe("UTC");
    expect(ianaTimeZoneSchema.parse("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(ianaTimeZoneSchema.parse("America/New_York")).toBe("America/New_York");
    expect(() => ianaTimeZoneSchema.parse("Fake/Zone")).toThrow();
  });

  it("creates valid ProblemDetails RFC 9457 objects", () => {
    const problem = createProblemDetails({
      title: "Conflict",
      status: 409,
      code: "slot_unavailable",
      detail: "Slot already taken",
    });
    expect(problem.status).toBe(409);
    expect(problem.code).toBe("slot_unavailable");
    expect(problem.type).toBe("https://api.velvetai.example/problems/slot_unavailable");
  });
});
