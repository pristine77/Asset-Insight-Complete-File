import bcrypt from "bcryptjs";
import fs from "fs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import path from "path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let SavedInput: typeof import("../src/models/savedInput.model.js")["default"];
let userId = "";
const uploadUserIds = new Set<string>();

const authHeaders = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: userId, role: "admin" },
    process.env.JWT_SECRET!,
    { expiresIn: "30m" }
  )}`,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: SavedInput } = await import("../src/models/savedInput.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  const user = await User.create({
    email: "draft-metadata@example.test",
    username: "Draft Metadata",
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role: "admin",
  });
  userId = String(user._id);
  uploadUserIds.add(userId);
});

afterAll(async () => {
  for (const uploadedUserId of uploadUserIds) {
    await fs.promises.rm(
      path.resolve(process.cwd(), "uploads/drafts", uploadedUserId),
      { recursive: true, force: true }
    );
  }
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("saved draft image metadata", () => {
  it("returns upload identity metadata and preserves it when saving a draft", async () => {
    const uploaded = await request(app)
      .post("/api/saved-inputs/draft/upload")
      .set(authHeaders())
      .field("lotId", "lot-1")
      .field("type", "main")
      .field(
        "metadata",
        JSON.stringify([
          {
            clientFileId: "client-photo-1",
            size: 999,
            lastModified: 1_788_000_000_000,
          },
        ])
      )
      .attach("images", Buffer.from("draft-image"), {
        filename: "photo.jpg",
        contentType: "image/jpeg",
      });

    expect(uploaded.status).toBe(200);
    expect(uploaded.body.data[0]).toMatchObject({
      clientFileId: "client-photo-1",
      lotId: "lot-1",
      type: "main",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      size: Buffer.byteLength("draft-image"),
      lastModified: 1_788_000_000_000,
    });

    const saved = await request(app)
      .post("/api/saved-inputs/draft")
      .set(authHeaders())
      .send({
        formType: "asset",
        formData: { contractNo: "CV-100" },
        draftImages: uploaded.body.data,
      });

    expect(saved.status).toBe(201);
    expect(saved.body.data.draftImages[0]).toMatchObject({
      clientFileId: "client-photo-1",
      size: Buffer.byteLength("draft-image"),
      lastModified: 1_788_000_000_000,
    });

    const persisted = await SavedInput.findById(saved.body.data._id).lean();
    expect(persisted?.draftImages[0]).toMatchObject({
      clientFileId: "client-photo-1",
      size: Buffer.byteLength("draft-image"),
      lastModified: 1_788_000_000_000,
    });
  });

  it("continues to accept legacy draft images without identity metadata", async () => {
    const response = await request(app)
      .post("/api/saved-inputs/draft")
      .set(authHeaders())
      .send({
        formType: "asset",
        formData: { contractNo: "LEGACY-1" },
        draftImages: [
          {
            lotId: "legacy-lot",
            type: "extra",
            name: "legacy.jpg",
            url: "/uploads/drafts/legacy.jpg",
            mimeType: "image/jpeg",
          },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.draftImages[0]).toMatchObject({
      lotId: "legacy-lot",
      name: "legacy.jpg",
    });
    expect(response.body.data.draftImages[0].clientFileId).toBeUndefined();
    expect(response.body.data.draftImages[0].lastModified).toBeUndefined();
  });
});
