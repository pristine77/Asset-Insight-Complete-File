/**
 * Lots Auctioneer 2.0 sends before they have a sale (owner, 2026-11-05, on
 * its Bank/Corporate Board: "Allow push to Asset Insight without a sale
 * event. Yes, only from this board").
 *
 * Auctioneer 2.0 marks such a task saleEventPending. Asset Insight does the
 * condition report without an event lot number and never sends a number back:
 * Auctioneer 2.0 numbers the lot when it assigns the sale. Everything else
 * keeps the event check.
 */
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
const upstream = vi.hoisted(() => ({ lots: vi.fn(), config: vi.fn(), contracts: vi.fn() }));
vi.mock("../src/service/auctioneer2Client.js", () => ({
  getContractLots: upstream.lots,
  getAuctioneer2ConfigStatus: upstream.config,
  listIncomingContracts: upstream.contracts,
}));

import WorkItem from "../src/models/auctioneerWorkItem.model.js";
import Asset from "../src/models/asset.model.js";
import { allocateInitialAuctioneerLotNumbers as allocate } from "../src/service/auctioneerLotNumberAllocationService.js";
import { isSaleEventPendingWorkItem, markSaleEventPending, taskIsSaleEventPending } from "../src/service/auctioneerSaleEventPending.js";

let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  vi.clearAllMocks();
  upstream.lots.mockResolvedValue([]);
  upstream.contracts.mockResolvedValue([]);
  upstream.config.mockReturnValue({ baseUrl: "https://auctioneer.example/api/external" });
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const pendingTask = { saleEventPending: true, lot: { id: "a2-lot-1", eventId: null, saleEventPending: true, lotNumber: "LOT-0042" } };

async function seed(input: { tasks?: unknown[]; kind?: "scheduleA" | "unknown"; eventId?: string; sourceNumber?: string } = {}) {
  const reportId = new mongoose.Types.ObjectId();
  const workId = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();
  await WorkItem.collection.insertOne({
    _id: workId, source: "auctioneer2", linkedReportId: reportId, linkedReportModel: "AssetReport",
    cycleKey: `test-${workId}`, clientSubmissionId: `test-${workId}`, selectedReportType: "asset", claimedBy: owner,
    contract: { id: "contract-bank", contractNo: "825790", eventId: input.eventId ?? "" },
    kind: input.kind ?? "scheduleA",
    snapshot: { tasks: input.tasks ?? [pendingTask], lots: [{ sourceKey: "src-1", lotId: "a2-lot-1", lotNumber: input.sourceNumber ?? "LOT-0042" }] },
    delivery: { status: "not_ready" },
  });
  await Asset.collection.insertOne({ _id: reportId, user: owner, auctioneerWorkItem: workId, status: "processing", lots: [] });
  return { reportId };
}

const capturedLot = () => ({
  lot_id: "one", auctioneer_source_key: "src-1", lot_number: "1",
  image_urls: ["https://assetinsight.test/a.jpg"], cover_index: 0, description: "Bank lot, condition report only.",
  analysis_metadata: { bundle_lot_number_detection: { numberSource: "sequential_fallback", resolvedLotNumber: "1", selectedImageLimit: 100 } },
});

describe("which work is sale-pending", () => {
  const work = (extra: Record<string, unknown> = {}) => ({ source: "auctioneer2", kind: "scheduleA", contract: { eventId: "" }, snapshot: { tasks: [pendingTask] }, ...extra });

  it("an Auctioneer one-lot task with no event, every task flagged", () => {
    expect(isSaleEventPendingWorkItem(work())).toBe(true);
    expect(taskIsSaleEventPending({ lot: { saleEventPending: true } })).toBe(true);
  });

  it("never ordinary work: an event, an Unknown contract, no flag, a mixed set or no tasks", () => {
    expect(isSaleEventPendingWorkItem(work({ contract: { eventId: "event-9" } }))).toBe(false);
    expect(isSaleEventPendingWorkItem(work({ kind: "unknown" }))).toBe(false);
    expect(isSaleEventPendingWorkItem(work({ snapshot: { tasks: [{ lot: { id: "x" } }] } }))).toBe(false);
    expect(isSaleEventPendingWorkItem(work({ snapshot: { tasks: [pendingTask, { lot: { id: "x" } }] } }))).toBe(false);
    expect(isSaleEventPendingWorkItem(work({ snapshot: { tasks: [] } }))).toBe(false);
    expect(isSaleEventPendingWorkItem(null)).toBe(false);
  });

  it("marks a lot without changing its number", () => {
    const marked = markSaleEventPending({ lot_number: "1", analysis_metadata: { kept: true } });
    expect(marked.lot_number).toBe("1");
    expect(marked.analysis_metadata).toEqual({ kept: true, auctioneer_lot_number: { version: 1, source: "sale_event_pending" } });
  });
});

describe.sequential("numbering a sale-pending lot", () => {
  it("gives no event number and does not ask for the event", async () => {
    const { reportId } = await seed();
    const lots = await allocate({ reportId, reportType: "asset", lots: [capturedLot()], fallbackIndexes: [0] });
    expect(lots[0].lot_number).toBe("1");
    expect(lots[0].analysis_metadata.auctioneer_lot_number).toEqual({ version: 1, source: "sale_event_pending" });
    expect(upstream.contracts).not.toHaveBeenCalled();
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it("keeps Auctioneer's own real number when it has one, as before", async () => {
    const { reportId } = await seed({ sourceNumber: "0123" });
    const lots = await allocate({ reportId, reportType: "asset", lots: [capturedLot()], fallbackIndexes: [0] });
    expect(lots[0].lot_number).toBe("0123");
  });

  it("the same lot without the flag still needs the event", async () => {
    const { reportId } = await seed({ tasks: [{ lot: { id: "a2-lot-1", eventId: null } }] });
    await expect(allocate({ reportId, reportType: "asset", lots: [capturedLot()], fallbackIndexes: [0] }))
      .rejects.toMatchObject({ code: "auctioneer_lot_event_required" });
  });

  it("a split lot (a new Auctioneer lot) still needs the event", async () => {
    const { reportId } = await seed();
    const split = { ...capturedLot(), lot_id: "two", auctioneer_source_parent_key: "src-1" };
    await expect(allocate({ reportId, reportType: "asset", lots: [split], fallbackIndexes: [0] }))
      .rejects.toMatchObject({ code: "auctioneer_lot_event_required" });
  });
});
