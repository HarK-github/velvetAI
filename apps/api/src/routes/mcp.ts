import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import {
  createMcpHandler,
  McpServer,
  fromJsonSchema,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { sharedToolRegistry, ToolExecutionContext } from "@velvetai/tool-registry";
import { bookingService } from "./bookings.js";
import { catalogService } from "./services.js";
import { availabilityService } from "./availability.js";
import { getAuthAdapter } from "../plugins/auth.js";
import { validateEnv } from "@velvetai/observability";
import { createDatabaseClient, Database } from "@velvetai/db";
import type { Kysely } from "kysely";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";
let db = createDatabaseClient(databaseUrl);

export function setMcpDb(newDb: Kysely<Database>) {
  db = newDb;
}

// Strict closed JSON Schemas for the 8 versioned MCP tools per Specification Section D, E and W3
const TOOL_JSON_SCHEMAS: Record<string, Record<string, unknown>> = {
  "list_services.v1": {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  "find_available_slots.v1": {
    type: "object",
    properties: {
      serviceId: { type: "string", format: "uuid" },
      locationId: { type: "string", format: "uuid" },
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" },
      timeZone: { type: "string", maxLength: 100 },
    },
    required: ["serviceId"],
    additionalProperties: false,
  },
  "quote_booking.v1": {
    type: "object",
    properties: {
      serviceId: { type: "string", format: "uuid" },
      locationId: { type: "string", format: "uuid" },
      startsAt: { type: "string", format: "date-time" },
      timeZone: { type: "string", maxLength: 100 },
    },
    required: ["serviceId", "locationId", "startsAt", "timeZone"],
    additionalProperties: false,
  },
  "prepare_booking.v1": {
    type: "object",
    properties: {
      serviceId: { type: "string", format: "uuid" },
      locationId: { type: "string", format: "uuid" },
      startsAt: { type: "string", format: "date-time" },
      timeZone: { type: "string", maxLength: 100 },
      customer: {
        type: "object",
        properties: {
          email: { type: "string", format: "email", maxLength: 255 },
          displayName: { type: "string", maxLength: 100 },
        },
        required: ["email"],
        additionalProperties: false,
      },
      note: { type: "string", maxLength: 500 },
    },
    required: ["serviceId", "locationId", "startsAt", "timeZone", "customer"],
    additionalProperties: false,
  },
  "get_booking.v1": {
    type: "object",
    properties: {
      bookingId: { type: "string", format: "uuid" },
    },
    required: ["bookingId"],
    additionalProperties: false,
  },
  "prepare_cancellation.v1": {
    type: "object",
    properties: {
      bookingId: { type: "string", format: "uuid" },
      reason: { type: "string", maxLength: 500 },
    },
    required: ["bookingId"],
    additionalProperties: false,
  },
  "commit_booking.v1": {
    type: "object",
    properties: {
      intent: { type: "string", minLength: 10 },
      confirmation: { type: "string", minLength: 10 },
      idempotency_key: { type: "string", minLength: 1, maxLength: 255 },
    },
    required: ["intent", "idempotency_key"],
    additionalProperties: false,
  },
  "commit_cancellation.v1": {
    type: "object",
    properties: {
      bookingId: { type: "string", format: "uuid" },
      cancellationConfirmationToken: { type: "string", minLength: 10 },
      reason: { type: "string", maxLength: 500 },
    },
    required: ["bookingId", "cancellationConfirmationToken"],
    additionalProperties: false,
  },
};

// Concurrency and Rate Limiting state
const clientConcurrency = new Map<string, number>();
const clientRateWindows = new Map<string, number[]>();

export const mcpRoutes: FastifyPluginAsync = async (app) => {
  const env = validateEnv();
  const allowedHosts = env.ALLOWED_HOSTS.split(",").map((h) => h.trim().toLowerCase());
  const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim().toLowerCase());

  // 1. Reject sessionful GET and DELETE with 405 Method Not Allowed per W2
  app.route({
    method: ["GET", "DELETE"],
    url: "/mcp",
    handler: async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Allow", "POST");
      return reply.status(405).send({
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: "Method not allowed. MCP endpoint is strictly stateless POST.",
        },
        id: null,
      });
    },
  });

  // 2. Authoritative Stateless Streamable HTTP POST /mcp (Protocol 2026-07-28)
  app.post("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (request.body as Record<string, unknown>) || {};
    const requestId =
      typeof rawBody.id === "number" || typeof rawBody.id === "string" ? rawBody.id : null;

    // A. Validate Host header
    const hostHeader = (request.headers.host || "").toLowerCase().trim();
    const hostName = hostHeader.split(":")[0];
    if (
      hostHeader &&
      !allowedHosts.some((h) => hostHeader === h || hostName === h || hostName === h.split(":")[0])
    ) {
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: {
          code: -32020,
          message: `Host '${hostHeader}' is not in the approved host allowlist`,
        },
        id: requestId,
      });
    }

    // B. Validate Origin header (reject present unauthorized origins, no wildcard HTTPS origins)
    const originHeader = request.headers.origin;
    if (originHeader) {
      const normalizedOrigin = originHeader.toLowerCase().trim();
      const isAllowed = allowedOrigins.some((o) => normalizedOrigin === o);
      if (!isAllowed) {
        return reply.status(403).send({
          jsonrpc: "2.0",
          error: {
            code: -32003,
            message: `Origin '${originHeader}' is not allowed by MCP security policy`,
          },
          id: requestId,
        });
      }
    }

    // C. Strictly reject session header (No Mcp-Session-Id per 2026-07-28)
    if (request.headers["mcp-session-id"]) {
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message:
            "Stateful MCP sessions are prohibited. velvetAI MCP 2026-07-28 is strictly stateless.",
        },
        id: requestId,
      });
    }

    const preAuthVersionHeader = request.headers["mcp-protocol-version"];
    if (preAuthVersionHeader !== undefined) {
      const preAuthClaimedVersion = Array.isArray(preAuthVersionHeader)
        ? preAuthVersionHeader[0]
        : preAuthVersionHeader;
      if (preAuthClaimedVersion !== "2026-07-28" && preAuthClaimedVersion !== "2025-11-25") {
        return reply.status(400).send({
          type: "https://velvetai.example/errors/unsupported-protocol-version",
          title: "Bad Request",
          status: 400,
          code: "unsupported_protocol_version",
          detail:
            "Unsupported MCP-Protocol-Version header. Supported versions are 2026-07-28 and 2025-11-25.",
          instance: request.url,
        });
      }
    }

    // D. Extract & validate Bearer Token
    const authHeader = request.headers.authorization;
    const resourceMetadataUrl = `${request.protocol}://${request.host}/.well-known/oauth-protected-resource/mcp`;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply
        .status(401)
        .header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`)
        .send({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Unauthorized: Missing Bearer token in Authorization header",
          },
          id: requestId,
        });
    }
    const token = authHeader.slice(7).trim();

    const clientId =
      typeof request.headers["x-client-id"] === "string"
        ? request.headers["x-client-id"]
        : request.clientId || "default-client";

    const requestedTenantId =
      typeof request.headers["x-tenant-id"] === "string"
        ? request.headers["x-tenant-id"]
        : undefined;

    const mcpExpectedAudience = env.MCP_RESOURCE_URL || `http://${request.host}/mcp`;

    let principal;
    try {
      principal = await getAuthAdapter().authenticateBearerToken(
        token,
        requestedTenantId,
        mcpExpectedAudience,
      );
    } catch (err: unknown) {
      const error = err as Error;
      return reply
        .status(401)
        .header(
          "WWW-Authenticate",
          `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
        )
        .send({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: `Authentication failed: ${error.message}`,
          },
          id: requestId,
        });
    }

    // E. Rate Limits & Concurrency Budgets (60 calls/min/client, 10 concurrent)
    const currentConcurrent = clientConcurrency.get(clientId) || 0;
    if (currentConcurrent >= 10) {
      return reply.status(429).send({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Client concurrency limit exceeded (max 10 concurrent requests)",
        },
        id: requestId,
      });
    }

    const now = Date.now();
    const rateWindow = (clientRateWindows.get(clientId) || []).filter((ts) => now - ts < 60_000);
    if (rateWindow.length >= 60) {
      return reply.status(429).send({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Client rate limit exceeded (max 60 calls per minute)",
        },
        id: requestId,
      });
    }
    rateWindow.push(now);
    clientRateWindows.set(clientId, rateWindow);
    clientConcurrency.set(clientId, currentConcurrent + 1);

    // F. Protocol Version Header & Meta Validation per W2
    const versionHeader = request.headers["mcp-protocol-version"];
    if (!versionHeader) {
      clientConcurrency.set(clientId, Math.max(0, (clientConcurrency.get(clientId) || 1) - 1));
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: {
          code: -32602,
          message: "Missing required MCP-Protocol-Version header",
        },
        id: requestId,
      });
    }

    const claimedVersion = Array.isArray(versionHeader) ? versionHeader[0] : versionHeader;
    if (claimedVersion !== "2026-07-28" && claimedVersion !== "2025-11-25") {
      clientConcurrency.set(clientId, Math.max(0, (clientConcurrency.get(clientId) || 1) - 1));
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: {
          code: -32602,
          message: `Unsupported protocol revision: '${claimedVersion}'. velvetAI supports '2026-07-28'.`,
          data: { supported: ["2026-07-28"] },
        },
        id: requestId,
      });
    }

    // Check header and body meta agreement
    const params = (rawBody.params as Record<string, unknown>) || {};
    const meta = (params._meta as Record<string, unknown>) || {};
    const bodyVersion =
      (meta[PROTOCOL_VERSION_META_KEY] as string) || (meta.protocolVersion as string) || undefined;

    if (bodyVersion && bodyVersion !== claimedVersion) {
      clientConcurrency.set(clientId, Math.max(0, (clientConcurrency.get(clientId) || 1) - 1));
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: {
          code: -32020,
          message: `Bad Request: the request headers and body disagree: the body envelope names protocol version ${bodyVersion} but the MCP-Protocol-Version header names ${claimedVersion}`,
          data: {
            mismatch: {
              header: claimedVersion,
              body: `the body envelope names protocol version ${bodyVersion} but the MCP-Protocol-Version header names ${claimedVersion}`,
            },
          },
        },
        id: requestId,
      });
    }

    // G. Create Fresh McpServer per request
    const toolExecutionContext: ToolExecutionContext = {
      tenantId: principal.tenantId,
      actor: {
        subject: principal.subject,
        userId: principal.userId,
        tenantId: principal.tenantId,
        roles: principal.roles,
      },
      clientId,
      scopes: principal.scopes,
      bookingService,
      catalogService,
      availabilityService,
      db,
    };

    const handler = createMcpHandler(async () => {
      const server = new McpServer({
        name: "velvetai",
        version: "1.0.0",
      });

      for (const [toolName, jsonSchema] of Object.entries(TOOL_JSON_SCHEMAS)) {
        const toolDef = sharedToolRegistry.get(toolName);
        if (!toolDef) continue;

        server.registerTool(
          toolName,
          {
            description: toolDef.description,
            inputSchema: fromJsonSchema(jsonSchema),
            annotations: {
              readOnlyHint: toolDef.readOnlyHint ?? false,
              destructiveHint: toolDef.consequentialHint ?? false,
            },
          },
          async (args) => {
            const result = await sharedToolRegistry.execute(toolName, args, toolExecutionContext);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result),
                },
              ],
            };
          },
        );
      }

      return server;
    });

    // H. Execute with 30-Second Wall-Clock Timeout
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30_000);

    try {
      const url = `http://${hostHeader || "localhost:3000"}${request.url}`;
      const webHeaders = new Headers();
      for (const [k, v] of Object.entries(request.headers)) {
        if (v !== undefined) {
          if (Array.isArray(v)) {
            for (const item of v) webHeaders.append(k, item);
          } else {
            webHeaders.set(k, v);
          }
        }
      }

      const webRequest = new Request(url, {
        method: "POST",
        headers: webHeaders,
        body: JSON.stringify(rawBody),
        signal: abortController.signal,
      });

      const response = await handler.fetch(webRequest, {
        authInfo: {
          token,
          clientId,
          scopes: (principal.scopes || []) as string[],
        },
      });

      clearTimeout(timeout);
      clientConcurrency.set(clientId, Math.max(0, (clientConcurrency.get(clientId) || 1) - 1));

      const responseText = await response.text();
      for (const [k, v] of response.headers.entries()) {
        reply.header(k, v);
      }
      return reply.status(response.status).send(responseText);
    } catch (err: unknown) {
      clearTimeout(timeout);
      clientConcurrency.set(clientId, Math.max(0, (clientConcurrency.get(clientId) || 1) - 1));
      const error = err as Error;

      if (abortController.signal.aborted) {
        return reply.status(504).send({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "MCP request timed out (30-second budget exceeded)",
          },
          id: requestId,
        });
      }

      return reply.status(500).send({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error.message || "Internal MCP handler error",
        },
        id: requestId,
      });
    }
  });
};
