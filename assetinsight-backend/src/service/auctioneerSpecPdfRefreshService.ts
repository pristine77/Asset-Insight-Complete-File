import { resolvePhotoWatermark } from "../utils/photoWatermarkPolicy.js";
/**
 * Regenerates condition-report artifacts from the current canonical report state.
 * Uploads complete before document URLs are persisted so callers never observe a
 * database pointer to a missing object; cache-busting query values let replacement
 * objects become visible immediately through CDNs and browsers.
 */
import { createHash, randomUUID } from "node:crypto";
import { sha256Buffer } from "../utils/sha256Buffer.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import PdfReport from "../models/pdfReport.model.js";
import { generateAuctioneerSpecSheetPdfFromReport } from "./auctioneerSpecSheetPdfService.js";
import { generateAuctioneerSpecSheetDocxFromReport } from "./auctioneerSpecSheetDocxService.js";
import {
  deleteFromR2,
  uploadBufferToR2,
} from "../utils/r2Storage/r2Upload.js";
import { markPreviewDataSpecsReviewed, normalizePreviewDataAuctioneerSpecs } from "../utils/auctioneerSpecRows.js";
import {
  buildReportArtifactFilenames,
  getReportContractNumber,
  getReportLots,
} from "../utils/reportArtifactNames.js";
import { getReportDownloadAccess } from "./reportReleaseService.js";
import { proposalValuationWritableRevisionCondition } from "./proposalValuationArtifactPublicationService.js";
import {
  isLotListingArtifactPublicationLive,
  lotListingArtifactPublicationAvailableCondition,
} from "./lotListingArtifactPublicationService.js";

const CR_DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const REQUEST_CR_PUBLICATION_LEASE_MS = 60 * 1_000;
const REQUEST_CR_PUBLICATION_HEARTBEAT_MS = 10 * 1_000;

function plain(value: any): any {
  if (!value) return {};
  if (typeof value.toObject === "function") return value.toObject();
  return value;
}

function userName(user: any): string {
  return String(user?.name || user?.username || "").trim();
}

export function buildSpecReportData(document: any): any {
  const base = plain(document);
  const previewData = normalizePreviewDataAuctioneerSpecs(
    markPreviewDataSpecsReviewed(
      base.preview_data && typeof base.preview_data === "object" ? base.preview_data : {},
      { reconcileManualOverrides: false }
    )
  );
  const user = base.user && typeof base.user === "object" ? base.user : {};

  return {
    ...base,
    ...previewData,
    lots: Array.isArray(previewData.lots)
      ? previewData.lots
      : Array.isArray(base.lots)
        ? base.lots
        : [],
    imageUrls: Array.isArray(base.imageUrls) ? base.imageUrls : [],
    contract_no: previewData.contract_no || base.contract_no || base.contract_number || "",
    contract_number: previewData.contract_no || base.contract_no || base.contract_number || "",
    sales_date: previewData.sales_date || base.sales_date,
    include_damage_analysis:
      previewData.include_damage_analysis ?? base.include_damage_analysis ?? true,
    bank_photos_enabled:
      previewData.bank_photos_enabled === true ||
      previewData.bank_photos_enabled === "true" ||
      (previewData.bank_photos_enabled === undefined &&
        (base.bank_photos_enabled === true || base.bank_photos_enabled === "true")),
    watermark_images: resolvePhotoWatermark(previewData.watermark_images, base.watermark_images),
    inspector_name: userName(user) || base.inspector_name || previewData.inspector_name || "",
    user_email: user?.email || base.user_email || "",
    appraisal_company: user?.companyName || base.appraisal_company || previewData.appraisal_company || "",
    schedule_a_pdf_url:
      previewData.schedule_a_pdf_url ||
      base.schedule_a_pdf_url ||
      base?.preview_files?.schedule_a_pdf ||
      base?.files?.schedule_a_pdf ||
      "",
  };
}

function stableFingerprintValue(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    return stableFingerprintValue(Object.fromEntries(value.entries()));
  }
  if (Array.isArray(value)) return value.map(stableFingerprintValue);
  if (!value || typeof value !== "object") return value;
  if (typeof value.toHexString === "function") return value.toHexString();
  return Object.keys(value)
    .sort()
    .reduce<Record<string, any>>((result, key) => {
      if (value[key] !== undefined) {
        result[key] = stableFingerprintValue(value[key]);
      }
      return result;
    }, {});
}

const CR_RENDERER_LOT_INPUT_FIELDS = [
  "lot_number",
  "lot_id",
  "lot",
  "id",
  "title",
  "asset_title",
  "name",
  "categories",
  "category",
  "child_category",
  "asset_category",
  "description",
  "details",
  "serial_number",
  "serial_no_or_label",
  "sn_vin",
  "vin",
  "sn",
  "year",
  "model_year",
  "modelYear",
  "vinDecoded",
  "vin_decoded",
  "vinDecode",
  "vin_decode",
  "condition_report_selections",
  "condition_report_specs",
  "condition_report_specs_reviewed",
  "condition_report_specs_manual_overrides",
  "condition_report_specs_deleted",
  "deleted_condition_report_specs",
  "removed_condition_report_specs",
  "hidden_condition_report_specs",
  "condition_report_specs_custom_order",
  "custom_condition_report_specs_order",
  "auctioneer_specs_custom_order",
  "auctioneer_import_specs",
  "auctioneer_specs",
  "category_specs",
  "specifications",
  "specs",
  "other_specs",
  "other_specifications",
  "other_specifications_html",
  "otherSpecificationsHtml",
  "damage_analysis",
  "lotted_by",
  "bank_photos_enabled",
  "image_url",
  "image_urls",
  "extra_image_urls",
  "image_indexes",
  "extra_image_indexes",
] as const;

