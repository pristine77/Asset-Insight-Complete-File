import { createHash } from "node:crypto";
import { Types } from "mongoose";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import AuctioneerLotNumberLedger from "../models/auctioneerLotNumberLedger.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import { enforceLotDamageAnalysisPolicy, parseLotNumberNumericPortion } from "../utils/lotDamagePolicy.js";
import { getAuctioneer2ConfigStatus, getContractLots } from "./auctioneer2Client.js";
import { recoverInitialAuctioneerEventIdentity } from "./auctioneerEventResolutionService.js";
import { normalizeAuctioneerEventId } from "../utils/auctioneerEventIdentity.js";

const MAX_EVENT_ALLOCATIONS = 50_000;
const MAX_CAS_ATTEMPTS = 64;

export class AuctioneerLotNumberAllocationError extends Error {
  readonly statusCode = 409;
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AuctioneerLotNumberAllocationError";
  }
}

const text = (value: unknown): string => String(value ?? "").trim();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function lotNumber(value: unknown): unknown {
  if (!record(value)) return undefined;
  const source = record(value.lot) ? value.lot : value;
  return [source.lot_number, source.lotNumber, source.number].find((entry) => text(entry));
}

function numericHighWater(values: unknown[]): bigint {
  return values.reduce<bigint>((highest, value) => {
    const number = parseLotNumberNumericPortion(value);
    return number !== null && number > highest ? number : highest;
  }, 0n);
}

function valuesInLots(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map(lotNumber) : [];
}

function sourceDisplayNumber(source: any): string | undefined {
  const value = source?.lotNumber ?? source?.lot_number;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) return undefined;
  const number = text(value);
  // Auctioneer's LOT-#### placeholder is not an assigned auction number.
  // Its real display numbers are strings; do not discard a valid prefix like A12.
  return number && !/^LOT-\d+$/i.test(number) ? number : undefined;
}

function withResolvedFallback(lot: any, number: string, source: "event_sequence" | "source_snapshot"): any {
  const diagnostic = lot?.analysis_metadata?.bundle_lot_number_detection;
  return enforceLotDamageAnalysisPolicy({
    ...lot,
    lot_number: number,
    analysis_metadata: {
      ...(lot?.analysis_metadata || {}),
      ...(diagnostic?.numberSource === "sequential_fallback"
        ? { bundle_lot_number_detection: { ...diagnostic, resolvedLotNumber: number } }
        : {}),
      auctioneer_lot_number: { version: 1, source, number },
    },
  });
}

/** Only number fields are loaded: never hydrate report photos or queued payloads. */
async function localEventNumbers(eventId: string, excludeReportId: Types.ObjectId): Promise<unknown[]> {
  const workItems = await AuctioneerWorkItem.find({ "contract.eventId": eventId })
    .select({
      linkedReportId: 1,
      linkedReportModel: 1,
      "snapshot.lots.lotNumber": 1,
      "delivery.manifest.previewData.lots.lot_number": 1,
      "delivery.manifest.previewData.lots.lotNumber": 1,
    })
    .lean();
  const values: unknown[] = [];
  const assetIds: Types.ObjectId[] = [];
  const listingIds: Types.ObjectId[] = [];
  for (const item of workItems) {
    values.push(...valuesInLots(item.snapshot?.lots));
    values.push(...valuesInLots((item.delivery?.manifest as any)?.previewData?.lots));
    if (!item.linkedReportId || String(item.linkedReportId) === String(excludeReportId)) continue;
    if (item.linkedReportModel === "AssetReport") assetIds.push(item.linkedReportId);
    if (item.linkedReportModel === "LotListing") listingIds.push(item.linkedReportId);
  }
  const projection = {
    "lots.lot_number": 1,
    "lots.lotNumber": 1,
    "preview_data.lots.lot_number": 1,
    "preview_data.lots.lotNumber": 1,
  };
  // Include pending and archived reports conservatively. Their numbers may
  // already exist upstream; deleting a local report never releases a number.
  const [assets, listings] = await Promise.all([
    assetIds.length ? AssetReport.find({ _id: { $in: assetIds } }).select(projection).lean() : [],
    listingIds.length ? LotListing.find({ _id: { $in: listingIds } }).select(projection).lean() : [],
  ]);
  for (const report of [...assets, ...listings]) {
    values.push(...valuesInLots(report.lots));
    values.push(...valuesInLots((report.preview_data as any)?.lots));
  }
  return values;
}

function allocationKey(workId: string, reportId: string, lot: any, index: number): string {
  const stableLotKey = text(lot?.auctioneer_source_key) || text(lot?.lot_id) || `position:${index}`;
  return hash(JSON.stringify([workId, reportId, stableLotKey]));
}

