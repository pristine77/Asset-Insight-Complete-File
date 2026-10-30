import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
// This suite's reports carry no condition-report PDF (see auctioneer2-delivery for that step).
vi.mock("../src/service/auctioneer2ConditionReportDocument.js", () => ({ buildLotConditionReportPdf: vi.fn(async () => null) }));

const upstream = vi.hoisted(() => ({
  getContractCapturePermission: vi.fn(), reopenContractForUser: vi.fn(),
  listIncomingContracts: vi.fn(), listIncomingTasks: vi.fn(), getContractLots: vi.fn(),
  closeContractPartForUser: vi.fn(), getLot: vi.fn(), getContractScheduleAItems: vi.fn(),
  submitLot: vi.fn(), patchLot: vi.fn(), uploadLotPhotos: vi.fn(), setLotVideo: vi.fn(),
  completeConditionReport: vi.fn(), markArrived: vi.fn(), pushToAssetInsight: vi.fn(), completeContractTask: vi.fn(),
}));
vi.mock("../src/service/auctioneer2Client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/service/auctioneer2Client.js")>(), ...upstream,
}));

let mongo: MongoMemoryServer;
let User: typeof import("../src/models/user.model.js")["default"];
let Work: typeof import("../src/models/auctioneerWorkItem.model.js")["default"];
let State: typeof import("../src/models/auctioneerContractClose.model.js")["default"];
let Asset: typeof import("../src/models/asset.model.js")["default"];
let Admission: typeof import("../src/models/reportSubmissionAdmission.model.js")["default"];
let integration: typeof import("../src/service/auctioneer2IntegrationService.js");
let client: typeof import("../src/service/auctioneer2Client.js");
let app: Awaited<typeof import("../src/app.js")>["default"];
const savedEnv = Object.fromEntries(["AUCTIONEER2_API_BASE_URL", "AUCTIONEER2_API_KEY", "AUCTIONEER2_FEATURE_ENABLED", "DEVICE_APPROVAL_ENFORCEMENT"].map(key => [key, process.env[key]]));
const contractId = "contract-reopen-94677";
let sequence = 0;

async function user(suffix: string) {
  return User.create({ email: `reopen-${suffix}@example.test`, username: `Reopen ${suffix}`,
    password: await bcrypt.hash("Password123!", 4), authProvider: "email", isVerified: true });
}
function token(owner: unknown) {
  return jwt.sign({ id: String(owner), role: "user" }, process.env.JWT_SECRET!, { expiresIn: "30m" });
}
function route(action: string, id = contractId) { return `/api/auctioneer/contracts/${encodeURIComponent(id)}/${action}`; }
function post(owner: unknown, action = "reopen", body: unknown = {}) {
  return request(app).post(route(action)).set("Authorization", `Bearer ${token(owner)}`).send(body);
}
function listing(owner: unknown, extra: Record<string, unknown> = {}) {
  return { id: contractId, contractNumber: "94677", eventId: "event-regina-1", eventTitle: "Regina Sale",
    eventDate: "2026-10-27", eventTime: "09:00", eventClosed: false, reopenUntil: "2026-10-27T15:00:00.000Z",
    status: "ProposalInAssetInsight", assignedUserId: String(owner), assignedUserName: "Assigned owner",
    hasScheduleA: true, hasUnknownLots: false, assetInsightTaskCompleted: true, ...extra };
}
async function work(owner: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) {
  const n = ++sequence;
  return Work.create({ source: "auctioneer2", cycleKey: `reopen-old-${n}`, assignmentUserId: owner,
    contract: { id: contractId, contractNo: "94677", eventId: "event-regina-1", eventTitle: "Regina Sale" },
    kind: "scheduleA", snapshot: { tasks: [], lots: [{ sourceKey: "original-lot", lotId: "old-upstream-lot",
      title: "Original report", sourcePhotos: [{ url: "https://assetinsight.test/original-photo.jpg" }] }], capturedAt: new Date() },
    claimedBy: owner, claimedAt: new Date(), selectedReportType: "asset", clientSubmissionId: `reopen-submission-${n}`,
    status: "sent", delivery: { status: "sent", completeContract: false, attempts: 1,
      lots: [{ sourceKey: "original-lot", sourceLotId: "old-upstream-lot", status: "sent" }], reconciliation: { required: false } }, ...extra });
}
async function closed(owner: mongoose.Types.ObjectId) {
  const old = await work(owner);
  upstream.listIncomingContracts.mockResolvedValue([listing(owner)]);
  const response = await post(owner, "close-my-part");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return old;
}
async function readyReport(owner: mongoose.Types.ObjectId) {
  const lots = [{ lot_number: "1", title: "Preserved old lot", image_indexes: [0] }];
  return Asset.create({ user: owner, contract_no: "94677", grouping_mode: "mixed", lots,
    imageUrls: ["https://assetinsight.test/preserved-original.jpg"], preview_data: { contract_no: "94677", lots },
    status: "approved", release_status: "released", job_status: "done",
    preview_files: { excel: "https://assetinsight.test/original.xlsx", docx: "https://assetinsight.test/original.docx", images: "https://assetinsight.test/original.zip" } });
}

