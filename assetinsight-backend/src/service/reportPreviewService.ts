/**
 * Resolves any report identifier into one sanitized preview contract for the admin UI.
 * Collection-specific builders preserve legacy schemas behind a stable payload shape;
 * fallback PDF records keep older reports viewable without teaching controllers the
 * historical storage model.
 */
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import PdfReport from "../models/pdfReport.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import SalvageReport from "../models/salvage.model.js";
import { salvageSnapshot } from "./salvageWorkflowService.js";
import { presentSalvageSnapshot } from "./salvagePresentation.js";
import {
  ASSET_SCHEDULE_CALCULATION_VERSION,
  buildAssetScheduleCalculations,
  deriveAssetScheduleSummary,
  type AssetScheduleCalculation,
  type AssetScheduleDerivedSummary,
  type AssetAdminScheduleSheet,
} from "./assetAdminScheduleSheetService.js";
import {
  getCanonicalProposalValuationSheet,
  saveAdminProposalValuationSheet,
} from "./proposalValuationService.js";

type PreviewField = {
  label: string;
  value: string;
};

export type ReportPreviewPayload = {
  reportId?: string;
  title: string;
  meta: PreviewField[];
  data: Record<string, unknown>;
  variant?: "assetScheduleSheet";
  currencyCode?: string;
  assetScheduleSheet?: AssetAdminScheduleSheet;
  ownerColumnId?: string | null;
  ownerId?: string;
  revision?: number;
  summary?: AssetScheduleDerivedSummary;
  calculationVersion?: string;
  calculations?: AssetScheduleCalculation[];
};

type ResolvedRecord =
  | {
      kind: "asset";
      doc: any;
      pdfReport?: any;
    }
  | {
      kind: "realEstate";
      doc: any;
      pdfReport?: any;
    }
  | {
      kind: "salvage";
      doc: any;
      pdfReport?: any;
    }
  | {
      kind: "lotListing";
      doc: any;
    }
  | {
      kind: "pdfOnly";
      pdfReport: any;
    };

const ASSET_PREVIEW_PARTICIPANT_FIELDS =
  "email username companyName avatarUrl role isBlocked isVerified proposalValuationEnabled";

async function findPopulatedAssetPreviewReport(id: unknown) {
  if (!id) return null;
  return AssetReport.findById(id)
    .populate({ path: "user", select: ASSET_PREVIEW_PARTICIPANT_FIELDS, transform: (user, id) => user || id })
    .populate(
      "proposal_valuation_evaluators.user",
      ASSET_PREVIEW_PARTICIPANT_FIELDS
    )
    .lean();
}

const OMITTED_KEYS = new Set([
  "__v",
  "_id",
  "analysis",
  "preview_files",
  "files",
  "filePath",
  "imagesFolderPath",
  "approval_requested_at",
  "approval_processed_at",
  "preview_submitted_at",
  "reviewedBy",
  "reviewedAt",
  "user",
  "report",
  "reportModel",
]);

function isPresent(value: unknown) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function toPlainObject<T>(value: T): T {
  if (value && typeof value === "object" && typeof (value as any).toObject === "function") {
    return (value as any).toObject({ flattenMaps: true });
  }
  return value;
}

function sanitizeValue(value: unknown, preserveEmpty = false): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item, preserveEmpty))
      .filter((item) => preserveEmpty || isPresent(item));
  }
  if (typeof value === "object") {
    const plain = toPlainObject(value as Record<string, unknown>);
    const entries = Object.entries(plain)
      .filter(([key, nested]) => !OMITTED_KEYS.has(key) && (preserveEmpty || isPresent(nested)))
      .map(([key, nested]) => [key, sanitizeValue(nested, preserveEmpty)]);
    return Object.fromEntries(entries.filter(([, nested]) => preserveEmpty || isPresent(nested)));
  }
  return value;
}

function pickDefined(entries: Record<string, unknown>, canonicalKeys: string[] = []) {
  return Object.fromEntries(
    Object.entries(entries)
      .map(([key, value]) => [key, sanitizeValue(value, canonicalKeys.includes(key))])
      .filter(([, value]) => isPresent(value))
  ) as Record<string, unknown>;
}

function formatMetaValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  const asString = String(value).trim();
  if (!asString) return "";
  const date = new Date(asString);
  if (!Number.isNaN(date.getTime()) && /\d{4}-\d{2}-\d{2}|T/.test(asString)) {
    return date.toISOString().slice(0, 19).replace("T", " ");
  }
  return asString;
}

function appendMeta(meta: PreviewField[], label: string, value: unknown) {
  const formatted = formatMetaValue(value);
  if (formatted) meta.push({ label, value: formatted });
}

