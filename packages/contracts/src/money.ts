import { z } from "zod";
import { currencyCodeSchema, getCurrencyScale } from "./primitives.js";
export { getCurrencyScale };

/**
 * Validated integer decimal string representing minor units (e.g. cents, pence, yen).
 * Avoids JavaScript floating-point truncation, precision loss, and BigInt JSON serialization failures.
 */
export const moneyMinorStringSchema = z
  .string()
  .regex(/^-?\d+$/, "Money minor must be an integer decimal string");

/**
 * Canonical Authoritative Money Wire Contract.
 */
export const canonicalMoneySchema = z
  .object({
    valueMinor: moneyMinorStringSchema,
    currency: currencyCodeSchema,
  })
  .strict();

export type CanonicalMoney = z.infer<typeof canonicalMoneySchema>;

export interface FormatMoneyOptions {
  locale?: string;
  fallbackErrorLabel?: string;
}

/**
 * Formats minor units into an authoritative localized currency string
 * using currency scale and Intl.NumberFormat without ANY floating-point math.
 *
 * Rules:
 * - USD 7500 -> "$75.00"
 * - USD 2000 -> "$20.00"
 * - JPY 1000 -> "¥1,000"
 * - KWD 1500 -> "KWD 1.500"
 * - Malformed, missing, or unknown money values render a visible data error, NEVER "$0.00".
 */
export function formatMoney(
  money: CanonicalMoney | { valueMinor?: unknown; currency?: unknown } | null | undefined,
  options: FormatMoneyOptions = {},
): string {
  const fallbackLabel = options.fallbackErrorLabel || "[Pricing unavailable]";

  if (!money || typeof money !== "object") {
    return fallbackLabel;
  }

  const rawValue = (money as any).valueMinor;
  const rawCurrency = (money as any).currency;

  // Validate valueMinor is a valid integer string or BigInt/number convertible to integer string
  let valueMinorStr: string;
  if (typeof rawValue === "string") {
    valueMinorStr = rawValue.trim();
  } else if (typeof rawValue === "bigint") {
    valueMinorStr = rawValue.toString();
  } else if (typeof rawValue === "number" && Number.isInteger(rawValue)) {
    valueMinorStr = Math.trunc(rawValue).toString();
  } else {
    return fallbackLabel;
  }

  if (!/^-?\d+$/.test(valueMinorStr)) {
    return fallbackLabel;
  }

  // Validate currency code
  if (typeof rawCurrency !== "string" || rawCurrency.trim().length !== 3) {
    return fallbackLabel;
  }
  const currency = rawCurrency.trim().toUpperCase();

  // Test that Intl accepts the currency
  let scale: number;
  try {
    scale = getCurrencyScale(currency);
  } catch {
    return fallbackLabel;
  }

  const isNegative = valueMinorStr.startsWith("-");
  const absDigits = isNegative ? valueMinorStr.slice(1) : valueMinorStr;

  let decimalString: string;
  if (scale === 0) {
    decimalString = absDigits;
  } else {
    const padded = absDigits.padStart(scale + 1, "0");
    const intPart = padded.slice(0, padded.length - scale);
    const fracPart = padded.slice(padded.length - scale);
    decimalString = `${intPart}.${fracPart}`;
  }

  const signedDecimalString = isNegative ? `-${decimalString}` : decimalString;

  try {
    const locale = options.locale || "en-US";
    const formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    });
    // Intl.NumberFormat.format accepts string in ES2023 environments
    return formatter.format(signedDecimalString as any);
  } catch {
    return fallbackLabel;
  }
}