beforeAll(async () => {
  process.env.AUCTIONEER2_API_BASE_URL = "https://auctioneer.example/api/external";
  process.env.AUCTIONEER2_API_KEY = "test-reopen-secret";
  process.env.AUCTIONEER2_FEATURE_ENABLED = "true";
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: Work } = await import("../src/models/auctioneerWorkItem.model.js"));
  ({ default: State } = await import("../src/models/auctioneerContractClose.model.js"));
  ({ default: Asset } = await import("../src/models/asset.model.js"));
  ({ default: Admission } = await import("../src/models/reportSubmissionAdmission.model.js"));
  integration = await import("../src/service/auctioneer2IntegrationService.js");
  client = await import("../src/service/auctioneer2Client.js");
  ({ default: app } = await import("../src/app.js"));
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([Work.createIndexes(), Admission.createIndexes()]);
  integration.clearAuctioneer2IncomingCacheForTests();
  Object.values(upstream).forEach(mock => mock.mockReset());
  for (const mutate of [upstream.submitLot, upstream.patchLot, upstream.uploadLotPhotos, upstream.setLotVideo,
    upstream.completeConditionReport, upstream.markArrived, upstream.pushToAssetInsight, upstream.completeContractTask]) {
    mutate.mockRejectedValue(new Error("This close-only test must not send or alter upstream lots."));
  }
  upstream.listIncomingContracts.mockResolvedValue([]);
  upstream.listIncomingTasks.mockResolvedValue([]);
  // A reopening must never import the old contract lots returned by this feed.
  upstream.getContractLots.mockResolvedValue([{ id: "old-upstream-lot", contractId, eventId: "event-regina-1", description: "Old lot" }]);
  upstream.getLot.mockResolvedValue({ id: "old-upstream-lot", contractId, eventId: "event-regina-1" });
  upstream.getContractScheduleAItems.mockResolvedValue({ contractId, hasScheduleA: true, items: [
    { lineId: "line-original", title: "Original report", severalLots: true, parentLotId: "old-upstream-lot", lotCount: 1, sortOrder: 1 },
    { lineId: "line-unticked", title: "Single item", severalLots: false, parentLotId: "single-lot", lotCount: 1, sortOrder: 2 },
  ] });
  upstream.getContractCapturePermission.mockResolvedValue({ reopen: { allowed: true, reason: null, reopenUntil: "2026-10-27T15:00:00.000Z" } });
  upstream.reopenContractForUser.mockImplementation(async (id: string) => ({ contractId: id, reopened: true, alreadyOpen: false, accessRevision: 42 }));
  upstream.closeContractPartForUser.mockImplementation(async (id: string, body: { completedByUserId: string }) => ({
    contractId: id, userId: body.completedByUserId, userStatus: "completed", taskCompleted: true, alreadyCompleted: false }));
});
afterAll(async () => {
  await mongoose.disconnect(); await mongo.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe.sequential("Auctioneer per-user contract Re-Open", () => {
  it.each(["asset", "lotListing"] as const)("reopens a closed contract as an empty %s capture and retains old reports and originals", async reportType => {
    const owner = await user(`happy-${reportType}`);
    const old = await closed(owner._id);
    const report = await readyReport(owner._id);
    await Work.updateOne({ _id: old._id }, { $set: { linkedReportId: report._id, linkedReportModel: "AssetReport" } });
    const oldBefore = await Work.findById(old._id).lean();
    const reportBefore = await Asset.findById(report._id).lean();
    expect((await integration.listAuctioneerIncoming(true, String(owner._id))).find(row => row.contractId === contractId)?.status).toBe("sent");
    const permission = await request(app).get(route("capture-permission")).set("Authorization", `Bearer ${token(owner._id)}`);
    expect(permission.status, JSON.stringify(permission.body)).toBe(200);
    expect(permission.headers["cache-control"]).toContain("no-store");
    expect(permission.body.data.reopen.allowed).toBe(true);
    const result = await post(owner._id);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toMatchObject({ reopened: true, accessRevision: 42 });
    expect(upstream.reopenContractForUser).toHaveBeenCalledWith(contractId, { userId: String(owner._id), reopenedBy: owner.username });
    const state = await State.findOne({ user: owner._id, contractId }).lean();
    expect(state).toMatchObject({ status: "open", accessRevision: 42 });
    const incoming = await integration.listAuctioneerIncoming(true, String(owner._id));
    const fresh = incoming.find(row => row.contractId === contractId && row.status === "available");
    expect(fresh).toMatchObject({ kind: "unknown", lotCount: 0 });
    expect(fresh?.cycleKey).not.toBe(old.cycleKey);
    upstream.getContractLots.mockClear();
    const claim = await integration.claimAuctioneerIncoming(fresh!.cycleKey, String(owner._id), reportType);
    const saved = await Work.findById(claim.workItemId).lean();
    expect(saved).toMatchObject({ kind: "unknown", contractAccessRevision: 42, snapshot: { tasks: [], lots: [] } });
    expect(upstream.getContractLots).not.toHaveBeenCalled();
    expect(await Work.findById(old._id).lean()).toEqual(oldBefore);
    expect(await Asset.findById(report._id).lean()).toEqual(reportBefore);
  });

  it("keeps a Schedule A contract's Several lots items on the Re-Open capture", async () => {
    // Owner 2026-10-28: lots captured after Re-Open must name a Schedule A item.
    const owner = await user("schedule-a-items"); await closed(owner._id);
    expect((await post(owner._id)).status).toBe(200);
    const fresh = (await integration.listAuctioneerIncoming(true, String(owner._id))).find(row => row.contractId === contractId && row.status === "available");
    const claim = await integration.claimAuctioneerIncoming(fresh!.cycleKey, String(owner._id), "asset");
    const original = { lineId: "line-original", title: "Original report", parentLotId: "old-upstream-lot" };
    expect((await Work.findById(claim.workItemId).lean())?.scheduleAChoices).toEqual([original]);
    expect(upstream.getContractScheduleAItems).toHaveBeenCalledWith(contractId);
    const setup = await integration.getAuctioneerWorkItemSetup(claim.workItemId, String(owner._id));
    expect(setup).toMatchObject({ kind: "unknown", requiresScheduleAItem: true, scheduleAChoices: [original] });
  });

  it("uses only the authenticated user and refuses body or query actor overrides", async () => {
    const owner = await user("actor"); const other = await user("spoof"); await closed(owner._id);
    for (const body of [{ userId: String(other._id) }, { reopenedBy: "Someone else" }, [], "invalid"]) {
      expect((await post(owner._id, "reopen", body)).status).toBe(400);
    }
    expect((await request(app).get(`${route("capture-permission")}?userId=${other._id}`).set("Authorization", `Bearer ${token(owner._id)}`)).status).toBe(400);
    expect((await request(app).post(`${route("reopen")}?userId=${other._id}`).set("Authorization", `Bearer ${token(owner._id)}`).send({})).status).toBe(400);
    expect(upstream.reopenContractForUser).not.toHaveBeenCalled();
    expect(upstream.getContractCapturePermission).not.toHaveBeenCalled();
  });

  it("does not use somebody else's local contract work as assignment authority", async () => {
    const owner = await user("assigned"); const other = await user("unassigned"); await closed(owner._id);
    upstream.listIncomingContracts.mockResolvedValue([]);
    const result = await post(other._id);
    expect(result.status, JSON.stringify(result.body)).toBe(404);
    expect(upstream.reopenContractForUser).not.toHaveBeenCalled();
    expect(await State.countDocuments({ user: other._id })).toBe(0);
  });

  it.each(["LOTS_CLOSING_STARTED", "EVENT_CLOSED", "PROPOSAL_REVIEWED", "REVOKED", "NO_GRANT", "AMBIGUOUS_REOPEN_USER"])("retains closure and exposes a meaningful %s refusal", async code => {
    const owner = await user(code.toLowerCase()); const old = await closed(owner._id);
    const prior = await State.findOne({ user: owner._id, contractId }).lean();
    const oldBefore = await Work.findById(old._id).lean();
    upstream.reopenContractForUser.mockRejectedValue(new client.Auctioneer2ClientError(`Re-Open was refused: ${code.toLowerCase().replaceAll("_", " ")}. Contact the auction team.`, { statusCode: 409, upstreamStatus: 409, code }));
    const result = await post(owner._id);
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body).toMatchObject({ code, message: expect.stringContaining("Contact the auction team") });
    expect(result.body.message).not.toContain("status code");
    expect(await State.findOne({ user: owner._id, contractId }).lean()).toMatchObject({ status: "confirmed", closedAt: prior?.closedAt });
    expect(await Work.findById(old._id).lean()).toEqual(oldBefore);
    expect((await integration.listAuctioneerIncoming(true, String(owner._id))).find(row => row.contractId === contractId)?.status).toBe("sent");
  });

  it("keeps an uncertain request fenced and confirms the same cycle on explicit already-open retry", async () => {
    const owner = await user("uncertain"); await closed(owner._id);
    upstream.reopenContractForUser.mockRejectedValueOnce(new client.Auctioneer2ClientError("Auctioneer could not confirm Re-Open. Retry the same request.", { statusCode: 504, code: "auctioneer2_timeout", ambiguousWrite: true }));
    expect((await post(owner._id)).status).toBe(504);
    const pending = await State.findOne({ user: owner._id, contractId }).lean();
    expect(pending).toMatchObject({ status: "reopen_pending", reopenCycleKey: expect.any(String) });
    upstream.getContractCapturePermission.mockResolvedValue({ reopen: { allowed: false, reason: null, reopenUntil: null } });
    const check = await request(app).get(route("capture-permission")).set("Authorization", `Bearer ${token(owner._id)}`);
    expect(check.body.data).toMatchObject({ confirmationPending: true, reopen: { allowed: false } });
    upstream.reopenContractForUser.mockResolvedValue({ contractId, reopened: false, alreadyOpen: true, accessRevision: 42 });
    const retry = await post(owner._id);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    const confirmed = await State.findOne({ user: owner._id, contractId }).lean();
    expect(confirmed).toMatchObject({ status: "open", reopenCycleKey: expect.any(String), reopenAttemptId: pending?.reopenAttemptId });
    const repeat = await post(owner._id);
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(200);
    expect(await State.findOne({ user: owner._id, contractId }).lean()).toMatchObject({ reopenCycleKey: confirmed?.reopenCycleKey, reopenAttemptId: pending?.reopenAttemptId });
    expect((await integration.listAuctioneerIncoming(true, String(owner._id))).filter(row => row.contractId === contractId)).toHaveLength(1);
  });

  it.each([404, 405, 501])("hides Re-Open when the upstream capability is unavailable (%s)", async upstreamStatus => {
    const owner = await user(`unsupported-${upstreamStatus}`); await closed(owner._id);
    upstream.getContractCapturePermission.mockRejectedValue(new client.Auctioneer2ClientError("Upstream unavailable.", { statusCode: 502, code: "auctioneer2_upstream_error", upstreamStatus }));
    const result = await request(app).get(route("capture-permission")).set("Authorization", `Bearer ${token(owner._id)}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.reopen.allowed).toBe(false);
    expect((await State.findOne({ user: owner._id, contractId }).lean())?.status).toBe("confirmed");
    expect(upstream.reopenContractForUser).not.toHaveBeenCalled();
  });

  it.each(["queued", "sending", "failed", "needs_reconciliation"])("does not reopen over an unfinished %s delivery", async deliveryStatus => {
    const owner = await user(`unfinished-${deliveryStatus}`); const old = await closed(owner._id);
    await Work.updateOne({ _id: old._id }, { $set: { "delivery.status": deliveryStatus } });
    const result = await post(owner._id);
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.code).toBe("auctioneer_contract_delivery_unfinished");
    expect(upstream.reopenContractForUser).not.toHaveBeenCalled();
  });

  it("refuses old report sends and continuations after Re-Open", async () => {
    const owner = await user("old-capture"); const old = await closed(owner._id);
    const report = await readyReport(owner._id);
    await Work.updateOne({ _id: old._id }, { $set: { status: "report_created", activeContractKey: "old-active-capture",
      linkedReportId: report._id, linkedReportModel: "AssetReport", "delivery.status": "ready" } });
    await Asset.updateOne({ _id: report._id }, { $set: { auctioneerWorkItem: old._id,
      client_submission_id: old.clientSubmissionId, job_id: "accepted-old-job" } });
    const result = await post(owner._id);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    await expect(integration.queueAuctioneerDelivery(String(old._id), String(owner._id), { destination: "LottingBoard" }))
      .rejects.toMatchObject({ code: "auctioneer_contract_capture_changed" });
    await expect(integration.continueAuctioneerWorkItem(String(old._id), String(owner._id), { reportId: String(report._id) }))
      .rejects.toMatchObject({ code: "auctioneer_contract_capture_changed" });
  });

  it("limits Completed visibility to the current upstream completed-contract window", async () => {
    const owner = await user("window"); await closed(owner._id);
    expect((await integration.listAuctioneerIncoming(true, String(owner._id))).some(row => row.contractId === contractId)).toBe(true);
    upstream.listIncomingContracts.mockResolvedValue([]);
    expect((await integration.listAuctioneerIncoming(true, String(owner._id))).some(row => row.contractId === contractId)).toBe(false);
    expect(await Work.countDocuments({ "contract.id": contractId })).toBe(1);
  });

  it("fences delayed old Close requests and closes the current revision without changing historical receipts", async () => {
    const owner = await user("close-epoch"); const old = await closed(owner._id);
    const oldBefore = await Work.findById(old._id).lean();
    expect((await post(owner._id)).status).toBe(200);
    const fresh = (await integration.listAuctioneerIncoming(true, String(owner._id))).find(row => row.status === "available");
    const claim = await integration.claimAuctioneerIncoming(fresh!.cycleKey, String(owner._id), "asset");
    const calls = upstream.closeContractPartForUser.mock.calls.length;
    for (const body of [{}, { accessRevision: 0 }, { accessRevision: "42" }]) {
      const stale = await post(owner._id, "close-my-part", body);
      expect(stale.status, JSON.stringify(stale.body)).toBe(409);
      expect(stale.body.code).toBe("auctioneer_contract_capture_changed");
    }
    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(calls);
    expect((await State.findOne({ user: owner._id, contractId }).lean())?.status).toBe("open");
    const current = await post(owner._id, "close-my-part", { accessRevision: 42 });
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect((await State.findOne({ user: owner._id, contractId }).lean())?.status).toBe("confirmed");
    expect((await Work.findById(claim.workItemId).lean())?.delivery.contractClose).toMatchObject({ userId: String(owner._id), via: "manual" });
    expect(await Work.findById(old._id).lean()).toEqual(oldBefore);
  });

  it("prevents a delayed old delivery worker from closing the reopened part", async () => {
    const owner = await user("worker-epoch");
    const old = await work(owner._id);
    const report = await readyReport(owner._id);
    await Work.updateOne({ _id: old._id }, { $set: { status: "report_created", activeContractKey: "worker-old-active",
      linkedReportId: report._id, linkedReportModel: "AssetReport", "delivery.status": "ready" } });
    await integration.queueAuctioneerDelivery(String(old._id), String(owner._id), { destination: "LottingBoard", completeContract: true });
    await Work.updateOne({ _id: old._id }, { $set: { status: "sent", "delivery.status": "sent", "delivery.lots.$[].status": "sent" }, $unset: { activeContractKey: 1 } });
    expect((await post(owner._id, "close-my-part")).status).toBe(200);
    upstream.listIncomingContracts.mockResolvedValue([listing(owner._id)]);
    expect((await post(owner._id)).status).toBe(200);
    const closeCalls = upstream.closeContractPartForUser.mock.calls.length;
    // Model a late worker attempt carrying the original immutable delivery.
    await Work.updateOne({ _id: old._id }, { $set: { status: "report_created", "delivery.status": "queued" } });
    const { runAuctioneerDeliveryJob } = await import("../src/service/auctioneer2DeliveryService.js");
    await expect(runAuctioneerDeliveryJob(String(old._id))).rejects.toThrow(/earlier opening/);
    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(closeCalls);
    expect((await State.findOne({ user: owner._id, contractId }).lean())?.status).toBe("open");
    expect((await Work.findById(old._id).lean())?.delivery.lots.every(lot => lot.status === "sent")).toBe(true);
    const historicalFailure = await Work.findById(old._id).lean();
    const fresh = (await integration.listAuctioneerIncoming(true, String(owner._id))).find(row => row.status === "available");
    await integration.claimAuctioneerIncoming(fresh!.cycleKey, String(owner._id), "asset");
    const closedCurrent = await post(owner._id, "close-my-part", { accessRevision: 42 });
    expect(closedCurrent.status, JSON.stringify(closedCurrent.body)).toBe(200);
    expect(await Work.findById(old._id).lean()).toEqual(historicalFailure);
  });

  it("does not let an Incoming read begun before Re-Open replace the refreshed cache", async () => {
    const owner = await user("cache-epoch"); await closed(owner._id);
    let release!: (value: unknown[]) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<unknown[]>(resolve => { release = resolve; });
    upstream.listIncomingContracts.mockImplementationOnce(async () => { entered(); return gate; });
    const oldRead = integration.listAuctioneerIncoming(true, String(owner._id));
    await started;
    try {
      expect((await post(owner._id)).status).toBe(200);
      upstream.listIncomingContracts.mockResolvedValue([listing(owner._id, { eventTitle: "Current event title" })]);
      const fresh = await integration.listAuctioneerIncoming(true, String(owner._id));
      expect(fresh.find(row => row.contractId === contractId)?.eventTitle).toBe("Current event title");
      release([listing(owner._id, { eventTitle: "Old event title" })]);
      await oldRead;
      const cached = await integration.listAuctioneerIncoming(false, String(owner._id));
      expect(cached.find(row => row.contractId === contractId)?.eventTitle).toBe("Current event title");
      expect(upstream.listIncomingContracts).toHaveBeenCalledTimes(2);
    } finally { release([]); await oldRead; }
  });

  it("refuses foreign embedded contract context before a reopened capture is created", async () => {
    const owner = await user("foreign-context"); await closed(owner._id);
    expect((await post(owner._id)).status).toBe(200);
    const fresh = (await integration.listAuctioneerIncoming(true, String(owner._id))).find(row => row.status === "available");
    upstream.listIncomingContracts.mockResolvedValue([listing(owner._id, { contract: { id: "somebody-elses-contract", eventId: "event-regina-1" } })]);
    await expect(integration.claimAuctioneerIncoming(fresh!.cycleKey, String(owner._id), "asset")).rejects.toMatchObject({ statusCode: 409 });
    expect(await Work.countDocuments({ contractAccessRevision: 42 })).toBe(0);
  });

  it("does not revive an original proposal cycle after its old work is removed and the part is closed or reopened", async () => {
    const owner = await user("deleted-old-cycle");
    upstream.listIncomingContracts.mockResolvedValue([listing(owner._id, { assetInsightTaskCompleted: false })]);
    const original = (await integration.listAuctioneerIncoming(true, String(owner._id))).find(row => row.status === "available");
    expect(original?.cycleKey).toBeDefined();
    const old = await closed(owner._id);
    await Work.deleteOne({ _id: old._id });
    upstream.getContractLots.mockClear(); upstream.getLot.mockClear();
    await expect(integration.claimAuctioneerIncoming(original!.cycleKey, String(owner._id), "asset"))
      .rejects.toMatchObject({ code: "auctioneer_contract_close_pending_or_confirmed" });
    expect((await post(owner._id)).status).toBe(200);
    await expect(integration.claimAuctioneerIncoming(original!.cycleKey, String(owner._id), "asset"))
      .rejects.toMatchObject({ code: "auctioneer_contract_capture_changed" });
    expect(upstream.getContractLots).not.toHaveBeenCalled();
    expect(upstream.getLot).not.toHaveBeenCalled();
    expect(await Work.countDocuments({ "contract.id": contractId })).toBe(0);
    expect((await State.findOne({ user: owner._id, contractId }).lean())?.status).toBe("open");
  });

  it.each([
    ["asset", "asset"], ["lotListing", "lotListing"], ["asset", "lotListing"],
  ] as const)("serializes simultaneous same-owner original-cycle claims (%s / %s) without losing retry identity or the report-type lock", async (firstType, secondType) => {
    const owner = await user(`concurrent-${firstType}-${secondType}`);
    const contract = listing(owner._id, { assetInsightTaskCompleted: false, hasScheduleA: false, hasUnknownLots: true });
    upstream.listIncomingContracts.mockResolvedValue([contract]);
    upstream.getContractLots.mockResolvedValue([]);
    const incoming = (await integration.listAuctioneerIncoming(true, String(owner._id))).find(row => row.status === "available");
    expect(incoming?.cycleKey).toBeDefined();
    let release!: () => void; let entered!: () => void; let arrivals = 0;
    const bothRead = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Both calls have already observed no existing work before either can
    // acquire admission. The second must recover the first call's exact claim.
    upstream.listIncomingContracts.mockImplementation(async () => {
      if (++arrivals === 2) entered();
      await gate; return [contract];
    });
    const resultsPromise = Promise.allSettled([
      integration.claimAuctioneerIncoming(incoming!.cycleKey, String(owner._id), firstType),
      integration.claimAuctioneerIncoming(incoming!.cycleKey, String(owner._id), secondType),
    ]);
    await bothRead;
    try {
      release();
      const results = await resultsPromise;
      const successes = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof integration.claimAuctioneerIncoming>>> => result.status === "fulfilled");
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (firstType === secondType) {
        expect(successes).toHaveLength(2); expect(failures).toHaveLength(0);
        expect(successes[1].value).toEqual(successes[0].value);
      } else {
        expect(successes).toHaveLength(1); expect(failures).toHaveLength(1);
        expect(failures[0].reason).toMatchObject({ code: "auctioneer_report_type_locked" });
      }
      const saved = await Work.findOne({ "contract.id": contractId }).lean();
      expect(saved).toMatchObject({ selectedReportType: successes[0].value.reportType,
        clientSubmissionId: successes[0].value.clientSubmissionId });
      expect(await Work.countDocuments({ "contract.id": contractId })).toBe(1);
      expect(upstream.getContractLots).toHaveBeenCalledTimes(1);
    } finally { release(); await resultsPromise; }
  });

  it("automatically closes a new revision after delivery while retaining an old failed delivery and its receipt", async () => {
    const owner = await user("automatic-close-epoch"); const old = await closed(owner._id);
    expect((await post(owner._id)).status).toBe(200);
    await Work.updateOne({ _id: old._id }, { $set: { "delivery.status": "failed", "delivery.lastError": "Historical failure retained" } });
    const historical = await Work.findById(old._id).lean();
    const fresh = (await integration.listAuctioneerIncoming(true, String(owner._id))).find(row => row.status === "available");
    const claim = await integration.claimAuctioneerIncoming(fresh!.cycleKey, String(owner._id), "asset");
    const report = await readyReport(owner._id);
    // The listing has a Schedule A, so the Re-Open lot names its item (owner 2026-10-28).
    await Asset.updateOne({ _id: report._id }, { $set: { "lots.0.auctioneer_source_key": "fresh-close-source",
      "preview_data.lots.0.auctioneer_source_key": "fresh-close-source",
      "lots.0.schedule_a_parent_lot_id": "old-upstream-lot",
      "preview_data.lots.0.schedule_a_parent_lot_id": "old-upstream-lot" } });
    await Work.updateOne({ _id: claim.workItemId }, { $set: { status: "report_created", linkedReportId: report._id,
      linkedReportModel: "AssetReport", "delivery.status": "ready" } });
    await integration.queueAuctioneerDelivery(claim.workItemId, String(owner._id), { destination: "LottingBoard", completeContract: true });
    // Every fresh lot has landed; only the current part's automatic close remains.
    await Work.updateOne({ _id: claim.workItemId }, { $set: { "delivery.lots": [
      { sourceKey: "fresh-close-source", createdLotId: "fresh-confirmed-lot", status: "sent" },
    ] } });
    const beforeCalls = upstream.closeContractPartForUser.mock.calls.length;
    const { runAuctioneerDeliveryJob } = await import("../src/service/auctioneer2DeliveryService.js");
    await runAuctioneerDeliveryJob(claim.workItemId);
    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(beforeCalls + 1);
    expect(await Work.findById(claim.workItemId).lean()).toMatchObject({ status: "sent", delivery: {
      status: "sent", contractClose: { userId: String(owner._id), via: "delivery", taskCompleted: true } } });
    expect(await State.findOne({ user: owner._id, contractId }).lean()).toMatchObject({ status: "confirmed", accessRevision: 42 });
    expect(await Work.findById(old._id).lean()).toEqual(historical);
    expect(upstream.submitLot).not.toHaveBeenCalled();
  });

  /*
   * Owner, 2026-10-29 (contract 825684): a capture made before the Re-Open and
   * never sent was stranded — "This capture belongs to an earlier opening" — so
   * the appraiser had to capture the lot again. It now carries into the current
   * opening when sent. A capture that was sent stays fenced (the test above).
   */
  it("carries a never-sent capture from before the Re-Open into the current opening when it is sent", async () => {
    const owner = await user("carry-unsent");
    // Made before the part was closed and never sent; no opening number yet, as on 825684.
    const unsent = await work(owner._id, { status: "report_created",
      delivery: { status: "ready", completeContract: false, attempts: 0, lots: [], reconciliation: { required: false } } });
    const report = await readyReport(owner._id);
    await Work.updateOne({ _id: unsent._id }, { $set: { linkedReportId: report._id, linkedReportModel: "AssetReport" } });
    await Asset.updateOne({ _id: report._id }, { $set: { auctioneerWorkItem: unsent._id, client_submission_id: unsent.clientSubmissionId } });
    await closed(owner._id);
    expect((await post(owner._id)).status).toBe(200);

    // Reports already shows it in the current opening, so the phone app's check of the reply holds.
    const listed = (await integration.listAuctioneerDeliveries(String(owner._id))).find(row => row.workItemId === String(unsent._id));
    expect(listed).toMatchObject({ accessRevision: 42, canSend: true, state: "ready" });
    expect(await integration.getAuctioneerDeliverySummary(String(unsent._id), String(owner._id))).toMatchObject({ accessRevision: 42 });

    const sent = await integration.queueAuctioneerDelivery(String(unsent._id), String(owner._id), { destination: "LottingBoard" });
    expect(sent).toMatchObject({ workItemId: String(unsent._id), accessRevision: 42, state: "queued" });
    const carried = await Work.findById(unsent._id).lean();
    expect(carried).toMatchObject({ contractAccessRevision: 42, carriedFromAccessRevision: null, delivery: { status: "queued" } });
    expect(carried?.carriedIntoOpeningAt).toBeInstanceOf(Date);
  });

  it("carries only never-sent captures of the contract's own user, and only while the contract is open again", async () => {
    const { captureCarriesIntoCurrentOpening } = await import("../src/service/auctioneerContractCloseService.js");
    const owner = new mongoose.Types.ObjectId();
    const unsent = { claimedBy: owner, assignmentUserId: owner, contractAccessRevision: 41, status: "report_created",
      delivery: { status: "ready", attempts: 0, lots: [] } };
    const open = { status: "open", accessRevision: 42 };
    expect(captureCarriesIntoCurrentOpening(unsent, open)).toBe(true);
    expect(captureCarriesIntoCurrentOpening({ ...unsent, contractAccessRevision: undefined }, open)).toBe(true);
    // Already in the current opening: nothing to carry.
    expect(captureCarriesIntoCurrentOpening({ ...unsent, contractAccessRevision: 42 }, open)).toBe(false);
    // Sent, or ever attempted: Auctioneer may hold a copy, so it stays fenced.
    expect(captureCarriesIntoCurrentOpening({ ...unsent, delivery: { status: "failed", attempts: 1, lots: [] } }, open)).toBe(false);
    expect(captureCarriesIntoCurrentOpening({ ...unsent, delivery: { status: "ready", attempts: 0, lots: [{}] } }, open)).toBe(false);
    expect(captureCarriesIntoCurrentOpening({ ...unsent, status: "sent" }, open)).toBe(false);
    // The contract closed again, or its Re-Open not yet confirmed.
    expect(captureCarriesIntoCurrentOpening(unsent, { status: "confirmed", accessRevision: 42 })).toBe(false);
    expect(captureCarriesIntoCurrentOpening(unsent, { status: "reopen_pending", accessRevision: 42 })).toBe(false);
    expect(captureCarriesIntoCurrentOpening(unsent, null)).toBe(false);
    // Somebody else's assigned work.
    expect(captureCarriesIntoCurrentOpening({ ...unsent, assignmentUserId: new mongoose.Types.ObjectId() }, open)).toBe(false);
  });
});
