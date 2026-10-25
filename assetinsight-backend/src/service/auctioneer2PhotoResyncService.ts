/**
 * Operator-only recovery for photo bytes that were delivered to the wrong
 * Auctioneer storage environment. This service deliberately bypasses the
 * normal delivery state machine: it reads sent checkpoints, uploads photos,
 * and never mutates the work item, report, lot lifecycle, or condition report.
 */
import { Types } from "mongoose";
import AssetReport from "../models/asset.model.js";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import LotListing from "../models/lotListing.model.js";
import {
  AUCTIONEER2_PHOTO_MAX_BATCH_BYTES,
  AUCTIONEER2_PHOTO_MAX_FILE_BYTES,
  AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST,
  uploadLotPhotos,
  type Auctioneer2Photo,
  type Auctioneer2Record,
} from "./auctioneer2Client.js";
import {
  loadAuctioneerPhoto,
  type AuctioneerPhotoUpload,
} from "./auctioneer2PhotoService.js";
import { createLotPhotoResolver, firstReportImageManifest } from "../utils/lotPhotoOrder.js";

type ResyncWorkItem = Record<string, any>;
type ResyncReport = Record<string, any>;

export type Auctioneer2PhotoResyncDependencies = {
  loadWorkItem: (workItemId: string) => Promise<ResyncWorkItem | null>;
  loadLinkedReport: (workItem: ResyncWorkItem) => Promise<ResyncReport | null>;
  loadPhoto: (
    sourceUrl: string,
    lotIndex: number,
    photoIndex: number
  ) => Promise<AuctioneerPhotoUpload>;
  uploadPhotos: (
    lotId: string,
    photos: Auctioneer2Photo[]
  ) => Promise<Auctioneer2Record>;
};

export type Auctioneer2PhotoResyncLotResult = {
  workItemId: string;
  reportId: string;
  reportType: "asset" | "lotListing";
  lotIndex: number;
  sourceKey: string;
  targetLotId: string;
  photoCount: number;
  batchCount: number;
  decodedBytes: number;
  submittedPhotoCount: number;
  status: "no_photos" | "ready" | "submitted";
};

export type Auctioneer2PhotoResyncSummary = {
  mode: "dry-run" | "execute";
  workItemCount: number;
  lotCount: number;
  photoCount: number;
  batchCount: number;
  decodedBytes: number;
  submittedPhotoCount: number;
  lots: Auctioneer2PhotoResyncLotResult[];
};

export class Auctioneer2PhotoResyncError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "Auctioneer2PhotoResyncError";
    this.code = code;
  }
}

