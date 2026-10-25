/**
 * Merges eligible asset drafts into a new report, using the selected primary report as
 * the metadata/preview base and recording its id. Image references are remapped into one
 * global array. Eligibility checks and merge-request deduplication run before persistence;
 * client retries converge on the already-created merged report.
 */
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import ReportJob from "../models/reportJob.model.js";
import { generateValuationTable, type ValuationMethod } from "./assetValuationService.js";
import { getCrDisclaimerLotKey } from "../utils/crDisclaimers.js";
import {
  buildAssetPreviewFilesJobOutbox,
  queuePreviewFilesJob,
} from "../jobs/assetReportJob.js";
import { calculateAssetLotsTotalValue } from "../utils/assetTotalValue.js";
import { assignSequentialMergedLotNumbers } from "../utils/mergedAssetLotNumbers.js";
import { enforceLotsDamageAnalysisPolicy } from "../utils/lotDamagePolicy.js";
import {
  createAssetPreviewFilesGenerationToken,
  reconcileAssetPreviewFilesQueueFailure,
} from "./assetPreviewFilesGenerationService.js";
import {
  shouldUseMongoReportQueue,
  type ReportJobOutbox,
} from "../utils/reportJobMongoQueue.js";

const STABLE_STATUSES = new Set(["preview", "declined", "pending_approval", "approved"]);
const MAX_MERGE_SOURCES = 20;
const MAX_COMPOSED_JSON_BYTES = 12 * 1024 * 1024;
const lotNumberCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export class AssetMergeError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export function normalizeAssetContractKey(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function exactLegacyContractRegex(value: unknown): RegExp {
  const escapedParts = String(value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^\\s*${escapedParts.join("\\s+")}\\s*$`, "i");
}

function clonePlain<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

type AssetMergeFilesOptions = NonNullable<
  Parameters<typeof queuePreviewFilesJob>[1]
>;

type AssetMergeFilesHandoff = {
  options: AssetMergeFilesOptions;
  outbox?: ReportJobOutbox;
};

function prepareAssetMergeFilesHandoff(input: {
  reportId: string;
  generationToken: string;
}): AssetMergeFilesHandoff {
  // The merged report row is the immutable generation snapshot while its
  // ownership flags are active, so the durable payload can reload it instead
  // of duplicating a potentially large preview inside the same Mongo document.
  const options: AssetMergeFilesOptions = {
    targetStatus: "preview",
    jobId: input.generationToken,
    generationToken: input.generationToken,
  };
  const outbox = shouldUseMongoReportQueue()
    ? buildAssetPreviewFilesJobOutbox(input.reportId, options)
    : undefined;
  return {
    options: {
      ...options,
      reportJobOutboxToken: outbox?.token,
    },
    outbox,
  };
}

async function dispatchAssetMergeFilesHandoff(input: {
  reportId: string;
  handoff: AssetMergeFilesHandoff;
  fallbackStatus: string;
}): Promise<void> {
  try {
    await queuePreviewFilesJob(input.reportId, input.handoff.options);
  } catch (queueError) {
    if (input.handoff.outbox) {
      // The report row and its exact queue intent were committed together.
      // Keep both untouched so an API retry or worker restart can finish the
      // same idempotent handoff without creating another merged report/job.
      console.error(
        `[AssetMerge] Durable file-generation handoff is pending for ${input.reportId}:`,
        queueError
      );
      return;
    }
    const generationToken = String(
      input.handoff.options.generationToken || input.handoff.options.jobId || ""
    );
    const reconciliation = await reconcileAssetPreviewFilesQueueFailure({
      reportId: input.reportId,
      generationToken,
      error: queueError,
      fallbackStatus: input.fallbackStatus,
    });
    if (!reconciliation.queued) throw queueError;
  }
}

function withoutReportJobOutbox<T extends Record<string, any>>(report: T): T {
  if (!Object.prototype.hasOwnProperty.call(report, "report_job_outbox")) {
    return report;
  }
  const { report_job_outbox: _outbox, ...safeReport } = report;
  return safeReport as T;
}

async function resumeAssetMergeOutbox(report: any): Promise<any> {
  const reportId = String(report?._id || "");
  const generationToken = String(report?.job_id || "");
  const outbox = report?.report_job_outbox as ReportJobOutbox | undefined;
  if (reportId && generationToken && outbox?.token) {
    await dispatchAssetMergeFilesHandoff({
      reportId,
      handoff: {
        options: {
          targetStatus: "preview",
          jobId: generationToken,
          generationToken,
          reportJobOutboxToken: String(outbox.token),
        },
        outbox,
      },
      fallbackStatus: "preview",
    });
  }
  return withoutReportJobOutbox(report);
}

function reportContract(report: any): string {
  return String(report?.preview_data?.contract_no || report?.contract_no || "").trim();
}

function reportLots(report: any): any[] {
  if (Array.isArray(report?.preview_data?.lots)) return report.preview_data.lots;
  return Array.isArray(report?.lots) ? report.lots : [];
}

function isActive(report: any): boolean {
  if (
    report?.status === "processing" ||
    report?.job_status === "queued" ||
    report?.job_status === "processing"
  ) {
    return true;
  }
  // Generated URLs and a completed job are authoritative when legacy flags
  // were not cleared by an older worker deployment.
  if (report?.job_status === "done" || report?.preview_files?.excel) return false;
  return Boolean(report?.files_generating || report?.files_regenerating);
}

function eligibilityReason(report: any, hasDurableJob = false): string | null {
  if (!STABLE_STATUSES.has(String(report?.status || ""))) {
    return "Only stable Preview, Declined, Pending Approval, or Approved reports can be merged.";
  }
  if (hasDurableJob || isActive(report)) return "This report is still processing files.";
  if (reportLots(report).length === 0) return "This report does not contain any saved lots.";
  return null;
}

function displayLotNumber(lot: any, index: number): string {
  return String(lot?.lot_number ?? lot?.lot_id ?? index + 1)
    .trim()
    .replace(/^(?:lot\s*#?\s*|#\s*)/i, "") || String(index + 1);
}

function firstLotImage(report: any): string | undefined {
  const root = Array.isArray(report?.imageUrls) ? report.imageUrls : [];
  const lot = reportLots(report)[0];
  const direct = Array.isArray(lot?.image_urls) ? lot.image_urls.find(Boolean) : undefined;
  if (direct) return String(direct);
  const index = Array.isArray(lot?.image_indexes) ? Number(lot.image_indexes[0]) : NaN;
  if (Number.isInteger(index) && root[index]) return String(root[index]);
  return lot?.image_url ? String(lot.image_url) : undefined;
}

function candidateDto(report: any, anchorId: string, activeReportIds: Set<string>) {
  const lots = reportLots(report);
  const reason = eligibilityReason(report, activeReportIds.has(String(report._id)));
  const owner = report?.user && typeof report.user === "object" ? report.user : null;
  return {
    id: String(report._id),
    isAnchor: String(report._id) === anchorId,
    eligible: !reason,
    disabledReason: reason,
    status: report.status,
    clientName: report?.preview_data?.client_name || report?.client_name || "Asset Report",
    contractNo: reportContract(report),
    createdAt: report.createdAt,
    lotCount: lots.length,
    lotNumbers: lots.map(displayLotNumber),
    imageCount: lots.reduce((count: number, lot: any) => {
      const mainCount = Array.isArray(lot?.image_indexes) && lot.image_indexes.length > 0
        ? lot.image_indexes.length
        : Array.isArray(lot?.image_urls) && lot.image_urls.length > 0
          ? lot.image_urls.length
          : lot?.image_url
            ? 1
            : 0;
      const extraCount = Array.isArray(lot?.extra_image_indexes) && lot.extra_image_indexes.length > 0
        ? lot.extra_image_indexes.length
        : Array.isArray(lot?.extra_image_urls)
          ? lot.extra_image_urls.length
          : 0;
      return count + mainCount + extraCount;
    }, 0),
    thumbnailUrl: firstLotImage(report),
    isMergedReport: report?.is_merged_report === true,
    owner: {
      id: String(owner?._id || report?.user || ""),
      name: String(owner?.username || owner?.name || owner?.email || "Report owner"),
      email: String(owner?.email || ""),
    },
  };
}

export async function getAssetMergeCandidates(userId: string, anchorReportId: string) {
  if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(anchorReportId)) {
    throw new AssetMergeError("Asset report not found.", 404);
  }
  const ownerObjectId = new mongoose.Types.ObjectId(userId);
  const anchor = await AssetReport.findOne({
    _id: new mongoose.Types.ObjectId(anchorReportId),
    user: ownerObjectId,
    is_draft_preview: { $ne: true },
  } as any).lean<any>();
  if (!anchor) throw new AssetMergeError("Asset report not found.", 404);
  const contractKey = normalizeAssetContractKey(reportContract(anchor));
  if (!contractKey) throw new AssetMergeError("The selected report does not have a contract number.");
  const legacyContractRegex = exactLegacyContractRegex(reportContract(anchor));

  // Candidate discovery is contract-scoped across users so teams can combine
  // work captured by different employees. The anchor remains owner-scoped,
  // which prevents users from probing contracts they do not already own.
  const reports = await AssetReport.find({
    is_draft_preview: { $ne: true },
    status: { $in: ["preview", "declined", "pending_approval", "approved", "processing", "error"] },
    $or: [
      { contract_key: contractKey },
      {
        $and: [
          {
            $or: [
              { contract_key: { $exists: false } },
              { contract_key: null },
              { contract_key: "" },
            ],
          },
          {
            $or: [
              { contract_no: legacyContractRegex },
              { "preview_data.contract_no": legacyContractRegex },
            ],
          },
        ],
      },
    ],
  } as any)
    .populate("user", "username name email")
    .sort({ createdAt: -1 })
    .lean<any[]>();
  const activeJobs = await ReportJob.find({
    reportId: { $in: reports.map((report) => String(report._id)) },
    status: { $in: ["queued", "processing"] },
  })
    .select("reportId")
    .lean<any[]>();
  const activeReportIds = new Set(activeJobs.map((job) => String(job.reportId)));
  const candidates = reports
    .filter((report) => normalizeAssetContractKey(reportContract(report)) === contractKey)
    .map((report) => candidateDto(report, anchorReportId, activeReportIds));

  return {
    contractNo: reportContract(anchor),
    contractKey,
    anchorReportId,
    candidates,
  };
}

type RemapContext = {
  report: any;
  sourceId: string;
  globalUrls: string[];
  deleted: Set<number>;
  deletedUrls: Set<string>;
  oldToNew: Map<number, number>;
  directUrlToNew: Map<string, number>;
  mergedUrls: string[];
};

function appendDirectUrl(context: RemapContext, value: unknown): number | undefined {
  const url = String(value ?? "").trim();
  if (!url || context.deletedUrls.has(url)) return undefined;
  const existing = context.directUrlToNew.get(url);
  if (existing != null) return existing;
  const next = context.mergedUrls.length;
  context.mergedUrls.push(url);
  context.directUrlToNew.set(url, next);
  return next;
}

function remapRootIndex(context: RemapContext, rawIndex: unknown): number | undefined {
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || context.deleted.has(index)) return undefined;
  const existing = context.oldToNew.get(index);
  if (existing != null) return existing;
  const url = context.globalUrls[index];
  const remapped = appendDirectUrl(context, url);
  if (remapped != null) context.oldToNew.set(index, remapped);
  return remapped;
}

function remapImageList(
  context: RemapContext,
  rawIndexes: unknown,
  rawUrls: unknown
): { indexes: number[]; urls: string[] } {
  // Both index- and URL-based image references exist in historical lots. Funnel them
  // through one mapping so all nested records point at the merged global URL array.
  const indexes: number[] = [];
  const urls: string[] = [];
  const seen = new Set<number>();
  const sourceIndexes = Array.isArray(rawIndexes) ? rawIndexes : [];
  for (const rawIndex of sourceIndexes) {
    const mapped = remapRootIndex(context, rawIndex);
    if (mapped == null || seen.has(mapped)) continue;
    seen.add(mapped);
    indexes.push(mapped);
    urls.push(context.mergedUrls[mapped]);
  }
  const sourceUrls = Array.isArray(rawUrls) ? rawUrls : [];
  for (const rawUrl of sourceUrls) {
    const mapped = appendDirectUrl(context, rawUrl);
    if (mapped == null || seen.has(mapped)) continue;
    seen.add(mapped);
    indexes.push(mapped);
    urls.push(context.mergedUrls[mapped]);
  }
  return { indexes, urls };
}

function remapLot(context: RemapContext, sourceLot: any, lotIndex: number) {
  const lot = clonePlain(sourceLot || {});
  const main = remapImageList(context, lot.image_indexes, lot.image_urls);
  const extra = remapImageList(context, lot.extra_image_indexes, lot.extra_image_urls);
  let preferredImageIndex = appendDirectUrl(context, lot.image_url);
  if (main.indexes.length === 0 && preferredImageIndex != null) {
    const mapped = preferredImageIndex;
    main.indexes.push(mapped);
    main.urls.push(context.mergedUrls[mapped]);
  } else if (main.indexes.length === 0 && lot.image_url) {
    const mapped = appendDirectUrl(context, lot.image_url);
    if (mapped != null) {
      main.indexes.push(mapped);
      main.urls.push(context.mergedUrls[mapped]);
    }
  }

  const sourceLotId = String(lot.lot_id || `lot-${lotIndex + 1}`);
  // The full immutable source id prevents lot-id collisions across reports that
  // happen to share the same trailing ObjectId bytes.
  const mergedLotId = `merge-${context.sourceId}-${lotIndex + 1}`;
  const items = Array.isArray(lot.items)
    ? lot.items.map((item: any) => {
        const next = clonePlain(item || {});
        const mapped = remapRootIndex(context, next.image_index);
        if (mapped != null) {
          next.image_index = mapped;
          next.image_url = context.mergedUrls[mapped];
        } else if (next.image_url) {
          const direct = appendDirectUrl(context, next.image_url);
          if (direct != null) {
            next.image_index = direct;
            next.image_url = context.mergedUrls[direct];
          } else {
            delete next.image_index;
            delete next.image_url;
          }
        } else {
          delete next.image_index;
        }
        return next;
      })
    : undefined;

  if (preferredImageIndex == null) preferredImageIndex = main.indexes[0] ?? extra.indexes[0];
  const remappedLotImageIndex = remapRootIndex(context, lot.image_index);
  const remappedCoverImageIndex = remapRootIndex(context, lot.cover_image_index);
  const remappedPrimaryImageIndex = remapRootIndex(context, lot.primary_image_index);
  const lotNumber = displayLotNumber(lot, lotIndex);
  const title = String(lot.title || lot.categories || `Lot ${lotNumber}`).trim();
  const description = String(lot.description || lot.details || title).trim();

  const remappedLot: any = {
    ...lot,
    lot_id: mergedLotId,
    title,
    description,
    merge_source_report_id: context.sourceId,
    merge_source_lot_id: sourceLotId,
    merge_source_lot_number: lotNumber,
    image_indexes: main.indexes,
    image_urls: main.urls,
    image_url:
      (preferredImageIndex != null ? context.mergedUrls[preferredImageIndex] : undefined) ||
      main.urls[0] ||
      extra.urls[0] ||
      null,
    extra_image_indexes: extra.indexes,
    extra_image_urls: extra.urls,
    ...(items ? { items } : {}),
  };
  if (remappedLotImageIndex != null) remappedLot.image_index = remappedLotImageIndex;
  else delete remappedLot.image_index;
  if (remappedCoverImageIndex != null) remappedLot.cover_image_index = remappedCoverImageIndex;
  else delete remappedLot.cover_image_index;
  if (remappedPrimaryImageIndex != null) remappedLot.primary_image_index = remappedPrimaryImageIndex;
  else delete remappedLot.primary_image_index;
  return remappedLot;
}

export function findMergedLotConflicts(lots: any[]) {
  const byNumber = new Map<string, { lotNumber: string; lots: any[] }>();
  lots.forEach((lot, index) => {
    const lotNumber = displayLotNumber(lot, index);
    const key = lotNumber.toLowerCase();
    const current = byNumber.get(key) || { lotNumber, lots: [] };
    current.lots.push(lot);
    byNumber.set(key, current);
  });
  return Array.from(byNumber.values())
    .filter((entry) => entry.lots.length > 1)
    .map((entry) => ({
      type: "duplicate_lot_number" as const,
      lotNumber: entry.lotNumber,
      lotIds: entry.lots.map((lot) => String(lot.lot_id)),
      sourceReportIds: Array.from(
        new Set(entry.lots.map((lot) => String(lot.merge_source_report_id || "")).filter(Boolean))
      ),
    }));
}

const REPORT_METADATA_KEYS = [
  "client_name",
  "effective_date",
  "appraisal_purpose",
  "owner_name",
  "appraiser",
  "appraisal_company",
  "industry",
  "inspection_date",
  "contract_no",
  "language",
  "currency",
  "user_cv_url",
  "user_cv_filename",
  "prepared_for",
  "factors_age_condition",
  "factors_quality",
  "factors_analysis",
  "include_damage_analysis",
  "damage_analysis",
  "bank_photos_enabled",
  "watermark_images",
  "include_valuation_table",
  "valuation_methods",
] as const;

function primaryMetadata(primary: any) {
  const metadata: Record<string, any> = {};
  for (const key of REPORT_METADATA_KEYS) {
    const value = primary?.preview_data?.[key] !== undefined
      ? primary.preview_data[key]
      : primary[key];
    if (value !== undefined) metadata[key] = clonePlain(value);
  }
  return metadata;
}

function primaryPreviewBase(primary: any) {
  const preview = clonePlain(primary?.preview_data || {});
  for (const key of [
    "lots",
    "deleted_image_indexes",
    "cr_disclaimers_by_lot",
    "admin_schedule_sheet",
    "valuation_data",
    "total_value",
    "total_appraised_value",
    "merge_conflicts",
  ]) {
    delete preview[key];
  }
  return preview;
}

function buildValuationData(primary: any, lots: any[], totalValue: number) {
  const enabled = primary?.include_valuation_table === true || primary?.preview_data?.include_valuation_table === true;
  const methods = (primary?.valuation_methods || primary?.preview_data?.valuation_methods || []) as ValuationMethod[];
  if (!enabled || methods.length === 0) return undefined;
  const oldMethods = primary?.valuation_data?.methods || primary?.preview_data?.valuation_data?.methods || [];
  const percentages = Object.fromEntries(
    oldMethods
      .filter((method: any) => method?.method && Number.isFinite(Number(method?.percentage)))
      .map((method: any) => [method.method, Number(method.percentage)])
  );
  return generateValuationTable(totalValue, methods, percentages);
}

export async function mergeAssetReports(input: {
  userId: string;
  sourceReportIds: string[];
  primaryReportId: string;
  mergeRequestId: string;
}) {
  const sourceIds = Array.from(new Set((input.sourceReportIds || []).map(String).filter(Boolean)));
  if (sourceIds.length < 2 || sourceIds.length > MAX_MERGE_SOURCES) {
    throw new AssetMergeError(`Select between 2 and ${MAX_MERGE_SOURCES} Asset reports.`);
  }
  if (!sourceIds.includes(String(input.primaryReportId))) {
    throw new AssetMergeError("The primary report must be one of the selected reports.");
  }
  const mergeRequestId = String(input.mergeRequestId || "").trim();
  if (!mergeRequestId || mergeRequestId.length > 120) {
    throw new AssetMergeError("A valid merge request ID is required.");
  }

  if (!mongoose.isValidObjectId(input.userId) || sourceIds.some((id) => !mongoose.isValidObjectId(id))) {
    throw new AssetMergeError("One or more selected Asset reports were not found.", 404);
  }
  const ownerObjectId = new mongoose.Types.ObjectId(input.userId);
  const sourceObjectIds = sourceIds.map((id) => new mongoose.Types.ObjectId(id));
  // Fast-path an explicit retry before loading and composing potentially large sources.
  // The unique-key recovery at create time remains the concurrent-race backstop.
  const existing = await AssetReport.findOne({
    user: ownerObjectId,
    merge_request_id: mergeRequestId,
    is_draft_preview: { $ne: true },
  } as any)
    .select("+report_job_outbox")
    .lean<any>();
  if (existing) {
    return {
      report: await resumeAssetMergeOutbox(existing),
      resumed: true,
    };
  }

  const found = await AssetReport.find({
    _id: { $in: sourceObjectIds },
    is_draft_preview: { $ne: true },
  } as any).lean<any[]>();
  if (found.length !== sourceIds.length) {
    throw new AssetMergeError("One or more selected Asset reports were not found.", 404);
  }
  const byId = new Map(found.map((report) => [String(report._id), report]));
  const sources = sourceIds.map((id) => byId.get(id)!);
  const primary = byId.get(String(input.primaryReportId));
  if (!primary) throw new AssetMergeError("Primary Asset report not found.", 404);
  const ownsAtLeastOneSource = sources.some(
    (source) => String(source?.user?._id || source?.user || "") === String(ownerObjectId)
  );
  if (!ownsAtLeastOneSource) {
    throw new AssetMergeError(
      "Select at least one Asset report that belongs to your account.",
      403
    );
  }

  const contractKey = normalizeAssetContractKey(reportContract(primary));
  if (!contractKey || sources.some((source) => normalizeAssetContractKey(reportContract(source)) !== contractKey)) {
    throw new AssetMergeError("All selected Asset reports must have the same contract number.");
  }
  const activeJobs = await ReportJob.find({
    reportId: { $in: sourceIds },
    status: { $in: ["queued", "processing"] },
  })
    .select("reportId")
    .lean<any[]>();
  const activeReportIds = new Set(activeJobs.map((job) => String(job.reportId)));
  for (const source of sources) {
    const reason = eligibilityReason(source, activeReportIds.has(String(source._id)));
    if (reason) throw new AssetMergeError(`${reportContract(source) || source._id}: ${reason}`);
  }

  const mergedUrls: string[] = [];
  const mergedVideoUrls: string[] = [];
  const seenVideoUrls = new Set<string>();
  const mergedLots: any[] = [];
  const stableLotOrder = new Map<string, { sourceOrder: number; lotOrder: number }>();
  const disclaimersByLot: Record<string, any> = {};
  for (const [sourceOrder, source] of sources.entries()) {
    const sourceId = String(source._id);
    // Only original report manifests authorize media reads. Keep unassigned
    // clips too; copied editable preview URLs must not expand that authority.
    const sourceVideoUrls = new Set<string>(
      (Array.isArray(source.videoUrls) ? source.videoUrls : [])
        .filter((url: unknown): url is string => typeof url === "string" && !!url.trim())
        .map((url: string) => url.trim()),
    );
    for (const url of sourceVideoUrls) {
      if (seenVideoUrls.has(url)) continue;
      seenVideoUrls.add(url);
      mergedVideoUrls.push(url);
    }
    const preview = source.preview_data || {};
    const sourceDisclaimers = preview.cr_disclaimers_by_lot || {};
    const context: RemapContext = {
      report: source,
      sourceId,
      globalUrls: Array.isArray(source.imageUrls) ? source.imageUrls : [],
      deleted: new Set((Array.isArray(preview.deleted_image_indexes) ? preview.deleted_image_indexes : []).map(Number)),
      deletedUrls: new Set(
        (Array.isArray(preview.deleted_image_indexes) ? preview.deleted_image_indexes : [])
          .map((index: unknown) => (Array.isArray(source.imageUrls) ? source.imageUrls[Number(index)] : undefined))
          .filter((url: unknown): url is string => typeof url === "string" && url.length > 0)
      ),
      oldToNew: new Map(),
      directUrlToNew: new Map(),
      mergedUrls,
    };
    reportLots(source).forEach((sourceLot, lotIndex) => {
      const oldKey = getCrDisclaimerLotKey(sourceLot, lotIndex);
      const mergedLot = remapLot(context, sourceLot, lotIndex);
      mergedLot.video_urls = (Array.isArray(sourceLot.video_urls) ? sourceLot.video_urls : [])
        .filter((url: unknown): url is string => typeof url === "string" && sourceVideoUrls.has(url.trim()))
        .map((url: string) => url.trim());
      mergedLots.push(mergedLot);
      stableLotOrder.set(mergedLot.lot_id, { sourceOrder, lotOrder: lotIndex });
      if (Object.prototype.hasOwnProperty.call(sourceDisclaimers, oldKey)) {
        disclaimersByLot[mergedLot.lot_id] = clonePlain(sourceDisclaimers[oldKey]);
      }
    });
  }

  mergedLots.sort((left, right) => {
    const result = lotNumberCollator.compare(displayLotNumber(left, 0), displayLotNumber(right, 0));
    if (result !== 0) return result;
    const leftOrder = stableLotOrder.get(String(left.lot_id)) || { sourceOrder: 0, lotOrder: 0 };
    const rightOrder = stableLotOrder.get(String(right.lot_id)) || { sourceOrder: 0, lotOrder: 0 };
    const sourceResult = leftOrder.sourceOrder - rightOrder.sourceOrder;
    if (sourceResult !== 0) return sourceResult;
    return leftOrder.lotOrder - rightOrder.lotOrder;
  });

  // Source reports can legitimately reuse lot numbers. The merged report is a
  // new document, so assign its visible sequence only after deterministic
  // natural sorting. Every output then reads the same persisted lot_number.
  const sequentialMergedLots = enforceLotsDamageAnalysisPolicy(
    assignSequentialMergedLotNumbers(mergedLots),
    primary?.preview_data?.include_damage_analysis !== false &&
      primary?.include_damage_analysis !== false
  );
  const conflicts = findMergedLotConflicts(sequentialMergedLots);
  const totalValue = calculateAssetLotsTotalValue(sequentialMergedLots);
  const valuationData = buildValuationData(primary, sequentialMergedLots, totalValue);
  const previewData = {
    ...primaryPreviewBase(primary),
    ...primaryMetadata(primary),
    contract_no: reportContract(primary),
    contract_key: contractKey,
    lots: sequentialMergedLots,
    videoUrls: mergedVideoUrls,
    total_value: totalValue,
    total_appraised_value: totalValue,
    deleted_image_indexes: [],
    cr_disclaimers_by_lot: disclaimersByLot,
    ...(primary?.preview_data?.cr_disclaimers
      ? { cr_disclaimers: clonePlain(primary.preview_data.cr_disclaimers) }
      : {}),
    ...(valuationData ? { valuation_data: valuationData } : {}),
    is_merged_report: true,
    merged_from_report_ids: sourceIds,
    merge_primary_report_id: String(primary._id),
    merge_conflicts: conflicts,
  };
  const generationToken =
    conflicts.length === 0
      ? createAssetPreviewFilesGenerationToken()
      : undefined;
  const reportId = new mongoose.Types.ObjectId();
  const fileHandoff = generationToken
    ? prepareAssetMergeFilesHandoff({
        reportId: String(reportId),
        generationToken,
      })
    : undefined;

  const reportData: any = {
    _id: reportId,
    user: ownerObjectId,
    grouping_mode: "mixed",
    imageUrls: mergedUrls,
    videoUrls: mergedVideoUrls,
    lots: sequentialMergedLots,
    status: conflicts.length > 0 ? "preview" : "processing",
    preview_data: previewData,
    ...primaryMetadata(primary),
    contract_no: reportContract(primary),
    contract_key: contractKey,
    total_value: totalValue,
    total_appraised_value: totalValue,
    valuation_data: valuationData,
    analysis: {
      merge: {
        sourceReportIds: sourceIds,
        primaryReportId: String(primary._id),
        createdAt: new Date().toISOString(),
      },
    },
    client_submission_id: `merge:${mergeRequestId}`,
    is_merged_report: true,
    merged_from_report_ids: sourceIds.map((id) => new mongoose.Types.ObjectId(id)),
    merge_primary_report_id: new mongoose.Types.ObjectId(String(primary._id)),
    merge_request_id: mergeRequestId,
    merge_created_at: new Date(),
    merge_conflicts: conflicts,
    ...(conflicts.length === 0
      ? {
          files_generating: true,
          files_regenerating: false,
          job_id: generationToken,
          job_status: "queued",
          queued_at: new Date(),
          generation_target_status: "preview",
          generation_progress: {
            stage: "generating_files",
            progressPercent: 1,
            message: "Queued to generate merged report files",
            updatedAt: new Date(),
          },
          ...(fileHandoff?.outbox
            ? { report_job_outbox: fileHandoff.outbox }
            : {}),
        }
      : {}),
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(reportData), "utf8");
  if (payloadBytes > MAX_COMPOSED_JSON_BYTES) {
    throw new AssetMergeError(
      `The selected ${sources.length} reports contain ${sequentialMergedLots.length} lots and are too large to merge safely. Select fewer reports and try again.`,
      413
    );
  }

  let report: any;
  try {
    report = await AssetReport.create(reportData);
  } catch (error: any) {
    if (error?.code === 11000) {
      const resumed = await AssetReport.findOne({
        user: ownerObjectId,
        merge_request_id: mergeRequestId,
        is_draft_preview: { $ne: true },
      } as any)
        .select("+report_job_outbox")
        .lean<any>();
      if (resumed) {
        if (resumed.report_job_outbox?.token) {
          return {
            report: await resumeAssetMergeOutbox(resumed),
            resumed: true,
          };
        }
        const resumedConflicts = Array.isArray(resumed.merge_conflicts)
          ? resumed.merge_conflicts
          : [];
        const needsQueueRecovery =
          resumedConflicts.length === 0 &&
          !resumed.preview_files?.excel &&
          !isActive(resumed);
        if (needsQueueRecovery) {
          const recoveryToken = createAssetPreviewFilesGenerationToken();
          const recoveryFallbackStatus = String(resumed.status || "preview");
          const recoveryHandoff = prepareAssetMergeFilesHandoff({
            reportId: String(resumed._id),
            generationToken: recoveryToken,
          });
          const recovered = await AssetReport.findOneAndUpdate(
            {
              _id: resumed._id,
              files_generating: { $ne: true },
              files_regenerating: { $ne: true },
              job_status: { $nin: ["queued", "processing"] },
              "report_job_outbox.token": { $exists: false },
            },
            {
              $set: {
                status: "processing",
                files_generating: true,
                files_regenerating: false,
                job_id: recoveryToken,
                job_status: "queued",
                queued_at: new Date(),
                generation_target_status: "preview",
                generation_progress: {
                  stage: "generating_files",
                  progressPercent: 1,
                  message: "Queued to generate merged report files",
                  updatedAt: new Date(),
                },
                ...(recoveryHandoff.outbox
                  ? { report_job_outbox: recoveryHandoff.outbox }
                  : {}),
              },
              $unset: {
                job_error: 1,
                job_execution_token: 1,
                ...(!recoveryHandoff.outbox
                  ? { report_job_outbox: 1 }
                  : {}),
              },
            },
            { new: true }
          )
            .select("+report_job_outbox")
            .lean<any>();
          if (recovered) {
            await dispatchAssetMergeFilesHandoff({
              reportId: String(recovered._id),
              handoff: recoveryHandoff,
              fallbackStatus: recoveryFallbackStatus,
            });
            return {
              report: withoutReportJobOutbox(recovered),
              resumed: true,
            };
          }
        }
        return {
          report: withoutReportJobOutbox(resumed),
          resumed: true,
        };
      }
    }
    throw error;
  }

  // Queue only after the report exists with a complete preview snapshot. Workers can
  // safely reload it, and conflict-bearing merges remain editable instead of generating
  // artifacts from an unresolved composition.
  if (fileHandoff) {
    await dispatchAssetMergeFilesHandoff({
      reportId: String(report._id),
      handoff: fileHandoff,
      fallbackStatus: "preview",
    });
  }
  return {
    report: withoutReportJobOutbox(report.toObject()),
    resumed: false,
  };
}