/** A resumed initial job must not replace previously saved/reviewed identities. */
function restoreSavedNumbers(lots: any[], savedLots: any[]): any[] {
  const fail = () => new AuctioneerLotNumberAllocationError(
    "The saved preview's lot mapping changed. Reopen the saved preview and generate files from its reviewed data instead of restarting analysis.",
    "auctioneer_saved_lot_mapping_changed",
  );
  if (lots.length !== savedLots.length) throw fail();
  const identity = (lot: any) => text(lot?.auctioneer_source_key) || text(lot?.lot_id);
  const byIdentity = new Map<string, any>();
  for (const lot of savedLots) {
    const key = identity(lot);
    if (!key) continue;
    if (byIdentity.has(key)) throw fail();
    byIdentity.set(key, lot);
  }
  const used = new Set<any>();
  return lots.map((lot, index) => {
    const key = identity(lot);
    const saved = (key && byIdentity.get(key)) || (!identity(savedLots[index]) ? savedLots[index] : undefined);
    if (!saved || used.has(saved)) throw fail();
    used.add(saved);
    const number = Object.prototype.hasOwnProperty.call(saved, "lot_number")
      ? saved.lot_number : saved.lotNumber;
    // A deliberately cleared number must not be filled by later normalization
    // (or revived from a stale camel-case alias). Require reviewed-data recovery.
    if ((typeof number === "string" && !number.trim())
      || (typeof number !== "string" && (typeof number !== "number" || !Number.isFinite(number)))) throw fail();
    const diagnostic = saved.analysis_metadata?.bundle_lot_number_detection || lot?.analysis_metadata?.bundle_lot_number_detection;
    return enforceLotDamageAnalysisPolicy({
      ...lot,
      lot_number: number,
      analysis_metadata: {
        ...(lot.analysis_metadata || {}),
        ...(diagnostic ? { bundle_lot_number_detection: { ...diagnostic, resolvedLotNumber: number } } : {}),
        auctioneer_lot_number: { version: 1, source: "saved_preview", number },
      },
    });
  });
}

/**
 * Initial preview only. The caller identifies proven automatic fallbacks,
 * never guesses that an explicit "1" is automatic. This does not renumber an
 * existing preview, manual/sticker value or immutable delivery manifest.
 *
 * The local event ledger prevents concurrent Asset Insight runs from sharing
 * automatic numbers. The contract read cannot reserve numbers against remote
 * users or unknown contracts in the event; Auctioneer's final 409 remains the
 * authority and must never be hidden or automatically resolved by renumbering.
 */
