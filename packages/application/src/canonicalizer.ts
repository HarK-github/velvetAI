import crypto from "node:crypto";
import canonicalize from "canonicalize";

/**
 * VelvetAI NFC Pre-Normalization Profile v1 (`velvetai-nfc-v1`).
 * Recursively traverses data structures and normalizes all string values and object keys
 * to Unicode Normalization Form C (NFC).
 * Note: Pure RFC 8785 (JCS) does not perform Unicode normalization; this is an explicit
 * versioned pre-normalization profile applied prior to standard RFC 8785 JCS serialization.
 */
export function preNormalizeNfcV1<T>(input: T): T {
  if (typeof input === "string") {
    return input.normalize("NFC") as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => preNormalizeNfcV1(item)) as unknown as T;
  }
  if (input !== null && typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input)) {
      result[key.normalize("NFC")] = preNormalizeNfcV1(val);
    }
    return result as unknown as T;
  }
  return input;
}

/**
 * Validates that raw JSON string contains no duplicate keys at any object depth
 * BEFORE standard object parsing (which silently overwrites duplicate keys).
 * Throws an error immediately upon encountering any duplicated key.
 */
export function validateNoDuplicateKeys(rawJson: string): void {
  let i = 0;
  const len = rawJson.length;

  function skipWhitespace(): void {
    while (i < len) {
      const ch = rawJson.charCodeAt(i);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        i++;
      } else {
        break;
      }
    }
  }

  function parseString(): string {
    i++; // skip opening quote
    let str = "";
    while (i < len) {
      const ch = rawJson[i];
      if (ch === '"') {
        i++;
        return str;
      }
      if (ch === "\\") {
        i++;
        if (i >= len) throw new Error("Unterminated string escape in JSON");
        const esc = rawJson[i];
        if (esc === '"' || esc === "\\" || esc === "/") {
          str += esc;
          i++;
        } else if (esc === "b") {
          str += "\b";
          i++;
        } else if (esc === "f") {
          str += "\f";
          i++;
        } else if (esc === "n") {
          str += "\n";
          i++;
        } else if (esc === "r") {
          str += "\r";
          i++;
        } else if (esc === "t") {
          str += "\t";
          i++;
        } else if (esc === "u") {
          i++;
          const hex = rawJson.slice(i, i + 4);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Error("Invalid unicode escape in JSON");
          }
          str += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          throw new Error(`Invalid escape character in JSON: \\${esc}`);
        }
      } else {
        str += ch;
        i++;
      }
    }
    throw new Error("Unterminated string in JSON");
  }

  function parseValue(): void {
    skipWhitespace();
    if (i >= len) return;
    const ch = rawJson[i];
    if (ch === "{") {
      parseObject();
    } else if (ch === "[") {
      parseArray();
    } else if (ch === '"') {
      parseString();
    } else if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
      parseNumber();
    } else if (rawJson.startsWith("true", i)) {
      i += 4;
    } else if (rawJson.startsWith("false", i)) {
      i += 5;
    } else if (rawJson.startsWith("null", i)) {
      i += 4;
    } else {
      throw new Error(`Unexpected character at offset ${i}: ${ch}`);
    }
  }

  function parseNumber(): void {
    while (i < len) {
      const ch = rawJson[i];
      if (
        (ch !== undefined && ch >= "0" && ch <= "9") ||
        ch === "-" ||
        ch === "+" ||
        ch === "." ||
        ch === "e" ||
        ch === "E"
      ) {
        i++;
      } else {
        break;
      }
    }
  }

  function parseArray(): void {
    i++; // skip '['
    skipWhitespace();
    if (i < len && rawJson[i] === "]") {
      i++;
      return;
    }
    while (i < len) {
      parseValue();
      skipWhitespace();
      if (i < len && rawJson[i] === ",") {
        i++;
        skipWhitespace();
      } else if (i < len && rawJson[i] === "]") {
        i++;
        return;
      } else {
        throw new Error(`Expected ',' or ']' in array at offset ${i}`);
      }
    }
  }

  function parseObject(): void {
    i++; // skip '{'
    skipWhitespace();
    if (i < len && rawJson[i] === "}") {
      i++;
      return;
    }
    const seenKeys = new Set<string>();
    while (i < len) {
      skipWhitespace();
      if (i >= len || rawJson[i] !== '"') {
        throw new Error(`Expected string key in object at offset ${i}`);
      }
      const key = parseString();
      if (seenKeys.has(key)) {
        throw new Error(`Duplicate JSON key detected: "${key}"`);
      }
      seenKeys.add(key);

      skipWhitespace();
      if (i >= len || rawJson[i] !== ":") {
        throw new Error(`Expected ':' after key at offset ${i}`);
      }
      i++; // skip ':'
      parseValue();

      skipWhitespace();
      if (i < len && rawJson[i] === ",") {
        i++;
        skipWhitespace();
      } else if (i < len && rawJson[i] === "}") {
        i++;
        return;
      } else {
        throw new Error(`Expected ',' or '}' in object at offset ${i}`);
      }
    }
  }

  parseValue();
  skipWhitespace();
  if (i < len) {
    throw new Error(`Trailing characters in JSON at offset ${i}`);
  }
}

/**
 * Parses JSON while guaranteeing that no duplicate keys exist at any object depth.
 */
export function parseJsonRejectingDuplicates<T = unknown>(rawJson: string): T {
  validateNoDuplicateKeys(rawJson);
  return JSON.parse(rawJson) as T;
}

/**
 * Deterministically canonicalizes a JavaScript value using RFC 8785 (JCS).
 * - When profile is 'velvetai-nfc-v1' (default), applies Unicode NFC pre-normalization first.
 * - When profile is 'pure-rfc8785', applies pure RFC 8785 JCS serialization directly.
 */
export function canonicalJson(
  data: unknown,
  profile: "velvetai-nfc-v1" | "pure-rfc8785" = "velvetai-nfc-v1",
): string {
  if (data === undefined) {
    throw new Error("Cannot canonicalize undefined");
  }
  const target = profile === "velvetai-nfc-v1" ? preNormalizeNfcV1(data) : data;
  const canonical = canonicalize(target);
  if (canonical === undefined) {
    throw new Error("Data could not be canonicalized according to RFC 8785");
  }
  return canonical;
}

/**
 * Computes a hex-encoded SHA-256 hash of a string or buffer.
 */
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Canonicalizes data and computes its deterministic SHA-256 hash.
 */
export function canonicalHash(
  data: unknown,
  profile: "velvetai-nfc-v1" | "pure-rfc8785" = "velvetai-nfc-v1",
): string {
  return sha256Hex(canonicalJson(data, profile));
}
