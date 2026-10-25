import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const upstream = vi.hoisted(() => ({
  getLot: vi.fn(),
  patchLot: vi.fn(),
  uploadLotPhotos: vi.fn(),
  setLotVideo: vi.fn(),
  completeConditionReport: vi.fn(),
  submitLot: vi.fn(),
  markArrived: vi.fn(),
  pushToAssetInsight: vi.fn(),
  completeContractTask: vi.fn(),
  closeContractPartForUser: vi.fn(),
}));
const photoSource = vi.hoisted(() => ({
  loadAuctioneerPhoto: vi.fn(),
  trustedPhotoSource: vi.fn(),
}));

vi.mock("../src/service/auctioneer2Client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/service/auctioneer2Client.js")>();
  return {
    ...actual,
    getLot: upstream.getLot,
    patchLot: upstream.patchLot,
    uploadLotPhotos: upstream.uploadLotPhotos,
    setLotVideo: upstream.setLotVideo,
    completeConditionReport: upstream.completeConditionReport,
    submitLot: upstream.submitLot,
    markArrived: upstream.markArrived,
    pushToAssetInsight: upstream.pushToAssetInsight,
    completeContractTask: upstream.completeContractTask,
    closeContractPartForUser: upstream.closeContractPartForUser,
  };
});

vi.mock("../src/service/auctioneer2PhotoService.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/service/auctioneer2PhotoService.js")
    >();
  return {
    ...actual,
    loadAuctioneerPhoto: photoSource.loadAuctioneerPhoto,
    trustedPhotoSource: photoSource.trustedPhotoSource,
  };
});

let mongo: MongoMemoryServer;
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let AuctioneerWorkItem: typeof import("../src/models/auctioneerWorkItem.model.js")["default"];
let runAuctioneerDeliveryJob: typeof import("../src/service/auctioneer2DeliveryService.js")["runAuctioneerDeliveryJob"];
let Auctioneer2ClientError: typeof import("../src/service/auctioneer2Client.js")["Auctioneer2ClientError"];
let getAuctioneerDeliverySummary: typeof import("../src/service/auctioneer2IntegrationService.js")["getAuctioneerDeliverySummary"];
let queueAuctioneerDelivery: typeof import("../src/service/auctioneer2IntegrationService.js")["queueAuctioneerDelivery"];

async function createUser() {
  return User.create({
    email: "auctioneer-worker@example.test",
    username: "Auctioneer Worker",
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
  });
}

async function createReport(userId: mongoose.Types.ObjectId, lots: any[]) {
  return AssetReport.create({
    user: userId,
    grouping_mode: "mixed",
    imageUrls: [],
    lots,
    status: "approved",
    release_status: "released",
    job_status: "done",
    contract_no: "C-100",
    preview_data: { contract_no: "C-100", lots },
    preview_files: {
      docx: "https://files.example/report.docx",
      excel: "https://files.example/report.xlsx",
      images: "https://files.example/images.zip",
    },
  });
}

async function createLotListingReport(
  userId: mongoose.Types.ObjectId,
  lots: any[],
  previewFiles: Record<string, string> = {
    excel: "https://files.example/lot-listing.xlsx",
    images: "https://files.example/lot-listing-images.zip",
  }
) {
  const normalizedLots = lots.map((lot, index) => ({
    lot_number: index + 1,
    ...lot,
  }));
  return LotListing.create({
    user: userId,
    contract_no: "C-LOT",
    sales_date: new Date("2026-08-05T00:00:00.000Z"),
    location: "Regina, SK",
    imageUrls: [],
    lots: normalizedLots,
    status: "preview",
    job_status: "done",
    preview_data: {
      contract_no: "C-LOT",
      lots: normalizedLots,
    },
    preview_files: previewFiles,
  });
}

async function createLinkedScheduleAWorkItem(input: {
  userId: mongoose.Types.ObjectId;
  reportId: mongoose.Types.ObjectId;
  reportType: "asset" | "lotListing";
  lots: any[];
  cycleKey: string;
  contractId?: string;
  assignmentUserId?: mongoose.Types.ObjectId;
  deliveryStatus?: "not_ready" | "ready" | "queued";
}) {
  const sourceLots = input.lots.map((lot, index) => ({
    sourceKey: lot.auctioneer_source_key || `source-${index + 1}`,
    lotId: `upstream-${index + 1}`,
    submissionId: `submission-${index + 1}`,
    raw: {},
  }));
  const deliveryStatus = input.deliveryStatus || "not_ready";
  return AuctioneerWorkItem.create({
    source: "auctioneer2",
    cycleKey: input.cycleKey,
    activeContractKey: `${input.cycleKey}-active`,
    assignmentUserId: input.assignmentUserId,
    contract: {
      id: input.contractId || `${input.cycleKey}-contract`,
      contractNo: "C-LOT",
      eventId: `${input.cycleKey}-event`,
    },
    kind: "scheduleA",
    snapshot: {
      tasks: [],
      capturedAt: new Date(),
      lots: sourceLots,
    },
    claimedBy: input.userId,
    selectedReportType: input.reportType,
    clientSubmissionId: `auctioneer2-${input.cycleKey}`,
    linkedReportModel:
      input.reportType === "asset" ? "AssetReport" : "LotListing",
    linkedReportId: input.reportId,
    status: "report_created",
    delivery: {
      status: deliveryStatus,
      destination: deliveryStatus === "queued" ? "LottingBoard" : undefined,
      completeContract: false,
      attempts: deliveryStatus === "queued" ? 1 : 0,
      manifest:
        deliveryStatus === "queued"
          ? {
              previewData: { lots: input.lots },
              destination: "LottingBoard",
              completeContract: false,
            }
          : undefined,
      lots: sourceLots.map((source) => ({
        sourceKey: source.sourceKey,
        sourceLotId: source.lotId,
        sourceSubmissionId: source.submissionId,
        status: "pending",
      })),
    },
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import(
    "../src/models/lotListing.model.js"
  ));
  ({ default: AuctioneerWorkItem } = await import(
    "../src/models/auctioneerWorkItem.model.js"
  ));
  ({ runAuctioneerDeliveryJob } = await import(
    "../src/service/auctioneer2DeliveryService.js"
  ));
  ({ getAuctioneerDeliverySummary, queueAuctioneerDelivery } = await import(
    "../src/service/auctioneer2IntegrationService.js"
  ));
  ({ Auctioneer2ClientError } = await import(
    "../src/service/auctioneer2Client.js"
  ));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  vi.clearAllMocks();
  // Clear unused one-shot responses as well as call counts between report types.
  for (const mock of [...Object.values(upstream), ...Object.values(photoSource)]) mock.mockReset();
  photoSource.trustedPhotoSource.mockReset().mockReturnValue("r2");
  upstream.getLot.mockResolvedValue({
    id: "upstream-lot",
    status: "OpToDo",
    conditionReportDone: false,
    photos: [],
  });
  upstream.patchLot.mockResolvedValue({ success: true });
  upstream.uploadLotPhotos.mockResolvedValue({ success: true, photos: [] });
  upstream.setLotVideo.mockResolvedValue({
    success: true,
    delivery: "video-only",
    photos: [],
    video: { id: "video-1", url: "https://www.youtube.com/embed/AbCdEfGhI_1", sortOrder: 1, skipped: false },
  });
  upstream.completeConditionReport.mockResolvedValue({
    success: true,
    newStatus: "Lotting",
  });
  upstream.submitLot.mockResolvedValue({
    success: true,
    lotId: "created-lot",
    submissionId: "created-submission",
    status: "AwaitingArrival",
  });
  upstream.markArrived.mockResolvedValue({
    success: true,
    newStatus: "Arrived",
  });
  upstream.pushToAssetInsight.mockResolvedValue({
    success: true,
    newStatus: "OpToDo",
    submissionId: "created-submission",
  });
  upstream.completeContractTask.mockResolvedValue({ success: true });
  // Auctioneer's per-user close: this user's part closes, others still work.
  upstream.closeContractPartForUser.mockImplementation(
    async (contractId: string, input: { completedByUserId: string }) => ({
      contractId,
      userId: input.completedByUserId,
      userStatus: "completed",
      taskCompleted: false,
      alreadyCompleted: false,
    })
  );
  photoSource.loadAuctioneerPhoto.mockImplementation(
    async (sourceUrl: string, lotIndex: number, photoIndex: number) => ({
      buffer: Buffer.from(`image-${photoIndex}`),
      contentType: "image/jpeg",
      filename: `lot-${String(lotIndex + 1).padStart(3, "0")}-photo-${String(
        photoIndex + 1
      ).padStart(3, "0")}.jpg`,
      sourceUrl,
    })
  );
});

