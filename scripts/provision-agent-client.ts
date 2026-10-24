import fs from "node:fs";
import path from "node:path";
import { provisionTestUser, redactId, SYNTHETIC_DEV_TENANT_ID } from "./provision-test-user.js";

function loadEnvFiles(): void {
  const rootDir = process.cwd();
  for (const envFile of [".env", ".env.local"]) {
    const fullPath = path.join(rootDir, envFile);
    if (fs.existsSync(fullPath) && typeof process.loadEnvFile === "function") {
      try {
        process.loadEnvFile(fullPath);
      } catch {
        // ignore
      }
    }
  }
}

export async function provisionAgentClient(clientId?: string) {
  loadEnvFiles();
  const effectiveClientId = clientId || process.env.AUTH0_AGENT_CLIENT_ID;
  if (!effectiveClientId) {
    throw new Error(
      "AUTH0_AGENT_CLIENT_ID not found in environment or arguments. Please specify clientId.",
    );
  }

  const subject = effectiveClientId.endsWith("@clients")
    ? effectiveClientId
    : `${effectiveClientId}@clients`;

  console.log(
    `[auth:provision-agent-client] Provisioning M2M client subject: ${redactId(subject)}`,
  );
  console.log(`[auth:provision-agent-client] Target Tenant: ${SYNTHETIC_DEV_TENANT_ID}`);

  const result = await provisionTestUser(subject);

  console.log("[auth:provision-agent-client] SUCCESS: Agent client identity provisioned.");
  console.log(`  User ID:        ${redactId(result.userId)} (isNew: ${result.isNewUser})`);
  console.log(`  Tenant ID:      ${redactId(result.tenantId)}`);
  console.log(`  Membership ID:  ${redactId(result.membershipId)} (role: ${result.role})`);
  return result;
}

if (process.argv[1]?.endsWith("provision-agent-client.ts")) {
  const argClientId = process.argv[2];
  provisionAgentClient(argClientId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[auth:provision-agent-client] ERROR:", err.message);
      process.exit(1);
    });
}