function formatAssetFairMarketValue(report: any) {
  const previewData = report?.preview_data || {};
  const currency = String(previewData?.currency || report?.currency || "CAD").toUpperCase();
  const baseFMV = previewData?.valuation_data?.baseFMV;
  const lots = Array.isArray(previewData?.lots)
    ? previewData.lots
    : Array.isArray(report?.lots)
      ? report.lots
      : [];
  const sumFromLots = lots.reduce((acc: number, lot: any) => {
    const raw = typeof lot?.estimated_value === "string" ? lot.estimated_value : "";
    const num = parseFloat(String(raw).replace(/[^0-9.-]+/g, ""));
    return acc + (Number.isFinite(num) ? num : 0);
  }, 0);
  const total = Number.isFinite(baseFMV as any) ? (baseFMV as number) : sumFromLots;
  if (total > 0) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(total);
  }
  return `${currency} 0.00`;
}

function buildAssetPayload(report: any, pdfReport?: any): ReportPreviewPayload {
  const previewData = report?.preview_data || {};
  const currencyCode = String(previewData?.currency || report?.currency || "CAD").toUpperCase();
  const title =
    previewData?.contract_no
      ? `Asset - ${previewData.contract_no}`
      : previewData?.client_name || previewData?.prepared_for || report?.client_name || report?.prepared_for || "Asset Report";
  const meta: PreviewField[] = [];
  appendMeta(meta, "Report Type", "Asset");
  appendMeta(meta, "Source", pdfReport ? "PdfReport / AssetReport" : "AssetReport");
  appendMeta(meta, "Status", report?.status || pdfReport?.approvalStatus);
  appendMeta(meta, "Contract", previewData?.contract_no || report?.contract_no || pdfReport?.contract_no);
  appendMeta(meta, "Client", previewData?.client_name || report?.client_name);
  appendMeta(meta, "Prepared For", previewData?.prepared_for || report?.prepared_for);
  appendMeta(meta, "FMV", pdfReport?.fairMarketValue || formatAssetFairMarketValue(report));
  appendMeta(meta, "Language", previewData?.language || report?.language);
  appendMeta(meta, "Currency", previewData?.currency || report?.currency);
  appendMeta(meta, "Created", report?.createdAt || pdfReport?.createdAt);
  appendMeta(meta, "Updated", report?.updatedAt || pdfReport?.updatedAt);

  const assetScheduleSheet = getCanonicalProposalValuationSheet(report);
  const summary = deriveAssetScheduleSummary(assetScheduleSheet);
  return {
    reportId: String(report?._id || ""),
    title,
    meta,
    variant: "assetScheduleSheet",
    currencyCode,
    assetScheduleSheet,
    ownerColumnId: assetScheduleSheet.evaluator_columns.find(column => column.user_id === String(report?.user?._id || report?.user || ""))?.id || null,
    revision: Number(report?.proposal_valuation_revision || 0),
    summary,
    calculationVersion: ASSET_SCHEDULE_CALCULATION_VERSION,
    calculations: buildAssetScheduleCalculations(assetScheduleSheet, summary),
    ownerId: String(report?.user?._id || report?.user || pdfReport?.user?._id || pdfReport?.user || ""),
    // Admin inspection needs the exact saved preview values, not a second
    // hand-maintained subset that can drift from generated files.
    data: pickDefined({
      ...previewData,
      lots: Array.isArray(previewData?.lots) ? previewData.lots : report?.lots,
      image_urls: previewData?.image_urls ?? previewData?.imageUrls ?? report?.imageUrls,
      extra_image_urls: previewData?.extra_image_urls ?? previewData?.extraImageUrls ?? report?.extraImageUrls,
      video_urls: previewData?.video_urls ?? previewData?.videoUrls ?? report?.videoUrls,
      status: report?.status,
      decline_reason: report?.decline_reason,
      error_message: report?.error_message,
    }),
  };
}