function crRendererLotFingerprintInput(lot: any): Record<string, unknown> {
  if (!lot || typeof lot !== "object") return {};
  return Object.fromEntries(
    CR_RENDERER_LOT_INPUT_FIELDS.flatMap((field) =>
      lot[field] === undefined ? [] : [[field, lot[field]]]
    )
  );
}

/** Hash only inputs consumed by the CR renderers, never output/workflow metadata. */
export function buildCrArtifactSourceFingerprint(reportData: any): string {
  const source = {
    lots: Array.isArray(reportData?.lots)
      ? reportData.lots.map(crRendererLotFingerprintInput)
      : [],
    imageUrls: Array.isArray(reportData?.imageUrls) ? reportData.imageUrls : [],
    contract_no: reportData?.contract_no,
    contract_number: reportData?.contract_number,
    prepared_for: reportData?.prepared_for,
    client_name: reportData?.client_name,
    owner_name: reportData?.owner_name,
    sales_date: reportData?.sales_date,
    effective_date: reportData?.effective_date,
    inspection_date: reportData?.inspection_date,
    inspector_name: reportData?.inspector_name,
    appraiser: reportData?.appraiser,
    include_damage_analysis: reportData?.include_damage_analysis,
    bank_photos_enabled: reportData?.bank_photos_enabled,
    cr_disclaimers:
      reportData?.cr_disclaimers ??
      reportData?.preview_data?.cr_disclaimers ??
      reportData?.details?.cr_disclaimers,
    cr_disclaimers_by_lot:
      reportData?.cr_disclaimers_by_lot ??
      reportData?.preview_data?.cr_disclaimers_by_lot ??
      reportData?.details?.cr_disclaimers_by_lot,
  };
  return createHash("sha256")
    .update(JSON.stringify(stableFingerprintValue(source)))
    .digest("hex");
}

type CrReportKind = "asset" | "lotListing";

export type StoredCrArtifactBundle = {
  specPdf: string;
  crDocx: string;
};

type UploadedCrArtifactBundle = StoredCrArtifactBundle & {
  kind: CrReportKind;
  reportId: string;
  bucket: string;
  keys: [string, string];
};

function storedCrArtifactBundle(document: any): StoredCrArtifactBundle | null {
  const specPdf = String(document?.preview_files?.spec_pdf || "").trim();
  const crDocx = String(document?.preview_files?.cr_docx || "").trim();
  return specPdf && crDocx ? { specPdf, crDocx } : null;
}

function syncStoredCrArtifactBundle(input: {
  document: any;
  bundle: StoredCrArtifactBundle;
  updatedAt?: unknown;
  includeApprovedFiles?: boolean;
}) {
  input.document.preview_files = {
    ...(input.document.preview_files || {}),
    spec_pdf: input.bundle.specPdf,
    cr_docx: input.bundle.crDocx,
  };
  if (input.includeApprovedFiles) {
    input.document.files = {
      ...(input.document.files || {}),
      spec_pdf: input.bundle.specPdf,
      cr_docx: input.bundle.crDocx,
    };
  }
  input.document.unmarkModified?.("preview_files");
  if (input.includeApprovedFiles) {
    input.document.unmarkModified?.("files");
  }
  if (input.updatedAt) {
    input.document.updatedAt = input.updatedAt;
    input.document.unmarkModified?.("updatedAt");
  }
}

function requiredSourceUpdatedAt(document: any): Date {
  const sourceUpdatedAt = new Date(document?.updatedAt as any);
  if (Number.isFinite(sourceUpdatedAt.getTime())) return sourceUpdatedAt;
  throw Object.assign(
    new Error("Reload the report before generating CR files."),
    { code: "REPORT_REVISION_CHANGED", statusCode: 409 }
  );
}

class RequestScopedCrPublicationLeaseLostError extends Error {
  constructor() {
    super("The report changed while CR files were being generated");
    this.name = "RequestScopedCrPublicationLeaseLostError";
  }
}

function safeObjectKeySegment(value: unknown, fallback: string): string {
  const segment = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return segment || fallback;
}

async function immutableCrArtifactKey(input: {
  kind: CrReportKind;
  reportId: string;
  sourceFingerprint: string;
  filename: string;
  buffer: Buffer;
}): Promise<string> {
  const reportId = safeObjectKeySegment(input.reportId, "report");
  const sourceFingerprint = safeObjectKeySegment(
    input.sourceFingerprint,
    "source"
  );
  const filename = safeObjectKeySegment(input.filename, "condition-report.bin");
  const digest = await sha256Buffer(input.buffer);
  return input.kind === "asset"
    ? `previews/asset-cr/${reportId}/${sourceFingerprint}/${digest}-${filename}`
    : `lot-listings/lot-listing-cr/${reportId}/${sourceFingerprint}/${digest}-${filename}`;
}

