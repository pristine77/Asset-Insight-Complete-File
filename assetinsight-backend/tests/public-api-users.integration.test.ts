import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let ApiKey: typeof import("../src/models/apiKey.model.js")["default"];
let createApiKey: typeof import("../src/service/apiKeyService.js")["createApiKey"];
let rawApiKey: string;

async function createUser(input: {
  email: string;
  username?: string;
  companyName?: string;
  role?: "user" | "admin" | "superadmin";
  isVerified?: boolean;
  isBlocked?: boolean;
}) {
  return User.create({
    email: input.email,
    username: input.username || input.email.split("@")[0],
    companyName: input.companyName,
    password: "Password123!",
    authProvider: "email",
    role: input.role || "user",
    isVerified: input.isVerified ?? true,
    isBlocked: input.isBlocked ?? false,
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: ApiKey } = await import("../src/models/apiKey.model.js"));
  ({ createApiKey } = await import("../src/service/apiKeyService.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  const owner = await createUser({
    email: "api-owner@example.test",
    username: "API Owner",
    role: "superadmin",
  });
  ({ rawKey: rawApiKey } = await createApiKey({
    name: "Auctioneer user directory",
    createdBy: String(owner._id),
  }));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("public API assignable users", () => {
  it("requires a valid, active API key", async () => {
    const missing = await request(app).get("/api/v1/users");
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({
      error: { code: "missing_api_key", message: "Missing API key" },
    });

    const invalid = await request(app)
      .get("/api/v1/users")
      .set("X-API-Key", "not-a-valid-key");
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe("invalid_api_key");

    await ApiKey.updateOne({}, { $set: { revokedAt: new Date() } });
    const revoked = await request(app)
      .get("/api/v1/users")
      .set("X-API-Key", rawApiKey);
    expect(revoked.status).toBe(403);
    expect(revoked.body.error.code).toBe("revoked_api_key");
  });

  it("returns only verified, unblocked report users with safe fields", async () => {
    const alpha = await createUser({
      email: "alpha@example.test",
      username: "Alpha User",
      companyName: "Alpha Co",
    });
    const beta = await createUser({
      email: "beta@example.test",
      username: "Beta User",
    });
    await createUser({
      email: "unverified@example.test",
      username: "Unverified",
      isVerified: false,
    });
    await createUser({
      email: "blocked@example.test",
      username: "Blocked",
      isBlocked: true,
    });
    await createUser({
      email: "admin@example.test",
      username: "Admin",
      role: "admin",
    });

    const response = await request(app)
      .get("/api/v1/users?limit=100")
      .set("X-API-Key", rawApiKey);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 100,
      total: 2,
      totalPages: 1,
    });
    expect(response.body.data.map((item: any) => item._id)).toEqual([
      String(alpha._id),
      String(beta._id),
    ]);
    expect(response.body.data[0]).toEqual({
      _id: String(alpha._id),
      displayName: "Alpha User",
      username: "Alpha User",
      email: "alpha@example.test",
      companyName: "Alpha Co",
      role: "user",
      updatedAt: expect.any(String),
    });
    expect(Object.keys(response.body.data[0]).sort()).toEqual(
      [
        "_id",
        "companyName",
        "displayName",
        "email",
        "role",
        "updatedAt",
        "username",
      ].sort()
    );
  });

  it("supports search and pagination while retaining deterministic totals", async () => {
    await createUser({
      email: "charlie@example.test",
      username: "Charlie",
      companyName: "Prairie Appraisals",
    });
    await createUser({
      email: "delta@example.test",
      username: "Delta",
      companyName: "Prairie Appraisals",
    });
    await createUser({
      email: "echo@example.test",
      username: "Echo",
      companyName: "Other Company",
    });

    const response = await request(app)
      .get("/api/v1/users?q=prairie&page=2&limit=1")
      .set("Authorization", `Bearer ${rawApiKey}`);

    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      page: 2,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].username).toBe("Delta");
  });
});