describe("Auctioneer CR lot numbers", () => {
  it.each(["asset", "lotListing"] as const)("persists repeated %s checkpoints with a real activity ledger", async reportType => {
    const { reportActivityContext } = await import("../src/utils/reportActivityContext.js");
    const { waitForActivityDispatch } = await import("../src/service/reportActivityService.js");
    const user = await createUser();
    const lots = [{ lot_id: "audited-lot", auctioneer_source_key: "audited-source", lot_number: "12", title: "Audited vehicle", image_urls: ["https://images.sellsnap.store/first.jpg"] }];
    const work = await reportActivityContext.run({ actor: String(user._id), source: "web" }, async () => {
      const report = reportType === "asset" ? await createReport(user._id, lots) : await createLotListingReport(user._id, lots);
      const workItem = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType, lots, cycleKey: `audited-${reportType}` });
      await queueAuctioneerDelivery(String(workItem._id), String(user._id), { destination: "LottingBoard", completeContract: false });
      return workItem;
    });
    const queued = await AuctioneerWorkItem.collection.findOne({ _id: work._id });
    expect(queued?.activity_stream_id).toBeTruthy();
    try {
      // A background worker has no HTTP context, but retains the existing audit stream.
      await runAuctioneerDeliveryJob(String(work._id));
      expect(upstream.patchLot).toHaveBeenCalledTimes(1);
      expect(upstream.uploadLotPhotos).toHaveBeenCalledTimes(1);
      expect(upstream.completeConditionReport).toHaveBeenCalledTimes(1);
      expect((await AuctioneerWorkItem.findById(work._id).lean())?.delivery).toMatchObject({ status: "sent", lots: [{ status: "sent", step: "sent" }] });
      await waitForActivityDispatch();
      const events = await mongoose.connection.db!.collection("reportactivityevents").find({ activity: queued!.activity_stream_id, action: "auction_delivery" }).toArray();
      expect(events.map(event => event.data.deliveryStatus)).toContain("sent");
      expect(events.some(event => event.outcome === "failed")).toBe(false);
    } finally { await waitForActivityDispatch(); }
  });

  async function queued(reportType: "asset" | "lotListing", lotNumber: unknown = "12") {
    const user = await createUser();
    const lots = [{ lot_id: "local-lot", lot_number: lotNumber, title: "Reviewed vehicle", estimated_value: "CA$18,500", image_indexes: [] }];
    const report = reportType === "asset" ? await createReport(user._id, lots) : await createLotListingReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType, lots, cycleKey: "cr-lot-number", deliveryStatus: "queued" });
    return { workItem, report };
  }

  it("retries an audited delivery from the accepted photo checkpoint without duplicate writes", async () => {
    const { reportActivityContext } = await import("../src/utils/reportActivityContext.js");
    const { waitForActivityDispatch } = await import("../src/service/reportActivityService.js");
    const { workItem, report } = await reportActivityContext.run({ source: "web" }, () => queued("lotListing"));
    await LotListing.updateOne({ _id: report._id }, { $set: { "preview_data.lots.0.image_urls": ["https://images.sellsnap.store/first.jpg"] } });
    await AuctioneerWorkItem.updateOne({ _id: workItem._id }, { $set: { "delivery.manifest.photoOrderVersion": 2, "delivery.manifest.photoUrlsByLot": [["https://images.sellsnap.store/first.jpg"]] } });
    upstream.completeConditionReport.mockRejectedValueOnce(new Auctioneer2ClientError("Auctioneer is temporarily unavailable.", { statusCode: 503, code: "auctioneer2_upstream_error" }));
    try {
      await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow("temporarily unavailable");
      const failed = await AuctioneerWorkItem.findById(workItem._id).lean();
      expect(failed?.delivery).toMatchObject({ status: "failed", lots: [{ status: "failed", photosUploadedAt: expect.any(Date) }] });
      await queueAuctioneerDelivery(String(workItem._id), String(report.user), { destination: "LottingBoard", completeContract: false });
      await runAuctioneerDeliveryJob(String(workItem._id));
      expect(upstream.patchLot).toHaveBeenCalledTimes(1);
      expect(upstream.uploadLotPhotos).toHaveBeenCalledTimes(1);
      expect(upstream.completeConditionReport).toHaveBeenCalledTimes(2);
      expect((await AuctioneerWorkItem.findById(workItem._id).lean())?.delivery.status).toBe("sent");
    } finally { await waitForActivityDispatch(); }
  });

  it.each(["asset", "lotListing"] as const)("does not queue %s old artifacts while the current generation is active or failed", async reportType => {
    const { workItem, report } = await queued(reportType);
    await AuctioneerWorkItem.updateOne({ _id: workItem._id }, { $set: { "delivery.status": "ready" } });
    const model = reportType === "asset" ? AssetReport : LotListing;
    for (const jobStatus of ["queued", "processing", "error"]) {
      await model.updateOne({ _id: report._id }, { $set: { job_status: jobStatus } });
      expect(await getAuctioneerDeliverySummary(String(workItem._id), String(report.user))).toMatchObject({ state: "not_ready", filesReady: false, canSend: false });
      await expect(queueAuctioneerDelivery(String(workItem._id), String(report.user), { destination: "LottingBoard" })).rejects.toMatchObject({ code: "delivery_not_ready" });
    }
    for (const mock of Object.values(upstream)) expect(mock).not.toHaveBeenCalled();
  });

  it.each(["processing", "error"])("explains a %s generation that changes after delivery was queued", async jobStatus => {
    const { workItem, report } = await queued("lotListing");
    await LotListing.updateOne({ _id: report._id }, { $set: { job_status: jobStatus } });
    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow(jobStatus === "processing" ? "Wait for them to finish" : "regenerate its files");
    for (const mock of Object.values(upstream)) expect(mock).not.toHaveBeenCalled();
    expect((await AuctioneerWorkItem.findById(workItem._id).lean())?.delivery.lastError).not.toContain("while preparing or uploading");
  });

  it("retains an existing caller save predicate rather than bypassing a real conflict", async () => {
    const { workItem } = await queued("lotListing");
    const loaded = (await AuctioneerWorkItem.findById(workItem._id))!;
    loaded.$where = { status: "abandoned" };
    // Use a real document and real Mongo save; only inject the caller's guard.
    const read = vi.spyOn(AuctioneerWorkItem, "findById").mockReturnValueOnce(Promise.resolve(loaded) as never);
    try {
      await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow("changed while a checkpoint");
      expect(loaded.$where).toEqual({ status: "abandoned" });
      for (const mock of Object.values(upstream)) expect(mock).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
    expect((await AuctioneerWorkItem.findById(workItem._id).lean())?.delivery.status).toBe("queued");
  });

  it("identifies database save failures without exposing their predicates", async () => {
    const { deliveryErrorDiagnostic } = await import("../src/service/auctioneer2DeliveryError.js");
    const error = new mongoose.Error.DocumentNotFoundError({ privateNote: "customer-secret" });
    const diagnostic = deliveryErrorDiagnostic(error);
    expect(diagnostic.name).toBe("DocumentNotFoundError");
    expect(JSON.stringify(diagnostic)).not.toContain("customer-secret");
  });

  it.each(["audit", "version", "document"])("does not save a stale failure after a real %s compare-and-swap loss", async conflict => {
    const { reportActivityContext } = await import("../src/utils/reportActivityContext.js");
    const { waitForActivityDispatch } = await import("../src/service/reportActivityService.js");
    const { workItem } = await reportActivityContext.run({ source: "web" }, () => queued("lotListing"));
    await waitForActivityDispatch();
    const raw = mongoose.connection.db!.collection("auctioneerworkitems");
    const before = (await raw.findOne({ _id: workItem._id as mongoose.Types.ObjectId }))!;
    const completedAt = new Date();
    const winningDelivery = { ...before.delivery, status: "sent", completedAt,
      lots: before.delivery.lots.map((lot: any) => ({ ...lot, status: "sent", step: "sent", photosUploadedAt: completedAt, conditionReportCompletedAt: completedAt })) };
    if (conflict === "document") await raw.updateOne({ _id: workItem._id as mongoose.Types.ObjectId }, { $set: { "delivery.status": "sending" } });
    const loaded = (await AuctioneerWorkItem.findById(workItem._id))!;
    if (conflict === "version") loaded.increment();
    if (conflict === "document") loaded.$where = { activity_revision: before.activity_revision };
    const read = vi.spyOn(AuctioneerWorkItem, "findById").mockReturnValueOnce(Promise.resolve(loaded) as never);
    const originalUpdate = AuctioneerWorkItem.collection.updateOne.bind(AuctioneerWorkItem.collection);
    let injected = false;
    const write = vi.spyOn(AuctioneerWorkItem.collection, "updateOne").mockImplementation(async (...args: any[]) => {
      if (!injected && args[1]?.$set?.delivery?.status === "sending") {
        injected = true;
        // A real second database write wins after the audit hook read its preimage.
        await raw.updateOne({ _id: workItem._id as mongoose.Types.ObjectId }, {
          $set: { status: "sent", delivery: winningDelivery },
          $inc: conflict === "version" ? { __v: 1 } : { activity_revision: 1 },
        });
      }
      return (originalUpdate as any)(...args);
    });
    try {
      await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow();
      expect(injected).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      for (const mock of Object.values(upstream)) expect(mock).not.toHaveBeenCalled();
      const after = (await raw.findOne({ _id: workItem._id as mongoose.Types.ObjectId }))!;
      expect(after.status).toBe("sent");
      expect(after.delivery).toEqual(winningDelivery);
    } finally { write.mockRestore(); read.mockRestore(); await waitForActivityDispatch(); }
  });

  it.each(["asset", "lotListing"] as const)("sends the saved %s delivery number with complete-cr, not the source placeholder", async reportType => {
    const { workItem, report } = await queued(reportType, " 012A ");
    // Changes after queuing must not alter the immutable delivery snapshot.
    const model = reportType === "asset" ? AssetReport : LotListing;
    await model.updateOne({ _id: report._id }, { $set: { "preview_data.lots.0.lot_number": "999" } });
    upstream.getLot.mockResolvedValue({ status: "OpToDo", lotNumber: "LOT-4321", photos: [] });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(upstream.completeConditionReport).toHaveBeenCalledWith("upstream-1", expect.objectContaining({ lotNumber: "012A", estimatedValue: "18500", destination: "LottingBoard" }));
  });

  it.each([12, "12"])("sends %s as a string", async value => {
    const { workItem } = await queued("asset", value);
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(upstream.completeConditionReport.mock.calls[0][1].lotNumber).toBe("12");
  });

  it.each([undefined, "", "   "])("does not send a blank number (%s) or fall back to an upstream placeholder", async value => {
    const { workItem } = await queued("asset", value === undefined ? null : value);
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(upstream.completeConditionReport.mock.calls[0][1]).not.toHaveProperty("lotNumber");
  });

  it.each(["scheduleA", "unknown"] as const)("repairs a %s placeholder after a completed CR without replaying CR or photos", async kind => {
    const { workItem } = await queued("asset");
    workItem.kind = kind;
    if (kind === "unknown") workItem.delivery.lots[0].createdLotId = "upstream-1";
    await workItem.save();
    upstream.getLot.mockResolvedValue({ status: "Lotting", lotNumber: "LOT-4321" });
    upstream.patchLot.mockResolvedValue({ success: true, updatedFields: ["lotNumber"] });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(upstream.patchLot).toHaveBeenCalledExactlyOnceWith("upstream-1", { lotNumber: "12" });
    expect(upstream.completeConditionReport).not.toHaveBeenCalled();
    expect(upstream.uploadLotPhotos).not.toHaveBeenCalled();
    expect(upstream.submitLot).not.toHaveBeenCalled();
    expect((await AuctioneerWorkItem.findById(workItem._id))?.delivery.status).toBe("sent");
  });

  it("creates a lot split out of a Schedule A line instead of patching its parent", async () => {
    /*
       OWNER, 2026-09-29: an appraiser may return more lots than Schedule A
       lists, and each extra must name its parent; the extras become "New
       Schedule A lots inheriting the parent's commission."

       ── WHY THIS TEST EARNS ITS KEEP ──────────────────────────────────────

       The two delivery paths are not symmetric. deliverScheduleALot PATCHES the
       lot that already exists upstream for a line and completes its condition
       report; deliverUnknownLot CREATES one. A Schedule A line already has its
       lot, so if a split went down the Schedule A path it would patch the SAME
       upstream lot as its parent — three splits would overwrite one another and
       the last would win, with a success response, no error, and two lots'
       work silently gone.

       So the split is asserted to reach submitLot (create) while its parent
       still reaches patchLot, and to carry the parent's upstream lot id so
       Auctioneer knows whose commission to copy.
    */
    const user = await createUser();
    const lots = [
      {
        lot_id: "report-parent-lot",
        auctioneer_source_key: "source-split-parent",
        title: "Pallet of attachments",
        description: "As listed on Schedule A",
        image_indexes: [],
      },
      {
        lot_id: "report-split-lot",
        // Its own key — Auctioneer de-duplicates on the reference, so a split
        // sharing its parent's would be taken for a replay and dropped.
        auctioneer_source_key: "source-split-parent:split:report-split-lot",
        auctioneer_source_parent_key: "source-split-parent",
        title: "Bucket",
        description: "Split out of the pallet",
        image_indexes: [],
      },
      {
        lot_id: "report-second-line",
        auctioneer_source_key: "source-second-line",
        title: "Second original line",
        description: "Keep this after the split",
        image_indexes: [],
      },
    ];
    const report = await createReport(user._id, lots);
    const savedReport = await AssetReport.findById(report._id).lean();
    expect(savedReport?.lots?.[1]?.auctioneer_source_parent_key).toBe("source-split-parent");
    const listing = new LotListing({ lots }).toObject();
    expect(listing.lots?.[1]?.auctioneer_source_parent_key).toBe("source-split-parent");
    const workItem = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "cycle-schedule-a-split",
      activeContractKey: "contract-split",
      contract: {
        id: "contract-split",
        contractNo: "C-SPLIT",
        eventId: "event-split",
      },
      kind: "scheduleA",
      snapshot: {
        tasks: [],
        capturedAt: new Date(),
        // The split is interleaved: checkpoints must stay in report order.
        lots: [
          {
            sourceKey: "source-split-parent",
            lotId: "upstream-split-parent",
            submissionId: "submission-split-parent",
            raw: {},
          },
          { sourceKey: "source-second-line", lotId: "upstream-second-line", submissionId: "submission-second-line", raw: {} },
        ],
      },
      claimedBy: user._id,
      selectedReportType: "asset",
      clientSubmissionId: "auctioneer2-cycle-schedule-a-split",
      linkedReportModel: "AssetReport",
      linkedReportId: report._id,
      status: "report_created",
      delivery: {
        status: "queued",
        destination: "LottingBoard",
        completeContract: false,
        attempts: 1,
        manifest: {
          previewData: { lots },
          destination: "LottingBoard",
          completeContract: false,
        },
        lots: [
          {
            sourceKey: "source-split-parent",
            sourceLotId: "upstream-split-parent",
            sourceSubmissionId: "submission-split-parent",
            status: "pending",
          },
          {
            sourceKey: "source-split-parent:split:report-split-lot",
            sourceLotId: "upstream-split-parent",
            sourceSubmissionId: "submission-split-parent",
            status: "pending",
          },
        ],
      },
    });

    upstream.submitLot.mockResolvedValue({
      success: true,
      lotId: "created-split-lot",
      submissionId: "created-split-submission",
      status: "AwaitingArrival",
      rowGuid: "created-split-lot",
    });

    await runAuctioneerDeliveryJob(String(workItem._id));

    // The parent line is filled in where it already lives.
    expect(upstream.patchLot.mock.calls.map(([lotId]) => lotId)).toEqual([
      "upstream-split-parent",
      "upstream-second-line",
    ]);

    // The split becomes a NEW lot upstream, naming the line it came from.
    expect(upstream.submitLot).toHaveBeenCalledTimes(1);
    expect(upstream.submitLot.mock.calls[0][0]).toMatchObject({
      contractId: "contract-split",
      scheduleAParentRef: "upstream-split-parent",
    });

    // And it does not reuse its parent's submission reference, which would make
    // Auctioneer answer it as a replay and return the parent's lot.
    expect(upstream.submitLot.mock.calls[0][0].contractLotRef).not.toBe(
      "submission-split-parent"
    );
  });

  it("reconciles a lost completion response without resending an already saved number", async () => {
    const { workItem } = await queued("asset");
    upstream.completeConditionReport.mockRejectedValueOnce(new Auctioneer2ClientError(
      "Auctioneer 2.0 did not respond before the timeout.",
      { statusCode: 504, code: "auctioneer2_timeout" }
    ));
    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow("timeout");
    upstream.getLot.mockResolvedValue({ status: "Lotting", lotNumber: "12" });
    await AuctioneerWorkItem.updateOne({ _id: workItem._id }, { $set: { "delivery.status": "queued" } });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(upstream.patchLot).toHaveBeenCalledTimes(1);
    expect(upstream.completeConditionReport).toHaveBeenCalledTimes(1);
    expect((await AuctioneerWorkItem.findById(workItem._id))?.delivery.status).toBe("sent");
  });

  it.each(["12", 12])("does not rewrite a matching completed lot number (%s)", async value => {
    const { workItem } = await queued("asset");
    upstream.getLot.mockResolvedValue({ status: "Lotting", lotNumber: value });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(upstream.patchLot).not.toHaveBeenCalled();
    expect(upstream.completeConditionReport).not.toHaveBeenCalled();
  });

  it("uses read-back when a number-only PATCH does not list updatedFields", async () => {
    const { workItem } = await queued("asset");
    upstream.getLot.mockResolvedValueOnce({ status: "Lotting", lotNumber: "LOT-4321" })
      .mockResolvedValueOnce({ status: "Lotting", lotNumber: "12" });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(upstream.getLot).toHaveBeenCalledTimes(2);
    expect((await AuctioneerWorkItem.findById(workItem._id))?.delivery.status).toBe("sent");
  });

  it("does not mark delivery sent if read-back still has the placeholder", async () => {
    const { workItem } = await queued("asset");
    upstream.getLot.mockResolvedValue({ status: "Lotting", lotNumber: "LOT-4321" });
    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow("did not confirm the lot number");
    expect((await AuctioneerWorkItem.findById(workItem._id))?.delivery.status).toBe("failed");
  });

  it("persists an actionable conflict and retries the same lot without replaying prior steps", async () => {
    const { workItem } = await queued("asset");
    upstream.completeConditionReport.mockRejectedValueOnce(new Auctioneer2ClientError(
      "Another lot in the same auction event already uses this lot number. Resolve the conflicting number in Auctioneer, then retry sending.",
      { statusCode: 409, code: "LOT_NUMBER_CONFLICT", upstreamStatus: 409 }
    ));
    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow("same auction event");
    const failed = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(failed?.delivery.status).toBe("failed");
    expect(failed?.delivery.lastError).toContain("same auction event");
    expect(failed?.delivery.lots[0].conditionReportCompletedAt).toBeUndefined();
    expect(upstream.submitLot).not.toHaveBeenCalled();
    await AuctioneerWorkItem.updateOne({ _id: workItem._id }, { $set: { "delivery.status": "queued" } });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(upstream.patchLot).toHaveBeenCalledTimes(1);
    expect(upstream.completeConditionReport).toHaveBeenCalledTimes(2);
    expect(upstream.completeConditionReport.mock.calls[1]).toEqual(upstream.completeConditionReport.mock.calls[0]);
    expect((await AuctioneerWorkItem.findById(workItem._id))?.delivery.status).toBe("sent");
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("Auctioneer 2.0 delivery worker", () => {
  it.each(["asset", "lotListing"] as const)("freezes %s lot video mapping and retries only the video after photos", async reportType => {
    const user = await createUser();
    const url = "https://www.youtube.com/watch?v=AbCdEfGhI_1";
    const lots = [
      { lot_id: "one", auctioneer_source_key: "source-one", title: "First", image_urls: ["https://images.sellsnap.store/first.jpg"], video_urls: [url] },
      { lot_id: "two", auctioneer_source_key: "source-two", title: "Second", image_urls: [], video_urls: [] },
    ];
    const report = reportType === "asset" ? await createReport(user._id, lots) : await createLotListingReport(user._id, lots);
    const model = reportType === "asset" ? AssetReport : LotListing;
    await model.updateOne({ _id: report._id }, { $set: { videoUrls: [url] } });
    const work = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType, lots, cycleKey: `frozen-video-${reportType}` });
    const options = { destination: "LottingBoard" as const, completeContract: false };
    await queueAuctioneerDelivery(String(work._id), String(user._id), options);
    upstream.setLotVideo.mockRejectedValueOnce(new Auctioneer2ClientError("Auctioneer 2.0 could not be reached.", { statusCode: 502, code: "auctioneer2_unreachable" }));
    await expect(runAuctioneerDeliveryJob(String(work._id))).rejects.toThrow("could not be reached");
    const failed = await AuctioneerWorkItem.findById(work._id).lean();
    expect(failed?.delivery.lots[0].photosUploadedAt).toBeTruthy();
    expect(failed?.delivery.lots[0].videoUploadedAt).toBeUndefined();
    expect(upstream.uploadLotPhotos.mock.invocationCallOrder[0]).toBeLessThan(upstream.setLotVideo.mock.invocationCallOrder[0]);
    expect(upstream.completeConditionReport).not.toHaveBeenCalled();
    await model.updateOne({ _id: report._id }, { $set: { "preview_data.lots.0.video_urls": ["https://youtu.be/ZyXwVuTsR_2"] } });
    await queueAuctioneerDelivery(String(work._id), String(user._id), options);
    await runAuctioneerDeliveryJob(String(work._id));
    expect(upstream.uploadLotPhotos).toHaveBeenCalledTimes(1);
    expect(upstream.setLotVideo.mock.calls).toEqual([["upstream-1", url], ["upstream-1", url]]);
    const done = await AuctioneerWorkItem.findById(work._id).lean();
    expect(done?.delivery.status).toBe("sent");
    expect(done?.delivery.lots[0].videoUploadedAt).toBeTruthy();
    expect(done?.delivery.manifest).toEqual(failed?.delivery.manifest);
    await runAuctioneerDeliveryJob(String(work._id));
    expect(upstream.setLotVideo).toHaveBeenCalledTimes(2);
  });

  it("preflights bad photo hosts before upstream writes and retains all frozen data", async () => {
    const { AuctioneerDeliveryError } = await import("../src/service/auctioneer2DeliveryError.js");
    const user = await createUser();
    const lots = [{ lot_id: "one", auctioneer_source_key: "source-one", title: "Vehicle", image_urls: ["https://foreign.test/private?signature=secret"] }];
    const report = await createReport(user._id, lots);
    const work = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType: "asset", lots, cycleKey: "bad-photo-host" });
    await queueAuctioneerDelivery(String(work._id), String(user._id), { destination: "LottingBoard", completeContract: false });
    photoSource.trustedPhotoSource.mockImplementation(() => { throw new AuctioneerDeliveryError("Report photo storage host is not trusted: foreign.test"); });
    await expect(runAuctioneerDeliveryJob(String(work._id))).rejects.toThrow("Lot 1, photo 1: Report photo storage host is not trusted: foreign.test");
    expect(upstream.patchLot).not.toHaveBeenCalled();
    expect(upstream.submitLot).not.toHaveBeenCalled();
    expect(photoSource.loadAuctioneerPhoto).not.toHaveBeenCalled();
    const saved = await AuctioneerWorkItem.findById(work._id).lean();
    expect(saved?.delivery.lastError).not.toContain("signature");
    const summary = await getAuctioneerDeliverySummary(String(work._id), String(user._id));
    expect(summary.error).toBe("Lot 1, photo 1: Report photo storage host is not trusted: foreign.test");
    expect((saved?.delivery.manifest as any)?.photoUrlsByLot).toEqual([lots[0].image_urls]);
    expect((await AssetReport.findById(report._id).lean())?.preview_data.lots[0].image_urls).toEqual(lots[0].image_urls);
  });

  it("logs unexpected errors with checkpoint and stack without leaking provider diagnostics", async () => {
    const user = await createUser();
    const lots = [{ lot_id: "one", auctioneer_source_key: "source-one", title: "Vehicle", image_urls: ["https://images.sellsnap.store/first.jpg"] }];
    const report = await createReport(user._id, lots);
    const work = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType: "asset", lots, cycleKey: "diagnostic-photo" });
    await queueAuctioneerDelivery(String(work._id), String(user._id), { destination: "LottingBoard", completeContract: false });
    photoSource.loadAuctioneerPhoto.mockRejectedValueOnce(new Error("PRIVATE_KEY private-secret https://media.test/file?signature=secret"));
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(runAuctioneerDeliveryJob(String(work._id))).rejects.toThrow("while preparing or uploading");
      expect(logger).toHaveBeenCalledWith("[Auctioneer2Delivery] delivery failed", expect.objectContaining({ reportId: String(report._id), contractNo: "C-LOT", checkpoint: expect.objectContaining({ sourceKey: "source-one" }), stack: expect.any(String) }));
      expect(JSON.stringify(logger.mock.calls)).not.toMatch(/PRIVATE_KEY|private-secret|signature=secret/);
    } finally { logger.mockRestore(); }
  });
  it.each(["photos_uploaded:1", "uploading_photos:0:1"])("refuses changed legacy photo order at %s before any upstream action", async (step) => {
    const user = await createUser();
    const urls = ["https://assetinsight.test/first.jpg", "https://assetinsight.test/cover.jpg"];
    const lots = [{ lot_id: "lot-222", lot_number: "222", title: "Trailer", image_urls: urls, image_url: urls[1], image_indexes: [] }];
    const report = await createReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType: "asset", lots, cycleKey: "legacy-photo-partial", deliveryStatus: "queued" });
    await AuctioneerWorkItem.updateOne({ _id: workItem._id }, { $set: { "delivery.lots.0.step": step, "delivery.lots.0.patchedAt": new Date() } });
    const before = (await AuctioneerWorkItem.findById(workItem._id).lean())!;
    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow("already started with a different saved photo order");
    for (const mock of Object.values(upstream)) expect(mock).not.toHaveBeenCalled();
    expect(photoSource.loadAuctioneerPhoto).not.toHaveBeenCalled();
    const saved = (await AuctioneerWorkItem.findById(workItem._id).lean())!;
    expect(saved.delivery.lots).toEqual(before.delivery.lots);
    expect(saved.delivery.manifest).toEqual(before.delivery.manifest);
    expect(saved.delivery.status).toBe("failed");
  });

  it("freezes the corrected photo order for new deliveries and resumes the same manifest after failure", async () => {
    const user = await createUser();
    const urls = Array.from({ length: 7 }, (_, index) => `https://assetinsight.test/${index}.jpg`);
    const lots = [{ lot_id: "lot-222", lot_number: "222", title: "Trailer", image_urls: urls, image_url: urls[3], image_indexes: [] }];
    const report = await createReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType: "asset", lots, cycleKey: "v2-photo-retry" });
    await queueAuctioneerDelivery(String(workItem._id), String(user._id), { destination: "LottingBoard", completeContract: false });
    const first = (await AuctioneerWorkItem.findById(workItem._id).lean())!;
    expect(first.delivery.manifest).toMatchObject({ photoOrderVersion: 2, photoUrlsByLot: [urls] });
    upstream.uploadLotPhotos.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error("isolated failure"));
    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow();
    await AssetReport.updateOne({ _id: report._id }, { $set: { imageUrls: ["https://assetinsight.test/changed.jpg"], "preview_data.lots.0.image_urls": ["https://assetinsight.test/changed.jpg"] } });
    await queueAuctioneerDelivery(String(workItem._id), String(user._id), { destination: "LottingBoard", completeContract: false });
    upstream.uploadLotPhotos.mockResolvedValue({ success: true });
    photoSource.loadAuctioneerPhoto.mockClear();
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(photoSource.loadAuctioneerPhoto.mock.calls.map(([url]) => url)).toEqual(urls.slice(5));
    const saved = (await AuctioneerWorkItem.findById(workItem._id).lean())!;
    expect(saved.delivery.manifest).toEqual(first.delivery.manifest);
    expect(saved.delivery.status).toBe("sent");
  });

  it("continues a legacy partial delivery whose saved photo order is unchanged", async () => {
    const user = await createUser();
    const urls = Array.from({ length: 7 }, (_, index) => `https://assetinsight.test/unchanged-${index}.jpg`);
    const lots = [{ lot_id: "lot-222", lot_number: "222", title: "Trailer", image_urls: urls, image_url: urls[0], image_indexes: [] }];
    const report = await createReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType: "asset", lots, cycleKey: "legacy-photo-stable", deliveryStatus: "queued" });
    await AuctioneerWorkItem.updateOne({ _id: workItem._id }, { $set: { "delivery.lots.0.step": "photos_uploaded:5", "delivery.lots.0.patchedAt": new Date() } });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(photoSource.loadAuctioneerPhoto.mock.calls.map(([url]) => url)).toEqual(urls.slice(5));
    expect(upstream.patchLot).not.toHaveBeenCalled();
    expect((await AuctioneerWorkItem.findById(workItem._id))?.delivery.status).toBe("sent");
  });

  it.each(["asset", "lotListing"] as const)("delivers every %s photo in saved URL order, not a stale cover or shifted global index", async (reportType) => {
    const user = await createUser();
    const imageUrls = Array.from({ length: 41 }, (_, index) => `https://assetinsight.test/lot-222/photo-${index}.jpg`);
    const lots = [{ lot_id: "lot-222", lot_number: "222", auctioneer_source_key: "source-222", title: "Trailer", image_urls: imageUrls, image_indexes: imageUrls.map((_, index) => index + 1), image_url: imageUrls[12], cover_index: 12 }];
    const report = reportType === "asset" ? await createReport(user._id, lots) : await createLotListingReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType, lots, cycleKey: `photo-order-${reportType}`, deliveryStatus: "queued" });
    await AuctioneerWorkItem.updateOne({ _id: workItem._id }, { $set: { "delivery.manifest.previewData.imageUrls": [imageUrls[0], ...imageUrls] } });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(photoSource.loadAuctioneerPhoto.mock.calls.map(([url]) => url)).toEqual(imageUrls);
    expect(upstream.uploadLotPhotos.mock.calls.flatMap(([, photos]) => photos.map((photo: any) => photo.order))).toEqual(imageUrls.map((_, index) => index));
    expect((await AuctioneerWorkItem.findById(workItem._id))?.delivery.status).toBe("sent");
  });

  it("queues and sends a generated Lot Listing without approval or release", async () => {
    const user = await createUser();
    const lots = [
      {
        lot_id: "report-lot-listing",
        auctioneer_source_key: "source-lot-listing",
        title: "Skid Steer",
        description: "Starts and operates",
        estimated_value: "CA$15,000",
        image_indexes: [],
      },
    ];
    const report = await createLotListingReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({
      userId: user._id,
      reportId: report._id,
      reportType: "lotListing",
      lots,
      cycleKey: "cycle-lot-listing-no-approval",
    });

    await expect(
      getAuctioneerDeliverySummary(String(workItem._id), String(user._id))
    ).resolves.toMatchObject({
      reportType: "lotListing",
      state: "ready",
      canSend: true,
      reportStatus: "preview",
      filesReady: true,
    });

    await expect(
      queueAuctioneerDelivery(String(workItem._id), String(user._id), {
        destination: "LottingBoard",
        completeContract: false,
      })
    ).resolves.toMatchObject({
      reportType: "lotListing",
      state: "queued",
    });

    await runAuctioneerDeliveryJob(String(workItem._id));

    const saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    const unchangedReport = await LotListing.findById(report._id).lean();
    expect(saved?.delivery.status).toBe("sent");
    expect(saved?.status).toBe("sent");
    expect(unchangedReport?.status).toBe("preview");
    expect(unchangedReport?.release_status).toBeUndefined();
    expect(upstream.patchLot).toHaveBeenCalledWith(
      "upstream-1",
      expect.objectContaining({ estimatedValue: "15000" })
    );
    expect(upstream.completeConditionReport).toHaveBeenCalledWith(
      "upstream-1",
      expect.objectContaining({
        estimatedValue: "15000",
        conditionReport: expect.any(String),
      })
    );
  });

  it("sends the walkaround video with the lot", async () => {
    /*
     * The portal has held a place for this since 2026-09-26 and the public site
     * already looks for it, but nothing in the delivery ever read videoUrls, so
     * the video never left Asset Insight.
     */
    const user = await createUser();
    const lots = [
      {
        lot_id: "report-lot-video",
        auctioneer_source_key: "source-lot-video",
        title: "Skid Steer",
        description: "Starts and operates",
        estimated_value: "CA$15,000",
        image_indexes: [],
        video_urls: ["https://youtu.be/AbCdEfGhI_1"],
      },
    ];
    const report = await createLotListingReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({
      userId: user._id,
      reportId: report._id,
      reportType: "lotListing",
      lots,
      cycleKey: "cycle-lot-video",
    });
    await queueAuctioneerDelivery(String(workItem._id), String(user._id), {
      destination: "LottingBoard",
      completeContract: false,
    });

    await runAuctioneerDeliveryJob(String(workItem._id));

    const saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(saved?.delivery.status).toBe("sent");
    expect(upstream.setLotVideo).toHaveBeenCalledWith(
      "upstream-1",
      "https://www.youtube.com/watch?v=AbCdEfGhI_1"
    );
    /*
     * Canonical links are independent of photo downloads; the original report
     * text is unchanged and the selected video is checkpointed separately.
     */
  });

  it("retains a refused video as a failed checkpoint instead of claiming success", async () => {
    /*
     * A response is not proof of acceptance. Keep the existing photo checkpoint
     * and permit an explicit same-link retry without resending photographs.
     */
    const { Auctioneer2ClientError } = await import(
      "../src/service/auctioneer2Client.js"
    );
    upstream.setLotVideo.mockRejectedValue(
      new Auctioneer2ClientError(
        "video_url must be a YouTube link — a watch, youtu.be, embed or shorts URL, or the bare video id",
        { statusCode: 400, code: "auctioneer2_invalid_video" }
      )
    );

    const user = await createUser();
    const lots = [
      {
        lot_id: "report-lot-bad-video",
        auctioneer_source_key: "source-lot-bad-video",
        title: "Skid Steer",
        description: "Starts and operates",
        estimated_value: "CA$15,000",
        image_indexes: [],
        video_urls: ["https://youtu.be/AbCdEfGhI_1"],
      },
    ];
    const report = await createLotListingReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({
      userId: user._id,
      reportId: report._id,
      reportType: "lotListing",
      lots,
      cycleKey: "cycle-lot-bad-video",
    });
    await queueAuctioneerDelivery(String(workItem._id), String(user._id), {
      destination: "LottingBoard",
      completeContract: false,
    });

    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow("Auctioneer rejected the lot video link");

    const saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(saved?.delivery.status).toBe("failed");
    expect(saved?.delivery.lots[0].photosUploadedAt).toBeTruthy();
    expect(saved?.delivery.lots[0].videoUploadedAt).toBeUndefined();
    expect(upstream.completeConditionReport).not.toHaveBeenCalled();
  });

  it("asks for no video when the report carries none", async () => {
    // The overwhelmingly common case, and it must cost nothing.
    const user = await createUser();
    const lots = [
      {
        lot_id: "report-lot-no-video",
        auctioneer_source_key: "source-lot-no-video",
        title: "Skid Steer",
        description: "Starts and operates",
        estimated_value: "CA$15,000",
        image_indexes: [],
      },
    ];
    const report = await createLotListingReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({
      userId: user._id,
      reportId: report._id,
      reportType: "lotListing",
      lots,
      cycleKey: "cycle-lot-no-video",
    });
    await queueAuctioneerDelivery(String(workItem._id), String(user._id), {
      destination: "LottingBoard",
      completeContract: false,
    });

    await runAuctioneerDeliveryJob(String(workItem._id));

    expect(upstream.setLotVideo).not.toHaveBeenCalled();
  });

  it("partitions Base64 photo delivery by file-count and decoded-byte limits", async () => {
    const user = await createUser();
    const imageUrls = Array.from(
      { length: 7 },
      (_, index) => `https://images.sellsnap.store/photo-${index + 1}.jpg`
    );
    const lots = [
      {
        lot_id: "report-photo-batches",
        auctioneer_source_key: "source-photo-batches",
        title: "Loader",
        description: "Photo batching test",
        image_urls: imageUrls,
      },
    ];
    const report = await createReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({
      userId: user._id,
      reportId: report._id,
      reportType: "asset",
      lots,
      cycleKey: "cycle-photo-batches",
      deliveryStatus: "queued",
    });
    photoSource.loadAuctioneerPhoto.mockImplementation(
      async (sourceUrl: string, lotIndex: number, photoIndex: number) => ({
        buffer:
          photoIndex < 5
            ? Buffer.from(`small-${photoIndex}`)
            : Buffer.alloc(18 * 1024 * 1024, photoIndex),
        contentType: "image/jpeg",
        filename: `lot-${String(lotIndex + 1).padStart(3, "0")}-photo-${String(
          photoIndex + 1
        ).padStart(3, "0")}.jpg`,
        sourceUrl,
      })
    );

    await runAuctioneerDeliveryJob(String(workItem._id));

    expect(upstream.uploadLotPhotos).toHaveBeenCalledTimes(3);
    expect(
      upstream.uploadLotPhotos.mock.calls.map(([, photos]) => photos.length)
    ).toEqual([5, 1, 1]);
    expect(
      upstream.uploadLotPhotos.mock.calls.flatMap(([, photos]) =>
        photos.map((photo: any) => photo.order)
      )
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(saved?.delivery.lots[0]).toMatchObject({
      status: "sent",
      step: "sent",
    });
  });

  it("blocks an Asset Report with generated files until it is approved and released", async () => {
    const user = await createUser();
    const lots = [
      {
        lot_id: "report-asset-unapproved",
        auctioneer_source_key: "source-asset-unapproved",
        title: "Excavator",
        description: "Generated but not approved",
        image_indexes: [],
      },
    ];
    const report = await createReport(user._id, lots);
    report.status = "preview";
    report.release_status = undefined;
    await report.save();
    const workItem = await createLinkedScheduleAWorkItem({
      userId: user._id,
      reportId: report._id,
      reportType: "asset",
      lots,
      cycleKey: "cycle-asset-unapproved",
    });

    await expect(
      getAuctioneerDeliverySummary(String(workItem._id), String(user._id))
    ).resolves.toMatchObject({
      reportType: "asset",
      state: "not_ready",
      canSend: false,
      reportStatus: "preview",
      filesReady: true,
    });
    await expect(
      queueAuctioneerDelivery(String(workItem._id), String(user._id), {
        destination: "LottingBoard",
        completeContract: false,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "delivery_not_ready",
    });

    await AuctioneerWorkItem.collection.updateOne(
      { _id: workItem._id },
      {
        $set: {
          "delivery.status": "queued",
          "delivery.destination": "LottingBoard",
          "delivery.manifest": {
            previewData: { lots },
            destination: "LottingBoard",
            completeContract: false,
          },
        },
      }
    );
    await expect(
      runAuctioneerDeliveryJob(String(workItem._id))
    ).rejects.toThrow("approved and released");
    const saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(saved?.delivery.status).toBe("failed");
    expect(upstream.patchLot).not.toHaveBeenCalled();
  });

  it("blocks a Lot Listing when its required generated files are missing", async () => {
    const user = await createUser();
    const lots = [
      {
        lot_id: "report-lot-listing-no-files",
        auctioneer_source_key: "source-lot-listing-no-files",
        title: "Loader",
        description: "Preview only",
        image_indexes: [],
      },
    ];
    const report = await createLotListingReport(user._id, lots, {
      excel: "https://files.example/lot-listing.xlsx",
    });
    const workItem = await createLinkedScheduleAWorkItem({
      userId: user._id,
      reportId: report._id,
      reportType: "lotListing",
      lots,
      cycleKey: "cycle-lot-listing-no-files",
    });

    await expect(
      getAuctioneerDeliverySummary(String(workItem._id), String(user._id))
    ).resolves.toMatchObject({
      reportType: "lotListing",
      state: "not_ready",
      canSend: false,
      reportStatus: "preview",
      filesReady: false,
    });
    await expect(
      queueAuctioneerDelivery(String(workItem._id), String(user._id), {
        destination: "LottingBoard",
        completeContract: false,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "delivery_not_ready",
    });
    expect(upstream.patchLot).not.toHaveBeenCalled();
  });

  it("checkpoints each Schedule A lot and completes the contract only after all lots", async () => {
    const user = await createUser();
    const lots = [
      {
        lot_id: "report-lot-1",
        auctioneer_source_key: "source-1",
        title: "Excavator",
        description: "Starts and operates",
        image_indexes: [],
      },
      {
        lot_id: "report-lot-2",
        auctioneer_source_key: "source-2",
        title: "Loader",
        description: "Good condition",
        image_indexes: [],
      },
    ];
    const report = await createReport(user._id, lots);
    const workItem = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "cycle-schedule-a",
      activeContractKey: "contract-1",
      contract: {
        id: "contract-1",
        contractNo: "C-100",
        eventId: "event-1",
      },
      kind: "scheduleA",
      snapshot: {
        tasks: [],
        capturedAt: new Date(),
        lots: [
          {
            sourceKey: "source-1",
            lotId: "upstream-1",
            submissionId: "submission-1",
            raw: {},
          },
          {
            sourceKey: "source-2",
            lotId: "upstream-2",
            submissionId: "submission-2",
            raw: {},
          },
        ],
      },
      claimedBy: user._id,
      selectedReportType: "asset",
      clientSubmissionId: "auctioneer2-cycle-schedule-a",
      linkedReportModel: "AssetReport",
      linkedReportId: report._id,
      status: "report_created",
      delivery: {
        status: "queued",
        destination: "LottingBoard",
        completeContract: true,
        attempts: 1,
        manifest: {
          previewData: { lots },
          destination: "LottingBoard",
          completeContract: true,
        },
        lots: [
          {
            sourceKey: "source-1",
            sourceLotId: "upstream-1",
            sourceSubmissionId: "submission-1",
            status: "pending",
          },
          {
            sourceKey: "source-2",
            sourceLotId: "upstream-2",
            sourceSubmissionId: "submission-2",
            status: "pending",
          },
        ],
      },
    });

    await runAuctioneerDeliveryJob(String(workItem._id));

    const saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(saved?.delivery.status).toBe("sent");
    expect(saved?.status).toBe("sent");
    expect(saved?.activeContractKey).toBeUndefined();
    expect(saved?.delivery.lots.map((lot) => lot.status)).toEqual([
      "sent",
      "sent",
    ]);
    expect(upstream.patchLot.mock.calls.map(([lotId]) => lotId)).toEqual([
      "upstream-1",
      "upstream-2",
    ]);
    expect(upstream.completeConditionReport).toHaveBeenCalledTimes(2);
    expect(upstream.completeContractTask).toHaveBeenCalledTimes(1);
    // Unassigned work has nobody to name: it still closes the contract itself.
    expect(upstream.completeContractTask).toHaveBeenCalledWith("contract-1", {
      completedBy: "Auctioneer Worker",
    });
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    // No per-user part was closed, and the summary says the contract itself
    // closed, so the web client words it as the whole contract.
    expect(saved?.delivery.contractCompletedAt).toEqual(expect.any(Date));
    expect(saved?.delivery.contractClose).toBeUndefined();
    await expect(
      getAuctioneerDeliverySummary(String(workItem._id), String(user._id))
    ).resolves.toMatchObject({
      contractCompletionScope: "contract",
      contractClosedAt: expect.any(Date),
      contractTaskCompleted: true,
    });
    expect(
      upstream.completeConditionReport.mock.calls[0][1]
    ).toMatchObject({
      destination: "LottingBoard",
      completedBy: "Auctioneer Worker",
      submissionGuid: "submission-1",
    });
  });

  it.each(["asset", "lotListing"] as const)("persists a new %s lot identity and sends photos before its video", async reportType => {
    const user = await createUser();
    const lots = [
      {
        lot_id: "report-unknown-row-guid",
        lot_number: "007B",
        auctioneer_source_key: "unknown-row-guid-source",
        title: "Tractor",
        description: "Field-created lot",
        image_indexes: [],
        image_urls: ["https://images.sellsnap.store/new-lot-photo.jpg"],
        video_urls: ["https://youtu.be/AbCdEfGhI_1"],
      },
    ];
    const report = reportType === "asset" ? await createReport(user._id, lots) : await createLotListingReport(user._id, lots);
    const workItem = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "cycle-unknown-row-guid",
      activeContractKey: "contract-unknown-row-guid",
      contract: {
        id: "contract-unknown-row-guid",
        contractNo: "C-ROW-GUID",
        eventId: "event-row-guid",
      },
      kind: "unknown",
      snapshot: {
        tasks: [],
        capturedAt: new Date(),
        lots: [{ sourceKey: "unknown-row-guid-source", raw: {} }],
      },
      claimedBy: user._id,
      selectedReportType: reportType,
      clientSubmissionId: "auctioneer2-cycle-unknown-row-guid",
      linkedReportModel: reportType === "asset" ? "AssetReport" : "LotListing",
      linkedReportId: report._id,
      status: "report_created",
      delivery: {
        status: "queued",
        destination: "LottingBoard",
        completeContract: false,
        attempts: 1,
        manifest: {
          previewData: { lots },
          destination: "LottingBoard",
          completeContract: false,
        },
        lots: [{ sourceKey: "unknown-row-guid-source", status: "pending" }],
      },
    });
    upstream.submitLot.mockResolvedValueOnce({
      success: true,
      data: {
        lot: { rowGuid: "created-emp-lot-row-guid" },
        submissionId: "created-submission-row-guid",
      },
    });
    upstream.getLot.mockResolvedValueOnce({ status: "AwaitingArrival", photos: [] });
    upstream.pushToAssetInsight.mockResolvedValueOnce({
      success: true,
      newStatus: "OpToDo",
      submissionId: "created-submission-row-guid",
    });

    await runAuctioneerDeliveryJob(String(workItem._id));

    const saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(saved?.delivery.lots[0]).toMatchObject({
      createdLotId: "created-emp-lot-row-guid",
      createdSubmissionId: "created-submission-row-guid",
      status: "sent",
      step: "sent",
    });
    expect(saved?.delivery.lots[0].photosUploadedAt).toBeTruthy();
    expect(saved?.delivery.lots[0].videoUploadedAt).toBeTruthy();
    expect(upstream.setLotVideo).toHaveBeenCalledWith("created-emp-lot-row-guid", "https://www.youtube.com/watch?v=AbCdEfGhI_1");
    expect(upstream.uploadLotPhotos.mock.invocationCallOrder[0]).toBeLessThan(upstream.setLotVideo.mock.invocationCallOrder[0]);
    expect(upstream.setLotVideo.mock.invocationCallOrder[0]).toBeLessThan(upstream.completeConditionReport.mock.invocationCallOrder[0]);
    expect(upstream.getLot.mock.calls.map(([lotId]) => lotId)).toEqual([
      "created-emp-lot-row-guid",
    ]);
    expect(upstream.markArrived).toHaveBeenCalledWith(
      "created-emp-lot-row-guid",
      expect.any(Object)
    );
    expect(upstream.pushToAssetInsight).toHaveBeenCalledWith(
      "created-emp-lot-row-guid",
      expect.any(Object)
    );
    expect(upstream.completeConditionReport).toHaveBeenCalledWith(
      "created-emp-lot-row-guid",
      expect.objectContaining({ lotNumber: "007B", submissionGuid: "created-submission-row-guid" })
    );
  });

  it("stops an ambiguous Unknown Lot creation and requires reconciliation without resubmitting", async () => {
    const user = await createUser();
    const lots = [
      {
        lot_id: "report-lot-1",
        auctioneer_source_key: "unknown-source",
        title: "Tractor",
        description: "Field-created lot",
        image_indexes: [],
      },
    ];
    const report = await createReport(user._id, lots);
    const workItem = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "cycle-unknown",
      activeContractKey: "contract-unknown",
      contract: {
        id: "contract-unknown",
        contractNo: "C-200",
        eventId: "event-2",
      },
      kind: "unknown",
      snapshot: {
        tasks: [],
        capturedAt: new Date(),
        lots: [{ sourceKey: "unknown-source", raw: {} }],
      },
      claimedBy: user._id,
      selectedReportType: "asset",
      clientSubmissionId: "auctioneer2-cycle-unknown",
      linkedReportModel: "AssetReport",
      linkedReportId: report._id,
      status: "report_created",
      delivery: {
        status: "queued",
        destination: "LottingBoard",
        completeContract: false,
        attempts: 1,
        manifest: {
          previewData: { lots },
          destination: "LottingBoard",
          completeContract: false,
        },
        lots: [{ sourceKey: "unknown-source", status: "pending" }],
      },
    });
    upstream.submitLot.mockRejectedValueOnce(
      new Auctioneer2ClientError("Auctioneer 2.0 did not respond before the timeout.", {
        statusCode: 504,
        code: "auctioneer2_timeout",
        ambiguousWrite: true,
      })
    );

    await expect(
      runAuctioneerDeliveryJob(String(workItem._id))
    ).rejects.toThrow("Reconcile");

    let saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(saved?.delivery.status).toBe("needs_reconciliation");
    expect(saved?.delivery.reconciliation).toMatchObject({
      required: true,
      sourceKey: "unknown-source",
    });
    expect(saved?.delivery.lots[0]).toMatchObject({
      status: "needs_reconciliation",
      step: "submitting",
    });

    await expect(
      runAuctioneerDeliveryJob(String(workItem._id))
    ).rejects.toThrow("requires reconciliation");
    saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(saved?.delivery.status).toBe("needs_reconciliation");
    expect(upstream.submitLot).toHaveBeenCalledTimes(1);
  });

});

