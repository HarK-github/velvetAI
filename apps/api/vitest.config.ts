import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      TEST_PACKAGE_NAME: "api",
      OIDC_MOCK_ENABLED: "true",
      AI_PROVIDER: "fake",
    },
  },
});
