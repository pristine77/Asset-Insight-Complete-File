import bcrypt from "bcryptjs";
import { Readable } from "node:stream";
import jwt from "jsonwebtoken";
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
  vi,
} from "vitest";

const r2Mocks = vi.hoisted(() => ({
  createPresignedPutUrl: vi.fn(),
  deleteFromR2: vi.fn(),
  headR2Object: vi.fn(),
  getR2ObjectStream: vi.fn(),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/r2Storage/r2Upload.js")
  >();
  return {
    ...actual,
    createR2PresignedPutUrl: r2Mocks.createPresignedPutUrl,
    deleteFromR2: r2Mocks.deleteFromR2,
    headR2Object: r2Mocks.headR2Object,
    getR2ObjectStream: r2Mocks.getR2ObjectStream,
  };
});

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let ReportDraft: typeof import("../src/models/reportDraft.model.js")["default"];
let mediaService: typeof import("../src/service/reportDraftMediaService.js");
let userId = "";

const originalEnvironment = {
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
  R2_BROWSER_DIRECT_UPLOADS_ENABLED:
    process.env.R2_BROWSER_DIRECT_UPLOADS_ENABLED,
};

const authHeaders = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: userId, role: "admin" },
    process.env.JWT_SECRET!,
    { expiresIn: "30m" },
  )}`,
});

const mediaItem = (clientFileId = "photo-1") => ({
  clientFileId,
  localKey: clientFileId,
  mediaId: clientFileId,
  lotId: "lot-1",
  slot: "main",
  index: 0,
  captureOrder: 0,
  originalOrder: 0,
  name: `${clientFileId}.jpg`,
  mimeType: "image/jpeg",
  size: 1_024,
  lastModified: 1_788_000_000_000,
});

const autosavePayload = (revision: number, media: any[]) => ({
  clientDraftId: "media-cas-draft",
  type: "asset",
  storageMode: "r2_media",
  revision,
  deviceId: "device-a",
  contractNo: "MEDIA-CAS-100",
  title: "Media CAS",
  formData: { clientName: `Revision ${revision}` },
  lots: [{ id: "lot-1", title: "Forklift" }],
  activeLotIdx: 0,
  media,
});

describe("owner-scoped original restoration", () => {
  async function savedMedia(uploaded = false, overrides: Record<string, unknown> = {}) {
    const draft = await ReportDraft.create({ user: userId, ...autosavePayload(10, [{
      ...mediaItem(), r2Key: "report-drafts/fixture/original.jpg", r2Bucket: "asset-insight-test",
      ...(uploaded ? { uploadedAt: new Date() } : {}), ...overrides,
    }]) });
    return { draft, url: `/api/report-drafts/${draft._id}/media/photo-1/content` };
  }

  it.each([false, true])("streams the exact saved original with confirmation=%s without changing metadata", async (uploaded) => {
    const { draft, url } = await savedMedia(uploaded);
    const before = await ReportDraft.findById(draft._id).lean();
    const bytes = Buffer.alloc(1024, 42);
    r2Mocks.getR2ObjectStream.mockResolvedValue({ contentLength: bytes.length, stream: Readable.from(bytes) });
    const response = await request(app).get(url).set(authHeaders());
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bytes);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(r2Mocks.getR2ObjectStream).toHaveBeenCalledWith("asset-insight-test", "report-drafts/fixture/original.jpg");
    expect(await ReportDraft.findById(draft._id).lean()).toEqual(before);
    expect(r2Mocks.deleteFromR2).not.toHaveBeenCalled();
    expect(r2Mocks.createPresignedPutUrl).not.toHaveBeenCalled();
  });

  it.each([0, 512, undefined])("rejects missing/mismatched object size %s without returning partial bytes", async (size) => {
    const { url } = await savedMedia();
    const stream = Readable.from(Buffer.alloc(512));
    r2Mocks.getR2ObjectStream.mockResolvedValue({ contentLength: size, stream });
    const response = await request(app).get(url).set(authHeaders());
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("DRAFT_MEDIA_SIZE_MISMATCH");
    expect(stream.destroyed).toBe(true);
  });

  it.each([false, true])("explains missing originals with confirmation=%s and retains the draft", async (uploaded) => {
    const { draft, url } = await savedMedia(uploaded);
    const before = await ReportDraft.findById(draft._id).lean();
    r2Mocks.getR2ObjectStream.mockRejectedValue(Object.assign(new Error("private bucket path"), { name: "NoSuchKey" }));
    const response = await request(app).get(url).set(authHeaders());
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("DRAFT_MEDIA_MISSING");
    expect(JSON.stringify(response.body)).not.toContain("private");
    expect(await ReportDraft.findById(draft._id).lean()).toEqual(before);
  });

  it("does not read objects for another owner or a changed media identity", async () => {
    const { draft, url } = await savedMedia();
    const changed = await request(app).get(url.replace("photo-1", "other-photo")).set(authHeaders());
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("DRAFT_MEDIA_CHANGED");
    await ReportDraft.updateOne({ _id: draft._id }, { $set: { user: new mongoose.Types.ObjectId() } });
    expect((await request(app).get(url).set(authHeaders())).status).toBe(404);
    expect(r2Mocks.getR2ObjectStream).not.toHaveBeenCalled();
  });

  it("distinguishes an unuploaded file and redacts provider failures", async () => {
    const { draft, url } = await savedMedia(false, { r2Key: undefined });
    const incomplete = await request(app).get(url).set(authHeaders());
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.code).toBe("DRAFT_MEDIA_UPLOAD_INCOMPLETE");
    expect(r2Mocks.getR2ObjectStream).not.toHaveBeenCalled();
    await ReportDraft.updateOne({ _id: draft._id }, { $set: { "media.0.r2Key": "report-drafts/fixture/original.jpg" } });
    r2Mocks.getR2ObjectStream.mockRejectedValue(new Error("secret signed storage request"));
    const unavailable = await request(app).get(url).set(authHeaders());
    expect(unavailable.status).toBe(502);
    expect(unavailable.body.code).toBe("DRAFT_MEDIA_UNAVAILABLE");
    expect(JSON.stringify(unavailable.body)).not.toContain("secret");
  });
});

beforeAll(async () => {
  process.env.JWT_SECRET ||= "draft-media-concurrency-secret";
  process.env.R2_BUCKET_NAME = "asset-insight-test";
  process.env.R2_PUBLIC_URL = "https://assetinsight.test";
  process.env.R2_BROWSER_DIRECT_UPLOADS_ENABLED = "true";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: ReportDraft } = await import(
    "../src/models/reportDraft.model.js"
  ));
  mediaService = await import("../src/service/reportDraftMediaService.js");
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await ReportDraft.syncIndexes();
  r2Mocks.createPresignedPutUrl.mockReset();
  r2Mocks.deleteFromR2.mockReset();
  r2Mocks.headR2Object.mockReset();
  r2Mocks.getR2ObjectStream.mockReset();
  r2Mocks.createPresignedPutUrl.mockResolvedValue(
    "https://upload.example.test/presigned",
  );
  r2Mocks.deleteFromR2.mockResolvedValue(undefined);
  r2Mocks.headR2Object.mockResolvedValue({ size: 1_024 });
  const user = await User.create({
    email: "draft-media-concurrency@example.test",
    username: "draft-media-concurrency",
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
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe.sequential("report draft media concurrency", () => {
  it("preserves a target allocated while the next autosave revision commits", async () => {
    const item = mediaItem();
    await request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(autosavePayload(1, [item]));
    const draft: any = await ReportDraft.findOne({
      clientDraftId: "media-cas-draft",
    });

    let targetStarted!: () => void;
    let releaseTarget!: () => void;
    const targetStartedPromise = new Promise<void>((resolve) => {
      targetStarted = resolve;
    });
    const targetGate = new Promise<void>((resolve) => {
      releaseTarget = resolve;
    });
    r2Mocks.createPresignedPutUrl.mockImplementation(async () => {
      targetStarted();
      await targetGate;
      return "https://upload.example.test/presigned";
    });

    const targetPromise = mediaService.createDraftMediaTargets(draft, [item]);
    await targetStartedPromise;
    const autosavePromise = request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(autosavePayload(2, [item]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseTarget();

    const [targets, autosave] = await Promise.all([
      targetPromise,
      autosavePromise,
    ]);
    expect(autosave.status).toBe(200);
    expect(targets).toHaveLength(1);
    const persisted: any = await ReportDraft.findById(draft._id)
      .select("+mediaRevision")
      .lean();
    expect(persisted).toMatchObject({ revision: 2 });
    expect(persisted.media).toHaveLength(1);
    expect(persisted.media[0]).toMatchObject({
      clientFileId: "photo-1",
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
    });
    expect(String(persisted.media[0].r2Key || "")).toMatch(
      /^report-drafts\//,
    );
    expect(persisted.mediaRevision).toBeGreaterThanOrEqual(3);
  });

  it("preserves confirmation when autosave races the R2 verification", async () => {
    const item = {
      ...mediaItem(),
      r2Key: "report-drafts/user/draft/pending-photo.jpg",
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
    };
    const draft: any = await ReportDraft.create({
      user: userId,
      clientDraftId: "media-cas-draft",
      type: "asset",
      storageMode: "r2_media",
      revision: 1,
      mediaRevision: 1,
      contractNo: "MEDIA-CAS-100",
      formData: { clientName: "Revision 1" },
      lots: [{ id: "lot-1", title: "Forklift" }],
      media: [item],
    });

    let headStarted!: () => void;
    let releaseHead!: () => void;
    const headStartedPromise = new Promise<void>((resolve) => {
      headStarted = resolve;
    });
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    r2Mocks.headR2Object.mockImplementation(async () => {
      headStarted();
      await headGate;
      return { size: 1_024 };
    });

    const confirmPromise = mediaService.confirmDraftMedia(draft, ["photo-1"]);
    await headStartedPromise;
    const autosavePromise = request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(autosavePayload(2, [mediaItem()]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseHead();

    const [, autosave] = await Promise.all([confirmPromise, autosavePromise]);
    expect(autosave.status).toBe(200);
    const persisted: any = await ReportDraft.findById(draft._id).lean();
    expect(persisted).toMatchObject({ revision: 2 });
    expect(persisted.media[0]).toMatchObject({
      clientFileId: "photo-1",
      r2Key: item.r2Key,
      verifiedSize: 1_024,
    });
    expect(persisted.media[0].uploadedAt).toBeInstanceOf(Date);
  });

  it("never resurrects a physically deleted R2 key from a stale autosave", async () => {
    const deletedKey = "report-drafts/user/draft/deleted-photo.jpg";
    const item = {
      ...mediaItem(),
      r2Key: deletedKey,
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      uploadedAt: new Date(),
      verifiedSize: 1_024,
    };
    const draft: any = await ReportDraft.create({
      user: userId,
      clientDraftId: "media-cas-draft",
      type: "asset",
      storageMode: "r2_media",
      revision: 1,
      mediaRevision: 1,
      contractNo: "MEDIA-CAS-100",
      formData: { clientName: "Revision 1" },
      lots: [{ id: "lot-1", title: "Forklift" }],
      media: [item],
    });

    await mediaService.deleteSelectedDraftMedia(draft, ["photo-1"]);
    const staleAutosave = await request(app)
      .post("/api/report-drafts")
      .set(authHeaders())
      .send(autosavePayload(2, [mediaItem()]));

    expect(staleAutosave.status).toBe(200);
    const persisted: any = await ReportDraft.findById(draft._id).lean();
    expect(
      persisted.media.some((entry: any) => entry.r2Key === deletedKey),
    ).toBe(false);
    expect(r2Mocks.deleteFromR2).toHaveBeenCalledWith(
      "asset-insight-test",
      deletedKey,
    );
  });
});
