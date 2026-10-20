import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { createProblemDetails } from "@velvetai/contracts";

declare module "fastify" {
  interface FastifyRequest {
    _idempotencyStoreKey?: string;
    _idempotencyHash?: string;
  }
}

interface StoredIdempotency {
  requestHash: string;
  statusCode: number;
  body: string;
}

const memoryIdempotencyStore = new Map<string, StoredIdempotency>();

export function computeCanonicalHash(payload: unknown): string {
  const serialized = payload ? JSON.stringify(payload) : "";
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export function registerIdempotency(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    const isMutating = ["POST", "PUT", "PATCH"].includes(request.method);
    if (!isMutating) return;

    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      return;
    }

    const tenantId = request.tenantId || "default_tenant";
    const actorId = request.principal?.userId || "anon";
    const routePath = request.routeOptions?.url || request.url;
    const storeKey = `${tenantId}:${actorId}:${routePath}:${idempotencyKey}`;

    const currentHash = computeCanonicalHash(request.body);
    const existing = memoryIdempotencyStore.get(storeKey);

    if (existing) {
      if (existing.requestHash !== currentHash) {
        const problem = createProblemDetails({
          title: "Idempotency Conflict",
          status: 409,
          code: "idempotency_conflict",
          requestId: request.id,
          detail: `Idempotency key '${idempotencyKey}' was already executed with a different request payload`,
        });
        return reply
          .status(409)
          .header("content-type", "application/problem+json")
          .send(problem);
      }

      // Return recorded response
      reply.header("x-idempotent-replay", "true");
      return reply
        .status(existing.statusCode)
        .header("content-type", "application/json")
        .send(existing.body);
    }

    request._idempotencyStoreKey = storeKey;
    request._idempotencyHash = currentHash;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const storeKey = request._idempotencyStoreKey;
    const requestHash = request._idempotencyHash;

    if (storeKey && requestHash && reply.statusCode >= 200 && reply.statusCode < 300) {
      memoryIdempotencyStore.set(storeKey, {
        requestHash,
        statusCode: reply.statusCode,
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      });
    }
    return payload;
  });
}
