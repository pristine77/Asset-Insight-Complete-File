import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => {
  const config = () => ({ parsed: {} });
  return { default: { config }, config };
});
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
const upstream = vi.hoisted(() => ({ contracts: vi.fn(), tasks: vi.fn(), scheduleAItems: vi.fn() }));
vi.mock("../src/service/auctioneer2Client.js", async (original) => ({
  ...await original<typeof import("../src/service/auctioneer2Client.js")>(),
  listIncomingContracts: upstream.contracts,
  listIncomingTasks: upstream.tasks,
  getContractScheduleAItems: upstream.scheduleAItems,
}));

let mongo: MongoMemoryServer;
let app: typeof import("../src/app.js")["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let WorkItem: typeof import("../src/models/auctioneerWorkItem.model.js")["default"];
let Asset: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let integration: typeof import("../src/service/auctioneer2IntegrationService.js");
let ownerId: string;
let token: string;

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_continuation_test_only");
  vi.stubEnv("AUCTIONEER2_FEATURE_ENABLED", "true");
  vi.stubEnv("AUCTIONEER2_API_KEY", "test-only");
  vi.stubEnv("AUCTIONEER2_API_BASE_URL", "https://auctioneer.example/api/external");
  vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: WorkItem } = await import("../src/models/auctioneerWorkItem.model.js"));
  ({ default: Asset } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  integration = await import("../src/service/auctioneer2IntegrationService.js");
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await WorkItem.createIndexes();
  vi.clearAllMocks();
  integration.clearAuctioneer2IncomingCacheForTests();
  const user = await User.create({
    username: "Continuation owner", email: "continuation@example.test",
    password: await bcrypt.hash("Test-only-password", 4), authProvider: "email", isVerified: true,
  });
  ownerId = String(user._id);
  token = `Bearer ${jwt.sign({ id: ownerId, role: "user" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}`;
  upstream.contracts.mockResolvedValue([{
    id: "contract-1", contractNumber: "93530", assignedUserId: ownerId,
    status: "ProposalInAssetInsight", customerName: "Current provider customer",
  }]);
  upstream.tasks.mockResolvedValue([]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  vi.unstubAllEnvs();
});

async function seed(reportType: "asset" | "lotListing" = "asset") {
  const reportId = new mongoose.Types.ObjectId();
  const work = await WorkItem.create({
    cycleKey: `original-${reportId}`, activeContractKey: `claim-${reportId}`,
    assignmentUserId: ownerId, claimedBy: ownerId, claimedAt: new Date(),
    selectedReportType: reportType, clientSubmissionId: `submission-${reportId}`,
    kind: "scheduleA", status: "report_created", linkedReportId: reportId,
    linkedReportModel: reportType === "asset" ? "AssetReport" : "LotListing",
    contract: { id: "contract-1", contractNo: "93530", customerName: "Imported customer", description: "Imported equipment description", eventId: "event-1", eventTitle: "Sale", eventDate: "2026-09-20", location: "Regina", categories: "Vehicles" },
    snapshot: { contract: { id: "contract-1" }, event: { id: "event-1" }, customer: { name: "Imported customer" }, tasks: [{ lotId: "old-lot" }], lots: [{ sourceKey: "old-source", lotId: "old-lot", submissionId: "old-submission", description: "Do not copy", sourcePhotos: [{ url: "https://assetinsight.test/old.jpg" }] }], capturedAt: new Date() },
    delivery: { status: "not_ready", completeContract: false, attempts: 0, lots: [{ sourceKey: "old-source", sourceLotId: "old-lot", status: "pending" }] },
  });
  const report = { _id: reportId, user: new mongoose.Types.ObjectId(ownerId), auctioneerWorkItem: work._id, client_submission_id: work.clientSubmissionId, contract_no: "93530", status: "processing", job_status: "queued", job_id: `job-${reportId}`, imageUrls: ["https://assetinsight.test/keep.jpg"], lots: [{ lot_number: "12", description: "Keep old report" }] };
  const model = reportType === "asset" ? Asset : LotListing;
  await model.collection.insertOne(report);
  return { work, report, model };
}

function continueRequest(workId: unknown, reportId: unknown) {
  return request(app).post(`/api/auctioneer/work-items/${String(workId)}/continue`).set("Authorization", token).send({ reportId: String(reportId) });
}

