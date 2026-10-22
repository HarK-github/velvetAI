import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  canonicalHash,
  sha256Hex,
  preNormalizeNfcV1,
  validateNoDuplicateKeys,
  parseJsonRejectingDuplicates,
} from "../canonicalizer.js";

describe("Canonicalizer & RFC 8785 JCS (Acceptance Audit Requirement 5)", () => {
  it("RFC 8785 Vector: sorts object keys lexicographically by UTF-16 code units", () => {
    const objA = { z: 1, a: 2, m: 3 };
    const objB = { a: 2, m: 3, z: 1 };
    const objC = { m: 3, z: 1, a: 2 };

    expect(canonicalJson(objA)).toBe('{"a":2,"m":3,"z":1}');
    expect(canonicalJson(objB)).toBe('{"a":2,"m":3,"z":1}');
    expect(canonicalJson(objC)).toBe('{"a":2,"m":3,"z":1}');

    expect(canonicalHash(objA)).toBe(canonicalHash(objB));
    expect(canonicalHash(objA)).toBe(canonicalHash(objC));
  });

  it("RFC 8785 Vector: handles numbers, negative zero, and exponential notation", () => {
    // RFC 8785 Section 3.2.2.3: -0 must be serialized as 0
    expect(canonicalJson(-0, "pure-rfc8785")).toBe("0");
    expect(canonicalJson(1e6, "pure-rfc8785")).toBe("1000000");
    expect(canonicalJson(1.0, "pure-rfc8785")).toBe("1");
    expect(canonicalJson(0, "pure-rfc8785")).toBe("0");
    expect(canonicalJson(12345.67, "pure-rfc8785")).toBe("12345.67");
  });

  it("RFC 8785 Vector: handles whitespace, empty structures, and primitives", () => {
    expect(canonicalJson({}, "pure-rfc8785")).toBe("{}");
    expect(canonicalJson([], "pure-rfc8785")).toBe("[]");
    expect(canonicalJson(null, "pure-rfc8785")).toBe("null");
    expect(canonicalJson(true, "pure-rfc8785")).toBe("true");
    expect(canonicalJson(false, "pure-rfc8785")).toBe("false");
    expect(canonicalJson("", "pure-rfc8785")).toBe('""');
  });

  it("Profile distinction: pure-rfc8785 preserves NFD whereas velvetai-nfc-v1 normalizes to NFC", () => {
    // 'é' as single code point \u00E9 (NFC) vs 'e' + combining acute accent \u0301 (NFD)
    const nfcString = "caf\u00E9";
    const nfdString = "cafe\u0301";

    expect(nfcString).not.toBe(nfdString);

    // Pure RFC 8785 does not alter Unicode code points
    const pureNfc = canonicalJson({ name: nfcString }, "pure-rfc8785");
    const pureNfd = canonicalJson({ name: nfdString }, "pure-rfc8785");
    expect(pureNfc).not.toBe(pureNfd);

    // velvetai-nfc-v1 pre-normalizes to NFC
    const canonNfc = canonicalJson({ name: nfcString }, "velvetai-nfc-v1");
    const canonNfd = canonicalJson({ name: nfdString }, "velvetai-nfc-v1");
    expect(canonNfc).toBe(canonNfd);
    expect(preNormalizeNfcV1(nfdString)).toBe(nfcString);
    expect(canonicalHash({ name: nfcString })).toBe(canonicalHash({ name: nfdString }));
  });

  it("rejects non-finite numbers (NaN, Infinity, -Infinity)", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow();
  });

  it("rejects duplicate JSON keys before normal object parsing", () => {
    // Top-level duplicate key
    const duplicateTop = '{"serviceId":"s1","amount":100,"amount":200}';
    expect(() => validateNoDuplicateKeys(duplicateTop)).toThrow(
      /Duplicate JSON key detected: "amount"/,
    );
    expect(() => parseJsonRejectingDuplicates(duplicateTop)).toThrow(
      /Duplicate JSON key detected: "amount"/,
    );

    // Nested duplicate key
    const duplicateNested = '{"customer":{"email":"a@b.com","email":"c@d.com"}}';
    expect(() => validateNoDuplicateKeys(duplicateNested)).toThrow(
      /Duplicate JSON key detected: "email"/,
    );

    // Duplicate key in array of objects
    const duplicateInArray = '[{"id":"1"},{"id":"2","id":"3"}]';
    expect(() => validateNoDuplicateKeys(duplicateInArray)).toThrow(
      /Duplicate JSON key detected: "id"/,
    );

    // Valid JSON with identical key in DIFFERENT objects succeeds
    const validMultiObj = '{"slotA":{"time":"10:00"},"slotB":{"time":"10:00"}}';
    expect(() => validateNoDuplicateKeys(validMultiObj)).not.toThrow();
    const parsed = parseJsonRejectingDuplicates<{
      slotA: { time: string };
      slotB: { time: string };
    }>(validMultiObj);
    expect(parsed.slotA.time).toBe("10:00");
    expect(parsed.slotB.time).toBe("10:00");
  });

  it("handles complex nested structures deterministically", () => {
    const complex = {
      active: true,
      deleted: null,
      tags: ["alpha", "beta"],
      nested: {
        y: 2,
        x: 1,
      },
    };

    const expected =
      '{"active":true,"deleted":null,"nested":{"x":1,"y":2},"tags":["alpha","beta"]}';
    expect(canonicalJson(complex)).toBe(expected);
    expect(canonicalHash(complex)).toBe(sha256Hex(expected));
  });
});
