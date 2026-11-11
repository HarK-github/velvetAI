import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as jose from "jose";
import { Kysely, sql } from "kysely";
import {
  AuthenticatedPrincipal,
  AuthenticationPort,
  OnboardingService,
} from "@velvetai/application";
import {
  TenantId,
  UserId,
  Role,
  Scope,
  DEFAULT_ROLE_SCOPES,
  createProblemDetails,
  MembershipRevokedError,
  StaleRoleVersionError,
  DomainError,
} from "@velvetai/contracts";
import { Database, createDatabaseClient, withUserTransaction } from "@velvetai/db";
import { validateEnv } from "@velvetai/observability";
import { getClientIp } from "./public-rate-limit.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticateBearerToken: (
      token: string,
      requestedTenantId?: TenantId,
    ) => Promise<AuthenticatedPrincipal>;
  }
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
    tenantId?: TenantId;
    clientId?: string;
  }
}

export interface Auth0AdapterOptions {
  issuer?: string;
  audience?: string;
  jwksUri?: string;
  db?: Kysely<Database>;
  allowDevTokens?: boolean;
  localKeySet?: jose.JWTVerifyGetKey;
}

/**
 * Authoritative Auth0 Authentication and Local PostgreSQL RBAC Adapter.
 *
 * Verifies external Auth0 JWTs using JWKS caching and key rotation.
 * The local PostgreSQL `memberships` table remains the sole authoritative source
 * of truth for tenant_id, local user_id, role, role_version, and revocation status.
 */
export class Auth0AuthenticationAdapter implements AuthenticationPort {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUri: string;
  private readonly db?: Kysely<Database>;
  private readonly allowDevTokens: boolean;
  private readonly onboardingService?: OnboardingService;
  private jwks?: jose.JWTVerifyGetKey;

