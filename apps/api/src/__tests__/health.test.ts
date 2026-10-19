import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";

describe("API Health Endpoints", () => {
  const app = buildApp();

  it("GET /health/live returns 200 OK with timestamp", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  it("GET /health/ready returns 200 ready", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ready");
    expect(body.dependencies).toBeDefined();
  });
});
