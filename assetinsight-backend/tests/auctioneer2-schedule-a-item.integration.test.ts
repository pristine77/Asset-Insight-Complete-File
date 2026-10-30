import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
   Owner 2026-10-28: a lot on a contract with a Schedule A is not sent to
   Auctioneer 2.0 until the appraiser has chosen which Schedule A item it
   belongs to. These cases cover the work item's choices, Send, the delivery
   and preview edits against a real (in-memory) database.
*/

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
// This suite's reports carry no condition-report PDF (see auctioneer2-delivery for that step).
vi.mock("../src/service/auctioneer2ConditionReportDocument.js", () => ({ buildLotConditionReportPdf: vi.fn(async () => null) }));

const upstream = vi.hoisted(() => ({
  getContractScheduleAItems: vi.fn(),
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
vi.mock("../src/service/auctioneer2Client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/auctioneer2Client.js")>(),
  ...upstream,
}));
vi.mock("../src/service/auctioneer2PhotoService.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/auctioneer2PhotoService.js")>(),
  trustedPhotoSource: vi.fn().mockReturnValue("r2"),
  loadAuctioneerPhoto: vi.fn(),
}));

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let Work: typeof import("../src/models/auctioneerWorkItem.model.js")["default"];
let Asset: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let integration: typeof import("../src/service/auctioneer2IntegrationService.js");
let delivery: typeof import("../src/service/auctioneer2DeliveryService.js");
let client: typeof import("../src/service/auctioneer2Client.js");
let ownerId: mongoose.Types.ObjectId;
let sequence = 0;
const savedEnv = Object.fromEntries(["AUCTIONEER2_API_BASE_URL", "AUCTIONEER2_API_KEY", "AUCTIONEER2_FEATURE_ENABLED", "DEVICE_APPROVAL_ENFORCEMENT"].map((key) => [key, process.env[key]]));

const ITEMS = [
  { lineId: "line-ford", title: "2021 Ford F150", severalLots: false, parentLotId: "lot-ford", lotCount: 1, sortOrder: 1 },
  { lineId: "line-tools", title: "Misc Shop Tools", severalLots: true, parentLotId: "lot-tools", lotCount: 1, sortOrder: 2 },
];
const TOOLS = { lineId: "line-tools", title: "Misc Shop Tools", parentLotId: "lot-tools" };

function auth() {
  return { Authorization: `Bearer ${jwt.sign({ id: String(ownerId), role: "user" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` };
}

async function workItem(extra: Record<string, any> = {}) {
  const n = ++sequence;
  return Work.create({
    source: "auctioneer2", cycleKey: `schedule-a-item-${n}`, activeContractKey: `schedule-a-item-active-${n}`,
    contract: { id: `contract-${n}`, contractNo: `C-${n}`, eventId: `event-${n}`, hasScheduleA: true },
    kind: "unknown", snapshot: { tasks: [], lots: [], capturedAt: new Date() },
    claimedBy: ownerId, selectedReportType: "asset", clientSubmissionId: `auctioneer2-schedule-a-item-${n}`,
    status: "claimed", delivery: { status: "not_ready", completeContract: false, attempts: 0, lots: [] },
    ...extra,
  });
}

