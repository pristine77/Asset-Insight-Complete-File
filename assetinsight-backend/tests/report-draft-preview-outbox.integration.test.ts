import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jobMocks = vi.hoisted(() => ({
  queueLotListingJob: vi.fn(),
}));

vi.mock("../src/jobs/lotListingJob.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/lotListingJob.js")>()),
  queueLotListingJob: jobMocks.queueLotListingJob,
}));

let mongo: MongoMemoryServer;
let ReportDraft: typeof import("../src/models/reportDraft.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let queueReportDraftPreview: typeof import("../src/service/reportDraftPreviewService.js")["queueReportDraftPreview"];

const originalQueueBackend = process.env.REPORT_QUEUE_BACKEND;
const originalR2BucketName = process.env.R2_BUCKET_NAME;
const originalR2Bucket = process.env.R2_BUCKET;
const originalR2PublicUrl = process.env.R2_PUBLIC_URL;
const originalR2CustomDomain = process.env.R2_CUSTOM_DOMAIN;
const originalLegacyBucket = process.env.R2_LEGACY_BUCKET_NAME;
const originalLegacyPublicUrl = process.env.R2_LEGACY_PUBLIC_URL;

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  process.env.R2_BUCKET_NAME = "asset-insight-test";
  process.env.R2_BUCKET = "asset-insight-test";
  process.env.R2_PUBLIC_URL = "https://assetinsight.test";
  process.env.R2_CUSTOM_DOMAIN = "https://assetinsight.test";
  process.env.R2_LEGACY_BUCKET_NAME = "sellsnap";
  process.env.R2_LEGACY_PUBLIC_URL = "https://images.sellsnap.store";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: ReportDraft } = await import("../src/models/reportDraft.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ queueReportDraftPreview } = await import(
    "../src/service/reportDraftPreviewService.js"
  ));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  jobMocks.queueLotListingJob.mockReset();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("REPORT_QUEUE_BACKEND", originalQueueBackend);
  restore("R2_BUCKET_NAME", originalR2BucketName);
  restore("R2_BUCKET", originalR2Bucket);
  restore("R2_PUBLIC_URL", originalR2PublicUrl);
  restore("R2_CUSTOM_DOMAIN", originalR2CustomDomain);
  restore("R2_LEGACY_BUCKET_NAME", originalLegacyBucket);
  restore("R2_LEGACY_PUBLIC_URL", originalLegacyPublicUrl);
});

