import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const r2Mocks = vi.hoisted(() => ({
  createPutUrl: vi.fn(),
  headObject: vi.fn(),
  sha256Object: vi.fn(),
  publicUrl: vi.fn(
    (key: string, target: { publicBaseUrl: string }) => `${target.publicBaseUrl}/${key}`
  ),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/r2Storage/r2Upload.js")>();
  return {
    ...actual,
    createR2PresignedPutUrl: r2Mocks.createPutUrl,
    headR2Object: r2Mocks.headObject,
    sha256R2Object: r2Mocks.sha256Object,
    getR2PublicUrl: r2Mocks.publicUrl,
  };
});

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let ApkRelease: typeof import("../src/models/apkRelease.model.js")["default"];

const originalEnvironment = {
  DEVICE_APPROVAL_ENFORCEMENT: process.env.DEVICE_APPROVAL_ENFORCEMENT,
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
  R2_LEGACY_BUCKET_NAME: process.env.R2_LEGACY_BUCKET_NAME,
  R2_LEGACY_PUBLIC_URL: process.env.R2_LEGACY_PUBLIC_URL,
};

function authHeader(id: string) {
  return {
    Authorization: `Bearer ${jwt.sign(
      { id, role: "superadmin" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    )}`,
  };
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  process.env.R2_BUCKET_NAME = "asset-insight-test";
  process.env.R2_PUBLIC_URL = "https://assetinsight.test";
  process.env.R2_LEGACY_BUCKET_NAME = "sellsnap-test";
  process.env.R2_LEGACY_PUBLIC_URL = "https://images.sellsnap.test";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: ApkRelease } = await import("../src/models/apkRelease.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  r2Mocks.createPutUrl.mockReset().mockResolvedValue("https://upload.example/signed");
  r2Mocks.headObject.mockReset();
  r2Mocks.sha256Object.mockReset();
  r2Mocks.publicUrl.mockClear();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function createSuperadmin() {
  return User.create({
    email: "apk-admin@example.test",
    username: "apk-admin",
    password: "Password123!",
    authProvider: "email",
    isVerified: true,
    role: "superadmin",
  });
}

describe.sequential("APK storage generation", () => {
  it("binds new direct-to-R2 uploads to the current bucket and public base URL", async () => {
    const admin = await createSuperadmin();

    const response = await request(app)
      .post("/api/admin/apk-releases/upload-token")
      .set(authHeader(String(admin._id)))
      .send({
        versionName: "2.5.0",
        versionCode: 20500,
        originalName: "asset-insight.apk",
        sizeBytes: 4096,
      });

    expect(response.status).toBe(200);
    expect(r2Mocks.createPutUrl).toHaveBeenCalledWith(
      "asset-insight-test",
      expect.stringMatching(/^apk\/android\/20500-/),
      "application/vnd.android.package-archive",
      3600
    );
    const payload = jwt.verify(response.body.token, process.env.JWT_SECRET!) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
    });
  });

  it("finishes metadata-free pre-cutover upload tokens against legacy storage", async () => {
    const admin = await createSuperadmin();
    const apkKey = "apk/android/10400-legacy-asset-insight.apk";
    const uploadToken = jwt.sign(
      {
        id: String(admin._id),
        purpose: "apk-release-r2-upload",
        apkKey,
        versionName: "1.4.0",
        versionCode: 10400,
        releaseNotes: "Before storage cutover",
        mandatory: false,
        originalName: "asset-insight.apk",
        sizeBytes: 2048,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    );
    r2Mocks.headObject.mockResolvedValue({ size: 2048 });
    r2Mocks.sha256Object.mockResolvedValue("legacy-sha256");

    const response = await request(app)
      .post("/api/admin/apk-releases/complete")
      .set(authHeader(String(admin._id)))
      .send({ uploadToken });

    expect(response.status).toBe(201);
    expect(r2Mocks.headObject).toHaveBeenCalledWith("sellsnap-test", apkKey);
    expect(r2Mocks.sha256Object).toHaveBeenCalledWith("sellsnap-test", apkKey);
    expect(r2Mocks.publicUrl).toHaveBeenCalledWith(
      apkKey,
      expect.objectContaining({
        bucketName: "sellsnap-test",
        publicBaseUrl: "https://images.sellsnap.test",
        generation: "legacy",
      })
    );
    const stored: any = await ApkRelease.findOne({ versionCode: 10400 }).lean();
    expect(stored).toMatchObject({
      apkUrl: `https://images.sellsnap.test/${apkKey}`,
      apkKey,
      r2Bucket: "sellsnap-test",
      r2PublicBaseUrl: "https://images.sellsnap.test",
    });
  });
});
