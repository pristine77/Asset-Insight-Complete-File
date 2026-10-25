import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
const upstream = vi.hoisted(() => ({ contracts: vi.fn(), lots: vi.fn() }));
vi.mock("../src/service/auctioneer2Client.js", () => ({ listIncomingContracts: upstream.contracts, getContractLots: upstream.lots }));

import WorkItem from "../src/models/auctioneerWorkItem.model.js";
import Asset from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import { recoverInitialAuctioneerEventIdentity as recover } from "../src/service/auctioneerEventResolutionService.js";

let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase(); vi.restoreAllMocks(); vi.clearAllMocks();
  upstream.contracts.mockReset().mockResolvedValue([]); upstream.lots.mockReset().mockResolvedValue([]);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

type ReportType = "asset" | "lotListing";
async function seed(options: { type?: ReportType; eventId?: unknown; snapshot?: Record<string, unknown>; work?: Record<string, unknown>; report?: Record<string, unknown> } = {}) {
  const type = options.type || "asset", reportId = new mongoose.Types.ObjectId(), workId = new mongoose.Types.ObjectId(), owner = new mongoose.Types.ObjectId();
  const updatedAt = new Date("2026-09-23T12:00:00.000Z");
  await WorkItem.collection.insertOne({
    _id: workId, source: "auctioneer2", cycleKey: `cycle-${workId}`, clientSubmissionId: `submission-${workId}`,
    linkedReportId: reportId, linkedReportModel: type === "asset" ? "AssetReport" : "LotListing", selectedReportType: type,
    claimedBy: owner, assignmentUserId: owner, status: "report_created", kind: "unknown", updatedAt,
    contract: { id: "contract-1", contractNo: "93530", customerName: "Keep customer", eventTitle: "Keep title", ...(options.eventId !== undefined ? { eventId: options.eventId } : {}) },
    snapshot: { contract: { id: "contract-1" }, tasks: [], lots: [], customer: { name: "Frozen customer" }, capturedAt: updatedAt, ...options.snapshot },
    delivery: { status: "not_ready", lots: [], attempts: 0 }, ...options.work,
  });
  const Model = type === "asset" ? Asset : LotListing;
  await Model.collection.insertOne({
    _id: reportId, user: owner, auctioneerWorkItem: workId, status: "error", job_status: "error", job_id: `job-${reportId}`,
    client_submission_id: `submission-${workId}`, updatedAt, imageUrls: ["https://assetinsight.test/keep-original.jpg"], notes: "Keep complete report", lots: [], ...options.report,
  });
  return { reportId, workId, owner, type, Model };
}
type Source = Awaited<ReturnType<typeof seed>>;
const run = (source: Source, assertOwned?: () => Promise<void>) => recover({ reportId: source.reportId, reportType: source.type, assertOwned });
const assigned = (source: Source, eventId: unknown = "event-1") => ({ id: "contract-1", status: "ProposalInAssetInsight", assignedUserId: String(source.owner), eventId });
const changedError = { code: "auctioneer_event_context_changed", statusCode: 409 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
async function unchanged(source: Source, workBefore: unknown, reportBefore: unknown) {
  expect(await WorkItem.collection.findOne({ _id: source.workId })).toEqual(workBefore);
  expect(await source.Model.collection.findOne({ _id: source.reportId })).toEqual(reportBefore);
}

describe.sequential("missing Auctioneer event recovery", () => {
  it.each(["asset", "lotListing"] as const)("recovers %s from consistent saved metadata without provider calls or changing snapshots/report", async (type) => {
    const source = await seed({ type, snapshot: { contract: { id: "contract-1", eventId: " event-1 " }, event: { id: "event-1" }, tasks: [{ lot: { contractId: "contract-1", event_id: "event-1" } }], lots: [{ sourceKey: "source-1", raw: { contract: { id: "contract-1", event: { id: "event-1" } }, photos: [{ url: "https://assetinsight.test/frozen.jpg" }], notes: "Keep source" } }] } });
    const before = await WorkItem.collection.findOne({ _id: source.workId }), report = await source.Model.collection.findOne({ _id: source.reportId });
    expect(await run(source)).toEqual({ eventId: "event-1", contractId: "contract-1" });
    const saved = await WorkItem.collection.findOne({ _id: source.workId });
    expect(saved?.contract).toEqual({ ...before!.contract, eventId: "event-1" });
    expect(saved?.snapshot).toEqual(before?.snapshot); expect(saved?.delivery).toEqual(before?.delivery);
    expect(saved?.eventIdentityRecovery).toMatchObject({ eventId: "event-1", source: "saved_snapshot", resolvedAt: expect.any(Date) });
    expect(await source.Model.collection.findOne({ _id: source.reportId })).toEqual(report);
    expect(await mongoose.connection.db!.collection("reportjobs").countDocuments()).toBe(0);
    expect(upstream.contracts).not.toHaveBeenCalled(); expect(upstream.lots).not.toHaveBeenCalled();
  });

  it.each(["contract", "event", "task", "source-lot"])("uses an isolated saved %s event source", async (kind) => {
    const snapshot = kind === "contract" ? { contract: { id: "contract-1", event_id: "event-1" } }
      : kind === "event" ? { event: { id: "event-1" } }
        : kind === "task" ? { tasks: [{ item: { contractId: "contract-1", event: { id: "event-1" } } }] }
          : { lots: [{ sourceKey: "one", raw: { contractId: "contract-1", eventId: "event-1" } }] };
    const source = await seed({ snapshot }); expect((await run(source)).eventId).toBe("event-1");
    expect(upstream.contracts).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("recovers %s from its freshly assigned exact contract", async (type) => {
    const source = await seed({ type }); upstream.contracts.mockResolvedValue([{ id: "other-contract", eventId: "ignore" }, { ...assigned(source), eventId: "  ", event: { id: "event-1" } }]);
    expect(await run(source)).toEqual({ eventId: "event-1", contractId: "contract-1" });
    expect(upstream.contracts).toHaveBeenCalledWith(String(source.owner)); expect(upstream.lots).not.toHaveBeenCalled();
    expect((await WorkItem.findById(source.workId).lean())?.eventIdentityRecovery?.source).toBe("assigned_contract");
  });

  it.each(["asset", "lotListing"] as const)("uses exact-contract lots for legacy %s assignment absent from Proposal feed", async (type) => {
    const source = await seed({ type }); upstream.lots.mockResolvedValue([{ eventId: "unscoped-ignore" }, { rowGuid: "lot-1", contract: { id: "contract-1" }, event: { id: "event-1" } }]);
    expect(await run(source)).toEqual({ eventId: "event-1", contractId: "contract-1" });
    expect(upstream.lots).toHaveBeenCalledWith("contract-1"); expect((await WorkItem.findById(source.workId).lean())?.eventIdentityRecovery?.source).toBe("contract_lots");
  });

  it.each(["absent", "invalid-scalars", "title-only", "unscoped-lot"])("keeps genuine %s event failures explicit and makes no correction", async (kind) => {
    const source = await seed({ snapshot: kind === "title-only" ? { event: { title: "Sale", date: "2026-10-01" } } : {} });
    if (kind === "invalid-scalars") upstream.contracts.mockResolvedValue([assigned(source, {}), assigned(source, true), assigned(source, -1)]);
    if (kind === "unscoped-lot") upstream.lots.mockResolvedValue([{ eventId: "event-1" }]);
    const before = await WorkItem.collection.findOne({ _id: source.workId }), report = await source.Model.collection.findOne({ _id: source.reportId });
    await expect(run(source)).rejects.toMatchObject({ code: "auctioneer_lot_event_required", statusCode: 409 }); await unchanged(source, before, report);
  });

  it.each(["wrong-owner", "missing-owner", "wrong-status", "conflicting-owner", "foreign-contract-alias"])("rejects an assigned contract with %s without falling through to lots", async (kind) => {
    const source = await seed(); const contract: Record<string, unknown> = assigned(source);
    if (kind === "wrong-owner") contract.assignedUserId = String(new mongoose.Types.ObjectId());
    if (kind === "missing-owner") delete contract.assignedUserId;
    if (kind === "wrong-status") contract.status = "Completed";
    if (kind === "conflicting-owner") contract.assignedTo = String(new mongoose.Types.ObjectId());
    if (kind === "foreign-contract-alias") contract.contractId = "foreign";
    upstream.contracts.mockResolvedValue([contract]); upstream.lots.mockResolvedValue([{ contractId: "contract-1", eventId: "event-1" }]);
    await expect(run(source)).rejects.toMatchObject({ code: kind === "foreign-contract-alias" ? changedError.code : "auctioneer_event_assignment_unavailable" });
    expect(upstream.lots).not.toHaveBeenCalled(); expect((await WorkItem.findById(source.workId).lean())?.contract.eventId).toBeUndefined();
  });

  it.each(["saved-contract", "saved-task", "saved-source-lot", "live-lot", "nested-contract"])("rejects foreign %s event evidence", async (kind) => {
    const snapshot = kind === "saved-contract" ? { contract: { id: "foreign", eventId: "event-1" } }
      : kind === "saved-task" ? { tasks: [{ lot: { contractId: "foreign", eventId: "event-1" } }] }
        : kind === "saved-source-lot" ? { lots: [{ raw: { contractId: "foreign", eventId: "event-1" } }] }
          : kind === "nested-contract" ? { tasks: [{ lot: { contract: { _id: "foreign", eventId: "event-1" } } }] } : {};
    const source = await seed({ snapshot }); if (kind === "live-lot") upstream.lots.mockResolvedValue([{ contractId: "foreign", eventId: "event-1" }]);
    await expect(run(source)).rejects.toMatchObject(changedError);
    expect((await WorkItem.findById(source.workId).lean())?.contract.eventId).toBeUndefined();
  });

  it.each(["saved", "assigned", "lots"])("rejects conflicting %s event identities", async (kind) => {
    const source = await seed({ snapshot: kind === "saved" ? { contract: { id: "contract-1", eventId: "event-1" }, event: { id: "event-2" } } : {} });
    if (kind === "assigned") upstream.contracts.mockResolvedValue([assigned(source, "event-1"), assigned(source, "event-2")]);
    if (kind === "lots") upstream.lots.mockResolvedValue([{ contractId: "contract-1", eventId: "event-1" }, { contractId: "contract-1", eventId: "event-2" }]);
    await expect(run(source)).rejects.toMatchObject({ code: "auctioneer_event_identity_conflict" });
    expect((await WorkItem.findById(source.workId).lean())?.contract.eventId).toBeUndefined();
  });

  it.each(["saved-nested-contract", "live-nested-contract", "standalone-event"])("rejects foreign contract identity in %s metadata without changing saved work", async (kind) => {
    const snapshot = kind === "saved-nested-contract"
      ? { contract: { id: "contract-1", lot: { contract: { _id: "foreign-contract", eventId: "event-1" } } } }
      : kind === "standalone-event" ? { event: { id: "event-1", contractId: "foreign-contract" } } : {};
    const source = await seed({ snapshot });
    if (kind === "live-nested-contract") upstream.contracts.mockResolvedValue([{ ...assigned(source, undefined), eventId: undefined, contract: { id: "foreign-contract", eventId: "event-1" } }]);
    const before = await WorkItem.collection.findOne({ _id: source.workId }), report = await source.Model.collection.findOne({ _id: source.reportId });
    await expect(run(source)).rejects.toMatchObject(changedError);
    await unchanged(source, before, report);
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it("does not touch a known canonical event or inspect contradictory recovery evidence", async () => {
    const source = await seed({ eventId: "event-known", snapshot: { event: { id: "event-other" } } });
    const before = await WorkItem.collection.findOne({ _id: source.workId }), report = await source.Model.collection.findOne({ _id: source.reportId });
    expect(await run(source)).toEqual({ eventId: "event-known", contractId: "contract-1" });
    await unchanged(source, before, report); expect(upstream.contracts).not.toHaveBeenCalled(); expect(upstream.lots).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("rejects every submitted/reviewed/released %s boundary before provider access", async (type) => {
    const states: Record<string, unknown>[] = [
      { status: "preview" }, { status: "approved" }, { status: "pending_approval" }, { is_draft_preview: true },
      { preview_submitted_at: new Date() }, { approval_requested_at: new Date() }, { approval_processed_at: new Date() }, { released_at: new Date() },
      { adminArchivedAt: new Date() }, { preview_data: { lots: [{ lot_number: "1" }] } },
    ];
    for (const report of states) { const source = await seed({ type, report }); await expect(run(source)).rejects.toMatchObject(changedError); }
    expect(upstream.contracts).not.toHaveBeenCalled(); expect(upstream.lots).not.toHaveBeenCalled();
  });

  it.each(["ready", "queued", "sending", "sent", "needs_reconciliation", "frozen-manifest", "abandoned", "work-sent"])("protects %s delivery/work state", async (state) => {
    const work = state === "abandoned" || state === "work-sent" ? { status: state === "abandoned" ? "abandoned" : "sent" }
      : { delivery: { status: state === "frozen-manifest" ? "failed" : state, ...(state === "frozen-manifest" ? { manifest: { reportId: "frozen" } } : {}) } };
    const source = await seed({ work }); await expect(run(source)).rejects.toMatchObject(changedError); expect(upstream.contracts).not.toHaveBeenCalled();
  });

  it.each(["report-owner", "assignment-owner", "report-link", "wrong-source", "wrong-type"])("rejects mismatched %s ownership/linkage", async (kind) => {
    const source = await seed();
    if (kind === "report-owner") await source.Model.collection.updateOne({ _id: source.reportId }, { $set: { user: new mongoose.Types.ObjectId() } });
    if (kind === "assignment-owner") await WorkItem.collection.updateOne({ _id: source.workId }, { $set: { assignmentUserId: new mongoose.Types.ObjectId() } });
    if (kind === "report-link") await source.Model.collection.updateOne({ _id: source.reportId }, { $set: { auctioneerWorkItem: new mongoose.Types.ObjectId() } });
    if (kind === "wrong-source") await WorkItem.collection.updateOne({ _id: source.workId }, { $set: { source: "legacy" } });
    if (kind === "wrong-type") await WorkItem.collection.updateOne({ _id: source.workId }, { $set: { linkedReportModel: "LotListing" } });
    await expect(run(source)).rejects.toMatchObject(changedError); expect(upstream.contracts).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs, absent records and a missing contract ID without provider reads", async () => {
    await expect(recover({ reportId: "bad-id", reportType: "asset" })).rejects.toMatchObject(changedError);
    await expect(recover({ reportId: new mongoose.Types.ObjectId(), reportType: "asset" })).rejects.toMatchObject(changedError);
    const source = await seed(); await WorkItem.collection.updateOne({ _id: source.workId }, { $unset: { "contract.id": 1 } });
    await expect(run(source)).rejects.toMatchObject({ code: "auctioneer_lot_contract_required" }); expect(upstream.contracts).not.toHaveBeenCalled();
  });

  it.each(["contracts", "lots"])("preserves provider %s failures without writing or inventing an event", async (endpoint) => {
    const source = await seed(); upstream[endpoint].mockRejectedValue(new Error("Provider fixture unavailable"));
    await expect(run(source)).rejects.toThrow("Provider fixture unavailable"); expect((await WorkItem.findById(source.workId).lean())?.contract.eventId).toBeUndefined();
  });

  it("honors the worker ownership callback before any provider access", async () => {
    const source = await seed(); const owned = vi.fn(async () => { throw new Error("Lease lost"); });
    await expect(run(source, owned)).rejects.toThrow("Lease lost"); expect(upstream.contracts).not.toHaveBeenCalled();
  });

  it("stops if the worker loses its lease during provider lookup", async () => {
    const source = await seed(); upstream.contracts.mockResolvedValue([assigned(source)]);
    const owned = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("Lease lost after lookup"));
    await expect(run(source, owned)).rejects.toThrow("Lease lost after lookup");
    expect((await WorkItem.findById(source.workId).lean())?.contract.eventId).toBeUndefined();
  });

  it.each(["owner", "status", "edit", "submitted", "preview"])("rejects report %s changes while provider lookup is pending, without a worker callback", async (kind) => {
    const source = await seed(); const gate = deferred<unknown[]>(); upstream.contracts.mockReturnValue(gate.promise);
    const result = run(source).catch((error: unknown) => error); await vi.waitFor(() => expect(upstream.contracts).toHaveBeenCalledTimes(1));
    const update = kind === "owner" ? { user: new mongoose.Types.ObjectId() } : kind === "status" ? { status: "preview" }
      : kind === "edit" ? { updatedAt: new Date(), notes: "Keep newer edit" } : kind === "submitted" ? { preview_submitted_at: new Date() }
        : { preview_data: { lots: [{ lot_number: "5", description: "Keep saved preview" }] } };
    await source.Model.collection.updateOne({ _id: source.reportId }, { $set: update }); gate.resolve([assigned(source)]);
    expect(await result).toMatchObject(changedError); expect((await WorkItem.findById(source.workId).lean())?.contract.eventId).toBeUndefined();
    expect(await source.Model.collection.findOne({ _id: source.reportId })).toMatchObject(update);
  });

  it("rejects post-CAS report review without rolling back or overwriting the reviewed report", async () => {
    const source = await seed({ snapshot: { event: { id: "event-1" } } });
    const update = WorkItem.collection.updateOne.bind(WorkItem.collection);
    vi.spyOn(WorkItem.collection, "updateOne").mockImplementationOnce(async (...args: Parameters<typeof update>) => {
      const result = await update(...args); await source.Model.collection.updateOne({ _id: source.reportId }, { $set: { status: "preview", updatedAt: new Date() } }); return result;
    });
    await expect(run(source)).rejects.toMatchObject(changedError);
    expect((await source.Model.findById(source.reportId).lean())?.status).toBe("preview");
  });

  it("coalesces same-event concurrent corrections and records one durable identity", async () => {
    const source = await seed(); const gate = deferred<unknown[]>(); upstream.contracts.mockReturnValue(gate.promise);
    const results = Promise.all([run(source), run(source)]); await vi.waitFor(() => expect(upstream.contracts).toHaveBeenCalledTimes(2)); gate.resolve([assigned(source)]);
    expect(await results).toEqual([{ eventId: "event-1", contractId: "contract-1" }, { eventId: "event-1", contractId: "contract-1" }]);
    expect((await WorkItem.findById(source.workId).lean())?.eventIdentityRecovery).toMatchObject({ eventId: "event-1", source: "assigned_contract" });
    expect(await WorkItem.countDocuments()).toBe(1);
  });

  it("never overwrites a different event chosen concurrently", async () => {
    const source = await seed(); const gates = [deferred<unknown[]>(), deferred<unknown[]>()]; upstream.contracts.mockReturnValueOnce(gates[0].promise).mockReturnValueOnce(gates[1].promise);
    const results = Promise.allSettled([run(source), run(source)]); await vi.waitFor(() => expect(upstream.contracts).toHaveBeenCalledTimes(2));
    gates[0].resolve([assigned(source, "event-1")]); gates[1].resolve([assigned(source, "event-2")]);
    const outcomes = await results; expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((item) => item.status === "rejected") as PromiseRejectedResult; expect(failure.reason).toMatchObject(changedError);
    const saved = await WorkItem.findById(source.workId).lean(); expect(saved?.contract.eventId).toBe(saved?.eventIdentityRecovery?.eventId);
  });

  it("does not overwrite an unrelated concurrent work-item correction or freeze", async () => {
    const source = await seed(); const gate = deferred<unknown[]>(); upstream.contracts.mockReturnValue(gate.promise);
    const result = run(source).catch((error: unknown) => error); await vi.waitFor(() => expect(upstream.contracts).toHaveBeenCalledTimes(1));
    await WorkItem.collection.updateOne({ _id: source.workId }, { $set: { "contract.eventId": "manual-event", "delivery.status": "queued", updatedAt: new Date() } }); gate.resolve([assigned(source)]);
    expect(await result).toMatchObject(changedError); expect((await WorkItem.findById(source.workId).lean())?.contract.eventId).toBe("manual-event");
  });

  it.each(["claim-owner", "assignment", "link", "source"])("rejects a concurrent work-item %s change without correcting event metadata", async (kind) => {
    const source = await seed(); const gate = deferred<unknown[]>(); upstream.contracts.mockReturnValue(gate.promise);
    const result = run(source).catch((error: unknown) => error); await vi.waitFor(() => expect(upstream.contracts).toHaveBeenCalledTimes(1));
    const update = kind === "claim-owner" ? { claimedBy: new mongoose.Types.ObjectId() }
      : kind === "assignment" ? { assignmentUserId: new mongoose.Types.ObjectId() }
        : kind === "link" ? { linkedReportId: new mongoose.Types.ObjectId() } : { source: "legacy" };
    await WorkItem.collection.updateOne({ _id: source.workId }, { $set: update }); gate.resolve([assigned(source)]);
    expect(await result).toMatchObject(changedError);
    const saved = await WorkItem.collection.findOne({ _id: source.workId }); expect(saved?.contract.eventId).toBeUndefined(); expect(saved).toMatchObject(update);
  });
});
