import { z } from "zod";
import crypto from "node:crypto";

// UUID v4/v7 validator
export const uuidSchema = z.string().uuid({ message: "Invalid UUID format" }).brand<"UUID">();
export type UUID = z.infer<typeof uuidSchema>;

/**
 * Generates an RFC 9562 compliant, time-sortable UUIDv7 identifier.
 */
export function generateUUIDv7(): UUID {
  const bytes = crypto.randomBytes(16);
  const now = BigInt(Date.now());

  // 48-bit timestamp in milliseconds
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);

  // version 7 (0b0111) in top 4 bits of byte 6
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  // variant 1 (0b10) in top 2 bits of byte 8
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as UUID;
}

export const generateUuidV7 = generateUUIDv7;

// Branded identifier schemas
export const tenantIdSchema = uuidSchema.brand<"TenantId">();
export type TenantId = z.infer<typeof tenantIdSchema>;

export const userIdSchema = uuidSchema.brand<"UserId">();
export type UserId = z.infer<typeof userIdSchema>;

export const locationIdSchema = uuidSchema.brand<"LocationId">();
export type LocationId = z.infer<typeof locationIdSchema>;

export const serviceIdSchema = uuidSchema.brand<"ServiceId">();
export type ServiceId = z.infer<typeof serviceIdSchema>;

export const serviceVersionIdSchema = uuidSchema.brand<"ServiceVersionId">();
export type ServiceVersionId = z.infer<typeof serviceVersionIdSchema>;

export const resourceIdSchema = uuidSchema.brand<"ResourceId">();
export type ResourceId = z.infer<typeof resourceIdSchema>;

export const bookingQuoteIdSchema = uuidSchema.brand<"BookingQuoteId">();
export type BookingQuoteId = z.infer<typeof bookingQuoteIdSchema>;

export const bookingIdSchema = uuidSchema.brand<"BookingId">();
export type BookingId = z.infer<typeof bookingIdSchema>;

export const paymentIntentIdSchema = uuidSchema.brand<"PaymentIntentId">();
export type PaymentIntentId = z.infer<typeof paymentIntentIdSchema>;

export const paymentCaptureIdSchema = uuidSchema.brand<"PaymentCaptureId">();
export type PaymentCaptureId = z.infer<typeof paymentCaptureIdSchema>;

export const refundIdSchema = uuidSchema.brand<"RefundId">();
export type RefundId = z.infer<typeof refundIdSchema>;

export const invoiceIdSchema = uuidSchema.brand<"InvoiceId">();
export type InvoiceId = z.infer<typeof invoiceIdSchema>;

export const cancellationPolicyIdSchema = uuidSchema.brand<"CancellationPolicyId">();
export type CancellationPolicyId = z.infer<typeof cancellationPolicyIdSchema>;

// Money representation in integer minor units (e.g. cents)
export const currencyCodeSchema = z
  .string()
  .length(3, "Currency code must be 3-character ISO 4217")
  .toUpperCase()
  .brand<"CurrencyCode">();
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/**
 * Represents money minor units as an explicit, validated integer decimal string.
 * Transmitted over wire (REST, JWS, audit, events) as a decimal string to avoid JSON BigInt issues.
 */
export const moneyMinorSchema = z
  .string()
  .regex(/^-?\d+$/, "Money minor must be an integer decimal string")
  .brand<"MoneyMinor">();
export type MoneyMinor = z.infer<typeof moneyMinorSchema>;

export const moneySchema = z.object({
  currency: currencyCodeSchema,
  valueMinor: moneyMinorSchema,
});
export type Money = z.infer<typeof moneySchema>;

export const SUPPORTED_MVP_CURRENCIES = ["USD"] as const;
export type SupportedMvpCurrency = (typeof SUPPORTED_MVP_CURRENCIES)[number];

export const PAYPAL_OFFICIALLY_SUPPORTED_CURRENCIES = [
  "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS",
  "JPY", "MYR", "MXN", "TWD", "NZD", "NOK", "PHP", "PLN", "GBP", "SGD",
  "SEK", "CHF", "THB", "USD",
] as const;

export function isSupportedMvpCurrency(currency: string): currency is SupportedMvpCurrency {
  return SUPPORTED_MVP_CURRENCIES.includes(currency.toUpperCase() as SupportedMvpCurrency);
}

/**
 * Known currency minor unit scales (ISO 4217).
 * Zero-decimal: JPY, KRW, VND, CLF, etc.
 * Three-decimal: BHD, KWD, OMR, JOD, TND.
 * Two-decimal: default for all other currencies (USD, EUR, GBP, etc.).
 */
export function getCurrencyScale(currency: string): number {
  const zeroDecimal = ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"];
  const threeDecimal = ["BHD", "IQD", "JOD", "KWD", "OMR", "TND"];
  const upper = currency.toUpperCase();
  if (zeroDecimal.includes(upper)) return 0;
  if (threeDecimal.includes(upper)) return 3;
  return 2;
}

/**
 * Validates whether an amount decimal string fits within signed 64-bit integer limits:
 * -9223372036854775808 <= x <= 9223372036854775807
 */
export function isSafeMoneyMinor(valueStr: string): boolean {
  if (!/^-?\d+$/.test(valueStr)) return false;
  try {
    const val = BigInt(valueStr);
    const min = -9223372036854775808n;
    const max = 9223372036854775807n;
    return val >= min && val <= max;
  } catch {
    return false;
  }
}

export function minorUnitsToDecimal(minorUnits: string | bigint, scale: number = 2): string {
  const bigVal = typeof minorUnits === "bigint" ? minorUnits : BigInt(minorUnits);
  const isNegative = bigVal < 0n;
  const absVal = isNegative ? -bigVal : bigVal;
  const divisor = 10n ** BigInt(scale);
  const whole = absVal / divisor;
  const fraction = absVal % divisor;
  const paddedFraction = fraction.toString().padStart(scale, "0");
  const result = scale > 0 ? `${whole}.${paddedFraction}` : whole.toString();
  return isNegative ? `-${result}` : result;
}

export function decimalToMinorUnits(decimal: string, scale: number = 2): string {
  const parts = decimal.trim().split(".");
  const wholePart = parts[0] ?? "0";
  const fractionPart = (parts[1] ?? "").padEnd(scale, "0").slice(0, scale);
  const isNegative = wholePart.startsWith("-");
  const cleanWhole = isNegative ? wholePart.slice(1) : wholePart;
  const minor = BigInt(cleanWhole) * (10n ** BigInt(scale)) + BigInt(fractionPart);
  return (isNegative ? -minor : minor).toString();
}

// Time and date formats
export const rfc3339TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .brand<"Rfc3339Timestamp">();
export type Rfc3339Timestamp = z.infer<typeof rfc3339TimestampSchema>;

export const ianaTimeZoneSchema = z
  .string()
  .min(1)
  .refine(
    (tz) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid IANA time zone identifier" },
  )
  .brand<"IanaTimeZone">();
export type IanaTimeZone = z.infer<typeof ianaTimeZoneSchema>;

// Roles defined in spec.md
export const roleSchema = z.enum([
  "BUYER",
  "SCHEDULER",
  "MANAGER",
  "OWNER",
  "SUPPORT",
  "WORKER",
  "ABUSE_LAB",
]);
export type Role = z.infer<typeof roleSchema>;
