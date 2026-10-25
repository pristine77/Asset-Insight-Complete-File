import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let ReportDraft: typeof import("../src/models/reportDraft.model.js")["default"];
let userId = "";

const authHeaders = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: userId, role: "admin" },
    process.env.JWT_SECRET!,
    { expiresIn: "30m" }
  )}`,
});

const draftPayload = (revision: number, clientName: string) => ({
  clientDraftId: "revision-cas-draft",
  type: "asset",
  storageMode: "r2_media",
  revision,
  deviceId: "device-a",
  contractNo: "DRAFT-CAS-100",
  title: "Revision CAS",
  formData: { clientName },
  lots: [{ id: "lot-1", title: "Forklift" }],
  activeLotIdx: 0,
  media: [],
});

beforeAll(async () => {
  process.env.JWT_SECRET ||= "draft-revision-test-secret";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: ReportDraft } = await import("../src/models/reportDraft.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await ReportDraft.syncIndexes();
  const user = await User.create({
    email: "draft-revision@example.test",
    username: "draft-revision",
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role: "admin",
  });
  userId = String(user._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("report draft revision compare-and-set", () => {
  it("retains all 51 lots and 992 media references after a lost save acknowledgement and conflicting retry", async () => {
    const lots = Array.from({ length: 51 }, (_, index) => ({ id: `lot-${index}`, title: `Lot ${index + 1}` }));
    const media = lots.flatMap((lot, lotIndex) => Array.from({ length: lotIndex < 23 ? 20 : 19 }, (_, index) => ({
      clientFileId: `${lot.id}-photo-${index}`, localKey: `${lot.id}-photo-${index}`,
      mediaId: `${lot.id}-photo-${index}`, lotId: lot.id, slot: "main", index,
      name: `${lot.id}-${index}.jpg`, mimeType: "image/jpeg", size: 1024,
    })));
    const payload = { ...draftPayload(50, "Saved complete capture"), lots, media };
    // The server commits even if the transport subsequently loses this reply.
    const first = await request(app).post("/api/report-drafts").set(authHeaders()).send(payload);
    expect(first.status).toBe(200);
    const retry = await request(app).post("/api/report-drafts").set(authHeaders()).send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    const collision = await request(app).post("/api/report-drafts").set(authHeaders()).send({
      ...payload, formData: { clientName: "Different edit using the old revision" },
    });
    expect(collision.status).toBe(409);
    expect(collision.body.code).toBe("DRAFT_REVISION_CONFLICT");
    expect(collision.body.data.lots).toHaveLength(51);
    expect(collision.body.data.media).toHaveLength(992);
    const persisted = await ReportDraft.findOne().lean();
    expect(persisted?.lots).toHaveLength(51);
    expect(persisted?.media.map((file) => file.clientFileId)).toEqual(media.map((file) => file.clientFileId));
    expect(persisted?.formData).toEqual(payload.formData);
  });

  it("treats the same revision and payload as one idempotent save", async () => {
    const first = await request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(draftPayload(1, "North Yard"));
    const retry = await request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(draftPayload(1, "North Yard"));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(await ReportDraft.countDocuments()).toBe(1);
  });

  it("rejects different content that reuses an existing revision", async () => {
    await request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(draftPayload(1, "Original Client"));
    const collision = await request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(draftPayload(1, "Overwritten Client"));

    expect(collision.status).toBe(409);
    expect(collision.body.code).toBe("DRAFT_REVISION_CONFLICT");
    const persisted = await ReportDraft.findOne().lean();
    expect((persisted?.formData as any)?.clientName).toBe("Original Client");
  });

  it("does not mistake server-owned R2 transport progress for new user content", async () => {
    const payload = {
      ...draftPayload(1, "Media Client"),
      media: [
        {
          clientFileId: "photo-1",
          localKey: "photo-1",
          mediaId: "photo-1",
          lotId: "lot-1",
          slot: "main",
          index: 0,
          captureOrder: 0,
          originalOrder: 0,
          name: "forklift.jpg",
          mimeType: "image/jpeg",
          size: 1_024,
          lastModified: 1_788_000_000_000,
        },
      ],
    };
    await request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(payload);
    await ReportDraft.updateOne(
      { clientDraftId: payload.clientDraftId },
      {
        $set: {
          "media.0.r2Key": "uploads/report-drafts/photo-1.jpg",
          "media.0.r2Bucket": "asset-insight-test",
          "media.0.r2PublicBaseUrl": "https://assetinsight.test",
          "media.0.verifiedSize": 1_024,
          "media.0.uploadedAt": new Date(),
        },
      }
    );

    const retry = await request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(payload);

    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
  });

  it("allows only one of two competing next-revision writes", async () => {
    await request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(draftPayload(1, "Revision One"));

    const [first, second] = await Promise.all([
      request(app)
        .post("/api/report-drafts")
        .set(authHeaders())
        .send(draftPayload(2, "Tab A")),
      request(app)
        .post("/api/report-drafts")
        .set(authHeaders())
        .send(draftPayload(2, "Tab B")),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const persisted = await ReportDraft.findOne().lean();
    expect(persisted?.revision).toBe(2);
    expect(["Tab A", "Tab B"]).toContain((persisted?.formData as any)?.clientName);
  });

  it("allows only one of two competing first-revision payloads", async () => {
    const [first, second] = await Promise.all([
      request(app)
        .post("/api/report-drafts")
        .set(authHeaders())
        .send(draftPayload(1, "First Tab")),
      request(app)
        .post("/api/report-drafts")
        .set(authHeaders())
        .send(draftPayload(1, "Second Tab")),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const conflict = first.status === 409 ? first : second;
    expect(conflict.body.code).toBe("DRAFT_REVISION_CONFLICT");
    expect(await ReportDraft.countDocuments()).toBe(1);
    const persisted = await ReportDraft.findOne().lean();
    expect(persisted?.revision).toBe(1);
    expect(["First Tab", "Second Tab"]).toContain(
      (persisted?.formData as any)?.clientName
    );
  });
});
