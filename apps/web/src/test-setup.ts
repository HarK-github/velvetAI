if (typeof (globalThis as any).Iterator === "undefined") {
  (globalThis as any).Iterator = {
    from(iterable: any) {
      return iterable;
    },
  };
}

const proc = (globalThis as any).process;
if (typeof proc !== "undefined" && proc.env) {
  proc.env.VITE_AUTH0_DOMAIN = proc.env.VITE_AUTH0_DOMAIN || "dev-example.us.auth0.com";
  proc.env.VITE_AUTH0_CLIENT_ID = proc.env.VITE_AUTH0_CLIENT_ID || "placeholder_auth0_spa_client_id";
  proc.env.VITE_AUTH0_AUDIENCE = proc.env.VITE_AUTH0_AUDIENCE || "https://velvetai.example/api";
  proc.env.VITE_API_BASE_URL = proc.env.VITE_API_BASE_URL || "http://localhost:3000";
}