export async function allocateInitialAuctioneerLotNumbers(input: {
  reportId: unknown;
  reportType: "asset" | "lotListing";
  lots: any[];
  fallbackIndexes: readonly number[];
  assertOwned?: () => Promise<void>;
}): Promise<any[]> {
  if (!Types.ObjectId.isValid(text(input.reportId)) || !Array.isArray(input.lots)) return input.lots;
  const reportId = new Types.ObjectId(text(input.reportId));
  const candidates = [...new Set(input.fallbackIndexes)].sort((a, b) => a - b);
  if (candidates.some((index) => !Number.isInteger(index) || index < 0 || index >= input.lots.length || !record(input.lots[index]))) {
    throw new AuctioneerLotNumberAllocationError("Lot numbering could not verify the initial lot mapping. Retry the saved report.", "auctioneer_lot_mapping_invalid");
  }
  const linkedReportModel = input.reportType === "asset" ? "AssetReport" : "LotListing";
  const work = await AuctioneerWorkItem.findOne({ linkedReportId: reportId, linkedReportModel })
    .select("_id kind contract.id contract.eventId snapshot.lots.sourceKey snapshot.lots.lotNumber delivery.status delivery.manifest.reportId")
    .lean();
  if (!work) return input.lots;
  // A retry of file generation/delivery cannot opt an old snapshot into allocation.
  if (work.delivery?.manifest || ["queued", "sending", "sent"].includes(work.delivery?.status)) return input.lots;
  const identityFilter = { _id: reportId };
  const projection = "auctioneerWorkItem adminArchivedAt preview_data.lots.lot_number preview_data.lots.lotNumber preview_data.lots.lot_id preview_data.lots.auctioneer_source_key preview_data.lots.analysis_metadata.bundle_lot_number_detection";
  const report = input.reportType === "asset"
    ? await AssetReport.findOne(identityFilter).select(projection).lean()
    : await LotListing.findOne(identityFilter).select(projection).lean();
  if (!report || report.adminArchivedAt || (report.auctioneerWorkItem && String(report.auctioneerWorkItem) !== String(work._id))) {
    throw new AuctioneerLotNumberAllocationError("Lot numbering could not verify the imported report. Reopen the saved report before retrying.", "auctioneer_lot_report_mismatch");
  }
  const savedLots = (report.preview_data as any)?.lots;
  if (Array.isArray(savedLots) && savedLots.length) {
    await input.assertOwned?.();
    return restoreSavedNumbers(input.lots, savedLots);
  }
  const sourceLots = Array.isArray(work.snapshot?.lots) ? work.snapshot.lots : [];
  const sourceByKey = new Map(sourceLots.map((source) => [text(source.sourceKey), source]));
  let lots = input.lots;
  const toAllocate = candidates.filter((index) => {
    if (work.kind !== "scheduleA") return true;
    if (text(input.lots[index]?.auctioneer_source_parent_key)) return true;
    const requestedKey = text(input.lots[index]?.auctioneer_source_key);
    const source = (requestedKey ? sourceByKey.get(requestedKey) : undefined) || sourceLots[index];
    const number = sourceDisplayNumber(source);
    if (!number) return true;
    if (lots === input.lots) lots = input.lots.slice();
    lots[index] = withResolvedFallback(input.lots[index], number, "source_snapshot");
    return false;
  });
  let eventId = normalizeAuctioneerEventId(work.contract?.eventId);
  let contractId = normalizeAuctioneerEventId(work.contract?.id);
  if (!eventId || !contractId) {
    if (!toAllocate.length) return lots;
    ({ eventId, contractId } = await recoverInitialAuctioneerEventIdentity(input));
  }
  await input.assertOwned?.();
  const [remoteLots, localNumbers] = toAllocate.length
    ? await Promise.all([getContractLots(contractId), localEventNumbers(eventId, reportId)])
    : [[], []];
  await input.assertOwned?.();
  const candidatesSet = new Set(toAllocate);
  const explicitNumbers = lots.filter((_lot, index) => !candidatesSet.has(index)).map(lotNumber);
  const observedHighWater = numericHighWater([...valuesInLots(remoteLots), ...localNumbers, ...explicitNumbers]);
  if (!toAllocate.length && observedHighWater === 0n) return lots;
  const keys = toAllocate.map((index) => allocationKey(String(work._id), String(reportId), lots[index], index));
  if (new Set(keys).size !== keys.length) {
    throw new AuctioneerLotNumberAllocationError("Lot numbering found repeated source identifiers. Review the saved lot grouping before retrying.", "auctioneer_lot_mapping_invalid");
  }
  const baseUrl = getAuctioneer2ConfigStatus().baseUrl;
  if (!baseUrl) {
    if (!toAllocate.length) return lots;
    throw new AuctioneerLotNumberAllocationError("Auctioneer configuration is required before lot numbers can be assigned.", "auctioneer_lot_configuration_required");
  }
  const ledgerId = hash(JSON.stringify([baseUrl, eventId]));
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    await input.assertOwned?.();
    const saved = await AuctioneerLotNumberLedger.findById(ledgerId).lean();
    const allocations = { ...(saved?.allocations || {}) };
    let highWater = numericHighWater([saved?.highWater, observedHighWater.toString()]);
    for (const key of keys) {
      if (!allocations[key]) {
        highWater += 1n;
        allocations[key] = String(highWater);
      }
    }
    if (Object.keys(allocations).length > MAX_EVENT_ALLOCATIONS) {
      throw new AuctioneerLotNumberAllocationError("This auction's automatic lot-number capacity has been reached. Contact support before creating more lots.", "auctioneer_lot_capacity_reached");
    }
    try {
      const savedNext = saved
        ? await AuctioneerLotNumberLedger.updateOne(
            { _id: ledgerId, revision: saved.revision },
            { $set: { highWater: String(highWater), allocations }, $inc: { revision: 1 } },
          )
        : await AuctioneerLotNumberLedger.create({ _id: ledgerId, revision: 1, highWater: String(highWater), allocations });
      if (saved && !("modifiedCount" in savedNext && savedNext.modifiedCount === 1)) continue;
      await input.assertOwned?.();
      const numbers = new Map(toAllocate.map((index, position) => [index, allocations[keys[position]!]]));
      return lots.map((lot, index) => {
        const number = numbers.get(index);
        if (!number) return lot;
        return withResolvedFallback(lot, number, "event_sequence");
      });
    } catch (error) {
      if ((error as any)?.code === 11000) continue;
      throw error;
    }
  }
  throw new AuctioneerLotNumberAllocationError("Lot numbering is busy for this auction. Retry the saved report; no additional report is needed.", "auctioneer_lot_allocation_busy");
}
