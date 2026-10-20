import Fastify, { FastifyInstance, FastifyError } from "fastify";
import cors from "@fastify/cors";
import { createLogger, validateEnv } from "@velvetai/observability";
import { createProblemDetails, DomainError } from "@velvetai/contracts";
import crypto from "node:crypto";

import { servicesRoutes } from "./routes/services.js";
import { availabilityRoutes } from "./routes/availability.js";
import { bookingsRoutes } from "./routes/bookings.js";
import { riskRoutes } from "./routes/risk.js";
import { registerAuth } from "./plugins/auth.js";
import { registerIdempotency } from "./plugins/idempotency.js";

export function buildApp(): FastifyInstance {
  const env = validateEnv();
  const logger = createLogger();

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyInstance["log"],
    genReqId: (req) => {
      const headerReqId = req.headers["x-request-id"];
      return typeof headerReqId === "string" ? headerReqId : crypto.randomUUID();
    },
  });

  app.register(cors, {
    origin: [env.WEB_BASE_URL, "http://localhost:5173"],
    credentials: true,
  });

  // Auth and Idempotency Middleware on Root App
  registerAuth(app);
  registerIdempotency(app);

  // Health checks
  app.get("/health/live", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/health/ready", async () => {
    return {
      status: "ready",
      timestamp: new Date().toISOString(),
      dependencies: {
        database: "ok",
        redis: "ok",
      },
    };
  });

  // Business & frontend endpoints
  app.register(servicesRoutes);
  app.register(availabilityRoutes);
  app.register(bookingsRoutes);
  app.register(riskRoutes);

  // RFC 9457 Problem Details error handler
  app.setErrorHandler((error: FastifyError | Error | unknown, request, reply) => {
    request.log.error({ err: error }, "Request failed with error");

    if (error instanceof DomainError) {
      const problem = createProblemDetails({
        title: error.message,
        status: error.status,
        code: error.code,
        requestId: request.id,
        detail: error.message,
      });
      return reply
        .status(error.status)
        .header("content-type", "application/problem+json")
        .send(problem);
    }

    const err = error as { validation?: unknown; message?: string; statusCode?: number };

    if (err.validation) {
      const problem = createProblemDetails({
        title: "Validation Error",
        status: 400,
        code: "invalid_request_schema",
        requestId: request.id,
        detail: err.message ?? "Validation failed",
      });
      return reply.status(400).header("content-type", "application/problem+json").send(problem);
    }

    const problem = createProblemDetails({
      title: "Internal Server Error",
      status: err.statusCode ?? 500,
      code: "internal_error",
      requestId: request.id,
      detail:
        process.env.NODE_ENV === "production"
          ? "An unexpected error occurred"
          : (err.message ?? "Unknown error"),
    });
    return reply
      .status(problem.status)
      .header("content-type", "application/problem+json")
      .send(problem);
  });

  return app;
}
