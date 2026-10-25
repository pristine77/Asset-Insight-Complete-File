import { createHash } from "node:crypto";
import { hasRequiredReportFiles } from "./reportFileState.js";

export const activityHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const ACTIVITY_ACTIONS = ["history_started", "photo_captured", "photos_imported", "lot_added", "next_lot", "photos_removed", "lot_removed", "photos_reordered", "lots_reordered", "cover_changed", "logo_changed", "draft_opened", "draft_saved", "preview_saved", "upload_started", "upload_progress", "upload_accepted", "submission_requested", "preview_submitted", "retry_requested", "cancelled", "preview_ready", "generation_started", "generation_completed", "generation_failed", "reassigned", "approved", "declined", "released", "auction_delivery", "report_deleted", "draft_deleted", "preview_deleted", "fields_changed", "capture_mode_changed", "backup_started", "backup_paused", "backup_resumed", "backup_interrupted", "backup_completed", "upload_queued", "upload_paused", "upload_resumed", "upload_interrupted", "upload_failed"] as const;
export const CLIENT_ACTIVITY_ACTIONS = new Set<string>(["history_started", "upload_started", "photo_captured", "photos_imported", "lot_added", "next_lot", "photos_removed", "lot_removed", "photos_reordered", "lots_reordered", "cover_changed", "logo_changed", "draft_opened", "draft_saved", "submission_requested", "retry_requested", "cancelled", "fields_changed", "capture_mode_changed", "draft_deleted"]);
const fieldNames = ["title", "description", "lot_number", "lotNumber", "estimated_value", "estimatedValue", "serial_number", "serialNumber", "year", "make", "model", "condition", "condition_report", "condition_report_selections", "specs", "specifications", "category", "location", "currency", "total_value", "valuation_methods", "sales_date", "contract_no", "contractNo", "client_name", "prepared_for", "appraisal_purpose", "effective_date", "notes",
  "condition_report_specs", "condition_report_specs_manual_overrides", "condition_report_specs_deleted", "condition_report_specs_custom_order",
  "damage_analysis", "quantity", "must_take", "categories", "show_on_website", "close_date", "bid_increment", "opening_bid", "item_condition", "serial_no_or_label", "details", "tags", "lotted_by", "items",
  "owner_name", "appraiser", "appraisal_company", "industry", "inspection_date", "language", "factors_age_condition", "factors_quality", "factors_analysis", "include_valuation_table", "include_damage_analysis", "latitude", "longitude"];