const defaultDependencies: Auctioneer2PhotoResyncDependencies = {
  loadWorkItem: async (workItemId) =>
    AuctioneerWorkItem.findById(workItemId).lean(),
  loadLinkedReport: async (workItem) => {
    if (!workItem.linkedReportId) return null;
    return workItem.selectedReportType === "asset"
      ? AssetReport.findById(workItem.linkedReportId).lean()
      : LotListing.findById(workItem.linkedReportId).lean();
  },
  loadPhoto: loadAuctioneerPhoto,
  uploadPhotos: uploadLotPhotos,
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deliveryPreviewData(
  workItem: ResyncWorkItem,
  report: ResyncReport
): Record<string, any> {
  const manifest = isRecord(workItem.delivery?.manifest)
    ? workItem.delivery.manifest
    : {};
  if (isRecord(manifest.previewData)) return manifest.previewData;
  return isRecord(report.preview_data) ? report.preview_data : {};
}

function finalReportLots(
  workItem: ResyncWorkItem,
  report: ResyncReport
): any[] {
  const previewData = deliveryPreviewData(workItem, report);
  if (Array.isArray(previewData.lots)) return previewData.lots;
  return Array.isArray(report.lots) ? report.lots : [];
}

/**
 * Mirrors the normal delivery photo selection without importing its private
 * state-machine helpers. Order is stable, deleted references are excluded, and
 * a URL can appear only once for the target lot.
 */
export function collectAuctioneer2ResyncPhotoUrls(
  workItem: ResyncWorkItem,
  report: ResyncReport,
  lot: any,
  lotIndex?: number,
): string[] {
  const manifest = workItem.delivery?.manifest;
  if (manifest?.photoOrderVersion === 2) {
    const saved = typeof lotIndex === "number" && Number.isInteger(lotIndex) && lotIndex >= 0 && Array.isArray(manifest.photoUrlsByLot)
      ? manifest.photoUrlsByLot[lotIndex] : undefined;
    if (!Array.isArray(saved) || saved.some((url) => typeof url !== "string" || !url.trim())) {
      throw new Auctioneer2PhotoResyncError(
        "The frozen delivery photo manifest is incomplete. Review it before resyncing photos.",
        "photo_manifest_invalid",
      );
    }
    return [...saved];
  }
  const previewData = deliveryPreviewData(workItem, report);
  // Index fields refer to one ordered report-level array. Do not concatenate or
  // deduplicate candidate arrays before resolving indexes because either action
  // can shift the target position. The frozen delivery preview is authoritative.
  const globalUrls = firstReportImageManifest(
    previewData.imageUrls,
    previewData.image_urls,
    report.imageUrls,
    report.image_urls
  );
  return createLotPhotoResolver(globalUrls, previewData.deleted_image_indexes, previewData.deleted_image_urls)(lot).map((photo) => photo.url);
}

type ResyncLotPlan = {
  workItemId: string;
  reportId: string;
  reportType: "asset" | "lotListing";
  lotIndex: number;
  sourceKey: string;
  targetLotId: string;
  photoUrls: string[];
};

async function buildResyncPlans(
  workItemIds: string[],
  dependencies: Auctioneer2PhotoResyncDependencies
): Promise<ResyncLotPlan[]> {
  const plans: ResyncLotPlan[] = [];

  for (const workItemId of workItemIds) {
    const workItem = await dependencies.loadWorkItem(workItemId);
    if (!workItem) {
      throw new Auctioneer2PhotoResyncError(
        `Auctioneer work item ${workItemId} was not found.`,
        "work_item_not_found"
      );
    }
    if (
      workItem.source !== "auctioneer2" ||
      workItem.status !== "sent" ||
      workItem.delivery?.status !== "sent"
    ) {
      throw new Auctioneer2PhotoResyncError(
        `Auctioneer work item ${workItemId} is not fully sent and cannot be resynced.`,
        "work_item_not_sent"
      );
    }
    const reportId = clean(workItem.linkedReportId);
    if (!reportId) {
      throw new Auctioneer2PhotoResyncError(
        `Auctioneer work item ${workItemId} has no linked report.`,
        "linked_report_missing"
      );
    }
    if (!["asset", "lotListing"].includes(workItem.selectedReportType)) {
      throw new Auctioneer2PhotoResyncError(
        `Auctioneer work item ${workItemId} has an unsupported report type.`,
        "report_type_invalid"
      );
    }

    const report = await dependencies.loadLinkedReport(workItem);
    if (!report) {
      throw new Auctioneer2PhotoResyncError(
        `The linked report for Auctioneer work item ${workItemId} was not found.`,
        "linked_report_not_found"
      );
    }

    const lots = finalReportLots(workItem, report);
    const checkpoints = Array.isArray(workItem.delivery?.lots)
      ? workItem.delivery.lots
      : [];
    if (lots.length === 0 || lots.length !== checkpoints.length) {
      throw new Auctioneer2PhotoResyncError(
        `Auctioneer work item ${workItemId} no longer has an exact sent lot mapping.`,
        "lot_mapping_mismatch"
      );
    }
    const manifest = workItem.delivery?.manifest;
    if (manifest?.photoOrderVersion === 2 && (!Array.isArray(manifest.photoUrlsByLot) || manifest.photoUrlsByLot.length !== lots.length)) {
      throw new Auctioneer2PhotoResyncError(
        "The frozen delivery photo manifest does not match the sent lot positions. Review it before resyncing photos.",
        "photo_manifest_invalid",
      );
    }

    lots.forEach((lot, lotIndex) => {
      const checkpoint = checkpoints[lotIndex];
      const sourceKey = clean(checkpoint?.sourceKey);
      const reportSourceKey = clean(lot?.auctioneer_source_key);
      if (
        checkpoint?.status !== "sent" ||
        !sourceKey ||
        (reportSourceKey && reportSourceKey !== sourceKey)
      ) {
        throw new Auctioneer2PhotoResyncError(
          `Auctioneer work item ${workItemId} has an unsafe lot mapping at position ${lotIndex + 1}.`,
          "lot_mapping_mismatch"
        );
      }
      const targetLotId = clean(
        checkpoint.sourceLotId || checkpoint.createdLotId
      );
      if (!targetLotId) {
        throw new Auctioneer2PhotoResyncError(
          `Auctioneer work item ${workItemId} has no saved target lot ID at position ${lotIndex + 1}.`,
          "target_lot_missing"
        );
      }

      plans.push({
        workItemId,
        reportId,
        reportType: workItem.selectedReportType,
        lotIndex,
        sourceKey,
        targetLotId,
        photoUrls: collectAuctioneer2ResyncPhotoUrls(workItem, report, lot, lotIndex),
      });
    });
  }

  return plans;
}

async function processLotPlan(
  plan: ResyncLotPlan,
  execute: boolean,
  dependencies: Auctioneer2PhotoResyncDependencies
): Promise<Auctioneer2PhotoResyncLotResult> {
  let batch: Auctioneer2Photo[] = [];
  let batchBytes = 0;
  let batchCount = 0;
  let decodedBytes = 0;
  let submittedPhotoCount = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    if (execute) {
      try {
        await dependencies.uploadPhotos(plan.targetLotId, batch);
      } catch {
        throw new Auctioneer2PhotoResyncError(
          `Auctioneer rejected photo batch ${batchCount + 1} for work item ${plan.workItemId}, lot position ${plan.lotIndex + 1}. No delivery state was changed.`,
          "photo_upload_failed"
        );
      }
      submittedPhotoCount += batch.length;
    }
    batchCount += 1;
    batch = [];
    batchBytes = 0;
  };

  for (let photoIndex = 0; photoIndex < plan.photoUrls.length; photoIndex += 1) {
    let photo: AuctioneerPhotoUpload;
    try {
      photo = await dependencies.loadPhoto(
        plan.photoUrls[photoIndex],
        plan.lotIndex,
        photoIndex
      );
    } catch {
      throw new Auctioneer2PhotoResyncError(
        `Unable to prepare photo ${photoIndex + 1} for work item ${plan.workItemId}, lot position ${plan.lotIndex + 1}.`,
        "photo_load_failed"
      );
    }
    const photoBytes = photo.buffer.byteLength;
    if (photoBytes > AUCTIONEER2_PHOTO_MAX_FILE_BYTES) {
      throw new Auctioneer2PhotoResyncError(
        `Auctioneer work item ${plan.workItemId} contains a prepared photo over 20 MB at lot position ${plan.lotIndex + 1}.`,
        "photo_too_large"
      );
    }
    if (
      batch.length >= AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST ||
      (batch.length > 0 &&
        batchBytes + photoBytes > AUCTIONEER2_PHOTO_MAX_BATCH_BYTES)
    ) {
      await flush();
    }
    batch.push({
      buffer: photo.buffer,
      filename: photo.filename,
      contentType: photo.contentType,
      order: photoIndex,
    });
    batchBytes += photoBytes;
    decodedBytes += photoBytes;
  }
  await flush();

  const photoCount = plan.photoUrls.length;
  return {
    workItemId: plan.workItemId,
    reportId: plan.reportId,
    reportType: plan.reportType,
    lotIndex: plan.lotIndex,
    sourceKey: plan.sourceKey,
    targetLotId: plan.targetLotId,
    photoCount,
    batchCount,
    decodedBytes,
    submittedPhotoCount,
    status: photoCount === 0 ? "no_photos" : execute ? "submitted" : "ready",
  };
}

