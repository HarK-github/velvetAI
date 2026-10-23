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

describe("W2, W3, W4: Stateless MCP 2026-07-28 Streamable HTTP & Two-Phase Human Approval", () => {
  let app: FastifyInstance;
  let testDb: Kysely<Database>;
  const tenantId = "01932b10-0000-7000-8000-000000000001";
  const userId = "01932b10-0000-7000-8000-000000000002";
  const serviceId = "01932b10-0001-7000-8000-000000000001";
  const locationId = crypto.randomUUID();
  const authHeader = `Bearer test-token:${userId}:${tenantId}:BUYER:1`;

  beforeAll(async () => {
    const databaseUrl = getTestDatabaseUrl();
    testDb = createDatabaseClient(databaseUrl);

    // Seed tenant, location, service, and policy if not present
    await testDb
      .insertInto("tenants")
      .values({
        id: tenantId,
        name: "MCP Test Tenant",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    await testDb
      .insertInto("app_users")
      .values({
        id: userId,
        oidc_subject: `oidc|${userId}`,
        email_ciphertext: "mcp-test@velvetai.internal",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    await withTenantTransaction(testDb, tenantId, async (trx) => {
      await trx
        .insertInto("locations")
        .values({
          id: locationId,
          tenant_id: tenantId,
          name: `MCP Location ${locationId}`,
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          location_id: locationId,
          resource_type: "STAFF",
          display_name: "MCP Stylist Resource",
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

    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Protocol Rejections & Transport Security", () => {
    it("rejects sessionful GET and DELETE with 405 Method Not Allowed", async () => {
      const getRes = await app.inject({
        method: "GET",
        url: "/mcp",
      });
      expect(getRes.statusCode).toBe(405);
      expect(getRes.headers.allow).toBe("POST");

      const delRes = await app.inject({
        method: "DELETE",
        url: "/mcp",
      });
      expect(delRes.statusCode).toBe(405);
    });

    it("rejects Mcp-Session-Id header with 400 Bad Request (strictly stateless)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-session-id": "session-12345",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
        }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toMatch(/stateless/i);
    });

    it("rejects unauthorized Origin header with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          origin: "https://malicious-site.attacker.com",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
        }),
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.message).toMatch(/Origin .* is not allowed/i);
    });

    it("rejects missing MCP-Protocol-Version header with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
        }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toMatch(/Missing required MCP-Protocol-Version/i);
    });

    it("rejects protocol version mismatch between header and body _meta with official error shape", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "server/discover",
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2025-11-25",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32020);
      expect(body.error.message).toMatch(/headers and body disagree/i);
    });

    it("rejects missing Authorization header with 401 Unauthorized", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32001);
    });
  });

  describe("MCP 2026-07-28 Core Operations", () => {
    it("handles server/discover returning supported revision 2026-07-28 and serverInfo", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "server/discover",
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.result.supportedVersions).toContain("2026-07-28");
      expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("velvetai");
    });

    it("handles tools/list returning all 8 versioned tools with annotations", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/list",
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const tools = body.result.tools;
      const names = tools.map((t: any) => t.name);

      expect(names).toEqual(
        expect.arrayContaining([
          "list_services.v1",
          "find_available_slots.v1",
          "quote_booking.v1",
          "prepare_booking.v1",
          "get_booking.v1",
          "prepare_cancellation.v1",
          "commit_booking.v1",
          "commit_cancellation.v1",
        ]),
      );
    });

    it("executes list_services.v1 through shared ToolRegistry", async () => {
      const res = await app.inject({
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
          id: 12,
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

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.result.content[0].type).toBe("text");
      const data = JSON.parse(body.result.content[0].text);
      expect(data).toHaveProperty("services");
    });
  });

  describe("W4: Two-Phase Human Approval via MCP", () => {
    it("prepare_booking.v1 creates hold snapshot and returns approval locator without exposing confirmation token", async () => {
      const slotStart = new Date(
        Date.now() + 86400_000 * 50 + Math.floor(Math.random() * 100_000_000),
      ).toISOString();

      const res = await app.inject({
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
          id: 13,
          method: "tools/call",
          params: {
            name: "prepare_booking.v1",
            arguments: {
              serviceId,
              locationId,
              startsAt: slotStart,
              timeZone: "America/New_York",
              customer: {
                email: "mcp-buyer@example.com",
                displayName: "MCP Buyer",
              },
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const data = JSON.parse(body.result.content[0].text);

      expect(data.status).toBe("HELD");
      expect(data).toHaveProperty("bookingId");
      expect(data).toHaveProperty("intent");
      expect(data).toHaveProperty("approvalLocator");
      expect(data.approvalLocator).toMatch(/^\/v1\/booking-approvals\//);
      expect(data.requiresHumanConfirmation).toBe(true);

      // CRITICAL SECURITY ASSERTION (W4.5): Never expose raw confirmation token to agent
      expect(data).not.toHaveProperty("confirmation");
      expect(data).not.toHaveProperty("confirmationToken");
    });

    it("commit_booking.v1 fails closed without valid browser human confirmation", async () => {
      const res = await app.inject({
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
          id: 14,
          method: "tools/call",
          params: {
            name: "commit_booking.v1",
            arguments: {
              intent: "forged.booking.intent",
              confirmation: "unconfirmed-fake-token-12345",
              idempotency_key: "mcp-test-idemp-1",
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      // Commit without verified human confirmation MUST fail closed
      const body = JSON.parse(res.body);
      if (res.statusCode === 200) {
        expect(body.result?.isError).toBe(true);
      } else {
        expect([400, 401, 403, 404, 409, 500]).toContain(res.statusCode);
      }
    });

    it("completes full two-phase human approval lifecycle: prepare -> human browser confirm -> commit", async () => {
      const slotStart = new Date(
        Date.now() + 86400_000 * 100 + Math.floor(Math.random() * 100_000_000),
      ).toISOString();

      // Phase 1: Agent calls prepare_booking.v1
      const prepareRes = await app.inject({
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
          id: 101,
          method: "tools/call",
          params: {
            name: "prepare_booking.v1",
            arguments: {
              serviceId,
              locationId,
              startsAt: slotStart,
              timeZone: "America/New_York",
              customer: {
                email: "buyer-lifecycle@example.com",
                displayName: "Lifecycle Buyer",
              },
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      expect(prepareRes.statusCode).toBe(200);
      const prepareBody = JSON.parse(prepareRes.body);
      const prepareData = JSON.parse(prepareBody.result.content[0].text);
      expect(prepareData.status).toBe("HELD");
      expect(prepareData.approvalLocator).toBeTruthy();

      const locator = prepareData.approvalLocator.replace("/v1/booking-approvals/", "");

      // Phase 2: Human buyer approves terms on hardened approval route
      const confirmRes = await app.inject({
        method: "POST",
        url: `/v1/booking-approvals/${locator}/confirm`,
        headers: {
          authorization: authHeader,
          "idempotency-key": `confirm-idemp-${Date.now()}-${Math.random()}`,
        },
      });

      expect(confirmRes.statusCode).toBe(200);
      const confirmData = JSON.parse(confirmRes.body);
      expect(confirmData).toHaveProperty("confirmation");
      const confirmationToken = confirmData.confirmation;

      // Phase 3: Agent calls commit_booking.v1 with intent and human confirmation token
      const commitRes = await app.inject({
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
          id: 102,
          method: "tools/call",
          params: {
            name: "commit_booking.v1",
            arguments: {
              intent: prepareData.intent,
              confirmation: confirmationToken,
              idempotency_key: `lifecycle-idemp-${Date.now()}`,
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      expect(commitRes.statusCode).toBe(200);
      const commitBody = JSON.parse(commitRes.body);
      expect(commitBody.result?.isError).toBeFalsy();
      const commitData = JSON.parse(commitBody.result.content[0].text);
      expect(commitData.status).toBe("COMMITTING");

      // Phase 4: Replay with already consumed confirmation token fails closed
      const replayRes = await app.inject({
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
          id: 103,
          method: "tools/call",
          params: {
            name: "commit_booking.v1",
            arguments: {
              intent: prepareData.intent,
              confirmation: confirmationToken,
              idempotency_key: `lifecycle-replay-${Date.now()}`,
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      const replayBody = JSON.parse(replayRes.body);
      // Replay must fail closed because token was consumed
      expect(replayBody.result?.isError).toBe(true);
    });
  });

  describe("Audit Section 5: Two-Phase Confirmation Security Invariants & Server-Side Resolution", () => {
    it("commit succeeds with server-resolved confirmation when agent supplies only intent and idempotency_key after browser approval", async () => {
      const slotStart = new Date(
        Date.now() + 86400_000 * 350 + Math.floor(Math.random() * 50_000_000),
      ).toISOString();
      const clientId = "mcp-agent-client-1";

      // 1. Agent prepares booking hold
      const prepRes = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "prepare_booking.v1",
          "x-client-id": clientId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 201,
          method: "tools/call",
          params: {
            name: "prepare_booking.v1",
            arguments: {
              serviceId,
              locationId,
              startsAt: slotStart,
              timeZone: "America/New_York",
              customer: { email: "sec5-buyer@example.com", displayName: "Sec5 Buyer" },
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      expect(prepRes.statusCode).toBe(200);
      const prepData = JSON.parse(JSON.parse(prepRes.body).result.content[0].text);
      expect(prepData.approvalLocator).toBeDefined();
      expect(prepData.intent).toBeDefined();
      // SECURITY INVARIANT: Confirmation token is NEVER sent to the agent/model
      expect((prepData as Record<string, unknown>).confirmation).toBeUndefined();

      // 2. Buyer approves terms on hardened browser route
      const locator = prepData.approvalLocator.replace("/v1/booking-approvals/", "");
      const confirmRes = await app.inject({
        method: "POST",
        url: `/v1/booking-approvals/${locator}/confirm`,
        headers: {
          authorization: authHeader,
          "idempotency-key": `browser-confirm-${Date.now()}`,
        },
      });
      expect(confirmRes.statusCode).toBe(200);

      // 3. Agent calls commit_booking without providing any confirmation token!
      const commitRes = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "commit_booking.v1",
          "x-client-id": clientId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 202,
          method: "tools/call",
          params: {
            name: "commit_booking.v1",
            arguments: {
              intent: prepData.intent,
              // Notice: confirmation token is intentionally omitted!
              idempotency_key: `sec5-commit-${Date.now()}`,
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      expect(commitRes.statusCode).toBe(200);
      const commitBody = JSON.parse(commitRes.body);
      expect(commitBody.result?.isError).toBeFalsy();
      const commitData = JSON.parse(commitBody.result.content[0].text);
      expect(commitData.status).toBe("COMMITTING");
    });

    it("commit fails closed with APPROVAL_INCOMPLETE when agent attempts commit before browser confirmation", async () => {
      const slotStart = new Date(
        Date.now() + 86400_000 * 370 + Math.floor(Math.random() * 50_000_000),
      ).toISOString();
      const clientId = "mcp-agent-client-2";

      // 1. Prepare booking
      const prepRes = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "prepare_booking.v1",
          "x-client-id": clientId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 203,
          method: "tools/call",
          params: {
            name: "prepare_booking.v1",
            arguments: {
              serviceId,
              locationId,
              startsAt: slotStart,
              timeZone: "America/New_York",
              customer: {
                email: "unconfirmed-buyer@example.com",
                displayName: "Unconfirmed Buyer",
              },
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });
      const prepData = JSON.parse(JSON.parse(prepRes.body).result.content[0].text);

      // 2. Agent immediately calls commit BEFORE buyer approves in browser
      const commitRes = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "commit_booking.v1",
          "x-client-id": clientId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 204,
          method: "tools/call",
          params: {
            name: "commit_booking.v1",
            arguments: {
              intent: prepData.intent,
              idempotency_key: `premature-commit-${Date.now()}`,
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      // Must fail closed because browser confirmation has not occurred
      const commitBody = JSON.parse(commitRes.body);
      expect(commitBody.result?.isError).toBe(true);
      expect(commitBody.result.content[0].text).toContain("Approval incomplete");
    });

    it("commit fails closed with INVALID_CONFIRMATION when model or attacker provides a fake confirmation token", async () => {
      const slotStart = new Date(
        Date.now() + 86400_000 * 390 + Math.floor(Math.random() * 50_000_000),
      ).toISOString();
      const clientId = "mcp-agent-client-3";

      // 1. Prepare booking
      const prepRes = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "prepare_booking.v1",
          "x-client-id": clientId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 205,
          method: "tools/call",
          params: {
            name: "prepare_booking.v1",
            arguments: {
              serviceId,
              locationId,
              startsAt: slotStart,
              timeZone: "America/New_York",
              customer: { email: "fake-conf-buyer@example.com", displayName: "Fake Conf Buyer" },
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });
      const prepData = JSON.parse(JSON.parse(prepRes.body).result.content[0].text);

      // 2. Caller supplies a fake confirmation token
      const commitRes = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "commit_booking.v1",
          "x-client-id": clientId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 206,
          method: "tools/call",
          params: {
            name: "commit_booking.v1",
            arguments: {
              intent: prepData.intent,
              confirmation: "conf_fake_unauthorized_token_1234567890",
              idempotency_key: `fake-conf-idemp-${Date.now()}`,
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      const commitBody = JSON.parse(commitRes.body);
      expect(commitBody.result?.isError).toBe(true);
      expect(commitBody.result.content[0].text).toContain("Invalid buyer confirmation token");
    });

    it("commit fails closed with CLIENT_MISMATCH when another OAuth client attempts to commit with valid intent handle", async () => {
      const slotStart = new Date(
        Date.now() + 86400_000 * 410 + Math.floor(Math.random() * 50_000_000),
      ).toISOString();
      const originClient = "mcp-origin-client";
      const attackerClient = "mcp-attacker-client";

      // 1. Prepare booking under originClient
      const prepRes = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "prepare_booking.v1",
          "x-client-id": originClient,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 207,
          method: "tools/call",
          params: {
            name: "prepare_booking.v1",
            arguments: {
              serviceId,
              locationId,
              startsAt: slotStart,
              timeZone: "America/New_York",
              customer: { email: "origin-buyer@example.com", displayName: "Origin Buyer" },
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });
      const prepData = JSON.parse(JSON.parse(prepRes.body).result.content[0].text);

      // 2. Buyer confirms
      const locator = prepData.approvalLocator.replace("/v1/booking-approvals/", "");
      await app.inject({
        method: "POST",
        url: `/v1/booking-approvals/${locator}/confirm`,
        headers: {
          authorization: authHeader,
          "idempotency-key": `origin-confirm-${Date.now()}`,
        },
      });

      // 3. Different client tries to commit with valid intent
      const commitRes = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "commit_booking.v1",
          "x-client-id": attackerClient,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 208,
          method: "tools/call",
          params: {
            name: "commit_booking.v1",
            arguments: {
              intent: prepData.intent,
              idempotency_key: `attacker-commit-${Date.now()}`,
            },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });

      const commitBody = JSON.parse(commitRes.body);
      expect(commitBody.result?.isError).toBe(true);
      expect(commitBody.result.content[0].text).toContain("OAuth client substitution detected");
    });
  });
});
