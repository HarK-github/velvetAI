import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      TEST_PACKAGE_NAME: "abuse-lab",
    },
  },
});