export async function resyncAuctioneer2Photos(
  input: { workItemIds: string[]; execute?: boolean },
  dependencies: Auctioneer2PhotoResyncDependencies = defaultDependencies
): Promise<Auctioneer2PhotoResyncSummary> {
  const requestedIds = Array.isArray(input.workItemIds)
    ? input.workItemIds.map(clean).filter(Boolean)
    : [];
  const workItemIds = Array.from(new Set(requestedIds));
  if (workItemIds.length === 0) {
    throw new Auctioneer2PhotoResyncError(
      "At least one explicit Auctioneer work item ID is required.",
      "work_item_ids_required"
    );
  }
  const invalidId = workItemIds.find((id) => !Types.ObjectId.isValid(id));
  if (invalidId) {
    throw new Auctioneer2PhotoResyncError(
      `Auctioneer work item ID ${invalidId} is invalid.`,
      "work_item_id_invalid"
    );
  }

  // Complete eligibility and mapping preflight for every requested work item
  // before an execute run is allowed to make its first external POST.
  const plans = await buildResyncPlans(workItemIds, dependencies);
  const execute = input.execute === true;
  const lots: Auctioneer2PhotoResyncLotResult[] = [];
  for (const plan of plans) {
    lots.push(await processLotPlan(plan, execute, dependencies));
  }

  return {
    mode: execute ? "execute" : "dry-run",
    workItemCount: workItemIds.length,
    lotCount: lots.length,
    photoCount: lots.reduce((sum, lot) => sum + lot.photoCount, 0),
    batchCount: lots.reduce((sum, lot) => sum + lot.batchCount, 0),
    decodedBytes: lots.reduce((sum, lot) => sum + lot.decodedBytes, 0),
    submittedPhotoCount: lots.reduce(
      (sum, lot) => sum + lot.submittedPhotoCount,
      0
    ),
    lots,
  };
}