/*
   Several Asset Insight users can be assigned to one contract. A delivery for
   assigned work may close ONLY its own user's part — named by id — and
   Auctioneer decides when the whole contract is complete (owner, 2026-10-02).
*/
describe("Closing a user's part of the contract after delivery", () => {
  const scopedLots = [
    {
      lot_id: "report-lot-scoped",
      auctioneer_source_key: "source-scoped",
      title: "Loader",
      description: "Assigned loader",
      image_indexes: [],
    },
  ];

  async function scopedWorkItem(options: { assignedTo?: mongoose.Types.ObjectId } = {}) {
    const user = await createUser();
    const report = await createReport(user._id, scopedLots);
    const workItem = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "cycle-user-scoped",
      activeContractKey: "scoped-active-key",
      assignmentUserId: options.assignedTo ?? user._id,
      contract: {
        id: "contract-scoped",
        contractNo: "C-SCOPED",
        eventId: "event-scoped",
      },
      kind: "scheduleA",
      snapshot: {
        tasks: [],
        capturedAt: new Date(),
        lots: [
          {
            sourceKey: "source-scoped",
            lotId: "upstream-scoped",
            submissionId: "submission-scoped",
            raw: {},
          },
        ],
      },
      claimedBy: user._id,
      selectedReportType: "asset",
      clientSubmissionId: "auctioneer2-user-scoped",
      linkedReportModel: "AssetReport",
      linkedReportId: report._id,
      status: "report_created",
      delivery: {
        status: "ready",
        completeContract: false,
        attempts: 0,
        lots: [
          {
            sourceKey: "source-scoped",
            sourceLotId: "upstream-scoped",
            sourceSubmissionId: "submission-scoped",
            status: "pending",
          },
        ],
      },
    });
    return { user, report, workItem };
  }

  it("closes only the assigned user's part, by id, once after every lot lands", async () => {
    const { user, workItem } = await scopedWorkItem();
    const userId = String(user._id);

    await expect(getAuctioneerDeliverySummary(String(workItem._id), userId)).resolves.toMatchObject({
      canCompleteContract: true,
      contractCompletionScope: "user",
      completeContract: false,
      contractClosedAt: null,
      contractTaskCompleted: null,
    });
    await queueAuctioneerDelivery(String(workItem._id), userId, {
      destination: "LottingBoard",
      completeContract: true,
    });
    await runAuctioneerDeliveryJob(String(workItem._id));

    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(1);
    expect(upstream.closeContractPartForUser).toHaveBeenCalledWith("contract-scoped", {
      completedBy: "Auctioneer Worker",
      completedByUserId: userId,
    });
    // The unnamed whole-contract call is never used for assigned work.
    expect(upstream.completeContractTask).not.toHaveBeenCalled();
    // The lot is reported back BEFORE the part is closed.
    expect(upstream.completeConditionReport.mock.invocationCallOrder[0]).toBeLessThan(
      upstream.closeContractPartForUser.mock.invocationCallOrder[0]
    );
    const saved = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(saved?.delivery).toMatchObject({
      status: "sent",
      completeContract: true,
      contractCompletedAt: expect.any(Date),
      contractClose: { userId, closedAt: expect.any(Date), taskCompleted: false, userStatus: "completed", via: "delivery" },
    });
    await expect(getAuctioneerDeliverySummary(String(workItem._id), userId)).resolves.toMatchObject({
      state: "sent",
      completeContract: true,
      contractClosedAt: expect.any(Date),
      contractTaskCompleted: false,
    });

    // Running the finished job again changes nothing upstream.
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(1);
    expect(upstream.completeConditionReport).toHaveBeenCalledTimes(1);
  });

  it("records that the whole contract completed when the last assigned user closes", async () => {
    upstream.closeContractPartForUser.mockResolvedValueOnce({
      contractId: "contract-scoped",
      userId: null,
      userStatus: "completed",
      taskCompleted: true,
      alreadyCompleted: false,
    });
    const { user, workItem } = await scopedWorkItem();
    await queueAuctioneerDelivery(String(workItem._id), String(user._id), { destination: "LottingBoard", completeContract: true });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect((await AuctioneerWorkItem.findById(workItem._id).lean())?.delivery.contractClose).toMatchObject({ taskCompleted: true });
  });

  it("lets two closing deliveries finish without deadlocking or resending already-sent lots", async () => {
    const { user, workItem: first } = await scopedWorkItem();
    const userId = String(user._id);
    const secondLots = [{ lot_id: "second-lot", auctioneer_source_key: "source-second", title: "Second loader", description: "Second delivery", image_indexes: [] }];
    const secondReport = await createLotListingReport(user._id, secondLots);
    const second = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: secondReport._id, reportType: "lotListing", lots: secondLots, cycleKey: "second-close", contractId: "contract-scoped", assignmentUserId: user._id, deliveryStatus: "ready" });
    const settings = { destination: "LottingBoard" as const, completeContract: true };
    await queueAuctioneerDelivery(String(first._id), userId, settings);
    await queueAuctioneerDelivery(String(second._id), userId, settings);

    // A cannot close while B still has media to send; A's completed lots stay saved.
    await expect(runAuctioneerDeliveryJob(String(first._id))).rejects.toThrow("another delivery for this contract is unfinished");
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    expect((await AuctioneerWorkItem.findById(first._id).lean())?.delivery).toMatchObject({ status: "failed", lots: [{ status: "sent" }] });

    // Once B finishes its lots, A's close-only failure must not prevent B closing.
    await runAuctioneerDeliveryJob(String(second._id));
    expect((await AuctioneerWorkItem.findById(second._id).lean())?.delivery.status).toBe("sent");
    await queueAuctioneerDelivery(String(first._id), userId, settings);
    await runAuctioneerDeliveryJob(String(first._id));
    expect((await AuctioneerWorkItem.findById(first._id).lean())?.delivery.status).toBe("sent");
    expect(upstream.patchLot).toHaveBeenCalledTimes(2);
    expect(upstream.completeConditionReport).toHaveBeenCalledTimes(2);
    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(2);
    expect(upstream.closeContractPartForUser.mock.calls.every(([contractId, input]) => contractId === "contract-scoped" && input.completedByUserId === userId)).toBe(true);
  });

  // The client error class is imported in beforeAll, so build it lazily.
  it.each([
    ["a lost response", () => new Auctioneer2ClientError("Auctioneer 2.0 did not respond before the timeout.", { statusCode: 504, code: "auctioneer2_timeout" })],
    ["an ambiguous-user refusal", () => new Auctioneer2ClientError("AMBIGUOUS_COMPLETION_USER: Auctioneer could not tell whose part of the contract to close.", { statusCode: 409, code: "AMBIGUOUS_COMPLETION_USER", upstreamStatus: 409 })],
  ])("keeps the delivery retryable after %s and closes on retry without resending lots", async (_case, makeFailure) => {
    const failure = makeFailure();
    const { user, workItem } = await scopedWorkItem();
    const userId = String(user._id);
    upstream.closeContractPartForUser.mockRejectedValueOnce(failure);
    await queueAuctioneerDelivery(String(workItem._id), userId, { destination: "LottingBoard", completeContract: true });

    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow(
      "Every lot was delivered, but Auctioneer did not confirm closing your part of the contract."
    );
    const failed = await AuctioneerWorkItem.findById(workItem._id).lean();
    expect(failed?.delivery).toMatchObject({ status: "failed", lots: [{ status: "sent" }] });
    expect(failed?.delivery.lastError).toContain(failure.message);
    expect(failed?.delivery.lastError).toContain("Retry the same delivery");
    expect(failed?.delivery.contractCompletedAt).toBeUndefined();
    expect(failed?.delivery.contractClose).toBeUndefined();

    // A retry must keep the original close setting.
    await expect(queueAuctioneerDelivery(String(workItem._id), userId, { destination: "LottingBoard", completeContract: false }))
      .rejects.toMatchObject({ code: "delivery_retry_settings_locked" });
    await queueAuctioneerDelivery(String(workItem._id), userId, { destination: "LottingBoard", completeContract: true });
    await runAuctioneerDeliveryJob(String(workItem._id));

    // Auctioneer is idempotent, so the second ask is safe; the lot is not resent.
    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(2);
    expect(upstream.closeContractPartForUser.mock.calls.every(([, input]) => input.completedByUserId === userId)).toBe(true);
    expect(upstream.patchLot).toHaveBeenCalledTimes(1);
    expect(upstream.completeConditionReport).toHaveBeenCalledTimes(1);
    expect((await AuctioneerWorkItem.findById(workItem._id).lean())?.delivery).toMatchObject({
      status: "sent",
      contractClose: { userId, via: "delivery" },
    });
  });

  it("never closes a part on behalf of a different assigned user", async () => {
    const otherUserId = new mongoose.Types.ObjectId();
    const { user, workItem } = await scopedWorkItem({ assignedTo: otherUserId });
    await expect(
      queueAuctioneerDelivery(String(workItem._id), String(user._id), { destination: "LottingBoard", completeContract: true })
    ).rejects.toMatchObject({ statusCode: 409, code: "auctioneer_contract_completion_not_allowed" });

    // The worker refuses it too, even if the setting reached the saved manifest.
    await AuctioneerWorkItem.collection.updateOne({ _id: workItem._id }, {
      $set: {
        "delivery.status": "queued",
        "delivery.destination": "LottingBoard",
        "delivery.completeContract": true,
        "delivery.manifest": { previewData: { lots: scopedLots }, destination: "LottingBoard", completeContract: true },
      },
    });
    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow("only they can close their part");
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    expect(upstream.completeContractTask).not.toHaveBeenCalled();
  });

  it("does not close anything when the user leaves the box unticked", async () => {
    const { user, workItem } = await scopedWorkItem();
    await queueAuctioneerDelivery(String(workItem._id), String(user._id), { destination: "LottingBoard", completeContract: false });
    await runAuctioneerDeliveryJob(String(workItem._id));
    expect((await AuctioneerWorkItem.findById(workItem._id).lean())?.delivery.status).toBe("sent");
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    expect(upstream.completeContractTask).not.toHaveBeenCalled();
  });
});

