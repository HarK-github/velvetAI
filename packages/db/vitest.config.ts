import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      TEST_PACKAGE_NAME: "db",
    },
  },
});
