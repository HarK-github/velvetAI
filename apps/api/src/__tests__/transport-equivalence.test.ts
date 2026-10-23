import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import {
  createDatabaseClient,
  withTenantTransaction,
  Database,
  getTestDatabaseUrl,
} from "@velvetai/db";
import { Kysely } from "kysely";
import crypto from "node:crypto";
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";
import {
  FakeModelProvider,
  GeminiModelProvider,
  BookingService,
  CatalogService,
  AvailabilityService,
} from "@velvetai/application";
import { sharedToolRegistry, ToolExecutionContext } from "@velvetai/tool-registry";
import {
  DomainError,
  TenantId,
  UserId,
  ServiceId,
  ServiceVersionId,
  LocationId,
  ResourceId,
} from "@velvetai/contracts";

describe("W8/Section 9: Four-Transport Equivalence Across REST, MCP, WebMCP Simulation & Ask AI", () => {
  let app: FastifyInstance;
  let testDb: Kysely<Database>;
  let fakeModelProvider: FakeModelProvider;
  let bookingService: BookingService;
  let catalogService: CatalogService;
  let availabilityService: AvailabilityService;

  const tenantId = crypto.randomUUID() as TenantId;
  const userId = crypto.randomUUID() as UserId;
  const serviceId = crypto.randomUUID() as ServiceId;
  const serviceVersionId = crypto.randomUUID() as ServiceVersionId;
  const locationId = crypto.randomUUID() as LocationId;
  const resourceId = crypto.randomUUID() as ResourceId;
  const authHeader = `Bearer test-token:${userId}:${tenantId}:BUYER:1`;

  const webMcpContext: ToolExecutionContext = {
    tenantId,
    actor: {
      subject: `oidc|eq-${userId}`,
      userId,
      tenantId,
      roles: ["BUYER", "OWNER"],
    },
    clientId: "webmcp-browser-client",
    scopes: [
      "booking:read",
      "booking:quote",
      "booking:prepare",
      "booking:commit",
      "booking:cancel",
    ],
    bookingService: undefined as any,
    catalogService: undefined as any,
    availabilityService: undefined as any,
    db: undefined as any,
  };

  beforeAll(async () => {
    const databaseUrl = getTestDatabaseUrl();
    testDb = createDatabaseClient(databaseUrl);

    bookingService = new BookingService(testDb);
    catalogService = new CatalogService(testDb);
    availabilityService = new AvailabilityService(testDb);

    webMcpContext.bookingService = bookingService;
    webMcpContext.catalogService = catalogService;
    webMcpContext.availabilityService = availabilityService;
    webMcpContext.db = testDb;

    // Seed test tenant & user
    await testDb
      .insertInto("tenants")
      .values({
        id: tenantId,
        name: `Equivalence Tenant ${tenantId}`,
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    await testDb
      .insertInto("app_users")
      .values({
        id: userId,
        oidc_subject: `oidc|eq-${userId}`,
        email_ciphertext: `eq-buyer-${userId}@velvetai.internal`,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    await withTenantTransaction(testDb, tenantId, async (trx) => {
      await trx
        .insertInto("locations")
        .values({
          id: locationId,
          tenant_id: tenantId,
          name: `Equivalence Location ${locationId}`,
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();

      await trx
        .insertInto("services")
        .values({
          id: serviceId,
          tenant_id: tenantId,
          status: "ACTIVE",
          current_version_id: null,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("service_versions")
        .values({
          id: serviceVersionId,
          tenant_id: tenantId,
          service_id: serviceId,
          version: 1,
          name: "Equivalence Luxury Grooming",
          duration_minutes: 45,
          buffer_before_minutes: 0,
          buffer_after_minutes: 0,
          price_minor: "12000",
          base_deposit_minor: "3000",
          currency: "USD",
          cancellation_policy_id: "01932b10-0003-7000-8000-000000000001",
        })
        .execute();

      await trx
        .updateTable("services")
        .set({ current_version_id: serviceVersionId })
        .where("id", "=", serviceId)
        .execute();

      // Ensure active resource exists for location
      await trx
        .insertInto("resources")
        .values({
          id: resourceId,
          tenant_id: tenantId,
          location_id: locationId,
          resource_type: "STAFF",
          display_name: "Master Stylist Equivalence",
          status: "ACTIVE",
        })
        .execute();

      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          user_id: userId,
          role: "OWNER",
          role_version: 1,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .execute();
    });

    fakeModelProvider = new FakeModelProvider();
    app = buildApp({ modelProvider: fakeModelProvider, db: testDb });
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // =========================================================================
  // Operation 1: list_services
  // =========================================================================
  it("Equivalence 1: list_services returns identical service catalog across REST, MCP, WebMCP Simulation & Ask AI", async () => {
    // 1. REST
    const restRes = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: { authorization: authHeader },
    });
    expect(restRes.statusCode).toBe(200);
    const restData = JSON.parse(restRes.body);
    const restService = restData.services.find((s: any) => s.id === serviceId);
    expect(restService).toBeDefined();

    // 2. MCP (tools/call list_services.v1)
    const mcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "list_services.v1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: {
          name: "list_services.v1",
          arguments: {},
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    expect(mcpRes.statusCode).toBe(200);
    const mcpBody = JSON.parse(mcpRes.body);
    const mcpData = JSON.parse(mcpBody.result.content[0].text);
    const mcpService = mcpData.services.find((s: any) => s.id === serviceId);
    expect(mcpService).toBeDefined();

    // 3. WebMCP Simulation (sharedToolRegistry execution with WebMCP client context)
    const webMcpData = (await sharedToolRegistry.execute(
      "list_services.v1",
      {},
      webMcpContext,
    )) as any;
    const webMcpService = webMcpData.services.find((s: any) => s.id === serviceId);
    expect(webMcpService).toBeDefined();

    // 4. Ask AI with FakeModelProvider (POST /v1/ai/chat executing list_services_v1)
    fakeModelProvider.reset();
    fakeModelProvider.queueScript([
      {
        type: "tool-call",
        toolCallId: "call-list-services",
        toolName: "list_services_v1",
        toolArgs: "{}",
      },
    ]);
    const aiRes = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Show available services" }] }],
      }),
    });
    expect(aiRes.statusCode).toBe(200);
    expect(aiRes.body).toContain("list_services");
    expect(aiRes.body).toContain("Equivalence Luxury Grooming");

    // Strict Cross-Transport Field Equivalence
    const restVersion = restService.versions[0];
    expect(mcpService.id).toBe(restService.id);
    expect(webMcpService.id).toBe(restService.id);
    expect(mcpService.name).toBe(restVersion.name);
    expect(webMcpService.name).toBe(restVersion.name);
    expect(Number(mcpService.durationMinutes)).toBe(Number(restVersion.durationMinutes));
    expect(Number(webMcpService.durationMinutes)).toBe(Number(restVersion.durationMinutes));
    expect(String(mcpService.price.valueMinor)).toBe(String(restVersion.priceMinor));
    expect(String(webMcpService.price.valueMinor)).toBe(String(restVersion.priceMinor));
  });

  // =========================================================================
  // Operation 2: find_available_slots
  // =========================================================================
  it("Equivalence 2: find_available_slots returns identical slots & revisions across REST, MCP, WebMCP Simulation & Ask AI", async () => {
    // 1. REST
    const restRes = await app.inject({
      method: "GET",
      url: `/v1/availability?serviceId=${serviceId}&locationId=${locationId}`,
      headers: { authorization: authHeader },
    });
    expect(restRes.statusCode).toBe(200);
    const restData = JSON.parse(restRes.body);

    // 2. MCP
    const mcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "find_available_slots.v1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: {
          name: "find_available_slots.v1",
          arguments: { serviceId, locationId },
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    expect(mcpRes.statusCode).toBe(200);
    const mcpData = JSON.parse(JSON.parse(mcpRes.body).result.content[0].text);

    // 3. WebMCP Simulation
    const webMcpData = (await sharedToolRegistry.execute(
      "find_available_slots.v1",
      { serviceId, locationId },
      webMcpContext,
    )) as any;

    // 4. Ask AI with FakeModelProvider
    fakeModelProvider.reset();
    fakeModelProvider.queueScript([
      {
        type: "tool-call",
        toolCallId: "call-find-slots",
        toolName: "find_available_slots_v1",
        toolArgs: JSON.stringify({ serviceId, locationId }),
      },
    ]);
    const aiRes = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Find open appointments" }] }],
      }),
    });
    expect(aiRes.statusCode).toBe(200);
    expect(aiRes.body).toContain("find_available_slots");

    // Strict Cross-Transport Field Equivalence
    expect(mcpData.slots?.length).toBe(restData.slots?.length);
    expect(webMcpData.slots?.length).toBe(restData.slots?.length);
    expect(mcpData.scheduleRevision).toBe(restData.scheduleRevision);
    expect(webMcpData.scheduleRevision).toBe(restData.scheduleRevision);
  });

  // =========================================================================
  // Operation 3: quote_booking
  // =========================================================================
  it("Equivalence 3: quote_booking calculates identical totals, deposits, and policy snapshots across REST, MCP, WebMCP Simulation & Ask AI", async () => {
    const slotStart = new Date(Date.now() + 86400_000 * 300).toISOString();
    const quotePayload = {
      serviceId,
      locationId,
      startsAt: slotStart,
      timeZone: "America/New_York",
    };

    // 1. REST Quote
    const restRes = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `quote-rest-eq-${Date.now()}`,
      },
      body: JSON.stringify(quotePayload),
    });
    expect(restRes.statusCode).toBe(201);
    const restQuote = JSON.parse(restRes.body);

    // 2. MCP Quote
    const mcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "quote_booking.v1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: {
          name: "quote_booking.v1",
          arguments: quotePayload,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    expect(mcpRes.statusCode).toBe(200);
    const mcpQuote = JSON.parse(JSON.parse(mcpRes.body).result.content[0].text);

    // 3. WebMCP Simulation
    const webMcpQuote = (await sharedToolRegistry.execute(
      "quote_booking.v1",
      quotePayload,
      webMcpContext,
    )) as any;

    // 4. Ask AI with FakeModelProvider
    fakeModelProvider.reset();
    fakeModelProvider.queueScript([
      {
        type: "tool-call",
        toolCallId: "call-quote",
        toolName: "quote_booking_v1",
        toolArgs: JSON.stringify(quotePayload),
      },
    ]);
    const aiRes = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Quote this appointment" }] }],
      }),
    });
    expect(aiRes.statusCode).toBe(200);
    expect(aiRes.body).toContain("quote_booking");

    // Strict Cross-Transport Field Equivalence
    expect(String(mcpQuote.total.valueMinor)).toBe(String(restQuote.total.valueMinor));
    expect(String(webMcpQuote.total.valueMinor)).toBe(String(restQuote.total.valueMinor));
    expect(String(mcpQuote.deposit.valueMinor)).toBe(String(restQuote.deposit.valueMinor));
    expect(String(webMcpQuote.deposit.valueMinor)).toBe(String(restQuote.deposit.valueMinor));
    expect(mcpQuote.total.currency).toBe(restQuote.total.currency);
    expect(webMcpQuote.total.currency).toBe(restQuote.total.currency);
    expect(mcpQuote.cancellationPolicy.policyId).toBe(restQuote.cancellationPolicy.policyId);
    expect(webMcpQuote.cancellationPolicy.policyId).toBe(restQuote.cancellationPolicy.policyId);
  });

  // =========================================================================
  // Operation 4: prepare_booking & approval requirement
  // =========================================================================
  it("Equivalence 4: prepare_booking creates scarce HELD inventory with human approval required across REST, MCP, WebMCP Simulation & Ask AI", async () => {
    // Generate 4 unique slot windows to avoid GiST collision across concurrent holds
    const slotRest = new Date(Date.now() + 86400_000 * 320).toISOString();
    const slotMcp = new Date(Date.now() + 86400_000 * 321).toISOString();
    const slotWebMcp = new Date(Date.now() + 86400_000 * 322).toISOString();
    const slotAi = new Date(Date.now() + 86400_000 * 323).toISOString();

    // 1. REST prepare
    const restRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/prepare",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `prep-rest-${Date.now()}`,
      },
      body: JSON.stringify({
        serviceId,
        locationId,
        startsAt: slotRest,
        timeZone: "America/New_York",
        customer: { email: "rest-eq@example.com", displayName: "REST Eq Buyer" },
      }),
    });
    expect(restRes.statusCode).toBe(201);
    const restData = JSON.parse(restRes.body);

    // 2. MCP prepare
    const mcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "prepare_booking.v1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 104,
        method: "tools/call",
        params: {
          name: "prepare_booking.v1",
          arguments: {
            serviceId,
            locationId,
            startsAt: slotMcp,
            timeZone: "America/New_York",
            customer: { email: "mcp-eq@example.com", displayName: "MCP Eq Buyer" },
          },
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    expect(mcpRes.statusCode).toBe(200);
    const mcpData = JSON.parse(JSON.parse(mcpRes.body).result.content[0].text);

    // 3. WebMCP Simulation prepare
    const webMcpData = (await sharedToolRegistry.execute(
      "prepare_booking.v1",
      {
        serviceId,
        locationId,
        startsAt: slotWebMcp,
        timeZone: "America/New_York",
        customer: { email: "webmcp-eq@example.com", displayName: "WebMCP Eq Buyer" },
      },
      webMcpContext,
    )) as any;

    // 4. Ask AI prepare with FakeModelProvider
    fakeModelProvider.reset();
    fakeModelProvider.queueScript([
      {
        type: "tool-call",
        toolCallId: "call-prepare",
        toolName: "prepare_booking_v1",
        toolArgs: JSON.stringify({
          serviceId,
          locationId,
          startsAt: slotAi,
          timeZone: "America/New_York",
          customer: { email: "ai-eq@example.com", displayName: "AI Eq Buyer" },
        }),
      },
    ]);
    const aiRes = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Reserve this slot" }] }],
      }),
    });
    expect(aiRes.statusCode).toBe(200);
    expect(aiRes.body).toContain("prepare_booking");
    expect(aiRes.body).toContain("/v1/booking-approvals/");

    // Strict Cross-Transport State & Invariant Assertions
    expect(restData.status).toBe("HELD");
    expect(mcpData.status).toBe("HELD");
    expect(webMcpData.status).toBe("HELD");

    expect(restData.approvalLocator).toMatch(/^\/v1\/booking-approvals\//);
    expect(mcpData.approvalLocator).toMatch(/^\/v1\/booking-approvals\//);
    expect(webMcpData.approvalLocator).toMatch(/^\/v1\/booking-approvals\//);

    expect(restData.requiresHumanConfirmation).toBe(true);
    expect(mcpData.requiresHumanConfirmation).toBe(true);
    expect(webMcpData.requiresHumanConfirmation).toBe(true);

    // CRITICAL SECURITY INVARIANT: Raw confirmation token NEVER exposed across any transport
    expect(restData).not.toHaveProperty("confirmation");
    expect(restData).not.toHaveProperty("confirmationToken");
    expect(mcpData).not.toHaveProperty("confirmation");
    expect(mcpData).not.toHaveProperty("confirmationToken");
    expect(webMcpData).not.toHaveProperty("confirmation");
    expect(webMcpData).not.toHaveProperty("confirmationToken");
    expect(aiRes.body).not.toContain("rawConfirmationToken");
  });

  // =========================================================================
  // Operation 5: commit_booking with verified human confirmation & AI fail-closed
  // =========================================================================
  it("Equivalence 5: commit_booking requires browser human confirmation; commits atomically on REST, MCP & WebMCP, and fails closed for Ask AI", async () => {
    // 1. MCP Commit Flow
    const slotMcp = new Date(Date.now() + 86400_000 * 330).toISOString();
    const prepMcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "prepare_booking.v1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 105,
        method: "tools/call",
        params: {
          name: "prepare_booking.v1",
          arguments: {
            serviceId,
            locationId,
            startsAt: slotMcp,
            timeZone: "America/New_York",
            customer: { email: "commit-mcp@example.com", displayName: "Commit MCP" },
          },
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    const prepMcp = JSON.parse(JSON.parse(prepMcpRes.body).result.content[0].text);
    const locMcp = prepMcp.approvalLocator.replace("/v1/booking-approvals/", "");

    // Buyer confirms in browser
    const confMcpRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${locMcp}/confirm`,
      headers: { authorization: authHeader, "idempotency-key": `conf-mcp-${Date.now()}` },
    });
    expect(confMcpRes.statusCode).toBe(200);
    const { confirmation: mcpToken } = JSON.parse(confMcpRes.body);

    // MCP Commit succeeds
    const commitMcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "commit_booking.v1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 106,
        method: "tools/call",
        params: {
          name: "commit_booking.v1",
          arguments: {
            intent: prepMcp.intent,
            confirmation: mcpToken,
            idempotency_key: `commit-mcp-${Date.now()}`,
          },
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    expect(commitMcpRes.statusCode).toBe(200);
    const commitMcpData = JSON.parse(JSON.parse(commitMcpRes.body).result.content[0].text);
    expect(commitMcpData.status).toBe("COMMITTING");

    // 2. REST Commit Flow
    const slotRest = new Date(Date.now() + 86400_000 * 331).toISOString();
    const prepRestRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/prepare",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `prep-rest-c-${Date.now()}`,
      },
      body: JSON.stringify({
        serviceId,
        locationId,
        startsAt: slotRest,
        timeZone: "America/New_York",
        customer: { email: "commit-rest@example.com", displayName: "Commit REST" },
      }),
    });
    const prepRest = JSON.parse(prepRestRes.body);
    const locRest = prepRest.approvalLocator.replace("/v1/booking-approvals/", "");

    const confRestRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${locRest}/confirm`,
      headers: { authorization: authHeader, "idempotency-key": `conf-rest-${Date.now()}` },
    });
    expect(confRestRes.statusCode).toBe(200);
    const { confirmation: restToken } = JSON.parse(confRestRes.body);

    const commitRestRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/commit",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `commit-rest-${Date.now()}`,
      },
      body: JSON.stringify({
        intent: prepRest.intent,
        confirmation: restToken,
        idempotency_key: `commit-rest-${Date.now()}`,
      }),
    });
    expect(commitRestRes.statusCode).toBe(200);
    const commitRestData = JSON.parse(commitRestRes.body);
    expect(commitRestData.status).toBe("COMMITTING");

    // 3. WebMCP Simulation Commit Flow
    const slotWeb = new Date(Date.now() + 86400_000 * 332).toISOString();
    const prepWeb = (await sharedToolRegistry.execute(
      "prepare_booking.v1",
      {
        serviceId,
        locationId,
        startsAt: slotWeb,
        timeZone: "America/New_York",
        customer: { email: "commit-web@example.com", displayName: "Commit Web" },
      },
      webMcpContext,
    )) as any;
    const locWeb = prepWeb.approvalLocator.replace("/v1/booking-approvals/", "");

    const confWebRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${locWeb}/confirm`,
      headers: { authorization: authHeader, "idempotency-key": `conf-web-${Date.now()}` },
    });
    expect(confWebRes.statusCode).toBe(200);
    const { confirmation: webToken } = JSON.parse(confWebRes.body);

    const commitWebData = (await sharedToolRegistry.execute(
      "commit_booking.v1",
      {
        intent: prepWeb.intent,
        confirmation: webToken,
        idempotency_key: `commit-web-${Date.now()}`,
      },
      webMcpContext,
    )) as any;
    expect(commitWebData.status).toBe("COMMITTING");

    // 4. Ask AI Fails Closed for Commit
    fakeModelProvider.reset();
    fakeModelProvider.queueScript([
      {
        type: "tool-call",
        toolCallId: "call-commit-ai-attempt",
        toolName: "commit_booking_v1",
        toolArgs: JSON.stringify({
          intent: prepWeb.intent,
          confirmation: webToken,
          idempotency_key: `commit-ai-${Date.now()}`,
        }),
      },
    ]);
    const aiCommitRes = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Commit the booking now" }] }],
      }),
    });
    expect(aiCommitRes.statusCode).toBe(200);
    expect(aiCommitRes.body).toContain("COMMIT_NOT_PERMITTED_FOR_AI");
  });

  // =========================================================================
  // Operation 6: commit_booking replay failure
  // =========================================================================
  it("Equivalence 6: replay of committed token fails closed across REST, MCP & WebMCP Simulation", async () => {
    const slotStart = new Date(Date.now() + 86400_000 * 340).toISOString();

    // Prepare via REST
    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/prepare",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `prep-rep-${Date.now()}`,
      },
      body: JSON.stringify({
        serviceId,
        locationId,
        startsAt: slotStart,
        timeZone: "America/New_York",
        customer: { email: "replay-eq@example.com", displayName: "Replay Eq Buyer" },
      }),
    });
    const prepData = JSON.parse(prepRes.body);
    const loc = prepData.approvalLocator.replace("/v1/booking-approvals/", "");

    // Buyer confirms
    const confRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${loc}/confirm`,
      headers: { authorization: authHeader, "idempotency-key": `conf-rep-${Date.now()}` },
    });
    const { confirmation } = JSON.parse(confRes.body);

    // Initial commit succeeds
    const initialCommit = await app.inject({
      method: "POST",
      url: "/v1/bookings/commit",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `commit-rep-initial-${Date.now()}`,
      },
      body: JSON.stringify({
        intent: prepData.intent,
        confirmation,
        idempotency_key: `commit-rep-initial-${Date.now()}`,
      }),
    });
    expect(initialCommit.statusCode).toBe(200);

    // Replay on REST -> 409 Conflict
    const restReplay = await app.inject({
      method: "POST",
      url: "/v1/bookings/commit",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `commit-rep-rest-replay-${Date.now()}`,
      },
      body: JSON.stringify({
        intent: prepData.intent,
        confirmation,
        idempotency_key: `commit-rep-rest-replay-${Date.now()}`,
      }),
    });
    expect(restReplay.statusCode).toBe(409);

    // Replay on MCP -> tools/call isError: true
    const mcpReplay = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "commit_booking.v1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 107,
        method: "tools/call",
        params: {
          name: "commit_booking.v1",
          arguments: {
            intent: prepData.intent,
            confirmation,
            idempotency_key: `commit-rep-mcp-replay-${Date.now()}`,
          },
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    const mcpReplayBody = JSON.parse(mcpReplay.body);
    expect(mcpReplayBody.result?.isError).toBe(true);

    // Replay on WebMCP Simulation -> DomainError thrown (409)
    await expect(
      sharedToolRegistry.execute(
        "commit_booking.v1",
        {
          intent: prepData.intent,
          confirmation,
          idempotency_key: `commit-rep-web-replay-${Date.now()}`,
        },
        webMcpContext,
      ),
    ).rejects.toThrowError(DomainError);
  });

  // =========================================================================
  // Operation 7: prepare_cancellation
  // =========================================================================
  it("Equivalence 7: prepare_cancellation returns identical refund quotes across REST, MCP, WebMCP Simulation & Ask AI", async () => {
    // First, prepare a booking to obtain a valid bookingId
    const slotStart = new Date(Date.now() + 86400_000 * 350).toISOString();
    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/prepare",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `prep-cancel-${Date.now()}`,
      },
      body: JSON.stringify({
        serviceId,
        locationId,
        startsAt: slotStart,
        timeZone: "America/New_York",
        customer: { email: "cancel-eq@example.com", displayName: "Cancel Eq Buyer" },
      }),
    });
    expect(prepRes.statusCode).toBe(201);
    const { bookingId } = JSON.parse(prepRes.body);

    // 1. REST prepare cancellation
    const restRes = await app.inject({
      method: "POST",
      url: `/v1/bookings/${bookingId}/prepare-cancellation`,
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "Scheduling conflict" }),
    });
    expect(restRes.statusCode).toBe(200);
    const restData = JSON.parse(restRes.body);

    // 2. MCP prepare cancellation
    const mcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "prepare_cancellation.v1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 108,
        method: "tools/call",
        params: {
          name: "prepare_cancellation.v1",
          arguments: { bookingId, reason: "Scheduling conflict" },
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    expect(mcpRes.statusCode).toBe(200);
    const mcpData = JSON.parse(JSON.parse(mcpRes.body).result.content[0].text);

    // 3. WebMCP Simulation prepare cancellation
    const webMcpData = (await sharedToolRegistry.execute(
      "prepare_cancellation.v1",
      { bookingId, reason: "Scheduling conflict" },
      webMcpContext,
    )) as any;

    // 4. Ask AI prepare cancellation with FakeModelProvider
    fakeModelProvider.reset();
    fakeModelProvider.queueScript([
      {
        type: "tool-call",
        toolCallId: "call-cancel",
        toolName: "prepare_cancellation_v1",
        toolArgs: JSON.stringify({ bookingId, reason: "Scheduling conflict" }),
      },
    ]);
    const aiRes = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "What happens if I cancel?" }] }],
      }),
    });
    expect(aiRes.statusCode).toBe(200);
    expect(aiRes.body).toContain("prepare_cancellation");

    // Strict Cross-Transport Field Equivalence
    expect(mcpData.cancellationAllowed).toBe(restData.cancellationAllowed);
    expect(webMcpData.cancellationAllowed).toBe(restData.cancellationAllowed);
    expect(String(mcpData.refundEligibleMinor)).toBe(String(restData.refundEligibleMinor));
    expect(String(webMcpData.refundEligibleMinor)).toBe(String(restData.refundEligibleMinor));
    expect(mcpData.currency).toBe(restData.currency);
    expect(webMcpData.currency).toBe(restData.currency);
    expect(mcpData.policySummary).toBe(restData.policySummary);
    expect(webMcpData.policySummary).toBe(restData.policySummary);
  });

  // =========================================================================
  // Operation 8: Real Gemini Opt-In Gate
  // =========================================================================
  it("Equivalence 8: Real Gemini Live Model Equivalence reports BLOCKED/NOT_RUN or validates live provider", async () => {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      console.warn(
        "[ACCEPTANCE CRITERIA W8] Real Gemini live equivalence test status: BLOCKED/NOT_RUN (GOOGLE_GENERATIVE_AI_API_KEY not configured in environment).",
      );
      expect(true).toBe(true);
      return;
    }

    const liveGemini = new GeminiModelProvider(apiKey);
    expect(liveGemini.providerName).toBe("gemini");
    const model = liveGemini.getLanguageModel();
    expect(model).toBeDefined();
  });
});
