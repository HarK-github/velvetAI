import { FastifyInstance } from "fastify";
import { createProblemDetails } from "@velvetai/contracts";
import { canonicalHash } from "@velvetai/application";

declare module "fastify" {
  interface FastifyRequest {
    _idempotencyStoreKey?: string;
    _idempotencyHash?: string;
    _idempotencyCompleted?: boolean;
  }
}

export interface StoredIdempotency {
  requestHash: string;
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

interface InFlightDeferred {
  requestHash: string;
  promise: Promise<StoredIdempotency>;
  resolve: (val: StoredIdempotency) => void;
  reject: (err: unknown) => void;
}

// In-memory idempotency cache and in-flight request convergence map
const memoryIdempotencyStore = new Map<string, StoredIdempotency>();
const inFlightOperations = new Map<string, InFlightDeferred>();

// Mutating routes that strictly require Idempotency-Key per Epic 3.5 W3
const MUTATING_ROUTES_REQUIRING_IDEMPOTENCY = [
  /^\/v1\/booking-quotes\/?$/,
  /^\/v1\/bookings\/prepare\/?$/,
  /^\/v1\/booking-holds\/?$/,
  /^\/v1\/booking-approvals\/[^/]+\/confirm\/?$/,
  /^\/v1\/bookings\/commit\/?$/,
  /^\/v1\/bookings\/[^/]+\/payment-order\/?$/,
  /^\/v1\/payments\/[^/]+\/capture\/?$/,
  /^\/v1\/captures\/[^/]+\/refunds\/?$/,
  /^\/v1\/bookings\/[^/]+\/balance-invoice\/?$/,
  /^\/v1\/bookings\/[^/]+\/cancel\/?$/,
  /^\/v1\/bookings\/[^/]+\/check-in\/?$/,
  /^\/v1\/bookings\/[^/]+\/complete\/?$/,
  /^\/v1\/bookings\/[^/]+\/no-show\/?$/,
];

// Exempt routes: provably read-only despite POST semantics or external webhook deduplication
const EXEMPT_ROUTES = [
  /^\/v1\/risk\/evaluate\/?$/, // Read-only risk model computation
  /^\/v1\/webhooks\/paypal(\/.*)?$/, // Ingress webhook with transmission-ID deduplication
];

export function isMutatingRouteRequiringIdempotency(method: string, path: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) {
    return false;
  }

  // Check explicit exemptions
  if (EXEMPT_ROUTES.some((pattern) => pattern.test(path))) {
    return false;
  }

  return MUTATING_ROUTES_REQUIRING_IDEMPOTENCY.some((pattern) => pattern.test(path));
}

/**
 * Computes canonical hash over operation, tenant, actor, and request body per RFC 8785.
 */
export function computeCanonicalHash(
  operation: string,
  tenantId: string,
  actorId: string,
  payload: unknown,
): string {
  return canonicalHash({
    operation,
    tenantId,
    actorId,
    body: payload ?? {},
  });
}

/**
 * Reset helper for test teardown
 */
export function clearIdempotencyStore(): void {
  memoryIdempotencyStore.clear();
  inFlightOperations.clear();
}

