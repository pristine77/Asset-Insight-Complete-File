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
import Ledger from "../src/models/auctioneerLotNumberLedger.model.js";
import Asset from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import { allocateInitialAuctioneerLotNumbers as allocate } from "../src/service/auctioneerLotNumberAllocationService.js";

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  vi.clearAllMocks();
  upstream.lots.mockResolvedValue([]);
  upstream.contracts.mockResolvedValue([]);
  upstream.config.mockReturnValue({ baseUrl: "https://auctioneer.example/api/external" });
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

async function seed(input: { type?: "asset" | "lotListing"; eventId?: string; contractId?: string; lots?: any[]; previewLots?: any[]; sourceLots?: any[]; manifest?: any; status?: string; kind?: "unknown" | "scheduleA" } = {}) {
  const type = input.type || "asset";
  const reportId = new mongoose.Types.ObjectId();
  const workId = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();
  await WorkItem.collection.insertOne({
    _id: workId, source: "auctioneer2", linkedReportId: reportId,
    cycleKey: `test-${workId}`, clientSubmissionId: `test-${workId}`,
    linkedReportModel: type === "asset" ? "AssetReport" : "LotListing",
    selectedReportType: type, claimedBy: owner,
    contract: { id: input.contractId || "contract-1", contractNo: "93530", eventId: input.eventId ?? "event-1" },
    kind: input.kind || "unknown", snapshot: { lots: input.sourceLots || [] },
    delivery: { status: input.status || "not_ready", ...(input.manifest ? { manifest: input.manifest } : {}) },
  });
  const Model = type === "asset" ? Asset : LotListing;
  await Model.collection.insertOne({
    _id: reportId, user: owner, auctioneerWorkItem: workId, status: "processing",
    lots: input.lots || [], ...(input.previewLots ? { preview_data: { lots: input.previewLots } } : {}),
  });
  return { reportId, workId, type, Model };
}

const fallbackLot = (key = "one", value: string | null = "1") => ({
  lot_id: key, auctioneer_source_key: key, lot_number: value,
  image_urls: ["https://assetinsight.test/first.jpg", "https://assetinsight.test/last.jpg"],
  cover_index: 1, description: "Keep all submitted details.",
  analysis_metadata: { bundle_lot_number_detection: { numberSource: "sequential_fallback", resolvedLotNumber: value, selectedImageLimit: 100 } },
});
const run = (source: Awaited<ReturnType<typeof seed>>, lots = [fallbackLot()], indexes: number[] = lots.map((_lot, index) => index)) =>
  allocate({ reportId: source.reportId, reportType: source.type, lots, fallbackIndexes: indexes });

