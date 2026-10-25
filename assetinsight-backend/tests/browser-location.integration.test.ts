import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  BROWSER_LOCATION_MAX_PENDING_LOOKUPS,
  BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS,
  resetBrowserLocationServiceForTests,
  resolveBrowserLocation,
} from "../src/service/browserLocationService.js";

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let userId: string;
const originalDeviceApproval = process.env.DEVICE_APPROVAL_ENFORCEMENT;

function authorization() {
  return `Bearer ${jwt.sign(
    { id: userId, role: "user" },
    process.env.JWT_SECRET!,
    { expiresIn: "30m" }
  )}`;
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  resetBrowserLocationServiceForTests();
  const user = await User.create({
    email: "browser-location@example.test",
    username: "Browser Location User",
    companyName: "Asset Insight QA",
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role: "user",
  });
  userId = String(user._id);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (originalDeviceApproval === undefined) {
    delete process.env.DEVICE_APPROVAL_ENFORCEMENT;
  } else {
    process.env.DEVICE_APPROVAL_ENFORCEMENT = originalDeviceApproval;
  }
});

describe.sequential("browser location API", () => {
  it("requires an authenticated user", async () => {
    const response = await request(app)
      .post("/api/location/reverse-geocode")
      .send({ latitude: 51.503407, longitude: -0.127592 });

    expect(response.status).toBe(401);
  });

  it("rejects coordinates outside valid latitude/longitude ranges", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(app)
      .post("/api/location/reverse-geocode")
      .set("Authorization", authorization())
      .send({ latitude: 95, longitude: -0.127592 });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/valid latitude and longitude/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a readable place name while keeping coordinates out of the response label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            display_name:
              "10 Downing Street, Westminster, London, England, SW1A 2AA, United Kingdom",
            address: { country_code: "gb" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const response = await request(app)
      .post("/api/location/reverse-geocode")
      .set("Authorization", authorization())
      .set("Accept-Language", "en-GB")
      .send({ latitude: 51.503407, longitude: -0.127592 });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toMatchObject({
      location:
        "10 Downing Street, Westminster, London, England, SW1A 2AA, United Kingdom",
      countryCode: "GB",
      currency: "GBP",
      source: "openstreetmap",
      attribution: "© OpenStreetMap contributors",
    });
    expect(response.body.data.location).not.toMatch(/\bLat\b|\bLong\b/i);
  });

  it("returns a retryable 429 after a user's location request quota is exhausted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          display_name: "Regina, Saskatchewan, Canada",
          address: { country_code: "ca" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    for (
      let attempt = 0;
      attempt < BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS;
      attempt += 1
    ) {
      const allowed = await request(app)
        .post("/api/location/reverse-geocode")
        .set("Authorization", authorization())
        .send({ latitude: 50.44521, longitude: -104.618896 });
      expect(allowed.status).toBe(200);
    }

    const limited = await request(app)
      .post("/api/location/reverse-geocode")
      .set("Authorization", authorization())
      .send({ latitude: 50.44521, longitude: -104.618896 });

    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.body).toMatchObject({
      code: "BROWSER_LOCATION_RATE_LIMITED",
      retryAfterSeconds: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns a retryable 429 instead of extending a saturated provider queue", async () => {
    let finishFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      finishFirst = resolve;
    });
    const providerPayload = JSON.stringify({
      display_name: "Regina, Saskatchewan, Canada",
      address: { country_code: "ca" },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(firstResponse)
        .mockImplementation(async () =>
          new Response(providerPayload, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
    );
    const pending = Array.from(
      { length: BROWSER_LOCATION_MAX_PENDING_LOOKUPS },
      (_, index) =>
        resolveBrowserLocation({
          latitude: 45 + index / 100,
          longitude: -100,
        })
    );

    const busy = await request(app)
      .post("/api/location/reverse-geocode")
      .set("Authorization", authorization())
      .send({ latitude: 60, longitude: -110 });

    expect(busy.status).toBe(429);
    expect(busy.headers["retry-after"]).toMatch(/^\d+$/);
    expect(busy.body).toMatchObject({
      code: "BROWSER_LOCATION_BUSY",
      retryAfterSeconds: expect.any(Number),
    });

    finishFirst(
      new Response(providerPayload, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(Promise.all(pending)).resolves.toHaveLength(
      BROWSER_LOCATION_MAX_PENDING_LOOKUPS
    );
  });
});
