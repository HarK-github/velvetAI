export type PayPalEnvironment = "sandbox";

export interface PayPalSandboxConfig {
  environment?: PayPalEnvironment;
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Converts minor integer units to a validated decimal string (e.g. 2500 cents -> "25.00").
 */
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

/**
 * Converts a decimal string to minor integer units (e.g. "25.00" -> "2500").
 */
export function decimalToMinorUnits(decimal: string, scale: number = 2): string {
  const parts = decimal.trim().split(".");
  const wholePart = parts[0] ?? "0";
  const fractionPart = (parts[1] ?? "").padEnd(scale, "0").slice(0, scale);
  const isNegative = wholePart.startsWith("-");
  const cleanWhole = isNegative ? wholePart.slice(1) : wholePart;
  const minor = BigInt(cleanWhole) * 10n ** BigInt(scale) + BigInt(fractionPart);
  return (isNegative ? -minor : minor).toString();
}
