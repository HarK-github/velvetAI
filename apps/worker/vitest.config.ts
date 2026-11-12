import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      TEST_PACKAGE_NAME: "worker",
    },
  },
});
