import { Kysely } from "kysely";
import crypto from "node:crypto";
import { Database } from "@velvetai/db";
import { DomainError, MembershipRevokedError, Role } from "@velvetai/contracts";
import { JUDGE_TENANT_ID, DEV_TENANT_ID } from "@velvetai/domain";

export interface SelfProvisionUserInput {
  subject: string;
  clientIp?: string;
  emailVerified?: boolean;
}

export interface SelfProvisionResult {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: Role;
  roleVersion: number;
}

// In-memory sliding windows for rate limiting JIT creations:
// Max 30 new users per hour per IP; 500 per day globally.
const ipJitCreationWindows = new Map<string, number[]>();
const globalJitCreationWindow: number[] = [];

export function resetJitRateLimits(): void {
  ipJitCreationWindows.clear();
  globalJitCreationWindow.length = 0;
}

export class OnboardingService {
  constructor(private readonly db: Kysely<Database>) {}

  async selfProvisionBuyer(input: SelfProvisionUserInput): Promise<SelfProvisionResult> {
    const subject = input.subject?.trim();
    if (!subject) {
      throw new DomainError(
        "OIDC subject is required for self-provisioning",
        "invalid_subject",
        400,
      );
    }

    // Rule 1: Never M2M @clients tokens
    if (subject.endsWith("@clients") || subject.includes("@clients")) {
      throw new DomainError(
        "User has not been provisioned in local database",
        "user_not_provisioned",
        403,
      );
    }

    const clientIp = input.clientIp || "127.0.0.1";
    const now = Date.now();

    // 1. Check if user already exists
    const existingUser = await this.db
      .selectFrom("app_users")
      .where("oidc_subject", "=", subject)
      .select(["id"])
      .executeTakeFirst();

    // If new user, enforce rate limits: 30/hr per IP, 500/day globally
    if (!existingUser) {
      const oneHourAgo = now - 3600_000;
      const oneDayAgo = now - 86400_000;

      // Clean global window
      while (globalJitCreationWindow.length > 0 && globalJitCreationWindow[0]! < oneDayAgo) {
        globalJitCreationWindow.shift();
      }
      if (globalJitCreationWindow.length >= 500) {
        throw new DomainError(
          "Too many accounts created recently. Please try again later.",
          "self_signup_rate_limited",
          429,
        );
      }

      // Clean IP window
      const ipWindow = (ipJitCreationWindows.get(clientIp) || []).filter((ts) => ts >= oneHourAgo);
      if (ipWindow.length >= 30) {
        throw new DomainError(
          "Too many accounts created recently. Please try again later.",
          "self_signup_rate_limited",
          429,
        );
      }
    }

    // 2. Determine target tenant (Rule 2 & 4: SELF_SIGNUP_TENANT_ID, default JUDGE_TENANT_ID)
    const preferredTenantId =
      process.env.SELF_SIGNUP_TENANT_ID || process.env.PUBLIC_DEMO_TENANT_ID || JUDGE_TENANT_ID;

    // Check if target tenant exists in DB; if not, fall back to DEV_TENANT_ID
    const targetTenantExists = await this.db
      .selectFrom("tenants")
      .where("id", "=", preferredTenantId)
      .select(["id"])
      .executeTakeFirst();

    let targetTenantId = preferredTenantId;
    if (!targetTenantExists) {
      console.warn(
        `[OnboardingService] Target tenant ${preferredTenantId} does not exist in database; falling back to development tenant ${DEV_TENANT_ID}`,
      );
      targetTenantId = DEV_TENANT_ID;
    }

    // 3. Transactional, concurrent-safe creation
    const result = await this.db.transaction().execute(async (trx) => {
      // Upsert app_users
      const userId = crypto.randomUUID();
      await trx
        .insertInto("app_users")
        .values({
          id: userId,
          oidc_subject: subject,
          email_ciphertext: "self-provisioned@velvetai.example",
        })
        .onConflict((oc) => oc.column("oidc_subject").doNothing())
        .execute();

      const user = await trx
        .selectFrom("app_users")
        .where("oidc_subject", "=", subject)
        .select(["id"])
        .executeTakeFirstOrThrow();

      // Check existing membership in target tenant
      const existingMembership = await trx
        .selectFrom("memberships")
        .where("user_id", "=", user.id)
        .where("tenant_id", "=", targetTenantId)
        .select(["id", "role", "role_version", "revoked_at"])
        .executeTakeFirst();

      if (existingMembership) {
        // Rule 7: Revoked membership is not re-created or un-revoked by JIT
        if (existingMembership.revoked_at !== null) {
          throw new MembershipRevokedError("Membership has been revoked");
        }
        return {
          userId: user.id,
          tenantId: targetTenantId,
          membershipId: existingMembership.id,
          role: existingMembership.role as Role,
          roleVersion: existingMembership.role_version,
          isNew: false,
        };
      }

      // Rule 2 & 4: Insert BUYER membership strictly (never MERCHANT/OWNER/JUDGE)
      const membershipId = crypto.randomUUID();
      await trx
        .insertInto("memberships")
        .values({
          id: membershipId,
          tenant_id: targetTenantId,
          user_id: user.id,
          role: "BUYER",
          role_version: 1,
          revoked_at: null,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .execute();

      const membership = await trx
        .selectFrom("memberships")
        .where("user_id", "=", user.id)
        .where("tenant_id", "=", targetTenantId)
        .select(["id", "role", "role_version", "revoked_at"])
        .executeTakeFirstOrThrow();

      if (membership.revoked_at !== null) {
        throw new MembershipRevokedError("Membership has been revoked");
      }

      // Rule 2 & 6: Record audit event user.self_provisioned with email_verified status
      await trx
        .insertInto("audit_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: targetTenantId,
          actor_id: user.id,
          actor_type: "USER",
          action: "user.self_provisioned",
          resource_type: "app_users",
          resource_id: user.id,
          metadata_redacted: {
            email_verified: input.emailVerified ?? false,
            sub: subject,
          },
          occurred_at: new Date(),
        })
        .execute();

      return {
        userId: user.id,
        tenantId: targetTenantId,
        membershipId: membership.id,
        role: membership.role as Role,
        roleVersion: membership.role_version,
        isNew: true,
      };
    });

    // If new user was created, record in rate limit windows
    if (result.isNew) {
      globalJitCreationWindow.push(now);
      const ipWindow = ipJitCreationWindows.get(clientIp) || [];
      ipWindow.push(now);
      ipJitCreationWindows.set(clientIp, ipWindow);
    }

    return {
      userId: result.userId,
      tenantId: result.tenantId,
      membershipId: result.membershipId,
      role: result.role,
      roleVersion: result.roleVersion,
    };
  }
}
