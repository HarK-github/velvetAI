import pino, { Logger, LoggerOptions } from "pino";

export interface LogContext {
  tenantId?: string;
  actorId?: string;
  actorType?: string;
  requestId?: string;
  traceId?: string;
  operation?: string;
  [key: string]: unknown;
}

export const REDACTED_PATHS = [
  "authorization",
  "*.authorization",
  "access_token",
  "*.access_token",
  "refreshToken",
  "*.refreshToken",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "password",
  "*.password",
  "client_secret",
  "*.client_secret",
  "paypalClientSecret",
  "*.paypalClientSecret",
  "customerNote",
  "*.customerNote",
  "note",
  "*.note",
  "notes",
  "*.notes",
  "email",
  "*.email",
  "displayName",
  "*.displayName",
  "cardNumber",
  "*.cardNumber",
  "cvv",
  "*.cvv",
];

export function createLogger(options?: LoggerOptions): Logger {
  return pino({
    level: process.env.LOG_LEVEL || "info",
    redact: {
      paths: REDACTED_PATHS,
      censor: "[REDACTED]",
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options,
  });
}