  constructor(options?: Auth0AdapterOptions) {
    const env = validateEnv();
    this.issuer = options?.issuer ?? env.AUTH0_ISSUER;
    this.audience = options?.audience ?? env.AUTH0_AUDIENCE;
    this.jwksUri =
      options?.jwksUri ??
      env.AUTH0_JWKS_URI ??
      `${this.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
    this.db = options?.db;
    if (this.db) {
      this.onboardingService = new OnboardingService(this.db);
    }

    const isProduction = env.NODE_ENV === "production";
    const isMockEnabled = env.OIDC_MOCK_ENABLED === true;
    const isTest = env.NODE_ENV === "test";

    // Requirement 3 & 4: Dev tokens allowed ONLY when:
    // - OIDC_MOCK_ENABLED is true AND (NODE_ENV === "test" OR non-production mock environment)
    // When OIDC_MOCK_ENABLED=false, dev tokens are strictly forbidden even in test mode.
    const devTokensPermitted = !isProduction && isMockEnabled && (isTest || isMockEnabled);

    // Requirement 5: Production and development-with-Auth0 startup must fail if dev-token fallback is configured.
    if (options?.allowDevTokens === true && !devTokensPermitted) {
      if (isProduction) {
        throw new Error("FATAL: Dev-token fallback is strictly forbidden in production.");
      }
      if (!isMockEnabled) {
        throw new Error(
          "FATAL: Dev-token fallback is strictly forbidden when OIDC_MOCK_ENABLED=false.",
        );
      }
      throw new Error("FATAL: Dev-token fallback is strictly forbidden in this environment.");
    }

    if (options?.allowDevTokens !== undefined) {
      this.allowDevTokens = options.allowDevTokens && devTokensPermitted;
    } else {
      this.allowDevTokens = devTokensPermitted;
    }

    if (options?.localKeySet) {
      this.jwks = options.localKeySet;
    }
  }

  isDevTokensAllowed(): boolean {
    return this.allowDevTokens;
  }

  private getJWKS(): jose.JWTVerifyGetKey {
    if (!this.jwks) {
      this.jwks = jose.createRemoteJWKSet(new URL(this.jwksUri), {
        cacheMaxAge: 3600_000,
        cooldownDuration: 30_000,
      });
    }
    return this.jwks;
  }

  getAudience(): string {
    return this.audience;
  }

  async authenticateBearerToken(
    token: string,
    requestedTenantId?: string,
    expectedAudience?: string,
    clientIp?: string,
  ): Promise<AuthenticatedPrincipal> {
    // 1. Dev / Offline Test Token Fast Path
    if (token.startsWith("test-token:") || token === "test-token") {
      if (!this.allowDevTokens) {
        throw new DomainError("Dev tokens not allowed in this environment", "unauthorized", 401);
      }
      return await this.authenticateDevToken(token, requestedTenantId, expectedAudience);
    }

    // 2. Auth0 JWT Verification
    let payload: jose.JWTPayload;
    try {
      const keySet = this.getJWKS();
      const normalizedIssuer = this.issuer.replace(/\/+$/, "");
      const audienceToCheck = expectedAudience || this.audience;
      const normalizedAudience = audienceToCheck.replace(/\/+$/, "");
      const verified = await jose.jwtVerify(token, keySet, {
        issuer: [normalizedIssuer, `${normalizedIssuer}/`],
        audience: [normalizedAudience, `${normalizedAudience}/`],
        algorithms: ["RS256"],
      });
      payload = verified.payload;
    } catch (err: unknown) {
      const error = err as Error;
      throw new DomainError(`JWT verification failed: ${error.message}`, "invalid_jwt", 401);
    }

    // 3. Exact validation of subject and expiration
    const subject = payload.sub;
    if (!subject || typeof subject !== "string") {
      throw new DomainError("JWT missing subject (sub) claim", "invalid_jwt_subject", 401);
    }
    if (typeof payload.exp !== "number") {
      throw new DomainError("JWT missing expiration (exp) claim", "invalid_jwt", 401);
    }

    // 4. Local PostgreSQL Membership Authority Resolution (with JIT self-provisioning when enabled)
    return await this.resolveLocalMembership(subject, payload, clientIp);
  }

  private async authenticateDevToken(
    token: string,
    requestedTenantId?: string,
    expectedAudience?: string,
  ): Promise<AuthenticatedPrincipal> {
    const targetAud = (expectedAudience || this.audience).toLowerCase();
    const isMcpTarget = targetAud.endsWith("/mcp");

    if (token === "test-token") {
      const tenantId = (requestedTenantId || "01932b10-0000-7000-8000-000000000001") as TenantId;
      const role: Role = "OWNER";
      return {
        subject: "dev|default-owner",
        userId: "01932b10-0000-7000-8000-000000000002" as UserId,
        tenantId,
        roles: [role],
        roleVersion: 1,
        authTime: new Date().toISOString(),
        mfaVerified: true,
        scopes: DEFAULT_ROLE_SCOPES[role],
      };
    }

    // Format: test-token:<userId>:<tenantId>:<role>:<roleVersion>:<revoked?>:<scopes>
    const parts = token.split(":");

    // Audience isolation check for dev tokens: e.g. "aud=mcp" or "aud=rest"
    const audPart = parts.find((p) => p.startsWith("aud="));
    if (audPart) {
      const tokenAud = audPart.slice(4).toLowerCase();
      if (tokenAud === "mcp" && !isMcpTarget) {
        throw new DomainError("Audience mismatch: token intended for MCP only", "invalid_jwt", 401);
      }
      if (tokenAud === "rest" && isMcpTarget) {
        throw new DomainError(
          "Audience mismatch: token intended for REST only",
          "invalid_jwt",
          401,
        );
      }
    }
    const userId = (parts[1] || "01932b10-0000-7000-8000-000000000002") as UserId;
    const tenantId = (parts[2] ||
      requestedTenantId ||
      "01932b10-0000-7000-8000-000000000001") as TenantId;
    const role = (parts[3] || "OWNER") as Role;
    const roleVersion = parts[4] ? parseInt(parts[4], 10) : 1;
    const isRevoked = parts[5] === "revoked" || parts[5] === "true";
    const explicitScopes =
      parts.length > 6 ? (parts.slice(6).join(":").split(",") as Scope[]) : undefined;

    // Immediate rejection of revoked dev token
    if (isRevoked) {
      throw new MembershipRevokedError("Membership has been revoked");
    }

    // If DB is connected and this user exists in DB, check authoritative DB membership
    if (this.db) {
      try {
        const dbResult = await this.queryMembershipByUserId(userId, tenantId);
        if (dbResult) {
          if (dbResult.revoked_at !== null) {
            throw new MembershipRevokedError("Membership has been revoked in database");
          }
          if (dbResult.role_version !== roleVersion) {
            throw new StaleRoleVersionError(
              `Stale role version: token=${roleVersion}, db=${dbResult.role_version}`,
            );
          }
        }
      } catch (err) {
        if (err instanceof DomainError) throw err;
        // If DB table not ready or offline test mock, continue with token values
      }
    }

    return {
      subject: `dev|${userId}`,
      userId,
      tenantId,
      roles: [role],
      roleVersion,
      authTime: new Date().toISOString(),
      mfaVerified: true,
      scopes: explicitScopes ?? DEFAULT_ROLE_SCOPES[role],
    };
  }

  private async resolveLocalMembership(
    subject: string,
    payload: jose.JWTPayload,
    clientIp?: string,
  ): Promise<AuthenticatedPrincipal> {
    if (!this.db) {
      // In isolated environments without DB connection, use token claims
      const role = (payload["https://velvetai.com/role"] as Role) || "BUYER";
      const tenantId = ((payload["https://velvetai.com/tenant_id"] as string) ||
        "01932b10-0000-7000-8000-000000000001") as TenantId;
      const userId =
        (payload["https://velvetai.com/user_id"] as UserId) ||
        ("01932b10-0000-7000-8000-000000000002" as UserId);

      return {
        subject,
        userId,
        tenantId,
        roles: [role],
        roleVersion: 1,
        authTime: new Date().toISOString(),
        mfaVerified: true,
        scopes: this.extractScopes(payload, role),
      };
    }

    // 1. Look up app_user by oidc_subject (app_users is intentionally global/non-tenant-scoped)
    let user = await this.db
      .selectFrom("app_users")
      .where("oidc_subject", "=", subject)
      .select(["id"])
      .executeTakeFirst();

    if (!user) {
      // Part 1: JIT buyer provisioning check
      const env = validateEnv();
      const isSelfSignupEnabled =
        env.SELF_SIGNUP_ENABLED === true || process.env.SELF_SIGNUP_ENABLED === "true";

      const isM2MToken =
        subject.endsWith("@clients") ||
        subject.includes("@clients") ||
        payload.gty === "client-credentials";

      if (!isSelfSignupEnabled || isM2MToken) {
        throw new DomainError(
          "User has not been provisioned in local database",
          "user_not_provisioned",
          403,
        );
      }

      if (!this.onboardingService) {
        throw new DomainError("Onboarding service is unavailable", "internal_error", 500);
      }

      const provisioned = await this.onboardingService.selfProvisionBuyer({
        subject,
        clientIp,
        emailVerified: payload.email_verified === true,
      });

      user = { id: provisioned.userId };
    }

    // 2. Set transaction-local authenticated user context (app.user_id) and query memberships.
    // The self_membership_select_policy allows an authenticated local user to read only their own membership rows.
    let memberships = await withUserTransaction(this.db, user.id, async (trx) => {
      return await trx
        .selectFrom("memberships")
        .where("user_id", "=", user.id)
        .select(["id", "tenant_id", "role", "role_version", "revoked_at"])
        .execute();
    });

    if (memberships.length === 0) {
      // If user exists without membership and self-signup is enabled, provision BUYER membership
      const env = validateEnv();
      const isSelfSignupEnabled =
        env.SELF_SIGNUP_ENABLED === true || process.env.SELF_SIGNUP_ENABLED === "true";
      const isM2MToken =
        subject.endsWith("@clients") ||
        subject.includes("@clients") ||
        payload.gty === "client-credentials";

      if (isSelfSignupEnabled && !isM2MToken && this.onboardingService) {
        await this.onboardingService.selfProvisionBuyer({
          subject,
          clientIp,
          emailVerified: payload.email_verified === true,
        });

        memberships = await withUserTransaction(this.db, user.id, async (trx) => {
          return await trx
            .selectFrom("memberships")
            .where("user_id", "=", user.id)
            .select(["id", "tenant_id", "role", "role_version", "revoked_at"])
            .execute();
        });
      }

      if (memberships.length === 0) {
        throw new DomainError("No local membership found for user", "membership_not_found", 403);
      }
    }

    const activeMemberships = memberships.filter((m) => m.revoked_at === null);

    // If memberships exist but all are revoked, fail immediately with membership_revoked
    if (activeMemberships.length === 0) {
      throw new MembershipRevokedError("Membership has been revoked");
    }

    // If more than one active membership exists, require explicit future tenant-selection workflow
    if (activeMemberships.length > 1) {
      throw new DomainError(
        "Multiple active memberships found; explicit tenant selection required",
        "multiple_memberships_found",
        403,
      );
    }

    const membership = activeMemberships[0]!;

    // 4. Immediate rejection of stale role version if claim present in token
    const tokenRoleVersion =
      typeof payload["https://velvetai.com/role_version"] === "number"
        ? payload["https://velvetai.com/role_version"]
        : typeof payload.rv === "number"
          ? payload.rv
          : undefined;

    if (tokenRoleVersion !== undefined && tokenRoleVersion !== membership.role_version) {
      throw new StaleRoleVersionError(
        `Stale role version: token has ${tokenRoleVersion}, local database has ${membership.role_version}`,
      );
    }

    const role = membership.role as Role;
    const roles: Role[] = role === "JUDGE" ? ["JUDGE", "BUYER", "SCHEDULER"] : [role];
    const isHumanPrincipal = !subject.endsWith("@clients") && payload.gty !== "client-credentials";
    const baseScopes = this.extractScopes(payload, role);
    const scopes: Scope[] =
      isHumanPrincipal && role === "JUDGE"
        ? Array.from(
            new Set([
              ...baseScopes,
              ...(DEFAULT_ROLE_SCOPES.JUDGE || []).filter((s) => s.startsWith("judge:")),
            ]),
          )
        : baseScopes;

    return {
      subject,
      userId: user.id as UserId,
      tenantId: membership.tenant_id as TenantId,
      roles,
      roleVersion: membership.role_version,
      authTime: new Date().toISOString(),
      mfaVerified: true,
      scopes,
    };
  }

  private async queryMembershipByUserId(userId: string, tenantId: string) {
    if (!this.db) return undefined;
    return await this.db.transaction().execute(async (trx) => {
      await trx.executeQuery(
        sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.compile(this.db!),
      );
      return await trx
        .selectFrom("memberships")
        .where("user_id", "=", userId)
        .where("tenant_id", "=", tenantId)
        .select(["id", "role", "role_version", "revoked_at"])
        .executeTakeFirst();
    });
  }

  private extractScopes(payload: jose.JWTPayload, role: Role): Scope[] {
    const rawScope = payload.scope;
    const rawPermissions = payload.permissions;

    let claimedScopes: string[] = [];
    if (typeof rawScope === "string") {
      claimedScopes = rawScope.split(" ").filter(Boolean);
    } else if (Array.isArray(rawPermissions)) {
      claimedScopes = rawPermissions.filter((p) => typeof p === "string");
    }

    if (claimedScopes.length > 0) {
      const validScopes: Scope[] = [];
      const roleAllowed = DEFAULT_ROLE_SCOPES[role] || [];
      for (const s of claimedScopes) {
        if (roleAllowed.includes(s as Scope)) {
          validScopes.push(s as Scope);
        }
      }
      return validScopes;
    }

    return DEFAULT_ROLE_SCOPES[role] || [];
  }
}

// Global adapter instance
let globalAuthAdapter: Auth0AuthenticationAdapter | undefined;

export function getAuthAdapter(): Auth0AuthenticationAdapter {
  if (!globalAuthAdapter) {
    const env = validateEnv();
    const db = createDatabaseClient(env.DATABASE_URL);
    globalAuthAdapter = new Auth0AuthenticationAdapter({ db });
  }
  return globalAuthAdapter;
}

export function setAuthAdapter(adapter: Auth0AuthenticationAdapter): void {
  globalAuthAdapter = adapter;
}

/**
 * Fastify route authorization guard requiring specified scopes.
 */
export function requireScopes(...requiredScopes: Scope[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = request.principal;
    if (!principal) {
      const problem = createProblemDetails({
        title: "Unauthorized",
        status: 401,
        code: "unauthorized",
        requestId: request.id,
        detail: "Authentication credentials missing or invalid",
      });
      return reply.status(401).header("content-type", "application/problem+json").send(problem);
    }

    const userScopes = principal.scopes || [];
    const missing = requiredScopes.filter((s) => !userScopes.includes(s));
    if (missing.length > 0) {
      const problem = createProblemDetails({
        title: "Forbidden",
        status: 403,
        code: "insufficient_scope",
        requestId: request.id,
        detail: `Missing required scope(s): ${missing.join(", ")}`,
      });
      return reply.status(403).header("content-type", "application/problem+json").send(problem);
    }
  };
}

export function registerAuth(app: FastifyInstance): void {
  const authAdapter = getAuthAdapter();

  app.decorateRequest("principal", undefined);
  app.decorateRequest("tenantId", undefined);
  app.decorateRequest("clientId", undefined);
  app.decorate(
    "authenticateBearerToken",
    async (
      token: string,
      requestedTenantId?: TenantId,
      expectedAudience?: string,
      clientIp?: string,
    ) => {
      return authAdapter.authenticateBearerToken(
        token,
        requestedTenantId,
        expectedAudience,
        clientIp,
      );
    },
  );

  // RFC 9728: OAuth 2.0 Protected Resource Metadata (REST API audience)
  app.get("/.well-known/oauth-protected-resource", async (_request, reply) => {
    const currentEnv = validateEnv();
    return reply
      .header("content-type", "application/json")
      .header("cache-control", "public, max-age=3600")
      .send({
        resource: currentEnv.AUTH0_AUDIENCE,
        authorization_servers: [currentEnv.AUTH0_ISSUER],
        bearer_methods_supported: ["header"],
        scopes_supported: [
          "booking:read",
          "booking:quote",
          "booking:prepare",
          "booking:commit",
          "booking:cancel",
          "merchant:schedule",
          "merchant:refund",
        ],
      });
  });

  // RFC 9728: OAuth 2.0 Protected Resource Metadata (MCP path-specific audience per F2)
  app.get("/.well-known/oauth-protected-resource/mcp", async (request, reply) => {
    const currentEnv = validateEnv();
    const hostHeader = (request.headers.host as string) || "localhost:3000";
    const resourceUrl = currentEnv.MCP_RESOURCE_URL || `http://${hostHeader}/mcp`;
    return reply
      .header("content-type", "application/json")
      .header("cache-control", "public, max-age=3600")
      .send({
        resource: resourceUrl,
        authorization_servers: [currentEnv.AUTH0_ISSUER],
        bearer_methods_supported: ["header"],
        scopes_supported: ["booking:read", "booking:quote", "booking:prepare", "booking:commit"],
      });
  });

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip public paths
    if (
      request.url === "/" ||
      request.url.startsWith("/health") ||
      request.url === "/v1/system/spec" ||
      request.url === "/.well-known/oauth-protected-resource" ||
      request.url.startsWith("/.well-known/oauth-protected-resource") ||
      request.url === "/v1/ai/status" ||
      request.url === "/mcp" ||
      request.url.startsWith("/mcp?") ||
      (request.method === "GET" && request.url.startsWith("/v1/booking-approvals/"))
    ) {
      return;
    }

    request.clientId =
      typeof request.headers["x-client-id"] === "string"
        ? request.headers["x-client-id"]
        : "default-client";

    const clientIp = getClientIp(request);

    const isPublicReadRoute =
      request.method === "GET" &&
      (request.url === "/v1/services" ||
        request.url.startsWith("/v1/services/") ||
        request.url.startsWith("/v1/services?") ||
        request.url === "/v1/availability" ||
        request.url.startsWith("/v1/availability?"));

    const authHeader = request.headers.authorization;
    let token: string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }

    if (!token) {
      // Public read routes allowed without token
      if (isPublicReadRoute) {
        return;
      }

      // In explicit test/mock environment, allow tests without headers to use default dev token
      if (authAdapter.isDevTokensAllowed()) {
        token =
          "test-token:01932b10-0000-7000-8000-000000000002:01932b10-0000-7000-8000-000000000001:OWNER";
      } else {
        const problem = createProblemDetails({
          title: "Unauthorized",
          status: 401,
          code: "unauthorized",
          requestId: request.id,
          detail: "Missing or invalid Authorization header. Bearer token required.",
        });
        return reply.status(401).header("content-type", "application/problem+json").send(problem);
      }
    }

    try {
      // Authoritative principal resolution derives tenant_id strictly from database membership
      const principal = await authAdapter.authenticateBearerToken(
        token,
        undefined,
        undefined,
        clientIp,
      );
      request.principal = principal;
      request.tenantId = principal.tenantId;
    } catch (err: unknown) {
      // 1. Expected domain authentication errors (401, 403)
      if (err instanceof DomainError) {
        const status = err.status;
        const problem = createProblemDetails({
          title: status === 403 ? "Forbidden" : status === 401 ? "Unauthorized" : "Error",
          status,
          code: err.code,
          requestId: request.id,
          detail: err.message,
        });
        request.log.warn(
          { code: err.code, status, detail: err.message, requestId: request.id },
          "Auth preHandler rejected request",
        );
        return reply
          .status(status)
          .header("content-type", "application/problem+json")
          .send(problem);
      }

      // 2. Unexpected database, policy, or configuration errors
      // NEVER leak SQLSTATE 42501, table names, SQL or internal database error messages to clients
      request.log.error(
        { err, requestId: request.id },
        "Internal authentication or database error during principal resolution",
      );

      const problem = createProblemDetails({
        title: "Internal Server Error",
        status: 500,
        code: "internal_error",
        requestId: request.id,
        detail: "An internal database or authentication error occurred",
      });
      return reply.status(500).header("content-type", "application/problem+json").send(problem);
    }
  });
}
