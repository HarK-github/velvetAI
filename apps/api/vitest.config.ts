import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      OIDC_MOCK_ENABLED: "true",
      AI_PROVIDER: "fake",
    },
  },
});
