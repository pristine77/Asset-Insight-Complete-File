import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

let app: Awaited<typeof import("../src/app.js")>["default"];

beforeAll(async () => {
  ({ default: app } = await import("../src/app.js"));
});

describe("Express edge contract", () => {
  it("mounts capture metadata owner and administrator routes behind authentication", async () => {
    const captureId = "a7a45591-2a9a-4a60-9e50-7844ab603ada";
    expect((await request(app).put(`/api/capture-inventory/${captureId}`).send({})).status).toBe(401);
    expect((await request(app).get(`/api/capture-inventory/${captureId}`)).status).toBe(401);
    expect((await request(app).get("/api/admin/capture-inventory")).status).toBe(401);
    expect((await request(app).get("/api/admin/capture-inventory/users")).status).toBe(401);
  });
  it("serves the shallow health response without caching", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      ok: true,
      service: "asset-insight-api",
    });
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("answers preflight requests for an established browser origin", async () => {
    const response = await request(app)
      .options("/api/health")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "GET");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000"
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("returns a controlled policy response for a disallowed browser origin", async () => {
    const response = await request(app)
      .options("/api/health")
      .set("Origin", "https://untrusted.example")
      .set("Access-Control-Request-Method", "GET");

    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      error: {
        code: "cors_origin_denied",
        message: "Origin is not allowed.",
      },
    });
  });

  it("retains Express's default not-found behavior", async () => {
    const response = await request(app).get("/api/__missing-route__");
    expect(response.status).toBe(404);
  });
});