async function linkedAsset(lots: any[], workExtra: Record<string, any> = {}) {
  const report = await Asset.create({
    user: ownerId, grouping_mode: "mixed", imageUrls: [], lots, contract_no: "C-SA",
    status: "approved", release_status: "released", job_status: "done",
    preview_data: { contract_no: "C-SA", lots },
    preview_files: { docx: "https://files.example/r.docx", excel: "https://files.example/r.xlsx", images: "https://files.example/r.zip" },
  });
  const work = await workItem({
    scheduleAChoices: [TOOLS], status: "report_created",
    linkedReportModel: "AssetReport", linkedReportId: report._id, ...workExtra,
  });
  await Asset.collection.updateOne({ _id: report._id }, { $set: { auctioneerWorkItem: work._id } });
  return { report, work };
}

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", process.env.RESEND_API_KEY || "re_schedule_a_item_test_only");
  process.env.AUCTIONEER2_API_BASE_URL = "https://auctioneer.example/api/external";
  process.env.AUCTIONEER2_API_KEY = "test-schedule-a-item";
  process.env.AUCTIONEER2_FEATURE_ENABLED = "true";
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: Work } = await import("../src/models/auctioneerWorkItem.model.js"));
  ({ default: Asset } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  integration = await import("../src/service/auctioneer2IntegrationService.js");
  delivery = await import("../src/service/auctioneer2DeliveryService.js");
  client = await import("../src/service/auctioneer2Client.js");
  ({ default: app } = await import("../src/app.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Work.createIndexes();
  integration.clearAuctioneer2IncomingCacheForTests();
  Object.values(upstream).forEach((mock) => mock.mockReset());
  upstream.getContractScheduleAItems.mockImplementation(async (contractId: string) => ({ contractId, hasScheduleA: true, items: ITEMS }));
  upstream.submitLot.mockResolvedValue({ success: true, lotId: "created-lot", submissionId: "created-submission" });
  upstream.getLot.mockResolvedValue({ id: "created-lot", status: "AwaitingArrival", photos: [] });
  upstream.markArrived.mockResolvedValue({ success: true, newStatus: "Arrived" });
  upstream.pushToAssetInsight.mockResolvedValue({ success: true, newStatus: "OpToDo" });
  upstream.completeConditionReport.mockResolvedValue({ success: true, newStatus: "Lotting" });
  const user = await User.create({ email: "schedule-a-item@example.test", username: "Schedule A appraiser",
    password: await bcrypt.hash("Password123!", 4), authProvider: "email", isVerified: true });
  ownerId = user._id as mongoose.Types.ObjectId;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.unstubAllEnvs();
});

describe.sequential("Schedule A item on a Schedule A contract's extra lots", () => {
  it("offers only Several lots items in setup and picks up an item the office ticks later", async () => {
    const work = await workItem();
    const first = await integration.getAuctioneerWorkItemSetup(String(work._id), String(ownerId));
    expect(first).toMatchObject({ kind: "unknown", requiresScheduleAItem: true, scheduleAChoices: [TOOLS] });
    expect((await Work.findById(work._id).lean())?.scheduleAChoices).toEqual([TOOLS]);

    // A second open inside the short cache window costs no provider read.
    await integration.getAuctioneerWorkItemSetup(String(work._id), String(ownerId));
    expect(upstream.getContractScheduleAItems).toHaveBeenCalledTimes(1);

    upstream.getContractScheduleAItems.mockResolvedValue({ contractId: work.contract.id, hasScheduleA: true,
      items: ITEMS.map((item) => ({ ...item, severalLots: true })) });
    integration.clearAuctioneer2IncomingCacheForTests();
    const ticked = await integration.getAuctioneerWorkItemSetup(String(work._id), String(ownerId));
    expect(ticked.scheduleAChoices).toEqual([
      { lineId: "line-ford", title: "2021 Ford F150", parentLotId: "lot-ford" }, TOOLS,
    ]);
    expect((await Work.findById(work._id).lean())?.scheduleAChoices).toHaveLength(2);
  });

  it("keeps the saved items when Auctioneer cannot answer, and leaves sent work alone", async () => {
    const work = await workItem({ scheduleAChoices: [TOOLS] });
    upstream.getContractScheduleAItems.mockRejectedValue(new client.Auctioneer2ClientError("Auctioneer 2.0 rejected the request with status 404.",
      { statusCode: 502, code: "auctioneer2_upstream_error", upstreamStatus: 404 }));
    expect((await integration.getAuctioneerWorkItemSetup(String(work._id), String(ownerId))).scheduleAChoices).toEqual([TOOLS]);
    expect((await Work.findById(work._id).lean())?.scheduleAChoices).toEqual([TOOLS]);

    upstream.getContractScheduleAItems.mockClear();
    const sent = await workItem({ scheduleAChoices: [TOOLS], status: "sent", activeContractKey: undefined,
      delivery: { status: "sent", completeContract: false, attempts: 1, lots: [] } });
    expect((await integration.getAuctioneerWorkItemSetup(String(sent._id), String(ownerId))).scheduleAChoices).toEqual([TOOLS]);
    expect(upstream.getContractScheduleAItems).not.toHaveBeenCalled();
  });

  it("asks nothing of Schedule A work and contracts without a Schedule A, and flags Several lots lines", async () => {
    const lines = await workItem({ kind: "scheduleA", snapshot: { tasks: [], capturedAt: new Date(), lots: [
      { sourceKey: "line-1", lotId: "lot-tools", scheduleALineId: "line-tools", severalLots: true, scheduleAItemTitle: "Misc Shop Tools" },
      { sourceKey: "line-2", lotId: "lot-older" },
    ] } });
    const setup = await integration.getAuctioneerWorkItemSetup(String(lines._id), String(ownerId));
    expect(setup).toMatchObject({ requiresScheduleAItem: false, scheduleAChoices: [] });
    expect(setup.lots).toEqual([
      { sourceKey: "line-1", lotId: "lot-tools", scheduleALineId: "line-tools", severalLots: true, scheduleAItemTitle: "Misc Shop Tools" },
      { sourceKey: "line-2", lotId: "lot-older", severalLots: false },
    ]);
    const plain = await workItem({ contract: { id: "contract-plain", contractNo: "C-PLAIN", eventId: "event-plain", hasScheduleA: false } });
    expect(await integration.getAuctioneerWorkItemSetup(String(plain._id), String(ownerId))).toMatchObject({ requiresScheduleAItem: false, scheduleAChoices: [] });
    expect(upstream.getContractScheduleAItems).not.toHaveBeenCalled();
  });

  it("refuses Send at once for a lot without its Schedule A item, then sends it under the chosen item", async () => {
    const lots = [
      { lot_id: "lot-001", auctioneer_source_key: "k1", title: "Air compressor", image_indexes: [], schedule_a_parent_lot_id: "lot-tools" },
      { lot_id: "lot-002", auctioneer_source_key: "k2", title: "Bench grinder", image_indexes: [] },
    ];
    const { report, work } = await linkedAsset(lots);
    await expect(integration.queueAuctioneerDelivery(String(work._id), String(ownerId), { destination: "LottingBoard" }))
      .rejects.toMatchObject({ statusCode: 409, code: "AUCTIONEER_SCHEDULE_A_ITEM_REQUIRED", message: "Choose which Schedule A item this lot belongs to." });
    expect((await Work.findById(work._id).lean())?.delivery).toMatchObject({ status: "not_ready", attempts: 0 });
    expect(upstream.submitLot).not.toHaveBeenCalled();

    const linked = lots.map((lot) => ({ ...lot, schedule_a_parent_lot_id: "lot-tools" }));
    await Asset.collection.updateOne({ _id: report._id }, { $set: { "preview_data.lots": linked, lots: linked } });
    await integration.queueAuctioneerDelivery(String(work._id), String(ownerId), { destination: "LottingBoard" });
    await delivery.runAuctioneerDeliveryJob(String(work._id));
    expect(upstream.submitLot).toHaveBeenCalledTimes(2);
    for (const [body] of upstream.submitLot.mock.calls) expect(body).toMatchObject({ scheduleAParentRef: "lot-tools" });
    expect((await Work.findById(work._id).lean())?.delivery.status).toBe("sent");
  });

  it("does not add a parent to an Unknown Lot on a contract without a Schedule A", async () => {
    const lots = [{ lot_id: "lot-001", auctioneer_source_key: "k1", title: "Trailer", image_indexes: [], schedule_a_parent_lot_id: "lot-tools" }];
    const { work } = await linkedAsset(lots, { contract: { id: "contract-plain", contractNo: "C-PLAIN", eventId: "event-plain", hasScheduleA: false } });
    await integration.queueAuctioneerDelivery(String(work._id), String(ownerId), { destination: "LottingBoard" });
    await delivery.runAuctioneerDeliveryJob(String(work._id));
    // A link on a plain Unknown Lot is never accepted at submission, and even
    // a stored one is not sent: the contract has no Schedule A to link to.
    expect(upstream.submitLot).toHaveBeenCalledTimes(1);
    expect(upstream.submitLot.mock.calls[0][0]).not.toHaveProperty("scheduleAParentRef");
  });

  it("records Auctioneer's Several lots refusal as the delivery error, word for word", async () => {
    const lots = [{ lot_id: "lot-001", auctioneer_source_key: "k1", title: "Air compressor", image_indexes: [], schedule_a_parent_lot_id: "lot-tools" }];
    const { work } = await linkedAsset(lots);
    const message = "SCHEDULE_A_ITEM_NOT_SEVERAL_LOTS: The Schedule A item chosen for this lot is not marked Several lots in Auctioneer 2.0. Ask the office to tick Several lots on that item, then retry sending.";
    upstream.submitLot.mockRejectedValue(new client.Auctioneer2ClientError(message,
      { statusCode: 409, code: "SCHEDULE_A_ITEM_NOT_SEVERAL_LOTS", upstreamStatus: 409 }));
    await integration.queueAuctioneerDelivery(String(work._id), String(ownerId), { destination: "LottingBoard" });
    await expect(delivery.runAuctioneerDeliveryJob(String(work._id))).rejects.toThrow(message);
    const failed = await Work.findById(work._id).lean();
    expect(failed?.delivery).toMatchObject({ status: "failed", lastError: message, lots: [{ status: "failed", step: "pending" }] });
    const summary = await integration.getAuctioneerDeliverySummary(String(work._id), String(ownerId));
    expect(summary.error).toBe(message);
  });

  it("restores a link a preview edit left out and refuses a lot left without one", async () => {
    const lots = [{ lot_id: "lot-001", lot_number: "1", title: "Air compressor", description: "Works", image_indexes: [], schedule_a_parent_lot_id: "lot-tools" }];
    const { report } = await linkedAsset(lots, { status: "report_created" });
    await Asset.collection.updateOne({ _id: report._id }, { $set: { status: "preview" } });

    const edited = await request(app).put(`/api/asset/${report._id}/preview`).set(auth())
      .send({ preview_data: { contract_no: "C-SA", lots: [{ lot_id: "lot-001", lot_number: "1", title: "Air compressor (edited)", description: "Works", image_indexes: [] }] } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.lots[0]).toMatchObject({ title: "Air compressor (edited)", schedule_a_parent_lot_id: "lot-tools" });

    const foreign = await request(app).put(`/api/asset/${report._id}/preview`).set(auth())
      .send({ preview_data: { contract_no: "C-SA", lots: [{ lot_id: "lot-001", lot_number: "1", title: "Air compressor", image_indexes: [], schedule_a_parent_lot_id: "lot-ford" }] } });
    expect(foreign.status).toBe(409);
    expect(foreign.body).toMatchObject({ code: "AUCTIONEER_SCHEDULE_A_ITEM_REQUIRED", message: "Choose which Schedule A item this lot belongs to." });
    expect((await Asset.findById(report._id).lean())?.preview_data?.lots?.[0]).toMatchObject({ title: "Air compressor (edited)", schedule_a_parent_lot_id: "lot-tools" });
  });

  it("refuses a Lot Listing preview edit on a report saved without links until the lot names its item", async () => {
    const lots = [{ lot_id: "lot-001", lot_number: "1", title: "Bench grinder", image_indexes: [] }];
    const listing = await LotListing.create({
      user: ownerId, contract_no: "C-LL", sales_date: new Date("2026-11-05T00:00:00.000Z"), location: "Regina, SK",
      imageUrls: [], lots, status: "preview", job_status: "done", preview_data: { contract_no: "C-LL", lots },
    });
    const work = await workItem({ selectedReportType: "lotListing", scheduleAChoices: [TOOLS], status: "report_created",
      linkedReportModel: "LotListing", linkedReportId: listing._id });
    await LotListing.collection.updateOne({ _id: listing._id }, { $set: { auctioneerWorkItem: work._id } });

    const refused = await request(app).put(`/api/lot-listing/${listing._id}/preview`).set(auth())
      .send({ preview_data: { lots: [{ ...lots[0], title: "Bench grinder (edited)" }] } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("AUCTIONEER_SCHEDULE_A_ITEM_REQUIRED");

    const accepted = await request(app).put(`/api/lot-listing/${listing._id}/preview`).set(auth())
      .send({ preview_data: { lots: [{ ...lots[0], title: "Bench grinder (edited)", schedule_a_parent_lot_id: "lot-tools" }] } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const saved = await LotListing.findById(listing._id).lean();
    expect(saved?.preview_data?.lots?.[0]).toMatchObject({ title: "Bench grinder (edited)", schedule_a_parent_lot_id: "lot-tools" });
    expect(saved?.lots?.[0]).toMatchObject({ schedule_a_parent_lot_id: "lot-tools" });

    // Once the work is sent nothing more is created in Auctioneer; edits are not refused.
    await Work.updateOne({ _id: work._id }, { $set: { status: "sent", "delivery.status": "sent" }, $unset: { activeContractKey: 1 } });
    const afterSend = await request(app).put(`/api/lot-listing/${listing._id}/preview`).set(auth())
      .send({ preview_data: { lots: [{ lot_id: "lot-002", lot_number: "2", title: "Late lot", image_indexes: [] }] } });
    expect(afterSend.status, JSON.stringify(afterSend.body)).toBe(200);
  });
});