/*
   A lot pushed back from the Operations To-Do Board for re-inspection usually
   still carries conditionReportDone from its first report and sits at OpToDo,
   which is what a finished To-Do delivery looks like. Auctioneer marks such a
   lot with awaitingAssetInsightReinspection while the job is out with Asset
   Insight; delivery must then send it in full.
*/
describe("Re-inspection lots sent back from the To-Do Board", () => {
  async function queuedToDoDelivery() {
    const user = await createUser();
    const photo = "https://images.sellsnap.store/reinspection.jpg";
    const lots = [{ lot_id: "reinspected", auctioneer_source_key: "source-1", lot_number: "7", title: "Loader", description: "Re-checked hydraulics", image_urls: [photo] }];
    const report = await createReport(user._id, lots);
    const workItem = await createLinkedScheduleAWorkItem({ userId: user._id, reportId: report._id, reportType: "asset", lots, cycleKey: "reinspection", deliveryStatus: "queued" });
    await AuctioneerWorkItem.updateOne({ _id: workItem._id }, {
      $set: {
        "delivery.destination": "OpToDoBoard",
        "delivery.opTaskDescription": "Re-inspected as asked",
        "delivery.manifest.destination": "OpToDoBoard",
        "delivery.manifest.opTaskDescription": "Re-inspected as asked",
        "delivery.manifest.photoOrderVersion": 2,
        "delivery.manifest.photoUrlsByLot": [[photo]],
      },
    });
    return workItem;
  }

  it("sends PATCH, photos and complete-cr while Auctioneer says the lot awaits re-inspection", async () => {
    upstream.getLot.mockResolvedValue({ id: "upstream-1", status: "OpToDo", conditionReportDone: true, lotNumber: "7", awaitingAssetInsightReinspection: true, photos: [] });
    const workItem = await queuedToDoDelivery();

    await runAuctioneerDeliveryJob(String(workItem._id));

    expect(upstream.patchLot).toHaveBeenCalledTimes(1);
    expect(upstream.patchLot.mock.calls[0][0]).toBe("upstream-1");
    expect(upstream.uploadLotPhotos).toHaveBeenCalledTimes(1);
    expect(upstream.completeConditionReport).toHaveBeenCalledTimes(1);
    expect(upstream.completeConditionReport).toHaveBeenCalledWith("upstream-1", expect.objectContaining({
      destination: "OpToDoBoard",
      opTaskDescription: "Re-inspected as asked",
      submissionGuid: "submission-1",
    }));
    expect((await AuctioneerWorkItem.findById(workItem._id).lean())?.delivery).toMatchObject({
      status: "sent",
      lots: [{ status: "sent", conditionReportCompletedAt: expect.any(Date) }],
    });
  });

  it.each([
    ["missing (an older Auctioneer)", {}],
    ["false", { awaitingAssetInsightReinspection: false }],
  ])("keeps treating a finished To-Do lot as done when the flag is %s", async (_case, flag) => {
    upstream.getLot.mockResolvedValue({ id: "upstream-1", status: "OpToDo", conditionReportDone: true, lotNumber: "7", photos: [], ...flag });
    const workItem = await queuedToDoDelivery();

    await runAuctioneerDeliveryJob(String(workItem._id));

    expect(upstream.patchLot).not.toHaveBeenCalled();
    expect(upstream.uploadLotPhotos).not.toHaveBeenCalled();
    expect(upstream.completeConditionReport).not.toHaveBeenCalled();
    expect((await AuctioneerWorkItem.findById(workItem._id).lean())?.delivery).toMatchObject({
      status: "sent",
      lots: [{ status: "sent" }],
    });
  });

  it("does not send a re-inspection twice when a retry finds the job already finished", async () => {
    // complete-cr landed but its response was lost; Auctioneer then finished
    // the To-Do job, so the flag is gone when the retry reads the lot.
    upstream.getLot
      .mockResolvedValueOnce({ id: "upstream-1", status: "OpToDo", conditionReportDone: true, lotNumber: "7", awaitingAssetInsightReinspection: true, photos: [] })
      .mockResolvedValue({ id: "upstream-1", status: "OpToDo", conditionReportDone: true, lotNumber: "7", awaitingAssetInsightReinspection: false, photos: [] });
    upstream.completeConditionReport.mockRejectedValueOnce(new Auctioneer2ClientError("Auctioneer 2.0 did not respond before the timeout.", { statusCode: 504, code: "auctioneer2_timeout" }));
    const workItem = await queuedToDoDelivery();

    await expect(runAuctioneerDeliveryJob(String(workItem._id))).rejects.toThrow("timeout");
    await AuctioneerWorkItem.updateOne({ _id: workItem._id }, { $set: { "delivery.status": "queued" } });
    await runAuctioneerDeliveryJob(String(workItem._id));

    expect(upstream.completeConditionReport).toHaveBeenCalledTimes(1);
    expect(upstream.uploadLotPhotos).toHaveBeenCalledTimes(1);
    expect((await AuctioneerWorkItem.findById(workItem._id).lean())?.delivery.status).toBe("sent");
  });
});
