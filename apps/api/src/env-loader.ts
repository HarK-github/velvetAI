import { loadRootEnv } from "@velvetai/observability";
import { getTestDatabaseUrl } from "@velvetai/db";

loadRootEnv({ isTest: process.env.NODE_ENV === "test" });

if (process.env.NODE_ENV === "test") {
  const apiTestDbUrl = getTestDatabaseUrl("api");
  process.env.DATABASE_URL = apiTestDbUrl;
  process.env.TEST_DATABASE_URL = apiTestDbUrl;
}