function urlReferencesObjectKey(value: unknown, key: string): boolean {
  try {
    const parsed = new URL(String(value || ""));
    return decodeURIComponent(parsed.pathname).endsWith(`/${key}`);
  } catch {
    return false;
  }
}

async function deleteUnpublishedCrArtifacts(
  uploaded:
    | Pick<
        UploadedCrArtifactBundle,
        "kind" | "reportId" | "bucket" | "keys"
      >
    | null
) {
  if (!uploaded) return;
  // Deterministic retry keys can already be the authoritative pair after a
  // lost response. If pointer inspection is unavailable, retaining an orphan
  // is safer than deleting a potentially live report artifact.
  let current: any = null;
  try {
    current =
      uploaded.kind === "asset"
        ? await AssetReport.findById(uploaded.reportId)
            .select("preview_files files")
            .lean()
        : await LotListing.findById(uploaded.reportId)
            .select("preview_files files")
            .lean();
  } catch {
    return;
  }
  if (!current) return;
  const referencedUrls = [
    ...Object.values(current.preview_files || {}),
    ...Object.values(current.files || {}),
  ];
  const unreferencedKeys = uploaded.keys.filter(
    (key) => !referencedUrls.some((url) => urlReferencesObjectKey(url, key))
  );
  await Promise.allSettled(
    unreferencedKeys.map((key) => deleteFromR2(uploaded.bucket, key))
  );
}

async function uploadImmutableCrArtifactBundle(input: {
  kind: CrReportKind;
  reportId: string;
  sourceFingerprint: string;
  reportData: any;
  specPdfBuffer: Buffer;
  crDocxBuffer: Buffer;
}): Promise<UploadedCrArtifactBundle> {
  const bucket = String(process.env.R2_BUCKET_NAME || "").trim();
  if (!bucket) throw new Error("R2_BUCKET_NAME is required to save CR files");
  const filenames = buildReportArtifactFilenames({
    kind: input.kind,
    contractNo: getReportContractNumber(input.reportData, input.reportId),
    reportId: input.reportId,
    fallback: input.reportId,
    lots: input.reportData?.lots,
  });
  const specPdfKey = await immutableCrArtifactKey({
    kind: input.kind,
    reportId: input.reportId,
    sourceFingerprint: input.sourceFingerprint,
    filename: filenames.crPdf,
    buffer: input.specPdfBuffer,
  });
  const crDocxKey = await immutableCrArtifactKey({
    kind: input.kind,
    reportId: input.reportId,
    sourceFingerprint: input.sourceFingerprint,
    filename: filenames.crDocx,
    buffer: input.crDocxBuffer,
  });
  const keys: [string, string] = [specPdfKey, crDocxKey];
  const version = Date.now();
  try {
    const writes = await Promise.allSettled([
      uploadBufferToR2(
        input.specPdfBuffer,
        "application/pdf",
        bucket,
        specPdfKey
      ),
      uploadBufferToR2(
        input.crDocxBuffer,
        CR_DOCX_CONTENT_TYPE,
        bucket,
        crDocxKey
      ),
    ]);
    const failed = writes.find(
      (write): write is PromiseRejectedResult => write.status === "rejected"
    );
    if (failed) throw failed.reason;
    const [specPdf, crDocx] = writes.map(
      (write) => (write as PromiseFulfilledResult<string>).value
    );
    return {
      kind: input.kind,
      reportId: input.reportId,
      bucket,
      keys,
      specPdf: `${specPdf}?v=${version}`,
      crDocx: `${crDocx}?v=${version}`,
    };
  } catch (error) {
    await deleteUnpublishedCrArtifacts({
      kind: input.kind,
      reportId: input.reportId,
      bucket,
      keys,
    });
    throw error;
  }
}

function assetRevisionCondition(revision: number): Record<string, unknown> {
  if (revision === 0) {
    return {
      $or: [
        { proposal_valuation_revision: 0 },
        { proposal_valuation_revision: { $exists: false } },
        { proposal_valuation_revision: null },
      ],
    };
  }
  return { proposal_valuation_revision: revision };
}

function inactiveGenerationCondition(): Record<string, unknown> {
  return {
    files_generating: { $ne: true },
    files_regenerating: { $ne: true },
    job_status: { $nin: ["queued", "processing"] },
  };
}

