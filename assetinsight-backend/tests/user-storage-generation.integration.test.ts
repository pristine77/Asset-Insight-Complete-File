import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const r2Mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  uploadBuffer: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/r2Storage/r2Upload.js")
  >();
  return {
    ...actual,
    uploadToR2: r2Mocks.uploadFile,
    uploadBufferToR2: r2Mocks.uploadBuffer,
    deleteFromR2: r2Mocks.deleteObject,
  };
});

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];

const originalEnvironment = {
  DEVICE_APPROVAL_ENFORCEMENT: process.env.DEVICE_APPROVAL_ENFORCEMENT,
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
  R2_LEGACY_BUCKET_NAME: process.env.R2_LEGACY_BUCKET_NAME,
  R2_LEGACY_PUBLIC_URL: process.env.R2_LEGACY_PUBLIC_URL,
};

const authHeader = (id: string) => ({
  Authorization: `Bearer ${jwt.sign({ id, role: "user" }, process.env.JWT_SECRET!, {
    expiresIn: "30m",
  })}`,
});

async function createUser(email: string, overrides: Record<string, unknown> = {}) {
  return User.create({
    email,
    username: email.split("@")[0],
    password: "Password123!",
    authProvider: "email",
    isVerified: true,
    role: "user",
    ...overrides,
  });
}

async function imageBytes(): Promise<Buffer> {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  })
    .png()
    .toBuffer();
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  process.env.R2_BUCKET_NAME = "user-storage-test";
  process.env.R2_PUBLIC_URL = "https://user-storage.test";
  process.env.R2_LEGACY_BUCKET_NAME = "legacy-user-storage-test";
  process.env.R2_LEGACY_PUBLIC_URL = "https://legacy-user-storage.test";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  r2Mocks.uploadFile.mockReset().mockImplementation(
    async (_file: unknown, _bucket: string, key: string) =>
      `https://user-storage.test/${key}`
  );
  r2Mocks.uploadBuffer.mockReset().mockImplementation(
    async (_buffer: Buffer, _contentType: string, _bucket: string, key: string) =>
      `https://user-storage.test/${key}`
  );
  r2Mocks.deleteObject.mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe.sequential("user media storage generations", () => {
  it("snapshots current storage for new CV and avatar uploads", async () => {
    const user = await createUser("current-media@example.test");

    const cv = await request(app)
      .post("/api/user/cv")
      .set(authHeader(String(user._id)))
      .attach("cv", Buffer.from("docx-test"), {
        filename: "valuation-experience.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });

    expect(cv.status).toBe(200);
    const afterCv: any = await User.findById(user._id).lean();
    expect(afterCv).toMatchObject({
      cvBucket: "user-storage-test",
      cvPublicBaseUrl: "https://user-storage.test",
      cvKey: expect.stringMatching(/^cv\//),
      cvUrl: expect.stringMatching(/^https:\/\/user-storage\.test\/cv\//),
    });
    expect(r2Mocks.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: "valuation-experience.docx" }),
      "user-storage-test",
      afterCv.cvKey
    );

    const avatar = await request(app)
      .post("/api/user/avatar")
      .set(authHeader(String(user._id)))
      .attach("avatar", await imageBytes(), {
        filename: "profile.png",
        contentType: "image/png",
      });

    expect(avatar.status).toBe(200);
    const afterAvatar: any = await User.findById(user._id).lean();
    expect(afterAvatar).toMatchObject({
      avatarBucket: "user-storage-test",
      avatarPublicBaseUrl: "https://user-storage.test",
      avatarKey: expect.stringMatching(/^avatars\//),
      avatarUrl: expect.stringMatching(/^https:\/\/user-storage\.test\/avatars\//),
    });
    expect(r2Mocks.uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/webp",
      "user-storage-test",
      afterAvatar.avatarKey
    );
  });

  it("replaces a metadata-free legacy avatar without deleting the legacy object", async () => {
    const legacyKey = "avatars/legacy-owner/old.webp";
    const user = await createUser("legacy-replace@example.test", {
      avatarUrl: `https://legacy-user-storage.test/${legacyKey}`,
      avatarKey: legacyKey,
      avatarUploadedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const response = await request(app)
      .post("/api/user/avatar")
      .set(authHeader(String(user._id)))
      .attach("avatar", await imageBytes(), {
        filename: "replacement.png",
        contentType: "image/png",
      });

    expect(response.status).toBe(200);
    expect(r2Mocks.deleteObject).not.toHaveBeenCalled();
    const stored: any = await User.findById(user._id).lean();
    expect(stored.avatarKey).not.toBe(legacyKey);
    expect(stored).toMatchObject({
      avatarBucket: "user-storage-test",
      avatarPublicBaseUrl: "https://user-storage.test",
    });
  });

  it("removes metadata-free legacy avatar metadata without deleting legacy bytes", async () => {
    const legacyKey = "avatars/legacy-owner/delete.webp";
    const user = await createUser("legacy-delete@example.test", {
      avatarUrl: `https://legacy-user-storage.test/${legacyKey}`,
      avatarKey: legacyKey,
      avatarUploadedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const response = await request(app)
      .delete("/api/user/avatar")
      .set(authHeader(String(user._id)));

    expect(response.status).toBe(200);
    expect(r2Mocks.deleteObject).not.toHaveBeenCalled();
    const stored: any = await User.findById(user._id).lean();
    expect(stored).not.toHaveProperty("avatarUrl");
    expect(stored).not.toHaveProperty("avatarKey");
    expect(stored).not.toHaveProperty("avatarBucket");
    expect(stored).not.toHaveProperty("avatarPublicBaseUrl");
  });
});