describe.sequential("initial Auctioneer lot-number allocation", () => {
  it.each(["asset", "lotListing"] as const)("gives a %s split its own event number", async (type) => {
    const source = await seed({ type, kind: "scheduleA", sourceLots: [
      { sourceKey: "parent", lotId: "upstream-parent", lotNumber: "100", raw: {} },
    ] });
    const lots = [fallbackLot("parent"), { ...fallbackLot("split"), auctioneer_source_parent_key: "parent" }];
    const result = await run(source, lots);
    expect(result.map(lot => lot.lot_number)).toEqual(["100", "101"]);
    expect((await run(source, lots)).map(lot => lot.lot_number)).toEqual(["100", "101"]);
  });
  it.each(["asset", "lotListing"] as const)("starts %s after upstream lots without changing report/media snapshots", async (type) => {
    upstream.lots.mockResolvedValue([{ lotNumber: "11" }, { lot: { lot_number: "0012A" } }]);
    const source = await seed({ type });
    const lots = [fallbackLot("a"), fallbackLot("b")];
    const before = structuredClone(lots);
    const result = await run(source, lots);
    expect(result.map((lot) => lot.lot_number)).toEqual(["13", "14"]);
    expect(result[0].analysis_metadata.bundle_lot_number_detection.resolvedLotNumber).toBe("13");
    expect(result[0].image_urls).toEqual(before[0].image_urls);
    expect(result[0].cover_index).toBe(1);
    expect(lots).toEqual(before);
    expect((await source.Model.findById(source.reportId).lean())?.lots).toEqual([]);
    expect(upstream.lots).toHaveBeenCalledWith("contract-1");
  });

  it("reserves distinct numbers for concurrent reports across Asset/Lot and different contracts in the event", async () => {
    const sources = await Promise.all(Array.from({ length: 12 }, (_value, index) => seed({ type: index % 2 ? "asset" : "lotListing", contractId: `contract-${index}` })));
    const results = await Promise.all(sources.map((source) => run(source, [fallbackLot("a"), fallbackLot("b")])));
    const numbers = results.flat().map((lot) => Number(lot.lot_number));
    expect(new Set(numbers).size).toBe(24);
    expect(numbers.sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_value, index) => index + 1));
    expect(await Ledger.countDocuments()).toBe(1);
  });

  it("same-report concurrent retries and restarted workers reuse durable allocations", async () => {
    const source = await seed();
    const results = await Promise.all(Array.from({ length: 8 }, () => run(source)));
    expect(results.every((lots) => lots[0].lot_number === "1")).toBe(true);
    upstream.lots.mockResolvedValue([{ lotNumber: "999" }]);
    expect((await run(source))[0].lot_number).toBe("1");
    expect((await run(await seed()))[0].lot_number).toBe("1000");
  });

  it("observes pending reports, canonical source snapshots and immutable manifests across all users and report types", async () => {
    await seed({ type: "asset", lots: [{ lot_number: "13" }], contractId: "other-1" });
    await seed({ type: "lotListing", previewLots: [{ lot_number: "25" }], contractId: "other-2" });
    await seed({ sourceLots: [{ lotNumber: "1,000A" }], contractId: "other-3" });
    await seed({ status: "sent", manifest: { reportId: "old", previewData: { lots: [{ lot_number: "1001" }] } }, contractId: "other-4" });
    expect((await run(await seed()))[0].lot_number).toBe("1002");
  });

  it("does not let another event's reports affect this event or prevent reused numbers", async () => {
    const first = await seed({ eventId: "event-1", lots: [{ lot_number: "4500" }] });
    const second = await seed({ eventId: "event-2" });
    expect((await run(first))[0].lot_number).toBe("1");
    expect((await run(second))[0].lot_number).toBe("1");
    expect(await Ledger.countDocuments()).toBe(2);
  });

  it("preserves explicit numbers, including a literal 1, stickers, suffixes and unknown identifiers", async () => {
    const source = await seed();
    const explicit = [
      { lot_number: "1", description: "Manual" },
      { lot_number: "157", analysis_metadata: { bundle_lot_number_detection: { numberSource: "first_main_photo", detectedValue: "157", resolvedLotNumber: "157" } } },
      { lot_number: "0199A" }, { lot_number: "special" },
    ];
    const lots = [...explicit, fallbackLot("auto")];
    const result = await run(source, lots, [4]);
    expect(result.slice(0, 4)).toEqual(explicit);
    expect(result[4].lot_number).toBe("200");
  });

  it("restores canonical Schedule A numbers by source key before assigning any automatic numbers", async () => {
    const source = await seed({ kind: "scheduleA", sourceLots: [{ sourceKey: "a", lotNumber: "0500A" }, { sourceKey: "b", lotNumber: "11" }] });
    const result = await run(source, [fallbackLot("b"), fallbackLot("a")]);
    expect(result.map((lot) => lot.lot_number)).toEqual(["11", "0500A"]);
    expect(result[0].analysis_metadata.bundle_lot_number_detection.resolvedLotNumber).toBe("11");
    expect(result[0].analysis_metadata.auctioneer_lot_number.source).toBe("source_snapshot");
    expect(upstream.lots).not.toHaveBeenCalled();
    expect((await run(await seed()))[0].lot_number).toBe("501");
  });

  it("supports legacy positional Schedule A mapping, but never treats LOT-#### as an assigned number", async () => {
    const source = await seed({ kind: "scheduleA", sourceLots: [{ sourceKey: "source-a", lotNumber: "18" }, { sourceKey: "source-b", lotNumber: "LOT-200" }] });
    const result = await run(source, [fallbackLot("local-a"), fallbackLot("local-b")]);
    expect(result.map((lot) => lot.lot_number)).toEqual(["18", "201"]);
    expect(result[0].analysis_metadata.auctioneer_lot_number.source).toBe("source_snapshot");
    expect(result[1].analysis_metadata.auctioneer_lot_number.source).toBe("event_sequence");
  });

  it("does not overwrite explicit/manual values with Schedule A values", async () => {
    const source = await seed({ kind: "scheduleA", sourceLots: [{ sourceKey: "a", lotNumber: "18" }] });
    const lots = [{ ...fallbackLot("a"), lot_number: "157" }];
    expect(await run(source, lots, [])).toEqual(lots);
    expect(upstream.lots).not.toHaveBeenCalled();
    expect((await run(await seed()))[0].lot_number).toBe("158");
  });

  it("retains a real prefixed Schedule A display number rather than inventing a replacement", async () => {
    const source = await seed({ kind: "scheduleA", sourceLots: [{ sourceKey: "a", lotNumber: " A12 " }] });
    expect((await run(source, [fallbackLot("a")]))[0].lot_number).toBe("A12");
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it("permits fully explicit or canonical numbers without a known event but never allocates", async () => {
    const explicit = await seed({ eventId: "" });
    const source = await seed({ eventId: "", kind: "scheduleA", sourceLots: [{ sourceKey: "a", lotNumber: "18" }] });
    expect((await run(explicit, [fallbackLot("a", "157")], []))[0].lot_number).toBe("157");
    expect((await run(source, [fallbackLot("a")]))[0].lot_number).toBe("18");
    expect(await Ledger.countDocuments()).toBe(0);
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it("enforces damage eligibility at allocated numbers above 1000 without touching original media", async () => {
    upstream.lots.mockResolvedValue([{ lotNumber: "1000" }]);
    const result = await run(await seed(), [{ ...fallbackLot(), damage_analysis: "Damage", items: [{ damage_analysis: "Nested damage" }] }]);
    expect(result[0]).toMatchObject({ lot_number: "1001", damage_analysis: null, items: [{ damage_analysis: null }] });
    expect(result[0].image_urls).toHaveLength(2);
  });

  it("does not allocate nonimport reports, missing IDs or empty candidate sets", async () => {
    const lots = [fallbackLot()];
    expect(await allocate({ reportId: new mongoose.Types.ObjectId(), reportType: "asset", lots, fallbackIndexes: [0] })).toBe(lots);
    expect(await allocate({ reportId: "invalid", reportType: "asset", lots, fallbackIndexes: [0] })).toBe(lots);
    expect(await allocate({ reportId: new mongoose.Types.ObjectId(), reportType: "asset", lots, fallbackIndexes: [] })).toBe(lots);
    expect(upstream.lots).not.toHaveBeenCalled();
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it.each(["queued", "sending", "sent"])("does not renumber %s delivery snapshots", async (status) => {
    const source = await seed({ status });
    const lots = [fallbackLot()];
    expect(await run(source, lots)).toBe(lots);
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it("does not renumber saved previews or failed immutable delivery manifests", async () => {
    const preview = await seed({ previewLots: [{ lot_number: "1" }] });
    const failed = await seed({ status: "failed", manifest: { reportId: "saved", previewData: { lots: [{ lot_number: "1" }] } } });
    const lots = [fallbackLot()];
    expect((await run(preview, lots))[0].lot_number).toBe("1");
    expect(await run(failed, lots)).toBe(lots);
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it("fails closed on unavailable upstream so fallback 1 cannot silently collide", async () => {
    upstream.lots.mockRejectedValue(new Error("Provider unavailable"));
    await expect(run(await seed())).rejects.toThrow("Provider unavailable");
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it("replays saved/manual numbers by stable source key, even after row reordering", async () => {
    const source = await seed({ previewLots: [
      { auctioneer_source_key: "b", lot_number: "00730A" },
      { auctioneer_source_key: "a", lot_number: "13" },
    ] });
    const result = await run(source, [fallbackLot("a"), fallbackLot("b")]);
    expect(result.map((lot) => lot.lot_number)).toEqual(["13", "00730A"]);
    expect(result[1].analysis_metadata.bundle_lot_number_detection.resolvedLotNumber).toBe("00730A");
    expect(result[1].image_urls).toEqual(fallbackLot("b").image_urls);
    expect(upstream.lots).not.toHaveBeenCalled();
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it("fails closed on changed saved mappings instead of overwriting reviewed identities", async () => {
    const source = await seed({ previewLots: [{ auctioneer_source_key: "original", lot_number: "13" }] });
    await expect(run(source)).rejects.toMatchObject({ code: "auctioneer_saved_lot_mapping_changed" });
    await expect(run(source, [fallbackLot("original"), fallbackLot("extra")])).rejects.toMatchObject({ code: "auctioneer_saved_lot_mapping_changed" });
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it.each(["", " ", null])("does not turn a cleared saved number %j into a local fallback or stale alias", async (lot_number) => {
    const source = await seed({ previewLots: [{ auctioneer_source_key: "one", lot_number, lotNumber: "old-number" }] });
    await expect(run(source)).rejects.toMatchObject({ code: "auctioneer_saved_lot_mapping_changed" });
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it.each(["1", 0])("preserves a valid saved manual number %j", async (lot_number) => {
    const source = await seed({ previewLots: [{ auctioneer_source_key: "one", lot_number }] });
    expect((await run(source))[0].lot_number).toBe(lot_number);
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it("replays legacy camel-case numbers only when the canonical property is absent", async () => {
    const source = await seed({ previewLots: [{ auctioneer_source_key: "one", lotNumber: "017A" }] });
    expect((await run(source))[0].lot_number).toBe("017A");
  });

  it("requires an event for automatic numbers", async () => {
    await expect(run(await seed({ eventId: "" }))).rejects.toMatchObject({ code: "auctioneer_lot_event_required" });
    expect(upstream.lots).toHaveBeenCalledWith("contract-1");
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it("rejects missing, archived and mismatched linked reports without reserving numbers", async () => {
    const missing = await seed();
    await missing.Model.collection.deleteOne({ _id: missing.reportId });
    const archived = await seed();
    await archived.Model.collection.updateOne({ _id: archived.reportId }, { $set: { adminArchivedAt: new Date() } });
    const mismatched = await seed();
    await mismatched.Model.collection.updateOne({ _id: mismatched.reportId }, { $set: { auctioneerWorkItem: new mongoose.Types.ObjectId() } });
    for (const source of [missing, archived, mismatched]) {
      await expect(run(source)).rejects.toMatchObject({ code: "auctioneer_lot_report_mismatch" });
    }
    expect(upstream.lots).not.toHaveBeenCalled();
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it("isolates reservation counters between configured Auctioneer environments", async () => {
    const source = await seed();
    expect((await run(source))[0].lot_number).toBe("1");
    upstream.config.mockReturnValue({ baseUrl: "https://another.example/api/external" });
    expect((await run(await seed()))[0].lot_number).toBe("1");
    expect(await Ledger.countDocuments()).toBe(2);
  });

  it("never assumes a contract reference is an auction display lot number", async () => {
    upstream.lots.mockResolvedValue([{ contractLotRef: "AI-9999", rowGuid: "8888" }]);
    expect((await run(await seed()))[0].lot_number).toBe("1");
  });

  it("rejects invalid mapping and repeated source keys instead of sharing a number", async () => {
    const source = await seed();
    await expect(run(source, [fallbackLot()], [2])).rejects.toMatchObject({ code: "auctioneer_lot_mapping_invalid" });
    await expect(run(source, [fallbackLot(), fallbackLot()])).rejects.toMatchObject({ code: "auctioneer_lot_mapping_invalid" });
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it("never allocates after execution ownership has been lost", async () => {
    const source = await seed();
    await expect(allocate({ reportId: source.reportId, reportType: source.type, lots: [fallbackLot()], fallbackIndexes: [0], assertOwned: async () => { throw new Error("Lost execution"); } })).rejects.toThrow("Lost execution");
    expect(await Ledger.countDocuments()).toBe(0);
    expect(upstream.lots).not.toHaveBeenCalled();
  });

  it("preserves a reservation if ownership is lost after CAS, then recovers it on retry", async () => {
    const source = await seed();
    let checks = 0;
    await expect(allocate({ reportId: source.reportId, reportType: source.type, lots: [fallbackLot()], fallbackIndexes: [0], assertOwned: async () => { checks += 1; if (checks === 4) throw new Error("Lost execution"); } })).rejects.toThrow("Lost execution");
    expect((await run(source))[0].lot_number).toBe("1");
    expect((await run(await seed()))[0].lot_number).toBe("2");
  });

  it("does not truncate large numeric labels through JavaScript number precision", async () => {
    upstream.lots.mockResolvedValue([{ lotNumber: "9007199254740993" }]);
    expect((await run(await seed()))[0].lot_number).toBe("9007199254740994");
  });
});
