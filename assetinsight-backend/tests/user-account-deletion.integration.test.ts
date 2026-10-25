import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import User from "../src/models/user.model.js";
import DeviceRegistration from "../src/models/deviceRegistration.model.js";
import DeviceAccessChallenge from "../src/models/deviceAccessChallenge.model.js";
import UserIpObservation from "../src/models/userIpObservation.model.js";
import SecurityAuditEvent from "../src/models/securityAuditEvent.model.js";

// These unrelated profile dependencies must never contact a provider in this suite.
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
const storage = vi.hoisted(() => ({ deleteFromR2: vi.fn() }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  deleteFromR2: storage.deleteFromR2,
  getCurrentR2StorageTarget: vi.fn(),
  isCurrentR2StorageTarget: vi.fn(),
  resolvePersistedR2StorageTarget: vi.fn(),
  uploadBufferToR2: vi.fn(),
  uploadToR2: vi.fn(),
}));

let mongo: MongoMemoryServer;
const app = express();
const originalEnforcement = process.env.DEVICE_APPROVAL_ENFORCEMENT;
const password = " Deliberate password spaces! ";
const installationKey = "test-account-deletion-device-installation";

async function owner(overrides: Record<string, unknown> = {}) {
  const user = await User.create({
    email: `account-${new mongoose.Types.ObjectId()}@example.test`,
    username: "Deletion test account",
    password: await bcrypt.hash(password, 4),
    authProvider: "email",
    isVerified: true,
    role: "user",
    ...overrides,
  });
  const device = await DeviceRegistration.create({
    user: user._id,
    installationKeyHash: createHash("sha256").update(installationKey).digest("hex"),
    platform: "web",
    formFactor: "desktop",
    displayName: "Isolated account deletion browser",
    status: "approved",
    sessionVersion: 0,
  });
  const headers = {
    Authorization: `Bearer ${jwt.sign(
      { id: String(user._id), did: String(device._id), dv: 0 },
      process.env.JWT_SECRET!,
      { expiresIn: "5m" },
    )}`,
    "X-Device-Key": installationKey,
  };
  return { user, device, headers };
}