function crPublicationConflict(input: {
  current: any;
  kind: CrReportKind;
  sourceRevision?: number;
}): Error {
  const currentRevision = Number(
    input.current?.proposal_valuation_revision || 0
  );
  const leaseExpiresAt =
    input.kind === "asset"
      ? input.current?.proposal_valuation_artifact_publish_expires_at
      : input.current?.artifact_publish_expires_at;
  const hasLiveLease =
    input.kind === "asset"
      ? Boolean(
          input.current?.proposal_valuation_artifact_publish_token &&
            leaseExpiresAt &&
            new Date(leaseExpiresAt).getTime() > Date.now()
        )
      : isLotListingArtifactPublicationLive(input.current);
  const generationActive = Boolean(
    input.current?.files_generating === true ||
      input.current?.files_regenerating === true ||
      ["queued", "processing"].includes(
        String(input.current?.job_status || "")
      )
  );
  const revisionChanged =
    input.kind === "asset" && currentRevision !== input.sourceRevision;
  return Object.assign(
    new Error(
      hasLiveLease
        ? "CR files are already being generated. Wait for that refresh to finish."
        : generationActive
          ? "This report started generating files. Wait for it to finish before refreshing the CR."
          : "The report changed while CR files were being generated. Refresh and retry."
    ),
    {
      code: hasLiveLease
        ? "CR_ARTIFACT_PUBLISH_IN_PROGRESS"
        : generationActive
          ? "REPORT_FILES_GENERATING"
          : revisionChanged
            ? "PV_REVISION_CONFLICT"
            : "REPORT_REVISION_CHANGED",
      statusCode: 409,
      ...(input.kind === "asset" ? { currentRevision } : {}),
      ...(hasLiveLease && leaseExpiresAt
        ? {
            retryAfterMs: Math.max(
              100,
              new Date(leaseExpiresAt).getTime() - Date.now()
            ),
          }
        : {}),
    }
  );
}

export async function generateAssetSpecPdfForReport(report: any): Promise<{
  buffer: Buffer;
  reportData: any;
}> {
  const reportData = buildSpecReportData(report);
  const buffer = await generateAuctioneerSpecSheetPdfFromReport(reportData);
  return { buffer, reportData };
}

export async function generateAssetCrDocxForReport(report: any): Promise<{
  buffer: Buffer;
  reportData: any;
}> {
  const reportData = buildSpecReportData(report);
  const buffer = await generateAuctioneerSpecSheetDocxFromReport(reportData);
  return { buffer, reportData };
}

/**
 * Generate the request-scoped Asset CR pair while holding the same short lease
 * used to fence Proposal Valuation publication. Both immutable objects must be
 * durable before one atomic Mongo update exposes either URL.
 */
