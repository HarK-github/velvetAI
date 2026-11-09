import crypto from "node:crypto";
import readline from "node:readline";
import { createDatabaseClient, sql, type Kysely, type Database } from "../packages/db/src/index.ts";
import { JUDGE_TENANT_ID, DEV_TENANT_ID } from "../packages/domain/src/judge.ts";
import { loadRootEnv, extractDatabaseName } from "./load-env.js";

export { JUDGE_TENANT_ID, DEV_TENANT_ID };
export const ALLOWED_JUDGE_ROLE = "JUDGE" as const;

export interface ProvisionJudgeUserResult {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: typeof ALLOWED_JUDGE_ROLE;
  isNewUser: boolean;
  isNewMembership: boolean;
}

export function redactId(id: string): string {
  if (!id || id.length <= 8) return "***";
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

export function validateJudgeSubject(rawSubject: string): string {
  const subject = typeof rawSubject === "string" ? rawSubject.trim() : "";
  if (!subject) {
    throw new Error("Invalid subject: Auth0 OIDC subject cannot be empty.");
  }

  // Reject obvious placeholders
  if (/(paste|your_|<|>|example)/i.test(subject)) {
    throw new Error(
      `Invalid subject: Subject "${subject}" contains a placeholder pattern (PASTE, YOUR_, <, >, example). Please provide the real Auth0 or Google user ID.`,
    );
  }

  // Require format auth0|<hex/alphanumeric 16+> or google-oauth2|<digits>
  const isAuth0 = /^auth0\|[a-zA-Z0-9]{16,}$/.test(subject);
  const isGoogle = /^google-oauth2\|\d+$/.test(subject);

  if (!isAuth0 && !isGoogle) {
    throw new Error(
      `Invalid subject format: Expected "auth0|<hex/alphanumeric 16+>" or "google-oauth2|<digits>", got "${subject}".`,
    );
  }

  return subject;
}

export async function provisionJudgeUser(
  rawSubject: string,
  options?: {
    databaseUrl?: string;
    db?: Kysely<Database>;
    nodeEnv?: string;
  },
): Promise<ProvisionJudgeUserResult> {
  const currentEnv = options?.nodeEnv ?? process.env.NODE_ENV;
  if (currentEnv === "production" && process.env.ALLOW_HOSTED_SEED !== "1") {
    throw new Error(
      "REFUSED: auth:provision-judge-user cannot be run in production environment (NODE_ENV=production). Set ALLOW_HOSTED_SEED=1 to provision hosted demo tenant.",
    );
  }

  const subject = validateJudgeSubject(rawSubject);

  // Always load root environment
  loadRootEnv();

  const databaseUrl = options?.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is required to provision judge user but was not found in environment, .env.local, or .env.",
    );
  }

  const parsed = new URL(databaseUrl);
  const host = parsed.hostname.toLowerCase();
  const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocalHost && process.env.ALLOW_HOSTED_SEED !== "1") {
    throw new Error(
      `REFUSED: Database host "${host}" is not localhost. To provision against a hosted demo database, set ALLOW_HOSTED_SEED=1.`,
    );
  }

  const dbName = extractDatabaseName(databaseUrl);
  console.log(`Target database: ${dbName}`);

  const db = options?.db ?? createDatabaseClient(databaseUrl);
  const shouldDestroy = !options?.db;

  try {
    return await db.transaction().execute(async (trx) => {
      // Set transaction-local tenant context for RLS policy
      await sql`SELECT set_config('app.tenant_id', ${JUDGE_TENANT_ID}, true)`.execute(trx);

      // 1. Check if an app_user for this oidc_subject already exists
      let isNewUser = false;
      const existingUser = await trx
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
            email_ciphertext: "judge@velvetai.example",
          })
          .execute();
      }

      // 2. Check for existing membership in the judge tenant
      let isNewMembership = false;
      const existingMembership = await trx
        .selectFrom("memberships")
        .where("user_id", "=", userId)
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .select(["id", "role", "role_version", "revoked_at"])
        .executeTakeFirst();

      let membershipId: string;
      if (existingMembership) {
        membershipId = existingMembership.id;
        // Enforce strictly JUDGE role, unrevoked state, and current role_version
        await trx
          .updateTable("memberships")
          .set({
            role: ALLOWED_JUDGE_ROLE,
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
            tenant_id: JUDGE_TENANT_ID,
            user_id: userId,
            role: ALLOWED_JUDGE_ROLE,
            role_version: 1,
            revoked_at: null,
          })
          .execute();
      }

      // CRITICAL: NEVER add a membership in the development tenant
      const devMembership = await trx
        .selectFrom("memberships")
        .where("user_id", "=", userId)
        .where("tenant_id", "=", DEV_TENANT_ID)
        .select(["id"])
        .executeTakeFirst();

      if (devMembership) {
        // Remove accidental dev tenant membership to keep strict tenant isolation
        await trx.deleteFrom("memberships").where("id", "=", devMembership.id).execute();
      }

      return {
        userId,
        tenantId: JUDGE_TENANT_ID,
        membershipId,
        role: ALLOWED_JUDGE_ROLE,
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

export function promptSubject(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function parseCliArgs(argv: string[]): { sub?: string } {
  const result: { sub?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sub" && i + 1 < argv.length) {
      result.sub = argv[i + 1];
      i++;
    } else if (arg?.startsWith("--sub=")) {
      result.sub = arg.slice(6);
    }
  }
  return result;
}

// Auto-run when invoked directly via CLI
if (process.argv[1]?.endsWith("provision-judge-user.ts")) {
  (async () => {
    try {
      const args = parseCliArgs(process.argv.slice(2));
      let subject = args.sub;

      if (!subject) {
        console.log(
          'Usage: pnpm auth:provision-judge-user --sub "auth0|<hex/alphanumeric 16+>" or "google-oauth2|<digits>"\n' +
            'Example: pnpm auth:provision-judge-user --sub "auth0|672e811f582e2df5c328db14"\n',
        );
        subject = await promptSubject("Enter Auth0 OIDC Subject (sub): ");
      }

      console.log("\n[JUDGE USER PROVISIONING] Initiating...");
      const res = await provisionJudgeUser(subject);

      console.log("\n=======================================================");
      console.log("  Judge User Successfully Provisioned into Judge Tenant");
      console.log("=======================================================");
      console.log(`User ID:        ${res.userId}`);
      console.log(`Tenant ID:      ${res.tenantId} (Judge Tenant)`);
      console.log(`Membership ID:  ${res.membershipId}`);
      console.log(`Role:           ${res.role} (BUYER + MERCHANT + JUDGE scopes)`);
      console.log(
        `User status:    ${res.isNewUser ? "Created new user" : "Updated existing user"}`,
      );
      console.log(`Membership:     ${res.isNewMembership ? "Created new" : "Refreshed existing"}`);
      console.log("=======================================================\n");
    } catch (err: unknown) {
      console.error("\n[ERROR] Provisioning failed:", (err as Error).message || err);
      process.exit(1);
    }
  })();
}