const plain = (value: any): any => value?.toObject ? value.toObject({ getters: false, virtuals: false }) : value;
function safeValue(value: any, depth = 0): any {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value ?? null;
  if (typeof value === "string") return value.length <= 20000 ? value : { text: value.slice(0, 20000), truncated: true };
  if (depth > 5) return "[Nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => safeValue(item, depth + 1));
  return Object.fromEntries(Object.entries(plain(value) || {}).filter(([key]) => !/(url|uri|image|photo|signature|token|password|secret|^\$|__proto__|constructor)/i.test(key)).slice(0, 1000).map(([key, item]) => [key, safeValue(item, depth + 1)]));
}
function mediaId(media: any, index: number) {
  return activityHash(String(typeof media === "string" ? media : media?.mediaId || media?.clientFileId || media?.fileId || media?.id || media?.url || media?.uri || `unknown:${index}`)).slice(0, 32);
}
export function activitySnapshot(raw: any, model: string) {
  const doc = plain(raw) || {};
  const preview = plain(doc.preview_data) || {};
  const details = plain(doc.details || doc.formData) || {};
  const grouped = doc.smartGrouping?.groups?.map((group: any) => ({ id: `smart-group:${group.groupIndex}`, lotNumber: String(group.groupIndex + 1),
    files: (group.fileIds || []).map((id: string) => ({ id })), coverIndex: (group.fileIds || []).indexOf(group.coverFileId) }));
  const sourceLots = grouped?.length ? grouped : preview.lots || doc.lots || details.lots || details.mixed_lots || [];
  const manifest = Array.isArray(doc.media) ? doc.media : Array.isArray(doc.files) ? doc.files : [];
  const values: Record<string, any> = {};
  for (const field of fieldNames) {
    const value = preview[field] ?? doc[field] ?? details[field];
    if (value !== undefined) values[field] = safeValue(value);
  }
  const lots = (Array.isArray(sourceLots) ? sourceLots : []).map((lot: any, position: number) => {
    lot = plain(lot);
    const id = String(lot.id || lot._id || lot.lotId || lot.lot_id || `position:${position}`);
    let main = lot.mainImages || lot.images || lot.image_urls || lot.imageUrls || lot.files || [];
    let extras = lot.extraImages || lot.extra_image_urls || lot.extra_files || lot.extraFiles || lot.report_images || [];
    // Legacy previews may retain indexes into the parent media collection only.
    const parentImages = doc.imageUrls || preview.imageUrls || [];
    if (!main.length && Array.isArray(lot.image_indexes)) main = lot.image_indexes.map((index: number) => parentImages[index] || { id: `parent-main:${index}` });
    if (!extras.length && Array.isArray(lot.extra_image_indexes)) extras = lot.extra_image_indexes.map((index: number) => parentImages[index] || { id: `parent-extra:${index}` });
    const attached = manifest.filter((file: any) => String(file.lotId || "") === id || file.lotIndex === position).sort((a: any, b: any) => Number(a.index ?? a.imageIndex ?? 0) - Number(b.index ?? b.imageIndex ?? 0));
    if (attached.length) {
      if (!main.length) main = attached.filter((file: any) => (file.slot || file.role || "main") === "main" && file.fieldname !== "videos");
      if (!extras.length) extras = attached.filter((file: any) => (file.slot || file.role) === "extra");
    }
    for (const field of fieldNames) if (lot[field] !== undefined) values[`lots.${id}.${field}`] = safeValue(lot[field]);
    return { id, lotNumber: String(lot.lot_number ?? lot.lotNumber ?? position + 1), position,
      main: (Array.isArray(main) ? main : []).map(mediaId), extra: (Array.isArray(extras) ? extras : []).map(mediaId),
      cover: lot.coverIndex ?? lot.cover_image_index ?? lot.cover_index ?? null };
  });
  const files = Array.isArray(doc.files) ? doc.files : [];
  const fallbackMain = files.length ? files.filter((file: any) => file.fieldname !== "videos" && file.role !== "video" && file.role !== "extra").length : (doc.imageUrls || []).length;
  const fallbackExtra = files.filter((file: any) => file.role === "extra").length;
  const mainPhotos = lots.length ? lots.reduce((count: number, lot: any) => count + lot.main.length, 0) : fallbackMain;
  const extraPhotos = lots.length ? lots.reduce((count: number, lot: any) => count + lot.extra.length, 0) : fallbackExtra;
  const submitted = !!(doc.preview_submitted_at || doc.approval_requested_at || doc.submitted_at || doc.submittedAt || ["pending_approval", "approved"].includes(doc.status));
  return {
    owner: String(doc.user?._id || doc.user || doc.claimedBy || ""), reportType: model === "AssetReport" ? "asset" : model === "LotListing" ? "lotListing" : doc.selectedReportType || doc.type,
    contract: String(doc.contract_no || doc.contractNo || doc.contract?.contractNo || details.contract_no || details.contractNo || ""),
    activityId: doc.activity_id || details.activity_id || doc.capture_id || details.capture_id || doc.clientDraftId || doc.client_submission_id || doc.clientSubmissionId || details.clientSubmissionId || details.client_submission_id || `server:${model}:${doc._id}`,
    reportId: ["AssetReport", "LotListing"].includes(model) ? String(doc._id) : doc.linkedReportId || doc.reportId || doc.promotedReportId || doc.previewReportId || null,
    draftId: model === "ReportDraft" ? String(doc._id) : doc.source_draft_id ? String(doc.source_draft_id) : null,
    captureId: doc.capture_id || details.capture_id || null,
    submissionId: doc.client_submission_id || doc.clientSubmissionId || details.clientSubmissionId || null,
    uploadSessionId: model === "ReportUploadSession" ? String(doc._id) : null,
    counts: model === "AuctioneerWorkItem" ? null : { lots: lots.length || (model === "ReportUploadSession" ? new Set(files.map((file: any) => file.lotIndex ?? 0)).size : 0), mainPhotos, extraPhotos, photos: mainPhotos + extraPhotos },
    lots, values, submitted,
    status: doc.status || doc.previewStatus || null, jobStatus: doc.job_status || null,
    generationId: doc.job_id || doc.jobId || null, release: doc.release_status || null,
    filesReady: hasRequiredReportFiles(model === "LotListing" ? "lotListing" : "asset", doc.file_paths, doc.files, doc.generated_files),
    uploadedPhotos: model === "ReportUploadSession" ? files.filter((file: any) => file.uploadedAt && file.fieldname !== "videos").length : null,
    // Missing is unknown: schema defaults on hydrated legacy records are not evidence.
    watermark: typeof (doc.watermark_images ?? details.watermark_images ?? details.watermarkImages) === "boolean" ? (doc.watermark_images ?? details.watermark_images ?? details.watermarkImages) : null,
    destination: String(doc.auction_destination || details.auction_destination || details.destination || "") || null,
    assignedTo: String(doc.approval_assigned_to || doc.assigned_to || "") || null,
    deliveryStatus: doc.delivery?.status || null,
    deliveryDestination: doc.delivery?.destination || null,
    error: safeActivityIssue(doc.job_error || doc.error_message || doc.lastError || doc.delivery?.lastError),
  };
}
export function safeActivityIssue(value: unknown): string | null {
  if (!value) return null;
  const text = String(value).slice(0, 1500);
  if (/^(Please enter FMV for Lot |Lot number [a-zA-Z0-9, .-]+ is already assigned within this event|No active processing job or complete source upload was found)/.test(text) &&
      !/(?:https?:|file:|content:|bearer |sk-|password|secret|token|\bat \w+\s*\()/i.test(text)) return text;
  return "The operation did not complete. Open the related preview to review the current issue, or contact Operations with the report number.";
}
export function activityChanges(before: ReturnType<typeof activitySnapshot> | null, after: ReturnType<typeof activitySnapshot>) {
  const changes: any[] = [];
  const bounded = (value: any) => {
    const json = JSON.stringify(value);
    return Buffer.byteLength(json) <= 32000 ? value : { text: json.slice(0, 8000), truncated: true };
  };
  function compare(field: string, oldValue: any, newValue: any) {
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
    const objects = [oldValue, newValue].filter(value => value != null);
    if (objects.length && objects.every(value => typeof value === "object" && !Array.isArray(value) && !value.truncated)) {
      for (const key of new Set([...Object.keys(oldValue || {}), ...Object.keys(newValue || {})])) compare(`${field}.${key}`, oldValue?.[key] ?? null, newValue?.[key] ?? null);
      return;
    }
    changes.push({ field, ...(before?.submitted ? { before: bounded(oldValue), after: bounded(newValue) } : {}) });
  }
  for (const field of new Set([...Object.keys(before?.values || {}), ...Object.keys(after.values)])) {
    compare(field, before?.values[field] ?? null, after.values[field] ?? null);
  }
  return changes;
}
