import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeIp,
  sanitizeDeviceMetadata,
} from "../src/service/deviceAccessService.js";

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let DeviceRegistration: typeof import("../src/models/deviceRegistration.model.js")["default"];
let DeviceAccessChallenge: typeof import("../src/models/deviceAccessChallenge.model.js")["default"];
let UserIpObservation: typeof import("../src/models/userIpObservation.model.js")["default"];
let SecurityAuditEvent: typeof import("../src/models/securityAuditEvent.model.js")["default"];

const adminHeaders = (id: string) => ({
  Authorization: `Bearer ${jwt.sign(
    { id, role: "admin" },
    process.env.JWT_SECRET!,
    { expiresIn: "30m" }
  )}`,
});

const context = (key: string, overrides: Record<string, unknown> = {}) => ({
  installationKey: key,
  platform: "web",
  formFactor: "desktop",
  displayName: "Test browser",
  metadata: {
    browser: { name: "Chromium", version: "test" },
    os: { name: "Test OS", version: "1" },
    ...overrides,
  },
});

const androidContext = (key: string, reinstallId?: string) => ({
  installationKey: key,
  ...(reinstallId ? { reinstallId } : {}),
  platform: "android",
  formFactor: "mobile",
  displayName: "Test Android phone",
  metadata: {
    manufacturer: "Test Manufacturer",
    model: "Test Model",
    os: { name: "Android", version: "15" },
  },
});

async function createUser(email: string, extra: Record<string, unknown> = {}) {
  return User.create({
    email,
    username: email.split("@")[0],
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role: "user",
    ...extra,
  });
}

async function login(email: string, deviceKey: string) {
  return request(app).post("/api/auth/login").send({
    email,
    password: "Password123!",
    deviceContext: context(deviceKey),
  });
}

async function loginAndroid(email: string, deviceKey: string, reinstallId?: string) {
  return request(app).post("/api/auth/login").send({
    email,
    password: "Password123!",
    deviceContext: androidContext(deviceKey, reinstallId),
  });
}

async function register(
  enrollmentToken: string,
  deviceKey: string,
  verification: "granted" | "no_camera" | "denied" = "granted"
) {
  return request(app)
    .post("/api/auth/device-requests/register")
    .set("Authorization", `Bearer ${enrollmentToken}`)
    .set("X-Device-Key", deviceKey)
    .send({
      platform: "web",
      formFactor: "desktop",
      displayName: "Test browser",
      metadata: {
        browser: { name: "Chromium", version: "test" },
        camera: {
          verification,
          count: verification === "no_camera" ? 0 : 1,
          devices: verification === "no_camera" ? [] : [{ label: "Front camera" }],
        },
        storage: { kind: "browser_origin", quotaBytes: 1024 ** 3 },
      },
    });
}

async function registerAndroid(
  enrollmentToken: string,
  deviceKey: string,
  reinstallId?: string
) {
  return request(app)
    .post("/api/auth/device-requests/register")
    .set("Authorization", `Bearer ${enrollmentToken}`)
    .set("X-Device-Key", deviceKey)
    .send({
      ...(reinstallId ? { reinstallId } : {}),
      platform: "android",
      formFactor: "mobile",
      displayName: "Test Android phone",
      metadata: {
        manufacturer: "Test Manufacturer",
        model: "Test Model",
        camera: {
          verification: "granted",
          count: 1,
          devices: [{ name: "Back camera", position: "back" }],
        },
        storage: { kind: "native_disk", totalBytes: 128 * 1024 ** 3 },
      },
    });
}