function buildRealEstatePayload(report: any, pdfReport?: any): ReportPreviewPayload {
  const previewData = report?.preview_data || {};
  const propertyDetails = previewData?.property_details || report?.property_details;
  const valuation = previewData?.valuation || report?.valuation;
  const farmlandValuation = previewData?.farmland_valuation || report?.farmland_valuation;
  const address = propertyDetails?.address || pdfReport?.address || "Real Estate Report";
  const fairMarketValue =
    pdfReport?.fairMarketValue ||
    valuation?.fair_market_value ||
    farmlandValuation?.fair_market_value_formatted ||
    "N/A";

  const meta: PreviewField[] = [];
  appendMeta(meta, "Report Type", "Real Estate");
  appendMeta(meta, "Source", pdfReport ? "PdfReport / RealEstateReport" : "RealEstateReport");
  appendMeta(meta, "Status", report?.status || pdfReport?.approvalStatus);
  appendMeta(meta, "Address", address);
  appendMeta(meta, "Property Type", report?.property_type || propertyDetails?.property_type);
  appendMeta(meta, "FMV", fairMarketValue);
  appendMeta(meta, "Language", report?.language);
  appendMeta(meta, "Created", report?.createdAt || pdfReport?.createdAt);
  appendMeta(meta, "Updated", report?.updatedAt || pdfReport?.updatedAt);

  return {
    title: address,
    meta,
    ownerId: String(report?.user?._id || report?.user || pdfReport?.user?._id || pdfReport?.user || ""),
    data: pickDefined({
      language: report?.language,
      property_type: report?.property_type || propertyDetails?.property_type,
      fair_market_value: fairMarketValue,
      property_details: propertyDetails,
      report_dates: previewData?.report_dates ?? report?.report_dates,
      house_details: previewData?.house_details ?? report?.house_details,
      inspector_info: previewData?.inspector_info ?? report?.inspector_info,
      ai_extracted_features: previewData?.ai_extracted_features ?? report?.ai_extracted_features,
      farmland_details: previewData?.farmland_details ?? report?.farmland_details,
      farmland_valuation: farmlandValuation,
      comparable_properties: previewData?.comparableProperties ?? report?.comparableProperties,
      valuation,
      market_trend: previewData?.marketTrend ?? report?.marketTrend,
      image_urls: previewData?.imageUrls ?? report?.imageUrls,
      extra_image_urls: previewData?.extraImageUrls ?? report?.extraImageUrls,
      video_urls: previewData?.videoUrls ?? report?.videoUrls,
      decline_reason: report?.decline_reason,
    }),
  };
}

function buildSalvagePayload(report: any, pdfReport?: any): ReportPreviewPayload {
  const source = report;
  report = { ...report, ...presentSalvageSnapshot(salvageSnapshot(report)), user: source?.user };
  const itemName = [report?.year, report?.make, report?.item_model].filter(Boolean).join(" ").trim();
  const title = itemName || report?.insured_name || pdfReport?.address || "Salvage Report";
  const fairMarketValue =
    report?.valuation?.fairMarketValue ||
    report?.valuation?.fair_market_value ||
    report?.valuation?.final_estimate_value ||
    report?.valuation?.value || pdfReport?.fairMarketValue ||
    "N/A";

  const meta: PreviewField[] = [];
  appendMeta(meta, "Report Type", "Salvage");
  appendMeta(meta, "Source", pdfReport ? "PdfReport / SalvageReport" : "SalvageReport");
  appendMeta(meta, "Status", pdfReport?.approvalStatus);
  appendMeta(meta, "Claim Number", report?.claim_number);
  appendMeta(meta, "Insured", report?.insured_name);
  if (report?.assessment?.schemaVersion === 2) {
    const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value)
      ? new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(value) + " CAD" : "Unavailable";
    appendMeta(meta, "Pre-loss market value", amount(report.assessment.valuations?.preLoss?.amount));
    appendMeta(meta, "Repair estimate", amount(report.assessment.repairs?.total));
    appendMeta(meta, "As-is salvage value", amount(report.assessment.valuations?.asIs?.amount));
    appendMeta(meta, "Net auction recovery", amount(report.assessment.netRecovery?.total));
  } else appendMeta(meta, "FMV", fairMarketValue);
  appendMeta(meta, "Language", report?.language);
  appendMeta(meta, "Currency", report?.currency);
  appendMeta(meta, "Created", report?.createdAt || pdfReport?.createdAt);
  appendMeta(meta, "Updated", report?.updatedAt || pdfReport?.updatedAt);

  return {
    title,
    meta,
    reportId: String(source?._id || pdfReport?.report || ""),
    revision: Number(source?.revision || 0),
    ownerId: String(report?.user?._id || report?.user || pdfReport?.user?._id || pdfReport?.user || ""),
    data: pickDefined({
      report_date: report?.report_date,
      file_number: report?.file_number,
      date_received: report?.date_received,
      claim_number: report?.claim_number,
      policy_number: report?.policy_number,
      date_of_loss: report?.date_of_loss,
      reported_loss_type: report?.reported_loss_type,
      item_type: report?.item_type,
      year: report?.year,
      make: report?.make,
      item_model: report?.item_model,
      vin: report?.vin,
      appraiser_name: report?.appraiser_name,
      appraiser_phone: report?.appraiser_phone,
      appraiser_email: report?.appraiser_email,
      adjuster_name: report?.adjuster_name,
      insured_name: report?.insured_name,
      company_name: report?.company_name,
      company_address: report?.company_address,
      cause_of_loss_summary: report?.cause_of_loss_summary,
      appraiser_comments: report?.appraiser_comments,
      next_report_due: report?.next_report_due,
      language: report?.language,
      currency: report?.currency,
      fair_market_value: fairMarketValue,
      extracted_details: report?.aiExtractedDetails,
      comparable_items: report?.comparableItems,
      valuation: report?.valuation,
      assessment: report?.assessment,
      assessment_inputs: report?.assessment_inputs,
      report_context: report?.report_context,
      report_enrichment: report?.report_enrichment,
      specialty_data: report?.specialty_data,
      repair_items: report?.repair_items,
      labour_breakdown: report?.labour_breakdown,
      procurement_notes: report?.procurement_notes,
      assumptions: report?.assumptions,
      safety_concerns: report?.safety_concerns,
      priority_level: report?.priority_level,
      labour_rate_default: report?.labour_rate_default,
      parts_subtotal: report?.parts_subtotal,
      labour_total: report?.labour_total,
      repair_estimate: report?.repair_estimate,
      actual_cash_value: report?.actual_cash_value,
      replacement_cost: report?.replacement_cost,
      recommended_reserve: report?.recommended_reserve,
      item_condition: report?.item_condition,
      damage_description: report?.damage_description,
      inspection_comments: report?.inspection_comments,
      is_repairable: report?.is_repairable,
      repair_facility: report?.repair_facility,
      repair_facility_comments: report?.repair_facility_comments,
      replacement_cost_references: report?.replacement_cost_references,
      image_urls: report?.imageUrls,
    }, ["assessment", "assessment_inputs", "report_context", "report_enrichment"]),
  };
}

