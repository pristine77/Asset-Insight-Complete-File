/**
 * Maps a completed lot-listing report into Auctionsoft's integration contract. The
 * mapping tolerates legacy field aliases but emits one stable payload. A payload hash
 * suppresses repeats after success is stored; an ambiguous/lost response may be retried.
 */
import crypto from "crypto";
import LotListing from "../models/lotListing.model.js";
import { isReviewReportOwnerId } from "./reviewReportPolicy.js";
import { pushAuctionManagementResult } from "./auctionsoftClient.js";
import {
  isLotDamageAnalysisEligible,
  resolveDamageAnalysisEnabled,
} from "../utils/lotDamagePolicy.js";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function parseAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(clean(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function payloadHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex");
}

type AuctionsoftPushOwnership = {
  filter: Record<string, unknown>;
  assertOwned?: () => Promise<void>;
};

async function saveAuctionsoftState(
  listing: any,
  auctionsoft: Record<string, unknown>,
  ownership?: AuctionsoftPushOwnership
) {
  if (!ownership) {
    listing.auctionsoft = auctionsoft;
    listing.markModified?.("auctionsoft");
    await listing.save();
    return;
  }

  await ownership.assertOwned?.();
  const updated = await LotListing.updateOne(
    { _id: listing._id, ...ownership.filter },
    { $set: { auctionsoft } }
  );
  if (updated.matchedCount !== 1) {
    throw Object.assign(
      new Error("Lot Listing worker ownership changed during Auctionsoft delivery."),
      { code: "REPORT_JOB_OWNERSHIP_LOST" }
    );
  }
  listing.auctionsoft = auctionsoft;
}

function selectServicesForLot(meta: any, lot: any, seedLot: any, index: number): any[] {
  const selections = Array.isArray(meta?.selectedServicesByLot) ? meta.selectedServicesByLot : [];
  const match = selections.find((item: any) =>
    Number(item?.lotIndex) === index ||
    clean(item?.seedLotId) === clean(seedLot?.id) ||
    clean(item?.sourceLotId) === clean(seedLot?.sourceLotId) ||
    clean(item?.lotId) === clean(lot?.lot_id)
  );
  return Array.isArray(match?.selectedServices) ? match.selectedServices : [];
}

function normalizeLot(listing: any, lot: any, seedLot: any, index: number) {
  const imageUrls = Array.isArray(lot?.image_urls) ? lot.image_urls.map(clean).filter(Boolean) : [];
  const extraImageUrls = Array.isArray(lot?.extra_image_urls) ? lot.extra_image_urls.map(clean).filter(Boolean) : [];
  const specs = lot?.condition_report_specs && typeof lot.condition_report_specs === "object"
    ? lot.condition_report_specs
    : undefined;
  const conditionSelections = lot?.condition_report_selections && typeof lot.condition_report_selections === "object"
    ? lot.condition_report_selections
    : undefined;
  const lotNumber = lot?.lot_number ?? seedLot?.lotNumber ?? index + 1;
  const includeDamageAnalysis =
    resolveDamageAnalysisEnabled(listing?.preview_data?.include_damage_analysis, true) &&
    resolveDamageAnalysisEnabled(listing?.include_damage_analysis, true);
  return {
    externalLotId: clean(lot?.lot_id || seedLot?.id || seedLot?.scheduleALotId || seedLot?.sourceLotId || index + 1),
    sourceLotId: clean(seedLot?.sourceLotId) || undefined,
    scheduleALotId: clean(seedLot?.scheduleALotId) || undefined,
    lotNumber,
    title: clean(lot?.title) || clean(seedLot?.description) || `Lot ${index + 1}`,
    description: clean(lot?.description || lot?.title || seedLot?.description),
    details: clean(lot?.details),
    year: clean(lot?.year || seedLot?.year) || undefined,
    make: clean(lot?.make || seedLot?.make) || undefined,
    model: clean(lot?.model || seedLot?.model) || undefined,
    serialNumber: clean(lot?.serial_number || seedLot?.serialNumber) || undefined,
    categories: clean(lot?.categories) || undefined,
    conditionReport: clean(lot?.condition_report) || JSON.stringify({
      specs: specs || null,
      selections: conditionSelections || null,
    }),
    damageAnalysis:
      includeDamageAnalysis && isLotDamageAnalysisEligible(lotNumber)
        ? clean(lot?.damage_analysis) || undefined
        : undefined,
    estimatedValue: parseAmount(lot?.estimated_value),
    reserve: parseAmount(seedLot?.reserve),
    openingBid: parseAmount(lot?.opening_bid),
    bidIncrement: parseAmount(lot?.bid_increment),
    quantity: Number.isFinite(Number(lot?.quantity)) ? Number(lot.quantity) : 1,
    location: clean(lot?.location || listing?.preview_data?.location || listing?.location) || undefined,
    latitude: lot?.latitude ?? listing?.preview_data?.latitude,
    longitude: lot?.longitude ?? listing?.preview_data?.longitude,
    imageUrls,
    extraImageUrls,
    raw: lot,
  };
}

function buildAuctionsoftPayload(listing: any) {
  const meta = listing?.auctionsoft || {};
  const lots = Array.isArray(listing?.preview_data?.lots)
    ? listing.preview_data.lots
    : Array.isArray(listing?.lots)
      ? listing.lots
      : [];
  const seedLots = Array.isArray(meta?.seedLots) ? meta.seedLots : [];
  return {
    reportId: String(listing?._id || ""),
    jobId: clean(listing?.job_id) || undefined,
    destination: meta?.destination === "OpToDoBoard" ? "OpToDoBoard" : "LottingBoard",
    closeContract: meta?.closeContract === true,
    submittedBy: clean(meta?.submittedBy) || "ClearValue mobile",
    lots: lots.map((lot: any, index: number) => {
      const seedLot = seedLots[index] || {};
      return {
        ...normalizeLot(listing, lot, seedLot, index),
        selectedServices: selectServicesForLot(meta, lot, seedLot, index),
      };
    }),
  };
}

export async function pushAuctionsoftLotListingIfReady(
  listing: any,
  options: { ownership?: AuctionsoftPushOwnership } = {}
) {
  if (listing?.auctioneerWorkItem) return;
  const meta = listing?.auctionsoft || {};
  if (!meta?.taskId) return;
  const ownerId = String(listing?.user?._id || listing?.user || "");
  if (await isReviewReportOwnerId(ownerId)) return;
  if (!["preview", "pending_approval", "approved", "completed"].includes(String(listing?.status || ""))) return;

  const payload = buildAuctionsoftPayload(listing);
  const hash = payloadHash(payload);
  if (meta.pushStatus === "success" && meta.lastPayloadHash === hash) return;

  await saveAuctionsoftState(listing, {
    ...meta,
    pushStatus: "pushing",
    pushAttempts: Number(meta.pushAttempts || 0) + 1,
    lastError: undefined,
  }, options.ownership);

  try {
    await options.ownership?.assertOwned?.();
    await pushAuctionManagementResult(String(meta.taskId), payload);
    await saveAuctionsoftState(listing, {
      ...listing.auctionsoft,
      pushStatus: "success",
      pushedAt: new Date(),
      lastPayloadHash: hash,
      lastError: undefined,
    }, options.ownership);
  } catch (error) {
    await saveAuctionsoftState(listing, {
      ...listing.auctionsoft,
      pushStatus: "failed",
      lastError: error instanceof Error ? error.message : String(error),
    }, options.ownership).catch((saveError) => {
      if ((saveError as any)?.code === "REPORT_JOB_OWNERSHIP_LOST") return;
      throw saveError;
    });
    throw error;
  }
}
