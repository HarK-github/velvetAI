import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as jose from "jose";
import { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { Auth0AuthenticationAdapter, setAuthAdapter, requireScopes } from "../plugins/auth.js";
import {
  createDatabaseClient,
  withTenantTransaction,
  Database,
  getTestDatabaseUrl,
} from "@velvetai/db";
import { validateEnv } from "@velvetai/observability";
import { Kysely } from "kysely";
import crypto from "node:crypto";

describe("W1: Auth0 Identity and Local Membership Authority", () => {
  let app: FastifyInstance;
  let keyPair: jose.GenerateKeyPairResult;
  let testDb: Kysely<Database>;
  const testIssuer = "https://auth0.velvetai.test/";
  const testAudience = "https://velvetai.example/api";
  let scopeOidcSubject: string;

  beforeAll(async () => {
    delete process.env.SELF_SIGNUP_ENABLED;
    delete process.env.SELF_SIGNUP_TENANT_ID;

    // Generate an in-memory RS256 key pair for offline cryptographic token tests
    keyPair = await jose.generateKeyPair("RS256");

    const databaseUrl = getTestDatabaseUrl();
    testDb = createDatabaseClient(databaseUrl);

    // Create custom adapter that verifies with the in-memory test public key
    const localKeySet: jose.JWTVerifyGetKey = async () => keyPair.publicKey;

    const adapter = new Auth0AuthenticationAdapter({
      issuer: testIssuer,
      audience: testAudience,
      db: testDb,
      allowDevTokens: false,
      localKeySet,
    });
    setAuthAdapter(adapter);

    scopeOidcSubject = `auth0|scope-test-${Date.now()}`;
    const scopeUserId = crypto.randomUUID();
    const scopeTenantId = "01932b10-0000-7000-8000-000000000001";
    await testDb
      .insertInto("app_users")
      .values({
        id: scopeUserId,
        oidc_subject: scopeOidcSubject,
        email_ciphertext: "scope-test@example.com",
      })
      .execute();

    await withTenantTransaction(testDb, scopeTenantId, async (trx) => {
      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: scopeTenantId,
          user_id: scopeUserId,
          role: "BUYER",
          role_version: 1,
          revoked_at: null,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .execute();
    });

    app = buildApp();

    // Register test routes before calling ready()
    app.get("/v1/test/principal", async (request) => ({
      principal: request.principal,
    }));

    app.get(
      "/v1/test/guarded-refund",
      { preHandler: [requireScopes("merchant:refund")] },
      async () => ({ ok: true }),
    );

    app.get("/v1/test/guarded-read", { preHandler: [requireScopes("booking:read")] }, async () => ({
      ok: true,
    }));

    await app.ready();
  });

  afterAll(async () => {
    delete process.env.SELF_SIGNUP_ENABLED;
    delete process.env.SELF_SIGNUP_TENANT_ID;
    await app.close();
  });

  beforeEach(() => {
    delete process.env.SELF_SIGNUP_ENABLED;
    delete process.env.SELF_SIGNUP_TENANT_ID;
  });

  describe("RFC 9728 OAuth Protected Resource Metadata", () => {
    it("proves metadata.resource equals configured AUTH0_AUDIENCE and authorization_servers contains AUTH0_ISSUER", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-protected-resource",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");

      const body = JSON.parse(res.body);
      const env = validateEnv();

      // Proves metadata.resource equals the configured AUTH0_AUDIENCE
      expect(body.resource).toBe(env.AUTH0_AUDIENCE);
      expect(body.resource).toBe("https://velvetai.example/api");

      // Proves authorization_servers contains AUTH0_ISSUER
      expect(body.authorization_servers).toContain(env.AUTH0_ISSUER);

      // Proves we do not hardcode or advertise unregistered /mcp
      expect(body.resource).not.toBe("https://api.velvetai.example/mcp");

      expect(body.bearer_methods_supported).toEqual(["header"]);
      expect(body.scopes_supported).toEqual(
        expect.arrayContaining([
          "booking:read",
          "booking:quote",
          "booking:prepare",
          "booking:commit",
          "booking:cancel",
          "merchant:schedule",
          "merchant:refund",
        ]),
      );
    });

    it("dynamically reflects reconfigured AUTH0_AUDIENCE and does not advertise unregistered /mcp", async () => {
      const originalAudience = process.env.AUTH0_AUDIENCE;
      try {
        process.env.AUTH0_AUDIENCE = "https://custom-audience.example/api";
        const res = await app.inject({
          method: "GET",
          url: "/.well-known/oauth-protected-resource",
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.resource).toBe("https://custom-audience.example/api");
        expect(body.resource).not.toBe("https://api.velvetai.example/mcp");
      } finally {
        if (originalAudience !== undefined) {
          process.env.AUTH0_AUDIENCE = originalAudience;
        } else {
          delete process.env.AUTH0_AUDIENCE;
        }
      }
    });
  });

  describe("Dev Token Rejection & Explicit Mock Mode Enforcement", () => {
    it("rejects test-token with 401 when mock mode is false (OIDC_MOCK_ENABLED=false)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: {
          authorization:
            "Bearer test-token:01932b10-0000-7000-8000-000000000002:01932b10-0000-7000-8000-000000000001:BUYER:1",
        },
      });

      expect(res.statusCode).toBe(401);
      const problem = JSON.parse(res.body);
      expect(problem.status).toBe(401);
      expect(problem.code).toBe("unauthorized");
    });

    it("fails startup when allowDevTokens is configured with OIDC_MOCK_ENABLED=false", () => {
      const orig = process.env.OIDC_MOCK_ENABLED;
      try {
        process.env.OIDC_MOCK_ENABLED = "false";
        expect(() => {
          new Auth0AuthenticationAdapter({
            issuer: testIssuer,
            audience: testAudience,
            db: testDb,
            allowDevTokens: true,
          });
        }).toThrow(/FATAL: Dev-token fallback is strictly forbidden when OIDC_MOCK_ENABLED=false/);
      } finally {
        process.env.OIDC_MOCK_ENABLED = orig;
      }
    });

    it("fails startup when allowDevTokens is configured in production environment", () => {
      const origEnv = process.env.NODE_ENV;
      const origMock = process.env.OIDC_MOCK_ENABLED;
      const origSigning = process.env.INTENT_SIGNING_KEY;
      const origConfirm = process.env.CONFIRMATION_TOKEN_SECRET;
      const origEnvelope = process.env.ENVELOPE_ENCRYPTION_KEY;
      try {
        process.env.NODE_ENV = "production";
        process.env.OIDC_MOCK_ENABLED = "true";
        process.env.INTENT_SIGNING_KEY = Buffer.from(
          crypto
            .generateKeyPairSync("ec", { namedCurve: "prime256v1" })
            .privateKey.export({ type: "pkcs8", format: "pem" }),
        ).toString("base64");
        process.env.CONFIRMATION_TOKEN_SECRET = "super_secret_confirmation_token_secret_32_chars";
        process.env.ENVELOPE_ENCRYPTION_KEY =
          "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
        expect(() => {
          new Auth0AuthenticationAdapter({
            issuer: testIssuer,
            audience: testAudience,
            db: testDb,
            allowDevTokens: true,
          });
        }).toThrow(/FATAL: Dev-token fallback is strictly forbidden in production/);
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.OIDC_MOCK_ENABLED = origMock;
        if (origSigning) process.env.INTENT_SIGNING_KEY = origSigning;
        else delete process.env.INTENT_SIGNING_KEY;
        if (origConfirm) process.env.CONFIRMATION_TOKEN_SECRET = origConfirm;
        else delete process.env.CONFIRMATION_TOKEN_SECRET;
        if (origEnvelope) process.env.ENVELOPE_ENCRYPTION_KEY = origEnvelope;
        else delete process.env.ENVELOPE_ENCRYPTION_KEY;
      }
    });

    it("accepts test-token in explicit mock mode and resolves principal", async () => {
      const origMock = process.env.OIDC_MOCK_ENABLED;
      try {
        process.env.OIDC_MOCK_ENABLED = "true";
        const mockAdapter = new Auth0AuthenticationAdapter({
          issuer: testIssuer,
          audience: testAudience,
          db: testDb,
          allowDevTokens: true,
        });
        const principal = await mockAdapter.authenticateBearerToken(
          "test-token:01932b10-0000-7000-8000-000000000002:01932b10-0000-7000-8000-000000000001:BUYER:1",
        );
        expect(principal.userId).toBe("01932b10-0000-7000-8000-000000000002");
        expect(principal.tenantId).toBe("01932b10-0000-7000-8000-000000000001");
        expect(principal.roles).toContain("BUYER");
      } finally {
        process.env.OIDC_MOCK_ENABLED = origMock;
      }
    });

    it("rejects revoked test-token in explicit mock mode with 403 Forbidden", async () => {
      const origMock = process.env.OIDC_MOCK_ENABLED;
      try {
        process.env.OIDC_MOCK_ENABLED = "true";
        const mockAdapter = new Auth0AuthenticationAdapter({
          issuer: testIssuer,
          audience: testAudience,
          db: testDb,
          allowDevTokens: true,
        });
        await expect(
          mockAdapter.authenticateBearerToken(
            "test-token:01932b10-0000-7000-8000-000000000002:01932b10-0000-7000-8000-000000000001:BUYER:1:revoked",
          ),
        ).rejects.toThrow(/Membership has been revoked/i);
      } finally {
        process.env.OIDC_MOCK_ENABLED = origMock;
      }
    });
  });

  describe("Real RS256 JWT Verification & Local PostgreSQL Membership", () => {
    it("authenticates signed RS256 JWT and resolves local DB membership", async () => {
      const testUserId = crypto.randomUUID();
      const testTenantId = "01932b10-0000-7000-8000-000000000001";
      const oidcSub = `auth0|test-user-${Date.now()}`;

      await testDb
        .insertInto("app_users")
        .values({
          id: testUserId,
          oidc_subject: oidcSub,
          email_ciphertext: "test@example.com",
        })
        .execute();

      await withTenantTransaction(testDb, testTenantId, async (trx) => {
        await trx
          .insertInto("memberships")
          .values({
            id: crypto.randomUUID(),
            tenant_id: testTenantId,
            user_id: testUserId,
            role: "BUYER",
            role_version: 1,
            revoked_at: null,
          })
          .execute();
      });

      const jwt = await new jose.SignJWT({
        sub: oidcSub,
        scope: "booking:read booking:quote",
        "https://velvetai.com/role_version": 1,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-tenant-id": testTenantId,
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it("immediately rejects valid JWT when local DB membership is revoked", async () => {
      const testUserId = crypto.randomUUID();
      const testTenantId = "01932b10-0000-7000-8000-000000000001";
      const oidcSub = `auth0|revoked-user-${Date.now()}`;

      await testDb
        .insertInto("app_users")
        .values({
          id: testUserId,
          oidc_subject: oidcSub,
          email_ciphertext: "revoked@example.com",
        })
        .execute();

      await withTenantTransaction(testDb, testTenantId, async (trx) => {
        await trx
          .insertInto("memberships")
          .values({
            id: crypto.randomUUID(),
            tenant_id: testTenantId,
            user_id: testUserId,
            role: "BUYER",
            role_version: 1,
            revoked_at: new Date(),
          })
          .execute();
      });

      const jwt = await new jose.SignJWT({
        sub: oidcSub,
        scope: "booking:read",
        "https://velvetai.com/role_version": 1,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-tenant-id": testTenantId,
        },
      });

      expect(res.statusCode).toBe(403);
      const problem = JSON.parse(res.body);
      expect(problem.code).toBe("membership_revoked");
    });

    it("immediately rejects valid JWT when token role version is stale", async () => {
      const testUserId = crypto.randomUUID();
      const testTenantId = "01932b10-0000-7000-8000-000000000001";
      const oidcSub = `auth0|stale-user-${Date.now()}`;

      await testDb
        .insertInto("app_users")
        .values({
          id: testUserId,
          oidc_subject: oidcSub,
          email_ciphertext: "stale@example.com",
        })
        .execute();

      await withTenantTransaction(testDb, testTenantId, async (trx) => {
        await trx
          .insertInto("memberships")
          .values({
            id: crypto.randomUUID(),
            tenant_id: testTenantId,
            user_id: testUserId,
            role: "BUYER",
            role_version: 2, // Local DB version is 2
            revoked_at: null,
          })
          .execute();
      });

      const jwt = await new jose.SignJWT({
        sub: oidcSub,
        scope: "booking:read",
        "https://velvetai.com/role_version": 1, // Stale version 1 in token
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-tenant-id": testTenantId,
        },
      });

      expect(res.statusCode).toBe(403);
      const problem = JSON.parse(res.body);
      expect(problem.code).toBe("stale_role_version");
    });

    it("rejects forged issuer with 401 Unauthorized", async () => {
      const jwt = await new jose.SignJWT({
        sub: "auth0|forged-issuer",
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://malicious-issuer.attacker.com/")
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: {
          authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.statusCode).toBe(401);
      const problem = JSON.parse(res.body);
      expect(problem.code).toBe("invalid_jwt");
    });

    it("rejects wrong audience with 401 Unauthorized", async () => {
      const jwt = await new jose.SignJWT({
        sub: "auth0|wrong-audience",
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience("https://wrong-audience.internal")
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: {
          authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.statusCode).toBe(401);
      const problem = JSON.parse(res.body);
      expect(problem.code).toBe("invalid_jwt");
    });

    it("authenticates valid Auth0-shaped token without role_version claim and proves local DB authority", async () => {
      const testUserId = crypto.randomUUID();
      const testTenantId = "01932b10-0000-7000-8000-000000000001";
      const oidcSub = `auth0|no-role-version-user-${Date.now()}`;

      // 1. Insert app_user in local database
      await testDb
        .insertInto("app_users")
        .values({
          id: testUserId,
          oidc_subject: oidcSub,
          email_ciphertext: "noroleversion@example.com",
        })
        .execute();

      // 2. Insert initial membership in PostgreSQL: role WORKER, role_version 5
      const membershipId = crypto.randomUUID();
      await withTenantTransaction(testDb, testTenantId, async (trx) => {
        await trx
          .insertInto("memberships")
          .values({
            id: membershipId,
            tenant_id: testTenantId,
            user_id: testUserId,
            role: "WORKER",
            role_version: 5,
            revoked_at: null,
          })
          .execute();
      });

      // 3. Mint valid Auth0-shaped RS256 token WITHOUT role_version claim
      // Include adversarial role claims in token to prove PostgreSQL membership remains strictly authoritative
      const jwt = await new jose.SignJWT({
        sub: oidcSub,
        scope: "booking:read",
        "https://velvetai.com/role": "OWNER",
        role: "OWNER",
        // Notice: NO role_version or https://velvetai.com/role_version claim!
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      // 4. Send request and inspect principal
      const res1 = await app.inject({
        method: "GET",
        url: "/v1/test/principal",
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-tenant-id": testTenantId,
        },
      });

      expect(res1.statusCode).toBe(200);
      const data1 = JSON.parse(res1.body);
      expect(data1.principal).toBeDefined();
      expect(data1.principal.subject).toBe(oidcSub);
      expect(data1.principal.userId).toBe(testUserId);
      expect(data1.principal.tenantId).toBe(testTenantId);
      // Local PostgreSQL role WORKER is authoritative (NOT token claim OWNER)
      expect(data1.principal.roles).toEqual(["WORKER"]);
      // Local PostgreSQL role_version 5 is authoritative
      expect(data1.principal.roleVersion).toBe(5);

      // 5. Update local membership in PostgreSQL to SCHEDULER with role_version 6
      await withTenantTransaction(testDb, testTenantId, async (trx) => {
        await trx
          .updateTable("memberships")
          .set({ role: "SCHEDULER", role_version: 6 })
          .where("id", "=", membershipId)
          .execute();
      });

      // 6. With SAME token (still lacking role_version), local DB update is immediately authoritative
      const res2 = await app.inject({
        method: "GET",
        url: "/v1/test/principal",
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-tenant-id": testTenantId,
        },
      });

      expect(res2.statusCode).toBe(200);
      const data2 = JSON.parse(res2.body);
      expect(data2.principal.roles).toEqual(["SCHEDULER"]);
      expect(data2.principal.roleVersion).toBe(6);

      // 7. Revoke local membership in PostgreSQL
      await withTenantTransaction(testDb, testTenantId, async (trx) => {
        await trx
          .updateTable("memberships")
          .set({ revoked_at: new Date() })
          .where("id", "=", membershipId)
          .execute();
      });

      // 8. With SAME token, verify request is immediately rejected with 403 membership_revoked
      const res3 = await app.inject({
        method: "GET",
        url: "/v1/test/principal",
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-tenant-id": testTenantId,
        },
      });

      expect(res3.statusCode).toBe(403);
      const problem = JSON.parse(res3.body);
      expect(problem.code).toBe("membership_revoked");
    });

    it("rejects valid JWT when subject is not registered in local app_users with 403 Forbidden", async () => {
      const oidcSub = `auth0|unregistered-user-${Date.now()}`;
      const jwt = await new jose.SignJWT({
        sub: oidcSub,
        scope: "booking:read",
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: {
          authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.statusCode).toBe(403);
      const problem = JSON.parse(res.body);
      expect(problem.code).toBe("user_not_provisioned");
    });

    it("rejects valid JWT when local user has no membership in tenant with 403 Forbidden", async () => {
      const testUserId = crypto.randomUUID();
      const oidcSub = `auth0|nomembership-user-${Date.now()}`;

      await testDb
        .insertInto("app_users")
        .values({
          id: testUserId,
          oidc_subject: oidcSub,
          email_ciphertext: "nomembership@example.com",
        })
        .execute();

      const jwt = await new jose.SignJWT({
        sub: oidcSub,
        scope: "booking:read",
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-tenant-id": "01932b10-0000-7000-8000-000000000001",
        },
      });

      expect(res.statusCode).toBe(403);
      const problem = JSON.parse(res.body);
      expect(problem.code).toBe("membership_not_found");
    });

    it("ensures client-supplied tenant ID cannot influence selection", async () => {
      const testUserId = crypto.randomUUID();
      const actualTenantId = "01932b10-0000-7000-8000-000000000001";
      const adversarialTenantId = "01932b10-0000-7000-8000-000000000099";
      const oidcSub = `auth0|adversarial-tenant-${Date.now()}`;

      await testDb
        .insertInto("app_users")
        .values({
          id: testUserId,
          oidc_subject: oidcSub,
          email_ciphertext: "adversarial@example.com",
        })
        .execute();

      await withTenantTransaction(testDb, actualTenantId, async (trx) => {
        await trx
          .insertInto("memberships")
          .values({
            id: crypto.randomUUID(),
            tenant_id: actualTenantId,
            user_id: testUserId,
            role: "BUYER",
            role_version: 1,
            revoked_at: null,
          })
          .execute();
      });

      const jwt = await new jose.SignJWT({
        sub: oidcSub,
        scope: "booking:read",
        "https://velvetai.com/tenant_id": adversarialTenantId, // adversarial JWT claim
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      // Client sends adversarial x-tenant-id header
      const res = await app.inject({
        method: "GET",
        url: "/v1/test/principal",
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-tenant-id": adversarialTenantId,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      // Principal strictly derives tenant_id from local PostgreSQL membership, ignoring both client header and JWT claim
      expect(data.principal.tenantId).toBe(actualTenantId);
      expect(data.principal.tenantId).not.toBe(adversarialTenantId);
    });

    it("maps raw PostgreSQL 42501 error to generic 500 without leaking database details", async () => {
      const oidcSub = `auth0|pgerror-user-${Date.now()}`;
      const jwt = await new jose.SignJWT({
        sub: oidcSub,
        scope: "booking:read",
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const pgError = Object.assign(
        new Error('query would be affected by row-level security policy for table "memberships"'),
        {
          code: "42501",
          severity: "ERROR",
          table: "memberships",
          routine: "check_enable_rls",
        },
      );

      vi.spyOn(testDb, "selectFrom").mockImplementationOnce(() => {
        throw pgError;
      });

      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: {
          authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.statusCode).toBe(500);
      const problem = JSON.parse(res.body);
      expect(problem.status).toBe(500);
      expect(problem.code).toBe("internal_error");
      expect(problem.detail).toBe("An internal database or authentication error occurred");
      // Verify no leak of PostgreSQL code 42501, table name, or raw message
      expect(res.body).not.toContain("42501");
      expect(res.body).not.toContain("memberships");
      expect(res.body).not.toContain("row-level security");
    });
  });

  describe("Scope Enforcement Guard", () => {
    it("returns 403 Forbidden when client lacks required scope", async () => {
      const jwt = await new jose.SignJWT({
        sub: scopeOidcSubject,
        scope: "booking:read",
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const res = await app.inject({
        method: "GET",
        url: "/v1/test/guarded-refund",
        headers: {
          authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.statusCode).toBe(403);
      const problem = JSON.parse(res.body);
      expect(problem.code).toBe("insufficient_scope");
      expect(problem.detail).toMatch(/merchant:refund/);
    });

    it("allows access when client possesses required scope", async () => {
      const jwt = await new jose.SignJWT({
        sub: scopeOidcSubject,
        scope: "booking:read",
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(testIssuer)
        .setAudience(testAudience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(keyPair.privateKey);

      const res = await app.inject({
        method: "GET",
        url: "/v1/test/guarded-read",
        headers: {
          authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });

    it("unions local judge:* scopes when a human JUDGE authenticates with Auth0 JWT lacking judge:* claims", async () => {
      const judgeSub = `auth0|judge-union-${Date.now()}`;
      const judgeUserId = crypto.randomUUID();
      const judgeTenantId = "01932b10-0000-7000-8000-000000000a01";

      await testDb
        .insertInto("app_users")
        .values({
          id: judgeUserId,
          oidc_subject: judgeSub,
          email_ciphertext: "judge-union@example.com",
        })
        .execute();

      await withTenantTransaction(testDb, judgeTenantId, async (trx) => {
        await trx
          .insertInto("memberships")
          .values({
            id: crypto.randomUUID(),
            tenant_id: judgeTenantId,
            user_id: judgeUserId,
            role: "JUDGE",
            role_version: 1,
            revoked_at: null,
          })
          .execute();
      });

      try {
        const jwt = await new jose.SignJWT({
          sub: judgeSub,
          scope: "openid profile email booking:read",
        })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer(testIssuer)
          .setAudience(testAudience)
          .setIssuedAt()
          .setExpirationTime("2h")
          .sign(keyPair.privateKey);

        const res = await app.inject({
          method: "GET",
          url: "/v1/test/principal",
          headers: {
            authorization: `Bearer ${jwt}`,
          },
        });

        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.principal.roles).toContain("JUDGE");
        expect(data.principal.scopes).toEqual(
          expect.arrayContaining(["booking:read", "judge:reset", "judge:abuse_lab"]),
        );
      } finally {
        await withTenantTransaction(testDb, judgeTenantId, async (trx) => {
          await trx.deleteFrom("memberships").where("user_id", "=", judgeUserId).execute();
        });
        await testDb.deleteFrom("app_users").where("id", "=", judgeUserId).execute();
      }
    });
  });
});
