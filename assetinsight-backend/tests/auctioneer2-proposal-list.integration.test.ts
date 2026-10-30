import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
   Owner 2026-10-28: a Proposal's Schedule A list is pushed item by item to
   several Asset Insight users. Each user sees only their own items, returns
   each captured item against its listed item (green), returns an item they
   could not find as not found (red), may add items that were not listed
   (blue), and never creates an Auctioneer lot or closes the Proposal. A
   Proposal without a list keeps the older single-user flow.
*/

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));

const upstream = vi.hoisted(() => ({
  listIncomingContracts: vi.fn(),
  listIncomingTasks: vi.fn(),
  getContractLots: vi.fn(),
  getContractScheduleAItems: vi.fn(),
  returnProposalReviewItems: vi.fn(),
  submitLot: vi.fn(),
  getLot: vi.fn(),
  completeConditionReport: vi.fn(),
  closeContractPartForUser: vi.fn(),
  completeContractTask: vi.fn(),
}));
vi.mock("../src/service/auctioneer2Client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/auctioneer2Client.js")>(),
  ...upstream,
}));
vi.mock("../src/service/auctioneer2PhotoService.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/auctioneer2PhotoService.js")>(),
  trustedPhotoSource: vi.fn().mockReturnValue("r2"),
}));

let mongo: MongoMemoryServer;
let User: typeof import("../src/models/user.model.js")["default"];
let Work: typeof import("../src/models/auctioneerWorkItem.model.js")["default"];
let Asset: typeof import("../src/models/asset.model.js")["default"];
let integration: typeof import("../src/service/auctioneer2IntegrationService.js");
let delivery: typeof import("../src/service/auctioneer2DeliveryService.js");
let links: typeof import("../src/service/auctioneerReportLinkService.js");
let client: typeof import("../src/service/auctioneer2Client.js");
let ownerId: string;
let otherId: string;
const savedEnv = Object.fromEntries(["AUCTIONEER2_API_BASE_URL", "AUCTIONEER2_API_KEY", "AUCTIONEER2_FEATURE_ENABLED", "DEVICE_APPROVAL_ENFORCEMENT"].map((key) => [key, process.env[key]]));

const CONTRACT = "proposal-1";
const pushed = (userId: string, lineId: string, extra: Record<string, unknown> = {}) => ({
  lineId, title: `Item ${lineId}`, severalLots: false, parentLotId: null, lotCount: 0, sortOrder: 0,
  lotNumber: `L-${lineId}`, serialNumber: `SN-${lineId}`, assetInsightUserId: userId, sentToAssetInsight: true,
  returned: false, ...extra,
});
/** The list as Auctioneer holds it, filtered by ?userId= like Auctioneer does. */
let list: ReturnType<typeof pushed>[] = [];

function proposal(extra: Record<string, unknown> = {}) {
  // Pushed item by item: the contract itself names somebody else (or nobody).
  return { id: CONTRACT, contractNumber: "P-100", status: "ProposalInAssetInsight", assignedUserId: null,
    eventId: "event-1", hasScheduleA: true, customerName: "Proposal customer", ...extra };
}

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", process.env.RESEND_API_KEY || "re_proposal_list_test_only");
  process.env.AUCTIONEER2_API_BASE_URL = "https://auctioneer.example/api/external";
  process.env.AUCTIONEER2_API_KEY = "test-proposal-list";
  process.env.AUCTIONEER2_FEATURE_ENABLED = "true";
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: Work } = await import("../src/models/auctioneerWorkItem.model.js"));
  ({ default: Asset } = await import("../src/models/asset.model.js"));
  integration = await import("../src/service/auctioneer2IntegrationService.js");
  delivery = await import("../src/service/auctioneer2DeliveryService.js");
  links = await import("../src/service/auctioneerReportLinkService.js");
  client = await import("../src/service/auctioneer2Client.js");
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Work.createIndexes();
  integration.clearAuctioneer2IncomingCacheForTests();
  Object.values(upstream).forEach((mock) => mock.mockReset());
  const [owner, other] = await Promise.all(["owner", "other"].map(async (name) => User.create({
    email: `proposal-${name}@example.test`, username: `Proposal ${name}`,
    password: await bcrypt.hash("Password123!", 4), authProvider: "email", isVerified: true,
  })));
  ownerId = String(owner._id);
  otherId = String(other._id);
  list = [pushed(ownerId, "line-a"), pushed(ownerId, "line-b"), pushed(otherId, "line-c")];
  upstream.listIncomingContracts.mockResolvedValue([proposal()]);
  upstream.listIncomingTasks.mockResolvedValue([]);
  upstream.getContractScheduleAItems.mockImplementation(async (contractId: string, options: { userId?: string } = {}) => ({
    contractId, hasScheduleA: true,
    items: list.filter((item) => !options.userId || item.assetInsightUserId === options.userId),
  }));
  upstream.returnProposalReviewItems.mockImplementation(async (contractId: string, input: { items: unknown[] }) => ({
    contractId, reviewItemCount: input.items.length, remainsInAssetInsight: true,
  }));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.unstubAllEnvs();
});