function buildLotListingPayload(report: any): ReportPreviewPayload {
  const previewData = report?.preview_data || {};
  const contractNo = previewData?.contract_no || report?.contract_no || "Lot Listing";
  const lots = previewData?.lots || report?.lots || [];
  const meta: PreviewField[] = [];
  appendMeta(meta, "Report Type", "Lot Listing");
  appendMeta(meta, "Source", "LotListing");
  appendMeta(meta, "Status", report?.status);
  appendMeta(meta, "Contract", contractNo);
  appendMeta(meta, "Location", previewData?.location || report?.location);
  appendMeta(meta, "Lots", Array.isArray(lots) ? lots.length : 0);
  appendMeta(meta, "Language", report?.language);
  appendMeta(meta, "Currency", report?.currency);
  appendMeta(meta, "Created", report?.createdAt);
  appendMeta(meta, "Updated", report?.updatedAt);

  return {
    title: contractNo,
    meta,
    ownerId: String(report?.user?._id || report?.user || ""),
    data: pickDefined({
      contract_no: contractNo,
      sales_date: previewData?.sales_date || report?.sales_date,
      location: previewData?.location || report?.location,
      total_value: report?.total_value,
      language: report?.language,
      currency: report?.currency,
      mixed_lots: report?.mixed_lots,
      lots,
      image_urls: report?.imageUrls,
      decline_reason: report?.decline_reason,
      error_message: report?.error_message,
    }),
  };
}

function buildPdfFallbackPayload(pdfReport: any): ReportPreviewPayload {
  const title =
    pdfReport?.contract_no
      ? `${pdfReport?.reportType || "Report"} - ${pdfReport.contract_no}`
      : pdfReport?.address || pdfReport?.filename || "Report";
  const meta: PreviewField[] = [];
  appendMeta(meta, "Report Type", pdfReport?.reportType || "Report");
  appendMeta(meta, "Source", "PdfReport");
  appendMeta(meta, "Status", pdfReport?.approvalStatus);
  appendMeta(meta, "File Type", pdfReport?.fileType);
  appendMeta(meta, "Contract", pdfReport?.contract_no);
  appendMeta(meta, "Address", pdfReport?.address);
  appendMeta(meta, "FMV", pdfReport?.fairMarketValue);
  appendMeta(meta, "Created", pdfReport?.createdAt);
  appendMeta(meta, "Updated", pdfReport?.updatedAt);

  return {
    title,
    meta,
    ownerId: String(pdfReport?.user?._id || pdfReport?.user || ""),
    data: pickDefined({
      filename: pdfReport?.filename,
      file_type: pdfReport?.fileType,
      address: pdfReport?.address,
      fair_market_value: pdfReport?.fairMarketValue,
      contract_no: pdfReport?.contract_no,
      valuation_methods: pdfReport?.valuation_methods,
      valuation_data: pdfReport?.valuation_data,
      approval_status: pdfReport?.approvalStatus,
      approval_note: pdfReport?.approvalNote,
    }),
  };
}