describe.sequential("Auctioneer report continuation", () => {
  it.each((["asset", "lotListing"] as const).flatMap((type) => ["projection", "legacy-snapshot"].map((source) => ({ type, source }))))
    ("retains imported contact names for $type from $source without replacing them with live names", async ({ type, source }) => {
      const { work, report } = await seed(type);
      const names = { consignorName: "Imported Consignor", salespersonName: "Imported Salesperson" };
      await WorkItem.collection.updateOne({ _id: work._id }, { $set: source === "projection"
        ? { "contract.consignorName": names.consignorName, "contract.salespersonName": names.salespersonName }
        : { "snapshot.contract": { id: "contract-1", ...names } } });
      const before = await WorkItem.findById(work._id).lean();
      upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId,
        consignorName: "New live consignor", salespersonName: "New live salesperson", description: "Changed live description" }]);
      const first = await continueRequest(work._id, report._id);
      expect(first.status).toBe(201);
      expect(first.body.data.contract).toMatchObject(names);
      expect(first.body.data.contract.description).toBe("Imported equipment description");
      const successor = await WorkItem.findById(first.body.data.workItemId).lean();
      expect(successor?.contract).toMatchObject(names);
      expect(successor?.snapshot.contract).toMatchObject(names);
      expect(successor?.snapshot.contract?.description).toBe("Imported equipment description");
      expect(first.body.data.lots).toEqual([]);
      const retry = await continueRequest(work._id, report._id);
      expect(retry.status).toBe(200); expect(retry.body.data).toEqual(first.body.data);
      expect(await WorkItem.findById(work._id).lean()).toEqual(before);
    });

  it.each(["asset", "lotListing"] as const)("continues assigned Operations %s work absent from the Proposal feed", async (type) => {
    const { work, report, model } = await seed(type);
    upstream.contracts.mockResolvedValue([]);
    upstream.tasks.mockResolvedValue([{ id: "task-1", assignedTo: ownerId,
      lot: { id: "lot-1", contractId: "contract-1", eventId: "event-1" } }]);
    const before = await model.collection.findOne({ _id: report._id });
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(201);
    expect(response.body.data.contract).toMatchObject({ contractNo: "93530", location: "Regina" });
    expect(response.body.data.lots).toEqual([]);
    expect(upstream.tasks).toHaveBeenCalledWith(ownerId, "contract-1");
    expect(await model.collection.findOne({ _id: report._id })).toEqual(before);
  });

  it.each(["foreign", "missing-owner", "wrong-contract", "changed-event"])("refuses invalid Operations authority: %s", async (scenario) => {
    const { work, report } = await seed();
    upstream.contracts.mockResolvedValue([]);
    upstream.tasks.mockResolvedValue([{ assignedTo: scenario === "foreign" ? new mongoose.Types.ObjectId().toString() : scenario === "missing-owner" ? undefined : ownerId,
      lot: { contractId: scenario === "wrong-contract" ? "another-contract" : "contract-1", eventId: scenario === "changed-event" ? "event-2" : "event-1" } }]);
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(scenario === "foreign" ? 502 : 409);
    expect(response.body.code).toBe(scenario === "foreign" ? "auctioneer2_invalid_response"
      : scenario === "changed-event" ? "auctioneer_continuation_event_changed"
      : "auctioneer_continuation_assignment_unavailable");
    expect(await WorkItem.countDocuments()).toBe(1);
  });
  it.each((["asset", "lotListing"] as const).flatMap((type) => [
    "claim-owner", "assignment", "work-report-link", "work-submission", "work-closed", "report-owner",
    "report-work-link", "report-submission", "report-archived", "user-blocked", "user-unverified", "user-role",
  ].map((change) => ({ type, change }))))("rechecks local $change after provider lookup before creating a $type successor", async ({ type, change }) => {
    const { work, report, model } = await seed(type);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    upstream.contracts.mockImplementationOnce(async () => {
      await gate;
      return [{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId, eventId: "event-1" }];
    });
    const continuation = continueRequest(work._id, report._id).then((response) => response);
    await vi.waitFor(() => expect(upstream.contracts).toHaveBeenCalledTimes(1));
    const otherId = new mongoose.Types.ObjectId();
    if (change === "claim-owner") await WorkItem.collection.updateOne({ _id: work._id }, { $set: { claimedBy: otherId } });
    if (change === "assignment") await WorkItem.collection.updateOne({ _id: work._id }, { $set: { assignmentUserId: otherId } });
    if (change === "work-report-link") await WorkItem.collection.updateOne({ _id: work._id }, { $set: { linkedReportId: otherId } });
    if (change === "work-submission") await WorkItem.collection.updateOne({ _id: work._id }, { $set: { clientSubmissionId: "new-submission" } });
    if (change === "work-closed") await WorkItem.collection.updateOne({ _id: work._id }, { $set: { status: "abandoned" } });
    if (change === "report-owner") await model.collection.updateOne({ _id: report._id }, { $set: { user: otherId } });
    if (change === "report-work-link") await model.collection.updateOne({ _id: report._id }, { $set: { auctioneerWorkItem: otherId } });
    if (change === "report-submission") await model.collection.updateOne({ _id: report._id }, { $set: { client_submission_id: "new-submission" } });
    if (change === "report-archived") await model.collection.updateOne({ _id: report._id }, { $set: { adminArchivedAt: new Date() } });
    if (change === "user-blocked") await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(ownerId) }, { $set: { isBlocked: true } });
    if (change === "user-unverified") await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(ownerId) }, { $set: { isVerified: false } });
    if (change === "user-role") await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(ownerId) }, { $set: { role: "admin" } });
    const parentBefore = await WorkItem.findById(work._id).lean(); const reportBefore = await model.collection.findOne({ _id: report._id });
    release();
    const response = await continuation;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe(change.startsWith("user-") ? "auctioneer_assignee_unavailable" : "auctioneer_continuation_not_ready");
    expect(await WorkItem.countDocuments()).toBe(1);
    expect(await WorkItem.findById(work._id).lean()).toEqual(parentBefore);
    expect(await model.collection.findOne({ _id: report._id })).toEqual(reportBefore);
  });

  it.each(["asset", "lotListing"] as const)("permits ordinary %s processing updates while checking current assignment", async (type) => {
    const { work, report, model } = await seed(type);
    upstream.contracts.mockImplementationOnce(async () => {
      await model.collection.updateOne({ _id: report._id }, { $set: { updatedAt: new Date(), job_status: "processing", processing_started_at: new Date() } });
      await WorkItem.collection.updateOne({ _id: work._id }, { $set: { updatedAt: new Date() } });
      return [{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId, eventId: "event-1" }];
    });
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(201);
    expect((await model.collection.findOne({ _id: report._id }))?.job_status).toBe("processing");
  });

  it.each(["asset", "lotListing"] as const)("accepts valid authority behind invalid earlier aliases for %s continuation", async (type) => {
    const { work, report } = await seed(type);
    upstream.contracts.mockResolvedValue([{ id: "contract-1", status: " ", contractStatus: "ProposalInAssetInsight", assignedTo: {}, assignedUserId: ownerId, eventId: "event-1" }]);
    expect((await continueRequest(work._id, report._id)).status).toBe(201);
  });

  it.each(["owner", "status"])("rejects contradictory current contract %s aliases without creating a successor", async (field) => {
    const { work, report } = await seed();
    upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId,
      ...(field === "owner" ? { assignedTo: new mongoose.Types.ObjectId().toString() } : { contractStatus: "Completed" }),
    }]);
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(502); expect(response.body.code).toBe("auctioneer2_invalid_response");
    expect(await WorkItem.countDocuments()).toBe(1);
  });

  it.each(["restored", "removed"])("checks current assignment independently of an older in-flight Incoming read when assignment is %s", async (change) => {
    const { work, report } = await seed();
    const contract = { id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId, eventId: "event-1" };
    let finishOlderRead!: (rows: unknown[]) => void;
    const olderRead = new Promise<unknown[]>((resolve) => { finishOlderRead = resolve; });
    upstream.contracts.mockReturnValueOnce(olderRead).mockResolvedValue(change === "restored" ? [contract] : []);
    const incoming = integration.listAuctioneerIncoming(true, ownerId);
    await vi.waitFor(() => expect(upstream.contracts).toHaveBeenCalledTimes(1));
    const continuation = continueRequest(work._id, report._id).then((response) => response);
    try {
      await vi.waitFor(() => expect(upstream.contracts).toHaveBeenCalledTimes(2));
      const response = await continuation;
      expect(response.status).toBe(change === "restored" ? 201 : 409);
      if (change === "removed") expect(response.body.code).toBe("auctioneer_continuation_assignment_unavailable");
      expect(await WorkItem.countDocuments()).toBe(change === "restored" ? 2 : 1);
    } finally {
      finishOlderRead(change === "restored" ? [] : [contract]);
      await incoming; await continuation;
    }
  });

  it.each((["asset", "lotListing"] as const).flatMap((type) => [
    { type, source: "standalone event", field: "snapshot.event", value: { id: "event-saved" } },
    { type, source: "contract", field: "snapshot.contract", value: { id: "contract-1", event_id: "event-saved" } },
    { type, source: "task", field: "snapshot.tasks", value: [{ id: "task-1", lot: { contractId: "contract-1", eventId: "event-saved" } }] },
    { type, source: "lot detail", field: "snapshot.lots.0.raw", value: { id: "lot-1", contract: { id: "contract-1", event: { id: "event-saved" } } } },
  ]))("rejects fresh event changes against saved $source evidence for a missing-canonical $type parent", async ({ type, field, value }) => {
    const { work, report, model } = await seed(type);
    await WorkItem.collection.updateOne({ _id: work._id }, { $unset: { "contract.eventId": 1 }, $set: { "snapshot.event": {}, [field]: value } });
    const parentBefore = await WorkItem.findById(work._id).lean(); const reportBefore = await model.collection.findOne({ _id: report._id });
    upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId, eventId: "event-changed" }]);
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(409); expect(response.body.code).toBe("auctioneer_continuation_event_changed");
    expect(await WorkItem.countDocuments()).toBe(1);
    expect(await WorkItem.findById(work._id).lean()).toEqual(parentBefore);
    expect(await model.collection.findOne({ _id: report._id })).toEqual(reportBefore);
  });

  it.each((["asset", "lotListing"] as const).flatMap((type) => [false, true].map((liveEvent) => ({ type, liveEvent }))))("inherits consistent saved evidence for a missing-canonical $type parent (live event: $liveEvent)", async ({ type, liveEvent }) => {
    const { work, report, model } = await seed(type);
    await WorkItem.collection.updateOne({ _id: work._id }, { $unset: { "contract.eventId": 1 }, $set: {
      "snapshot.contract.event_id": "event-1", "snapshot.tasks": [{ id: "task-1", eventId: " event-1 " }],
      "snapshot.lots.0.raw": { id: "lot-1", contract: { id: "contract-1" }, event: { id: "event-1" } },
    } });
    const parentBefore = await WorkItem.findById(work._id).lean(); const reportBefore = await model.collection.findOne({ _id: report._id });
    upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId, ...(liveEvent ? { eventId: "event-1" } : {}) }]);
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(201); expect(response.body.data.contract.eventId).toBe("event-1");
    expect(await WorkItem.findById(work._id).lean()).toEqual(parentBefore);
    expect(await model.collection.findOne({ _id: report._id })).toEqual(reportBefore);
    const childBefore = await WorkItem.findById(response.body.data.workItemId).lean();
    upstream.contracts.mockRejectedValue(new Error("Existing child must remain frozen"));
    const retry = await continueRequest(work._id, report._id);
    expect(retry.status).toBe(200); expect(retry.body.data).toEqual(response.body.data);
    expect(await WorkItem.findById(response.body.data.workItemId).lean()).toEqual(childBefore);
    expect(upstream.contracts).toHaveBeenCalledTimes(1);
  });

  it("rejects contradictory saved evidence when the canonical parent event is missing", async () => {
    const { work, report } = await seed();
    await WorkItem.collection.updateOne({ _id: work._id }, { $unset: { "contract.eventId": 1 }, $set: { "snapshot.tasks": [{ lot: { eventId: "other-event" } }] } });
    const before = await WorkItem.findById(work._id).lean();
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(409); expect(response.body.code).toBe("auctioneer_event_identity_conflict");
    expect(await WorkItem.countDocuments()).toBe(1); expect(await WorkItem.findById(work._id).lean()).toEqual(before);
  });

  it.each(["snapshot.contract", "snapshot.tasks.0.lot", "snapshot.lots.0.raw", "snapshot.event"])("rejects foreign contract evidence in %s before filling a new successor", async (field) => {
    const { work, report } = await seed();
    await WorkItem.collection.updateOne({ _id: work._id }, { $unset: { "contract.eventId": 1 }, $set: { [field]: { contractId: "foreign-contract", eventId: "event-1" } } });
    const before = await WorkItem.findById(work._id).lean();
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(409); expect(response.body.code).toBe("auctioneer_event_context_changed");
    expect(await WorkItem.countDocuments()).toBe(1); expect(await WorkItem.findById(work._id).lean()).toEqual(before);
  });

  it("preserves an already-canonical parent event without reopening conflicting legacy snapshot evidence", async () => {
    const { work, report } = await seed();
    await WorkItem.collection.updateOne({ _id: work._id }, { $set: { "snapshot.event.id": "legacy-other-event", "snapshot.tasks": [{ contractId: "legacy-other-contract" }] } });
    const before = await WorkItem.findById(work._id).lean();
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(201); expect(response.body.data.contract.eventId).toBe("event-1");
    expect(await WorkItem.findById(work._id).lean()).toEqual(before);
  });

  it("rejects a freshly assigned contract carrying a nested foreign contract event", async () => {
    const { work, report } = await seed();
    await WorkItem.collection.updateOne({ _id: work._id }, { $unset: { "contract.eventId": 1, "snapshot.event.id": 1 } });
    const before = await WorkItem.findById(work._id).lean();
    upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId, contract: { id: "foreign-contract", eventId: "event-1" } }]);
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(409); expect(response.body.code).toBe("auctioneer_event_context_changed");
    expect(await WorkItem.countDocuments()).toBe(1); expect(await WorkItem.findById(work._id).lean()).toEqual(before);
  });

  it.each(["asset", "lotListing"] as const)("fills only a missing event on a new %s successor from the freshly assigned contract", async (type) => {
    const { work, report, model } = await seed(type);
    await WorkItem.collection.updateOne({ _id: work._id }, { $unset: { "contract.eventId": 1, "snapshot.event.id": 1 } });
    const parentBefore = await WorkItem.findById(work._id).lean(); const reportBefore = await model.collection.findOne({ _id: report._id });
    upstream.contracts.mockResolvedValue([{ id: "contract-1", contractNumber: "93530", status: "ProposalInAssetInsight", assignedUserId: ownerId, eventId: " ", event: { id: "event-recovered" }, eventTitle: "Changed title must not overwrite parent" }]);
    const first = await continueRequest(work._id, report._id);
    expect(first.status).toBe(201);
    expect(first.body.data.contract).toMatchObject({ eventId: "event-recovered", eventTitle: "Sale", customerName: "Imported customer" });
    expect(await WorkItem.findById(work._id).lean()).toEqual(parentBefore);
    expect(await model.collection.findOne({ _id: report._id })).toEqual(reportBefore);
    const childBefore = await WorkItem.findById(first.body.data.workItemId).lean();
    upstream.contracts.mockRejectedValue(new Error("Retry must not refresh the immutable child"));
    const retry = await continueRequest(work._id, report._id);
    expect(retry.status).toBe(200); expect(retry.body.data).toEqual(first.body.data);
    expect(await WorkItem.findById(first.body.data.workItemId).lean()).toEqual(childBefore);
    expect(upstream.contracts).toHaveBeenCalledTimes(1);
  });

  it("retains an existing missing-event child unchanged after the provider is corrected", async () => {
    const { work, report } = await seed();
    await WorkItem.collection.updateOne({ _id: work._id }, { $unset: { "contract.eventId": 1, "snapshot.event.id": 1 } });
    const first = await continueRequest(work._id, report._id);
    expect(first.status).toBe(201); expect(first.body.data.contract.eventId).toBeUndefined();
    upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId, eventId: "event-new" }]);
    const second = await continueRequest(work._id, report._id);
    expect(second.status).toBe(200); expect(second.body.data).toEqual(first.body.data); expect(upstream.contracts).toHaveBeenCalledTimes(1);
  });

  it("rejects contradictory live event aliases without changing the parent or creating a child", async () => {
    const { work, report } = await seed(); const before = await WorkItem.findById(work._id).lean();
    upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId, eventId: "event-1", event: { id: "event-2" } }]);
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(409); expect(response.body.code).toBe("auctioneer_event_identity_conflict");
    expect(await WorkItem.countDocuments()).toBe(1); expect(await WorkItem.findById(work._id).lean()).toEqual(before);
  });

  it.each(["asset", "lotListing"] as const)("creates a clean %s successor without touching the accepted report", async (type) => {
    const { work, report, model } = await seed(type);
    const before = await model.collection.findOne({ _id: report._id });
    const originalWork = await WorkItem.findById(work._id).lean();
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(201);
    const setup = response.body.data;
    expect(setup).toMatchObject({ reportType: type, kind: "unknown", lots: [], status: "claimed", reportId: null, continuationOfWorkItemId: String(work._id), contract: work.contract.toObject() });
    expect(setup.workItemId).not.toBe(String(work._id));
    expect(setup.clientSubmissionId).not.toBe(work.clientSubmissionId);
    expect(await model.collection.findOne({ _id: report._id })).toEqual(before);
    expect(await WorkItem.findById(work._id).lean()).toEqual(originalWork);
    expect(await model.countDocuments()).toBe(1);
    expect(await mongoose.connection.collection("reportjobs").countDocuments()).toBe(0);
    const successor = await WorkItem.findById(setup.workItemId).lean();
    expect(successor?.snapshot.tasks).toEqual([]);
    expect(successor?.snapshot.lots).toEqual([]);
    expect(successor?.delivery.lots).toEqual([]);
    expect(successor?.delivery.completeContract).toBe(false);
  });

  it("coalesces repeated and concurrent continuation requests", async () => {
    const { work, report } = await seed();
    const responses = await Promise.all(Array.from({ length: 6 }, () => continueRequest(work._id, report._id)));
    responses.forEach((response) => expect([200, 201]).toContain(response.status));
    expect(new Set(responses.map((response) => response.body.data.workItemId)).size).toBe(1);
    expect(await WorkItem.countDocuments()).toBe(2);
  });

  it.each([
    {}, { reportId: "bad" }, { reportId: 12 },
    { reportId: new mongoose.Types.ObjectId().toString(), reportType: "lotListing" },
    { reportId: new mongoose.Types.ObjectId().toString(), contractNo: "other" },
  ])("rejects malformed or client-controlled continuation fields: %j", async (body) => {
    const { work } = await seed();
    const response = await request(app).post(`/api/auctioneer/work-items/${work._id}/continue`).set("Authorization", token).send(body);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("invalid_continuation_request");
    expect(await WorkItem.countDocuments()).toBe(1);
    expect(upstream.contracts).not.toHaveBeenCalled();
  });

  it.each([
    { job_status: "uploading" }, { job_id: null }, { adminArchivedAt: new Date() },
    { auctioneerWorkItem: new mongoose.Types.ObjectId() },
    { user: new mongoose.Types.ObjectId() }, { client_submission_id: "different" },
    { status: "draft" },
    { status: "error", job_status: "error" },
  ])("does not clear an unaccepted or unrelated capture: %j", async (changes) => {
    const { work, report, model } = await seed();
    await model.collection.updateOne({ _id: report._id }, { $set: changes });
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("auctioneer_continuation_not_ready");
    expect(await WorkItem.countDocuments()).toBe(1);
    expect(upstream.contracts).not.toHaveBeenCalled();
  });

  it("requires authentication and ownership, including for exact retries", async () => {
    const { work, report } = await seed();
    expect((await request(app).post(`/api/auctioneer/work-items/${work._id}/continue`).send({ reportId: String(report._id) })).status).toBe(401);
    await WorkItem.collection.updateOne({ _id: work._id }, { $set: { claimedBy: new mongoose.Types.ObjectId() } });
    expect((await continueRequest(work._id, report._id)).status).toBe(404);
    expect(await WorkItem.countDocuments()).toBe(1);
  });

  it.each(["asset", "lotListing"] as const)("allows failed %s analysis only with an exact accepted job receipt", async (type) => {
    const { work, report, model } = await seed(type);
    await model.collection.updateOne({ _id: report._id }, { $set: { status: "error", job_status: "error" } });
    const { default: ReportJob } = await import("../src/models/reportJob.model.js");
    const job = await ReportJob.create({ type: type === "asset" ? "asset-preview" : "lot-listing-preview", reportId: String(report._id), progressId: "unrelated-run", status: "failed", payload: {} });
    expect((await continueRequest(work._id, report._id)).status).toBe(409);
    await ReportJob.updateOne({ _id: job._id }, { $set: { progressId: report.job_id } });
    expect((await continueRequest(work._id, report._id)).status).toBe(201);
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it("accepts an exact durable outbox without dispatching it or altering the errored report", async () => {
    const { work, report, model } = await seed();
    const outbox = { token: "test-intent", idempotencyKey: "test-accepted", type: "asset-preview", reportId: String(report._id), progressId: "unrelated-run", payload: {} };
    await model.collection.updateOne({ _id: report._id }, { $set: { status: "error", job_status: "error", report_job_outbox: outbox } });
    expect((await continueRequest(work._id, report._id)).status).toBe(409);
    await model.collection.updateOne({ _id: report._id }, { $set: { "report_job_outbox.progressId": report.job_id } });
    const before = await model.collection.findOne({ _id: report._id });
    expect((await continueRequest(work._id, report._id)).status).toBe(201);
    expect(await model.collection.findOne({ _id: report._id })).toEqual(before);
    expect(await mongoose.connection.collection("reportjobs").countDocuments()).toBe(0);
  });

  it("rejects a different report and a contract without a current assigned task", async () => {
    const { work, report } = await seed();
    expect((await continueRequest(work._id, new mongoose.Types.ObjectId())).status).toBe(409);
    upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "InProgress", assignedUserId: ownerId }]);
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("auctioneer_continuation_assignment_unavailable");
    expect(upstream.tasks).toHaveBeenCalledWith(ownerId, "contract-1");
    expect(await WorkItem.countDocuments()).toBe(1);
  });

  it.each(["removed", "reassigned", "event-changed", "provider-down"])("leaves the accepted report intact if assignment is %s", async (failure) => {
    const { work, report, model } = await seed();
    const before = await model.collection.findOne({ _id: report._id });
    if (failure === "removed") upstream.contracts.mockResolvedValue([]);
    if (failure === "reassigned") upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: new mongoose.Types.ObjectId().toString() }]);
    if (failure === "event-changed") upstream.contracts.mockResolvedValue([{ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: ownerId, eventId: "other-event" }]);
    if (failure === "provider-down") upstream.contracts.mockRejectedValue(new Error("Provider unavailable"));
    const response = await continueRequest(work._id, report._id);
    expect([409, 502, 500]).toContain(response.status);
    expect(await WorkItem.countDocuments()).toBe(1);
    expect(await model.collection.findOne({ _id: report._id })).toEqual(before);
  });

  it("recovers the same already-used successor without granting another form or calling the provider", async () => {
    const { work, report, model } = await seed();
    const first = await continueRequest(work._id, report._id);
    const childReportId = new mongoose.Types.ObjectId();
    await WorkItem.updateOne({ _id: first.body.data.workItemId }, { $set: { status: "report_created", linkedReportId: childReportId, linkedReportModel: "AssetReport" } });
    await model.collection.insertOne({ ...report, _id: childReportId, auctioneerWorkItem: new mongoose.Types.ObjectId(first.body.data.workItemId), client_submission_id: first.body.data.clientSubmissionId });
    upstream.contracts.mockRejectedValue(new Error("Provider unavailable"));
    await model.collection.updateOne({ _id: report._id }, { $set: { status: "error", job_status: "error" } });
    const replay = await continueRequest(work._id, report._id);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ workItemId: first.body.data.workItemId, status: "report_created", reportId: String(childReportId) });
    expect(upstream.contracts).toHaveBeenCalledTimes(1);
    expect(await WorkItem.countDocuments()).toBe(2);
  });

  it.each(["asset", "lotListing"] as const)("chains independent %s reports without carrying Schedule A IDs", async (type) => {
    const { work, report, model } = await seed(type);
    const first = (await continueRequest(work._id, report._id)).body.data;
    const { resolveAuctioneerReportContext } = await import("../src/service/auctioneerReportLinkService.js");
    const details = { auctioneer_work_item_id: first.workItemId, mixed_lots: [{ mode: "single_lot", lot_number: "13", source_key: "old-source", source_lot_id: "old-lot", source_submission_id: "old-submission" }] };
    await resolveAuctioneerReportContext({ details, userId: ownerId, reportType: type });
    expect(details.mixed_lots[0]).toEqual({ mode: "single_lot", lot_number: "13", source_key: `${first.workItemId}:unknown:1` });
    const childReportId = new mongoose.Types.ObjectId();
    await model.collection.insertOne({ ...report, _id: childReportId, auctioneerWorkItem: new mongoose.Types.ObjectId(first.workItemId), client_submission_id: first.clientSubmissionId });
    await WorkItem.updateOne({ _id: first.workItemId }, { $set: { status: "report_created", linkedReportId: childReportId, linkedReportModel: work.linkedReportModel } });
    const next = await continueRequest(first.workItemId, childReportId);
    expect(next.status).toBe(201);
    expect(next.body.data.contract).toEqual(first.contract);
    expect(next.body.data.lots).toEqual([]);
    expect(new Set([work.clientSubmissionId, first.clientSubmissionId, next.body.data.clientSubmissionId]).size).toBe(3);
    expect(await model.countDocuments()).toBe(2);
  });

  it.each(["asset", "lotListing"] as const)("keeps a Schedule A contract's Several lots items on the %s successor and requires one per lot", async (type) => {
    // Owner 2026-10-28: "Create Lot & Continue" on a Schedule A contract must
    // not produce orphan lots; the successor offers the items ticked Several lots.
    const { work, report } = await seed(type);
    await WorkItem.collection.updateOne({ _id: work._id }, { $set: { "contract.hasScheduleA": true } });
    upstream.scheduleAItems.mockResolvedValue({ contractId: "contract-1", hasScheduleA: true, items: [
      { lineId: "line-ford", title: "2021 Ford F150", severalLots: false, parentLotId: "old-lot", lotCount: 1, sortOrder: 1 },
      { lineId: "line-tools", title: "Misc Shop Tools", severalLots: true, parentLotId: "tools-lot", lotCount: 1, sortOrder: 2 },
    ] });
    const response = await continueRequest(work._id, report._id);
    expect(response.status).toBe(201);
    const tools = { lineId: "line-tools", title: "Misc Shop Tools", parentLotId: "tools-lot" };
    expect(response.body.data).toMatchObject({ kind: "unknown", requiresScheduleAItem: true, scheduleAChoices: [tools], lots: [] });
    expect((await WorkItem.findById(response.body.data.workItemId).lean())?.scheduleAChoices).toEqual([tools]);
    // One unfiltered read serves both the Proposal-list check and the Several
    // lots items; the per-user read (owner 2026-10-28) finds no list here.
    expect(upstream.scheduleAItems.mock.calls.filter(([, options]) => !options?.userId)).toEqual([["contract-1"]]);

    const { resolveAuctioneerReportContext } = await import("../src/service/auctioneerReportLinkService.js");
    const without = { auctioneer_work_item_id: response.body.data.workItemId, mixed_lots: [{ mode: "single_lot", count: 1 }] };
    await expect(resolveAuctioneerReportContext({ details: without, userId: ownerId, reportType: type }))
      .rejects.toMatchObject({ statusCode: 409, code: "AUCTIONEER_SCHEDULE_A_ITEM_REQUIRED" });
    const linked = { auctioneer_work_item_id: response.body.data.workItemId, mixed_lots: [{ mode: "single_lot", count: 1, schedule_a_parent_lot_id: "tools-lot" }] };
    await resolveAuctioneerReportContext({ details: linked, userId: ownerId, reportType: type });
    expect(linked.mixed_lots[0]).toMatchObject({ schedule_a_parent_lot_id: "tools-lot" });
  });

  it("retains continuation identity if an unused claim is released and reopened", async () => {
    const { work, report } = await seed();
    const first = (await continueRequest(work._id, report._id)).body.data;
    const released = await request(app).delete(`/api/auctioneer/work-items/${first.workItemId}/claim`).set("Authorization", token);
    expect(released.status).toBe(200);
    const reopened = await continueRequest(work._id, report._id);
    expect(reopened.status).toBe(201);
    expect(reopened.body.data.workItemId).toBe(first.workItemId);
    expect(reopened.body.data.clientSubmissionId).toBe(first.clientSubmissionId);
    expect(await WorkItem.countDocuments()).toBe(2);
  });

  it.each(["asset", "lotListing"] as const)("advertises exact draft upload recovery for unaccepted %s placeholders only", async (type) => {
    const { work, report, model } = await seed(type);
    const getSetup = () => request(app).get(`/api/auctioneer/work-items/${work._id}/setup`).set("Authorization", token);
    expect((await getSetup()).headers["cache-control"]).toBe("no-store");
    expect((await getSetup()).body.data.canResumeUpload).toBe(false);
    await model.collection.updateOne({ _id: report._id }, { $set: { job_status: "uploading" } });
    expect((await getSetup()).body.data).toMatchObject({ status: "report_created", reportId: String(report._id), canResumeUpload: true });
    await model.collection.updateOne({ _id: report._id }, { $set: { status: "error", job_status: "error" } });
    expect((await getSetup()).body.data.canResumeUpload).toBe(true);
    await model.collection.updateOne({ _id: report._id }, { $set: { processing_started_at: new Date() } });
    expect((await getSetup()).body.data.canResumeUpload).toBe(false);
    await model.collection.updateOne({ _id: report._id }, { $unset: { processing_started_at: 1 }, $set: { "preview_data.lots": [{ lot_number: "1", description: "Saved preview" }] } });
    expect((await getSetup()).body.data.canResumeUpload).toBe(false);
    await model.collection.updateOne({ _id: report._id }, { $unset: { preview_data: 1 }, $set: { client_submission_id: "not-this-draft" } });
    expect((await getSetup()).body.data.canResumeUpload).toBe(false);
  });

  it("never exposes queued provider payloads in setup and cannot resume an accepted error", async () => {
    const { work, report, model } = await seed();
    await model.collection.updateOne({ _id: report._id }, { $set: {
      status: "error", job_status: "error", report_job_outbox: { token: "accepted", idempotencyKey: "accepted", type: "asset-preview", reportId: String(report._id), progressId: report.job_id, payload: { privateMarker: "not-for-client" } },
    } });
    const response = await request(app).get(`/api/auctioneer/work-items/${work._id}/setup`).set("Authorization", token);
    expect(response.body.data.canResumeUpload).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain("not-for-client");
    expect((await continueRequest(work._id, report._id)).status).toBe(201);
  });
});