async function claimFor(userId: string) {
  const [row] = (await integration.listAuctioneerIncoming(true, userId)).filter((item: any) => item.proposalList);
  expect(row).toBeTruthy();
  return integration.claimAuctioneerIncoming(row.cycleKey, userId, "asset");
}

async function linkedReport(workItemId: string, lots: any[]) {
  const report = await Asset.create({
    user: ownerId, grouping_mode: "mixed", imageUrls: ["https://assetinsight.test/p/1.jpg", "https://assetinsight.test/p/2.jpg"],
    lots, contract_no: "P-100", status: "approved", release_status: "released", job_status: "done",
    preview_data: { contract_no: "P-100", lots },
    preview_files: { docx: "https://files.example/r.docx", excel: "https://files.example/r.xlsx", images: "https://files.example/r.zip" },
  });
  await Work.updateOne({ _id: workItemId }, { $set: { status: "report_created", linkedReportModel: "AssetReport", linkedReportId: report._id } });
  await Asset.collection.updateOne({ _id: report._id }, { $set: { auctioneerWorkItem: new mongoose.Types.ObjectId(workItemId) } });
  return report;
}

describe.sequential("A Proposal worked item by item (owner 2026-10-28)", () => {
  it("offers the Proposal to each user with items, with only their own items, and lets both claim it", async () => {
    const rows = await integration.listAuctioneerIncoming(true, ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contractId: CONTRACT, kind: "unknown", lotCount: 2, status: "available",
      proposalList: true, assignedToCurrentUser: true, assignedUser: { id: ownerId } });
    expect(upstream.getContractScheduleAItems).toHaveBeenCalledWith(CONTRACT, { userId: ownerId });

    const mine = await claimFor(ownerId);
    const theirs = await claimFor(otherId);
    expect(mine.workItemId).not.toBe(theirs.workItemId);

    const setup: any = await integration.getAuctioneerWorkItemSetup(mine.workItemId, ownerId);
    expect(setup).toMatchObject({ kind: "unknown", lots: [], requiresScheduleAItem: false, scheduleAChoices: [] });
    expect(setup.proposalList.items).toEqual([
      expect.objectContaining({ lineId: "line-a", sourceKey: "proposal-line:line-a", lotNumber: "L-line-a", serialNumber: "SN-line-a", state: "outstanding" }),
      expect.objectContaining({ lineId: "line-b", sourceKey: "proposal-line:line-b", state: "outstanding" }),
    ]);
    // The open claim is what Incoming shows now; it is not offered twice.
    const after = await integration.listAuctioneerIncoming(true, ownerId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ workItemId: mine.workItemId, status: "claimed", lotCount: 2, proposalList: true });
  });

  it("keeps the older single-user Proposal unchanged and hides a list that is not this user's", async () => {
    list = [];
    upstream.listIncomingContracts.mockResolvedValue([proposal({ assignedUserId: ownerId })]);
    upstream.getContractLots.mockResolvedValue([]);
    const [older] = await integration.listAuctioneerIncoming(true, ownerId);
    expect(older).toMatchObject({ contractId: CONTRACT, status: "available" });
    expect(older).not.toHaveProperty("proposalList");
    const claimed = await integration.claimAuctioneerIncoming(older.cycleKey, ownerId, "asset");
    expect((await Work.findById(claimed.workItemId).lean())?.proposalList).toBeUndefined();

    await mongoose.connection.db!.dropDatabase();
    integration.clearAuctioneer2IncomingCacheForTests();
    list = [pushed(otherId, "line-c")];
    expect(await integration.listAuctioneerIncoming(true, ownerId)).toEqual([]);
  });

  it("refuses a Proposal assigned to someone else when Auctioneer says none of it is this user's", async () => {
    list = [pushed(otherId, "line-c")];
    upstream.listIncomingContracts.mockResolvedValue([proposal({ assignedUserId: otherId })]);
    await expect(integration.listAuctioneerIncoming(true, ownerId))
      .rejects.toMatchObject({ statusCode: 502, code: "auctioneer2_invalid_response" });
  });

  it("keeps a listed lot's key as one lot, makes everything else an extra, and refuses a key that is not the user's", async () => {
    const claimed = await claimFor(ownerId);
    const details: Record<string, any> = {
      auctioneer_work_item_id: claimed.workItemId,
      mixed_lots: [
        { count: 3, mode: "per_photo", source_key: "proposal-line:line-a" },
        { count: 1, mode: "per_item", source_key: "anything-else" },
        { count: 1, mode: "single_lot" },
      ],
    };
    await links.resolveAuctioneerReportContext({ details, userId: ownerId, reportType: "asset" });
    expect(details.mixed_lots).toEqual([
      { count: 3, mode: "single_lot", source_key: "proposal-line:line-a" },
      { count: 1, mode: "per_item", source_key: `${claimed.workItemId}:unknown:2` },
      { count: 1, mode: "single_lot", source_key: `${claimed.workItemId}:unknown:3` },
    ]);
    expect((await Work.findById(claimed.workItemId).lean())?.proposalCapturedLineIds).toEqual(["line-a"]);

    for (const lots of [
      [{ count: 1, mode: "single_lot", source_key: "proposal-line:line-c" }],
      [{ count: 1, mode: "single_lot", source_key: "proposal-line:line-a" }, { count: 1, mode: "single_lot", source_key: "proposal-line:line-a" }],
    ]) {
      await expect(links.resolveAuctioneerReportContext({
        details: { auctioneer_work_item_id: claimed.workItemId, mixed_lots: lots }, userId: ownerId, reportType: "asset",
      })).rejects.toMatchObject({ statusCode: 409, code: "AUCTIONEER_PROPOSAL_ITEM_INVALID" });
    }
  });

  it("returns an item the user could not find at once, as not found, and offers it no more", async () => {
    const claimed = await claimFor(ownerId);
    const result: any = await integration.markAuctioneerProposalItemsNotFound(claimed.workItemId, ownerId, { lineIds: ["line-b"] });
    expect(upstream.returnProposalReviewItems).toHaveBeenCalledTimes(1);
    const [contractId, input] = upstream.returnProposalReviewItems.mock.calls[0];
    expect(contractId).toBe(CONTRACT);
    expect(input).toMatchObject({ completedByUserId: ownerId, completedBy: "Proposal owner" });
    expect(input.items).toEqual([{ proposalItemRef: expect.stringMatching(/^ai-line-[0-9a-f]{40}$/), scheduleALineId: "line-b", notFound: true }]);
    expect(result).toMatchObject({ notFound: ["line-b"], remainsInAssetInsight: true });
    expect(result.setup.proposalList.items.find((item: any) => item.lineId === "line-b").state).toBe("not_found");

    // Repeating is harmless and asks Auctioneer nothing more.
    await integration.markAuctioneerProposalItemsNotFound(claimed.workItemId, ownerId, { lineIds: ["line-b"] });
    expect(upstream.returnProposalReviewItems).toHaveBeenCalledTimes(1);
    // Another user's item, and an item already back, are refused.
    await expect(integration.markAuctioneerProposalItemsNotFound(claimed.workItemId, ownerId, { lineIds: ["line-c"] }))
      .rejects.toMatchObject({ statusCode: 409, code: "AUCTIONEER_PROPOSAL_ITEM_INVALID" });
    list = list.map((item) => (item.lineId === "line-a" ? { ...item, returned: true } : item));
    integration.clearAuctioneer2IncomingCacheForTests();
    await expect(integration.markAuctioneerProposalItemsNotFound(claimed.workItemId, ownerId, { lineIds: ["line-a"] }))
      .rejects.toMatchObject({ statusCode: 409, code: "auctioneer_proposal_item_not_outstanding" });
    await expect(integration.markAuctioneerProposalItemsNotFound(claimed.workItemId, ownerId, { lineIds: [] }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns listed and unlisted lots in one review-items call, creating no lot and closing nothing", async () => {
    const claimed = await claimFor(ownerId);
    const lots = [
      { lot_id: "lot-001", title: "Tractor", description: "Runs", serial_number: "SN-A", year: "2019", auctioneer_source_key: "proposal-line:line-a", image_indexes: [0] },
      { lot_id: "lot-002", title: "Spare tire", auctioneer_source_key: `${claimed.workItemId}:unknown:2`, image_indexes: [1] },
    ];
    await linkedReport(claimed.workItemId, lots);
    await expect(integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard", completeContract: true }))
      .rejects.toMatchObject({ statusCode: 409, code: "auctioneer_proposal_list_no_close" });
    const queued = await integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard" });
    expect(queued).toMatchObject({ canCompleteContract: false, proposalList: true, proposalReturn: null });

    await delivery.runAuctioneerDeliveryJob(claimed.workItemId);
    expect(upstream.submitLot).not.toHaveBeenCalled();
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    expect(upstream.completeContractTask).not.toHaveBeenCalled();
    expect(upstream.returnProposalReviewItems).toHaveBeenCalledTimes(1);
    const [, input] = upstream.returnProposalReviewItems.mock.calls[0];
    expect(input.completedByUserId).toBe(ownerId);
    // Items that were not listed go first; the listed one completes the call.
    expect(input.items).toEqual([
      expect.objectContaining({ proposalItemRef: expect.stringMatching(/:2$/), description: "Spare tire", photos: ["https://assetinsight.test/p/2.jpg"] }),
      expect.objectContaining({ scheduleALineId: "line-a", description: "Tractor", serialNumber: "SN-A", year: "2019", photos: ["https://assetinsight.test/p/1.jpg"] }),
    ]);
    expect(input.items[0]).not.toHaveProperty("scheduleALineId");
    const sent = await Work.findById(claimed.workItemId).lean();
    expect(sent).toMatchObject({ status: "sent", delivery: { status: "sent", proposalReturn: { itemCount: 2, remainsInAssetInsight: true } } });
    expect(sent?.delivery.lots.every((lot) => lot.status === "sent")).toBe(true);

    // The user's remaining item is offered again as a new cycle.
    list = list.map((item) => (item.lineId === "line-a" ? { ...item, returned: true } : item));
    integration.clearAuctioneer2IncomingCacheForTests();
    const [again] = await integration.listAuctioneerIncoming(true, ownerId);
    expect(again).toMatchObject({ status: "available", lotCount: 1, proposalList: true });
    expect(again.cycleKey).not.toBe((await Work.findById(claimed.workItemId).lean())?.cycleKey);
  });

  it("counts a repeat after the completing call landed as sent, but not an unconfirmed one", async () => {
    const claimed = await claimFor(ownerId);
    const lots = [{ lot_id: "lot-001", title: "Tractor", auctioneer_source_key: "proposal-line:line-a", image_indexes: [0] }];
    await linkedReport(claimed.workItemId, lots);
    await integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard" });
    upstream.returnProposalReviewItems.mockRejectedValueOnce(new client.Auctioneer2ClientError("Auctioneer 2.0 did not respond before the timeout.",
      { statusCode: 504, code: "auctioneer2_timeout", ambiguousWrite: true }));
    await expect(delivery.runAuctioneerDeliveryJob(claimed.workItemId)).rejects.toThrow(/timeout/);
    expect((await Work.findById(claimed.workItemId).lean())?.delivery).toMatchObject({ status: "failed", lots: [{ step: "returning" }] });

    const completed = new client.Auctioneer2ClientError("CONTRACT_ALREADY_COMPLETED: The auction contract has already been completed.",
      { statusCode: 409, code: "CONTRACT_ALREADY_COMPLETED", upstreamStatus: 409 });
    upstream.returnProposalReviewItems.mockRejectedValue(completed);
    await integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard" });
    await expect(delivery.runAuctioneerDeliveryJob(claimed.workItemId)).rejects.toThrow(/already closed this Proposal/);

    list = list.map((item) => (item.lineId === "line-a" ? { ...item, returned: true } : item));
    await integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard" });
    await delivery.runAuctioneerDeliveryJob(claimed.workItemId);
    expect((await Work.findById(claimed.workItemId).lean())?.delivery).toMatchObject({
      status: "sent", proposalReturn: { remainsInAssetInsight: false },
    });
  });

  it("does not let a list user close the Proposal for everyone", async () => {
    await claimFor(ownerId);
    await expect(integration.closeAuctioneerContractPart(CONTRACT, ownerId))
      .rejects.toMatchObject({ statusCode: 409, code: "auctioneer_proposal_list_no_close" });
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
  });

  it("carries the list to a Create Lot & Continue successor, without the items its parent captured", async () => {
    const claimed = await claimFor(ownerId);
    await links.resolveAuctioneerReportContext({
      details: { auctioneer_work_item_id: claimed.workItemId, mixed_lots: [{ count: 1, mode: "single_lot", source_key: "proposal-line:line-a" }] },
      userId: ownerId, reportType: "asset",
    });
    const report = await linkedReport(claimed.workItemId, [{ lot_id: "lot-001", title: "Tractor", auctioneer_source_key: "proposal-line:line-a", image_indexes: [0] }]);
    await Asset.collection.updateOne({ _id: report._id }, { $set: { status: "preview", job_id: "job-1", job_status: "done", client_submission_id: (await Work.findById(claimed.workItemId).lean())?.clientSubmissionId } });
    const result: any = await integration.continueAuctioneerWorkItem(claimed.workItemId, ownerId, { reportId: String(report._id) });
    expect(result.created).toBe(true);
    const states = Object.fromEntries(result.setup.proposalList.items.map((item: any) => [item.lineId, item.state]));
    expect(states).toEqual({ "line-a": "in_other_report", "line-b": "outstanding" });
    expect((await Work.findById(result.setup.workItemId).lean())?.proposalList?.items).toHaveLength(2);
  });
});

/*
   Owner 2026-10-29: a US Proposal without a list came back with one lot of
   the 3 to 6 captured. Its lots went one by one through /lots/submit, which
   Auctioneer now holds for the Proposal's review with no lot (BUG-501); the
   missing lot read as an uncertain write and stopped the send after lot 1.
*/
describe.sequential("A Proposal without a list returns all its lots for review (owner 2026-10-29)", () => {
  const threeLots = [
    { lot_id: "lot-001", title: "Tractor", serial_number: "SN-1", year: "2019", image_indexes: [0] },
    { lot_id: "lot-002", title: "Baler", image_indexes: [1] },
    { lot_id: "lot-003", title: "Rake", image_indexes: [0, 1] },
  ];
  async function claimOlder() {
    list = [];
    upstream.listIncomingContracts.mockResolvedValue([proposal({ assignedUserId: ownerId, hasScheduleA: false })]);
    upstream.getContractLots.mockResolvedValue([]);
    const [row] = await integration.listAuctioneerIncoming(true, ownerId);
    expect(row).not.toHaveProperty("proposalList");
    return integration.claimAuctioneerIncoming(row.cycleKey, ownerId, "asset");
  }

  it("sends every lot in one review-items call with its photos, creates no lot and keeps the Proposal open", async () => {
    const claimed = await claimOlder();
    await linkedReport(claimed.workItemId, threeLots);
    const queued = await integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard" });
    expect(queued).toMatchObject({ canCompleteContract: true });
    await delivery.runAuctioneerDeliveryJob(claimed.workItemId);

    expect(upstream.submitLot).not.toHaveBeenCalled();
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    expect(upstream.returnProposalReviewItems).toHaveBeenCalledTimes(1);
    const [contractId, input] = upstream.returnProposalReviewItems.mock.calls[0];
    expect(contractId).toBe(CONTRACT);
    expect(input).toMatchObject({ completedByUserId: ownerId, moreLotsExpected: true });
    const work = await Work.findById(claimed.workItemId).lean();
    // The same references /lots/submit used, so a lot already held there is replaced.
    expect(input.items.map((item: any) => item.proposalItemRef)).toEqual([1, 2, 3].map((n) => `${work!.clientSubmissionId}:${n}`));
    expect(input.items).toEqual([
      expect.objectContaining({ description: "Tractor", serialNumber: "SN-1", year: "2019", photos: ["https://assetinsight.test/p/1.jpg"] }),
      expect.objectContaining({ description: "Baler", photos: ["https://assetinsight.test/p/2.jpg"] }),
      expect.objectContaining({ description: "Rake", photos: ["https://assetinsight.test/p/1.jpg", "https://assetinsight.test/p/2.jpg"] }),
    ]);
    expect(input.items.some((item: any) => "scheduleALineId" in item)).toBe(false);
    expect(work).toMatchObject({ status: "sent", delivery: { status: "sent", proposalReturn: { itemCount: 3 } } });
  });

  it("closes the Proposal with Close my part once its lots are back", async () => {
    const claimed = await claimOlder();
    await linkedReport(claimed.workItemId, threeLots);
    upstream.closeContractPartForUser.mockImplementation(async (id: string, body: { completedByUserId: string }) => ({
      contractId: id, userId: body.completedByUserId, userStatus: "completed", taskCompleted: true, alreadyCompleted: false }));
    await integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard", completeContract: true });
    await delivery.runAuctioneerDeliveryJob(claimed.workItemId);
    expect(upstream.returnProposalReviewItems).toHaveBeenCalledTimes(1);
    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(1);
    expect(upstream.returnProposalReviewItems.mock.invocationCallOrder[0])
      .toBeLessThan(upstream.closeContractPartForUser.mock.invocationCallOrder[0]);
    expect(await Work.findById(claimed.workItemId).lean()).toMatchObject({ delivery: { status: "sent", contractClose: { taskCompleted: true } } });
  });

  it("finishes a send that stopped after Auctioneer held its first lot, once it is released as no lot created", async () => {
    const claimed = await claimOlder();
    await linkedReport(claimed.workItemId, threeLots);
    await integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard" });
    // What the deployed sender left behind: lot 1 held, the send parked for reconciliation.
    const reason = "Auctioneer accepted the Unknown Lot request without returning a lot ID. Reconcile it before retrying.";
    const work = await Work.findById(claimed.workItemId);
    const checkpoints = threeLots.map((lot, index) => ({ sourceKey: `${claimed.workItemId}:unknown:${index + 1}`, status: index === 0 ? "needs_reconciliation" : "pending", step: index === 0 ? "submitting" : undefined }));
    await Work.updateOne({ _id: work!._id }, { $set: { "delivery.status": "needs_reconciliation", "delivery.lots": checkpoints,
      "delivery.reconciliation": { required: true, sourceKey: checkpoints[0].sourceKey, reason, requestedAt: new Date() } } });

    await integration.reconcileAuctioneerDelivery(claimed.workItemId, ownerId, { sourceKey: checkpoints[0].sourceKey, confirmNotCreated: true });
    await integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard" });
    await delivery.runAuctioneerDeliveryJob(claimed.workItemId);
    expect(upstream.submitLot).not.toHaveBeenCalled();
    const [, input] = upstream.returnProposalReviewItems.mock.calls[0];
    expect(input.items).toHaveLength(3);
    expect(input.items[0].proposalItemRef).toBe(`${work!.clientSubmissionId}:1`);
    expect(await Work.findById(claimed.workItemId).lean()).toMatchObject({ delivery: { status: "sent" } });
  });

  it("switches to review-items if Auctioneer holds a lot it was not told was a Proposal's", async () => {
    const claimed = await claimOlder();
    await linkedReport(claimed.workItemId, threeLots);
    // A capture whose saved contract does not say Proposal (should not happen; the net for it).
    // The snapshot is immutable to the model, so the test edits the stored document directly.
    await Work.collection.updateOne({ _id: new mongoose.Types.ObjectId(claimed.workItemId) }, { $unset: { "snapshot.contract.status": "" } });
    upstream.submitLot.mockResolvedValue({ success: true, submissionId: "held-1", lotId: null, status: "ProposalReview", proposalReview: true });
    await integration.queueAuctioneerDelivery(claimed.workItemId, ownerId, { destination: "LottingBoard" });
    await delivery.runAuctioneerDeliveryJob(claimed.workItemId);
    expect(upstream.submitLot).toHaveBeenCalledTimes(1);
    const [, input] = upstream.returnProposalReviewItems.mock.calls[0];
    expect(input.items).toHaveLength(3);
    expect(await Work.findById(claimed.workItemId).lean()).toMatchObject({ delivery: { status: "sent", reconciliation: { required: false } } });
  });
});