export function registerIdempotency(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    const rawPath = request.url.split("?")[0] || request.url;
    const isRequired = isMutatingRouteRequiringIdempotency(request.method, rawPath);

    // Extract idempotency key from header or body
    let idempotencyKey: string | undefined =
      (request.headers["idempotency-key"] as string) ||
      (request.headers["paypal-request-id"] as string);

    if (
      !idempotencyKey &&
      typeof request.body === "object" &&
      request.body !== null &&
      "idempotency_key" in request.body
    ) {
      idempotencyKey = (request.body as { idempotency_key?: string }).idempotency_key;
    }

    // If route requires idempotency but key is absent, reject with RFC 9457 HTTP 400
    if (isRequired && (!idempotencyKey || idempotencyKey.trim().length === 0)) {
      const problem = createProblemDetails({
        title: "Idempotency-Key Required",
        status: 400,
        code: "idempotency_key_required",
        requestId: request.id,
        detail: `A valid Idempotency-Key header is required for mutating operation '${request.method} ${rawPath}'`,
      });
      return reply.status(400).header("content-type", "application/problem+json").send(problem);
    }

    // If key is present on any request, enforce idempotency guarantees
    if (idempotencyKey && idempotencyKey.trim().length > 0) {
      const tenantId = request.tenantId || "default_tenant";
      const actorId = request.principal?.userId || "anon";
      const operation = `${request.method.toUpperCase()}:${rawPath}`;
      const storeKey = `${tenantId}:${actorId}:${idempotencyKey.trim()}`;

      const currentHash = computeCanonicalHash(operation, tenantId, actorId, request.body);

      // Check if there is already an in-flight operation for this store key (concurrency convergence)
      const existingInFlight = inFlightOperations.get(storeKey);
      if (existingInFlight) {
        if (existingInFlight.requestHash !== currentHash) {
          const problem = createProblemDetails({
            title: "Idempotency Conflict",
            status: 409,
            code: "idempotency_conflict",
            requestId: request.id,
            detail: `Idempotency key '${idempotencyKey}' was concurrently submitted with a different request payload or operation`,
          });
          return reply.status(409).header("content-type", "application/problem+json").send(problem);
        }

        // Converge to single in-flight operation: await its completion and return same result
        const result = await existingInFlight.promise;
        reply.header("x-idempotent-replay", "true");
        return reply
          .status(result.statusCode)
          .header("content-type", "application/json")
          .send(result.body);
      }

      // Check if result already recorded in memory store
      const existing = memoryIdempotencyStore.get(storeKey);
      if (existing) {
        if (existing.requestHash !== currentHash) {
          const problem = createProblemDetails({
            title: "Idempotency Conflict",
            status: 409,
            code: "idempotency_conflict",
            requestId: request.id,
            detail: `Idempotency key '${idempotencyKey}' was previously executed with a different request payload or operation`,
          });
          return reply.status(409).header("content-type", "application/problem+json").send(problem);
        }

        // Return previously recorded result
        reply.header("x-idempotent-replay", "true");
        return reply
          .status(existing.statusCode)
          .header("content-type", "application/json")
          .send(existing.body);
      }

      // Register new in-flight operation for concurrency convergence
      let resolveFn!: (val: StoredIdempotency) => void;
      let rejectFn!: (err: unknown) => void;
      const inFlightPromise = new Promise<StoredIdempotency>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      // Attach noop catch to avoid unhandled rejection if operation errors and no waiter attached
      inFlightPromise.catch(() => {});

      inFlightOperations.set(storeKey, {
        requestHash: currentHash,
        promise: inFlightPromise,
        resolve: resolveFn,
        reject: rejectFn,
      });

      request._idempotencyStoreKey = storeKey;
      request._idempotencyHash = currentHash;
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const storeKey = request._idempotencyStoreKey;
    const requestHash = request._idempotencyHash;

    if (storeKey && requestHash) {
      const inFlight = inFlightOperations.get(storeKey);

      // Record successful and client-error statuses (200..499). Never cache 500 server crashes.
      if (reply.statusCode >= 200 && reply.statusCode < 500) {
        const stored: StoredIdempotency = {
          requestHash,
          statusCode: reply.statusCode,
          body: typeof payload === "string" ? payload : JSON.stringify(payload),
        };

        memoryIdempotencyStore.set(storeKey, stored);

        if (inFlight) {
          inFlight.resolve(stored);
          inFlightOperations.delete(storeKey);
        }
      } else if (inFlight) {
        inFlight.reject(new Error(`Operation finished with status ${reply.statusCode}`));
        inFlightOperations.delete(storeKey);
      }
    }

    return payload;
  });

  app.addHook("onError", async (request, _reply, error) => {
    const storeKey = request._idempotencyStoreKey;
    if (storeKey) {
      const inFlight = inFlightOperations.get(storeKey);
      if (inFlight) {
        inFlight.reject(error);
        inFlightOperations.delete(storeKey);
      }
    }
  });
}
