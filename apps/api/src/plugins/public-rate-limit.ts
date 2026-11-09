import { FastifyRequest } from "fastify";

const publicRateWindows = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

export function getClientIp(request: FastifyRequest): string {
  const rawForwarded = request.headers["x-forwarded-for"];
  const clientIp =
    (typeof rawForwarded === "string"
      ? rawForwarded.split(",")[0]?.trim()
      : Array.isArray(rawForwarded)
        ? rawForwarded[0]
        : undefined) ||
    request.ip ||
    "127.0.0.1";
  return clientIp;
}

export function checkPublicRateLimit(clientIp: string): boolean {
  const now = Date.now();
  const window = (publicRateWindows.get(clientIp) || []).filter((ts) => now - ts < WINDOW_MS);
  if (window.length >= MAX_REQUESTS) {
    return false;
  }
  window.push(now);
  publicRateWindows.set(clientIp, window);
  return true;
}

export function getPublicRateLimitRetryAfter(clientIp: string): number {
  const now = Date.now();
  const window = (publicRateWindows.get(clientIp) || []).filter((ts) => now - ts < WINDOW_MS);
  if (window.length === 0) return 1;
  const oldest = window[0]!;
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}

export function resetPublicRateLimits(): void {
  publicRateWindows.clear();
}

