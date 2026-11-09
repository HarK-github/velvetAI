import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    env: {
      VITE_AUTH0_DOMAIN: "dev-example.us.auth0.com",
      VITE_AUTH0_CLIENT_ID: "placeholder_auth0_spa_client_id",
      VITE_AUTH0_AUDIENCE: "https://velvetai.example/api",
      VITE_API_BASE_URL: "http://localhost:3000",
    },
  },
});