describe.sequential("draft preview durable outbox", () => {
  async function draftFixture() {
    const user = await User.create({ email: "draft-mapping@example.test", username: "draft-mapping", password: "Password123!", authProvider: "email", isVerified: true, role: "admin" });
    return ReportDraft.create({ user: user._id, clientDraftId: "mapping", type: "lotListing", storageMode: "r2_media", revision: 1, contractNo: "MAPPING", formData: { location: "Regina" },
      lots: [{ id: "first", coverIndex: 1 }, { id: "second" }],
      media: ["first", "second", "first", "second", "first"].map((lotId, index) => ({
        clientFileId: `photo-${index}`, lotId, slot: index === 4 ? "extra" : "main", index, originalOrder: index, name: `${index}.jpg`, mimeType: "image/jpeg", size: 12, verifiedSize: 12, r2Key: `report-drafts/fixture/${index}.jpg`, r2Bucket: "asset-insight-test", uploadedAt: new Date(),
      })),
    });
  }

  it.each(["pending-original", "orphan-photo", "empty-lot", "duplicate-photo"])("does not queue a partial draft preview with %s", async (issue) => {
    const draft: any = await draftFixture();
    if (issue === "pending-original") draft.media[0].uploadedAt = undefined;
    if (issue === "orphan-photo") draft.media[0].lotId = "unknown";
    if (issue === "empty-lot") draft.lots.push({ id: "empty" });
    if (issue === "duplicate-photo") draft.media[1].clientFileId = draft.media[0].clientFileId;
    draft.markModified("media"); draft.markModified("lots"); await draft.save();
    const before: any = await ReportDraft.findById(draft._id).lean();
    await expect(queueReportDraftPreview(String(draft._id), String(draft.user))).rejects.toMatchObject({ code: issue === "pending-original" ? "DRAFT_MEDIA_UPLOAD_INCOMPLETE" : "INVALID_LOT_PHOTO_MAPPING" });
    const after: any = await ReportDraft.findById(draft._id).lean();
    expect(after.media).toEqual(before.media); expect(after.lots).toEqual(before.lots);
    expect(after.previewStatus).toBe(before.previewStatus);
    expect(await LotListing.countDocuments()).toBe(0);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(jobMocks.queueLotListingJob).not.toHaveBeenCalled();
  });

  it("keeps interleaved saved media inside its original lot with main photos before extras", async () => {
    const draft = await draftFixture();
    jobMocks.queueLotListingJob.mockResolvedValue(undefined);
    await queueReportDraftPreview(String(draft._id), String(draft.user));
    const input = jobMocks.queueLotListingJob.mock.calls[0][0];
    expect(input.images.map((image: any) => image.originalname)).toEqual(["0.jpg", "2.jpg", "4.jpg", "1.jpg", "3.jpg"]);
    expect(input.images.map((image: any) => image.lotIndex)).toEqual([0, 0, 0, 1, 1]);
    expect(input.details.mixed_lots).toEqual([
      { count: 2, extra_count: 1, video_count: 0, cover_index: 1, mode: "single_lot" },
      { count: 2, extra_count: 0, video_count: 0, cover_index: 0, mode: "single_lot" },
    ]);
  });

  it("publishes the draft lifecycle guard before dispatch and recovers an ambiguous Lot queue write", async () => {
    const user = await User.create({
      email: "draft-outbox@example.test",
      username: "draft-outbox",
      password: "Password123!",
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const draft = await ReportDraft.create({
      user: user._id,
      clientDraftId: "lot-draft-outbox",
      type: "lotListing",
      storageMode: "r2_media",
      revision: 4,
      contractNo: "DRAFT-OUTBOX-400",
      formData: {
        contract_no: "DRAFT-OUTBOX-400",
        sales_date: "2026-09-01T00:00:00.000Z",
        location: "Regina, SK",
        valuation_methods: ["FML"],
      },
      lots: [{ id: "lot-1", title: "Forklift" }],
      media: [
        {
          clientFileId: "photo-1",
          mediaId: "photo-1",
          lotId: "lot-1",
          slot: "main",
          index: 0,
          captureOrder: 0,
          originalOrder: 0,
          name: "forklift.jpg",
          mimeType: "image/jpeg",
          size: 12,
          verifiedSize: 12,
          r2Key: "uploads/report-drafts/lot-draft-outbox/forklift.jpg",
          r2Bucket: "asset-insight-test",
          r2PublicBaseUrl: "https://assetinsight.test",
          uploadedAt: new Date(),
        },
      ],
    });

    jobMocks.queueLotListingJob.mockImplementationOnce(async (input: any) => {
      const guarded: any = await ReportDraft.findById(draft._id).lean();
      expect(guarded).toMatchObject({
        previewStatus: "queued",
        previewRequestedRevision: 4,
        previewJobId: `draft-preview:${String(draft._id)}:r4`,
      });
      expect(String(guarded.previewReportId)).toBe(String(input.listingId));
      const report: any = await LotListing.findById(input.listingId)
        .select("+report_job_outbox")
        .lean();
      expect(report.report_job_outbox).toMatchObject({
        type: "lot-listing-preview",
        reportId: String(input.listingId),
        progressId: guarded.previewJobId,
      });
      expect(input.reportJobOutboxToken).toBe(report.report_job_outbox.token);
      throw new Error("ambiguous queue acknowledgement");
    });

    await expect(
      queueReportDraftPreview(String(draft._id), String(user._id))
    ).rejects.toMatchObject({
      code: "DRAFT_PREVIEW_QUEUE_HANDOFF_PENDING",
      statusCode: 503,
    });

    const retained: any = await ReportDraft.findById(draft._id).lean();
    expect(retained.previewStatus).toBe("queued");
    const hiddenReport: any = await LotListing.findById(retained.previewReportId)
      .select("+report_job_outbox +submission_contract_claim")
      .lean();
    expect(hiddenReport.report_job_outbox?.token).toBeTruthy();
    expect(hiddenReport.submission_contract_claim).toBeUndefined();
    expect(await ReportJob.countDocuments()).toBe(0);

    const recovered = await queueReportDraftPreview(
      String(draft._id),
      String(user._id)
    );
    expect(recovered.previewStatus).toBe("queued");
    expect(jobMocks.queueLotListingJob).toHaveBeenCalledTimes(1);
    expect(
      await ReportJob.countDocuments({
        type: "lot-listing-preview",
        reportId: String(hiddenReport._id),
        progressId: retained.previewJobId,
      })
    ).toBe(1);
    const afterRecovery: any = await LotListing.findById(hiddenReport._id)
      .select("+report_job_outbox")
      .lean();
    expect(afterRecovery.report_job_outbox).toBeUndefined();
  });
});