async function resolveRecord(id: string): Promise<ResolvedRecord | null> {
  const asset = await findPopulatedAssetPreviewReport(id);
  if (asset) return { kind: "asset", doc: asset };

  const realEstate = await RealEstateReport.findById(id).populate("user", "email username").lean();
  if (realEstate) return { kind: "realEstate", doc: realEstate };

  const lotListing = await LotListing.findById(id).populate("user", "email username").lean();
  if (lotListing) return { kind: "lotListing", doc: lotListing };

  const pdfById = await PdfReport.findById(id)
    .populate("user", "email username")
    .populate("report")
    .lean();
  if (pdfById) {
    const sourceDoc = toPlainObject(pdfById.report as any);
    if (pdfById.reportModel === "AssetReport" && sourceDoc) {
      const populatedAsset =
        (await findPopulatedAssetPreviewReport((sourceDoc as any)._id)) ||
        sourceDoc;
      return { kind: "asset", doc: populatedAsset, pdfReport: pdfById };
    }
    if (pdfById.reportModel === "RealEstateReport" && sourceDoc) return { kind: "realEstate", doc: sourceDoc, pdfReport: pdfById };
    if (pdfById.reportModel === "SalvageReport" && sourceDoc) return { kind: "salvage", doc: await findPopulatedSalvagePreviewReport((sourceDoc as any)._id) || sourceDoc, pdfReport: pdfById };
    return { kind: "pdfOnly", pdfReport: pdfById };
  }

  const pdfByParent = await PdfReport.findOne({ report: id as any })
    .sort({ createdAt: -1 })
    .populate("user", "email username")
    .populate("report")
    .lean();
  if (pdfByParent) {
    const sourceDoc = toPlainObject(pdfByParent.report as any);
    if (pdfByParent.reportModel === "AssetReport" && sourceDoc) {
      const populatedAsset =
        (await findPopulatedAssetPreviewReport((sourceDoc as any)._id)) ||
        sourceDoc;
      return { kind: "asset", doc: populatedAsset, pdfReport: pdfByParent };
    }
    if (pdfByParent.reportModel === "RealEstateReport" && sourceDoc) return { kind: "realEstate", doc: sourceDoc, pdfReport: pdfByParent };
    if (pdfByParent.reportModel === "SalvageReport" && sourceDoc) return { kind: "salvage", doc: await findPopulatedSalvagePreviewReport((sourceDoc as any)._id) || sourceDoc, pdfReport: pdfByParent };
    return { kind: "pdfOnly", pdfReport: pdfByParent };
  }

  const salvage = await findPopulatedSalvagePreviewReport(id);
  if (salvage) return { kind: "salvage", doc: salvage };

  return null;
}

async function findPopulatedSalvagePreviewReport(id: any) {
  return SalvageReport.findById(id).select("+assessment_edit_history").populate("user", "email username").lean();
}

export async function getReportPreviewPayloadById(id: string): Promise<ReportPreviewPayload | null> {
  const resolved = await resolveRecord(id);
  if (!resolved) return null;

  if (resolved.kind === "asset") return buildAssetPayload(resolved.doc, resolved.pdfReport);
  if (resolved.kind === "realEstate") return buildRealEstatePayload(resolved.doc, resolved.pdfReport);
  if (resolved.kind === "salvage") return buildSalvagePayload(resolved.doc, resolved.pdfReport);
  if (resolved.kind === "lotListing") return buildLotListingPayload(resolved.doc);
  return buildPdfFallbackPayload(resolved.pdfReport);
}

export async function saveAssetAdminScheduleSheetById(
  id: string,
  rawSheet: unknown,
  options: { adminUserId: string; baseRevision?: unknown }
): Promise<ReportPreviewPayload | null> {
  const saved = await saveAdminProposalValuationSheet({
    reportId: id,
    adminUserId: options.adminUserId,
    rawSheet,
    baseRevision: options.baseRevision,
  });
  const assetReport = await AssetReport.findById(saved.reportId)
    .populate({ path: "user", select: "email username companyName avatarUrl", transform: (user, id) => user || id })
    .populate(
      "proposal_valuation_evaluators.user",
      "email username companyName avatarUrl"
    )
    .lean();
  if (!assetReport) return null;
  return buildAssetPayload(assetReport);
}
