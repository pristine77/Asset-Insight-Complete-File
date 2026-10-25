import { getCanonicalLotListingPreview } from "./reportPreviewAvailability.js";

/** Read-only queue DTO. Editors still fetch their complete owner-bound report.
 * Never send every photo, valuation/comparable or condition report on a poll. */
export function previewQueueSummary(report: any, kind: string) {
  const preview = kind === "lotListing" ? getCanonicalLotListingPreview(report) : report.preview_data;
  const lots = preview != null ? preview.lots : report.lots;
  const row: Record<string, any> = {};
  for (const key of ["_id", "status", "createdAt", "updatedAt", "contract_no", "client_name", "location", "currency", "grouping_mode",
    "property_type", "file_number", "preview_submitted_at", "approval_requested_at", "generation_target_status", "preview_transferred_at",
    "is_merged_report", "generation_state", "workflow_stage", "workflow_message", "workflow_progress_percent", "generation_progress",
    "job_status", "job_error", "files_ready", "files_generating", "files_regenerating", "preview_available", "release_status", "downloadable",
    "download_access", "files", "preview_files", "revision", "generation_kind", "can_cancel"]) {
    if (report[key] !== undefined) row[key] = report[key];
  }
  row.lot_count = Array.isArray(lots) ? lots.length : 0;
  row.image_count = Array.isArray(report.imageUrls) ? report.imageUrls.length : 0;
  row.merged_source_count = report.merged_from_report_ids?.length || 0;
  const thumbnail = (Array.isArray(report.imageUrls) ? report.imageUrls : []).find((url: unknown) => typeof url === "string" && url.length > 0);
  row.thumbnail_url = thumbnail || null;
  row.preview_data = {
    client_name: preview?.client_name, contract_no: preview?.contract_no, location: preview?.location,
    currency: preview?.currency, industry: preview?.industry, claim_number: preview?.claim_number,
    property_details: preview?.property_details ? { address: preview.property_details.address, owner_name: preview.property_details.owner_name } : undefined,
    valuation: preview?.valuation ? { fair_market_value: preview.valuation.fair_market_value } : undefined,
  };
  row.property_details = report.property_details ? { address: report.property_details.address, owner_name: report.property_details.owner_name } : undefined;
  row.valuation = report.valuation ? { fair_market_value: report.valuation.fair_market_value } : undefined;
  return row;
}