export async function generateAndStoreAssetCrArtifacts(
  report: any
): Promise<StoredCrArtifactBundle> {
  const reportId = String(report?._id || "").trim();
  if (!reportId) throw new Error("An Asset report ID is required to save CR files");
  const revision = Number(report?.proposal_valuation_revision || 0);
  const sourceUpdatedAt = requiredSourceUpdatedAt(report);
  const sourceStatus = String(report?.status || "");
  const reportData = buildSpecReportData(report);
  const sourceFingerprint = buildCrArtifactSourceFingerprint(reportData);
  const reusable = await AssetReport.findOne({
    _id: reportId,
    updatedAt: sourceUpdatedAt,
    status: sourceStatus,
    is_draft_preview: { $ne: true },
    cr_artifact_source_fingerprint: sourceFingerprint,
    ...inactiveGenerationCondition(),
    ...proposalValuationWritableRevisionCondition(revision),
  })
    .select("preview_files updatedAt")
    .lean();
  const reusableBundle = storedCrArtifactBundle(reusable);
  if (reusableBundle) {
    syncStoredCrArtifactBundle({
      document: report,
      bundle: reusableBundle,
      updatedAt: (reusable as any)?.updatedAt,
    });
    return reusableBundle;
  }

  const publicationToken = randomUUID();
  const startedAt = new Date();
  const claim = await AssetReport.findOneAndUpdate(
    {
      _id: reportId,
      updatedAt: sourceUpdatedAt,
      status: sourceStatus,
      is_draft_preview: { $ne: true },
      ...inactiveGenerationCondition(),
      ...proposalValuationWritableRevisionCondition(revision, startedAt),
    },
    {
      $set: {
        proposal_valuation_artifact_publish_token: publicationToken,
        proposal_valuation_artifact_publish_revision: revision,
        proposal_valuation_artifact_publish_expires_at: new Date(
          startedAt.getTime() + REQUEST_CR_PUBLICATION_LEASE_MS
        ),
      },
    },
    { returnDocument: "after", timestamps: false }
  ).lean();
  if (!claim) {
    const current = await AssetReport.findById(reportId)
      .select(
        "status job_status files_generating files_regenerating proposal_valuation_revision proposal_valuation_artifact_publish_token proposal_valuation_artifact_publish_expires_at"
      )
      .lean();
    throw crPublicationConflict({
      current,
      kind: "asset",
      sourceRevision: revision,
    });
  }

  const ownership = {
    _id: reportId,
    updatedAt: sourceUpdatedAt,
    status: sourceStatus,
    is_draft_preview: { $ne: true },
    ...inactiveGenerationCondition(),
    proposal_valuation_artifact_publish_token: publicationToken,
    proposal_valuation_artifact_publish_revision: revision,
    ...assetRevisionCondition(revision),
  };
  let heartbeatError: unknown;
  let renewalInFlight: Promise<void> | null = null;
  let uploaded: UploadedCrArtifactBundle | null = null;
  let published = false;
  const renew = async () => {
    if (heartbeatError) throw heartbeatError;
    const renewed = await AssetReport.updateOne(
      ownership,
      {
        $set: {
          proposal_valuation_artifact_publish_expires_at: new Date(
            Date.now() + REQUEST_CR_PUBLICATION_LEASE_MS
          ),
        },
      },
      { timestamps: false }
    );
    if (renewed.matchedCount !== 1) {
      throw new RequestScopedCrPublicationLeaseLostError();
    }
  };
  const heartbeat = setInterval(() => {
    if (renewalInFlight || heartbeatError) return;
    renewalInFlight = renew()
      .catch((error) => {
        heartbeatError = error;
      })
      .finally(() => {
        renewalInFlight = null;
      });
  }, REQUEST_CR_PUBLICATION_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const [specPdfBuffer, crDocxBuffer] = await Promise.all([
      generateAuctioneerSpecSheetPdfFromReport(reportData),
      generateAuctioneerSpecSheetDocxFromReport(reportData),
    ]);
    await renew();
    uploaded = await uploadImmutableCrArtifactBundle({
      kind: "asset",
      reportId,
      sourceFingerprint,
      reportData,
      specPdfBuffer,
      crDocxBuffer,
    });
    await renew();
    if (renewalInFlight) await renewalInFlight;
    if (heartbeatError) throw heartbeatError;

    const finalized = await AssetReport.findOneAndUpdate(
      ownership,
      {
        $set: {
          "preview_files.spec_pdf": uploaded.specPdf,
          "preview_files.cr_docx": uploaded.crDocx,
          cr_artifact_source_fingerprint: sourceFingerprint,
        },
        $unset: {
          proposal_valuation_artifact_publish_token: 1,
          proposal_valuation_artifact_publish_revision: 1,
          proposal_valuation_artifact_publish_expires_at: 1,
        },
      },
      { returnDocument: "after" }
    ).select("preview_files updatedAt");
    if (!finalized) throw new RequestScopedCrPublicationLeaseLostError();
    published = true;
    syncStoredCrArtifactBundle({
      document: report,
      bundle: uploaded,
      updatedAt: (finalized as any).updatedAt,
    });
    return { specPdf: uploaded.specPdf, crDocx: uploaded.crDocx };
  } catch (error) {
    if (!published) await deleteUnpublishedCrArtifacts(uploaded);
    await AssetReport.updateOne(
      {
        _id: reportId,
        proposal_valuation_artifact_publish_token: publicationToken,
      },
      {
        $unset: {
          proposal_valuation_artifact_publish_token: 1,
          proposal_valuation_artifact_publish_revision: 1,
          proposal_valuation_artifact_publish_expires_at: 1,
        },
      },
      { timestamps: false }
    ).catch(() => undefined);
    if (error instanceof RequestScopedCrPublicationLeaseLostError) {
      const current = await AssetReport.findById(reportId)
        .select(
          "status job_status files_generating files_regenerating proposal_valuation_revision proposal_valuation_artifact_publish_token proposal_valuation_artifact_publish_expires_at"
        )
        .lean();
      throw crPublicationConflict({
        current,
        kind: "asset",
        sourceRevision: revision,
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    const pendingRenewal = renewalInFlight as Promise<void> | null;
    if (!published && pendingRenewal) {
      await pendingRenewal.catch(() => undefined);
    }
  }
}

/** Compatibility wrappers keep older callers on the atomic CR-pair contract. */
export async function generateAndStoreAssetSpecPdf(report: any): Promise<string> {
  return (await generateAndStoreAssetCrArtifacts(report)).specPdf;
}

export async function generateAndStoreAssetCrDocx(report: any): Promise<string> {
  return (await generateAndStoreAssetCrArtifacts(report)).crDocx;
}

export async function generateLotListingSpecPdfForListing(listing: any): Promise<{
  buffer: Buffer;
  reportData: any;
}> {
  const reportData = buildSpecReportData(listing);
  const buffer = await generateAuctioneerSpecSheetPdfFromReport(reportData);
  return { buffer, reportData };
}

export async function generateLotListingCrDocxForListing(listing: any): Promise<{
  buffer: Buffer;
  reportData: any;
}> {
  const reportData = buildSpecReportData(listing);
  const buffer = await generateAuctioneerSpecSheetDocxFromReport(reportData);
  return { buffer, reportData };
}

/**
 * Lot Listing CR refreshes share the durable worker's artifact publication
 * lease, but never mutate worker state. The source updatedAt and status fence
 * the final two-pointer swap against edits or workflow transitions.
 */
export async function generateAndStoreLotListingCrArtifacts(
  listing: any
): Promise<StoredCrArtifactBundle> {
  const listingId = String(listing?._id || "").trim();
  if (!listingId) {
    throw new Error("A Lot Listing report ID is required to save CR files");
  }
  const sourceUpdatedAt = requiredSourceUpdatedAt(listing);
  const sourceStatus = String(listing?.status || "");
  const reportData = buildSpecReportData(listing);
  const sourceFingerprint = buildCrArtifactSourceFingerprint(reportData);
  let reusable: any = await LotListing.findOne({
    _id: listingId,
    updatedAt: sourceUpdatedAt,
    status: sourceStatus,
    is_draft_preview: { $ne: true },
    cr_artifact_source_fingerprint: sourceFingerprint,
    ...inactiveGenerationCondition(),
    ...lotListingArtifactPublicationAvailableCondition(),
  })
    .select("preview_files files updatedAt")
    .lean();
  const reusableBundle = storedCrArtifactBundle(reusable);
  if (reusableBundle) {
    const approvedFilesMatch =
      sourceStatus !== "approved" ||
      (String(reusable?.files?.spec_pdf || "").trim() ===
        reusableBundle.specPdf &&
        String(reusable?.files?.cr_docx || "").trim() ===
          reusableBundle.crDocx);
    if (!approvedFilesMatch) {
      reusable = await LotListing.findOneAndUpdate(
        {
          _id: listingId,
          updatedAt: sourceUpdatedAt,
          status: sourceStatus,
          is_draft_preview: { $ne: true },
          cr_artifact_source_fingerprint: sourceFingerprint,
          "preview_files.spec_pdf": reusableBundle.specPdf,
          "preview_files.cr_docx": reusableBundle.crDocx,
          ...inactiveGenerationCondition(),
          ...lotListingArtifactPublicationAvailableCondition(),
        },
        {
          $set: {
            "files.spec_pdf": reusableBundle.specPdf,
            "files.cr_docx": reusableBundle.crDocx,
          },
        },
        { returnDocument: "after" }
      )
        .select("preview_files files updatedAt")
        .lean();
      if (!reusable) {
        const current = await LotListing.findById(listingId)
          .select(
            "status job_status files_generating files_regenerating artifact_publish_token artifact_publish_expires_at"
          )
          .lean();
        throw crPublicationConflict({ current, kind: "lotListing" });
      }
    }
    syncStoredCrArtifactBundle({
      document: listing,
      bundle: reusableBundle,
      updatedAt: reusable.updatedAt,
      includeApprovedFiles: sourceStatus === "approved",
    });
    return reusableBundle;
  }

  const publicationToken = randomUUID();
  const generationToken = `cr-refresh:${publicationToken}`;
  const startedAt = new Date();
  const claimed = await LotListing.findOneAndUpdate(
    {
      _id: listingId,
      updatedAt: sourceUpdatedAt,
      status: sourceStatus,
      is_draft_preview: { $ne: true },
      ...inactiveGenerationCondition(),
      ...lotListingArtifactPublicationAvailableCondition(startedAt),
    },
    {
      $set: {
        artifact_publish_token: publicationToken,
        artifact_publish_generation_token: generationToken,
        artifact_publish_expires_at: new Date(
          startedAt.getTime() + REQUEST_CR_PUBLICATION_LEASE_MS
        ),
      },
    },
    { returnDocument: "after", timestamps: false }
  ).lean();
  if (!claimed) {
    const current = await LotListing.findById(listingId)
      .select(
        "status job_status files_generating files_regenerating artifact_publish_token artifact_publish_expires_at"
      )
      .lean();
    throw crPublicationConflict({ current, kind: "lotListing" });
  }

  const ownership = {
    _id: listingId,
    updatedAt: sourceUpdatedAt,
    status: sourceStatus,
    is_draft_preview: { $ne: true },
    ...inactiveGenerationCondition(),
    artifact_publish_token: publicationToken,
    artifact_publish_generation_token: generationToken,
  };
  let heartbeatError: unknown;
  let renewalInFlight: Promise<void> | null = null;
  let uploaded: UploadedCrArtifactBundle | null = null;
  let published = false;
  const renew = async () => {
    if (heartbeatError) throw heartbeatError;
    const renewed = await LotListing.updateOne(
      ownership,
      {
        $set: {
          artifact_publish_expires_at: new Date(
            Date.now() + REQUEST_CR_PUBLICATION_LEASE_MS
          ),
        },
      },
      { timestamps: false }
    );
    if (renewed.matchedCount !== 1) {
      throw new RequestScopedCrPublicationLeaseLostError();
    }
  };
  const heartbeat = setInterval(() => {
    if (renewalInFlight || heartbeatError) return;
    renewalInFlight = renew()
      .catch((error) => {
        heartbeatError = error;
      })
      .finally(() => {
        renewalInFlight = null;
      });
  }, REQUEST_CR_PUBLICATION_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const [specPdfBuffer, crDocxBuffer] = await Promise.all([
      generateAuctioneerSpecSheetPdfFromReport(reportData),
      generateAuctioneerSpecSheetDocxFromReport(reportData),
    ]);
    await renew();
    uploaded = await uploadImmutableCrArtifactBundle({
      kind: "lotListing",
      reportId: listingId,
      sourceFingerprint,
      reportData,
      specPdfBuffer,
      crDocxBuffer,
    });
    await renew();
    if (renewalInFlight) await renewalInFlight;
    if (heartbeatError) throw heartbeatError;

    const approvedFileUpdates =
      sourceStatus === "approved"
        ? {
            "files.spec_pdf": uploaded.specPdf,
            "files.cr_docx": uploaded.crDocx,
          }
        : {};
    const finalized = await LotListing.findOneAndUpdate(
      ownership,
      {
        $set: {
          "preview_files.spec_pdf": uploaded.specPdf,
          "preview_files.cr_docx": uploaded.crDocx,
          cr_artifact_source_fingerprint: sourceFingerprint,
          ...approvedFileUpdates,
        },
        $unset: {
          artifact_publish_token: 1,
          artifact_publish_generation_token: 1,
          artifact_publish_expires_at: 1,
        },
      },
      { returnDocument: "after" }
    ).select("preview_files files updatedAt");
    if (!finalized) throw new RequestScopedCrPublicationLeaseLostError();
    published = true;
    syncStoredCrArtifactBundle({
      document: listing,
      bundle: uploaded,
      updatedAt: (finalized as any).updatedAt,
      includeApprovedFiles: sourceStatus === "approved",
    });
    return { specPdf: uploaded.specPdf, crDocx: uploaded.crDocx };
  } catch (error) {
    if (!published) await deleteUnpublishedCrArtifacts(uploaded);
    await LotListing.updateOne(
      { _id: listingId, artifact_publish_token: publicationToken },
      {
        $unset: {
          artifact_publish_token: 1,
          artifact_publish_generation_token: 1,
          artifact_publish_expires_at: 1,
        },
      },
      { timestamps: false }
    ).catch(() => undefined);
    if (error instanceof RequestScopedCrPublicationLeaseLostError) {
      const current = await LotListing.findById(listingId)
        .select(
          "status job_status files_generating files_regenerating artifact_publish_token artifact_publish_expires_at"
        )
        .lean();
      throw crPublicationConflict({ current, kind: "lotListing" });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    const pendingRenewal = renewalInFlight as Promise<void> | null;
    if (!published && pendingRenewal) {
      await pendingRenewal.catch(() => undefined);
    }
  }
}

/** Compatibility wrappers keep older callers on the atomic CR-pair contract. */
export async function generateAndStoreLotListingSpecPdf(
  listing: any
): Promise<string> {
  return (await generateAndStoreLotListingCrArtifacts(listing)).specPdf;
}

export async function generateAndStoreLotListingCrDocx(
  listing: any
): Promise<string> {
  return (await generateAndStoreLotListingCrArtifacts(listing)).crDocx;
}

export async function generateAdminSpecPdfById(id: string): Promise<{
  buffer: Buffer;
  filename: string;
  reportType: "Asset" | "LotListing";
} | null> {
  const pdfReport = await PdfReport.findById(id).lean().catch(() => null);
  const parentId = String((pdfReport as any)?.report || id);

  const asset = await AssetReport.findById(parentId).populate("user", "email username name companyName");
  if (asset) {
    const { buffer, reportData } = await generateAssetSpecPdfForReport(asset);
    return {
      buffer,
      filename: buildReportArtifactFilenames({
        kind: "asset",
        contractNo: getReportContractNumber(reportData, parentId),
        reportId: parentId,
        fallback: parentId,
        lots: reportData.lots,
      }).crPdf,
      reportType: "Asset",
    };
  }

  const listing = await LotListing.findById(parentId).populate("user", "email username name companyName");
  if (listing) {
    const { buffer, reportData } = await generateLotListingSpecPdfForListing(listing);
    return {
      buffer,
      filename: buildReportArtifactFilenames({
        kind: "lotListing",
        contractNo: getReportContractNumber(reportData, parentId),
        reportId: parentId,
        fallback: parentId,
        lots: reportData.lots,
      }).crPdf,
      reportType: "LotListing",
    };
  }

  return null;
}

function plainUserId(user: any): string {
  if (!user) return "";
  if (typeof user === "string") return user;
  return String(user?._id || user?.id || "");
}

function cacheVersionFromUrl(value: unknown): number {
  const url = String(value || "").trim();
  if (!url) return 0;
  const match = url.match(/[?&]v=(\d+)/);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function freshestUsefulUrl(...values: unknown[]): string {
  const urls = values
    .map((value) => String(value || "").trim())
    .filter((url) => /^https?:\/\//i.test(url));
  if (urls.length === 0) return "";

  return urls.reduce((freshest, url) => {
    const urlVersion = cacheVersionFromUrl(url);
    const freshestVersion = cacheVersionFromUrl(freshest);
    return urlVersion > freshestVersion ? url : freshest;
  }, urls[0]);
}

export async function resolveCrPdfAccessById(
  id: string,
  options: {
    userId?: string;
    isAdmin?: boolean;
    generateIfMissing?: boolean;
    requireDownloadable?: boolean;
  } = {}
): Promise<{
  url: string;
  generated: boolean;
  reportType: "Asset" | "LotListing";
  contractNo: string;
  reportId: string;
  lots: any[];
} | null> {
  const pdfReport = await PdfReport.findById(id).lean().catch(() => null);
  const parentId = String((pdfReport as any)?.report || id);

  const asset = await AssetReport.findById(parentId).populate("user", "email username name companyName");
  if (asset) {
    if (!options.isAdmin && String(options.userId || "") !== plainUserId((asset as any).user)) {
      throw Object.assign(new Error("Not authorized to view this CR"), { statusCode: 403 });
    }
    if (options.requireDownloadable || !options.isAdmin) {
      const access = getReportDownloadAccess(asset);
      if (!access.allowed) {
        throw Object.assign(new Error(access.message), {
          statusCode: 409,
          code: access.code,
          downloadAccess: access,
        });
      }
    }

    const contractNo = getReportContractNumber(buildSpecReportData(asset), parentId);
    const existingUrl = freshestUsefulUrl(
      (asset as any)?.files?.spec_pdf,
      (asset as any)?.preview_files?.spec_pdf
    );
    if (existingUrl) {
      return { url: existingUrl, generated: false, reportType: "Asset", contractNo, reportId: parentId, lots: getReportLots(asset) };
    }
    if (!options.generateIfMissing) return null;

    const url = (await generateAndStoreAssetCrArtifacts(asset)).specPdf;
    return { url, generated: true, reportType: "Asset", contractNo, reportId: parentId, lots: getReportLots(asset) };
  }

  const listing = await LotListing.findById(parentId).populate("user", "email username name companyName");
  if (listing) {
    if (!options.isAdmin && String(options.userId || "") !== plainUserId((listing as any).user)) {
      throw Object.assign(new Error("Not authorized to view this CR"), { statusCode: 403 });
    }
    if (options.requireDownloadable || !options.isAdmin) {
      const access = getReportDownloadAccess(listing);
      if (!access.allowed) {
        throw Object.assign(new Error(access.message), {
          statusCode: 409,
          code: access.code,
          downloadAccess: access,
        });
      }
    }

    const contractNo = getReportContractNumber(buildSpecReportData(listing), parentId);
    const existingUrl = freshestUsefulUrl(
      (listing as any)?.files?.spec_pdf,
      (listing as any)?.preview_files?.spec_pdf
    );
    if (existingUrl) {
      return { url: existingUrl, generated: false, reportType: "LotListing", contractNo, reportId: parentId, lots: getReportLots(listing) };
    }
    if (!options.generateIfMissing) return null;

    const url = (await generateAndStoreLotListingCrArtifacts(listing)).specPdf;
    return { url, generated: true, reportType: "LotListing", contractNo, reportId: parentId, lots: getReportLots(listing) };
  }

  return null;
}

export async function resolveCrDocxAccessById(
  id: string,
  options: {
    userId?: string;
    isAdmin?: boolean;
    generateIfMissing?: boolean;
    requireDownloadable?: boolean;
  } = {}
): Promise<{
  url: string;
  generated: boolean;
  reportType: "Asset" | "LotListing";
  contractNo: string;
  reportId: string;
  lots: any[];
} | null> {
  const pdfReport = await PdfReport.findById(id).lean().catch(() => null);
  const parentId = String((pdfReport as any)?.report || id);

  const asset = await AssetReport.findById(parentId).populate("user", "email username name companyName");
  if (asset) {
    if (!options.isAdmin && String(options.userId || "") !== plainUserId((asset as any).user)) {
      throw Object.assign(new Error("Not authorized to view this CR DOCX"), { statusCode: 403 });
    }
    if (options.requireDownloadable || !options.isAdmin) {
      const access = getReportDownloadAccess(asset);
      if (!access.allowed) {
        throw Object.assign(new Error(access.message), {
          statusCode: 409,
          code: access.code,
          downloadAccess: access,
        });
      }
    }

    const contractNo = getReportContractNumber(buildSpecReportData(asset), parentId);
    const existingUrl = freshestUsefulUrl(
      (asset as any)?.files?.cr_docx,
      (asset as any)?.preview_files?.cr_docx
    );
    if (existingUrl) {
      return { url: existingUrl, generated: false, reportType: "Asset", contractNo, reportId: parentId, lots: getReportLots(asset) };
    }
    if (!options.generateIfMissing) return null;

    const url = (await generateAndStoreAssetCrArtifacts(asset)).crDocx;
    return { url, generated: true, reportType: "Asset", contractNo, reportId: parentId, lots: getReportLots(asset) };
  }

  const listing = await LotListing.findById(parentId).populate("user", "email username name companyName");
  if (listing) {
    if (!options.isAdmin && String(options.userId || "") !== plainUserId((listing as any).user)) {
      throw Object.assign(new Error("Not authorized to view this CR DOCX"), { statusCode: 403 });
    }
    if (options.requireDownloadable || !options.isAdmin) {
      const access = getReportDownloadAccess(listing);
      if (!access.allowed) {
        throw Object.assign(new Error(access.message), {
          statusCode: 409,
          code: access.code,
          downloadAccess: access,
        });
      }
    }

    const contractNo = getReportContractNumber(buildSpecReportData(listing), parentId);
    const existingUrl = freshestUsefulUrl(
      (listing as any)?.files?.cr_docx,
      (listing as any)?.preview_files?.cr_docx
    );
    if (existingUrl) {
      return { url: existingUrl, generated: false, reportType: "LotListing", contractNo, reportId: parentId, lots: getReportLots(listing) };
    }
    if (!options.generateIfMissing) return null;

    const url = (await generateAndStoreLotListingCrArtifacts(listing)).crDocx;
    return { url, generated: true, reportType: "LotListing", contractNo, reportId: parentId, lots: getReportLots(listing) };
  }

  return null;
}