async function enrollPending(email: string, key: string) {
  const initial = await login(email, key);
  expect(initial.status).toBe(200);
  expect(initial.body.authState).toBe("registration_required");
  const registered = await register(initial.body.challengeToken, key);
  expect(registered.status).toBe(201);
  expect(registered.body.authState).toBe("pending");
  return registered.body as {
    challengeToken: string;
    device: { id: string };
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: DeviceRegistration } = await import(
    "../src/models/deviceRegistration.model.js"
  ));
  ({ default: DeviceAccessChallenge } = await import(
    "../src/models/deviceAccessChallenge.model.js"
  ));
  ({ default: UserIpObservation } = await import(
    "../src/models/userIpObservation.model.js"
  ));
  ({ default: SecurityAuditEvent } = await import(
    "../src/models/securityAuditEvent.model.js"
  ));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("device approval integration", () => {
  it("enforces camera registration, admin approval, device proof, and one-time exchange", async () => {
    const user = await createUser("device@example.test");
    const admin = await User.create({
      email: "admin@example.test",
      username: "admin",
      password: await bcrypt.hash("AdminPassword123!", 4),
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const key = "a".repeat(64);
    const initial = await login(user.email, key);
    expect(initial.body).toMatchObject({
      authState: "registration_required",
      code: "DEVICE_CONTEXT_REQUIRED",
    });
    expect(initial.body).not.toHaveProperty("accessToken");

    const mismatched = await register(initial.body.challengeToken, "z".repeat(64));
    expect(mismatched.status).toBe(401);
    expect(mismatched.body.code).toBe("DEVICE_CHALLENGE_DEVICE_MISMATCH");

    const polluted = await request(app)
      .post("/api/auth/device-requests/register")
      .set("Authorization", `Bearer ${initial.body.challengeToken}`)
      .set("X-Device-Key", key)
      .send(
        JSON.parse(
          '{"platform":"web","formFactor":"desktop","displayName":"Polluted","metadata":{"__proto__":{"camera":{"verification":"no_camera"}}}}'
        )
      );
    expect(polluted.status).toBe(422);
    expect(polluted.body.code).toBe("CAMERA_VERIFICATION_REQUIRED");

    const denied = await register(initial.body.challengeToken, key, "denied");
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe("CAMERA_VERIFICATION_REQUIRED");

    const registered = await register(initial.body.challengeToken, key, "no_camera");
    expect(registered.status).toBe(201);
    expect(registered.body.authState).toBe("pending");
    expect(registered.body).not.toHaveProperty("accessToken");

    const pending = await request(app)
      .get("/api/auth/device-requests/status")
      .set("Authorization", `Bearer ${registered.body.challengeToken}`)
      .set("X-Device-Key", key);
    expect(pending.body.status).toBe("pending");

    const approved = await request(app)
      .post(`/api/admin/devices/${registered.body.device.id}/approve`)
      .set(adminHeaders(String(admin._id)))
      .send({ scope: "device" });
    expect(approved.status).toBe(200);

    const ready = await request(app)
      .get("/api/auth/device-requests/status")
      .set("Authorization", `Bearer ${registered.body.challengeToken}`)
      .set("X-Device-Key", key);
    expect(ready.body.status).toBe("approved");

    const exchange = await request(app)
      .post("/api/auth/device-requests/exchange")
      .set("Authorization", `Bearer ${registered.body.challengeToken}`)
      .set("X-Device-Key", key)
      .send({});
    expect(exchange.body).toMatchObject({ authState: "authenticated" });
    expect(exchange.body.accessToken).toBeTypeOf("string");
    const decoded = jwt.decode(exchange.body.accessToken) as { did?: string };
    expect(decoded.did).toBe(registered.body.device.id);

    const replay = await request(app)
      .post("/api/auth/device-requests/exchange")
      .set("Authorization", `Bearer ${registered.body.challengeToken}`)
      .set("X-Device-Key", key)
      .send({});
    expect(replay.status).toBe(401);
    expect(replay.body).not.toHaveProperty("accessToken");

    const me = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${exchange.body.accessToken}`)
      .set("X-Device-Key", key);
    expect(me.status).toBe(200);

    const missingProof = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${exchange.body.accessToken}`);
    expect(missingProof.status).toBe(428);
    expect(missingProof.body.code).toBe("DEVICE_CONTEXT_REQUIRED");

    const revoked = await request(app)
      .post(`/api/admin/devices/${registered.body.device.id}/revoke`)
      .set(adminHeaders(String(admin._id)))
      .send({ reason: "Lost device" });
    expect(revoked.status).toBe(200);

    const revokedAccess = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${exchange.body.accessToken}`)
      .set("X-Device-Key", key);
    expect(revokedAccess.status).toBe(403);
    expect(revokedAccess.body).toMatchObject({ authState: "revoked", code: "DEVICE_REVOKED" });

    const revokedRefresh = await request(app)
      .post("/api/auth/refresh-token")
      .set("X-Device-Key", key)
      .send({ token: exchange.body.refreshToken });
    expect(revokedRefresh.status).toBe(403);
    expect(revokedRefresh.body.code).toBe("INVALID_REFRESH_TOKEN");

    const restored = await request(app)
      .post(`/api/admin/devices/${registered.body.device.id}/restore`)
      .set(adminHeaders(String(admin._id)))
      .send({ reason: "Recovered and verified" });
    expect(restored.status).toBe(200);

    const staleAfterRestore = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${exchange.body.accessToken}`)
      .set("X-Device-Key", key);
    expect(staleAfterRestore.status).toBe(401);
    expect(staleAfterRestore.body.code).toBe("DEVICE_CONTEXT_REQUIRED");

    const signedInAgain = await login(user.email, key);
    expect(signedInAgain.body.authState).toBe("authenticated");
    expect(signedInAgain.body.accessToken).toBeTypeOf("string");
  });

  it("recovers an approved Android device after reinstall and invalidates the old installation", async () => {
    const user = await createUser("android-reinstall@example.test");
    const admin = await User.create({
      email: "android-reinstall-admin@example.test",
      username: "android-reinstall-admin",
      password: await bcrypt.hash("AdminPassword123!", 4),
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const oldKey = "1".repeat(64);
    const newKey = "2".repeat(64);
    const reinstallId = `android:v1:${"a".repeat(64)}`;

    const initial = await loginAndroid(user.email, oldKey, reinstallId);
    expect(initial.body.authState).toBe("registration_required");
    const enrolled = await registerAndroid(initial.body.challengeToken, oldKey, reinstallId);
    expect(enrolled.body.authState).toBe("pending");

    const approved = await request(app)
      .post(`/api/admin/devices/${enrolled.body.device.id}/approve`)
      .set(adminHeaders(String(admin._id)))
      .send({ scope: "device" });
    expect(approved.status).toBe(200);

    const oldSession = await request(app)
      .post("/api/auth/device-requests/exchange")
      .set("Authorization", `Bearer ${enrolled.body.challengeToken}`)
      .set("X-Device-Key", oldKey)
      .send({});
    expect(oldSession.body.authState).toBe("authenticated");

    const recovered = await loginAndroid(user.email, newKey, reinstallId);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      authState: "authenticated",
      device: { id: enrolled.body.device.id, status: "approved" },
    });

    const oldAccessWithOldProof = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${oldSession.body.accessToken}`)
      .set("X-Device-Key", oldKey);
    expect(oldAccessWithOldProof.status).toBe(401);
    expect(oldAccessWithOldProof.body.code).toBe("DEVICE_CONTEXT_REQUIRED");

    const oldAccessWithNewProof = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${oldSession.body.accessToken}`)
      .set("X-Device-Key", newKey);
    expect(oldAccessWithNewProof.status).toBe(401);
    expect(oldAccessWithNewProof.body.code).toBe("DEVICE_CONTEXT_REQUIRED");

    const oldRefresh = await request(app)
      .post("/api/auth/refresh-token")
      .set("X-Device-Key", oldKey)
      .send({ token: oldSession.body.refreshToken });
    expect(oldRefresh.status).toBe(403);
    expect(oldRefresh.body.code).toBe("INVALID_REFRESH_TOKEN");

    expect(await DeviceRegistration.countDocuments({ user: user._id })).toBe(1);
    const stored = await DeviceRegistration.findById(enrolled.body.device.id).lean();
    expect(stored?.status).toBe("approved");
    expect(stored?.sessionVersion).toBe(1);
    expect(
      await SecurityAuditEvent.countDocuments({
        targetUser: user._id,
        action: "device.installation_rebound",
      })
    ).toBe(1);
  });

  it("seeds reinstall recovery from a valid legacy Android session before uninstall", async () => {
    const user = await createUser("android-reinstall-rollout@example.test");
    const admin = await User.create({
      email: "android-reinstall-rollout-admin@example.test",
      username: "android-reinstall-rollout-admin",
      password: await bcrypt.hash("AdminPassword123!", 4),
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const legacyKey = "0".repeat(64);
    const reinstalledKey = "a".repeat(64);
    const reinstallId = `android:v1:${"0a".repeat(32)}`;

    const initial = await loginAndroid(user.email, legacyKey);
    const enrolled = await registerAndroid(initial.body.challengeToken, legacyKey);
    await request(app)
      .post(`/api/admin/devices/${enrolled.body.device.id}/approve`)
      .set(adminHeaders(String(admin._id)))
      .send({ scope: "device" });
    const legacySession = await request(app)
      .post("/api/auth/device-requests/exchange")
      .set("Authorization", `Bearer ${enrolled.body.challengeToken}`)
      .set("X-Device-Key", legacyKey)
      .send({});
    expect(legacySession.body.authState).toBe("authenticated");

    const beforeSeed = await DeviceRegistration.findById(enrolled.body.device.id)
      .select("+reinstallIdentityHash")
      .lean();
    expect(beforeSeed?.reinstallIdentityHash).toBeUndefined();

    const protectedRequest = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${legacySession.body.accessToken}`)
      .set("X-Device-Key", legacyKey)
      .set("X-Device-Reinstall-Id", reinstallId);
    expect(protectedRequest.status).toBe(200);

    const afterSeed = await DeviceRegistration.findById(enrolled.body.device.id)
      .select("+reinstallIdentityHash")
      .lean();
    expect(afterSeed?.reinstallIdentityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await SecurityAuditEvent.countDocuments({
        targetUser: user._id,
        device: enrolled.body.device.id,
        action: "device.reinstall_identity_seeded",
      })
    ).toBe(1);

    const recovered = await loginAndroid(user.email, reinstalledKey, reinstallId);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      authState: "authenticated",
      device: { id: enrolled.body.device.id, status: "approved" },
    });
    expect(await DeviceRegistration.countDocuments({ user: user._id })).toBe(1);
  });

  it.each(["stale", "revoked"] as const)(
    "does not seed reinstall recovery from a %s Android session",
    async (invalidSession) => {
      const user = await createUser(`android-no-seed-${invalidSession}@example.test`);
      const admin = await User.create({
        email: `android-no-seed-${invalidSession}-admin@example.test`,
        username: `android-no-seed-${invalidSession}-admin`,
        password: await bcrypt.hash("AdminPassword123!", 4),
        authProvider: "email",
        isVerified: true,
        role: "admin",
      });
      const legacyKey = invalidSession === "stale" ? "b".repeat(64) : "c".repeat(64);
      const reinstallId = `android:v1:${
        invalidSession === "stale" ? "1a".repeat(32) : "2b".repeat(32)
      }`;

      const initial = await loginAndroid(user.email, legacyKey);
      const enrolled = await registerAndroid(initial.body.challengeToken, legacyKey);
      await request(app)
        .post(`/api/admin/devices/${enrolled.body.device.id}/approve`)
        .set(adminHeaders(String(admin._id)))
        .send({ scope: "device" });
      const session = await request(app)
        .post("/api/auth/device-requests/exchange")
        .set("Authorization", `Bearer ${enrolled.body.challengeToken}`)
        .set("X-Device-Key", legacyKey)
        .send({});

      await DeviceRegistration.updateOne(
        { _id: enrolled.body.device.id },
        invalidSession === "stale"
          ? { $inc: { sessionVersion: 1 } }
          : { $set: { status: "revoked" } }
      );
      const denied = await request(app)
        .get("/api/user/me")
        .set("Authorization", `Bearer ${session.body.accessToken}`)
        .set("X-Device-Key", legacyKey)
        .set("X-Device-Reinstall-Id", reinstallId);
      expect(denied.status).toBe(invalidSession === "stale" ? 401 : 403);

      const stored = await DeviceRegistration.findById(enrolled.body.device.id)
        .select("+reinstallIdentityHash")
        .lean();
      expect(stored?.reinstallIdentityHash).toBeUndefined();
      expect(
        await SecurityAuditEvent.countDocuments({
          device: enrolled.body.device.id,
          action: "device.reinstall_identity_seeded",
        })
      ).toBe(0);
    }
  );

  it.each(["pending", "rejected", "revoked"] as const)(
    "preserves %s status when an Android installation is recovered",
    async (status) => {
      const user = await createUser(`android-reinstall-${status}@example.test`);
      const oldKey = status === "pending" ? "3".repeat(64) : status === "rejected" ? "4".repeat(64) : "5".repeat(64);
      const newKey = status === "pending" ? "6".repeat(64) : status === "rejected" ? "7".repeat(64) : "8".repeat(64);
      const reinstallId = `android:v1:${
        status === "pending" ? "b".repeat(64) : status === "rejected" ? "c".repeat(64) : "d".repeat(64)
      }`;

      const initial = await loginAndroid(user.email, oldKey, reinstallId);
      const enrolled = await registerAndroid(initial.body.challengeToken, oldKey, reinstallId);
      if (status !== "pending") {
        await DeviceRegistration.updateOne(
          { _id: enrolled.body.device.id },
          {
            $set: {
              status,
              decisionReason: `Remain ${status} after reinstall`,
              decidedAt: new Date(),
            },
          }
        );
      }

      const recovered = await loginAndroid(user.email, newKey, reinstallId);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toMatchObject({
        authState: status,
        device: { id: enrolled.body.device.id, status },
      });
      expect(await DeviceRegistration.countDocuments({ user: user._id })).toBe(1);
    }
  );

  it("requires a new request when the Android recovery identity is different", async () => {
    const user = await createUser("android-different-device@example.test");
    const firstKey = "9".repeat(64);
    const secondKey = "e".repeat(64);
    const firstReinstallId = `android:v1:${"e".repeat(64)}`;
    const secondReinstallId = `android:v1:${"f".repeat(64)}`;

    const initial = await loginAndroid(user.email, firstKey, firstReinstallId);
    const enrolled = await registerAndroid(
      initial.body.challengeToken,
      firstKey,
      firstReinstallId
    );
    expect(enrolled.body.authState).toBe("pending");

    const anotherDevice = await loginAndroid(user.email, secondKey, secondReinstallId);
    expect(anotherDevice.status).toBe(200);
    expect(anotherDevice.body.authState).toBe("registration_required");
    expect(anotherDevice.body).not.toHaveProperty("device");
  });

  it("canonicalizes equivalent IPv6 addresses before exact matching", () => {
    expect(normalizeIp("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("retains nested native camera resolution values", () => {
    const sanitized = sanitizeDeviceMetadata({
      camera: {
        verification: "granted",
        devices: [{ photoResolution: { width: 8160, height: 6120 } }],
      },
    });
    expect(sanitized).toMatchObject({
      camera: { devices: [{ photoResolution: { width: 8160, height: 6120 } }] },
    });
  });

  it("uses the configured trusted Nginx hop instead of its loopback socket", async () => {
    const user = await createUser("trusted-proxy@example.test");
    app.set("trust proxy", 1);
    try {
      const response = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "198.51.100.44")
        .send({
          email: user.email,
          password: "Password123!",
          deviceContext: context("9".repeat(64)),
        });
      expect(response.status).toBe(200);
      expect((await UserIpObservation.findOne({ user: user._id }).lean())?.ip).toBe("198.51.100.44");
    } finally {
      app.set("trust proxy", false);
    }
  });

  it("refreshes approved device identity metadata without losing camera verification", async () => {
    const user = await createUser("metadata-refresh@example.test", {
      deviceApprovalMode: "all_devices",
    });
    const key = "8".repeat(64);
    const initial = await login(user.email, key);
    const registered = await register(initial.body.challengeToken, key);
    expect(registered.body.authState).toBe("approved");

    const refreshed = await request(app).post("/api/auth/login").send({
      email: user.email,
      password: "Password123!",
      deviceContext: {
        ...context(key, {
          marketingName: "Samsung Galaxy S22+",
          hardwareProfile: {
            marketingName: "Samsung Galaxy S22+",
            modelCode: "SM-S906U",
            camera: { lensCount: 4, rearMaximumMegapixels: 50 },
          },
        }),
        platform: "android",
        formFactor: "mobile",
        displayName: "Samsung Galaxy S22+ (SM-S906U)",
      },
    });
    expect(refreshed.body.authState).toBe("authenticated");
    const stored = await DeviceRegistration.findById(registered.body.device.id).lean();
    expect(stored?.displayName).toBe("Samsung Galaxy S22+ (SM-S906U)");
    expect(stored?.metadata).toMatchObject({
      marketingName: "Samsung Galaxy S22+",
      hardwareProfile: { camera: { lensCount: 4, rearMaximumMegapixels: 50 } },
      camera: { verification: "granted" },
    });
  });

  it("allows an admin to type and block an exact IP for one user", async () => {
    const user = await createUser("manual-ip@example.test");
    const other = await createUser("manual-ip-other@example.test");
    const admin = await User.create({
      email: "manual-ip-admin@example.test",
      username: "manual-ip-admin",
      password: await bcrypt.hash("AdminPassword123!", 4),
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const blocked = await request(app)
      .post("/api/admin/device-ips/block")
      .set(adminHeaders(String(admin._id)))
      .send({
        userEmail: user.email,
        ip: "198.51.100.73",
        reason: "Confirmed suspicious source",
      });
    expect(blocked.status).toBe(201);
    expect(blocked.body.ipObservation).toMatchObject({
      ip: "198.51.100.73",
      blocked: true,
      source: "admin",
      count: 0,
    });

    app.set("trust proxy", 1);
    try {
      const denied = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "198.51.100.73")
        .send({ email: user.email, password: "Password123!", deviceContext: context("7".repeat(64)) });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("IP_BLOCKED");

      const unaffected = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "198.51.100.73")
        .send({ email: other.email, password: "Password123!", deviceContext: context("6".repeat(64)) });
      expect(unaffected.status).toBe(200);
      expect(unaffected.body.authState).toBe("registration_required");
    } finally {
      app.set("trust proxy", false);
    }
  });

  it("deletes a registration, invalidates access, and treats the installation as new", async () => {
    const user = await createUser("delete-device@example.test");
    const admin = await User.create({
      email: "delete-device-admin@example.test",
      username: "delete-device-admin",
      password: await bcrypt.hash("AdminPassword123!", 4),
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const key = "5".repeat(64);
    const enrolled = await enrollPending(user.email, key);
    await request(app)
      .post(`/api/admin/devices/${enrolled.device.id}/approve`)
      .set(adminHeaders(String(admin._id)))
      .send({ scope: "device" });
    const exchange = await request(app)
      .post("/api/auth/device-requests/exchange")
      .set("Authorization", `Bearer ${enrolled.challengeToken}`)
      .set("X-Device-Key", key)
      .send({});
    expect(exchange.body.authState).toBe("authenticated");

    const deleted = await request(app)
      .delete(`/api/admin/devices/${enrolled.device.id}`)
      .set(adminHeaders(String(admin._id)))
      .send({ reason: "Force fresh device verification" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.nextSignInRequiresRegistration).toBe(true);
    expect(await DeviceRegistration.findById(enrolled.device.id)).toBeNull();

    const staleAccess = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${exchange.body.accessToken}`)
      .set("X-Device-Key", key);
    expect(staleAccess.status).toBe(401);
    expect(staleAccess.body.code).toBe("DEVICE_CONTEXT_REQUIRED");

    const newLogin = await login(user.email, key);
    expect(newLogin.body.authState).toBe("registration_required");
    const newRequest = await register(newLogin.body.challengeToken, key);
    expect(newRequest.body.authState).toBe("pending");
    expect(newRequest.body.device.id).not.toBe(enrolled.device.id);
  });

  it("rejects legacy tokens, ignores spoofed forwarding headers, and blocks exact IP per user", async () => {
    const user = await createUser("network@example.test");
    const key = "b".repeat(64);
    const legacy = jwt.sign({ id: user._id }, process.env.JWT_SECRET!, { expiresIn: "15m" });
    const legacyResponse = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${legacy}`)
      .set("X-Device-Key", key);
    expect(legacyResponse.status).toBe(401);
    expect(legacyResponse.body.code).toBe("DEVICE_CONTEXT_REQUIRED");

    const initial = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.88")
      .send({
        email: user.email,
        password: "Password123!",
        deviceContext: context(key),
      });
    expect(initial.status).toBe(200);
    const observation = await UserIpObservation.findOne({ user: user._id }).lean();
    expect(observation?.ip).not.toBe("203.0.113.88");
    await UserIpObservation.updateOne(
      { _id: observation?._id },
      { $set: { blocked: true, blockReason: "Security test" } }
    );
    const blocked = await login(user.email, key);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ authState: "ip_blocked", code: "IP_BLOCKED" });

    const other = await createUser("other-network@example.test");
    const otherLogin = await login(other.email, "c".repeat(64));
    expect(otherLogin.status).toBe(200);
    expect(otherLogin.body.authState).toBe("registration_required");
  });

  it("uses conditional decisions and enforces re-request cooldown", async () => {
    await createUser("race@example.test");
    const admin = await User.create({
      email: "race-admin@example.test",
      username: "race-admin",
      password: await bcrypt.hash("AdminPassword123!", 4),
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const key = "d".repeat(64);
    const enrolled = await enrollPending("race@example.test", key);
    const [approve, reject] = await Promise.all([
      request(app)
        .post(`/api/admin/devices/${enrolled.device.id}/approve`)
        .set(adminHeaders(String(admin._id)))
        .send({ scope: "device" }),
      request(app)
        .post(`/api/admin/devices/${enrolled.device.id}/reject`)
        .set(adminHeaders(String(admin._id)))
        .send({ reason: "Concurrent review" }),
    ]);
    expect([approve.status, reject.status].sort()).toEqual([200, 409]);

    await DeviceRegistration.updateOne(
      { _id: enrolled.device.id },
      {
        $set: {
          status: "rejected",
          decisionReason: "Retry",
          decidedAt: new Date(),
          decidedBy: admin._id,
        },
      }
    );
    const first = await request(app)
      .post("/api/auth/device-requests/rerequest")
      .set("Authorization", `Bearer ${enrolled.challengeToken}`)
      .set("X-Device-Key", key)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.authState).toBe("rerequest_pending");
    const rerequested = await DeviceRegistration.findById(enrolled.device.id).lean();
    expect(rerequested?.decisionReason).toBeUndefined();
    expect(rerequested?.decidedAt).toBeUndefined();
    expect(rerequested?.decidedBy).toBeUndefined();

    await DeviceRegistration.updateOne(
      { _id: enrolled.device.id },
      { $set: { status: "rejected" } }
    );
    const cooldown = await request(app)
      .post("/api/auth/device-requests/rerequest")
      .set("Authorization", `Bearer ${first.body.challengeToken}`)
      .set("X-Device-Key", key)
      .send({});
    expect(cooldown.status).toBe(429);
    expect(cooldown.body.code).toBe("DEVICE_REREQUEST_COOLDOWN");
  });

  it("applies approve-all to current and future installs but not rejected devices", async () => {
    const user = await createUser("all@example.test");
    const admin = await User.create({
      email: "all-admin@example.test",
      username: "all-admin",
      password: await bcrypt.hash("AdminPassword123!", 4),
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const first = await enrollPending(user.email, "e".repeat(64));
    const rejected = await enrollPending(user.email, "f".repeat(64));
    await request(app)
      .post(`/api/admin/devices/${rejected.device.id}/reject`)
      .set(adminHeaders(String(admin._id)))
      .send({ reason: "Keep restricted" });

    const approveAll = await request(app)
      .post(`/api/admin/devices/${first.device.id}/approve`)
      .set(adminHeaders(String(admin._id)))
      .send({ scope: "all_devices", reason: "Managed corporate account" });
    expect(approveAll.status).toBe(200);
    expect((await User.findById(user._id).lean())?.deviceApprovalMode).toBe("all_devices");
    expect((await DeviceRegistration.findById(rejected.device.id).lean())?.status).toBe("rejected");

    const newKey = "1".repeat(64);
    const unknown = await login(user.email, newKey);
    const auto = await register(unknown.body.challengeToken, newKey, "no_camera");
    expect(auto.body.authState).toBe("approved");
    const exchanged = await request(app)
      .post("/api/auth/device-requests/exchange")
      .set("Authorization", `Bearer ${auto.body.challengeToken}`)
      .set("X-Device-Key", newKey)
      .send({});
    expect(exchanged.body.authState).toBe("authenticated");

    const disabled = await request(app)
      .patch(`/api/admin/users/${user._id}/device-approval-policy`)
      .set(adminHeaders(String(admin._id)))
      .send({ mode: "per_device", reason: "Return to per-device review" });
    expect(disabled.status).toBe(200);
    const nextKey = "2".repeat(64);
    const nextUnknown = await login(user.email, nextKey);
    const nextRegistered = await register(nextUnknown.body.challengeToken, nextKey, "no_camera");
    expect(nextRegistered.body.authState).toBe("pending");
  });

  it("routes verification and password reset token issuance through device enrollment", async () => {
    const unverified = await createUser("verify@example.test", {
      isVerified: false,
      verificationCode: "123456",
      verificationCodeExpires: new Date(Date.now() + 60_000),
    });
    const verified = await request(app)
      .post("/api/auth/verify-email")
      .send({
        email: unverified.email,
        verificationCode: "123456",
        deviceContext: context("3".repeat(64)),
      });
    expect(verified.body.authState).toBe("registration_required");
    expect(verified.body).not.toHaveProperty("accessToken");

    const resetUser = await createUser("reset@example.test", {
      passwordResetCode: "654321",
      passwordResetCodeExpires: new Date(Date.now() + 60_000),
    });
    const reset = await request(app)
      .post("/api/auth/reset-password-code")
      .send({
        email: resetUser.email,
        code: "654321",
        password: "NewPassword123!",
        deviceContext: context("4".repeat(64)),
      });
    expect(reset.body.authState).toBe("registration_required");
    expect(reset.body).not.toHaveProperty("accessToken");
  });

  it("does not consume a reset code or change the password without device context", async () => {
    const resetUser = await createUser("reset-missing-device@example.test", {
      passwordResetCode: "123987",
      passwordResetCodeExpires: new Date(Date.now() + 60_000),
    });

    const reset = await request(app).post("/api/auth/reset-password-code").send({
      email: resetUser.email,
      code: "123987",
      password: "ChangedPassword123!",
    });

    expect(reset.status).toBe(428);
    expect(reset.body.code).toBe("DEVICE_CONTEXT_REQUIRED");
    const unchanged = await User.findById(resetUser._id).select(
      "+password +passwordResetCode +passwordResetCodeExpires"
    );
    expect(unchanged?.passwordResetCode).toBe("123987");
    expect(await bcrypt.compare("Password123!", String(unchanged?.password))).toBe(true);
  });

  it("accepts Android installation identity from mobile request headers", async () => {
    const resetUser = await createUser("reset-mobile-headers@example.test", {
      passwordResetCode: "789123",
      passwordResetCodeExpires: new Date(Date.now() + 60_000),
    });
    const key = "d".repeat(64);
    const reinstallId = `android:v1:${"e".repeat(64)}`;

    const reset = await request(app)
      .post("/api/auth/reset-password-code")
      .set("X-Device-Key", key)
      .set("X-Device-Reinstall-Id", reinstallId)
      .set("X-Device-Platform", "android")
      .set("X-Device-Form-Factor", "mobile")
      .send({
        email: resetUser.email,
        code: "789123",
        password: "ChangedPassword123!",
      });

    expect(reset.status).toBe(200);
    expect(reset.body.authState).toBe("registration_required");
    expect(reset.body).not.toHaveProperty("accessToken");
  });

  it("cascades security records when an account is deleted", async () => {
    const user = await createUser("delete@example.test");
    const admin = await User.create({
      email: "delete-admin@example.test",
      username: "delete-admin",
      password: await bcrypt.hash("AdminPassword123!", 4),
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    await enrollPending(user.email, "5".repeat(64));
    expect(await DeviceRegistration.countDocuments({ user: user._id })).toBe(1);
    const deleted = await request(app)
      .delete(`/api/admin/users/${user._id}`)
      .set(adminHeaders(String(admin._id)));
    expect(deleted.status).toBe(204);
    expect(await DeviceRegistration.countDocuments({ user: user._id })).toBe(0);
    expect(await DeviceAccessChallenge.countDocuments({ user: user._id })).toBe(0);
    expect(await UserIpObservation.countDocuments({ user: user._id })).toBe(0);
    expect(await SecurityAuditEvent.countDocuments({ targetUser: user._id })).toBe(0);
  });
});
