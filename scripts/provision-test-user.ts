import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, sql, type Kysely, type Database } from "../packages/db/src/index.ts";
import { loadRootEnv, extractDatabaseName } from "./load-env.js";

export const SYNTHETIC_DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";
export const ALLOWED_ROLE = "BUYER" as const;

export interface ProvisionResult {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: typeof ALLOWED_ROLE;
  isNewUser: boolean;
  isNewMembership: boolean;
}

export function redactId(id: string): string {
  if (!id || id.length <= 8) return "***";
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

export async function provisionTestUser(
  rawSubject: string,
  options?: {
    databaseUrl?: string;
    db?: Kysely<Database>;
    nodeEnv?: string;
  },
): Promise<ProvisionResult> {
  const currentEnv = options?.nodeEnv ?? process.env.NODE_ENV;
  if (currentEnv === "production") {
    throw new Error(
      "REFUSED: auth:provision-test-user cannot be run in production environment (NODE_ENV=production).",
    );
  }

  const subject = rawSubject.trim();
  if (!subject) {
    throw new Error("Invalid subject: Auth0 OIDC subject cannot be empty.");
  }

  // Always load root environment
  loadRootEnv();

  const databaseUrl = options?.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is required to provision test user but was not found in environment, .env.local, or .env.",
    );
  }

  const dbName = extractDatabaseName(databaseUrl);
  console.log(`Target database: ${dbName}`);

  const db = options?.db ?? createDatabaseClient(databaseUrl);
  let shouldDestroy = !options?.db;

  try {
    return await db.transaction().execute(async (trx) => {
      // Set transaction-local tenant context for RLS policy on tenant-isolated tables
      await sql`SELECT set_config('app.tenant_id', ${SYNTHETIC_DEV_TENANT_ID}, true)`.execute(trx);

      // 1. Ensure the synthetic development tenant exists
      const tenant = await trx
        .selectFrom("tenants")
        .where("id", "=", SYNTHETIC_DEV_TENANT_ID)
        .select(["id", "name"])
        .executeTakeFirst();

      if (!tenant) {
        await trx
          .insertInto("tenants")
          .values({
            id: SYNTHETIC_DEV_TENANT_ID,
            name: "Velvet Flagship Manhattan",
            default_currency: "USD",
            status: "ACTIVE",
          })
          .execute();
      }

      // 2. Check if an app_user for this oidc_subject already exists
      let isNewUser = false;
      let existingUser = await trx
        .selectFrom("app_users")
        .where("oidc_subject", "=", subject)
        .select(["id", "oidc_subject"])
        .executeTakeFirst();

      let userId: string;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        isNewUser = true;
        userId = crypto.randomUUID();
        await trx
          .insertInto("app_users")
          .values({
            id: userId,
            oidc_subject: subject,
            email_ciphertext: "dev-test-buyer@velvetai.example",
          })
          .execute();
      }

      // 3. Check for existing membership in the synthetic development tenant
      let isNewMembership = false;
      const existingMembership = await trx
        .selectFrom("memberships")
        .where("user_id", "=", userId)
        .where("tenant_id", "=", SYNTHETIC_DEV_TENANT_ID)
        .select(["id", "role", "role_version", "revoked_at"])
        .executeTakeFirst();

      let membershipId: string;
      if (existingMembership) {
        membershipId = existingMembership.id;
        // Enforce strictly BUYER role, unrevoked state, and current role_version
        await trx
          .updateTable("memberships")
          .set({
            role: ALLOWED_ROLE,
            role_version: 1,
            revoked_at: null,
          })
          .where("id", "=", membershipId)
          .execute();
      } else {
        isNewMembership = true;
        membershipId = crypto.randomUUID();
        await trx
          .insertInto("memberships")
          .values({
            id: membershipId,
            tenant_id: SYNTHETIC_DEV_TENANT_ID,
            user_id: userId,
            role: ALLOWED_ROLE,
            role_version: 1,
            revoked_at: null,
          })
          .execute();
      }

      return {
        userId,
        tenantId: SYNTHETIC_DEV_TENANT_ID,
        membershipId,
        role: ALLOWED_ROLE,
        isNewUser,
        isNewMembership,
      };
    });
  } finally {
    if (shouldDestroy) {
      await db.destroy();
    }
  }
}

/**
 * Prompts user for input without echoing characters to the terminal.
 * Supports both interactive TTY and piped/non-interactive streams.
 */
export function promptSubjectHidden(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    // Non-interactive stream (pipe/test runner)
    if (!stdin.isTTY) {
      const rl = readline.createInterface({
        input: stdin,
        output: process.stderr,
        terminal: false,
      });
      rl.question(promptText, (ans) => {
        rl.close();
        resolve(ans.trim());
      });
      return;
    }

    // Interactive TTY: disable echo completely
    stdout.write(promptText);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";
    const onData = (char: string) => {
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004": // Ctrl+D / EOF
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          resolve(input.trim());
          break;
        case "\u0003": // Ctrl+C
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          process.exit(130);
          break;
        case "\u007f": // Backspace
        case "\b":
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
          break;
        default:
          input += char;
          break;
      }
    };

    stdin.on("data", onData);
  });
}

// CLI entry point
const isMain =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("provision-test-user.ts"));

if (isMain) {
  (async () => {
    try {
      if (process.env.NODE_ENV === "production") {
        console.error(
          "FATAL: auth:provision-test-user cannot be run in production environment (NODE_ENV=production).",
        );
        process.exit(1);
      }

      console.log("=============================================================");
      console.log("  velvetAI Local Development User Provisioning CLI");
      console.log("  Assigns strictly BUYER role in synthetic development tenant");
      console.log("=============================================================");

      const subject = await promptSubjectHidden("Enter Auth0 subject ('sub') [input hidden]: ");
      if (!subject) {
        console.error("FATAL: Auth0 subject cannot be empty.");
        process.exit(1);
      }

      const result = await provisionTestUser(subject);

      console.log("\n[PROVISION SUCCESS] Test user mapping complete:");
      console.log(`  User ID:       ${redactId(result.userId)}`);
      console.log(`  Tenant ID:     ${redactId(result.tenantId)}`);
      console.log(`  Membership ID: ${redactId(result.membershipId)}`);
      console.log(`  Assigned Role: ${result.role} (BUYER authority: PostgreSQL)`);
      console.log(
        `  Action:        ${result.isNewUser ? "Created new user" : "Matched existing user"}, ${
          result.isNewMembership ? "created membership" : "confirmed active membership"
        }`,
      );
      console.log("\nYou may now refresh the velvetAI web application in your browser.");
      console.log("The first protected request will now return HTTP 200 OK.");
    } catch (err) {
      console.error(
        "\n[PROVISION FAILED]:",
        err instanceof Error ? err.message : "Unexpected error during provisioning.",
      );
      process.exit(1);
    }
  })();
}
