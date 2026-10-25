import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as string[], xlsx: vi.fn(), lotXlsx: vi.fn(), zip: vi.fn(), upload: vi.fn(),
  connection: vi.fn(), start: vi.fn(), chunk: vi.fn(), check: vi.fn(), publish: vi.fn(),
}));
vi.mock("dotenv", () => ({ default: { config: () => ({}) }, config: () => ({}) }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: vi.fn(async () => ({ output_text: "{}" })) } } }));
vi.mock("../src/service/youtubeConnectionService.js", async (original) => ({
  ...await original<typeof import("../src/service/youtubeConnectionService.js")>(),
  getYoutubeConnection: mocks.connection,
  assertYoutubeConnection: async () => ({ channelId: `UC${"a".repeat(22)}`, revision: 7 }),
  getYoutubeAccessToken: async () => "isolated-provider-token",
  encryptYoutubeSecret: (value: string) => `encrypted:${value}`,
  decryptYoutubeSecret: (value: string) => value.slice("encrypted:".length),
}));
vi.mock("../src/service/youtubeVideoClient.js", async (original) => ({
  ...await original<typeof import("../src/service/youtubeVideoClient.js")>(),
  startYoutubeUpload: mocks.start, sendYoutubeChunk: mocks.chunk, checkYoutubeUpload: mocks.check, publishYoutubeVideo: mocks.publish,
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (original) => ({
  ...await original<typeof import("../src/utils/r2Storage/r2Upload.js")>(),
  uploadBufferToR2: mocks.upload,
  uploadFilePathToR2: vi.fn(async () => { throw new Error("Unexpected original upload"); }),
  copyR2Object: vi.fn(async () => {}), deleteFromR2: vi.fn(async () => {}),
  headR2Object: vi.fn(async () => ({ size: 19, etag: "fixture-etag", contentType: "video/mp4" })),
  readR2ObjectRange: vi.fn(async () => Buffer.from("original clip bytes")),
}));
vi.mock("../src/service/xlsx/assetXlsxService.js", async (original) => ({
  ...await original<typeof import("../src/service/xlsx/assetXlsxService.js")>(),
  generateAssetXlsxFromReport: mocks.xlsx, generateLotListingXlsxFromReport: mocks.lotXlsx,
}));
vi.mock("../src/service/assetDocxService.js", () => ({ generateAssetDocxFromReport: vi.fn(async () => Buffer.from("docx")) }));
vi.mock("../src/service/scheduleAReportPdfService.js", async (original) => ({
  ...await original<typeof import("../src/service/scheduleAReportPdfService.js")>(),
  generateScheduleAPdfFromReport: vi.fn(async () => Buffer.from("schedule")),
  generateAndUploadScheduleAPdf: vi.fn(async () => ({ url: "https://assetinsight.test/schedule.pdf" })),
}));
vi.mock("../src/service/assetSchedulePdfService.js", () => ({ generateAssetSchedulePdfFromReport: vi.fn(async () => Buffer.from("pdf")) }));
vi.mock("../src/service/auctioneerSpecSheetPdfService.js", async (original) => ({
  ...await original<typeof import("../src/service/auctioneerSpecSheetPdfService.js")>(), generateAuctioneerSpecSheetPdfFromReport: vi.fn(async () => Buffer.from("pdf")),
}));
vi.mock("../src/service/auctioneerSpecSheetDocxService.js", () => ({ generateAuctioneerSpecSheetDocxFromReport: vi.fn(async () => Buffer.from("docx")) }));
vi.mock("../src/jobs/assetReportJob/imagesZip.js", () => ({ generateImagesZip: mocks.zip }));
vi.mock("../src/service/assetOpenAIService.js", () => ({
  analyzeAssetImages: vi.fn(async () => ({ lots: [{ lot_number: "77", title: "Reviewed Truck", description: "Description", estimated_value: "CAD 1000", image_indexes: [0], categories: "Trucks" }] })),
  normalizeAssetAiLot: (lot: unknown) => lot,
}));
vi.mock("../src/service/lotListingSpecEnrichmentService.js", () => ({ enrichLotListingSpecs: vi.fn(async ({ lots }) => ({ lots, analyses: [] })), enrichAuctioneerImportSpecs: vi.fn(async ({ lots }) => ({ lots, analyses: [] })) }));
vi.mock("../src/service/bundleLotAnalysisPolicy.js", async (original) => ({ ...await original<typeof import("../src/service/bundleLotAnalysisPolicy.js")>(), detectBundleLotNumbersFromPhotos: vi.fn(async () => new Map([[0, "77"]])) }));
vi.mock("../src/service/vehicleApiService.js", async (original) => ({ ...await original<typeof import("../src/service/vehicleApiService.js")>(), enrichLotsWithVin: async (lots: any[]) => lots }));
vi.mock("../src/service/assetOpenAIService/imageUtils.js", () => ({ registerFocusBoxes: vi.fn(), clearFocusBoxes: vi.fn(), imageUrlToBase64WithMime: vi.fn(async () => ({ base64: "ZmFrZQ==", mime: "image/jpeg" })) }));
vi.mock("../src/service/assetEmailService.js", async (original) => ({ ...await original<typeof import("../src/service/assetEmailService.js")>(), sendPreviewReadyEmail: vi.fn(async () => {}), sendAssetReportEmail: vi.fn(async () => {}) }));
vi.mock("../src/utils/sendVerificationEmail.js", async (original) => ({ ...await original<typeof import("../src/utils/sendVerificationEmail.js")>(), sendEmail: vi.fn(async () => {}), sendTransactionalEmail: vi.fn(async () => {}) }));
vi.mock("../src/service/notificationService.js", () => ({ notifyUser: vi.fn(async () => {}) }));
vi.mock("../src/utils/expoPush.js", async (original) => ({ ...await original<typeof import("../src/utils/expoPush.js")>(), sendExpoPushNotifications: vi.fn(async () => {}) }));
vi.mock("../src/service/auctionsoftLotListingPush.js", () => ({ pushAuctionsoftLotListingIfReady: vi.fn(async () => {}) }));

import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import YoutubeVideo from "../src/models/youtubeVideo.model.js";
import User from "../src/models/user.model.js";
import assetRoutes from "../src/routes/asset.routes.js";
import lotRoutes from "../src/routes/lotListing.routes.js";
import youtubeRoutes from "../src/routes/youtube.routes.js";
import { runPreviewFilesJob } from "../src/jobs/assetReportJob/previewFilesJob.js";
import { runAssetPreviewJob } from "../src/jobs/assetReportJob/previewJob.js";
import { runLotListingJob, runRegenerateLotListingJob } from "../src/jobs/lotListingJob.js";
import { runExcelCrRegenerationJob } from "../src/jobs/excelCrRegenerationJob.js";
import { authorizeAutomaticYoutubeVideos, prepareReportYoutubeVideos, publishReleasedYoutubeVideos, readReportYoutubeLinks, uploadReviewedYoutubeVideos } from "../src/service/youtubeVideoService.js";
import { youtubeAutomaticLotMetadata, youtubeLotMetadata, youtubeVideoIdentity } from "../src/service/youtubeVideoPolicy.js";

type Kind = "asset" | "lotListing";
const app = express(); app.use(express.json()); app.use("/api/asset", assetRoutes); app.use("/api/lot-listing", lotRoutes);
app.use("/api/admin/youtube", youtubeRoutes);
const owner = new mongoose.Types.ObjectId(), otherOwner = new mongoose.Types.ObjectId(), reviewer = new mongoose.Types.ObjectId();
const video = "https://assetinsight.test/uploads/video.mp4";
const photo = "https://assetinsight.test/uploads/photo.jpg";
const channel = `UC${"a".repeat(22)}`;
const youtubeUrl = "https://www.youtube.com/watch?v=abcdefghijk";
const model = (kind: Kind): any => kind === "asset" ? AssetReport : LotListing;
const route = (kind: Kind, id: unknown, action: string) => `/api/${kind === "asset" ? "asset" : "lot-listing"}/${id}/${action}`;
const headers = () => ({ Authorization: `Bearer ${jwt.sign({ id: String(owner), role: "user" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` });
async function authorizeVideo(id: string) {
  await authorizeAutomaticYoutubeVideos();
  const receipt = await YoutubeVideo.findById(id).select("+description +publicationToken").lean();
  expect(receipt).toMatchObject({ privacyStatus: "public", publicationToken: expect.any(String) });
  expect(receipt!.reviewedBy).toBeUndefined();
  return { title: receipt!.title, description: receipt!.description };
}
const lot = () => ({ lot_id: "fixture-lot", lot_number: "77", title: "Reviewed Truck", description: "Reviewed condition narrative.", categories: "Trucks", serial_number: "SN-777", condition_report_specs: { Manufacturer: "Acme", Model: "Truck", "Serial Number": "SN-777" }, condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" }, estimated_value: "CAD 1000", image_indexes: [0], image_urls: [photo], video_urls: [video] });
async function report(kind: Kind, fields: Record<string, any> = {}) {
  const lots = [lot()];
  return model(kind).create({ user: owner, grouping_mode: "single_lot", imageUrls: [photo], videoUrls: [video], lots, contract_no: "YT-WORKFLOW", sales_date: new Date("2026-09-01"), location: "Regina, SK", currency: "CAD", valuation_methods: ["FML"], include_damage_analysis: false, is_merged_report: kind === "asset", status: "preview", job_status: "done", preview_data: { lots, videoUrls: [video], contract_no: "YT-WORKFLOW", currency: "CAD", total_value: 1000, valuation_methods: ["FML"], include_damage_analysis: false }, ...fields });
}
let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
beforeEach(async () => {
  vi.clearAllMocks(); mocks.events.length = 0;
  vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off"); vi.stubEnv("REPORT_QUEUE_BACKEND", "mongo");
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([AssetReport.syncIndexes(), LotListing.syncIndexes(), ReportJob.syncIndexes(), YoutubeVideo.syncIndexes()]);
  await User.collection.insertMany([{ _id: owner, username: "Fixture Owner", email: "owner@example.test", role: "user", isVerified: true }, { _id: otherOwner, username: "Other", email: "other@example.test", role: "user", isVerified: true }, { _id: reviewer, username: "Reviewer", email: "reviewer@example.test", role: "admin", isVerified: true }]);
  mocks.connection.mockResolvedValue({ channelId: channel, channelTitle: "Fixture Channel", revision: 7, connectedAt: new Date().toISOString() });
  mocks.start.mockImplementation(async () => { mocks.events.push("start"); return "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture"; });
  mocks.chunk.mockImplementation(async () => { mocks.events.push("chunk"); return { videoId: "abcdefghijk", url: youtubeUrl }; });
  mocks.check.mockResolvedValue({ videoId: "abcdefghijk", url: youtubeUrl });
  mocks.xlsx.mockImplementation(async () => { mocks.events.push("xlsx"); return Buffer.from("xlsx"); });
  mocks.lotXlsx.mockImplementation(async () => { mocks.events.push("xlsx"); return Buffer.from("xlsx"); });
  mocks.zip.mockResolvedValue(Buffer.from("original-media-zip"));
  mocks.upload.mockImplementation(async (_bytes, _type, _bucket, key) => `https://assetinsight.test/${key}`);
});
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo.stop(); });

describe.sequential("YouTube integration through real report workflow seams", () => {
  it.each(["asset", "lotListing"] as const)("%s explicit submit persists intent and outbox in the same guarded parent write", async (kind) => {
    const saved = await report(kind);
    const update = vi.spyOn(model(kind).collection, "updateOne");
    const result = await request(app).post(route(kind, saved._id, "submit-approval")).set(headers()).send({});
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const stored = await model(kind).findById(saved._id).select("+youtube_submission").lean();
    expect(stored.youtube_submission).toEqual({ generationToken: stored.job_id, uploadGenerationToken: stored.job_id, channelId: channel, connectionRevision: 7, ownerId: String(owner) });
    expect(stored.youtube_videos_enabled).toBe(true);
    const write: any = update.mock.calls.find((call: any) => call[1]?.$set?.youtube_submission)?.[1];
    expect(write.$set.report_job_outbox.payload.generationToken).toBe(stored.job_id);
    expect(write.$set.youtube_submission.generationToken).toBe(write.$set.job_id);
    expect(await ReportJob.countDocuments({ reportId: String(saved._id), progressId: stored.job_id })).toBe(1);
    expect(JSON.stringify(result.body)).not.toContain("youtube_submission");
    expect((await model(kind).findById(saved._id).lean())).not.toHaveProperty("youtube_submission");
    expect(mocks.start).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it.each(["asset", "lotListing"] as const)("%s resubmit refreshes explicit intent while an active retry retains one generation", async (kind) => {
    const saved = await report(kind, { status: "approved", release_status: "released", youtube_videos_enabled: true, youtube_submission: { generationToken: "prior", channelId: channel, connectionRevision: 6, ownerId: String(owner) } });
    const update = vi.spyOn(model(kind).collection, "updateOne");
    const result = await request(app).post(route(kind, saved._id, "resubmit")).set(headers()).send({});
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const stored = await model(kind).findById(saved._id).select("+youtube_submission").lean();
    expect(stored.youtube_submission).toMatchObject({ generationToken: stored.job_id, connectionRevision: 7 });
    expect(stored.job_id).not.toBe("prior");
    const write: any = update.mock.calls.find((call: any) => call[1]?.$set?.youtube_submission)?.[1];
    expect(write.$set.youtube_submission.generationToken).toBe(write.$set.report_job_outbox.payload.generationToken);
    expect(JSON.stringify(result.body)).not.toContain("youtube_submission");
    const retried = await request(app).post(route(kind, saved._id, "resubmit")).set(headers()).send({});
    expect(retried.status, JSON.stringify(retried.body)).toBe(202);
    expect(await ReportJob.countDocuments({ reportId: String(saved._id) })).toBe(1);
    expect(mocks.connection).toHaveBeenCalledTimes(1);
    update.mockRestore();
  });

  it.each(["asset", "lotListing"] as const)("%s concurrent save rejects the entire publication-intent/outbox transition", async (kind) => {
    const saved = await report(kind);
    mocks.connection.mockImplementationOnce(async () => {
      await model(kind).collection.updateOne({ _id: saved._id }, { $set: { updatedAt: new Date(Date.now() + 1000), "preview_data.lots.0.title": "Concurrent reviewed title" } });
      return { channelId: channel, revision: 7 };
    });
    const result = await request(app).post(route(kind, saved._id, "submit-approval")).set(headers()).send({});
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    const current = await model(kind).findById(saved._id).select("+youtube_submission +report_job_outbox").lean();
    expect(current).not.toHaveProperty("youtube_submission");
    expect(current).not.toHaveProperty("report_job_outbox");
    expect(current.files_generating).not.toBe(true);
    expect(current.preview_data.lots[0].title).toBe("Concurrent reviewed title");
    expect(await ReportJob.countDocuments({ reportId: String(saved._id) })).toBe(0);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("%s save and unavailable-channel submit cannot create publication intent", async (kind) => {
    const saved = await report(kind);
    const result = await request(app).put(route(kind, saved._id, "preview")).set(headers()).send({ preview_data: saved.preview_data });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(mocks.connection).not.toHaveBeenCalled();
    expect((await model(kind).findById(saved._id).select("+youtube_submission").lean())).not.toHaveProperty("youtube_submission");
    mocks.connection.mockResolvedValue(null);
    expect((await request(app).post(route(kind, saved._id, "submit-approval")).set(headers()).send({})).status).toBe(202);
    expect((await model(kind).findById(saved._id).select("+youtube_submission").lean())).not.toHaveProperty("youtube_submission");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("%s files finish independently before automatic video upload, retaining original ZIP media", async (kind) => {
    const saved = await report(kind);
    const response = await request(app).post(route(kind, saved._id, "submit-approval")).set(headers()).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const queued = await ReportJob.findOne({ reportId: String(saved._id) }).lean();
    const spreadsheet = kind === "asset" ? mocks.xlsx : mocks.lotXlsx;
    spreadsheet.mockImplementationOnce(async () => {
      const durable = await YoutubeVideo.findOne({ reportId: saved._id }).lean();
      expect(durable).toMatchObject({ status: "queued" });
      expect(durable).not.toHaveProperty("videoId");
      mocks.events.push("xlsx");
      return Buffer.from("xlsx");
    });
    if (kind === "asset") await runPreviewFilesJob(String(saved._id), { jobId: queued!.progressId, targetStatus: queued!.targetStatus, previewDataSnapshot: queued!.payload.previewDataSnapshot });
    else await runRegenerateLotListingJob({ listingId: String(saved._id), user: { id: String(owner), email: "owner@example.test" }, generationToken: queued!.progressId, previewDataSnapshot: queued!.payload.previewDataSnapshot });
    expect(mocks.events).toContain("xlsx");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.chunk).not.toHaveBeenCalled();
    expect(spreadsheet.mock.calls.at(-1)).toHaveLength(1);
    const receipt = await YoutubeVideo.findOne({ reportId: saved._id }).lean();
    expect(receipt).toMatchObject({ status: "queued", generationToken: queued!.progressId });
    expect(receipt).not.toHaveProperty("sessionCipher");
    expect(mocks.zip.mock.calls.at(-1)![2].rawFiles.map((entry: any) => entry.url)).toEqual([video]);
    expect(mocks.upload.mock.calls.every(([, type]) => !/^(?:video|image)\//.test(type))).toBe(true);
    expect((await model(kind).findById(saved._id).lean()).videoUrls).toEqual([video]);
    expect(mocks.publish).not.toHaveBeenCalled();
    const beforeReview = await model(kind).findById(saved._id).lean();
    await authorizeVideo(receipt!._id);
    expect(mocks.start).not.toHaveBeenCalled();
    await uploadReviewedYoutubeVideos();
    expect(await YoutubeVideo.findById(receipt!._id).lean()).toMatchObject({ status: "private", videoId: "abcdefghijk", url: youtubeUrl });
    expect(await model(kind).findById(saved._id).lean()).toEqual(beforeReview);
    expect(await readReportYoutubeLinks({ reportType: kind, reportId: String(saved._id), enabled: true })).toEqual(new Map([[video, youtubeUrl]]));
  });

  it.each(["asset", "lotListing"] as const)("%s ordinary approved-preview save preserves video links separately from Excel", async (kind) => {
    const saved = await report(kind, { status: "approved", job_id: "old-submission", release_status: "released", youtube_videos_enabled: true, youtube_submission: { generationToken: "old-submission", channelId: channel, connectionRevision: 7, ownerId: String(owner) } });
    await YoutubeVideo.create({ _id: `existing-${kind}`, reportType: kind, reportId: saved._id, ownerId: owner, channelId: channel, connectionRevision: 7, generationToken: "old-submission", sourceUrl: video, videoId: "abcdefghijk", url: youtubeUrl, status: "public", title: "Frozen public title", description: "Frozen public description" });
    const edited = structuredClone(saved.preview_data.toObject?.() || saved.preview_data);
    edited.lots[0].title = "Edited reviewed truck";
    const response = await request(app).put(route(kind, saved._id, "preview")).set(headers()).send({ preview_data: edited });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const current = await model(kind).findById(saved._id).select("+youtube_submission").lean();
    expect(current.youtube_submission.generationToken).toBe("old-submission");
    expect(current.job_id).not.toBe("old-submission");
    const queued = await ReportJob.findOne({ reportId: String(saved._id) }).lean();
    if (kind === "asset") await runPreviewFilesJob(String(saved._id), { jobId: queued!.progressId, targetStatus: queued!.targetStatus, previewDataSnapshot: queued!.payload.previewDataSnapshot });
    else await runRegenerateLotListingJob({ listingId: String(saved._id), user: { id: String(owner), email: "owner@example.test" }, generationToken: queued!.progressId, previewDataSnapshot: queued!.payload.previewDataSnapshot });
    expect((kind === "asset" ? mocks.xlsx : mocks.lotXlsx).mock.calls.at(-1)).toHaveLength(1);
    expect(await readReportYoutubeLinks({ reportType: kind, reportId: String(saved._id), enabled: true })).toEqual(new Map([[video, youtubeUrl]]));
    expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
    expect(await YoutubeVideo.countDocuments({ reportId: saved._id })).toBe(1);
    expect(await YoutubeVideo.findById(`existing-${kind}`).select("+description").lean()).toMatchObject({ title: "Frozen public title", description: "Frozen public description" });
  });

  it.each(["asset", "lotListing"] as const)("%s initial preview creates no YouTube intent or provider upload", async (kind) => {
    const images: any[] = [{ r2Key: "uploads/photo.jpg", r2Bucket: "asset-insight-test", r2PublicUrl: photo, originalname: "photo.jpg", mimetype: "image/jpeg" }];
    const videos: any[] = [{ r2Key: "uploads/video.mp4", r2Bucket: "asset-insight-test", r2PublicUrl: video, originalname: "video.mp4", mimetype: "video/mp4", lotIndex: 0 }];
    const details = { contract_no: "YT-INITIAL", sales_date: "2026-09-01", location: "Regina, SK", grouping_mode: "mixed", draft_preview: true, include_damage_analysis: false, mixed_lots: [{ count: 1, mode: "single_lot", video_count: 1 }], valuation_methods: ["FML"] };
    if (kind === "asset") await runAssetPreviewJob({ user: { id: String(owner), email: "owner@example.test" }, images, videos, details });
    else await runLotListingJob({ user: { id: String(owner), email: "owner@example.test" }, images, videos, details });
    const stored = await model(kind).findOne({ user: owner }).select("+youtube_submission").lean();
    expect(stored.status).toBe("preview"); expect(stored.videoUrls).toEqual([video]);
    expect(stored.youtube_submission).toBeUndefined(); expect(stored.youtube_videos_enabled).not.toBe(true);
    expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    expect(await YoutubeVideo.countDocuments()).toBe(0);
  });

  it("carries a private Asset upload through an edit and automatically publishes its saved details only after release", async () => {
    const saved = await report("asset");
    await User.updateOne({ _id: owner }, { $set: { reportApprover: otherOwner } });
    await AssetReport.updateOne({ _id: saved._id }, { $set: { "preview_data.lots.0.estimated_value": "CAD 1000000" } });
    expect((await request(app).post(route("asset", saved._id, "submit-approval")).set(headers()).send({})).status).toBe(202);
    const original = await ReportJob.findOne({ reportId: String(saved._id) }).lean();
    await runPreviewFilesJob(String(saved._id), { jobId: original!.progressId, targetStatus: "pending_approval", previewDataSnapshot: original!.payload.previewDataSnapshot });
    const awaiting = await YoutubeVideo.findOne({ reportId: saved._id }).lean();
    await authorizeVideo(awaiting!._id);
    await uploadReviewedYoutubeVideos();
    const uploaded = await YoutubeVideo.findOne({ reportId: saved._id }).lean();
    expect(uploaded).toMatchObject({ generationToken: original!.progressId, status: "private" });
    expect((await AssetReport.findById(saved._id).lean())!.status).toBe("pending_approval");
    // The dispatcher, outside runPreviewFilesJob, normally acknowledges completion.
    await ReportJob.updateOne({ _id: original!._id }, { $set: { status: "completed" }, $unset: { dedupeKey: 1 } });
    const edited = structuredClone(saved.preview_data.toObject?.() || saved.preview_data);
    edited.lots[0].title = "Final reviewed truck";
    edited.lots[0].description = "Final reviewed public condition narrative.";
    edited.lots[0].estimated_value = "CAD 1000000";
    mocks.start.mockClear(); mocks.chunk.mockClear();
    const response = await request(app).put(route("asset", saved._id, "preview")).set(headers()).send({ preview_data: edited });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const accepted = await AssetReport.findById(saved._id).select("+youtube_submission").lean();
    const regenerated = await ReportJob.findOne({ progressId: accepted!.job_id }).lean();
    expect(regenerated!.targetStatus).toBe("pending_approval");
    await runPreviewFilesJob(String(saved._id), { jobId: regenerated!.progressId, targetStatus: regenerated!.targetStatus, previewDataSnapshot: regenerated!.payload.previewDataSnapshot });
    const pending = await AssetReport.findById(saved._id).select("+youtube_submission").lean();
    expect(pending!.status).toBe("pending_approval");
    expect(pending!.youtube_submission).toMatchObject({ generationToken: regenerated!.progressId, uploadGenerationToken: original!.progressId });
    expect(await YoutubeVideo.findById(uploaded!._id).select("+description").lean()).toMatchObject({ status: "private", generationToken: regenerated!.progressId, ...youtubeLotMetadata(edited.lots[0]) });
    expect(mocks.xlsx.mock.calls.at(-1)).toHaveLength(1);
    expect(await readReportYoutubeLinks({ reportType: "asset", reportId: String(saved._id), enabled: true })).toEqual(new Map([[video, youtubeUrl]]));
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
    expect(await publishReleasedYoutubeVideos()).toBe(0);
    expect(mocks.publish).not.toHaveBeenCalled();
    // The release decision remains separate from file generation and video upload.
    await AssetReport.updateOne({ _id: saved._id }, { $set: { status: "approved", release_status: "released" } });
    await YoutubeVideo.updateOne({ _id: uploaded!._id }, { $set: { nextAttemptAt: new Date(0) } });
    const reviewedMetadata = youtubeAutomaticLotMetadata(edited.lots[0]);
    mocks.publish.mockImplementationOnce(async (_access, _id, _channel, authorize) => { await authorize(); return true; });
    expect(await publishReleasedYoutubeVideos()).toBe(1);
    expect(mocks.publish.mock.calls.at(-1)![4]).toEqual({ title: reviewedMetadata.title, description: reviewedMetadata.description });
    expect(mocks.publish.mock.calls.at(-1)![5]).toBe("public");
    expect((await YoutubeVideo.findById(uploaded!._id).lean())!.status).toBe("public");
  });

  it.each(["asset", "lotListing"] as const)("%s restarted artifact regeneration cannot gain upload authority for newly added clips", async (kind) => {
    const generationToken = `automatic-${kind}`;
    const saved = await report(kind, { status: "processing", job_status: "processing", job_id: generationToken, youtube_videos_enabled: true, youtube_submission: { generationToken: "original-explicit", uploadGenerationToken: "original-explicit", channelId: channel, connectionRevision: 7, ownerId: String(owner) } });
    await YoutubeVideo.create({ _id: `private-${kind}`, reportType: kind, reportId: saved._id, ownerId: owner, channelId: channel, connectionRevision: 7, generationToken: "original-explicit", sourceUrl: video, videoId: "abcdefghijk", url: youtubeUrl, status: "private" });
    const input = { reportType: kind, reportId: String(saved._id), enabled: true, generationToken, lots: [lot()], assertOwned: async () => {} };
    expect(await prepareReportYoutubeVideos(input)).toEqual(new Map([[video, youtubeUrl]]));
    const additional = "https://assetinsight.test/uploads/not-explicitly-submitted.mp4";
    await model(kind).updateOne({ _id: saved._id }, { $push: { videoUrls: additional } });
    expect(await prepareReportYoutubeVideos({ ...input, lots: [{ ...lot(), video_urls: [video, additional] }] })).toEqual(new Map([[video, youtubeUrl]]));
    expect((await model(kind).findById(saved._id).select("+youtube_submission").lean()).youtube_submission).toMatchObject({ generationToken, uploadGenerationToken: "original-explicit" });
    expect(await YoutubeVideo.countDocuments({ reportId: saved._id })).toBe(1);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("%s owner change cannot carry a previous owner's private video authority", async (kind) => {
    const saved = await report(kind, { user: otherOwner, status: "processing", job_status: "processing", job_id: "automatic", youtube_videos_enabled: true, youtube_submission: { generationToken: "old-explicit", uploadGenerationToken: "old-explicit", channelId: channel, connectionRevision: 7, ownerId: String(owner) } });
    await YoutubeVideo.create({ _id: `old-owner-${kind}`, reportType: kind, reportId: saved._id, ownerId: owner, channelId: channel, connectionRevision: 7, generationToken: "old-explicit", sourceUrl: video, videoId: "abcdefghijk", url: youtubeUrl, status: "private" });
    expect(await prepareReportYoutubeVideos({ reportType: kind, reportId: String(saved._id), enabled: true, generationToken: "automatic", lots: [lot()], assertOwned: async () => {} })).toEqual(new Map());
    expect((await YoutubeVideo.findById(`old-owner-${kind}`).lean())!.generationToken).toBe("old-explicit");
    expect((await model(kind).findById(saved._id).select("+youtube_submission").lean()).youtube_submission.generationToken).toBe("old-explicit");
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("%s ordinary regeneration rejects duplicate lot-source mappings before carrying authority", async (kind) => {
    const saved = await report(kind, { status: "processing", job_status: "processing", job_id: "automatic", youtube_videos_enabled: true, youtube_submission: { generationToken: "old-explicit", uploadGenerationToken: "old-explicit", channelId: channel, connectionRevision: 7, ownerId: String(owner) } });
    await YoutubeVideo.create({ _id: `ambiguous-${kind}`, reportType: kind, reportId: saved._id, ownerId: owner, channelId: channel, connectionRevision: 7, generationToken: "old-explicit", sourceUrl: video, videoId: "abcdefghijk", url: youtubeUrl, status: "private", title: "Original reviewed title" });
    await expect(prepareReportYoutubeVideos({ reportType: kind, reportId: String(saved._id), enabled: true, generationToken: "automatic", lots: [lot(), { ...lot(), lot_id: "second-lot", lot_number: "78", title: "Different lot" }], assertOwned: async () => {} })).rejects.toMatchObject({ code: "YOUTUBE_LOT_MAPPING_AMBIGUOUS" });
    expect(await YoutubeVideo.findById(`ambiguous-${kind}`).lean()).toMatchObject({ generationToken: "old-explicit", title: "Original reviewed title" });
    expect((await model(kind).findById(saved._id).select("+youtube_submission").lean()).youtube_submission.generationToken).toBe("old-explicit");
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
  });

  it("a stale artifact worker cannot overwrite a newer explicit receipt before its parent CAS fails", async () => {
    const saved = await report("asset", { status: "processing", job_status: "processing", job_id: "automatic", youtube_videos_enabled: true, youtube_submission: { generationToken: "old-explicit", uploadGenerationToken: "old-explicit", channelId: channel, connectionRevision: 7, ownerId: String(owner) } });
    await YoutubeVideo.create({ _id: "race-receipt", reportType: "asset", reportId: saved._id, ownerId: owner, channelId: channel, connectionRevision: 7, generationToken: "old-explicit", sourceUrl: video, videoId: "abcdefghijk", url: youtubeUrl, status: "private", title: "Old title" });
    let ownershipChecks = 0;
    const assertOwned = async () => {
      if (++ownershipChecks !== 3) return;
      // A current worker completes its authority check just before replacement wins.
      await AssetReport.updateOne({ _id: saved._id }, { $set: { job_id: "newer-explicit", "youtube_submission.generationToken": "newer-explicit", "youtube_submission.uploadGenerationToken": "newer-explicit" } });
      await YoutubeVideo.updateOne({ _id: "race-receipt" }, { $set: { generationToken: "newer-explicit", title: "Newer reviewed title" } });
    };
    await expect(prepareReportYoutubeVideos({ reportType: "asset", reportId: String(saved._id), enabled: true, generationToken: "automatic", lots: [lot()], assertOwned })).rejects.toThrow();
    expect(await YoutubeVideo.findById("race-receipt").lean()).toMatchObject({ generationToken: "newer-explicit", title: "Newer reviewed title" });
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
  });

  it("artifact regeneration cannot rewrite a receipt that became public after its snapshot", async () => {
    const saved = await report("asset", { status: "processing", job_status: "processing", job_id: "automatic", youtube_videos_enabled: true, youtube_submission: { generationToken: "old-explicit", uploadGenerationToken: "old-explicit", channelId: channel, connectionRevision: 7, ownerId: String(owner) } });
    await YoutubeVideo.create({ _id: "publication-race", reportType: "asset", reportId: saved._id, ownerId: owner, channelId: channel, connectionRevision: 7, generationToken: "old-explicit", sourceUrl: video, videoId: "abcdefghijk", url: youtubeUrl, status: "private", title: "Original published title" });
    let ownershipChecks = 0;
    const assertOwned = async () => {
      if (++ownershipChecks === 3) await YoutubeVideo.updateOne({ _id: "publication-race" }, { $set: { status: "public" } });
    };
    await expect(prepareReportYoutubeVideos({ reportType: "asset", reportId: String(saved._id), enabled: true, generationToken: "automatic", lots: [lot()], assertOwned })).resolves.toEqual(new Map([[video, youtubeUrl]]));
    expect(await YoutubeVideo.findById("publication-race").lean()).toMatchObject({ generationToken: "old-explicit", status: "public", title: "Original published title" });
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("%s Excel/CR-only regeneration preserves receipts without exporting links or starting uploads", async (kind) => {
    const token = "excel-only-revision";
    const saved = await report(kind, { status: "approved", job_id: token, job_status: "queued", files_regenerating: true, youtube_videos_enabled: true });
    await YoutubeVideo.create({ _id: `receipt-${kind}`, reportType: kind, reportId: saved._id, ownerId: owner, channelId: channel, connectionRevision: 7, generationToken: "previous", sourceUrl: video, videoId: "abcdefghijk", url: youtubeUrl, status: "public" });
    await runExcelCrRegenerationJob({ kind, reportId: String(saved._id), generationToken: token });
    expect(mocks.xlsx.mock.calls.at(-1)![1]).toEqual({ includeScheduleAColumn: kind === "asset" });
    expect(await readReportYoutubeLinks({ reportType: kind, reportId: String(saved._id), enabled: true })).toEqual(new Map([[video, youtubeUrl]]));
    expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
    expect(mocks.zip).not.toHaveBeenCalled();
  });

  it.each([
    ["asset", false], ["lotListing", false], ["asset", true], ["lotListing", true],
  ] as const)("%s Excel/CR carries private receipts to release without uploading added clips (same token: %s)", async (kind, sameToken) => {
    const token = `excel-carry-${kind}-${sameToken}`;
    const originalToken = sameToken ? token : "original-explicit-submission";
    const additional = "https://assetinsight.test/uploads/new-unsubmitted-video.mp4";
    const reviewedLot = { ...lot(), title: "Latest reviewed Excel truck", description: "Latest reviewed description for publication.", video_urls: [video, additional] };
    const saved = await report(kind, { status: "approved", release_status: "pending_release", job_id: token, job_status: "queued", files_regenerating: true, youtube_videos_enabled: true, videoUrls: [video, additional], lots: [reviewedLot], preview_data: { lots: [reviewedLot], currency: "CAD", contract_no: "YT-WORKFLOW", valuation_methods: ["FML"] }, youtube_submission: { generationToken: originalToken, uploadGenerationToken: originalToken, channelId: channel, connectionRevision: 7, ownerId: String(owner) } });
    const receiptId = youtubeVideoIdentity(kind, String(saved._id), video, channel);
    await YoutubeVideo.create({ _id: receiptId, reportType: kind, reportId: saved._id, ownerId: owner, channelId: channel, connectionRevision: 7, generationToken: originalToken, sourceUrl: video, videoId: "abcdefghijk", url: youtubeUrl, status: "private", title: "Original upload title", description: "Original upload description" });
    mocks.xlsx.mockImplementationOnce(async () => {
      expect(await YoutubeVideo.findById(receiptId).select("+description").lean()).toMatchObject({ generationToken: token, status: "private", ...youtubeLotMetadata(reviewedLot) });
      expect((await model(kind).findById(saved._id).select("+youtube_submission").lean()).youtube_submission).toMatchObject({ generationToken: token, uploadGenerationToken: originalToken });
      return Buffer.from("xlsx");
    });

    await runExcelCrRegenerationJob({ kind, reportId: String(saved._id), generationToken: token });
    expect(mocks.xlsx.mock.calls.at(-1)![1]).toEqual({ includeScheduleAColumn: kind === "asset" });
    expect(await readReportYoutubeLinks({ reportType: kind, reportId: String(saved._id), enabled: true })).toEqual(new Map([[video, youtubeUrl]]));
    expect(await model(kind).findById(saved._id).lean()).toMatchObject({ job_id: token, job_status: "done", release_status: "pending_release", files_regenerating: false, files_generating: false });
    expect(await YoutubeVideo.countDocuments({ reportId: saved._id })).toBe(1);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.zip).not.toHaveBeenCalled();
    expect(await publishReleasedYoutubeVideos()).toBe(0);
    expect(mocks.publish).not.toHaveBeenCalled();

    await model(kind).updateOne({ _id: saved._id }, { $set: { release_status: "released" } });
    await YoutubeVideo.updateOne({ _id: receiptId }, { $set: { nextAttemptAt: new Date(0) } });
    const reviewedMetadata = youtubeAutomaticLotMetadata(reviewedLot);
    mocks.publish.mockImplementationOnce(async (_access, _id, _channel, authorize) => { await authorize(); return true; });
    expect(await publishReleasedYoutubeVideos()).toBe(1);
    expect(mocks.publish.mock.calls.at(-1)![4]).toEqual({ title: reviewedMetadata.title, description: reviewedMetadata.description });
    expect((await YoutubeVideo.findById(receiptId).lean())!.status).toBe("public");
    expect(await YoutubeVideo.countDocuments({ reportId: saved._id })).toBe(1);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
  });

  it("keeps receipt URL projections inside the report, owner, channel and source manifest", async () => {
    const first = await report("asset", { youtube_videos_enabled: true, youtube_submission: { channelId: channel } });
    const second = await report("asset", { user: otherOwner, youtube_videos_enabled: true });
    const base = { reportType: "asset", reportId: first._id, ownerId: owner, channelId: channel, connectionRevision: 7, generationToken: "saved", sourceUrl: video, videoId: "abcdefghijk", status: "public" };
    await YoutubeVideo.create([
      { ...base, _id: "correct", url: youtubeUrl },
      { ...base, _id: "other-report", reportId: second._id, url: "https://www.youtube.com/watch?v=otherreport" },
      { ...base, _id: "other-owner", ownerId: otherOwner, url: "https://www.youtube.com/watch?v=other-owner" },
      { ...base, _id: "other-channel", channelId: `UC${"b".repeat(22)}`, url: "https://www.youtube.com/watch?v=otherchannl" },
      { ...base, _id: "injected-source", sourceUrl: "https://private.invalid/untrusted.mp4", url: "https://www.youtube.com/watch?v=untrustedsr" },
    ]);
    expect(await readReportYoutubeLinks({ reportType: "asset", reportId: String(first._id), enabled: true })).toEqual(new Map([[video, youtubeUrl]]));
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
