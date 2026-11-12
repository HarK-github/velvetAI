import Fastify, { FastifyInstance, FastifyError } from "fastify";
import cors from "@fastify/cors";
import { createLogger, validateEnv } from "@velvetai/observability";
import { createProblemDetails, DomainError } from "@velvetai/contracts";
import crypto from "node:crypto";

import {
  parseJsonRejectingDuplicates,
  ModelProviderPort,
  CatalogService,
  AvailabilityService,
  BookingService,
} from "@velvetai/application";
import { servicesRoutes, setCatalogService } from "./routes/services.js";
import { availabilityRoutes, setAvailabilityService } from "./routes/availability.js";
import { bookingsRoutes, setBookingService } from "./routes/bookings.js";
import { riskRoutes } from "./routes/risk.js";
import { paymentsRoutes, webhookRoutes, paymentService } from "./routes/payments.js";
import { mcpRoutes, setMcpDb } from "./routes/mcp.js";
import { aiRoutes } from "./routes/ai.js";
import { judgeRoutes, setJudgeDb } from "./routes/judge.js";
import { judgeAbuseLabRoutes, setJudgeAbuseLabDb } from "./routes/judge-abuse-lab.js";
import { judgeProofRoutes, setJudgeProofDb } from "./routes/judge-proof.js";
import { scheduleRoutes, setScheduleDb } from "./routes/schedule.js";
import { judgeRaceRoutes, setJudgeRaceDb } from "./routes/judge-race.js";
import type { JudgeAbuseLabService } from "./judge/abuse-lab-runner.js";
import type { JudgeRaceTestService } from "@velvetai/application";
import { registerAuth } from "./plugins/auth.js";
import { registerIdempotency } from "./plugins/idempotency.js";
import { Kysely } from "kysely";
import { Database } from "@velvetai/db";

export interface AppOptions {
  modelProvider?: ModelProviderPort;
  db?: Kysely<Database>;
  abuseLabService?: JudgeAbuseLabService;
  raceTestService?: JudgeRaceTestService;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const env = validateEnv();
  const logger = createLogger();

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyInstance["log"],
    trustProxy: true,
    genReqId: (req) => {
      const headerReqId = req.headers["x-request-id"];
      return typeof headerReqId === "string" ? headerReqId : crypto.randomUUID();
    },
  });

  // Global Transport Security Headers per Section 11
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.hasHeader("x-content-type-options")) {
      reply.header("x-content-type-options", "nosniff");
    }
    if (!reply.hasHeader("x-frame-options")) {
      reply.header("x-frame-options", "DENY");
    }
    if (!reply.hasHeader("referrer-policy")) {
      reply.header("referrer-policy", "strict-origin-when-cross-origin");
    }
    if (!reply.hasHeader("permissions-policy")) {
      reply.header("permissions-policy", "tools=(self)");
    }
  });

  // Secure Content-Type Parser: Reject duplicate JSON keys before standard object parsing
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body: string, done) => {
      if (!body || body.trim().length === 0) {
        done(null, {});
        return;
      }
      try {
        const parsed = parseJsonRejectingDuplicates(body);
        done(null, parsed);
      } catch (err: unknown) {
        const error = err as Error;
        done(Object.assign(error, { statusCode: 400 }), undefined);
      }
    },
  );

  const allowedOrigins = Array.from(
    new Set([
      ...(env.ALLOWED_ORIGINS
        ? env.ALLOWED_ORIGINS.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : []),
      env.WEB_BASE_URL,
      "http://localhost:5173",
      "https://velvetai-five.vercel.app",
    ]),
  );

  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (
        allowedOrigins.includes(origin) ||
        origin.endsWith(".vercel.app") ||
        origin.endsWith(".onrender.com")
      ) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
    exposedHeaders: ["Date", "ETag"],
  });

  // Auth and Idempotency Middleware on Root App
  registerAuth(app);
  registerIdempotency(app);

  // Root info endpoint
  app.get("/", async () => {
    return {
      name: "velvetAI API",
      status: "running",
      version: "1.0.0",
      health: "/health/live",
      spec: "/v1/system/spec",
      docs: "https://velvetai.example/docs",
    };
  });

  // Health checks
  app.get("/health/live", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/healthz", async () => {
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

  // Inject test or custom DB into services if provided
  if (options.db) {
    setCatalogService(new CatalogService(options.db));
    setAvailabilityService(new AvailabilityService(options.db));
    setBookingService(new BookingService(options.db, paymentService));
    setMcpDb(options.db);
    setJudgeDb(options.db);
    setJudgeAbuseLabDb(options.db);
    setJudgeProofDb(options.db);
    setScheduleDb(options.db);
    setJudgeRaceDb(options.db);
  }

  // Business & frontend endpoints
  app.register(servicesRoutes);
  app.register(availabilityRoutes);
  app.register(scheduleRoutes);
  app.register(bookingsRoutes);
  app.register(riskRoutes);
  app.register(paymentsRoutes);
  app.register(webhookRoutes);
  app.register(mcpRoutes);
  app.register(judgeRoutes);
  app.register(judgeAbuseLabRoutes, {
    db: options.db,
    abuseLabService: options.abuseLabService,
  });
  app.register(judgeProofRoutes, {
    db: options.db,
  });
  app.register(judgeRaceRoutes, {
    db: options.db,
    raceTestService: options.raceTestService,
  });
  app.register(aiRoutes, options);

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

    if (err.validation || (err.message && err.message.includes("Duplicate JSON key"))) {
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
