import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const rootDir = fileURLToPath(new URL("../../", import.meta.url));
  const env = loadEnv(mode, rootDir, "");

  const webPort = Number(process.env.WEB_PORT || env.WEB_PORT || 5173);
  const apiBaseUrl =
    process.env.VITE_API_BASE_URL ||
    env.VITE_API_BASE_URL ||
    process.env.API_BASE_URL ||
    env.API_BASE_URL ||
    "http://localhost:3000";

  return {
    envDir: rootDir,
    plugins: [react()],
    define: {
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(apiBaseUrl),
    },
    server: {
      port: webPort,
      strictPort: true,
      host: "0.0.0.0",
    },
  };
});