async function securityFixtures(userId: mongoose.Types.ObjectId, deviceId: mongoose.Types.ObjectId) {
  const challenge = await DeviceAccessChallenge.create({
    user: userId,
    device: deviceId,
    purpose: "status",
    tokenHash: new mongoose.Types.ObjectId().toString(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const observation = await UserIpObservation.create({ user: userId, ip: "192.0.2.10" });
  const audit = await SecurityAuditEvent.insertMany([
    { action: "test.target", actorType: "system", targetUser: userId },
    { action: "test.actor", actorType: "user", actor: userId },
    { action: "test.device-only", actorType: "system", device: deviceId },
  ]);
  return { challenge, observation, audit };
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "on";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const { default: userRoutes } = await import("../src/routes/user.routes.js");
  app.use(express.json());
  // The production router and protect middleware run unchanged, without loading
  // the API bootstrap, workers, unrelated routes or scheduled maintenance.
  app.use("/api/user", userRoutes);
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  storage.deleteFromR2.mockReset();
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (originalEnforcement === undefined) delete process.env.DEVICE_APPROVAL_ENFORCEMENT;
  else process.env.DEVICE_APPROVAL_ENFORCEMENT = originalEnforcement;
});

describe.sequential("self-service account deletion: existing endpoint boundaries", () => {
  it("requires authentication before considering a supplied user id or password", async () => {
    const { user } = await owner();
    const response = await request(app).delete("/api/user").send({ userId: user._id, password });
    expect(response.status).toBe(401);
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });

  it("rejects a valid JWT without the approved installation proof", async () => {
    const { user, headers } = await owner();
    const response = await request(app)
      .delete("/api/user")
      .set("Authorization", headers.Authorization)
      .send({ password });
    expect(response.status).toBe(428);
    expect(response.body.code).toBe("DEVICE_CONTEXT_REQUIRED");
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });

  it("does not allow a blocked account to bypass normal access restrictions", async () => {
    const { user, headers } = await owner({ isBlocked: true });
    const response = await request(app).delete("/api/user").set(headers).send({ password });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ACCOUNT_BLOCKED");
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });

  it.each([{}, { password: "" }])("requires a current password for an email account: %j", async (body) => {
    const { user, device, headers } = await owner();
    const response = await request(app).delete("/api/user").set(headers).send(body);
    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Password is required");
    expect(await User.exists({ _id: user._id })).toBeTruthy();
    expect(await DeviceRegistration.exists({ _id: device._id })).toBeTruthy();
  });

  it.each(["Wrong password!", password.trim()])("rejects an incorrect or trimmed password without deleting the account", async (candidate) => {
    const { user, device, headers } = await owner();
    const response = await request(app).delete("/api/user").set(headers).send({ password: candidate });
    expect(response.status).toBe(401);
    expect(response.body.message).toBe("Invalid credentials");
    expect(await User.exists({ _id: user._id })).toBeTruthy();
    expect(await DeviceRegistration.exists({ _id: device._id })).toBeTruthy();
  });

  it("requires a password hash even for a damaged legacy email account", async () => {
    const { user, headers } = await owner();
    await User.collection.updateOne({ _id: user._id }, { $unset: { password: 1 } });
    const response = await request(app).delete("/api/user").set(headers).send({ password });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Password not set for this account.");
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });

  it("deletes only the authenticated account and its security records, ignoring body/query ownership", async () => {
    const current = await owner();
    const unrelated = await owner();
    const currentSecurity = await securityFixtures(current.user._id, current.device._id);
    const otherSecurity = await securityFixtures(unrelated.user._id, unrelated.device._id);
    const response = await request(app)
      .delete(`/api/user?userId=${unrelated.user._id}`)
      .set(current.headers)
      .send({ password, userId: unrelated.user._id, id: unrelated.user._id, email: unrelated.user.email });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "User account deleted successfully" });
    expect(await User.exists({ _id: current.user._id })).toBeNull();
    expect(await DeviceRegistration.exists({ _id: current.device._id })).toBeNull();
    expect(await DeviceAccessChallenge.exists({ _id: currentSecurity.challenge._id })).toBeNull();
    expect(await UserIpObservation.exists({ _id: currentSecurity.observation._id })).toBeNull();
    expect(await SecurityAuditEvent.countDocuments({ _id: { $in: currentSecurity.audit.map((row) => row._id) } })).toBe(0);
    expect(await User.exists({ _id: unrelated.user._id })).toBeTruthy();
    expect(await DeviceRegistration.exists({ _id: unrelated.device._id })).toBeTruthy();
    expect(await DeviceAccessChallenge.exists({ _id: otherSecurity.challenge._id })).toBeTruthy();
    expect(await UserIpObservation.exists({ _id: otherSecurity.observation._id })).toBeTruthy();
    expect(await SecurityAuditEvent.countDocuments({ _id: { $in: otherSecurity.audit.map((row) => row._id) } })).toBe(3);
    // An otherwise unexpired token cannot read a profile or repeat the deletion.
    expect((await request(app).get("/api/user/me").set(current.headers)).status).toBe(401);
    expect((await request(app).delete("/api/user").set(current.headers).send({ password })).status).toBe(401);
  });

  it("documents that account removal does not erase retained domain records or stored media", async () => {
    const { user, headers } = await owner({ avatarKey: "avatars/test.webp", cvKey: "cv/test.docx" });
    // Raw fixtures deliberately avoid unrelated schema/hooks/queue side effects.
    // These are the production collection names, not a claim of full erasure.
    const retainedCollections = [
      "assetreports", "lotlistings", "reportdrafts", "reportuploadsessions",
      "reportactivities", "reportactivityevents", "crmleads", "supportconversations",
      "appnotifications",
    ];
    const fixture = { _id: new mongoose.Types.ObjectId(), user: user._id, ownerId: user._id, marker: "retention-audit" };
    for (const collection of retainedCollections) {
      await mongoose.connection.db!.collection(collection).insertOne({ ...fixture });
    }
    const response = await request(app).delete("/api/user").set(headers).send({ password });
    expect(response.status).toBe(200);
    for (const collection of retainedCollections) {
      expect(await mongoose.connection.db!.collection(collection).findOne({ _id: fixture._id })).toEqual(fixture);
    }
    expect(storage.deleteFromR2).not.toHaveBeenCalled();
  });

  it("does not claim success or delete the account when security cleanup rejects", async () => {
    const { user, headers } = await owner();
    vi.spyOn(DeviceAccessChallenge, "deleteMany").mockRejectedValueOnce(new Error("isolated security cleanup failure"));
    const response = await request(app).delete("/api/user").set(headers).send({ password });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: "Server error" });
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });

  it("documents non-transactional failure: user deletion can fail after device records were removed", async () => {
    const { user, device, headers } = await owner();
    const security = await securityFixtures(user._id, device._id);
    vi.spyOn(User, "findByIdAndDelete").mockRejectedValueOnce(new Error("isolated account write failure"));
    const response = await request(app).delete("/api/user").set(headers).send({ password });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: "Server error" });
    expect(await User.exists({ _id: user._id })).toBeTruthy();
    expect(await DeviceRegistration.exists({ _id: device._id })).toBeNull();
    expect(await DeviceAccessChallenge.exists({ _id: security.challenge._id })).toBeNull();
    // This known limitation requires account/device support, not a false success.
    const retry = await request(app).delete("/api/user").set(headers).send({ password });
    expect(retry.status).toBe(401);
    expect(retry.body.code).toBe("DEVICE_CONTEXT_REQUIRED");
  });
});
