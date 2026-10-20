import { FastifyInstance, FastifyRequest } from "fastify";
import {
  AuthenticatedPrincipal,
  AuthenticationPort,
} from "@velvetai/application";
import {
  TenantId,
  UserId,
  Role,
  createProblemDetails,
} from "@velvetai/contracts";

declare module "fastify" {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
    tenantId?: TenantId;
  }
}

/**
 * Isolated development & test authentication adapter.
 * Parses bearer tokens or dev headers to authenticate principal and memberships.
 */
export class DevAuthenticationAdapter implements AuthenticationPort {
  async authenticateBearerToken(token: string): Promise<AuthenticatedPrincipal> {
    if (token.startsWith("test-token:")) {
      const parts = token.split(":");
      const userId = (parts[1] || "01932b10-0000-7000-8000-000000000002") as UserId;
      const tenantId = (parts[2] || "01932b10-0000-7000-8000-000000000001") as TenantId;
      const role = (parts[3] || "OWNER") as Role;

      return {
        subject: `dev|${userId}`,
        userId,
        tenantId,
        roles: [role],
        roleVersion: 1,
        authTime: new Date().toISOString(),
        mfaVerified: true,
      };
    }

    return {
      subject: "dev|default-owner",
      userId: "01932b10-0000-7000-8000-000000000002" as UserId,
      tenantId: "01932b10-0000-7000-8000-000000000001" as TenantId,
      roles: ["OWNER"],
      roleVersion: 1,
      authTime: new Date().toISOString(),
      mfaVerified: true,
    };
  }
}

export function registerAuth(app: FastifyInstance): void {
  const authAdapter = new DevAuthenticationAdapter();

  app.decorateRequest("principal", undefined);
  app.decorateRequest("tenantId", undefined);

  app.addHook("preHandler", async (request: FastifyRequest, reply) => {
    // Skip public paths
    if (
      request.url.startsWith("/health") ||
      request.url === "/v1/system/spec"
    ) {
      return;
    }

    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "test-token:01932b10-0000-7000-8000-000000000002:01932b10-0000-7000-8000-000000000001:OWNER";

    try {
      const principal = await authAdapter.authenticateBearerToken(token);
      request.principal = principal;
      request.tenantId = principal.tenantId;
    } catch {
      const problem = createProblemDetails({
        title: "Unauthorized",
        status: 401,
        code: "unauthorized",
        requestId: request.id,
        detail: "Invalid or expired authentication credentials",
      });
      return reply
        .status(401)
        .header("content-type", "application/problem+json")
        .send(problem);
    }
  });
}
